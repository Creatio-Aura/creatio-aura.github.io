// Letting testers in. With no invite code anyone can sign up; confirming their email puts them in
// line, and Andrew lets each one in, or turns them away, from the link in the email the studio
// gets. Until then they can't open the web game or get build emails.
//
//   GET  /approve?t=…   → a page: who it is, where they'd play, and two buttons
//   POST /approve?t=…   → lets them in, and emails them (with the latest links for where they play)
//   POST /decline?t=…   → removes them; they hear nothing more
//   GET  /play-added?t=… → a page to tick off adding an Android tester to the app's Google Play test list
//   POST /play-added?t=… → ticks it off
//
// The link only opens a page: mail apps that check links by opening them can't let anyone in.

import { BETAS } from "./betas";
import { allowEmail, leaveToken, leaveTokenId } from "./guard";
import type { Env } from "./index";
import { howTo, sendEmail, welcomeEmail } from "./mail";

/** Approval tokens are signed apart from the remove-me ones. */
const LIST = "approve";
const EMAILS_PER_DAY = 400;
const service = (env: Env) => env.SERVICE_URL.replace(/\/$/, "");
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The link in the studio's email that opens the page for one sign-up. */
export const approveUrl = async (env: Env, id: number) => `${service(env)}/approve?t=${await leaveToken(env, id, LIST)}`;

/** The link that opens the page to tick off adding an Android tester to the Google Play test list. */
export const playAddedUrl = async (env: Env, id: number) => `${service(env)}/play-added?t=${await leaveToken(env, id, LIST)}`;

/** Android testers let in but not yet ticked off as added to their app's Google Play test list. */
export async function playToAdd(env: Env) {
  const rows = (
    await env.DB.prepare(
      "SELECT id, project, email, approved_at FROM signups WHERE approved_at IS NOT NULL AND play_added_at IS NULL AND (',' || platforms || ',') LIKE '%,Android,%' ORDER BY approved_at",
    ).all<{ id: number; project: string; email: string; approved_at: string }>()
  ).results;
  return Promise.all(
    rows.map(async (r) => ({
      project: r.project,
      app: BETAS[r.project]?.name ?? r.project,
      email: r.email,
      inSince: r.approved_at,
      url: await playAddedUrl(env, r.id),
    })),
  );
}

/** Ticks an Android tester off as added to their app's Google Play test list. */
export async function markPlayAdded(env: Env, id: number) {
  await env.DB.prepare("UPDATE signups SET play_added_at = ? WHERE id = ? AND play_added_at IS NULL").bind(new Date().toISOString(), id).run();
}

/** Where Andrew adds them, said the same everywhere. */
const PLAY_WHERE = (app: string) => `in Play Console, ${escape(app)} › Testing › Internal testing › Testers, add this address to the email list`;

/** A beta's latest build link for each platform (kept by each announcement that's sent). */
export async function currentBuilds(env: Env, project: string): Promise<Record<string, string>> {
  const rows = (
    await env.DB.prepare("SELECT platform, url FROM builds WHERE project = ?").bind(project).all<{ platform: string; url: string }>()
  ).results;
  return Object.fromEntries(rows.map((row) => [row.platform, row.url]));
}

export async function saveBuilds(env: Env, project: string, links: Record<string, string>) {
  const now = new Date().toISOString();
  for (const [platform, url] of Object.entries(links)) {
    await env.DB.prepare(
      "INSERT INTO builds (project, platform, url, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project, platform) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at",
    )
      .bind(project, platform, url, now)
      .run();
  }
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #120f1f; color: #f4eadb;
  font: 17px/1.55 Helvetica, Arial, sans-serif; padding: 24px; box-sizing: border-box; }
main { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 14px; }
h1 { margin: 0; font: 600 28px Georgia, serif; color: #ffb35c; }
p { margin: 0; color: #d8cbb6; }
b { color: #f4eadb; }
form { margin: 0; }
button { width: 100%; font: inherit; font-weight: 700; padding: 13px; border-radius: 99px; border: 0; background: #ff8a3d; color: #1d0f05; cursor: pointer; }
button.quiet { background: transparent; color: #f4eadb; border: 2px solid #5b4d78; }
</style></head><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
  );
}

export interface Signup {
  id: number;
  project: string;
  name: string;
  email: string;
  platforms: string;
  confirmed_at: string | null;
  approved_at: string | null;
  play_added_at?: string | null;
}

/**
 * Emails a tester that they're in, with the latest links for where they play (if there are any yet).
 * Sent when Andrew lets them in, and again on request (npm run welcome).
 */
export async function sendWelcome(env: Env, row: Pick<Signup, "id" | "project" | "name" | "email" | "platforms">, note = "") {
  const { content, links, leaveUrl } = await composeWelcome(env, row, note);
  let emailed = false;
  if (await allowEmail(env, EMAILS_PER_DAY)) {
    try {
      await sendEmail(env, { to: row.email, ...content, leaveUrl });
      emailed = true;
    } catch (error) {
      console.error("Emailing a tester they're in failed:", error);
    }
  }
  return { emailed, links };
}

/** The "You're in" email for a tester, with the latest links for where they play, unsent. */
export async function composeWelcome(env: Env, row: Pick<Signup, "id" | "project" | "name" | "email" | "platforms">, note = "") {
  const beta: { name: string; terms: boolean; guides?: { label: string; url: string; about: string }[] } = BETAS[row.project] ?? {
    name: row.project,
    terms: false,
  };
  const builds = await currentBuilds(env, row.project);
  const links = row.platforms
    .split(",")
    .filter((p) => builds[p])
    .map((platform) => ({ platform, url: builds[platform]!, how: howTo(platform, builds[platform]!, beta.name) }));
  const leaveUrl = `${service(env)}/leave?t=${await leaveToken(env, row.id)}`;
  const terms = beta.terms ? `${env.SITE_URL.replace(/\/$/, "")}/beta/terms/` : "";
  return { content: welcomeEmail(beta.name, row.name, leaveUrl, links, terms, beta.guides ?? [], note), links, leaveUrl };
}

/** Handles /approve and /decline: the page (GET), and the buttons on it (POST). */
export async function approval(env: Env, url: URL, method: string, path: string): Promise<Response> {
  const token = url.searchParams.get("t") ?? "";
  const id = token ? await leaveTokenId(env, token, LIST) : null;
  const row =
    id === null
      ? null
      : await env.DB.prepare("SELECT id, project, name, email, platforms, confirmed_at, approved_at, play_added_at FROM signups WHERE id = ?")
          .bind(id)
          .first<Signup>();
  if (!row) return page("Not here any more", "<p>That sign-up has gone: they left, or were turned away.</p>", 404);
  const who = `<b>${escape(row.email)}</b>`;
  const platforms = row.platforms.split(",");
  const beta = BETAS[row.project] ?? { name: row.project, terms: false };

  // Ticking off adding an Android tester to the Google Play test list.
  if (path === "/play-added") {
    if (!row.approved_at || !platforms.includes("Android")) return page("Nothing to add", `<p>${who} isn't an Android tester in the ${escape(beta.name)} beta.</p>`, 409);
    if (method === "POST") await markPlayAdded(env, row.id);
    if (method === "POST" || row.play_added_at) return page("Ticked off", `<p>${who} is ticked off as added to the ${escape(beta.name)} Google Play test.</p>`);
    return page(
      "Added on Google Play?",
      `<p>${PLAY_WHERE(beta.name)}:</p>
<p style="user-select: all; padding: 10px 14px; border-radius: 10px; background: #221c33; color: #f4eadb">${escape(row.email)}</p>
<form method="post" action="/play-added?t=${encodeURIComponent(token)}"><button type="submit">I've added them</button></form>`,
    );
  }

  if (method === "GET") {
    if (row.approved_at) return page("Already in", `<p>${who} is already in the ${escape(beta.name)} beta.</p>`);
    const action = (to: string) => `${to}?t=${encodeURIComponent(token)}`;
    return page(
      "Let them in?",
      `<p>${who} wants to join the ${escape(beta.name)} beta, on ${escape(platforms.join(", "))}.</p>
${platforms.includes("Android") ? "<p>On Android, Google Play only lets in the Google accounts on the test's tester list: add theirs in Play Console first (this address, if it's their Google one).</p>" : ""}
<form method="post" action="${action("/approve")}"><button type="submit">Let them in</button></form>
<form method="post" action="${action("/decline")}"><button class="quiet" type="submit">Turn them away</button></form>`,
    );
  }

  if (path === "/decline") {
    await env.DB.prepare("DELETE FROM signups WHERE id = ?").bind(row.id).run();
    return page("Turned away", `<p>${who} has been removed. They won't hear from us.</p>`);
  }
  if (!row.confirmed_at) return page("Not confirmed yet", `<p>${who} hasn't confirmed their email yet.</p>`, 409);
  if (row.approved_at) return page("Already in", `<p>${who} is already in the ${escape(beta.name)} beta.</p>`);

  await env.DB.prepare("UPDATE signups SET approved_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  const { emailed, links } = await sendWelcome(env, row);
  const told = emailed
    ? links.length
      ? `We've emailed them the links for ${escape(links.map((l) => l.platform).join(", "))}.`
      : "We've emailed them that they're in; the next build email will reach them."
    : "We couldn't email them just now, but they're in: the next build email will reach them.";
  const android = platforms.includes("Android")
    ? `<p><b>Now add them on Google Play:</b> ${PLAY_WHERE(beta.name)}. Their Google Play link won't let them in until you do.</p>
<p style="user-select: all; padding: 10px 14px; border-radius: 10px; background: #221c33; color: #f4eadb">${escape(row.email)}</p>
<form method="post" action="/play-added?t=${encodeURIComponent(token)}"><button type="submit">I've added them</button></form>
<p>Not yet? It stays on your list in the morning report, and in <b>npm run todo</b>, until you tick it off.</p>`
    : "";
  return page("They're in", `<p>${who} is in the ${escape(beta.name)} beta. ${told}</p>${android}`);
}
