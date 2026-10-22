// The Ignis Aura beta sign-up service (a Cloudflare Worker, with a D1 database).
//
//   POST /check-code  { code, turnstile }                 → { pass } unlocks the form for 30 min
//   POST /signup      { pass, name, email, platforms, consent, website }
//                                                          → sends a confirmation email
//   GET  /confirm?t=…                                      → confirms, then back to the site
//   GET|POST /leave?t=…                                    → removes them, then back to the site
//
// And for Creatio Aura only, with the admin key (worker/tools/):
//   GET  /admin/testers                                    → everyone confirmed, with platforms
//   POST /admin/announce { title, message, links, send }   → emails testers their builds
//   POST /admin/report { send }                            → the daily report (also sent every morning)
//
// Only people with the invite code get as far as the form; only those who confirm by email
// join the list. Nothing is kept but what they typed: no IP addresses. The list lives in the
// D1 database, readable only from Andrew's Cloudflare account.

import {
  allow,
  allowEmail,
  isAdmin,
  isHuman,
  isInviteCode,
  isPass,
  leaveToken,
  leaveTokenId,
  newPass,
  newToken,
  sha256,
  visitorKey,
} from "./guard";
import { emailProblem } from "../../site/email-check.js";
import {
  announcementEmail,
  dailyReportEmail,
  confirmationEmail,
  newTesterEmail,
  sendEmail,
  sendEmails,
  type Email,
} from "./mail";

export interface Env {
  DB: D1Database;
  /** The site's address, for links back to it. */
  SITE_URL: string;
  /** Comma-separated origins allowed to call this service. */
  ALLOWED_ORIGINS: string;
  /** This service's own address, for the links in emails. */
  SERVICE_URL: string;
  GMAIL_USER: string;
  /** Where "new beta tester" notifications go. */
  OWNER_EMAIL: string;
  /** Where the daily report goes; the owner's email if not set. */
  REPORT_EMAIL?: string;
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
  /** The key the announce and testers tools use. */
  ADMIN_TOKEN: string;
}

