// Runs the sign-up service locally (Cloudflare's own runtime, through wrangler dev, with a
// throwaway local database) and walks people through it: npm test. Emails are kept in the
// test outbox instead of sent. Turnstile uses Cloudflare's always-passes test key.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { emailProblem } from "../../site/email-check.js";
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
  ADMIN_TOKEN: "test-admin-key",
  OWNER_EMAIL: "studio@example.com",
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
    [{ email: "kodi@example" }, "bad-email"],
    [{ email: "kodi@gmail.con" }, "email-typo"],
    [{ platforms: ["Toaster"] }, "pick-platform"],
    [{ consent: false }, "need-consent"],
    [{ notes: "x".repeat(501) }, "bad-notes"],
  ];
  for (const [change, error] of cases) {
    const response = await post("/signup", person(body.pass, change));
    assert.equal(response.status, 400, error);
    assert.equal((await response.json()).error, error);
  }
});

test("a typo'd email is turned away with the likely right address", async () => {
  const { body } = await passFor();
  const response = await post("/signup", person(body.pass, { email: "kodi@gmail.con" }));
  assert.deepEqual(await response.json(), { ok: false, error: "email-typo", suggestion: "kodi@gmail.com" });
});

test("the email check (shared by the form and the service) catches typos, and passes real addresses", () => {
  const cases = [
    ["kodi@gmail.con", "kodi@gmail.com"],
    ["kodi@gmial.com", "kodi@gmail.com"],
    ["kodi@gmial.con", "kodi@gmail.com"],
    ["Kodi@Hotmial.com", "Kodi@hotmail.com"],
    ["kodi@icloud.co", "kodi@icloud.com"],
    ["kodi@studio.cmo", "kodi@studio.com"],
    ["kodi@school.ogr", "kodi@school.org"],
  ];
  for (const [email, suggestion] of cases) {
    assert.deepEqual(emailProblem(email), { error: "email-typo", suggestion }, email);
  }
  for (const email of ["kodi", "kodi@", "@gmail.com", "kodi@gmail", "kodi@gmail.c", "ko di@gmail.com", "kodi@@gmail.com"]) {
    assert.deepEqual(emailProblem(email), { error: "bad-email" }, email);
  }
  for (const email of ["kodi@gmail.com", "k.o+di@sub.example.co.uk", "kodi@example.co", "kodi@studio.games", "KODI@ICLOUD.COM"]) {
    assert.equal(emailProblem(email), null, email);
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
  assert.match(email.subject, /Confirm your place in the Ignis Aura beta/);
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


const admin = (path, body, key = "test-admin-key") =>
  fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

/** Signs someone up and confirms them through the link in their email. */
async function tester(name, email, platforms) {
  await post("/signup", person((await passFor()).body.pass, { name, email, platforms }));
  const mail = (await outbox()).find((e) => e.to_addr === email);
  await fetch(mail.body.match(/(http\S+\/confirm\?t=\S+)/)[1], { redirect: "manual" });
}

test("confirming tells the studio, with their name, email and platforms", async () => {
  await tester("Mira", "mira@example.com", ["Android", "Web"]);
  const [note] = (await outbox()).filter((e) => e.to_addr === "studio@example.com");
  assert.match(note.subject, /New Ignis Aura beta tester: Mira \(Android, Web\)/);
  assert.match(note.body, /Email: mira@example.com/);
  assert.match(note.body, /Plays on: Android, Web/);
});

test("the admin tools need the admin key", async () => {
  assert.equal((await admin("/admin/testers", undefined, "wrong")).status, 401);
  assert.equal((await fetch(`${BASE}/admin/testers`)).status, 401);
});

test("the tester list has everyone confirmed, with where they play", async () => {
  await tester("Rook", "rook@example.com", ["iPhone"]);
  const { testers } = await (await admin("/admin/testers")).json();
  const byEmail = Object.fromEntries(testers.map((t) => [t.email, t.platforms]));
  assert.deepEqual(byEmail["mira@example.com"], ["Android", "Web"]);
  assert.deepEqual(byEmail["rook@example.com"], ["iPhone"]);
  // Kodi re-signed up earlier but hasn't confirmed: not on the list.
  assert.equal(byEmail["kodi@example.com"], undefined);
});

test("an announcement goes only to people who play there, with only their links", async () => {
  const links = { Android: "https://expo.dev/artifacts/eas/test.apk", Web: "https://creatio-aura.github.io/ignis-aura-web/" };
  const dry = await (await admin("/admin/announce", { title: "Ignis Aura 0.6.0 is ready", message: "The board is in.", links })).json();
  assert.deepEqual(dry.recipients.map((r) => [r.email, r.platforms]), [["mira@example.com", ["Android", "Web"]]]);
  assert.equal(dry.sent, 0);

  const before = (await outbox()).length;
  const sent = await (await admin("/admin/announce", { title: "Ignis Aura 0.6.0 is ready", message: "The board is in.", links, send: true })).json();
  assert.equal(sent.sent, 1);
  const mails = (await outbox()).slice(0, (await outbox()).length - before);
  assert.deepEqual(mails.map((m) => m.to_addr), ["mira@example.com"]);
  assert.match(mails[0].body, /Android: https:\/\/expo.dev\/artifacts\/eas\/test.apk/);
  assert.match(mails[0].body, /Web: https:\/\/creatio-aura.github.io\/ignis-aura-web\//);
  // Every download email carries the Beta Tester Terms: at your own risk, and confidential.
  assert.match(mails[0].body, /you agree to the Beta Tester Terms/);
  assert.match(mails[0].body, /at your own risk/);
  assert.match(mails[0].body, /confidential/);
  assert.match(mails[0].body, new RegExp(`${SITE}/beta/terms/`));

  // Its remove-me link works.
  const leave = mails[0].body.match(/(http\S+\/leave\?t=\d+\.[0-9a-f]+)/)[1];
  assert.equal((await fetch(leave, { redirect: "manual" })).headers.get("Location"), `${SITE}/beta/left/`);
  const { testers } = await (await admin("/admin/testers")).json();
  assert.equal(testers.find((t) => t.email === "mira@example.com"), undefined);
});

test("notes written at sign-up reach the studio's email, the testers list and the report", async () => {
  const { body } = await passFor();
  const notes = "I'd play on iPhone when it's out.\nHappy to test the web version now.";
  assert.equal((await post("/signup", person(body.pass, { email: "noor@example.com", name: "Noor", platforms: ["Web"], notes }))).status, 200);
  const confirmLink = (await outbox())[0].body.match(/(http\S+\/confirm\?t=\S+)/)[1];
  await fetch(confirmLink, { redirect: "manual" });
  const [studio] = await outbox();
  assert.match(studio.subject, /New Ignis Aura beta tester: Noor/);
  assert.match(studio.body, /Notes: I'd play on iPhone when it's out\./);
  const { testers } = await (await admin("/admin/testers")).json();
  assert.equal(testers.find((t) => t.email === "noor@example.com").notes, notes);
  const report = await (await admin("/admin/report", {})).json();
  assert.match(report.preview, /Notes: I'd play on iPhone when it's out\. \/ Happy to test/);
});

test("the daily report lists everyone confirmed, marks the day's new testers, and emails the studio", async () => {
  const shown = await (await admin("/admin/report", {})).json();
  assert.equal(shown.sent, false);
  assert.match(shown.preview, /New (in the last day|since the last report \(.+\)): \d+/);
  assert.match(shown.preview, /Confirmed testers: \d+ \(iPhone \d+ · Android \d+ · Web \d+\)/);
  assert.match(shown.preview, /Signed up, waiting to confirm: \d+/);

  const sent = await (await admin("/admin/report", { send: true })).json();
  assert.equal(sent.sent, true);
  const [latest] = await outbox();
  assert.equal(latest.to_addr, "studio@example.com");
  assert.match(latest.subject, /^Ignis Aura beta: \d+ new, \d+ in all$/);

  // The next report counts only who's new since that one: nobody, here.
  const after = await (await admin("/admin/report", {})).json();
  assert.match(after.preview, /New since the last report \(.+\): 0/);
});

test("announcements need a title, a message and real https links", async () => {
  const bad = async (body) => (await admin("/admin/announce", body)).status;
  assert.equal(await bad({ message: "x", links: { Web: "https://a.b/" } }), 400);
  assert.equal(await bad({ title: "x", links: { Web: "https://a.b/" } }), 400);
  assert.equal(await bad({ title: "x", message: "y", links: { Web: "http://a.b/" } }), 400);
});

test("the announce and testers tools work from the command line", () => {
  const env = { ...process.env, SERVICE_URL: BASE, ADMIN_TOKEN: "test-admin-key" };
  const testers = spawnSync("node", ["tools/testers.mjs"], { cwd, env, encoding: "utf8" });
  assert.match(testers.stdout, /Rook/);
  const dry = spawnSync("node", ["tools/announce.mjs", "--title", "Hi", "--message", "Test", "--iphone", "https://testflight.apple.com/join/x"], { cwd, env, encoding: "utf8" });
  assert.match(dry.stdout, /Would send to 1:/);
  assert.match(dry.stdout, /Nothing was sent/);
});

// Last: it uses up this machine's code-check allowance.
test("guessing the code is cut off after a few tries an hour", async () => {
  let last;
  for (let i = 0; i < 20; i++) last = await passFor("WRONG-CODE");
  assert.equal(last.status, 429);
  assert.equal(last.body.error, "too-many");
});

// Guest creators: Andrew (here with the admin key) makes a code; the guest submits, he reviews.
const asAdmin = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE, Authorization: "Bearer test-admin-key" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
const asGuest = (path, body) =>
  post(path, body).then(async (response) => ({ status: response.status, body: await response.json() }));

test("guest creators: a code, a submission, changes asked, resubmitted, approved", async () => {
  assert.equal((await asGuest("/guests/admin/list", {})).status, 401);
  assert.equal((await asGuest("/guests/admin/list", { github: "not-a-real-token-at-all" })).status, 401);
  assert.equal((await asGuest("/guests/login", { code: "ASH-OAK-0000" })).status, 401);

  const made = await asAdmin("/guests/admin/guest", { name: "Wren" });
  assert.match(made.body.code, /^[A-Z]+-[A-Z]+-\d{4}$/);
  const code = made.body.code;
  assert.equal((await asGuest("/guests/login", { code: code.toLowerCase() })).body.name, "Wren");

  const encounter = { id: "civilization.tavern.a-quiet-corner", title: "A Quiet Corner" };
  const where = { tile: "civilization", location: "tavern" };
  const sent = await asGuest("/guests/submit", { code, encounter, where });
  assert.equal(sent.status, 200);
  const id = sent.body.id;

  await asAdmin("/guests/admin/review", { id, status: "changes", note: "More smoke" });
  const mine = (await asGuest("/guests/mine", { code })).body.submissions;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "changes");
  assert.equal(mine[0].note, "More smoke");
  assert.deepEqual(mine[0].where, where);

  // Sent again, it's the same submission, waiting again.
  const again = await asGuest("/guests/submit", { code, id, encounter: { ...encounter, title: "A Smoky Corner" }, where });
  assert.equal(again.body.id, id);
  const listed = (await asAdmin("/guests/admin/list", {})).body;
  assert.equal(listed.submissions.length, 1);
  assert.equal(listed.submissions[0].status, "submitted");
  assert.equal(listed.submissions[0].title, "A Smoky Corner");
  assert.equal(listed.submissions[0].guest, "Wren");

  await asAdmin("/guests/admin/review", { id, status: "approved" });
  // Approved, it's done: sending it again makes a new one.
  const after = await asGuest("/guests/submit", { code, id, encounter, where });
  assert.notEqual(after.body.id, id);

  // Switched off, the code stops working.
  await asAdmin("/guests/admin/guest-active", { code, active: false });
  assert.equal((await asGuest("/guests/login", { code })).status, 401);
  assert.equal((await asGuest("/guests/submit", { code, encounter, where })).status, 401);
});
