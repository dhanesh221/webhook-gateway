import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { setupAuth } from "../src/setupAuth";
let dir: string;
const cwd = process.cwd();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(),"wg-auth-")); process.chdir(dir);
  vi.spyOn(console,"log").mockImplementation(()=>{}); vi.spyOn(console,"error").mockImplementation(()=>{});
});
afterEach(() => { process.chdir(cwd); rmSync(dir,{recursive:true,force:true}); vi.restoreAllMocks(); });
describe("credential setup", () => {
  it("persists only a hash, removes legacy plaintext and restricts file permissions", async () => {
    writeFileSync(".env.local","SUPABASE_URL=keep\n# dashboard login password: old-plaintext\nADMIN_PASSWORD_HASH='old'\nSESSION_SECRET='old'\n");
    const password="new-password-never-saved-in-plaintext";
    expect(await setupAuth(true,password)).toBe(0);
    const env=readFileSync(".env.local","utf8");
    expect(env).not.toContain(password); expect(env).not.toContain("old-plaintext"); expect(env).toContain("SUPABASE_URL=keep");
    const hash=env.match(/ADMIN_PASSWORD_HASH='([^']+)'/)![1];
    expect(await bcrypt.compare(password,hash)).toBe(true);
    expect(statSync(".env.local").mode & 0o777).toBe(0o600);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(password);
  });
  it("does not overwrite credentials without force", async () => {
    writeFileSync(".env.local","ADMIN_PASSWORD_HASH=existing\n");
    expect(await setupAuth(false,"long-enough-test-password")).toBe(1);
    expect(readFileSync(".env.local","utf8")).toBe("ADMIN_PASSWORD_HASH=existing\n");
  });
  it("rejects missing files, short/oversized passwords and newlines", async () => {
    expect(await setupAuth(false,"long-enough-test-password")).toBe(1);
    writeFileSync(".env.local","SUPABASE_URL=keep\n");
    for (const password of ["short", "a".repeat(73), "a".repeat(20)+"\n"])
      expect(await setupAuth(false,password)).toBe(1);
    expect(readFileSync(".env.local","utf8")).toBe("SUPABASE_URL=keep\n");
  });
});
