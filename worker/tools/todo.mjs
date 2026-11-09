// What's left for Andrew to do by hand: Android testers to add to their app's Google Play internal
// test email list (Play Console › the app › Testing › Internal testing › Testers). Tick one off once
// it's done, here or with the link in the morning report or on the "They're in" page.
//
//     npm run todo                                         what's left
//     npm run todo -- --done someone@example.com           ticked off (Ignis Aura's beta)
//     npm run todo -- --done someone@example.com --project effugium
import { parseArgs } from "node:util";

import { admin } from "./admin.mjs";

const { values } = parseArgs({
  options: { done: { type: "string" }, project: { type: "string", default: "ignis" } },
  allowPositionals: false,
  strict: true,
});
const result = values.done
  ? await admin("/admin/todo", { project: values.project, email: values.done })
  : await admin("/admin/todo");
if (values.done) console.log(`Ticked off: ${values.done}.\n`);
console.log(`To add on Google Play: ${result.play.length}`);
for (const p of result.play) console.log(`  [ ] ${p.app}: ${p.email} (in since ${p.inSince.slice(0, 10)})`);
if (result.play.length) console.log("\nPlay Console › the app › Testing › Internal testing › Testers: add each address to the email list.");
