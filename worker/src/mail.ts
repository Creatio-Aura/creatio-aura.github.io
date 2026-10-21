// Sending email through Gmail itself: the Worker signs in to smtp.gmail.com as the studio's
// address with a Gmail app password, so the emails really come from Gmail and land in inboxes.
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
 * Sends several emails in one go (one sign-in to Gmail), and says how each went: true, or the
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
  // Google shows app passwords in groups of four; the spaces aren't part of it.
  return sendSmtp(env.GMAIL_USER, env.GMAIL_APP_PASSWORD.replace(/\s+/g, ""), emails);
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
    `Message-ID: <${crypto.randomUUID()}@creatio-aura.github.io>`,
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
async function sendSmtp(user: string, password: string, emails: Email[]): Promise<(true | Error)[]> {
  const socket = connect(
    { hostname: "smtp.gmail.com", port: 465 },
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
    if (code !== expect) throw new Error(`Gmail said "${lastLine}" (expected ${expect})`);
  };

  const results: (true | Error)[] = [];
  try {
    if ((await reply()) !== 220) throw new Error(`Gmail didn't greet us: "${lastLine}"`);
    await say("EHLO creatio-aura.github.io", 250);
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
    "Thanks for signing up for the Ignis beta. To confirm it was you, open this link:",
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
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">Confirm your place in the Ignis beta</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">Hi ${safeName},</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6">Thanks for signing up. Press the button to confirm it was you.</p>
<p style="margin:0 0 24px"><a href="${confirmUrl}" style="display:inline-block;background:#ff8a3d;color:#1d0f05;font-weight:bold;text-decoration:none;padding:14px 26px;border-radius:99px">Confirm my place</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#d8cbb6">The link works for 48 hours. If you didn't sign up, ignore this email: without confirming, your email and name are deleted within 7 days.</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#b9a8d6;text-align:center">Don't want these emails? <a href="${leaveUrl}" style="color:#ffb35c">Remove yourself</a>.</p>
</body></html>`;
  return { subject: "Confirm your place in the Ignis beta", text, html };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** To the studio: someone has just confirmed their place in the beta. */
export function newTesterEmail(name: string, email: string, platforms: string[], testers: number) {
  const when = new Date().toUTCString();
  const text = [
    "A new Ignis beta tester has confirmed.",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Plays on: ${platforms.join(", ")}`,
    `Confirmed: ${when}`,
    "",
    `Confirmed testers now: ${testers}.`,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#1d1a16">
<h2 style="margin:0 0 12px">New Ignis beta tester</h2>
<table cellpadding="4" style="font-size:15px">
<tr><td><b>Name</b></td><td>${escape(name)}</td></tr>
<tr><td><b>Email</b></td><td>${escape(email)}</td></tr>
<tr><td><b>Plays on</b></td><td>${escape(platforms.join(", "))}</td></tr>
<tr><td><b>Confirmed</b></td><td>${escape(when)}</td></tr>
</table>
<p style="font-size:15px">Confirmed testers now: <b>${testers}</b>.</p>
</body></html>`;
  return { subject: `New Ignis beta tester: ${name} (${platforms.join(", ")})`, text, html };
}

/** An announcement to a tester: a message, and the links for the platforms they play on. */
export function announcementEmail(
  name: string,
  title: string,
  body: string,
  links: { platform: string; url: string; how: string }[],
  leaveUrl: string,
) {
  const text = [
    `Hi ${name},`,
    "",
    body,
    "",
    ...links.flatMap((link) => [`${link.platform}: ${link.url}`, `  ${link.how}`, ""]),
    "Thanks for testing Ignis.",
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
<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#b9a8d6">Creatio Aura · Ignis beta</p>
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-weight:600;font-size:26px;color:#ffb35c">${escape(title)}</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:1.6">Hi ${escape(name)},</p>
${paragraphs}
${buttons}
<p style="margin:8px 0 0;font-size:15px;color:#d8cbb6">Thanks for testing Ignis.</p>
</div>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#b9a8d6;text-align:center">Don't want these emails? <a href="${leaveUrl}" style="color:#ffb35c">Remove yourself</a>.</p>
</body></html>`;
  return { subject: title, text, html };
}
