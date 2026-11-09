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
  /** Where a reply goes instead of support@ (a tester's feedback: to them). */
  replyTo?: string;
  /** Marked urgent (high priority) for the inbox: feedback from the apps. */
  urgent?: boolean;
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
        "INSERT INTO outbox (to_addr, subject, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(email.to, email.subject, email.text, new Date().toISOString(), email.replyTo ?? null)
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
    // Only ever an address the email check has passed (no line breaks, no brackets).
    ...(email.replyTo ? [`Reply-To: <${email.replyTo}>`] : []),
    `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(email.subject)))}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@creatio-aura.com>`,
    // Urgent, in each of the ways mail apps look for it.
    ...(email.urgent ? ["X-Priority: 1 (Highest)", "X-MSMail-Priority: High", "Importance: High", "Priority: urgent"] : []),
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

/** "Hi Kodi," or, for someone who gave no name (sign-ups since 7 November 2026 don't), "Hi,". */
const hi = (name: string) => (name ? `Hi ${name},` : "Hi,");

/** The confirmation email: one link to confirm, one to remove them. */
export function confirmationEmail(app: string, name: string, confirmUrl: string, leaveUrl: string) {
  const text = [
    hi(name),
    "",
    `Thanks for signing up for the ${app} beta. To confirm it was you, open this link:`,
    "",
    confirmUrl,
    "",
    "It works for 48 hours. If you didn't sign up, ignore this email: without confirming, your",
    "details are deleted within 7 days.",
    "",
    "— Creatio Aura",
    "",
    `Don't want these emails? Remove yourself: ${leaveUrl}`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#120f1f;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#f4eadb">
<div style="max-width:520px;margin:0 auto;background:#1d1830;border-radius:20px;padding:32px">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">Confirm your place in the ${escape(app)} beta</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">${escape(hi(name))}</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6">Thanks for signing up. Press the button to confirm it was you.</p>
<p style="margin:0 0 24px"><a href="${confirmUrl}" style="display:inline-block;background:#ff8a3d;color:#1d0f05;font-weight:bold;text-decoration:none;padding:14px 26px;border-radius:99px">Confirm my place</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#d8cbb6">The link works for 48 hours. If you didn't sign up, ignore this email: without confirming, your details are deleted within 7 days.</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#b9a8d6;text-align:center">Don't want these emails? <a href="${leaveUrl}" style="color:#ffb35c">Remove yourself</a>.</p>
</body></html>`;
  return { subject: `Confirm your place in the ${app} beta`, text, html };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** How to get a build on each platform, under its link. Android's depends on the link: Google Play's test, or the app file itself. */
export function howTo(platform: string, url: string, app = "Ignis Aura"): string {
  if (platform === "Android") {
    return /^https:\/\/play\.google\.com\//.test(url)
      ? `Open the link in Chrome on your Android phone (other browsers can stop partway through), signed in to the Google account you signed up with, and accept; then install ${app} from Google Play. Updates come through Google Play.`
      : "Open the link on your Android phone and download the app. If your phone asks, allow installing apps from your browser, then press Install. A newer build installs over the old one.";
  }
  if (platform === "iPhone") {
    return "Opens TestFlight, Apple's app for beta testing, on iPhone or iPad: install it from the App Store first if you haven't already.";
  }
  return "Opens in any browser, on a phone, tablet or computer. Nothing to install: sign in with the email you signed up with.";
}

/**
 * Once Andrew has let them in: they're in, with the latest links for where they play if there are
 * any yet (and the terms, for a beta they cover, as every download email has), and how to leave.
 */
export function welcomeEmail(
  app: string,
  name: string,
  leaveUrl: string,
  links: { platform: string; url: string; how: string }[] = [],
  /** The Beta Tester Terms, for a beta they cover; "" for one they don't. */
  termsUrl = "",
) {
  const text = [
    hi(name),
    "",
    `You're in: you're an ${app} beta tester now.`,
    "",
    ...(links.length
      ? [
          "Here's how to play:",
          "",
          ...links.flatMap((link) => [`${link.platform}: ${link.url}`, `  ${link.how}`, ""]),
          ...(termsUrl ? [...TERMS_IN_SHORT, `The full terms: ${termsUrl}`] : []),
        ]
      : ["We'll email you when there's a build for you to play."]),
    "",
    "Questions? Just reply to this email.",
    "",
    "Changed your mind? Remove yourself from the beta (this deletes your details straight away):",
    "",
    leaveUrl,
    "",
    "— Creatio Aura",
  ].join("\n");
  const buttons = links
    .map(
      (link) => `<div style="margin:0 0 18px">
<a href="${link.url}" style="display:inline-block;background:#ff8a3d;color:#1d0f05;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:99px">Get it for ${escape(link.platform)}</a>
<p style="margin:8px 0 0;font-size:13px;line-height:1.5;color:#d8cbb6">${escape(link.how)}</p></div>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#120f1f;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#f4eadb">
<div style="max-width:520px;margin:0 auto;background:#1d1830;border-radius:20px;padding:32px">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">You're in the ${escape(app)} beta</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">${escape(hi(name))}</p>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">You're in: you're an ${escape(app)} beta tester now.</p>
${
  links.length
    ? `${termsUrl ? `<div style="margin:6px 0 22px;padding:14px 16px;border:1px solid #4a3f66;border-radius:12px;background:#171327">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#b9a8d6">Before you download</p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#d8cbb6">By downloading, installing or using this beta build, you agree to the <a href="${termsUrl}" style="color:#ffb35c">Beta Tester Terms</a>. In short:</p>
<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.55;color:#d8cbb6">
<li>It's unfinished test software that you use at your own risk; Creatio Aura Ltd. isn't responsible for problems it causes on your devices.</li>
<li>The game is confidential: please don't post or talk about it publicly, social media included, without written permission from its creator and Creatio Aura Ltd.</li>
</ul></div>` : ""}
${buttons}`
    : `<p style="margin:0 0 14px;font-size:16px;line-height:1.6">We'll email you when there's a build for you to play.</p>`
}
<p style="margin:0 0 28px;font-size:16px;line-height:1.6">Questions? Just reply to this email.</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#d8cbb6">Changed your mind? Leaving deletes your details straight away.</p>
<p style="margin:0"><a href="${leaveUrl}" style="display:inline-block;border:2px solid #5b4d78;color:#f4eadb;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:99px">Remove me from the beta</a></p>
</div>
</body></html>`;
  return { subject: `You're in the ${app} beta`, text, html };
}

/** To the studio: someone has signed up and confirmed their email, and waits to be let in. */
export function waitingEmail(app: string, email: string, platforms: string[], approveUrl: string, waiting: number) {
  const when = new Date().toUTCString();
  const android = platforms.includes("Android")
    ? "On Android, add their Google account to the Play test's testers in Play Console first (this address, if it's their Google one)."
    : "";
  const text = [
    `Someone wants to join the ${app} beta, and has confirmed their email.`,
    "",
    `Email: ${email}`,
    `Plays on: ${platforms.join(", ")}`,
    `Confirmed: ${when}`,
    "",
    `Let them in, or turn them away: ${approveUrl}`,
    ...(android ? ["", android] : []),
    "",
    `Waiting for your OK now: ${waiting}.`,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#1d1a16">
<h2 style="margin:0 0 12px">Someone wants to join the ${escape(app)} beta</h2>
<table cellpadding="4" style="font-size:15px">
<tr><td><b>Email</b></td><td>${escape(email)}</td></tr>
<tr><td><b>Plays on</b></td><td>${escape(platforms.join(", "))}</td></tr>
<tr><td><b>Confirmed</b></td><td>${escape(when)}</td></tr>
</table>
<p style="margin:18px 0"><a href="${approveUrl}" style="display:inline-block;background:#e8792b;color:#1a0f08;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:99px">Let them in, or turn them away</a></p>
${android ? `<p style="font-size:14px;color:#4a433b">${escape(android)}</p>` : ""}
<p style="font-size:15px">Waiting for your OK now: <b>${waiting}</b>.</p>
</body></html>`;
  return { subject: `${app} beta: ${email} wants in (${platforms.join(", ")})`, text, html };
}

/** What the app sends with a note, as the feedback email names it. */
/** The apps that send feedback, by the name each note gives. */
export const APP_NAMES: Record<string, string> = { ignis: "Ignis Aura", effugium: "Effugium Aura" };

const DETAIL_LABELS: Record<string, string> = {
  version: "App version",
  build: "Build",
  commit: "Commit",
  platform: "Plays on",
  device: "Device",
  screen: "Screen",
  game: "Game",
};

/** To the studio: a tester's note from the app, with what the app sent along. */
export function feedbackEmail(
  message: string,
  email: string | null,
  /** Their name on the beta list ("" if they gave none), or null when they aren't on it. */
  tester: string | null,
  details: Record<string, string>,
  sentAt: string,
) {
  const when = new Date(sentAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Denver",
  });
  const from = email
    ? `${email} (${tester === null ? "not on the beta list" : tester ? `${tester}, on the beta list` : "on the beta list"}). Reply to this email to answer them.`
    : "No address left, so there's no one to reply to.";
  const rows = Object.entries(DETAIL_LABELS).flatMap(([key, label]) =>
    details[key] ? [[label, details[key]] as const] : [],
  );
  const app = APP_NAMES[details.app ?? "ignis"] ?? "Ignis Aura";
  const text = [
    `Feedback from the ${app} app.`,
    "",
    message,
    "",
    `From: ${from}`,
    ...rows.map(([label, value]) => `${label}: ${value}`),
    `Sent: ${when}`,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#1d1a16">
<h2 style="margin:0 0 12px">${escape(app)} feedback</h2>
<p style="font-size:16px;line-height:1.5;white-space:pre-wrap;border-left:3px solid #e8792b;padding-left:12px">${escape(message)}</p>
<table cellpadding="4" style="font-size:14px;color:#4a433b">
<tr><td valign="top"><b>From</b></td><td>${escape(from)}</td></tr>
${rows.map(([label, value]) => `<tr><td><b>${escape(label)}</b></td><td>${escape(value)}</td></tr>`).join("\n")}
<tr><td><b>Sent</b></td><td>${escape(when)}</td></tr>
</table>
</body></html>`;
  // Its first line, short, so the inbox shows what it's about.
  const gist = message.split("\n")[0]!.trim();
  const subject = `${app} FEEDBACK: ${gist.length > 60 ? `${gist.slice(0, 57).trimEnd()}…` : gist}`;
  return { subject, text, html };
}

/** A waiting list's confirmation email: one link to confirm, one to remove them. */
export function waitlistConfirmationEmail(project: string, confirmUrl: string, leaveUrl: string) {
  const text = [
    "Hi,",
    "",
    `Thanks for asking to hear when ${project} is out. To confirm it was you, open this link:`,
    "",
    confirmUrl,
    "",
    "It works for 48 hours. If you didn't ask, ignore this email: without confirming, your email is",
    "deleted within 7 days.",
    "",
    "— Creatio Aura",
    "",
    `Don't want these emails? Remove yourself: ${leaveUrl}`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#120f1f;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#f4eadb">
<div style="max-width:520px;margin:0 auto;background:#1d1830;border-radius:20px;padding:32px">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">Confirm: tell me when ${escape(project)} is out</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6">Thanks for asking to hear when ${escape(project)} is out. Press the button to confirm it was you.</p>
<p style="margin:0 0 24px"><a href="${confirmUrl}" style="display:inline-block;background:#ff8a3d;color:#1d0f05;font-weight:bold;text-decoration:none;padding:14px 26px;border-radius:99px">Confirm</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#d8cbb6">The link works for 48 hours. If you didn't ask, ignore this email: without confirming, your email is deleted within 7 days.</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#b9a8d6;text-align:center">Don't want these emails? <a href="${leaveUrl}" style="color:#ffb35c">Remove yourself</a>.</p>
</body></html>`;
  return { subject: `Confirm: tell me when ${project} is out`, text, html };
}

/** Once they've confirmed a waiting list: they're on it, and here's how to leave it. */
export function waitlistWelcomeEmail(project: string, leaveUrl: string) {
  const text = [
    "Hi,",
    "",
    `You're confirmed: we'll email you when ${project} is out. Questions? Just reply to this email.`,
    "",
    "Changed your mind? Remove yourself from the list (this deletes your email straight away):",
    "",
    leaveUrl,
    "",
    "— Creatio Aura",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#120f1f;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#f4eadb">
<div style="max-width:520px;margin:0 auto;background:#1d1830;border-radius:20px;padding:32px">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">You're on the ${escape(project)} list</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">You're confirmed. We'll email you when ${escape(project)} is out.</p>
<p style="margin:0 0 28px;font-size:16px;line-height:1.6">Questions? Just reply to this email.</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#d8cbb6">Changed your mind? Leaving the list deletes your email straight away.</p>
<p style="margin:0"><a href="${leaveUrl}" style="display:inline-block;border:2px solid #5b4d78;color:#f4eadb;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:99px">Remove me from the list</a></p>
</div>
</body></html>`;
  return { subject: `You're on the ${project} list`, text, html };
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
  app: string,
  name: string,
  title: string,
  body: string,
  links: { platform: string; url: string; how: string }[],
  leaveUrl: string,
  /** The Beta Tester Terms, for a beta they cover; "" for one they don't. */
  termsUrl: string,
) {
  const text = [
    hi(name),
    "",
    body,
    "",
    ...(termsUrl ? [...TERMS_IN_SHORT, `The full terms: ${termsUrl}`, ""] : []),
    ...links.flatMap((link) => [`${link.platform}: ${link.url}`, `  ${link.how}`, ""]),
    `Thanks for testing ${app}.`,
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
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura · ${escape(app)} beta</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">${escape(title)}</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">${escape(hi(name))}</p>
${paragraphs}
${termsUrl ? `<div style="margin:6px 0 22px;padding:14px 16px;border:1px solid #4a3f66;border-radius:12px;background:#171327">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#b9a8d6">Before you download</p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#d8cbb6">By downloading, installing or using this beta build, you agree to the <a href="${termsUrl}" style="color:#ffb35c">Beta Tester Terms</a>. In short:</p>
<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.55;color:#d8cbb6">
<li>It's unfinished test software that you use at your own risk; Creatio Aura Ltd. isn't responsible for problems it causes on your devices.</li>
<li>The game is confidential: please don't post or talk about it publicly, social media included, without written permission from its creator and Creatio Aura Ltd.</li>
</ul></div>` : ""}
${buttons}
<p style="margin:8px 0 0;font-size:15px;color:#d8cbb6">Thanks for testing ${escape(app)}.</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#b9a8d6;text-align:center">Don't want these emails? <a href="${leaveUrl}" style="color:#ffb35c">Remove yourself</a>.</p>
</body></html>`;
  return { subject: title, text, html };
}

/** One tester, as the daily report lists them. */
export interface ReportTester {
  name: string;
  email: string;
  platforms: string[];
  notes: string;
  /** When they were let in. */
  inSince: string;
  isNew: boolean;
}

/**
 * The studio's daily report: for each beta, who's been let in since the last report, everyone in it
 * and how many are still to confirm; everyone waiting to be let in, each with the link to decide;
 * the waiting lists and the feedback count.
 */
export function dailyReportEmail(
  betas: { name: string; platforms: string[]; testers: ReportTester[]; waitingToConfirm: number }[],
  /** Confirmed, and waiting to be let in: each with the link to let them in or turn them away. */
  waitingForYou: { app: string; email: string; platforms: string[]; confirmedAt: string; approveUrl: string }[],
  /** When the last report was sent; null before the first, when "new" means the last day. */
  lastReport: string | null,
  /** The waiting lists for the projects in the works: how many are on each, and how many are new. */
  lists: { name: string; total: number; fresh: number }[] = [],
  /** Notes sent from the app in the same time (each one is emailed on its own as it comes). */
  feedback = 0,
) {
  const day = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Denver",
  });
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
  const row = (t: ReportTester) =>
    `${t.name ? `${t.name} ` : ""}<${t.email}>: ${t.platforms.join(", ")} (in since ${t.inSince.slice(0, 10)})` +
    (t.notes ? `\n      Notes: ${t.notes.replace(/\n/g, " / ")}` : "");
  const totals = (beta: (typeof betas)[number]) =>
    beta.platforms.map((p) => `${p} ${beta.testers.filter((t) => t.platforms.includes(p)).length}`).join(" · ");
  const fresh = betas.flatMap((beta) => beta.testers.filter((t) => t.isNew));
  const text = [
    `Creatio Aura betas: ${day}`,
    "",
    `Waiting for your OK: ${waitingForYou.length}`,
    ...waitingForYou.map(
      (w) => `  ? ${w.app}: ${w.email}, ${w.platforms.join(", ")} (confirmed ${w.confirmedAt.slice(0, 10)}). Let in or turn away: ${w.approveUrl}`,
    ),
    ...betas.flatMap((beta) => {
      const isNew = beta.testers.filter((t) => t.isNew);
      return [
        "",
        `${beta.name} beta`,
        `  Let in ${sinceWhen}: ${isNew.length}`,
        ...isNew.map((t) => `    + ${row(t)}`),
        `  Testers: ${beta.testers.length} (${totals(beta)})`,
        `  Signed up, waiting to confirm: ${beta.waitingToConfirm}`,
        "  Everyone in, newest first:",
        ...beta.testers.map((t) => `    ${row(t)}`),
      ];
    }),
    "",
    `Feedback from the apps ${sinceWhen}: ${feedback}`,
    ...(lists.length
      ? ["", "Waiting lists (\"tell me when it's out\"):", ...lists.map((l) => `  ${l.name}: ${l.total} (${l.fresh} new)`)]
      : []),
  ].join("\n");
  const cells = (t: ReportTester) =>
    `<tr${t.isNew ? ' style="background:#fff3e2"' : ""}><td>${escape(t.name)}${t.isNew ? " <b>(new)</b>" : ""}</td><td>${escape(t.email)}</td><td>${escape(t.platforms.join(", "))}</td><td>${escape(t.inSince.slice(0, 10))}</td><td>${escape(t.notes).replace(/\n/g, "<br>")}</td></tr>`;
  const section = (beta: (typeof betas)[number]) => `<h3 style="margin:24px 0 8px">${escape(beta.name)} beta</h3>
<table cellpadding="6" style="font-size:15px;border-collapse:collapse;margin-bottom:12px">
<tr><td><b>Let in ${escape(sinceWhen)}</b></td><td style="font-size:20px"><b>${beta.testers.filter((t) => t.isNew).length}</b></td></tr>
<tr><td><b>Testers</b></td><td>${beta.testers.length} &nbsp;(${escape(totals(beta))})</td></tr>
<tr><td><b>Waiting to confirm</b></td><td>${beta.waitingToConfirm}</td></tr>
</table>
${
  beta.testers.length
    ? `<table cellpadding="6" style="font-size:14px;border-collapse:collapse" border="1" bordercolor="#e4ddd2">
<tr style="background:#f4efe6"><th align="left">Name</th><th align="left">Email</th><th align="left">Plays on</th><th align="left">In since</th><th align="left">Notes</th></tr>
${beta.testers.map(cells).join("\n")}
</table>`
    : "<p>No testers yet.</p>"
}`;
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#1d1a16">
<h2 style="margin:0 0 4px">Creatio Aura betas</h2>
<p style="margin:0 0 16px;color:#6b6157">${escape(day)}</p>
<h3 style="margin:0 0 8px">Waiting for your OK: ${waitingForYou.length}</h3>
${
  waitingForYou.length
    ? `<table cellpadding="6" style="font-size:14px;border-collapse:collapse;margin-bottom:16px">
${waitingForYou.map((w) => `<tr><td>${escape(w.app)}</td><td>${escape(w.email)}</td><td>${escape(w.platforms.join(", "))}</td><td><a href="${w.approveUrl}">Let in or turn away</a></td></tr>`).join("\n")}
</table>`
    : "<p>Nobody right now.</p>"
}
${betas.map(section).join("\n")}
<p style="margin:24px 0 0;font-size:15px"><b>Feedback from the apps ${escape(sinceWhen)}:</b> ${feedback}</p>
${
  lists.length
    ? `<h3 style="margin:24px 0 8px">Waiting lists</h3>
<table cellpadding="6" style="font-size:15px;border-collapse:collapse">
${lists.map((l) => `<tr><td><b>${escape(l.name)}</b></td><td>${l.total}${l.fresh ? ` &nbsp;(${l.fresh} new)` : ""}</td></tr>`).join("\n")}
</table>`
    : ""
}
</body></html>`;
  const subject = `Creatio Aura betas: ${fresh.length} new, ${waitingForYou.length} waiting for your OK`;
  return { subject, text, html };
}
