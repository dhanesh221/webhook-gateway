// Reads an operator-chosen password from stdin. Use a hidden shell prompt or a
// password-manager pipe, never a command-line argument or conversation message.
// Only its bcrypt hash is persisted. Existing credentials require --force.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import bcrypt from "bcryptjs";

export async function setupAuth(force: boolean, password: string): Promise<number> {
  const envPath = ".env.local";
  if (!existsSync(envPath)) { console.error("Create .env.local first (see README)."); return 1; }
  const existing = readFileSync(envPath, "utf8");
  if (/^ADMIN_PASSWORD_HASH=/m.test(existing) && !force) {
    console.error("Already configured. Use --force to replace the password and invalidate sessions."); return 1;
  }
  const bytes = Buffer.byteLength(password);
  if (bytes < 16 || bytes > 72 || /[\r\n\0]/.test(password)) {
    console.error("Password must be 16-72 UTF-8 bytes, without newlines or NUL."); return 1;
  }
  const hash = await bcrypt.hash(password, 12);
  const secret = randomBytes(48).toString("hex");
  const cleaned = existing.split("\n").filter(line =>
    !/^(ADMIN_PASSWORD_HASH=|SESSION_SECRET=|# dashboard login password|# --- Dashboard auth)/.test(line)
  ).join("\n").replace(/\n+$/, "");
  writeFileSync(envPath, `${cleaned}\n\n# --- Dashboard auth ---\nADMIN_PASSWORD_HASH='${hash}'\nSESSION_SECRET='${secret}'\n`);
  chmodSync(envPath, 0o600);
  console.log("Dashboard credentials configured. No plaintext password was saved. Old tokens are invalid.");
  return 0;
}
if (require.main === module) {
  if (process.stdin.isTTY) { console.error("Pipe the password via stdin; see README's hidden-prompt example."); process.exitCode = 1; }
  else {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; if (input.length > 1024) process.stdin.destroy(); });
    process.stdin.on("end", () => { setupAuth(process.argv.includes("--force"), input.replace(/\r?\n$/, "")).then(code => { process.exitCode = code; }).catch(() => { console.error("Credential setup failed"); process.exitCode = 1; }); });
  }
}
