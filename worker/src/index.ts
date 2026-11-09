// The Ignis Aura beta sign-up service (a Cloudflare Worker, with a D1 database).
//
//   POST /signup      { project, email, platforms, consent, turnstile, website, source } (betas.ts)
//                                                          → sends a confirmation email
//   GET  /confirm?t=…                                      → confirms, asks Andrew to let them in, back to the site
//   GET  /approve?t=…, POST /approve|/decline?t=…          → Andrew lets them in, or turns them away (approve.ts)
//   GET|POST /leave?t=…                                    → removes them, then back to the site
//   POST /waitlist, GET /waitlist/confirm, /waitlist/leave → "tell me when it's out" (waitlist.ts)
//   POST /feedback                                         → a tester's note from the app (feedback.ts)
//
// And for Creatio Aura only, with the admin key (worker/tools/):
//   GET  /admin/testers                                    → every tester, with platforms, and who's waiting
//   POST /admin/announce { title, message, links, send }   → emails testers their builds
//   POST /admin/report { send }                            → the daily report (also sent every morning)
//   POST /admin/builds { project, links }                  → stores a beta's latest links (no emails); shows them
//   POST /admin/welcome { project, email, send }           → one tester's "You're in" email again, with the links
//   POST /admin/add { project, emails, platforms, onPlayList, send } → people Andrew invited himself, let in and welcomed
//   GET  /admin/todo                                       → Android testers still to add to a Google Play test list
//   POST /admin/todo { project, email }                    → ticks one off
//   GET  /admin/waitlist                                   → everyone confirmed on each waiting list
//   GET  /admin/feedback                                   → the latest notes from the app
//
// Anyone can sign up (since 7 November 2026 there's no invite code): the human check, the decoy
// field and the rate limits keep bots off, confirming by email proves the address, and Andrew lets
// each one in. Nothing is kept but what they typed: no IP addresses. The list lives in the D1
// database, readable only from Andrew's Cloudflare account.

import { allow, allowEmail, isAdmin, isHuman, leaveToken, leaveTokenId, newToken, sha256, visitorKey } from "./guard";
import { approval, approveUrl, composeWelcome, currentBuilds, markPlayAdded, playToAdd, saveBuilds, sendWelcome } from "./approve";
import { BETAS, betaOf } from "./betas";
import { emailProblem } from "../../site/email-check.js";
import { feedback, feedbackSince, forgetOldFeedback, latestFeedback, sendFeedback } from "./feedback";
import { guests } from "./guests";
import { internal } from "./play";
import { waitlistConfirm, waitlistLeave, waitlists, waitlistSignup } from "./waitlist";
import {
  announcementEmail,
  dailyReportEmail,
  confirmationEmail,
  howTo,
  sendEmail,
  sendEmails,
  waitingEmail,
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
  /** The mail server emails go out through, and the mailbox (and From address) it signs in as. */
  SMTP_HOST: string;
  SMTP_USER: string;
  /** Where "someone wants in" notes go. */
  OWNER_EMAIL: string;
  /** Where the daily report goes; the owner's email if not set. */
  REPORT_EMAIL?: string;
  /** Where feedback from the app goes; the owner's email if not set. */
  FEEDBACK_EMAIL?: string;
  /** "smtp" to send through the mail server, "test" to keep emails in the outbox table. */
  MAIL_MODE: string;
  /** Tries per connection per hour; defaults 6 and 10 (the tests raise them). */
  SIGNUP_LIMIT?: string;
  FEEDBACK_LIMIT?: string;
  // Secrets (wrangler secret put …), never in the repo:
  TURNSTILE_SECRET: string;
  PASS_SECRET: string;
  IP_SALT: string;
  /** The SMTP_USER mailbox's password. */
  SMTP_PASSWORD: string;
  /** The key the announce and testers tools use. */
  ADMIN_TOKEN: string;
  /** The key the web build's Worker uses for /internal/… (sign-in links, guest codes). */
  INTERNAL_TOKEN?: string;
  /** Addresses that may open the web build without signing up (comma-separated). */
  PLAY_ALLOW?: string;
}

