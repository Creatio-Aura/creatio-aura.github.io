// The Ignis beta sign-up service (a Cloudflare Worker, with a D1 database).
//
//   POST /check-code  { code, turnstile }                 → { pass } unlocks the form for 30 min
//   POST /signup      { pass, name, email, platforms, consent, website }
//                                                          → sends a confirmation email
//   GET  /confirm?t=…                                      → confirms, then back to the site
//   GET|POST /leave?t=…                                    → removes them, then back to the site
//
// Only people with the invite code get as far as the form; only those who confirm by email
// join the list. Nothing is kept but what they typed: no IP addresses. The list lives in the
// D1 database, readable only from Andrew's Cloudflare account.

import {
  allow,
  allowEmail,
  isHuman,
  isInviteCode,
  isPass,
  newPass,
  newToken,
  sha256,
  visitorKey,
} from "./guard";
import { confirmationEmail, sendEmail } from "./mail";

export interface Env {
  DB: D1Database;
  /** The site's address, for links back to it. */
  SITE_URL: string;
  /** Comma-separated origins allowed to call this service. */
  ALLOWED_ORIGINS: string;
  /** This service's own address, for the links in emails. */
  SERVICE_URL: string;
  GMAIL_USER: string;
  /** "smtp" to send through Gmail, "test" to keep emails in the outbox table. */
  MAIL_MODE: string;
  /** Tries per connection per hour; defaults 8 and 6 (the tests raise them). */
  CODE_LIMIT?: string;
  SIGNUP_LIMIT?: string;
  // Secrets (wrangler secret put …), never in the repo:
  INVITE_CODE: string;
  TURNSTILE_SECRET: string;
  PASS_SECRET: string;
  IP_SALT: string;
  GMAIL_APP_PASSWORD: string;
}

/** What people agree to by ticking the box; kept with each sign-up. */
const CONSENT_TEXT = "Email me about the Ignis beta. I've read the privacy policy.";
const PLATFORMS = ["iPhone", "Android", "Web"];
/** Per connection per hour (code checks, sign-ups); emails per day; emails to one address. */
const limits = (env: Env) => ({
  codeChecks: Number(env.CODE_LIMIT ?? 8),
  signups: Number(env.SIGNUP_LIMIT ?? 6),
  emailsPerDay: 400,
  emailsPerPerson: 3,
});
const CONFIRM_HOURS = 48;
const UNCONFIRMED_DAYS = 7;

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });

function cors(origin: string | null): Record<string, string> {
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : {};
}

const redirect = (env: Env, path: string) =>
  Response.redirect(`${env.SITE_URL.replace(/\/$/, "")}${path}`, 303);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
    const origin = request.headers.get("Origin");
    const okOrigin = origin && allowed.includes(origin) ? origin : null;

    // The email links: opened from a mail app, so no Origin to check.
    if (url.pathname === "/confirm" && request.method === "GET") return confirm(env, url);
    if (url.pathname === "/leave" && (request.method === "GET" || request.method === "POST")) {
      return leave(env, url, request.method);
    }
    if (url.pathname === "/__outbox" && env.MAIL_MODE === "test") return outbox(env);

    // Everything else is the sign-up form, and only from our own site.
    if (!okOrigin) return json({ ok: false, error: "origin" }, 403, null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(okOrigin) });
    if (request.method !== "POST") return json({ ok: false, error: "method" }, 405, okOrigin);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "bad-request" }, 400, okOrigin);
    }
    try {
      if (url.pathname === "/check-code") return await checkCode(env, request, body, okOrigin);
      if (url.pathname === "/signup") return await signup(env, request, body, okOrigin);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: "server" }, 500, okOrigin);
    }
    return json({ ok: false, error: "not-found" }, 404, okOrigin);
  },
};

async function checkCode(env: Env, request: Request, body: Record<string, unknown>, origin: string) {
  const key = await visitorKey(env, request);
  if (!(await allow(env, "code", key, limits(env).codeChecks))) {
    return json({ ok: false, error: "too-many" }, 429, origin);
  }
  if (!(await isHuman(env, body.turnstile))) return json({ ok: false, error: "human-check" }, 403, origin);
  if (!isInviteCode(env, body.code)) return json({ ok: false, error: "bad-code" }, 401, origin);
  return json({ ok: true, pass: await newPass(env) }, 200, origin);
}

