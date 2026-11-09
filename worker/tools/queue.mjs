// The email queue: what's waiting to go to IONOS (and why, if it was turned away for now), and anything
// IONOS turned away for good. The service sends one a minute on its own, within MAIL_PER_HOUR.
//
//     npm run queue                what's waiting
//     npm run queue -- --drain 3   send up to 3 now (still within the hour's budget)
import { parseArgs } from "node:util";

import { admin } from "./admin.mjs";

const { values } = parseArgs({ options: { drain: { type: "string" } }, allowPositionals: false, strict: true });
const result = values.drain ? await admin("/admin/queue", { drain: Number(values.drain) }) : await admin("/admin/queue");
if (result.done) console.log(`Sent ${result.done.sent} now${result.done.later ? `; ${result.done.later} turned away for now (tried again later)` : ""}${result.done.failed ? `; ${result.done.failed} turned away for good` : ""}.\n`);
console.log(`Handed to the mail server in the last hour: ${result.lastHour} of ${result.perHour}.`);
console.log(`Waiting: ${result.waiting.length}`);
for (const q of result.waiting) {
  console.log(`  … ${q.to_addr}: "${q.subject}"${q.tries ? `, tried ${q.tries}×, next ${q.next_try_at.slice(11, 16)} UTC` : ""}`);
  if (q.last_error) console.log(`      the mail server said: ${q.last_error}`);
}
if (result.failed.length) {
  console.log(`Will never go: ${result.failed.length}`);
  for (const q of result.failed) console.log(`  ✗ ${q.to_addr}: "${q.subject}". ${q.last_error ?? ""}`);
}
