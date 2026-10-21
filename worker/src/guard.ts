// What keeps the beta list safe: the invite code, the human check, a short-lived pass that
// unlocks the form, rate limits, and the tokens in the email links (only their hashes are kept).

import type { Env } from "./index";

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** A random token for an email link, and the hash we keep instead of it. */
export async function newToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { token, hash: await sha256(token) };
}

/** Compares two strings in constant time, so the answer can't be timed out of it. */
function sameText(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

/** The invite code, forgiving case, spaces and dashes: "ember raven" = "EMBER-RAVEN". */
const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function isInviteCode(env: Env, code: unknown): boolean {
  return typeof code === "string" && code.length <= 80 && sameText(normalize(code), normalize(env.INVITE_CODE));
}

/** Cloudflare Turnstile: is this a person? */
export async function isHuman(env: Env, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}

const PASS_MINUTES = 30;

async function sign(env: Env, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.PASS_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

/** A pass that unlocks the sign-up form for half an hour, once the code and the check pass. */
export async function newPass(env: Env): Promise<string> {
  const expires = Date.now() + PASS_MINUTES * 60_000;
  return `${expires}.${await sign(env, `pass:${expires}`)}`;
}

export async function isPass(env: Env, pass: unknown): Promise<boolean> {
  if (typeof pass !== "string") return false;
  const [expires, signature] = pass.split(".");
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  return sameText(signature, await sign(env, `pass:${expires}`));
}

/** An anonymous key for this connection: a salted hash, never the address itself. */
export async function visitorKey(env: Env, request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return (await sha256(`${env.IP_SALT}:${address}`)).slice(0, 24);
}

const hourNow = () => Math.floor(Date.now() / 3_600_000);

/**
 * Counts one more try of this kind, by this key, this hour; false once there have been more
 * than `limit`. Old counts are cleared as it goes.
 */
export async function allow(env: Env, kind: string, key: string, limit: number): Promise<boolean> {
  const hour = hourNow();
  const row = await env.DB.prepare(
    `INSERT INTO attempts (kind, hour, key, count) VALUES (?, ?, ?, 1)
     ON CONFLICT (kind, hour, key) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(kind, hour, key)
    .first<{ count: number }>();
  if (Math.random() < 0.05) {
    await env.DB.prepare("DELETE FROM attempts WHERE hour < ?").bind(hour - 48).run();
  }
  return (row?.count ?? 0) <= limit;
}

/** How many emails have gone out in the last 24 hours (Gmail allows about 500 a day). */
export async function allowEmail(env: Env, limitPerDay: number): Promise<boolean> {
  const hour = hourNow();
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(count), 0) AS sent FROM attempts WHERE kind = 'email' AND hour > ?",
  )
    .bind(hour - 24)
    .first<{ sent: number }>();
  if ((row?.sent ?? 0) >= limitPerDay) return false;
  return allow(env, "email", "all", Number.MAX_SAFE_INTEGER);
}