/** Per connection per hour (sign-ups, feedback); emails per day; emails to one address. */
const limits = (env: Env) => ({
  signups: Number(env.SIGNUP_LIMIT ?? 6),
  feedback: Number(env.FEEDBACK_LIMIT ?? 10),
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
  // Every morning (wrangler.toml's cron), the studio's report on the beta list, any feedback that
  // couldn't be emailed yet, and notes older than the privacy pages say they're kept deleted.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailyReport(env, true).then(() => undefined));
    ctx.waitUntil(sendFeedback(env).then(() => undefined));
    ctx.waitUntil(forgetOldFeedback(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
    const origin = request.headers.get("Origin");
    const okOrigin = origin && allowed.includes(origin) ? origin : null;

    // The email links: opened from a mail app, so no Origin to check.
    if (url.pathname === "/confirm" && request.method === "GET") return confirm(env, url);
    if (url.pathname === "/leave" && (request.method === "GET" || request.method === "POST")) {
      return leave(env, url, request.method);
    }
    if (url.pathname === "/waitlist/confirm" && request.method === "GET") return waitlistConfirm(env, url);
    if (url.pathname === "/waitlist/leave" && (request.method === "GET" || request.method === "POST")) {
      return waitlistLeave(env, url, request.method);
    }
    // Letting someone in: the link in the studio's email opens a page, whose buttons post back here.
    if (url.pathname === "/approve" && (request.method === "GET" || request.method === "POST")) {
      return approval(env, url, request.method, url.pathname);
    }
    if (url.pathname === "/decline" && request.method === "POST") return approval(env, url, "POST", url.pathname);
    if (url.pathname === "/play-added" && (request.method === "GET" || request.method === "POST")) {
      return approval(env, url, request.method, url.pathname);
    }
    if (url.pathname === "/__outbox" && env.MAIL_MODE === "test") return outbox(env);
    // The web build's Worker, over a service binding: sign-in links and guest codes.
    if (url.pathname.startsWith("/internal/")) {
      try {
        return await internal(env, request, url.pathname);
      } catch (error) {
        console.error(error);
        return json({ ok: false, error: "server" }, 500, null);
      }
    }
    // Creatio Aura's own tools, from a computer rather than the site: the admin key instead.
    if (url.pathname.startsWith("/admin/")) {
      if (!isAdmin(env, request)) return json({ ok: false, error: "admin" }, 401, null);
      try {
        if (url.pathname === "/admin/testers" && request.method === "GET") return await testers(env);
        if (url.pathname === "/admin/waitlist" && request.method === "GET") {
          return json({ ok: true, lists: await waitlists(env) }, 200, null);
        }
        if (url.pathname === "/admin/feedback" && request.method === "GET") {
          return json({ ok: true, notes: await latestFeedback(env) }, 200, null);
        }
        if (url.pathname === "/admin/announce" && request.method === "POST") {
          return await announce(env, (await request.json()) as Record<string, unknown>);
        }
        if (url.pathname === "/admin/builds" && request.method === "POST") {
          return await builds(env, (await request.json()) as Record<string, unknown>);
        }
        if (url.pathname === "/admin/welcome" && request.method === "POST") {
          return await welcomeAgain(env, (await request.json()) as Record<string, unknown>);
        }
        if (url.pathname === "/admin/add" && request.method === "POST") {
          return await addTesters(env, (await request.json()) as Record<string, unknown>);
        }
        if (url.pathname === "/admin/todo" && request.method === "GET") {
          return json({ ok: true, play: await playToAdd(env) }, 200, null);
        }
        if (url.pathname === "/admin/todo" && request.method === "POST") {
          const body = (await request.json()) as Record<string, unknown>;
          const project = betaOf(body.project);
          const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          const row = project
            ? await env.DB.prepare("SELECT id FROM signups WHERE project = ? AND lower(email) = ? AND approved_at IS NOT NULL")
                .bind(project, email)
                .first<{ id: number }>()
            : null;
          if (!row) return json({ ok: false, error: "not-a-tester" }, 404, null);
          await markPlayAdded(env, row.id);
          return json({ ok: true, play: await playToAdd(env) }, 200, null);
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

    // Everything else is the sign-up form, and only from our own site; feedback comes from the
    // app as well, and an app on a phone sends no Origin at all (a browser always does).
    const fromApp = url.pathname === "/feedback" && origin === null;
    if (!okOrigin && !fromApp) return json({ ok: false, error: "origin" }, 403, null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(okOrigin) });
    if (request.method !== "POST") return json({ ok: false, error: "method" }, 405, okOrigin);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "bad-request" }, 400, okOrigin);
    }
    try {
      if (url.pathname === "/signup") return await signup(env, request, body, okOrigin);
      if (url.pathname === "/waitlist") return await waitlistSignup(env, request, body, cors(okOrigin), limits(env).signups);
      if (url.pathname === "/feedback") return await feedback(env, request, body, cors(okOrigin), ctx, limits(env).feedback);
      // Guest creators, from the online creator (on the same site).
      if (url.pathname.startsWith("/guests/")) {
        // Plenty for a guest at work; slow for anyone guessing codes.
        if (!(await allow(env, "guests", await visitorKey(env, request), 600)))
          return json({ ok: false, error: "slow-down" }, 429, okOrigin);
        return await guests(env, request, url.pathname, body, cors(okOrigin));
      }
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: "server" }, 500, okOrigin);
    }
    return json({ ok: false, error: "not-found" }, 404, okOrigin);
  },
};

