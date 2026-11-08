// Everyone let into each beta, with where they play, who's waiting for Andrew to let them in, and where
// sign-ups came from.
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

// Where sign-ups came from (everyone in or waiting): the Journal post and button ("web_jb_<post>"), the site
// they arrived from ("ref_google"), or "direct". Sign-ups from before 7 November 2026 have none.
for (const [project, name] of Object.entries(NAMES)) {
  const all = [...testers, ...waiting].filter((t) => t.project === project);
  if (all.length === 0) continue;
  const by = {};
  for (const t of all) by[t.source || "(not recorded)"] = (by[t.source || "(not recorded)"] || 0) + 1;
  console.log(`\n${name}: where sign-ups came from`);
  for (const [source, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${source}`);
}

console.log(`\nWaiting for your OK: ${waiting.length}${waiting.length ? " (the link is in the email you got, and in the morning report)" : ""}`);
if (waiting.length) table(waiting.map((t) => ({ ...t, name: NAMES[t.project] ?? t.project })), (t) => t.confirmed_at, "Confirmed");
