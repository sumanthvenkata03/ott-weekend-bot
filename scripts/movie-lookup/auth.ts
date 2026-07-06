// scripts/movie-lookup/auth.ts
// HTTP Basic Auth for the internal movie-lookup server, factored into a pure,
// testable module (no node:http / no SQLite / no network in the import graph).
//
// Policy:
//   - Auth is ENABLED only when BOTH MOVIE_LOOKUP_USER and MOVIE_LOOKUP_PASS are
//     set (non-empty). On Render you set these, so the site is protected.
//   - When either is unset, auth is DISABLED (open) so local dev isn't blocked —
//     the server logs a loud one-time warning at startup (see server.ts).
//   - Credentials are compared in constant time. The password is NEVER logged.

import { timingSafeEqual } from "node:crypto";

export interface AuthConfig {
  user?: string | undefined;
  pass?: string | undefined;
}

/** Read the auth config from the environment (or a provided bag, for tests). */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return { user: env.MOVIE_LOOKUP_USER, pass: env.MOVIE_LOOKUP_PASS };
}

/** Auth is active only when BOTH creds are present and non-empty. */
export function authEnabled(cfg: AuthConfig): boolean {
  return !!(cfg.user && cfg.pass);
}

/** Constant-time compare that tolerates length mismatch without throwing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Validate an incoming `Authorization` header against the configured creds.
 *   - When auth is DISABLED (unconfigured) → always true (open).
 *   - When ENABLED → true only for a well-formed `Basic base64(user:pass)` whose
 *     decoded user AND pass match exactly.
 */
export function checkBasicAuth(authorization: string | undefined, cfg: AuthConfig): boolean {
  if (!authEnabled(cfg)) return true;
  if (!authorization || !/^Basic /i.test(authorization)) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.replace(/^Basic /i, "").trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, cfg.user as string) && safeEqual(pass, cfg.pass as string);
}

export const REALM = "TBSI Movie Lookup";

/** The value for the `WWW-Authenticate` response header on a 401. */
export function wwwAuthenticateHeader(): string {
  return `Basic realm="${REALM}", charset="UTF-8"`;
}
