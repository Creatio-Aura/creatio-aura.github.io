// Lets in people Andrew invited himself (for example, ones already on a Google Play tester list) and
// sends each the "You're in" email with the latest links and guides. Shows who and the email first;
// nothing is added or sent without --send. People already in that beta are left alone.
//
//     npm run add-testers -- --project effugium --platforms Android --on-play-list --emails "a@x.com, b@y.com"
//     npm run add-testers -- --project effugium --platforms Android --on-play-list --file emails.txt --send
//
//   --project effugium    Effugium Aura's beta (Ignis Aura's if left out)
//   --platforms Android   where they test: Android, iPhone, Web (comma-separated)
//   --on-play-list        they're already on the Google Play tester list, so no to-do for it
//   --emails "…"          addresses, separated by commas, spaces or new lines; or --file with one per line
//   --note "…"            a short line at the top of their email (say, why they're getting it again)
//   --send                actually add them and send
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { admin } from "./admin.mjs";

const { values } = parseArgs({
  options: {
    project: { type: "string", default: "ignis" },
    platforms: { type: "string" },
    "on-play-list": { type: "boolean", default: false },
    emails: { type: "string" },
    file: { type: "string" },
    note: { type: "string" },
    send: { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});
const raw = values.file ? readFileSync(values.file, "utf8") : values.emails ?? "";
const emails = raw.split(/[\s,;]+/).filter((e) => e.includes("@"));
const platforms = (values.platforms ?? "").split(",").map((p) => p.trim()).filter(Boolean);
if (!emails.length || !platforms.length) {
  console.error("Needs --platforms and --emails (or --file).");
  process.exit(1);
}
const result = await admin("/admin/add", {
  project: values.project,
  platforms,
  emails,
  onPlayList: values["on-play-list"],
  note: values.note,
  send: values.send,
});
if (!values.send) {
  console.log(`Would let in ${result.add.length} on ${result.platforms.join(", ")}${result.onPlayList ? " (already on the Google Play list)" : ""}:`);
  for (const e of result.add) console.log(`  + ${e}`);
  if (result.already.length) console.log(`Already in, left alone: ${result.already.join(", ")}`);
  console.log("\nThe email each one gets:\n");
  console.log(result.preview.replace(/^/gm, "  | "));
  console.log("\nDry run: add --send to let them in and send it.");
} else {
  console.log(`Let in ${result.added.length}; ${result.queued} welcome email(s) queued: they go out at the mail server's pace (npm run queue shows them).`);
  if (result.notSent.length) console.log(`Not queued (the day's limit): ${result.notSent.join(", ")}. Resend later with npm run welcome.`);
  if (result.already.length) console.log(`Already in, left alone: ${result.already.join(", ")}`);
}
