// Feedback from the Ignis Aura app during the beta: a tester types a note (the app's menu → Send
// feedback) and it comes to the studio's inbox, with the app's version and device so a problem
// can be found. If they left their address, replying to the email answers them.
//
//   POST /feedback  { id, message, email?, version?, build?, platform?, device?, screen?, game? }
//                                                → { ok } once it's kept; the email follows
//
// An app on a phone sends no Origin; the web build sends its own, which must be an allowed one.
// Anyone could call this, so there are limits: a few a connection an hour, so many kept a day,
// and so many emailed a day (the rest wait for the next note, or the morning). Nothing is kept
// but what the app sent: no IP addresses.

import { allow, allowEmail, visitorKey } from "./guard";
import { emailProblem } from "../../site/email-check.js";
import type { Env } from "./index";
import { feedbackEmail, sendEmails, type Email } from "./mail";

/** The most of each detail an app sends with a note. */
const DETAIL_MAX = 200;
/** What an app may send with a note, in the order the email shows them. */
export const DETAILS = ["version", "build", "commit", "platform", "device", "screen", "game"] as const;
/**
 * Each app that sends notes: the most it lets someone write, and whether a note may hold links.
 * A note says which app it's from; one that doesn't is from Ignis Aura, which sent them first.
 */
const APPS = {
  ignis: { max: 4000, links: true },
  effugium: { max: 1000, links: false },
} as const;
type App = keyof typeof APPS;
/** Anything that reads as a link: a web address, or a name with a web ending. */
const LINK =
  /(https?:\/\/|www\.)|\b[a-z0-9-]+\.(com|net|org|io|app|co|me|ly|gg|xyz|info|biz|link|site|online|club|us|uk|ca|de|ru|cn)\b/i;
/** Per connection per hour (the tests raise it); kept a day from everyone; emailed a day. */
const PER_HOUR = 10;
const KEPT_PER_DAY = 300;
const EMAILED_PER_DAY = 60;
/** The service's own cap on emails a day, shared with the sign-ups. */
const EMAILS_PER_DAY = 400;

const reply = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();

/** Plain text: line breaks kept, other control characters dropped. */
const clean = (text: string) =>
  text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
/** One short line, or "" for none. */
const oneLine = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX)
    : "";

export async function feedback(
  env: Env,
  request: Request,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  ctx: ExecutionContext,
  perHour = PER_HOUR,
) {
  if (!(await allow(env, "feedback", await visitorKey(env, request), perHour))) {
    return reply({ ok: false, error: "too-many" }, 429, headers);
  }
  const app: App = body.app === "effugium" ? "effugium" : "ignis";
  const message = typeof body.message === "string" ? clean(body.message) : "";
  if (!message || message.length > APPS[app].max) return reply({ ok: false, error: "bad-message" }, 400, headers);
  if (!APPS[app].links && LINK.test(message)) return reply({ ok: false, error: "no-links" }, 400, headers);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const emailIssue = email ? emailProblem(email) : null;
  if (emailIssue) return reply({ ok: false, ...emailIssue }, 400, headers);
  // The app's own id for the note: a note it sends again (it never heard back) is kept once.
  const id = typeof body.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.id) ? body.id : null;
  const details: Record<string, string> = {
    app,
    ...Object.fromEntries(DETAILS.map((key) => [key, oneLine(body[key])]).filter(([, value]) => value)),
  };

  const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE created_at > ?")
    .bind(dayAgo())
    .first<{ n: number }>();
  if ((kept?.n ?? 0) >= KEPT_PER_DAY) return reply({ ok: false, error: "busy" }, 503, headers);
  await env.DB.prepare(
    "INSERT INTO feedback (client_id, created_at, message, email, details) VALUES (?, ?, ?, ?, ?) ON CONFLICT (client_id) DO NOTHING",
  )
    .bind(id, new Date().toISOString(), message, email || null, JSON.stringify(details))
    .run();
  // Kept: the app hears so straight away, and the email goes after.
  ctx.waitUntil(sendFeedback(env).catch((error) => console.error("Emailing feedback failed:", error)));
  return reply({ ok: true }, 200, headers);
}

interface Note {
  id: number;
  created_at: string;
  message: string;
  email: string | null;
  details: string;
  emailed_at: string | null;
}

// How long notes are kept, as the privacy pages say: older ones are deleted every morning, once emailed.
export const KEEP_FEEDBACK_YEARS = 2;

export async function forgetOldFeedback(env: Env): Promise<void> {
  const before = new Date();
  before.setUTCFullYear(before.getUTCFullYear() - KEEP_FEEDBACK_YEARS);
  await env.DB.prepare("DELETE FROM feedback WHERE created_at < ? AND emailed_at IS NOT NULL").bind(before.toISOString()).run();
}

/**
 * Emails the studio every note not yet emailed, as far as the day's allowance goes, and says how
 * many went. Each is claimed before it's sent, so two at once never send one twice; one that
 * fails is let go again, for next time.
 */
export async function sendFeedback(env: Env): Promise<number> {
  const emailed = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE emailed_at > ?")
    .bind(dayAgo())
    .first<{ n: number }>();
  const room = Math.min(EMAILED_PER_DAY - (emailed?.n ?? 0), 20);
  if (room <= 0) return 0;
  const waiting = (
    await env.DB.prepare("SELECT * FROM feedback WHERE emailed_at IS NULL ORDER BY id LIMIT ?").bind(room).all<Note>()
  ).results;

  const claimed: Note[] = [];
  const emails: Email[] = [];
  for (const note of waiting) {
    const claim = await env.DB.prepare("UPDATE feedback SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL")
      .bind(new Date().toISOString(), note.id)
      .run();
    if (claim.meta.changes !== 1) continue;
    if (!(await allowEmail(env, EMAILS_PER_DAY))) {
      await letGo(env, note.id);
      break;
    }
    // Whether they're on the beta list, to say so in the email (never to them).
    const tester = note.email
      ? await env.DB.prepare("SELECT name FROM signups WHERE email = ? AND approved_at IS NOT NULL")
          .bind(note.email)
          .first<{ name: string }>()
      : null;
    claimed.push(note);
    emails.push({
      to: env.FEEDBACK_EMAIL || env.OWNER_EMAIL,
      ...feedbackEmail(note.message, note.email, tester?.name ?? null, JSON.parse(note.details), note.created_at),
      replyTo: note.email ?? undefined,
      // Andrew (2026-11-05): every note from an app arrives marked urgent.
      urgent: true,
    });
  }
  if (emails.length === 0) return 0;
  const results = await sendEmails(env, emails);
  let sent = 0;
  for (const [i, result] of results.entries()) {
    if (result === true || result === "queued") sent++;
    else {
      console.error("A feedback email wasn't sent:", result);
      await letGo(env, claimed[i]!.id);
    }
  }
  return sent;
}

const letGo = (env: Env, id: number) =>
  env.DB.prepare("UPDATE feedback SET emailed_at = NULL WHERE id = ?").bind(id).run();

/** The latest notes, for the feedback tool. */
export async function latestFeedback(env: Env, limit = 100) {
  const rows = (
    await env.DB.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT ?").bind(limit).all<Note>()
  ).results;
  return rows.map(({ id, created_at, message, email, details, emailed_at }) => ({
    id,
    created_at,
    message,
    email,
    details: JSON.parse(details) as Record<string, string>,
    emailed: emailed_at !== null,
  }));
}

/** How many notes have come in since then, for the daily report. */
export async function feedbackSince(env: Env, since: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE created_at > ?")
    .bind(since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
