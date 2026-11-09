// Sends one tester their "You're in" email again (Ignis Aura's beta unless --project names another),
// with the links stored now (npm run builds). For someone let in before their platform had a link.
// Shows what it would send first; nothing is sent without --send.
//
//     npm run welcome -- --email someone@example.com
//     npm run welcome -- --email someone@example.com --send
//     npm run welcome -- --project effugium --email someone@example.com --send
//     --note "…"   a short line at the top (say, why they're getting it again)
import { parseArgs } from "node:util";

import { admin } from "./admin.mjs";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    project: { type: "string", default: "ignis" },
    note: { type: "string" },
    send: { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});
if (!values.email) {
  console.error("Needs --email (the address they signed up with).");
  process.exit(1);
}
const result = await admin("/admin/welcome", { project: values.project, email: values.email, note: values.note, send: values.send });
if (!result.ok) {
  console.error(result.error === "not-a-tester" ? `${values.email} isn't a tester let in to that beta.` : `Couldn't: ${result.error}`);
  process.exit(1);
}
const missing = result.platforms.filter((p) => !result.links.includes(p));
console.log(`${result.email} plays on ${result.platforms.join(", ")}.`);
console.log(result.links.length ? `Their welcome has the links for ${result.links.join(", ")}.` : "No links stored for their platforms yet (npm run builds).");
if (missing.length) console.log(`No link yet for: ${missing.join(", ")}.`);
if (!values.send && result.preview) console.log("\nThe email:\n\n" + result.preview.replace(/^/gm, "  | "));
console.log(values.send ? (result.sent ? "Sent." : "Not sent: the email service didn't take it, or the day's limit is reached.") : "Dry run: add --send to send it.");
