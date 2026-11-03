// Everyone confirmed on each project's waiting list ("tell me when it's out").
//
//     npm run waitlist
import { admin } from "./admin.mjs";

const { lists } = await admin("/admin/waitlist");
for (const list of lists) {
  console.log(`${list.name}: ${list.people.length}`);
  for (const person of list.people) console.log(`  ${person.email}   (confirmed ${person.confirmed_at.slice(0, 10)})`);
}
