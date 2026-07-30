// scripts/machine-room/auth.check.ts
// AUTH FAILS CLOSED — the deliberate inversion of movie-lookup.
//
// movie-lookup's checkBasicAuth returns TRUE when unconfigured, which is right
// for a read-only lookup that must not block local dev. Here the same default
// would leave a money-spending, publishing surface open to anything that can
// reach the port. So the absence of a token is a startup REFUSAL, pinned below.

import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE,
  SessionStore,
  clearedCookie,
  newSessionId,
  parseCookies,
  readAdminToken,
  sessionCookie,
  tokenMatches,
} from "./auth.js";

const GOOD = "a-long-enough-machine-room-token-value";

describe("startup gate — no token means NO SERVER", () => {
  it("refuses when MACHINE_ROOM_TOKEN is unset", () => {
    const r = readAdminToken({} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("MACHINE_ROOM_TOKEN is not set");
    expect(r.message).toContain("FAILS CLOSED");
  });

  it("refuses an empty or whitespace token", () => {
    expect(readAdminToken({ MACHINE_ROOM_TOKEN: "" } as NodeJS.ProcessEnv).ok).toBe(false);
    expect(readAdminToken({ MACHINE_ROOM_TOKEN: "   " } as NodeJS.ProcessEnv).ok).toBe(false);
  });

  it("refuses a too-short token rather than accepting a weak one", () => {
    const r = readAdminToken({ MACHINE_ROOM_TOKEN: "short" } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("at least 16");
  });

  it("accepts a long token, trimmed", () => {
    const r = readAdminToken({ MACHINE_ROOM_TOKEN: `  ${GOOD}  ` } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe(GOOD);
  });
});

describe("tokenMatches — constant-time, and closed by default", () => {
  it("accepts only the exact token", () => {
    expect(tokenMatches(GOOD, GOOD)).toBe(true);
    expect(tokenMatches(GOOD + "x", GOOD)).toBe(false);
    expect(tokenMatches(GOOD.slice(0, -1), GOOD)).toBe(false);
    expect(tokenMatches(GOOD.toUpperCase(), GOOD)).toBe(false);
  });
  it("rejects absent / empty input", () => {
    expect(tokenMatches(undefined, GOOD)).toBe(false);
    expect(tokenMatches("", GOOD)).toBe(false);
  });
  it("rejects EVERYTHING when the expected token is empty — never accidentally open", () => {
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("anything", "")).toBe(false);
  });
});

describe("cookies", () => {
  it("parses a normal header", () => {
    expect(parseCookies("a=1; mr_session=abc; b=2")).toEqual({ a: "1", mr_session: "abc", b: "2" });
  });
  it("tolerates junk, empties and absence", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("novalue; =x; ok=1")).toEqual({ ok: "1" });
  });
  it("is HttpOnly + SameSite=Strict, and NOT Secure (this server is plain http on loopback)", () => {
    const c = sessionCookie("abc123", 60);
    expect(c).toContain(`${SESSION_COOKIE}=abc123`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Max-Age=60");
    expect(c).not.toContain("Secure");
  });
  it("clearing expires it immediately", () => {
    expect(clearedCookie()).toContain("Max-Age=0");
  });
});

describe("session store", () => {
  it("issues unpredictable ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
    expect([...ids][0]).toMatch(/^[0-9a-f]{64}$/);
  });
  it("validates only ids it issued", () => {
    const s = new SessionStore();
    const id = s.create();
    expect(s.isValid(id)).toBe(true);
    expect(s.isValid("not-a-session")).toBe(false);
    expect(s.isValid(undefined)).toBe(false);
  });
  it("expires on TTL and forgets the entry", () => {
    const s = new SessionStore(1000);
    const id = s.create(0);
    expect(s.isValid(id, 999)).toBe(true);
    expect(s.isValid(id, 1001)).toBe(false);
    expect(s.size).toBe(0);
  });
  it("destroy revokes immediately", () => {
    const s = new SessionStore();
    const id = s.create();
    s.destroy(id);
    expect(s.isValid(id)).toBe(false);
  });
});
