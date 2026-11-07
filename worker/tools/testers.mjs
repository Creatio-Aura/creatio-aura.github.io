// Everyone let into each beta, with where they play, and who's waiting for Andrew to let them in.
//
//     npm run testers
import { admin } from "./admin.mjs";

const NAMES = { ignis: "Ignis Aura", effugium: "Effugium Aura" };
const { testers, waiting } = await admin("/admin/testers");

const table = (people, dateOf, dateTitle) => {
  const rows = people.map((t) => [t.name || "", t.email, t.platforms.join(", "), dateOf(t).slice(0, 10)]);
  const titles = ["Name", "Email", "Plays on", dateTitle];
  const widths = titles.map((title, i) => Math.max(...rows.map((r) => r[i].length), title.length));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("   ");
  console.log(line(titles));
  console.log(widths.map((w) => "-".repeat(w)).join("   "));
  people.forEach((t, i) => {
    console.log(line(rows[i]));
    if (t.notes) console.log(`    Notes: ${t.notes.replace(/\n/g, " / ")}`);
  });
};

for (const [project, name] of Object.entries(NAMES)) {
  const theirs = testers.filter((t) => t.project === project);
  console.log(`\n${name} beta: ${theirs.length} in`);
  if (theirs.length === 0) continue;
  table(theirs, (t) => t.approved_at, "In since");
  const count = (p) => theirs.filter((t) => t.platforms.includes(p)).length;
  console.log(["iPhone", "Android", "Web"].map((p) => `${p} ${count(p)}`).join(" · "));
}

console.log(`\nWaiting for your OK: ${waiting.length}${waiting.length ? " (the link is in the email you got, and in the morning report)" : ""}`);
if (waiting.length) table(waiting.map((t) => ({ ...t, name: NAMES[t.project] ?? t.project })), (t) => t.confirmed_at, "Confirmed");
