// Sending email through the studio's own mail server (IONOS): the Worker signs in as the support
// mailbox, so emails come from support@creatio-aura.com, signed for the domain, and land in inboxes.
// In test mode (MAIL_MODE=test) nothing is sent: emails are kept in the outbox table instead.

import { connect } from "cloudflare:sockets";

import type { Env } from "./index";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The remove-me link, for mail apps' own "unsubscribe" button (not on emails to us). */
  leaveUrl?: string;
}

export async function sendEmail(env: Env, email: Email): Promise<void> {
  const [result] = await sendEmails(env, [email]);
  if (result instanceof Error) throw result;
}

/**
 * Sends several emails in one go (one sign-in to the mail server), and says how each went: true, or the
 * error. A failure partway doesn't stop the rest from being tried.
 */
export async function sendEmails(env: Env, emails: Email[]): Promise<(true | Error)[]> {
  if (env.MAIL_MODE === "test") {
    for (const email of emails) {
      await env.DB.prepare(
        "INSERT INTO outbox (to_addr, subject, body, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(email.to, email.subject, email.text, new Date().toISOString())
        .run();
    }
    return emails.map(() => true);
  }
  return sendSmtp(env.SMTP_HOST, env.SMTP_USER, env.SMTP_PASSWORD, emails);
}

/** Base64 of UTF-8 text, wrapped at 76 characters as MIME expects. */
function base64Lines(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (btoa(binary).match(/.{1,76}/g) ?? []).join("\r\n");
}

function message(from: string, email: Email): string {
  const boundary = `ca-${crypto.randomUUID()}`;
  return [
    `From: Creatio Aura <${from}>`,
    `To: <${email.to}>`,
    `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(email.subject)))}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@creatio-aura.com>`,
    ...(email.leaveUrl
      ? [`List-Unsubscribe: <${email.leaveUrl}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"]
      : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(email.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(email.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Emails over SMTP (implicit TLS on port 465), signing in once with AUTH LOGIN. */
async function sendSmtp(
  hostname: string,
  user: string,
  password: string,
  emails: Email[],
): Promise<(true | Error)[]> {
  const socket = connect(
    { hostname, port: 465 },
    { secureTransport: "on", allowHalfOpen: false },
  );
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  let lastLine = "";
  /** The server's next reply: its code, once the last line of it has arrived. */
  const reply = async (): Promise<number> => {
    for (;;) {
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const match = /^(\d{3}) /.exec(lines[i]!);
        if (match) {
          lastLine = lines[i]!;
          buffer = lines.slice(i + 1).join("\r\n");
          return Number(match[1]);
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("The mail server hung up");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const say = async (line: string, expect: number) => {
    await writer.write(encoder.encode(`${line}\r\n`));
    const code = await reply();
    // What the server said (never what we sent: that could be the password).
    if (code !== expect) throw new Error(`The mail server said "${lastLine}" (expected ${expect})`);
  };

  const results: (true | Error)[] = [];
  try {
    if ((await reply()) !== 220) throw new Error(`The mail server didn't greet us: "${lastLine}"`);
    await say("EHLO creatio-aura.com", 250);
    await say("AUTH LOGIN", 334);
    await say(btoa(user), 334);
    await say(btoa(password), 235);
    for (const email of emails) {
      try {
        await say(`MAIL FROM:<${user}>`, 250);
        await say(`RCPT TO:<${email.to}>`, 250);
        await say("DATA", 354);
        // Every body line is base64, so none starts with a dot: no dot-stuffing needed.
        await say(`${message(user, email)}\r\n.`, 250);
        results.push(true);
      } catch (error) {
        results.push(error instanceof Error ? error : new Error(String(error)));
        // Start the next one afresh.
        await say("RSET", 250).catch(() => {});
      }
    }
    await writer.write(encoder.encode("QUIT\r\n"));
  } catch (error) {
    // Couldn't sign in (or the connection failed): every email not yet sent failed with it.
    const failure = error instanceof Error ? error : new Error(String(error));
    while (results.length < emails.length) results.push(failure);
  } finally {
    await socket.close().catch(() => {});
  }
  return results;
}

/** The confirmation email: one link to confirm, one to remove them. */
export function confirmationEmail(name: string, confirmUrl: string, leaveUrl: string) {
  const text = [
    `Hi ${name},`,
    "",
    "Thanks for signing up for the Ignis Aura beta. To confirm it was you, open this link:",
    "",
    confirmUrl,
    "",
    "It works for 48 hours. If you didn't sign up, ignore this email: without confirming, your",
    "email and name are deleted within 7 days.",
    "",
    "— Creatio Aura",
    "",
    `Don't want these emails? Remove yourself: ${leaveUrl}`,
  ].join("\n");
  const safeName = name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><body style="margin:0;background:#120f1f;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#f4eadb">
<div style="max-width:520px;margin:0 auto;background:#1d1830;border-radius:20px;padding:32px">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">Confirm your place in the Ignis Aura beta</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">Hi ${safeName},</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6">Thanks for signing up. Press the button to confirm it was you.</p>
<p style="margin:0 0 24px"><a href="${confirmUrl}" style="display:inline-block;background:#ff8a3d;color:#1d0f05;font-weight:bold;text-decoration:none;padding:14px 26px;border-radius:99px">Confirm my place</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#d8cbb6">The link works for 48 hours. If you didn't sign up, ignore this email: without confirming, your email and name are deleted within 7 days.</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#b9a8d6;text-align:center">Don't want these emails? <a href="${leaveUrl}" style="color:#ffb35c">Remove yourself</a>.</p>
</body></html>`;
  return { subject: "Confirm your place in the Ignis Aura beta", text, html };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Once they've confirmed: they're on the list, and here's how to leave it. */
export function welcomeEmail(name: string, leaveUrl: string) {
  const text = [
    `Hi ${name},`,
    "",
    "You're confirmed: you're on the Ignis Aura beta list. We'll email you when there's a build for",
    "you to play. Questions? Just reply to this email.",
    "",
    "Changed your mind? Remove yourself from the beta list (this deletes your details straight away):",
    "",
    leaveUrl,
    "",
    "— Creatio Aura",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#120f1f;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#f4eadb">
<div style="max-width:520px;margin:0 auto;background:#1d1830;border-radius:20px;padding:32px">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">You're on the Ignis Aura beta list</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">Hi ${escape(name)},</p>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">You're confirmed. We'll email you when there's a build for you to play.</p>
<p style="margin:0 0 28px;font-size:16px;line-height:1.6">Questions? Just reply to this email.</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#d8cbb6">Changed your mind? Leaving the list deletes your details straight away.</p>
<p style="margin:0"><a href="${leaveUrl}" style="display:inline-block;border:2px solid #5b4d78;color:#f4eadb;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:99px">Remove me from the beta</a></p>
</div>
</body></html>`;
  return { subject: "You're on the Ignis Aura beta list", text, html };
}

/** To the studio: someone has just confirmed their place in the beta. */
export function newTesterEmail(
  name: string,
  email: string,
  platforms: string[],
  notes: string,
  testers: number,
) {
  const when = new Date().toUTCString();
  const text = [
    "A new Ignis Aura beta tester has confirmed.",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Plays on: ${platforms.join(", ")}`,
    `Notes: ${notes || "(none)"}`,
    `Confirmed: ${when}`,
    "",
    `Confirmed testers now: ${testers}.`,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#1d1a16">
<h2 style="margin:0 0 12px">New Ignis Aura beta tester</h2>
<table cellpadding="4" style="font-size:15px">
<tr><td><b>Name</b></td><td>${escape(name)}</td></tr>
<tr><td><b>Email</b></td><td>${escape(email)}</td></tr>
<tr><td><b>Plays on</b></td><td>${escape(platforms.join(", "))}</td></tr>
<tr><td valign="top"><b>Notes</b></td><td>${notes ? escape(notes).replace(/\n/g, "<br>") : "<i>none</i>"}</td></tr>
<tr><td><b>Confirmed</b></td><td>${escape(when)}</td></tr>
</table>
<p style="font-size:15px">Confirmed testers now: <b>${testers}</b>.</p>
</body></html>`;
  return { subject: `New Ignis Aura beta tester: ${name} (${platforms.join(", ")})`, text, html };
}

/** What every download email says about the Beta Tester Terms, above the links. */
const TERMS_IN_SHORT = [
  "By downloading, installing or using this beta build, you agree to the Beta Tester Terms. In short:",
  "it's unfinished test software that you use at your own risk, and Creatio Aura Ltd. isn't responsible",
  "for problems it causes on your devices; and the game is confidential: please don't post or talk about",
  "it publicly, social media included, without written permission from its creator and Creatio Aura Ltd.",
];

/** An announcement to a tester: a message, the Beta Tester Terms, and the links for the platforms they play on. */
export function announcementEmail(
  name: string,
  title: string,
  body: string,
  links: { platform: string; url: string; how: string }[],
  leaveUrl: string,
  termsUrl: string,
) {
  const text = [
    `Hi ${name},`,
    "",
    body,
    "",
    ...TERMS_IN_SHORT,
    `The full terms: ${termsUrl}`,
    "",
    ...links.flatMap((link) => [`${link.platform}: ${link.url}`, `  ${link.how}`, ""]),
    "Thanks for testing Ignis Aura.",
    "— Creatio Aura",
    "",
    `Don't want these emails? Remove yourself: ${leaveUrl}`,
  ].join("\n");
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.6">${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const buttons = links
    .map(
      (link) => `<div style="margin:0 0 18px">
<a href="${link.url}" style="display:inline-block;background:#ff8a3d;color:#1d0f05;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:99px">Get it for ${escape(link.platform)}</a>
<p style="margin:8px 0 0;font-size:13px;line-height:1.5;color:#d8cbb6">${escape(link.how)}</p></div>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#120f1f;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#f4eadb">
<div style="max-width:520px;margin:0 auto;background:#1d1830;border-radius:20px;padding:32px">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura · Ignis Aura beta</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">${escape(title)}</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">Hi ${escape(name)},</p>
${paragraphs}
<div style="margin:6px 0 22px;padding:14px 16px;border:1px solid #4a3f66;border-radius:12px;background:#171327">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#b9a8d6">Before you download</p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#d8cbb6">By downloading, installing or using this beta build, you agree to the <a href="${termsUrl}" style="color:#ffb35c">Beta Tester Terms</a>. In short:</p>
<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.55;color:#d8cbb6">
<li>It's unfinished test software that you use at your own risk; Creatio Aura Ltd. isn't responsible for problems it causes on your devices.</li>
<li>The game is confidential: please don't post or talk about it publicly, social media included, without written permission from its creator and Creatio Aura Ltd.</li>
</ul></div>
${buttons}
<p style="margin:8px 0 0;font-size:15px;color:#d8cbb6">Thanks for testing Ignis Aura.</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#b9a8d6;text-align:center">Don't want these emails? <a href="${leaveUrl}" style="color:#ffb35c">Remove yourself</a>.</p>
</body></html>`;
  return { subject: title, text, html };
}

/** The studio's daily report: who joined the beta in the last day, and everyone on it. */
export function dailyReportEmail(
  testers: {
    name: string;
    email: string;
    platforms: string[];
    notes: string;
    confirmedAt: string;
    isNew: boolean;
  }[],
  waiting: number,
  /** When the last report was sent; null before the first, when "new" means the last day. */
  lastReport: string | null,
) {
  const day = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Denver",
  });
  const fresh = testers.filter((t) => t.isNew);
  const sinceWhen = lastReport
    ? `since the last report (${new Date(lastReport).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Denver",
      })})`
    : "in the last day";
  const count = (platform: string) => testers.filter((t) => t.platforms.includes(platform)).length;
  const totals = `iPhone ${count("iPhone")} · Android ${count("Android")} · Web ${count("Web")}`;
  const row = (t: (typeof testers)[number]) =>
    `${t.name} <${t.email}>: ${t.platforms.join(", ")} (confirmed ${t.confirmedAt.slice(0, 10)})` +
    (t.notes ? `\n      Notes: ${t.notes.replace(/\n/g, " / ")}` : "");
  const text = [
    `Ignis Aura beta: ${day}`,
    "",
    `New ${sinceWhen}: ${fresh.length}`,
    ...fresh.map((t) => `  + ${row(t)}`),
    "",
    `Confirmed testers: ${testers.length} (${totals})`,
    `Signed up, waiting to confirm: ${waiting}`,
    "",
    "Everyone on the beta, newest first:",
    ...testers.map((t) => `  ${row(t)}`),
  ].join("\n");
  const cells = (t: (typeof testers)[number]) =>
    `<tr${t.isNew ? ' style="background:#fff3e2"' : ""}><td>${escape(t.name)}${t.isNew ? " <b>(new)</b>" : ""}</td><td>${escape(t.email)}</td><td>${escape(t.platforms.join(", "))}</td><td>${escape(t.confirmedAt.slice(0, 10))}</td><td>${escape(t.notes).replace(/\n/g, "<br>")}</td></tr>`;
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#1d1a16">
<h2 style="margin:0 0 4px">Ignis Aura beta</h2>
<p style="margin:0 0 16px;color:#6b6157">${escape(day)}</p>
<table cellpadding="6" style="font-size:15px;border-collapse:collapse;margin-bottom:16px">
<tr><td><b>New ${escape(sinceWhen)}</b></td><td style="font-size:20px"><b>${fresh.length}</b></td></tr>
<tr><td><b>Confirmed testers</b></td><td>${testers.length} &nbsp;(${escape(totals)})</td></tr>
<tr><td><b>Waiting to confirm</b></td><td>${waiting}</td></tr>
</table>
${
  testers.length
    ? `<table cellpadding="6" style="font-size:14px;border-collapse:collapse" border="1" bordercolor="#e4ddd2">
<tr style="background:#f4efe6"><th align="left">Name</th><th align="left">Email</th><th align="left">Plays on</th><th align="left">Confirmed</th><th align="left">Notes</th></tr>
${testers.map(cells).join("\n")}
</table>`
    : "<p>No confirmed testers yet.</p>"
}
</body></html>`;
  const subject = `Ignis Aura beta: ${fresh.length} new, ${testers.length} in all`;
  return { subject, text, html };
}
