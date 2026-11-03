// "Tell me when it's out": the waiting lists for the projects still in the works. Anyone can join
// one from its page (no invite code), so the human check, the decoy field and the rate limits do
// the guarding; only those who confirm by email are on the list. Just the email, the project and
// what they agreed to are kept.
//
//   POST /waitlist          { project, email, consent, turnstile, website } → a confirmation email
//   GET  /waitlist/confirm?t=…                    → confirms, emails "you're on the list", then back to the site
//   GET|POST /waitlist/leave?t=…                  → removes them, then back to the site

import { allow, allowEmail, isHuman, leaveToken, leaveTokenId, newToken, sha256, visitorKey } from "./guard";
import { emailProblem } from "../../site/email-check.js";
import type { Env } from "./index";
import { sendEmail, sendEmails, waitlistConfirmationEmail, waitlistWelcomeEmail } from "./mail";

/** The projects with a waiting list, by the name their page and the service use. */
export const PROJECTS: Record<string, string> = {
  effugium: "Effugium Aura",
  secessio: "Secessio Aura",
  "familia-arbor": "Familia Arbor Aura",
};
/** Remove-me tokens for the waiting lists are signed apart from the beta's. */
const LIST = "waitlist-leave";
const CONFIRM_HOURS = 48;
const UNCONFIRMED_DAYS = 7;
/** Sign-ups per connection per hour; confirmation emails to one address for one project. */
const SIGNUPS_PER_HOUR = 6;
const EMAILS_PER_PERSON = 3;
const EMAILS_PER_DAY = 400;

export const consentText = (project: string) =>
  `Email me when ${PROJECTS[project]} is out. I've read the privacy policy.`;

const reply = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const back = (env: Env, path: string) => Response.redirect(`${env.SITE_URL.replace(/\/$/, "")}${path}`, 303);
const service = (env: Env) => env.SERVICE_URL.replace(/\/$/, "");

export async function waitlistSignup(
  env: Env,
  request: Request,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signupLimit = SIGNUPS_PER_HOUR,
) {
  if (!(await allow(env, "waitlist", await visitorKey(env, request), signupLimit))) {
    return reply({ ok: false, error: "too-many" }, 429, headers);
  }
  // The decoy field: people never see it, bots fill it in. Pretend all is well.
  if (typeof body.website === "string" && body.website.trim() !== "") return reply({ ok: true }, 200, headers);
  const project = typeof body.project === "string" ? body.project : "";
  if (!Object.hasOwn(PROJECTS, project)) return reply({ ok: false, error: "bad-project" }, 400, headers);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const emailIssue = emailProblem(email);
  if (emailIssue) return reply({ ok: false, ...emailIssue }, 400, headers);
  if (body.consent !== true) return reply({ ok: false, error: "need-consent" }, 400, headers);
  if (!(await isHuman(env, body.turnstile))) return reply({ ok: false, error: "human-check" }, 403, headers);

  const now = new Date();
  await env.DB.prepare("DELETE FROM waitlist WHERE confirmed_at IS NULL AND created_at < ?")
    .bind(new Date(now.getTime() - UNCONFIRMED_DAYS * 86_400_000).toISOString())
    .run();
  const existing = await env.DB.prepare(
    "SELECT confirmed_at, emails_sent FROM waitlist WHERE project = ? AND email = ?",
  )
    .bind(project, email)
    .first<{ confirmed_at: string | null; emails_sent: number }>();
  // Already on the list, or asked for enough emails: the same answer as anyone gets, so the form
  // never reveals who has signed up.
  if (existing?.confirmed_at || (existing && existing.emails_sent >= EMAILS_PER_PERSON)) {
    return reply({ ok: true }, 200, headers);
  }
  if (!(await allowEmail(env, EMAILS_PER_DAY))) return reply({ ok: false, error: "busy" }, 503, headers);

  const confirmToken = await newToken();
  const row = await env.DB.prepare(
    `INSERT INTO waitlist (project, email, consent_text, consent_at, created_at, confirm_hash, confirm_expires, emails_sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (project, email) DO UPDATE SET consent_text = excluded.consent_text,
       consent_at = excluded.consent_at, confirm_hash = excluded.confirm_hash,
       confirm_expires = excluded.confirm_expires, emails_sent = waitlist.emails_sent + 1
     RETURNING id`,
  )
    .bind(
      project,
      email,
      consentText(project),
      now.toISOString(),
      now.toISOString(),
      confirmToken.hash,
      new Date(now.getTime() + CONFIRM_HOURS * 3_600_000).toISOString(),
    )
    .first<{ id: number }>();

  const leaveUrl = `${service(env)}/waitlist/leave?t=${await leaveToken(env, row!.id, LIST)}`;
  const content = waitlistConfirmationEmail(PROJECTS[project]!, `${service(env)}/waitlist/confirm?t=${confirmToken.token}`, leaveUrl);
  try {
    await sendEmail(env, { to: email, ...content, leaveUrl });
  } catch (error) {
    // Couldn't send: don't count it against them, and say so plainly.
    console.error("Sending a waiting-list confirmation failed:", error);
    await env.DB.prepare("UPDATE waitlist SET emails_sent = MAX(emails_sent - 1, 0) WHERE id = ?").bind(row!.id).run();
    return reply({ ok: false, error: "mail" }, 502, headers);
  }
  return reply({ ok: true }, 200, headers);
}