async function signup(env: Env, request: Request, body: Record<string, unknown>, origin: string | null) {
  const key = await visitorKey(env, request);
  if (!(await allow(env, "signup", key, limits(env).signups))) {
    return json({ ok: false, error: "too-many" }, 429, origin);
  }
  // The decoy field: people never see it, bots fill it in. Pretend all is well.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true }, 200, origin);
  }

  const project = betaOf(body.project);
  if (!project) return json({ ok: false, error: "bad-project" }, 400, origin);
  const beta = BETAS[project]!;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const platforms = Array.isArray(body.platforms)
    ? beta.platforms.filter((p) => (body.platforms as unknown[]).includes(p))
    : [];
  // The same check as the form's (site/email-check.js): a real address, and no typo like ".con".
  const emailIssue = emailProblem(email);
  if (emailIssue) return json({ ok: false, ...emailIssue }, 400, origin);
  if (platforms.length === 0) return json({ ok: false, error: "pick-platform" }, 400, origin);
  if (body.consent !== true) return json({ ok: false, error: "need-consent" }, 400, origin);
  // Where they came from: a short code from the form ("web_jb_<post>", "ref_google", "direct"), so the
  // testers report shows which pages bring sign-ups without any analytics. Anything else is dropped.
  const source = typeof body.source === "string" && /^[a-z0-9_]{1,80}$/.test(body.source) ? body.source : "";
  // With no invite code, the human check is what stands between the form and bots.
  if (!(await isHuman(env, body.turnstile))) return json({ ok: false, error: "human-check" }, 403, origin);

  const now = new Date();
  // Unconfirmed sign-ups don't linger.
  await env.DB.prepare("DELETE FROM signups WHERE confirmed_at IS NULL AND created_at < ?")
    .bind(new Date(now.getTime() - UNCONFIRMED_DAYS * 86_400_000).toISOString())
    .run();

  const existing = await env.DB.prepare(
    "SELECT confirmed_at, emails_sent, last_email_at FROM signups WHERE project = ? AND email = ?",
  )
    .bind(project, email)
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
    `INSERT INTO signups (project, email, platforms, consent_text, consent_at, created_at,
       confirm_hash, confirm_expires, leave_hash, emails_sent, last_email_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (project, email) DO UPDATE SET platforms = excluded.platforms,
       source = CASE WHEN signups.source = '' THEN excluded.source ELSE signups.source END,
       consent_text = excluded.consent_text, consent_at = excluded.consent_at,
       confirm_hash = excluded.confirm_hash, confirm_expires = excluded.confirm_expires,
       leave_hash = excluded.leave_hash, emails_sent = signups.emails_sent + 1,
       last_email_at = excluded.last_email_at
     RETURNING id`,
  )
    .bind(
      project,
      email,
      platforms.join(","),
      beta.consent,
      now.toISOString(),
      now.toISOString(),
      confirmToken.hash,
      expires,
      legacyLeave.hash,
      now.toISOString(),
      source,
    )
    .first<{ id: number }>();

  const service = env.SERVICE_URL.replace(/\/$/, "");
  const leaveUrl = `${service}/leave?t=${await leaveToken(env, row!.id)}`;
  const content = confirmationEmail(beta.name, "", `${service}/confirm?t=${confirmToken.token}`, leaveUrl);
  try {
    await sendEmail(env, { to: email, ...content, leaveUrl });
  } catch (error) {
    // Couldn't send: don't count it against them, and say so plainly.
    console.error("Sending the confirmation email failed:", error);
    await env.DB.prepare("UPDATE signups SET emails_sent = MAX(emails_sent - 1, 0) WHERE project = ? AND email = ?")
      .bind(project, email)
      .run();
    return json({ ok: false, error: "mail" }, 502, origin);
  }
  return json({ ok: true }, 200, origin);
}

