// Runs the sign-up service locally (Cloudflare's own runtime, through wrangler dev, with a
// throwaway local database) and walks people through it: npm test. Emails are kept in the
// test outbox instead of sent. Turnstile uses Cloudflare's always-passes test key.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "https://creatio-aura.github.io";
const CODE = "EMBER-RAVEN-LANTERN-THORN-4821";
const cwd = new URL("..", import.meta.url);
const state = mkdtempSync(join(tmpdir(), "beta-test-"));
let server;

const vars = {
  MAIL_MODE: "test",
  INVITE_CODE: CODE,
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
  PASS_SECRET: "test-pass-secret",
  IP_SALT: "test-salt",
  GMAIL_APP_PASSWORD: "unused",
  SERVICE_URL: BASE,
  // Every test comes from one machine: room for them all, while still testing the limit.
  CODE_LIMIT: "16",
  SIGNUP_LIMIT: "40",
};

before(async () => {
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "creatio-aura-beta", "--local", "--persist-to", state], {
    cwd,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdio: "ignore",
  });
  const args = ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", state];
  for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}:${value}`);
  server = spawn("npx", args, {
    cwd,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await fetch(`${BASE}/__outbox`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("The service didn't start");
});

after(() => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server?.kill();
  }
  rmSync(state, { recursive: true, force: true });
});

const post = (path, body, origin = SITE) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });

const passFor = async (code = CODE) => {
  const response = await post("/check-code", { code, turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
  return { status: response.status, body: await response.json() };
};

const outbox = async () => (await fetch(`${BASE}/__outbox`)).json();

const person = (pass, extra = {}) => ({
  pass,
  name: "Kodi",
  email: "kodi@example.com",
  platforms: ["Android", "Web", "Toaster"],
  consent: true,
  website: "",
  ...extra,
});

test("only our own site can use it", async () => {
  const response = await post("/check-code", { code: CODE, turnstile: "x" }, "https://evil.example");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("the invite code opens the form; a wrong one, or no human check, doesn't", async () => {
  assert.equal((await post("/check-code", { code: CODE, turnstile: "" })).status, 403);
  const wrong = await passFor("EMBER-RAVEN-LANTERN-THORN-0000");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, "bad-code");
  // Case, spaces and dashes don't matter.
  const right = await passFor("ember raven lantern thorn 4821");
  assert.equal(right.status, 200);
  assert.match(right.body.pass, /^\d+\.[0-9a-f]{64}$/);
});

test("no pass, no sign-up", async () => {
  const response = await post("/signup", person("123.abc"));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "expired-pass");
});

test("bad details are turned away, each with its reason", async () => {
  const { body } = await passFor();
  const cases = [
    [{ name: "" }, "bad-name"],
    [{ name: "x".repeat(61) }, "bad-name"],
    [{ email: "not-an-email" }, "bad-email"],
    [{ platforms: ["Toaster"] }, "pick-platform"],
    [{ consent: false }, "need-consent"],
  ];
  for (const [change, error] of cases) {
    const response = await post("/signup", person(body.pass, change));
    assert.equal(response.status, 400, error);
    assert.equal((await response.json()).error, error);
  }
});

test("bots that fill in the hidden field are quietly ignored", async () => {
  const { body } = await passFor();
  const before = (await outbox()).length;
  const response = await post("/signup", person(body.pass, { email: "bot@example.com", website: "spam" }));
  assert.equal(response.status, 200);
  assert.equal((await outbox()).length, before);
});

test("signing up sends a confirmation email; the link confirms; the other removes them", async () => {
  const { body } = await passFor();
  const response = await post("/signup", person(body.pass));
  assert.equal(response.status, 200);
  const [email] = await outbox();
  assert.equal(email.to_addr, "kodi@example.com");
  assert.match(email.subject, /Confirm your place in the Ignis beta/);
  assert.match(email.body, /Hi Kodi,/);
  const confirmLink = email.body.match(/(http\S+\/confirm\?t=\S+)/)[1];
  const leaveLink = email.body.match(/(http\S+\/leave\?t=\S+)/)[1];

  const confirmed = await fetch(confirmLink, { redirect: "manual" });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get("Location"), `${SITE}/beta/confirmed/`);
  // A used link still says confirmed; a made-up one, expired.
  assert.equal((await fetch(confirmLink, { redirect: "manual" })).headers.get("Location"), `${SITE}/beta/confirmed/`);
  assert.equal(
    (await fetch(`${BASE}/confirm?t=nonsense`, { redirect: "manual" })).headers.get("Location"),
    `${SITE}/beta/link-expired/`,
  );

  // Signing up again once confirmed says the same as always, and sends nothing.
  const again = await post("/signup", person((await passFor()).body.pass));
  assert.equal(again.status, 200);
  assert.equal((await outbox()).filter((e) => e.to_addr === "kodi@example.com").length, 1);

  const left = await fetch(leaveLink, { redirect: "manual" });
  assert.equal(left.headers.get("Location"), `${SITE}/beta/left/`);
  // Gone: signing up again starts over with a new email.
  await post("/signup", person((await passFor()).body.pass));
  assert.equal((await outbox()).filter((e) => e.to_addr === "kodi@example.com").length, 2);
});

test("guessing the code is cut off after a few tries an hour", async () => {
  let last;
  for (let i = 0; i < 20; i++) last = await passFor("WRONG-CODE");
  assert.equal(last.status, 429);
  assert.equal(last.body.error, "too-many");
});