export async function waitlistConfirm(env: Env, url: URL) {
  const token = url.searchParams.get("t") ?? "";
  if (!token) return back(env, "/waitlist/link-expired/");
  const row = await env.DB.prepare(
    "SELECT id, project, email, confirm_expires, confirmed_at FROM waitlist WHERE confirm_hash = ?",
  )
    .bind(await sha256(token))
    .first<{ id: number; project: string; email: string; confirm_expires: string; confirmed_at: string | null }>();
  if (!row) return back(env, "/waitlist/link-expired/");
  const done = `/waitlist/confirmed/?p=${encodeURIComponent(row.project)}`;
  if (row.confirmed_at) return back(env, done);
  if (row.confirm_expires < new Date().toISOString()) return back(env, "/waitlist/link-expired/");
  await env.DB.prepare("UPDATE waitlist SET confirmed_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  // Tell them they're on the list, with the way off it. If that fails, they're on it all the same.
  try {
    if (await allowEmail(env, EMAILS_PER_DAY)) {
      const leaveUrl = `${service(env)}/waitlist/leave?t=${await leaveToken(env, row.id, LIST)}`;
      const [result] = await sendEmails(env, [{ to: row.email, ...waitlistWelcomeEmail(PROJECTS[row.project] ?? "our project", leaveUrl), leaveUrl }]);
      if (result instanceof Error) throw result;
    }
  } catch (error) {
    console.error("Emailing a new waiting-list member failed:", error);
  }
  return back(env, done);
}

export async function waitlistLeave(env: Env, url: URL, method: string) {
  const token = url.searchParams.get("t") ?? "";
  const id = token ? await leaveTokenId(env, token, LIST) : null;
  if (id !== null) await env.DB.prepare("DELETE FROM waitlist WHERE id = ?").bind(id).run();
  // Mail apps' one-click unsubscribe (POST) just needs a 200.
  if (method === "POST") return new Response("Removed.", { status: 200 });
  return back(env, "/waitlist/left/");
}

/** Everyone confirmed on each waiting list (for the studio's tools and the daily report). */
export async function waitlists(env: Env) {
  const rows = (
    await env.DB.prepare(
      "SELECT project, email, confirmed_at FROM waitlist WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at",
    ).all<{ project: string; email: string; confirmed_at: string }>()
  ).results;
  return Object.entries(PROJECTS).map(([project, name]) => ({
    project,
    name,
    people: rows.filter((r) => r.project === project).map(({ email, confirmed_at }) => ({ email, confirmed_at })),
  }));
}