async function confirm(env: Env, url: URL) {
  const token = url.searchParams.get("t") ?? "";
  if (!token) return redirect(env, "/beta/link-expired/");
  const row = await env.DB.prepare(
    "SELECT id, project, email, platforms, confirm_expires, confirmed_at FROM signups WHERE confirm_hash = ?",
  )
    .bind(await sha256(token))
    .first<{
      id: number;
      project: string;
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
  // Ask Andrew to let them in. If the email fails, they're confirmed all the same, and the
  // morning report lists them too.
  try {
    const waiting = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM signups WHERE confirmed_at IS NOT NULL AND approved_at IS NULL",
    ).first<{ n: number }>();
    const app = BETAS[row.project]?.name ?? row.project;
    await sendEmail(env, {
      to: env.OWNER_EMAIL,
      ...waitingEmail(app, row.email, row.platforms.split(","), await approveUrl(env, row.id), waiting?.n ?? 0),
    });
  } catch (error) {
    console.error("Asking the studio to let a tester in failed:", error);
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
  const rows = await env.DB.prepare("SELECT to_addr, subject, body, reply_to FROM outbox ORDER BY id DESC LIMIT 20").all();
  return new Response(JSON.stringify(rows.results), { headers: { "Content-Type": "application/json" } });
}

interface Tester {
  id: number;
  project: string;
  name: string;
  email: string;
  platforms: string;
  notes: string;
  confirmed_at: string;
  approved_at: string | null;
  source: string;
}

/** Everyone let into a beta, oldest first. */
const testersIn = async (env: Env, project: string) =>
  (
    await env.DB.prepare(
      "SELECT id, project, name, email, platforms, notes, confirmed_at, approved_at, source FROM signups WHERE project = ? AND approved_at IS NOT NULL ORDER BY approved_at",
    )
      .bind(project)
      .all<Tester>()
  ).results;

/** Everyone who's confirmed and waits for Andrew, in every beta, oldest first. */
const waitingForOk = async (env: Env) =>
  (
    await env.DB.prepare(
      "SELECT id, project, name, email, platforms, notes, confirmed_at, approved_at, source FROM signups WHERE confirmed_at IS NOT NULL AND approved_at IS NULL ORDER BY confirmed_at",
    ).all<Tester>()
  ).results;

/**
 * The daily report: who's waiting to be let in (with the links to decide), and for each beta who's
 * been let in since the last report was sent (or in the last day, before the first), everyone in
 * it, and how many are still to confirm. Sent when asked, and then remembered; otherwise shown.
 */
async function dailyReport(env: Env, send: boolean) {
  const last = await env.DB.prepare("SELECT sent_at FROM reports ORDER BY sent_at DESC LIMIT 1").first<{
    sent_at: string;
  }>();
  const since = last?.sent_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const betas = [];
  for (const [project, beta] of Object.entries(BETAS)) {
    const testers = [...(await testersIn(env, project))].reverse().map((t) => ({
      name: t.name,
      email: t.email,
      platforms: t.platforms.split(","),
      notes: t.notes,
      inSince: t.approved_at!,
      isNew: t.approved_at! > since,
    }));
    const unconfirmed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM signups WHERE project = ? AND confirmed_at IS NULL AND confirm_expires > ?",
    )
      .bind(project, now)
      .first<{ n: number }>();
    betas.push({ name: beta.name, platforms: beta.platforms, testers, waitingToConfirm: unconfirmed?.n ?? 0 });
  }
  const waitingForYou = [];
  for (const t of await waitingForOk(env)) {
    waitingForYou.push({
      app: BETAS[t.project]?.name ?? t.project,
      email: t.email,
      platforms: t.platforms.split(","),
      confirmedAt: t.confirmed_at,
      approveUrl: await approveUrl(env, t.id),
    });
  }
  const lists = (await waitlists(env)).map((l) => ({
    name: l.name,
    total: l.people.length,
    fresh: l.people.filter((p) => p.confirmed_at > since).length,
  }));
  const report = dailyReportEmail(betas, waitingForYou, last ? since : null, lists, await feedbackSince(env, since), await playToAdd(env));
  const to = env.REPORT_EMAIL || env.OWNER_EMAIL;
  if (send) {
    await sendEmail(env, { to, ...report });
    await env.DB.prepare("INSERT INTO reports (sent_at) VALUES (?)").bind(new Date().toISOString()).run();
  }
  return { sent: send, to, subject: report.subject, preview: report.text };
}

