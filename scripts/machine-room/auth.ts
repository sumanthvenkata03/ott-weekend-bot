// scripts/machine-room/auth.ts
// AUTH THAT FAILS CLOSED — the deliberate inversion of movie-lookup.
//
// movie-lookup's gate returns TRUE when unconfigured (auth.ts: `if
// (!authEnabled(cfg)) return true`), which is right for a read-only lookup that
// must not block local dev. It is exactly wrong here. This server SPENDS MONEY
// and PUBLISHES. An unconfigured machine room must not be an open one, so the
// absence of MACHINE_ROOM_TOKEN is a startup refusal, not a permissive default.
//
// COOKIE, NOT BEARER HEADER. EventSource cannot set request headers, and the
// live log pane is an EventSource. So the session rides an HttpOnly cookie.
// SameSite=Strict because every state-changing route is POST and there is no
// cross-site flow that could ever legitimately reach this server.
//
// No dependency: the session id is randomBytes, the compare is timingSafeEqual,
// the cookie is a string.

import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "mr_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * Constant-time token compare that tolerates a length mismatch without
 * throwing. Length still leaks, as it does in every such implementation; the
 * token is a local secret, not a password database.
 */
export function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!expected) return false;
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function newSessionId(): string {
  return randomBytes(32).toString("hex");
}

/** Parse a Cookie header into a plain map. Tolerates junk and missing values. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/**
 * The Set-Cookie value. No `Secure`: this server binds 127.0.0.1 only and is
 * therefore served over plain http, where a Secure cookie would be discarded
 * by the browser and lock the operator out.
 */
export function sessionCookie(id: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** In-memory session store. Sessions die with the process, which is correct. */
export class SessionStore {
  private live = new Map<string, number>();

  constructor(private ttlMs = SESSION_TTL_SECONDS * 1000) {}

  create(now = Date.now()): string {
    const id = newSessionId();
    this.live.set(id, now + this.ttlMs);
    return id;
  }

  isValid(id: string | undefined, now = Date.now()): boolean {
    if (!id) return false;
    const expires = this.live.get(id);
    if (expires === undefined) return false;
    if (expires <= now) {
      this.live.delete(id);
      return false;
    }
    return true;
  }

  destroy(id: string | undefined): void {
    if (id) this.live.delete(id);
  }

  get size(): number {
    return this.live.size;
  }
}

/**
 * The startup gate. Returns the token, or explains and refuses.
 * Kept pure (takes an env bag) so the refusal is unit-testable without exiting.
 */
export function readAdminToken(env: NodeJS.ProcessEnv = process.env): { ok: true; token: string } | { ok: false; message: string } {
  const token = (env.MACHINE_ROOM_TOKEN ?? "").trim();
  if (token.length === 0) {
    return {
      ok: false,
      message:
        "MACHINE_ROOM_TOKEN is not set.\n\n" +
        "The machine room spends money and publishes, so it FAILS CLOSED — unlike\n" +
        "the movie-lookup tool, an unconfigured machine room does not run open.\n\n" +
        "Add a long random value to .env, then start again:\n" +
        "  MACHINE_ROOM_TOKEN=<paste 32+ random chars>\n",
    };
  }
  if (token.length < 16) {
    return {
      ok: false,
      message: `MACHINE_ROOM_TOKEN is only ${token.length} chars. Use at least 16.\n`,
    };
  }
  return { ok: true, token };
}
