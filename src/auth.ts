// Session auth for the Phase 5 dashboard.
//
// Deliberately small and self-rolled rather than Supabase Auth. The reasoning
// (also in the README): this Express server is the only thing that ever holds
// the Supabase anon key — it is never shipped to a browser, unlike a typical
// Supabase frontend app. So the browser never talks to Supabase directly, and
// a server-side session cookie is a sufficient gate. Wiring up Supabase Auth
// would add an email-confirmation round trip for a single-operator dashboard.
import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const SESSION_COOKIE = "wg_session";

// Short-lived on purpose: this cookie is the only thing standing between a
// browser and the replay button, and there is no revocation list.
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionPayload {
  sub: string;
  iat?: number;
  exp?: number;
}

// Read at call time, not module load — same reasoning as getSupabase()'s lazy
// init: importing app.ts must never require env vars to be set.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set (run \`npm run setup:auth\`)`);
  }
  return value;
}

export async function verifyPassword(password: string): Promise<boolean> {
  const hash = requireEnv("ADMIN_PASSWORD_HASH");
  return bcrypt.compare(password, hash);
}

export function issueSessionToken(): string {
  return jwt.sign({ sub: "admin" }, requireEnv("SESSION_SECRET"), {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

// Returns null for anything a client could plausibly send: a forged signature,
// a token signed with a different secret, a token past its expiry, or garbage.
// A missing SESSION_SECRET is NOT one of those — that's server misconfiguration
// and is allowed to throw so it surfaces as a 500 rather than a silent 401.
export function verifySessionToken(token: string): SessionPayload | null {
  const secret = requireEnv("SESSION_SECRET");
  try {
    return jwt.verify(token, secret) as SessionPayload;
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    // Blocks the cookie on cross-site POSTs (CSRF) while still surviving a
    // normal top-level navigation back into the dashboard.
    sameSite: "lax" as const,
    // Local development is plain http, so this can't be unconditional.
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    SESSION_COOKIE
  ];

  if (!token || !verifySessionToken(token)) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  return next();
}

// True only for a request carrying a valid session. Used by `GET /` to decide
// which page to send the browser to; never used to grant access on its own.
export function hasValidSession(req: Request): boolean {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    SESSION_COOKIE
  ];
  if (!token) return false;
  try {
    return verifySessionToken(token) !== null;
  } catch {
    return false;
  }
}
