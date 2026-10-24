// Guest creators: friends write scenarios in the online creator with an invite code, and submit
// them here. Andrew (signed in to the creator with his GitHub token) creates the codes, reviews
// what's submitted, and approves (it goes into his changes, then out with Publish to testers),
// asks for changes with a note, or declines. Guests never touch GitHub or the game directly.

import { isAdmin } from "./guard";
import type { Env } from "./index";

/** The repo whose writers count as Andrew (or anyone he lets publish). */
const REPO = "Creatio-Aura/IgnisAura";
/** The most a submitted scenario can weigh, and how many one guest can have. */
const SUBMISSION_MAX_BYTES = 60_000;
const SUBMISSIONS_PER_GUEST = 60;
const WORDS = [
  "ASH",
  "EMBER",
  "RAVEN",
  "WOLF",
  "OAK",
  "RUNE",
  "MOTH",
  "IRON",
  "STAR",
  "FEN",
  "HOLLOW",
  "LANTERN",
];

type Json = Record<string, unknown>;
const now = () => new Date().toISOString();
const reply = (
  body: unknown,
  status: number,
  headers: Record<string, string>,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** A code like EMBER-RAVEN-4172. */
function newCode(): string {
  const pick = new Uint32Array(3);
  crypto.getRandomValues(pick);
  const word = (n: number) => WORDS[n % WORDS.length];
  return `${word(pick[0]!)}-${word(pick[1]!)}-${String(pick[2]! % 10000).padStart(4, "0")}`;
}

/** Whether this GitHub token can publish to the game's repo: Andrew, signed in to his creator. */
async function canPublish(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length < 20) return false;
  const response = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "creatio-aura-guests",
    },
  });
  if (!response.ok) return false;
  const repo = (await response.json()) as { permissions?: { push?: boolean } };
  return repo.permissions?.push === true;
}

async function guestFor(env: Env, code: unknown) {
  if (typeof code !== "string") return null;
  return env.DB.prepare(
    "SELECT code, name FROM guests WHERE code = ? AND active = 1",
  )
    .bind(code.trim().toUpperCase())
    .first<{ code: string; name: string }>();
}

const asSubmission = (row: Record<string, unknown>) => ({
  id: row.id,
  guest: row.name,
  title: row.title,
  where: JSON.parse(String(row.where_json)),
  encounter: JSON.parse(String(row.encounter_json)),
  status: row.status,
  note: row.note,
  updated: row.updated_at,
});

/** Handles /guests/…; every call is a POST with a JSON body. */
export async function guests(
  env: Env,
  request: Request,
  path: string,
  body: Json,
  headers: Record<string, string>,
): Promise<Response> {
  const ok = (data: Json) => reply({ ok: true, ...data }, 200, headers);
  const no = (error: string, status = 400) =>
    reply({ ok: false, error }, status, headers);

  // Andrew's side: his GitHub token proves it's him.
  if (path.startsWith("/guests/admin/")) {
    // Or the admin key, from Creatio Aura's own tools (and the tests).
    if (!isAdmin(env, request) && !(await canPublish(body.github)))
      return no("not-allowed", 401);
    if (path === "/guests/admin/list") {
      const guestRows = await env.DB.prepare(
        "SELECT code, name, active, created_at FROM guests ORDER BY created_at DESC",
      ).all();
      const rows = await env.DB.prepare(
        "SELECT s.*, g.name FROM submissions s JOIN guests g ON g.code = s.code ORDER BY s.updated_at DESC",
      ).all();
      return ok({
        guests: guestRows.results,
        submissions: rows.results.map(asSubmission),
      });
    }
    if (path === "/guests/admin/guest") {
      const name = String(body.name ?? "")
        .trim()
        .slice(0, 60);
      if (!name) return no("name");
      const code = newCode();
      await env.DB.prepare(
        "INSERT INTO guests (code, name, created_at) VALUES (?, ?, ?)",
      )
        .bind(code, name, now())
        .run();
      return ok({ code, name });
    }
    if (path === "/guests/admin/guest-active") {
      await env.DB.prepare("UPDATE guests SET active = ? WHERE code = ?")
        .bind(body.active ? 1 : 0, String(body.code ?? ""))
        .run();
      return ok({});
    }
    if (path === "/guests/admin/review") {
      const status = String(body.status ?? "");
      if (!["approved", "changes", "declined"].includes(status))
        return no("status");
      await env.DB.prepare(
        "UPDATE submissions SET status = ?, note = ?, updated_at = ? WHERE id = ?",
      )
        .bind(
          status,
          String(body.note ?? "").slice(0, 2000) || null,
          now(),
          Number(body.id),
        )
        .run();
      return ok({});
    }
    return no("not-found", 404);
  }

  // A guest's side: their code.
  const guest = await guestFor(env, body.code);
  if (!guest) return no("code", 401);
  if (path === "/guests/login")
    return ok({ name: guest.name, code: guest.code });
  if (path === "/guests/mine") {
    const rows = await env.DB.prepare(
      "SELECT s.*, g.name FROM submissions s JOIN guests g ON g.code = s.code WHERE s.code = ? ORDER BY s.updated_at DESC",
    )
      .bind(guest.code)
      .all();
    return ok({ submissions: rows.results.map(asSubmission) });
  }
  if (path === "/guests/submit") {
    const encounter = JSON.stringify(body.encounter ?? null);
    const where = JSON.stringify(body.where ?? null);
    if (encounter === "null" || encounter.length > SUBMISSION_MAX_BYTES)
      return no("size");
    const title =
      String((body.encounter as Json)?.title ?? "").slice(0, 120) ||
      "(untitled)";
    // Resubmitting one sent back for changes updates it; otherwise it's new.
    if (body.id !== undefined) {
      const done = await env.DB.prepare(
        "UPDATE submissions SET title = ?, where_json = ?, encounter_json = ?, status = 'submitted', updated_at = ? WHERE id = ? AND code = ? AND status IN ('submitted', 'changes')",
      )
        .bind(title, where, encounter, now(), Number(body.id), guest.code)
        .run();
      if (done.meta.changes) return ok({ id: Number(body.id) });
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE code = ?",
    )
      .bind(guest.code)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= SUBMISSIONS_PER_GUEST) return no("too-many");
    const stamp = now();
    const made = await env.DB.prepare(
      "INSERT INTO submissions (code, title, where_json, encounter_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(guest.code, title, where, encounter, stamp, stamp)
      .run();
    return ok({ id: made.meta.last_row_id });
  }
  return no("not-found", 404);
}