/** Everyone in each beta, and who's waiting to be let in: for npm run testers. */
async function testers(env: Env) {
  const shape = (t: Tester) => ({
    project: t.project,
    name: t.name,
    email: t.email,
    platforms: t.platforms.split(","),
    notes: t.notes,
    confirmed_at: t.confirmed_at,
    approved_at: t.approved_at,
    source: t.source,
  });
  const inBetas = [];
  for (const project of Object.keys(BETAS)) inBetas.push(...(await testersIn(env, project)).map(shape));
  return json({ ok: true, testers: inBetas, waiting: (await waitingForOk(env)).map(shape) }, 200, null);
}

/** A beta's links for its platforms from a request: https only, and only platforms the beta has. */
function linksFor(project: string, given: unknown): Record<string, string> {
  const links: Record<string, string> = {};
  const from = (given ?? {}) as Record<string, unknown>;
  for (const platform of BETAS[project]!.platforms) {
    const url = from[platform];
    if (typeof url === "string" && /^https:\/\/\S+$/.test(url)) links[platform] = url;
  }
  return links;
}

/**
 * Stores a beta's latest build links without emailing anyone, so everyone let in from now on gets
 * them in their welcome. With no links, it only shows what's stored.
 */
async function builds(env: Env, body: Record<string, unknown>) {
  const project = betaOf(body.project);
  if (!project) return json({ ok: false, error: "project" }, 400, null);
  const links = linksFor(project, body.links);
  if (Object.keys(links).length) await saveBuilds(env, project, links);
  return json({ ok: true, project, builds: await currentBuilds(env, project) }, 200, null);
}

/**
 * People Andrew invited himself (for example, already on a Google Play tester list): let in straight
 * away and sent the "You're in" email. They never used the form, so their record says so instead of
 * a consent they didn't give; every email still has their remove-me link. A dry run without send.
 */
