// Emails the confirmed beta testers about a new build, each with the links for the platforms
// they play on (people who play none of them get nothing). Shows who'd get what first; nothing
// is sent without --send.
//
//     npm run announce -- --title "Ignis Aura 0.6.0 is ready" --message "What's new: the digital board…" \
//       --android https://expo.dev/artifacts/eas/….apk --web
//     …then the same again with --send
//
//   --title "…"           the subject and heading
//   --message "…"         the note (blank lines make paragraphs), or --message-file note.txt
//   --android <link>      the Android install link (from the Expo build page)
//   --web [link]          the web version; on its own, the usual address
//   --iphone <link>       the TestFlight link, once there is one
//   --send                actually send
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { admin } from "./admin.mjs";

const WEB = "https://creatio-aura.com/ignis-aura-web/";
const { values } = parseArgs({
  options: {
    title: { type: "string" },
    message: { type: "string" },
    "message-file": { type: "string" },
    android: { type: "string" },
    web: { type: "string" },
    iphone: { type: "string" },
    send: { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
  // --web on its own means the usual address.
  args: process.argv.slice(2).flatMap((arg, i, all) => (arg === "--web" && (!all[i + 1] || all[i + 1].startsWith("--")) ? ["--web", WEB] : [arg])),
});

const message = values["message-file"] ? readFileSync(values["message-file"], "utf8") : values.message;
const links = { Android: values.android, Web: values.web, iPhone: values.iphone };
for (const key of Object.keys(links)) if (!links[key]) delete links[key];
if (!values.title || !message || Object.keys(links).length === 0) {
  console.error("Needs --title, --message (or --message-file), and at least one of --android, --web, --iphone.");
  process.exit(1);
}

const result = await admin("/admin/announce", { title: values.title, message, links, send: values.send });
if (result.recipients.length === 0) {
  console.log("Nobody plays on those platforms yet: nothing to send.");
  process.exit(0);
}
console.log(`${values.send ? "Sent to" : "Would send to"} ${result.recipients.length}:`);
for (const r of result.recipients) console.log(`  ${r.name} <${r.email}>: ${r.platforms.join(", ")}`);
if (!values.send) {
  console.log("\n— The first email, as text —\n");
  console.log(result.recipients[0].preview);
  console.log("\nNothing was sent. Add --send to send it.");
} else {
  console.log(`\nSent: ${result.sent}.`);
  if (result.failed.length) console.log(`Failed: ${result.failed.map((f) => `${f.email} (${f.error})`).join("; ")}`);
  if (result.notSentToday.length) console.log(`Over today's email allowance, send tomorrow: ${result.notSentToday.join(", ")}`);
}
