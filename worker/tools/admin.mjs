// Shared by the testers and announce tools: where the service is, and the admin key.
// The key lives only on this computer, in worker/.admin-token (never in git), and as the
// service's ADMIN_TOKEN secret. Override either with SERVICE_URL / ADMIN_TOKEN.
import { existsSync, readFileSync } from "node:fs";

const here = new URL("..", import.meta.url);

export function serviceUrl() {
  if (process.env.SERVICE_URL) return process.env.SERVICE_URL.replace(/\/$/, "");
  const toml = readFileSync(new URL("wrangler.toml", here), "utf8");
  return toml.match(/^SERVICE_URL\s*=\s*"([^"]+)"/m)[1].replace(/\/$/, "");
}

export function adminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
  const file = new URL(".admin-token", here);
  if (!existsSync(file)) {
    console.error("No admin key on this computer: worker/.admin-token is missing. See README.md → The tools.");
    process.exit(1);
  }
  return readFileSync(file, "utf8").trim();
}

export async function admin(path, body) {
  const response = await fetch(`${serviceUrl()}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${adminToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!result.ok) {
    const why = result.error === "admin" ? "the admin key was refused" : result.error;
    console.error(`The service said no: ${why}`);
    process.exit(1);
  }
  return result;
}