async function addTesters(env: Env, body: Record<string, unknown>) {
  const project = betaOf(body.project);
  if (!project) return json({ ok: false, error: "project" }, 400, null);
  const beta = BETAS[project]!;
  const platforms = (Array.isArray(body.platforms) ? body.platforms : []).filter(
    (p): p is string => typeof p === "string" && beta.platforms.includes(p),
  );
  if (platforms.length === 0) return json({ ok: false, error: "platforms" }, 400, null);
  const emails = [
    ...new Set(
      (Array.isArray(body.emails) ? body.emails : [])
        .filter((e): e is string => typeof e === "string")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
    ),
  ];
  if (emails.length === 0 || emails.length > 100) return json({ ok: false, error: "emails" }, 400, null);
  const already = new Set(
    (
      await env.DB.prepare(`SELECT email FROM signups WHERE project = ? AND email IN (${emails.map(() => "?").join(",")})`)
        .bind(project, ...emails)
        .all<{ email: string }>()
    ).results.map((r) => r.email),
  );
  const add = emails.filter((e) => !already.has(e));
  const onPlay = body.onPlayList === true && platforms.includes("Android");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 600) : "";
  if (body.send !== true) {
    const sample = add[0] ?? emails[0]!;
    const preview = (await composeWelcome(env, { id: 0, project, name: "", email: sample, platforms: platforms.join(",") }, note)).content.text;
    return json({ ok: true, sent: 0, add, already: [...already], platforms, onPlayList: onPlay, preview }, 200, null);
  }
  const now = new Date().toISOString();
  const consent = `Added by Andrew, not through the form: he invited them to test${onPlay ? " and put them on the Google Play tester list" : ""} (${now.slice(0, 10)}).`;
  const sent: string[] = [];
  const notSent: string[] = [];
  for (const email of add) {
    const row = await env.DB.prepare(
      `INSERT INTO signups (project, email, platforms, notes, consent_text, consent_at, created_at, confirmed_at,
         leave_hash, approved_at, play_added_at, source)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'added_by_andrew') RETURNING id, project, name, email, platforms`,
    )
      .bind(project, email, platforms.join(","), consent, now, now, now, (await newToken()).hash, now, onPlay ? now : null)
      .first<{ id: number; project: string; name: string; email: string; platforms: string }>();
    const { emailed } = await sendWelcome(env, row!, note);
    (emailed ? sent : notSent).push(email);
  }
  return json({ ok: true, sent: sent.length, added: add, notSent, already: [...already] }, 200, null);
}

/** One tester's "You're in" email again, with the links stored now. Shows what it would send without send. */
async function welcomeAgain(env: Env, body: Record<string, unknown>) {
  const project = betaOf(body.project);
  if (!project) return json({ ok: false, error: "project" }, 400, null);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const row = await env.DB.prepare(
    "SELECT id, project, name, email, platforms FROM signups WHERE project = ? AND lower(email) = ? AND approved_at IS NOT NULL",
  )
    .bind(project, email)
    .first<{ id: number; project: string; name: string; email: string; platforms: string }>();
  if (!row) return json({ ok: false, error: "not-a-tester" }, 404, null);
  const stored = await currentBuilds(env, project);
  const platforms = row.platforms.split(",");
  const links = platforms.filter((p) => stored[p]);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 600) : "";
  if (body.send !== true) {
    const preview = (await composeWelcome(env, row, note)).content.text;
    return json({ ok: true, sent: false, email: row.email, platforms, links, preview }, 200, null);
  }
  const { emailed } = await sendWelcome(env, row, note);
  return json({ ok: true, sent: emailed, email: row.email, platforms, links }, 200, null);
}

async function announce(env: Env, body: Record<string, unknown>) {
  const project = betaOf(body.project);
  if (!project) return json({ ok: false, error: "project" }, 400, null);
  const beta = BETAS[project]!;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const links = linksFor(project, body.links);
  if (!title || title.length > 120) return json({ ok: false, error: "title" }, 400, null);
  if (!message || message.length > 5000) return json({ ok: false, error: "message" }, 400, null);
  if (Object.keys(links).length === 0) return json({ ok: false, error: "links" }, 400, null);

  // Each tester gets the links for the platforms they play on; nobody gets an empty email.
  const service = env.SERVICE_URL.replace(/\/$/, "");
  const plan: { tester: Tester; email: Email }[] = [];
  for (const tester of await testersIn(env, project)) {
    const theirs = tester.platforms.split(",").filter((p) => links[p]);
    if (theirs.length === 0) continue;
    const leaveUrl = `${service}/leave?t=${await leaveToken(env, tester.id)}`;
    const content = announcementEmail(
      beta.name,
      tester.name,
      title,
      message,
      theirs.map((platform) => ({ platform, url: links[platform]!, how: howTo(platform, links[platform]!, beta.name) })),
      leaveUrl,
      beta.terms ? `${env.SITE_URL.replace(/\/$/, "")}/beta/terms/` : "",
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
  // These are the latest builds now: whoever's let in later gets them straight away.
  await saveBuilds(env, project, links);

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
