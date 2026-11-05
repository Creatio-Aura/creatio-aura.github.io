// The latest feedback from the Ignis Aura app, newest first (each one is emailed to the studio as
// it comes; this is the copy the service keeps).
//
//     npm run feedback
import { admin } from "./admin.mjs";

const { notes } = await admin("/admin/feedback");
if (notes.length === 0) console.log("No feedback yet.");
for (const note of notes) {
  const about = Object.values(note.details).join(" · ");
  console.log(`#${note.id}  ${note.created_at.slice(0, 16).replace("T", " ")} UTC  ${note.email ?? "(no address)"}${note.emailed ? "" : "  (not emailed yet)"}`);
  if (about) console.log(`    ${about}`);
  for (const line of note.message.split("\n")) console.log(`    > ${line}`);
  console.log("");
}
