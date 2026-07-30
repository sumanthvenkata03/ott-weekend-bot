// scripts/movie-lookup/errors.check.ts
// Tool-local tests for the PUBLIC error body. Named *.check.ts so the repo's
// `npx vitest run --dir src` never collects them. Run with:
//   npx vitest run --config scripts/movie-lookup/vitest.config.ts
//
// The regression: this server answered a failed request with `{ error: e.message }`
// while holding 8 secrets, and three upstreams (TMDb, OMDb, Fanart) carry their
// key in the request URL — so ofetch's `[GET] "<url>": 401` message put a live key
// into a body served to whoever triggered the error, on a PUBLIC deployment.
//
// Fully offline: pure functions only, no node:http, no network, no SQLite.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  errBody,
  newIncidentId,
  registerLookupSecrets,
  GENERIC_ERROR_MESSAGE,
  LOOKUP_SECRET_ENV,
} from "./errors.js";
import { __resetSecretRegistry, registeredSecretNames } from "../../src/shared/redact.js";

const TMDB = "tmdb-live-key-9f8e7d6c5b4a3210";
const DB_URL = "postgres://tbsi:sup3rsecretpassword@dpg-xyz.internal:5432/lookup";

/** The exact shape ofetch throws when a keyed TMDb GET fails. */
const tmdbFailure = () =>
  new Error(`[GET] "https://api.themoviedb.org/3/movie/693134?api_key=${TMDB}&language=en-US": 401 Unauthorized`);

let logged: string[];

beforeEach(() => {
  __resetSecretRegistry();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logged.push(a.map((x) => String(x)).join(" "));
  });
});

afterEach(() => {
  __resetSecretRegistry();
  vi.restoreAllMocks();
});

describe("registerLookupSecrets — this process's own 8 secrets", () => {
  it("covers exactly the render.yaml env set, including the two outside ConfigSchema", () => {
    expect([...LOOKUP_SECRET_ENV]).toEqual([
      "TMDB_API_KEY",
      "OMDB_API_KEY",
      "FANART_API_KEY",
      "TVDB_API_KEY",
      "YOUTUBE_API_KEY",
      "MOVIE_LOOKUP_USER",
      "MOVIE_LOOKUP_PASS",
      "DATABASE_URL",
    ]);
    expect([...LOOKUP_SECRET_ENV]).toContain("FANART_API_KEY");
    expect([...LOOKUP_SECRET_ENV]).toContain("TVDB_API_KEY");
  });

  it("registers from a supplied env bag and skips what is unset", () => {
    registerLookupSecrets({ TMDB_API_KEY: TMDB, DATABASE_URL: DB_URL } as NodeJS.ProcessEnv);
    expect(registeredSecretNames()).toEqual(["DATABASE_URL", "TMDB_API_KEY"]);
  });
});

describe("errBody — the PUBLIC body reveals nothing", () => {
  it("carries no registered secret value", () => {
    registerLookupSecrets({ TMDB_API_KEY: TMDB } as NodeJS.ProcessEnv);
    const body = errBody(tmdbFailure(), "request");
    expect(JSON.stringify(body)).not.toContain(TMDB);
  });

  it("carries no api_key / apikey / token pattern at all", () => {
    registerLookupSecrets({ TMDB_API_KEY: TMDB } as NodeJS.ProcessEnv);
    const payload = JSON.stringify(errBody(tmdbFailure(), "request"));
    expect(payload).not.toMatch(/api_key/i);
    expect(payload).not.toMatch(/apikey/i);
    expect(payload).not.toMatch(/token/i);
  });

  it("leaks NOTHING about the upstream — not the host, status, or path", () => {
    const payload = JSON.stringify(errBody(tmdbFailure(), "request"));
    expect(payload).not.toContain("themoviedb");
    expect(payload).not.toContain("401");
    expect(payload).not.toContain("693134");
  });

  it("is generic even when the key was never registered (no reliance on the registry)", () => {
    expect(registeredSecretNames()).toEqual([]);
    const body = errBody(tmdbFailure(), "request");
    expect(body.error).toBe(GENERIC_ERROR_MESSAGE);
    expect(JSON.stringify(body)).not.toContain(TMDB);
  });

  it("never echoes a non-Error throw either", () => {
    const body = errBody(`raw string carrying ${TMDB}`, "static");
    expect(JSON.stringify(body)).not.toContain(TMDB);
  });

  it("does not leak a DATABASE_URL password through a pg failure", () => {
    registerLookupSecrets({ DATABASE_URL: DB_URL } as NodeJS.ProcessEnv);
    const body = errBody(new Error(`connection terminated: ${DB_URL}`), "request");
    const payload = JSON.stringify(body);
    expect(payload).not.toContain("sup3rsecretpassword");
    expect(payload).not.toContain(DB_URL);
  });
});

describe("errBody — the INCIDENT ID", () => {
  it("is present, short, and hex", () => {
    const body = errBody(tmdbFailure(), "request");
    expect(body.incident).toMatch(/^[0-9a-f]{8}$/);
  });

  it("differs per call, so two failures are distinguishable", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newIncidentId()));
    expect(ids.size).toBe(20);
  });

  it("appears in BOTH the body and the log line, so they can be correlated", () => {
    const body = errBody(tmdbFailure(), "request");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`[incident ${body.incident}]`);
  });
});

describe("errBody — the SERVER LOG keeps the real, scrubbed error", () => {
  it("logs the real message with the key replaced by a NAMED marker", () => {
    registerLookupSecrets({ TMDB_API_KEY: TMDB } as NodeJS.ProcessEnv);
    errBody(tmdbFailure(), "request");
    const line = logged[0] ?? "";
    expect(line).not.toContain(TMDB);
    expect(line).toContain("<REDACTED:TMDB_API_KEY>");
    // Still fully diagnosable server-side — this is the whole trade.
    expect(line).toContain("api.themoviedb.org/3/movie/693134");
    expect(line).toContain("401 Unauthorized");
    expect(line).toContain("[request]");
  });

  it("falls back to the *** pattern for an UNREGISTERED key", () => {
    errBody(new Error('[GET] "https://webservice.fanart.tv/v3/movies/1?api_key=UNREGISTERED_FANART": 403'));
    const line = logged[0] ?? "";
    expect(line).not.toContain("UNREGISTERED_FANART");
    expect(line).toContain("api_key=***");
  });

  it("logs the STACK, not just the message, so the throw site survives", () => {
    errBody(tmdbFailure(), "request");
    expect(logged[0] ?? "").toContain("errors.check.ts");
  });
});