async function signup(env: Env, request: Request, body: Record<string, unknown>, origin: string) {
  if (!(await isPass(env, body.pass))) return json({ ok: false, error: "expired-pass" }, 401, origin);
  const key = await visitorKey(env, request);
  if (!(await allow(env, "signup", key, limits(env).signups))) {
    return json({ ok: false, error: "too-many" }, 429, origin);
  }
  // The decoy field: people never see it, bots fill it in. Pretend all is well.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true }, 200, origin);
  }

  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const platforms = Array.isArray(body.platforms)
    ? PLATFORMS.filter((p) => (body.platforms as unknown[]).includes(p))
    : [];
  if (name.length < 1 || name.length > 60 || /[\r\n<>]/.test(name)) {
    return json({ ok: false, error: "bad-name" }, 400, origin);
  }
  if (email.length > 254 || !/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(email)) {
    return json({ ok: false, error: "bad-email" }, 400, origin);
  }
  if (platforms.length === 0) return json({ ok: false, error: "pick-platform" }, 400, origin);
  if (body.consent !== true) return json({ ok: false, error: "need-consent" }, 400, origin);

  const now = new Date();
  // Unconfirmed sign-ups don't linger.
  await env.DB.prepare("DELETE FROM signups WHERE confirmed_at IS NULL AND created_at < ?")
    .bind(new Date(now.getTime() - UNCONFIRMED_DAYS * 86_400_000).toISOString())
    .run();

  const existing = await env.DB.prepare(
    "SELECT confirmed_at, emails_sent, last_email_at FROM signups WHERE email = ?",
  )
    .bind(email)
    .first<{ confirmed_at: string | null; emails_sent: number; last_email_at: string | null }>();
  // Already on the list: say the same thing as for anyone else, so the form never reveals who
  // has signed up.
  if (existing?.confirmed_at) return json({ ok: true }, 200, origin);
  if (existing && existing.emails_sent >= limits(env).emailsPerPerson) return json({ ok: true }, 200, origin);
  if (!(await allowEmail(env, limits(env).emailsPerDay))) {
    return json({ ok: false, error: "busy" }, 503, origin);
  }

  const confirmToken = await newToken();
  const leaveToken = await newToken();
  const expires = new Date(now.getTime() + CONFIRM_HOURS * 3_600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO signups (email, name, platforms, consent_text, consent_at, created_at,
       confirm_hash, confirm_expires, leave_hash, emails_sent, last_email_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (email) DO UPDATE SET name = excluded.name, platforms = excluded.platforms,
       consent_text = excluded.consent_text, consent_at = excluded.consent_at,
       confirm_hash = excluded.confirm_hash, confirm_expires = excluded.confirm_expires,
       leave_hash = excluded.leave_hash, emails_sent = signups.emails_sent + 1,
       last_email_at = excluded.last_email_at`,
  )
    .bind(
      email,
      name,
      platforms.join(","),
      CONSENT_TEXT,
      now.toISOString(),
      now.toISOString(),
      confirmToken.hash,
      expires,
      leaveToken.hash,
      now.toISOString(),
    )
    .run();

  const service = env.SERVICE_URL.replace(/\/$/, "");
  const leaveUrl = `${service}/leave?t=${leaveToken.token}`;
  const content = confirmationEmail(name, `${service}/confirm?t=${confirmToken.token}`, leaveUrl);
  try {
    await sendEmail(env, { to: email, ...content, leaveUrl });
  } catch (error) {
    // Couldn't send: don't count it against them, and say so plainly.
    console.error("Sending the confirmation email failed:", error);
    await env.DB.prepare("UPDATE signups SET emails_sent = MAX(emails_sent - 1, 0) WHERE email = ?")
      .bind(email)
      .run();
    return json({ ok: false, error: "mail" }, 502, origin);
  }
  return json({ ok: true }, 200, origin);
}

async function confirm(env: Env, url: URL) {
  const token = url.searchParams.get("t") ?? "";
  if (!token) return redirect(env, "/beta/link-expired/");
  const row = await env.DB.prepare(
    "SELECT id, confirm_expires, confirmed_at FROM signups WHERE confirm_hash = ?",
  )
    .bind(await sha256(token))
    .first<{ id: number; confirm_expires: string; confirmed_at: string | null }>();
  if (!row) return redirect(env, "/beta/link-expired/");
  if (row.confirmed_at) return redirect(env, "/beta/confirmed/");
  if (row.confirm_expires < new Date().toISOString()) return redirect(env, "/beta/link-expired/");
  await env.DB.prepare("UPDATE signups SET confirmed_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run();
  return redirect(env, "/beta/confirmed/");
}

async function leave(env: Env, url: URL, method: string) {
  const token = url.searchParams.get("t") ?? "";
  if (token) {
    await env.DB.prepare("DELETE FROM signups WHERE leave_hash = ?").bind(await sha256(token)).run();
  }
  // Mail apps' one-click unsubscribe (POST) just needs a 200.
  if (method === "POST") return new Response("Removed.", { status: 200 });
  return redirect(env, "/beta/left/");
}

async function outbox(env: Env) {
  const rows = await env.DB.prepare("SELECT to_addr, subject, body FROM outbox ORDER BY id DESC LIMIT 20").all();
  return new Response(JSON.stringify(rows.results), { headers: { "Content-Type": "application/json" } });
}
