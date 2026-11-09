// Runs the sign-up service locally (Cloudflare's own runtime, through wrangler dev, with a
// throwaway local database) and walks people through it: npm test. Emails are kept in the
// test outbox instead of sent. Turnstile uses Cloudflare's always-passes test key (any token but
// an empty one passes).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { emailProblem } from "../../site/email-check.js";
import assert from "node:assert/strict";

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "https://creatio-aura.com";
const cwd = new URL("..", import.meta.url);
const state = mkdtempSync(join(tmpdir(), "beta-test-"));
let server;

const vars = {
  MAIL_MODE: "test",
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
  PASS_SECRET: "test-pass-secret",
  IP_SALT: "test-salt",
  SMTP_PASSWORD: "unused",
  SERVICE_URL: BASE,
  ADMIN_TOKEN: "test-admin-key",
  INTERNAL_TOKEN: "test-internal-key",
  PLAY_ALLOW: "friend@example.com",
  OWNER_EMAIL: "studio@example.com",
  FEEDBACK_EMAIL: "feedback@example.com",
  // Every test comes from one machine: room for them all, while still testing the limit.
  SIGNUP_LIMIT: "40",
  FEEDBACK_LIMIT: "30",
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

const outbox = async () => (await fetch(`${BASE}/__outbox`)).json();
const HUMAN = "XXXX.DUMMY.TOKEN.XXXX";

/** A sign-up as the form sends it: Ignis Aura's beta unless it says otherwise. */
const person = (extra = {}) => ({
  email: "kodi@example.com",
  platforms: ["Android", "Web", "Toaster"],
  consent: true,
  turnstile: HUMAN,
  website: "",
  ...extra,
});

const admin = (path, body, key = "test-admin-key") =>
  fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

/** The link in the studio's "wants in" email for this address. */
async function approveLinkFor(email) {
  const note = (await outbox()).find((e) => e.to_addr === "studio@example.com" && e.subject.includes(`: ${email} wants in`));
  return note.body.match(/(http\S+\/approve\?t=\S+)/)[1];
}

/** Presses a button on the page that link opens: "approve" lets them in, "decline" turns them away. */
const press = (approveLink, button = "approve") =>
  fetch(approveLink.replace("/approve?", `/${button}?`), { method: "POST" });

/** Signs someone up, confirms them through the link in their email, and lets them in. */
async function tester(email, platforms, project) {
  await post("/signup", person({ email, platforms, ...(project ? { project } : {}) }));
  const mail = (await outbox()).find((e) => e.to_addr === email);
  await fetch(mail.body.match(/(http\S+\/confirm\?t=\S+)/)[1], { redirect: "manual" });
  await press(await approveLinkFor(email));
}

test("only our own site can use it", async () => {
  const response = await post("/signup", person(), "https://evil.example");
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  // The invite code's step is gone.
  assert.equal((await post("/check-code", { code: "ANY", turnstile: HUMAN })).status, 404);
});

test("no human check, no sign-up", async () => {
  const response = await post("/signup", person({ turnstile: "" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "human-check");
});

test("bad details are turned away, each with its reason", async () => {
  const cases = [
    [{ email: "not-an-email" }, "bad-email"],
    [{ email: "kodi@example" }, "bad-email"],
    [{ email: "kodi@gmail.con" }, "email-typo"],
    [{ platforms: ["Toaster"] }, "pick-platform"],
    // Effugium Aura has no web version.
    [{ project: "effugium", platforms: ["Web"] }, "pick-platform"],
    [{ project: "nope" }, "bad-project"],
    [{ consent: false }, "need-consent"],
  ];
  for (const [change, error] of cases) {
    const response = await post("/signup", person(change));
    assert.equal(response.status, 400, error);
    assert.equal((await response.json()).error, error);
  }
});

test("a typo'd email is turned away with the likely right address", async () => {
  const response = await post("/signup", person({ email: "kodi@gmail.con" }));
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
  const before = (await outbox()).length;
  const response = await post("/signup", person({ email: "bot@example.com", website: "spam" }));
  assert.equal(response.status, 200);
  assert.equal((await outbox()).length, before);
});

test("signing up: a confirmation email; confirming asks Andrew; he lets them in and they're told; leaving removes them", async () => {
  const response = await post("/signup", person());
  assert.equal(response.status, 200);
  const [email] = await outbox();
  assert.equal(email.to_addr, "kodi@example.com");
  assert.match(email.subject, /Confirm your place in the Ignis Aura beta/);
  assert.match(email.body, /^Hi,/);
  const confirmLink = email.body.match(/(http\S+\/confirm\?t=\S+)/)[1];

  const confirmed = await fetch(confirmLink, { redirect: "manual" });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get("Location"), `${SITE}/beta/confirmed/`);
  // Nothing to them yet; the studio is asked, with the link to decide.
  assert.equal((await outbox()).filter((e) => e.to_addr === "kodi@example.com").length, 1);
  const [note] = (await outbox()).filter((e) => e.to_addr === "studio@example.com");
  assert.equal(note.subject, "Ignis Aura beta: kodi@example.com wants in (Android, Web)");
  assert.match(note.body, /Plays on: Android, Web/);
  assert.match(note.body, /add their Google account to the Play test's testers/);
  const approveLink = await approveLinkFor("kodi@example.com");
  // A used link still says confirmed; a made-up one, expired.
  assert.equal((await fetch(confirmLink, { redirect: "manual" })).headers.get("Location"), `${SITE}/beta/confirmed/`);
  assert.equal(
    (await fetch(`${BASE}/confirm?t=nonsense`, { redirect: "manual" })).headers.get("Location"),
    `${SITE}/beta/link-expired/`,
  );

  // Opening the link only shows a page (a mail app checking links lets nobody in).
  const page = await fetch(approveLink);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /kodi@example\.com<\/b> wants to join the Ignis Aura beta, on Android, Web/);
  assert.match(html, /Let them in/);
  assert.equal((await (await admin("/admin/testers")).json()).testers.find((t) => t.email === "kodi@example.com"), undefined);
  assert.equal((await (await admin("/admin/testers")).json()).waiting.find((t) => t.email === "kodi@example.com").project, "ignis");
  // A made-up link: nothing.
  assert.equal((await fetch(`${BASE}/approve?t=1.abc`)).status, 404);

  // Let in: they're told, with the way off it (no build links have gone out yet).
  const letIn = await press(approveLink);
  const done = await letIn.text();
  assert.match(done, /is in the Ignis Aura beta/);
  // Android: a reminder to add them to the Play test's email list, with their address to copy.
  assert.match(done, /Now add them on Google Play:<\/b> in Play Console, Ignis Aura › Testing › Internal testing › Testers/);
  assert.match(done, /user-select: all[^>]*>kodi@example\.com</);
  const welcome = (await outbox()).find((e) => e.to_addr === "kodi@example.com");
  assert.equal(welcome.subject, "You're in the Ignis Aura beta");
  assert.match(welcome.body, /We'll email you when there's a build for you to play\./);
  const leaveLink = welcome.body.match(/(http\S+\/leave\?t=\S+)/)[1];
  assert.match(await (await fetch(approveLink)).text(), /already in the Ignis Aura beta/);

  // Signing up again once in says the same as always, and sends nothing.
  assert.equal((await post("/signup", person())).status, 200);
  assert.equal((await outbox()).filter((e) => e.to_addr === "kodi@example.com").length, 2);

  const left = await fetch(leaveLink, { redirect: "manual" });
  assert.equal(left.headers.get("Location"), `${SITE}/beta/left/`);
  // Gone: signing up again starts over with a new email.
  await post("/signup", person());
  assert.equal((await outbox()).filter((e) => e.to_addr === "kodi@example.com").length, 3);
});

test("turning someone away removes them, and they hear nothing", async () => {
  await post("/signup", person({ email: "spammy@example.com", platforms: ["Web"] }));
  const mail = (await outbox()).find((e) => e.to_addr === "spammy@example.com");
  await fetch(mail.body.match(/(http\S+\/confirm\?t=\S+)/)[1], { redirect: "manual" });
  const link = await approveLinkFor("spammy@example.com");
  assert.match(await (await press(link, "decline")).text(), /has been removed/);
  assert.equal((await fetch(link)).status, 404);
  assert.equal((await outbox()).filter((e) => e.to_addr === "spammy@example.com").length, 1);
  assert.equal((await (await admin("/admin/testers")).json()).waiting.find((t) => t.email === "spammy@example.com"), undefined);
});

test("the admin tools need the admin key", async () => {
  assert.equal((await admin("/admin/testers", undefined, "wrong")).status, 401);
  assert.equal((await fetch(`${BASE}/admin/testers`)).status, 401);
});

test("the tester list has everyone let in, with where they play, and who's waiting", async () => {
  await tester("mira@example.com", ["Android", "Web"]);
  await tester("rook@example.com", ["iPhone"]);
  const { testers, waiting } = await (await admin("/admin/testers")).json();
  const byEmail = Object.fromEntries(testers.map((t) => [t.email, t.platforms]));
  assert.deepEqual(byEmail["mira@example.com"], ["Android", "Web"]);
  assert.deepEqual(byEmail["rook@example.com"], ["iPhone"]);
  // Kodi signed up again but hasn't confirmed: neither in nor waiting.
  assert.equal(byEmail["kodi@example.com"], undefined);
  assert.equal(waiting.find((t) => t.email === "kodi@example.com"), undefined);
});

test("a sign-up keeps where it came from: a short code only, and the first one sticks", async () => {
  // Signed up from a Journal post's button, then again from Google before confirming: the post counts.
  await post("/signup", person({ email: "sol@example.com", source: "web_jb_effugium_aura_is_in_testing" }));
  await post("/signup", person({ email: "sol@example.com", source: "ref_google" }));
  // Anything that isn't a short code is dropped, never stored.
  await post("/signup", person({ email: "ivy@example.com", source: "https://evil.example/?q=<x>" }));
  for (const email of ["sol@example.com", "ivy@example.com"]) {
    const mail = (await outbox()).find((e) => e.to_addr === email);
    await fetch(mail.body.match(/(http\S+\/confirm\?t=\S+)/)[1], { redirect: "manual" });
  }
  const { waiting } = await (await admin("/admin/testers")).json();
  assert.equal(waiting.find((t) => t.email === "sol@example.com").source, "web_jb_effugium_aura_is_in_testing");
  assert.equal(waiting.find((t) => t.email === "ivy@example.com").source, "");
  // Turn them both away again, so the tests after this one see the list as it was.
  for (const email of ["sol@example.com", "ivy@example.com"]) await press(await approveLinkFor(email), "decline");
});

test("an announcement goes only to testers let in who play there, with only their links, and later testers get those links", async () => {
  const links = { Android: "https://play.google.com/apps/internaltest/1234", Web: "https://creatio-aura.com/ignis-aura-web/" };
  const dry = await (await admin("/admin/announce", { title: "Ignis Aura 0.6.0 is ready", message: "The board is in.", links })).json();
  assert.deepEqual(dry.recipients.map((r) => [r.email, r.platforms]), [["mira@example.com", ["Android", "Web"]]]);
  assert.equal(dry.sent, 0);

  const before = (await outbox()).length;
  const sent = await (await admin("/admin/announce", { title: "Ignis Aura 0.6.0 is ready", message: "The board is in.", links, send: true })).json();
  assert.equal(sent.sent, 1);
  const mails = (await outbox()).slice(0, (await outbox()).length - before);
  assert.deepEqual(mails.map((m) => m.to_addr), ["mira@example.com"]);
  assert.match(mails[0].body, /Android: https:\/\/play\.google\.com\/apps\/internaltest\/1234\n  Open the link in Chrome on your Android phone \(other browsers can stop partway through\), signed in to the Google account you signed up with/);
  assert.match(mails[0].body, /Web: https:\/\/creatio-aura.com\/ignis-aura-web\//);
  // Every download email carries the Beta Tester Terms: at your own risk, and confidential.
  assert.match(mails[0].body, /you agree to the Beta Tester Terms/);
  assert.match(mails[0].body, /at your own risk/);
  assert.match(mails[0].body, /confidential/);
  assert.match(mails[0].body, new RegExp(`${SITE}/beta/terms/`));

  // Someone let in afterwards gets those links in their welcome, with the terms.
  await tester("late@example.com", ["Web"]);
  const welcome = (await outbox()).find((e) => e.to_addr === "late@example.com" && e.subject.startsWith("You're in"));
  assert.match(welcome.body, /Here's how to play:\n\nWeb: https:\/\/creatio-aura.com\/ignis-aura-web\//);
  assert.doesNotMatch(welcome.body, /Android:/);
  assert.match(welcome.body, /you agree to the Beta Tester Terms/);

  // Its remove-me link works.
  const leave = mails[0].body.match(/(http\S+\/leave\?t=\d+\.[0-9a-f]+)/)[1];
  assert.equal((await fetch(leave, { redirect: "manual" })).headers.get("Location"), `${SITE}/beta/left/`);
  const { testers } = await (await admin("/admin/testers")).json();
  assert.equal(testers.find((t) => t.email === "mira@example.com"), undefined);
});

test("links stored without emailing anyone reach later welcomes, and one tester's welcome can be sent again", async () => {
  const play = "https://play.google.com/apps/internaltest/5678";
  const web = "https://creatio-aura.com/ignis-aura-web/";
  const before = (await outbox()).length;
  const stored = await (await admin("/admin/builds", { project: "ignis", links: { Android: play, Web: web, Nonsense: "https://x" } })).json();
  assert.deepEqual(stored.builds, { Android: play, Web: web });
  assert.equal((await outbox()).length, before); // nobody was emailed
  // With no links it only shows what's stored; a bad link is ignored.
  assert.deepEqual((await (await admin("/admin/builds", { project: "ignis", links: { Android: "http://insecure" } })).json()).builds, { Android: play, Web: web });

  // Someone let in now gets both, with the Chrome note for Google Play.
  await tester("again@example.com", ["Android", "Web"]);
  const welcome = (await outbox()).find((e) => e.to_addr === "again@example.com" && e.subject.startsWith("You're in"));
  assert.match(welcome.body, /Android: https:\/\/play\.google\.com\/apps\/internaltest\/5678\n  Open the link in Chrome/);
  assert.match(welcome.body, /If Google Play says you can't join yet, try again a little later: we add each tester by hand\./);
  assert.match(welcome.body, /Web: https:\/\/creatio-aura.com\/ignis-aura-web\//);

  // Sending it again: a dry run first, then one more welcome, to them only.
  const dry = await (await admin("/admin/welcome", { project: "ignis", email: "Again@Example.com" })).json();
  assert.deepEqual([dry.sent, dry.platforms, dry.links], [false, ["Android", "Web"], ["Android", "Web"]]);
  const count = () => outbox().then((all) => all.filter((e) => e.to_addr === "again@example.com" && e.subject.startsWith("You're in")).length);
  assert.equal(await count(), 1);
  const sent = await (await admin("/admin/welcome", { project: "ignis", email: "again@example.com", send: true })).json();
  assert.equal(sent.sent, true);
  assert.equal(await count(), 2);
  // Only testers let in to that beta.
  assert.equal((await admin("/admin/welcome", { project: "ignis", email: "nobody@example.com" })).status, 404);
  assert.equal((await admin("/admin/welcome", { project: "effugium", email: "again@example.com" })).status, 404);

  // Tidy up: they leave, so later tests' counts are unchanged.
  const leave = welcome.body.match(/(http\S+\/leave\?t=\d+\.[0-9a-f]+)/)[1];
  await fetch(leave, { redirect: "manual" });
});

test("Effugium Aura's beta: the same sign-up, its own list, links and emails, no Beta Tester Terms, and no web game", async () => {
  // One address can be in both betas.
  await tester("rook@example.com", ["iPhone", "Android"], "effugium");
  const note = (await outbox()).find((e) => e.subject === "Effugium Aura beta: rook@example.com wants in (iPhone, Android)");
  assert.ok(note);
  const welcome = (await outbox()).find((e) => e.to_addr === "rook@example.com" && e.subject === "You're in the Effugium Aura beta");
  assert.match(welcome.body, /You're in: you're an Effugium Aura beta tester now\./);
  const { testers } = await (await admin("/admin/testers")).json();
  assert.deepEqual(
    testers.filter((t) => t.email === "rook@example.com").map((t) => [t.project, t.platforms]),
    [["ignis", ["iPhone"]], ["effugium", ["iPhone", "Android"]]],
  );

  const links = { iPhone: "https://testflight.apple.com/join/EFFUG", Web: "https://example.com/not-for-effugium" };
  const sent = await (await admin("/admin/announce", { project: "effugium", title: "Effugium Aura 0.2 is ready", message: "Try it.", links, send: true })).json();
  assert.deepEqual(sent.recipients.map((r) => [r.email, r.platforms]), [["rook@example.com", ["iPhone"]]]);
  const [mail] = (await outbox()).filter((e) => e.subject === "Effugium Aura 0.2 is ready");
  assert.match(mail.body, /iPhone: https:\/\/testflight\.apple\.com\/join\/EFFUG/);
  assert.doesNotMatch(mail.body, /Beta Tester Terms|confidential|not-for-effugium/);
  assert.match(mail.body, /Thanks for testing Effugium Aura\./);

  // Someone only in Effugium Aura's beta can't open Ignis Aura's web game.
  await tester("calm@example.com", ["Android"], "effugium");
  const internal = (body) =>
    fetch(`${BASE}/internal/play-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-internal-key" },
      body: JSON.stringify(body),
    });
  await internal({ email: "calm@example.com", link: "https://play.example.com/ignis-aura-web/__login/link?t=abc" });
  assert.equal((await outbox()).filter((e) => e.to_addr === "calm@example.com" && /sign-in|link to the Ignis/i.test(e.subject)).length, 0);
});

test("the daily report: who's waiting for Andrew (with the links), and for each beta who's in and who's new; it emails the studio", async () => {
  // Someone confirmed, not yet let in.
  await post("/signup", person({ email: "noor@example.com", platforms: ["iPhone"], project: "effugium" }));
  const mail = (await outbox()).find((e) => e.to_addr === "noor@example.com");
  await fetch(mail.body.match(/(http\S+\/confirm\?t=\S+)/)[1], { redirect: "manual" });

  const shown = await (await admin("/admin/report", {})).json();
  assert.equal(shown.sent, false);
  assert.match(shown.preview, /Waiting for your OK: 1\n  \? Effugium Aura: noor@example\.com, iPhone \(confirmed \d{4}-\d\d-\d\d\)\. Let in or turn away: http\S+\/approve\?t=\S+/);
  assert.match(shown.preview, /Ignis Aura beta\n  Let in (in the last day|since the last report \(.+\)): \d+/);
  assert.match(shown.preview, /  Testers: \d+ \(iPhone \d+ · Android \d+ · Web \d+\)/);
  assert.match(shown.preview, /Effugium Aura beta\n  Let in .+: \d+/);
  assert.match(shown.preview, /  Testers: \d+ \(iPhone \d+ · Android \d+\)/);
  assert.match(shown.preview, /Signed up, waiting to confirm: \d+/);

  const sent = await (await admin("/admin/report", { send: true })).json();
  assert.equal(sent.sent, true);
  const [latest] = await outbox();
  assert.equal(latest.to_addr, "studio@example.com");
  assert.match(latest.subject, /^Creatio Aura betas: \d+ new, 1 waiting for your OK$/);

  // The next report counts only who's let in since that one: nobody, here.
  const after = await (await admin("/admin/report", {})).json();
  assert.match(after.preview, /Ignis Aura beta\n  Let in since the last report \(.+\): 0/);
});

test("announcements need a title, a message, real https links and a beta there is", async () => {
  const bad = async (body) => (await admin("/admin/announce", body)).status;
  assert.equal(await bad({ message: "x", links: { Web: "https://a.b/" } }), 400);
  assert.equal(await bad({ title: "x", links: { Web: "https://a.b/" } }), 400);
  assert.equal(await bad({ title: "x", message: "y", links: { Web: "http://a.b/" } }), 400);
  assert.equal(await bad({ project: "nope", title: "x", message: "y", links: { Web: "https://a.b/" } }), 400);
});

test("the announce and testers tools work from the command line", () => {
  const env = { ...process.env, SERVICE_URL: BASE, ADMIN_TOKEN: "test-admin-key" };
  const testers = spawnSync("node", ["tools/testers.mjs"], { cwd, env, encoding: "utf8" });
  assert.match(testers.stdout, /Ignis Aura beta: \d+ in/);
  assert.match(testers.stdout, /rook@example\.com/);
  assert.match(testers.stdout, /Effugium Aura beta: \d+ in/);
  assert.match(testers.stdout, /Waiting for your OK: 1/);
  assert.match(testers.stdout, /noor@example\.com/);
  const dry = spawnSync("node", ["tools/announce.mjs", "--title", "Hi", "--message", "Test", "--iphone", "https://testflight.apple.com/join/x"], { cwd, env, encoding: "utf8" });
  assert.match(dry.stdout, /Would send to 1:/);
  assert.match(dry.stdout, /Nothing was sent/);
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

test("the web build's sign-in: a link only for those who may play, and only with the shared key", async () => {
  const internal = (path, body, key = "test-internal-key") =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  const link = "https://play.example.com/ignis-aura-web/__login/link?t=abc";
  const mailsTo = async (to) =>
    (await outbox()).filter((mail) => mail.to_addr === to);

  // Without the key: nothing.
  assert.equal((await internal("/internal/play-link", { email: "friend@example.com", link }, "wrong")).status, 401);
  // Someone on the allow list gets their link; a stranger gets the same answer, and no email.
  assert.deepEqual(await (await internal("/internal/play-link", { email: "Friend@Example.com", link })).json(), { ok: true });
  assert.deepEqual(await (await internal("/internal/play-link", { email: "stranger@example.com", link })).json(), { ok: true });
  const friend = await mailsTo("friend@example.com");
  assert.equal(friend.length, 1);
  assert.match(friend[0].body, /play\.example\.com/);
  assert.equal((await mailsTo("stranger@example.com")).length, 0);
  // Confirmed but not yet let in: no link either; once let in, yes.
  await post("/signup", person({ email: "soon@example.com", platforms: ["Web"] }));
  const confirmMail = (await mailsTo("soon@example.com"))[0];
  await fetch(confirmMail.body.match(/(http\S+\/confirm\?t=\S+)/)[1], { redirect: "manual" });
  await internal("/internal/play-link", { email: "soon@example.com", link });
  assert.equal((await mailsTo("soon@example.com")).filter((m) => m.body.includes("play.example.com")).length, 0);
  await press(await approveLinkFor("soon@example.com"));
  await internal("/internal/play-link", { email: "soon@example.com", link });
  assert.equal((await mailsTo("soon@example.com")).filter((m) => m.body.includes("play.example.com")).length, 1);
  // A guest creator's code that isn't one: no.
  assert.equal((await (await internal("/internal/guest-check", { code: "NOT-A-CODE" })).json()).ok, false);
});

const joinList = (extra = {}) =>
  post("/waitlist", {
    project: "effugium",
    email: "wren@example.com",
    consent: true,
    turnstile: "XXXX.DUMMY.TOKEN.XXXX",
    website: "",
    ...extra,
  });

test("a waiting list: a confirmation email, the link confirms and says so by email, leaving removes them", async () => {
  assert.equal((await joinList()).status, 200);
  const [first] = (await outbox()).filter((e) => e.to_addr === "wren@example.com");
  assert.match(first.subject, /Confirm: tell me when Effugium Aura is out/);
  const confirmLink = first.body.match(/(http\S+\/waitlist\/confirm\?t=\S+)/)[1];

  const confirmed = await fetch(confirmLink, { redirect: "manual" });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.get("Location"), `${SITE}/waitlist/confirmed/?p=effugium`);
  const welcome = (await outbox()).find((e) => e.to_addr === "wren@example.com");
  assert.match(welcome.subject, /You're on the Effugium Aura list/);
  const leaveLink = welcome.body.match(/(http\S+\/waitlist\/leave\?t=\S+)/)[1];
  // Confirming again, or joining again, sends nothing more.
  await fetch(confirmLink, { redirect: "manual" });
  assert.equal((await joinList()).status, 200);
  assert.equal((await outbox()).filter((e) => e.to_addr === "wren@example.com").length, 2);

  const { lists } = await (await admin("/admin/waitlist")).json();
  assert.deepEqual(lists.find((l) => l.project === "effugium").people.map((p) => p.email), ["wren@example.com"]);
  assert.equal(lists.find((l) => l.project === "secessio").people.length, 0);
  const report = await (await admin("/admin/report", {})).json();
  assert.match(report.preview, /Effugium Aura: 1 \(1 new\)/);

  const left = await fetch(leaveLink, { redirect: "manual" });
  assert.equal(left.headers.get("Location"), `${SITE}/waitlist/left/`);
  const after = await (await admin("/admin/waitlist")).json();
  assert.equal(after.lists.find((l) => l.project === "effugium").people.length, 0);
  // A beta remove-me link can't be forged from a waiting list's, or the other way round.
  const [id, signature] = new URL(leaveLink).searchParams.get("t").split(".");
  const crossed = await fetch(`${BASE}/leave?t=${id}.${signature}`, { redirect: "manual" });
  assert.equal(crossed.headers.get("Location"), `${SITE}/beta/left/`);
});

test("a waiting list checks the project, the email, the consent, and catches bots", async () => {
  assert.deepEqual(await (await joinList({ project: "toaster" })).json(), { ok: false, error: "bad-project" });
  assert.deepEqual(await (await joinList({ project: "__proto__" })).json(), { ok: false, error: "bad-project" });
  assert.equal((await (await joinList({ email: "wren@gmail.con" })).json()).error, "email-typo");
  assert.deepEqual(await (await joinList({ consent: false })).json(), { ok: false, error: "need-consent" });
  const before = (await outbox()).length;
  assert.equal((await joinList({ email: "bot@example.com", website: "spam" })).status, 200);
  assert.equal((await outbox()).length, before);
  // Only from our own site.
  assert.equal((await post("/waitlist", { project: "effugium" }, "https://evil.example")).status, 403);
});

test("one email can wait for several projects", async () => {
  for (const project of ["secessio", "familia-arbor"]) {
    assert.equal((await joinList({ project, email: "ash@example.com" })).status, 200);
  }
  const subjects = (await outbox()).filter((e) => e.to_addr === "ash@example.com").map((e) => e.subject);
  assert.ok(subjects.some((s) => /Secessio Aura/.test(s)));
  assert.ok(subjects.some((s) => /Familia Arbor Aura/.test(s)));
});

// Feedback from the app. Its email goes after the answer, so the tests wait for it to land.
const sendNote = (body, origin = null) =>
  fetch(`${BASE}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
async function landed(find) {
  for (let i = 0; i < 50; i++) {
    const mail = (await outbox()).find(find);
    if (mail) return mail;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("No such email arrived");
}
const note = {
  id: "note-0001-abcdef",
  message: "The menu button vanished on my turn.\nIt came back after a reload.",
  version: "0.13.5",
  build: "1730000000",
  platform: "Android",
  device: "Pixel 8, Android 15",
  screen: "Encounter",
  game: "Pass and play · 3 heroes · round 4",
};

test("feedback from the app reaches the studio's inbox, with what the app sent, once", async () => {
  // An app on a phone sends no Origin.
  const response = await sendNote(note);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const mail = await landed((m) => m.subject === "Ignis Aura FEEDBACK: The menu button vanished on my turn.");
  assert.equal(mail.to_addr, "feedback@example.com");
  assert.equal(mail.reply_to, null);
  assert.match(mail.body, /The menu button vanished on my turn\.\nIt came back after a reload\./);
  assert.match(mail.body, /From: No address left/);
  assert.match(mail.body, /App version: 0\.13\.5\nBuild: 1730000000\nPlays on: Android\nDevice: Pixel 8, Android 15/);
  assert.match(mail.body, /Screen: Encounter\nGame: Pass and play · 3 heroes · round 4/);

  // Sent again (the app never heard back): kept once, emailed once.
  assert.equal((await sendNote(note)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await outbox()).filter((m) => m.subject === mail.subject).length, 1);
  const { notes } = await (await admin("/admin/feedback")).json();
  assert.equal(notes.filter((n) => n.message.startsWith("The menu button")).length, 1);
  assert.equal(notes[0].emailed, true);
  assert.equal(notes[0].details.device, "Pixel 8, Android 15");
});

test("a note with an address can be answered: replying goes to them, and it says if they're a tester", async () => {
  assert.equal((await sendNote({ message: "Loving the dice!", email: "Rook@Example.com " })).status, 200);
  const fromTester = await landed((m) => m.subject === "Ignis Aura FEEDBACK: Loving the dice!");
  assert.equal(fromTester.reply_to, "rook@example.com");
  assert.match(fromTester.body, /From: rook@example\.com \(on the beta list\)\. Reply to this email/);

  assert.equal((await sendNote({ message: "Found it from a friend.", email: "ash@example.com" })).status, 200);
  const fromStranger = await landed((m) => m.subject === "Ignis Aura FEEDBACK: Found it from a friend.");
  assert.equal(fromStranger.reply_to, "ash@example.com");
  assert.match(fromStranger.body, /ash@example\.com \(not on the beta list\)/);

  // A long first line is cut short in the subject.
  assert.equal((await sendNote({ message: "x".repeat(80) })).status, 200);
  const long = await landed((m) => m.subject.startsWith("Ignis Aura FEEDBACK: xxx"));
  assert.equal(long.subject, `Ignis Aura FEEDBACK: ${"x".repeat(57)}…`);
});

test("feedback from Effugium Aura: its name and FEEDBACK in the subject, a shorter limit, no links", async () => {
  const fromEffugium = {
    app: "effugium",
    id: "note-effugium-0001",
    message: "The sleep timer stopped early tonight.",
    version: "0.2.0",
    build: "1793900000",
    commit: "db04d40",
    platform: "iOS 27.1",
    device: "iPhone18,2",
  };
  assert.equal((await sendNote(fromEffugium)).status, 200);
  const mail = await landed((m) => m.subject === "Effugium Aura FEEDBACK: The sleep timer stopped early tonight.");
  assert.equal(mail.to_addr, "feedback@example.com");
  assert.match(mail.body, /^Feedback from the Effugium Aura app\./);
  assert.match(mail.body, /App version: 0\.2\.0\nBuild: 1793900000\nCommit: db04d40\nPlays on: iOS 27\.1\nDevice: iPhone18,2/);

  const error = async (body) => {
    const response = await sendNote({ app: "effugium", ...body });
    return [response.status, (await response.json()).error];
  };
  assert.deepEqual(await error({ message: "x".repeat(1001) }), [400, "bad-message"]);
  for (const message of ["See https://example.com", "look at www.example.org", "my site example.com has it"]) {
    assert.deepEqual(await error({ message }), [400, "no-links"]);
  }
  // Ignis Aura's notes may still be long and hold links.
  assert.equal((await sendNote({ message: `${"y".repeat(1500)} https://example.com` })).status, 200);
});

test("feedback needs a message and a real address, and comes only from the app or our own sites", async () => {
  const error = async (body, origin) => {
    const response = await sendNote(body, origin);
    return [response.status, (await response.json()).error];
  };
  assert.deepEqual(await error({ message: "   " }), [400, "bad-message"]);
  assert.deepEqual(await error({ message: "x".repeat(4001) }), [400, "bad-message"]);
  assert.deepEqual(await error({ message: "Hi", email: "kodi@example" }), [400, "bad-email"]);
  const typo = await sendNote({ message: "Hi", email: "kodi@gmail.con" });
  assert.deepEqual(await typo.json(), { ok: false, error: "email-typo", suggestion: "kodi@gmail.com" });
  // Another website: no. The web build: yes, and its browser may read the answer.
  assert.deepEqual(await error({ message: "Hi" }, "https://evil.example"), [403, "origin"]);
  const web = "https://ignis-aura-play.creatio-aura.workers.dev";
  const fromWeb = await sendNote({ message: "From the web build." }, web);
  assert.equal(fromWeb.status, 200);
  assert.equal(fromWeb.headers.get("Access-Control-Allow-Origin"), web);
  const preflight = await fetch(`${BASE}/feedback`, { method: "OPTIONS", headers: { Origin: web } });
  assert.equal(preflight.status, 204);
  // No Origin opens the feedback alone, never the sign-up form.
  const noOrigin = await fetch(`${BASE}/signup`, { method: "POST", body: JSON.stringify(person()) });
  assert.equal(noOrigin.status, 403);
});

test("the feedback tool lists the notes, and the daily report counts them", async () => {
  const env = { ...process.env, SERVICE_URL: BASE, ADMIN_TOKEN: "test-admin-key" };
  const tool = spawnSync("node", ["tools/feedback.mjs"], { cwd, env, encoding: "utf8" });
  assert.match(tool.stdout, /> The menu button vanished on my turn\./);
  assert.match(tool.stdout, /0\.13\.5 · 1730000000 · Android · Pixel 8, Android 15/);
  assert.match(tool.stdout, /rook@example\.com/);
  const report = await (await admin("/admin/report", {})).json();
  assert.match(report.preview, /Feedback from the apps since the last report \(.+\): [1-9]\d*/);
});

// Last: it uses up this machine's feedback allowance.
test("a flood of feedback is cut off after a few an hour", async () => {
  let last;
  for (let i = 0; i < 35; i++) last = await sendNote({ message: `Note ${i}` });
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, "too-many");
});

// Last: it uses up this machine's sign-up allowance.
test("a flood of sign-ups from one connection is cut off after a few an hour", async () => {
  let last;
  for (let i = 0; i < 45; i++) last = await post("/signup", person({ email: `flood${i}@example.com`, turnstile: "" }));
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, "too-many");
});
