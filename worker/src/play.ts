// For the beta's web build, which only signed-in testers can open: it lives behind its own
// Worker, which asks this one (over a service binding, with a shared key) to email a tester their
// sign-in link, or whether a guest creator's code is good. Nothing here says who is a tester: a
// sign-in link goes only to a confirmed tester (or an address on the allow list), and the answer
// is the same either way.

import { allow, isInternal, sha256 } from "./guard";
import type { Env } from "./index";
import { sendEmail } from "./mail";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Whether this address may play: a confirmed tester, or one on the allow list (a secret). */
async function mayPlay(env: Env, email: string): Promise<boolean> {
  const allowed = (env.PLAY_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.includes(email) || email === env.OWNER_EMAIL.toLowerCase()) return true;
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM signups WHERE email = ? AND confirmed_at IS NOT NULL",
  )
    .bind(email)
    .first<{ ok: number }>();
  return !!row;
}

function signInEmail(to: string, link: string) {
  const text = [
    "Here's your link to open the Ignis Aura beta in your browser:",
    "",
    link,
    "",
    "It works once, for 15 minutes, and keeps this browser signed in for 30 days.",
    "Didn't ask for it? Ignore this email: nothing happens without the link.",
  ].join("\n");
  const html = `<p>Here's your link to open the Ignis Aura beta in your browser:</p>
<p><a href="${link}">Open Ignis Aura</a></p>
<p>It works once, for 15 minutes, and keeps this browser signed in for 30 days.</p>
<p>Didn't ask for it? Ignore this email: nothing happens without the link.</p>`;
  return { to, subject: "Your link to the Ignis Aura beta", text, html };
}

/** Handles /internal/…: only with the shared key the web build's Worker holds. */
export async function internal(env: Env, request: Request, path: string): Promise<Response> {
  if (!isInternal(env, request)) return json({ ok: false, error: "internal" }, 401);
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (path === "/internal/play-link") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const link = typeof body.link === "string" ? body.link : "";
    if (!email || email.length > 254 || !link.startsWith("https://")) {
      return json({ ok: false, error: "bad-request" }, 400);
    }
    // A few a day for one address, so the box can't be used to flood someone's inbox.
    const key = (await sha256(`${env.IP_SALT}:${email}`)).slice(0, 24);
    if ((await allow(env, "play-link", key, 4)) && (await mayPlay(env, email))) {
      await sendEmail(env, signInEmail(email, link));
    }
    return json({ ok: true });
  }

  if (path === "/internal/guest-check") {
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!code || code.length > 80) return json({ ok: false });
    const row = await env.DB.prepare("SELECT name FROM guests WHERE code = ? AND active = 1")
      .bind(code)
      .first<{ name: string }>();
    return json({ ok: !!row, name: row?.name });
  }

  return json({ ok: false, error: "not-found" }, 404);
}