/** What people agree to by ticking the box; kept with each sign-up. */
const CONSENT_TEXT = "Email me about the Ignis Aura beta. I've read the privacy policy.";
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
  // Every morning (wrangler.toml's cron), the studio's report on the beta list.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailyReport(env, true).then(() => undefined));
  },

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
    // Creatio Aura's own tools, from a computer rather than the site: the admin key instead.
    if (url.pathname.startsWith("/admin/")) {
      if (!isAdmin(env, request)) return json({ ok: false, error: "admin" }, 401, null);
      try {
        if (url.pathname === "/admin/testers" && request.method === "GET") return await testers(env);
        if (url.pathname === "/admin/announce" && request.method === "POST") {
          return await announce(env, (await request.json()) as Record<string, unknown>);
        }
        if (url.pathname === "/admin/report" && request.method === "POST") {
          const { send } = (await request.json()) as { send?: boolean };
          return json({ ok: true, ...(await dailyReport(env, send === true)) }, 200, null);
        }
      } catch (error) {
        console.error(error);
        return json({ ok: false, error: "server" }, 500, null);
      }
      return json({ ok: false, error: "not-found" }, 404, null);
    }

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
  // The same check as the form's (site/email-check.js): a real address, and no typo like ".con".
  const emailIssue = emailProblem(email);
  if (emailIssue) return json({ ok: false, ...emailIssue }, 400, origin);
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
  const legacyLeave = await newToken();
  const expires = new Date(now.getTime() + CONFIRM_HOURS * 3_600_000).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO signups (email, name, platforms, consent_text, consent_at, created_at,
       confirm_hash, confirm_expires, leave_hash, emails_sent, last_email_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (email) DO UPDATE SET name = excluded.name, platforms = excluded.platforms,
       consent_text = excluded.consent_text, consent_at = excluded.consent_at,
       confirm_hash = excluded.confirm_hash, confirm_expires = excluded.confirm_expires,
       leave_hash = excluded.leave_hash, emails_sent = signups.emails_sent + 1,
       last_email_at = excluded.last_email_at
     RETURNING id`,
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
      legacyLeave.hash,
      now.toISOString(),
    )
    .first<{ id: number }>();

  const service = env.SERVICE_URL.replace(/\/$/, "");
  const leaveUrl = `${service}/leave?t=${await leaveToken(env, row!.id)}`;
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
    "SELECT id, name, email, platforms, confirm_expires, confirmed_at FROM signups WHERE confirm_hash = ?",
  )
    .bind(await sha256(token))
    .first<{
      id: number;
      name: string;
      email: string;
      platforms: string;
      confirm_expires: string;
      confirmed_at: string | null;
    }>();
  if (!row) return redirect(env, "/beta/link-expired/");
  if (row.confirmed_at) return redirect(env, "/beta/confirmed/");
  if (row.confirm_expires < new Date().toISOString()) return redirect(env, "/beta/link-expired/");
  await env.DB.prepare("UPDATE signups SET confirmed_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run();
  // Tell the studio. If that email fails, they're confirmed all the same.
  try {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE confirmed_at IS NOT NULL")
      .first<{ n: number }>();
    const note = newTesterEmail(row.name, row.email, row.platforms.split(","), count?.n ?? 0);
    await sendEmail(env, { to: env.OWNER_EMAIL, ...note });
  } catch (error) {
    console.error("Telling the studio about a new tester failed:", error);
  }
  return redirect(env, "/beta/confirmed/");
}

async function leave(env: Env, url: URL, method: string) {
  const token = url.searchParams.get("t") ?? "";
  const id = token ? await leaveTokenId(env, token) : null;
  if (id !== null) {
    await env.DB.prepare("DELETE FROM signups WHERE id = ?").bind(id).run();
  } else if (token) {
    // Links from before they were signed.
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

interface Tester {
  id: number;
  name: string;
  email: string;
  platforms: string;
  confirmed_at: string;
}

const confirmedTesters = async (env: Env) =>
  (
    await env.DB.prepare(
      "SELECT id, name, email, platforms, confirmed_at FROM signups WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at",
    ).all<Tester>()
  ).results;

/**
 * The daily report: everyone confirmed (newest first), who confirmed in the last 24 hours, and how
 * many are still waiting to confirm. Sent when asked; otherwise just shown.
 */
async function dailyReport(env: Env, send: boolean) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const list = [...(await confirmedTesters(env))].reverse().map((t) => ({
    name: t.name,
    email: t.email,
    platforms: t.platforms.split(","),
    confirmedAt: t.confirmed_at,
    isNew: t.confirmed_at >= since,
  }));
  const waiting = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM signups WHERE confirmed_at IS NULL AND confirm_expires > ?",
  )
    .bind(new Date().toISOString())
    .first<{ n: number }>();
  const report = dailyReportEmail(list, waiting?.n ?? 0);
  const to = env.REPORT_EMAIL || env.OWNER_EMAIL;
  if (send) await sendEmail(env, { to, ...report });
  return { sent: send, to, subject: report.subject, preview: report.text };
}

async function testers(env: Env) {
  const list = await confirmedTesters(env);
  return json(
    { ok: true, testers: list.map(({ name, email, platforms, confirmed_at }) => ({ name, email, platforms: platforms.split(","), confirmed_at })) },
    200,
    null,
  );
}

/** How to get the build, for each platform, in the announcement. */
const HOW: Record<string, string> = {
  Android:
    "Open the link on your Android phone and download the app. If your phone asks, allow installing apps from your browser, then press Install. A newer build installs over the old one and keeps your games.",
  Web: "Opens in any browser, on a phone, tablet or computer. Nothing to install.",
  iPhone: "Opens TestFlight, Apple's app for beta testing: install it from the App Store if you haven't already.",
};

async function announce(env: Env, body: Record<string, unknown>) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const given = (body.links ?? {}) as Record<string, unknown>;
  const links: Record<string, string> = {};
  for (const platform of PLATFORMS) {
    const url = given[platform];
    if (typeof url === "string" && /^https:\/\/\S+$/.test(url)) links[platform] = url;
  }
  if (!title || title.length > 120) return json({ ok: false, error: "title" }, 400, null);
  if (!message || message.length > 5000) return json({ ok: false, error: "message" }, 400, null);
  if (Object.keys(links).length === 0) return json({ ok: false, error: "links" }, 400, null);

  // Each tester gets the links for the platforms they play on; nobody gets an empty email.
  const service = env.SERVICE_URL.replace(/\/$/, "");
  const plan: { tester: Tester; email: Email }[] = [];
  for (const tester of await confirmedTesters(env)) {
    const theirs = tester.platforms.split(",").filter((p) => links[p]);
    if (theirs.length === 0) continue;
    const leaveUrl = `${service}/leave?t=${await leaveToken(env, tester.id)}`;
    const content = announcementEmail(
      tester.name,
      title,
      message,
      theirs.map((platform) => ({ platform, url: links[platform]!, how: HOW[platform]! })),
      leaveUrl,
      `${env.SITE_URL.replace(/\/$/, "")}/beta/terms/`,
    );
    plan.push({ tester, email: { to: tester.email, ...content, leaveUrl } });
  }
  const recipients = plan.map(({ tester, email }) => ({
    name: tester.name,
    email: tester.email,
    platforms: tester.platforms.split(",").filter((p) => links[p]),
    preview: email.text,
  }));
  if (body.send !== true) return json({ ok: true, sent: 0, recipients }, 200, null);

  // Within the day's email allowance; anyone over it is reported, not dropped silently.
  const allowed: typeof plan = [];
  for (const entry of plan) {
    if (!(await allowEmail(env, limits(env).emailsPerDay))) break;
    allowed.push(entry);
  }
  const results = await sendEmails(env, allowed.map((entry) => entry.email));
  const failed = allowed.flatMap((entry, i) =>
    results[i] === true ? [] : [{ email: entry.tester.email, error: String(results[i]) }],
  );
  for (const failure of failed) console.error("Announcement not sent:", failure);
  return json(
    {
      ok: true,
      sent: results.filter((r) => r === true).length,
      failed,
      notSentToday: plan.slice(allowed.length).map((entry) => entry.tester.email),
      recipients,
    },
    200,
    null,
  );
}
