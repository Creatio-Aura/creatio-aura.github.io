// Everyone confirmed on the Ignis Aura beta list, with where they play.
//
//     npm run testers
import { admin } from "./admin.mjs";

const { testers } = await admin("/admin/testers");
if (testers.length === 0) {
  console.log("No confirmed testers yet.");
} else {
  const rows = testers.map((t) => [t.name, t.email, t.platforms.join(", "), t.confirmed_at.slice(0, 10)]);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length), ["Name", "Email", "Plays on", "Confirmed"][i].length));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("   ");
  console.log(line(["Name", "Email", "Plays on", "Confirmed"]));
  console.log(widths.map((w) => "-".repeat(w)).join("   "));
  testers.forEach((t, i) => {
    console.log(line(rows[i]));
    if (t.notes) console.log(`    Notes: ${t.notes.replace(/\n/g, " / ")}`);
  });
  const count = (p) => testers.filter((t) => t.platforms.includes(p)).length;
  console.log(`\n${testers.length} confirmed · iPhone ${count("iPhone")} · Android ${count("Android")} · Web ${count("Web")}`);
}
