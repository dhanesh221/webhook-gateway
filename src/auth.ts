import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getSupabase } from "./supabase";

export const SESSION_COOKIE = "wg_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export interface SessionPayload { sub: string; jti: string; credential: string; iat: number; exp: number; }
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}
function credentialVersion(): string {
  return createHash("sha256").update(requireEnv("ADMIN_PASSWORD_HASH")).digest("hex");
}
export async function verifyPassword(password: string): Promise<boolean> {
  // bcrypt truncates after 72 bytes. Reject rather than accepting a suffix that
  // the caller reasonably believes is part of the password.
  if (Buffer.byteLength(password) > 72) return false;
  return bcrypt.compare(password, requireEnv("ADMIN_PASSWORD_HASH"));
}
export async function issueSessionToken(): Promise<string> {
  const jti = randomUUID();
  const token = jwt.sign({ sub: "admin", credential: credentialVersion() }, requireEnv("SESSION_SECRET"), {
    expiresIn: SESSION_TTL_SECONDS, jwtid: jti, algorithm: "HS256",
  });
  const { error } = await getSupabase().rpc("create_dashboard_session", {
    p_id: jti, p_expires_at: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) throw new Error("Session storage unavailable");
  return token;
}
export function verifySessionToken(token: string): SessionPayload | null {
  const secret = requireEnv("SESSION_SECRET");
  try {
    const p = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (typeof p === "string" || p.sub !== "admin" || typeof p.jti !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(p.jti) || typeof p.exp !== "number" ||
        p.credential !== credentialVersion()) return null;
    return p as SessionPayload;
  } catch { return null; }
}
function requestToken(req: Request): string | undefined { return req.cookies?.[SESSION_COOKIE]; }
export async function hasValidSession(req: Request): Promise<boolean> {
  const token = requestToken(req);
  if (!token) return false;
  const payload = verifySessionToken(token);
  if (!payload) return false;
  const { data, error } = await getSupabase().rpc("is_dashboard_session_active", { p_id: payload.jti });
  if (error) throw new Error("Session storage unavailable");
  return data === true;
}
export async function revokeSession(req: Request): Promise<void> {
  const token = requestToken(req);
  if (!token) return;
  const p = verifySessionToken(token);
  if (!p) return;
  const { error } = await getSupabase().rpc("revoke_dashboard_session", { p_id: p.jti });
  if (error) throw new Error("Session storage unavailable");
}
export async function revokeAllSessions(): Promise<void> {
  const { error } = await getSupabase().rpc("revoke_all_dashboard_sessions");
  if (error) throw new Error("Failed to revoke sessions");
}
export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };
}
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  hasValidSession(req).then(valid => {
    if (!valid) res.status(401).json({ error: "Not authenticated" });
    else next();
  }).catch(next);
}
