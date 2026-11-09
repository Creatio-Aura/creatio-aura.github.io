// Stores a beta's latest build links (Ignis Aura's unless --project names another) without emailing
// anyone: everyone let in from now on gets them in their "You're in" email. With no links, it only
// shows what's stored. (npm run announce stores them too, when it sends.)
//
//     npm run builds -- --android https://play.google.com/apps/internaltest/… --web
//     npm run builds -- --project effugium --android https://play.google.com/apps/internaltest/…
//     npm run builds                       what Ignis Aura's welcome sends now
//
//   --project effugium    Effugium Aura's beta (iPhone and Android) instead of Ignis Aura's
//   --android <link>      the Google Play test's join link
//   --web [link]          the web version; on its own, the usual address
//   --iphone <link>       the TestFlight link
import { parseArgs } from "node:util";

import { admin } from "./admin.mjs";

const WEB = "https://creatio-aura.com/ignis-aura-web/";
const { values } = parseArgs({
  options: {
    android: { type: "string" },
    web: { type: "string" },
    iphone: { type: "string" },
    project: { type: "string", default: "ignis" },
  },
  allowPositionals: false,
  strict: true,
  args: process.argv.slice(2).flatMap((arg, i, all) => (arg === "--web" && (!all[i + 1] || all[i + 1].startsWith("--")) ? ["--web", WEB] : [arg])),
});

const links = { Android: values.android, Web: values.web, iPhone: values.iphone };
for (const key of Object.keys(links)) if (!links[key]) delete links[key];
const result = await admin("/admin/builds", { project: values.project, links });
const stored = Object.entries(result.builds);
console.log(`${values.project === "effugium" ? "Effugium Aura" : "Ignis Aura"}: links in every "You're in" email${Object.keys(links).length ? " (updated)" : ""}:`);
if (stored.length === 0) console.log("  none yet");
for (const [platform, url] of stored) console.log(`  ${platform}: ${url}`);
