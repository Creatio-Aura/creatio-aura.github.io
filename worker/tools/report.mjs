// The daily beta report (the one emailed every morning), shown here; --send emails it now.
//
//     npm run report
//     npm run report -- --send
import { admin } from "./admin.mjs";

const send = process.argv.includes("--send");
const report = await admin("/admin/report", { send });
console.log(report.preview);
console.log(send ? `\nSent to ${report.to}.` : `\nNot sent: add --send to email it to ${report.to}.`);
