// scripts/movie-lookup/errors.ts
// PUBLIC ERROR BODIES + secret registration for the movie-lookup server.
//
// THE LEAK THIS CLOSES. server.ts used to answer a failed request with
// `{ error: e.message }`. This process holds eight secrets, and three of its
// upstreams carry their key in the REQUEST URL — sources.ts tmdbGet sets
// `api_key`, omdbGet sets `apikey`, the Fanart adapter sets `api_key`. ofetch
// throws a FetchError whose .message is `[GET] "<full resolved URL>": <status>`.
// So one expired TMDb key turned every 500 into a response body containing that
// key, served to whoever triggered it — on a PUBLIC Render deployment. Basic
// Auth does not help: the failure is reachable by any authenticated user, and
// /healthz-adjacent misconfiguration makes it reachable before that.
//
// THE RULE, now enforced in one place: a raw error message NEVER reaches a
// response body. The caller gets a fixed generic string plus a short random
// INCIDENT ID; the real error — stack included — goes to the server log only,
// through redactSecrets. The operator correlates the two by the id.
//
// Factored out of server.ts rather than inlined, matching this folder's existing
// shape (auth.ts, ratelimit.ts): a pure module with no node:http and no network
// in its import graph, so the tool checks can exercise it directly.
//
// DEPLOY FOOTPRINT: the only cross-boundary import is src/shared/redact.ts,
// which Render already clones (render.yaml deploys the whole repo and runs one
// file from it). redact.ts imports NOTHING — no config, no logger, no package —
// so this adds zero modules to the build and zero entries to package.json.

import { randomBytes } from "node:crypto";
import { registerSecrets, redactSecrets } from "../../src/shared/redact.js";

/**
 * Every secret this process holds. Read from process.env by NAME, because the
 * pipeline's ConfigSchema does not model FANART_API_KEY / TVDB_API_KEY /
 * MOVIE_LOOKUP_* / DATABASE_URL — those exist only here and on Render. Mirrors
 * the envVars block in render.yaml exactly.
 */
export const LOOKUP_SECRET_ENV = [
  "TMDB_API_KEY",
  "OMDB_API_KEY",
  "FANART_API_KEY",
  "TVDB_API_KEY",
  "YOUTUBE_API_KEY",
  "MOVIE_LOOKUP_USER",
  "MOVIE_LOOKUP_PASS",
  // The Render Postgres connection string embeds a PASSWORD. A pg failure
  // surfaces it in the error message, which is why it belongs here and not just
  // in the "config" bucket.
  "DATABASE_URL",
] as const;

/**
 * Hand this process's secrets to the shared redaction registry. Call ONCE, at
 * module init in server.ts, before any request can be served or any startup
 * banner logged. Values that are unset or under the registry's minimum length
 * are skipped by registerSecrets itself.
 */
export function registerLookupSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const pairs: Record<string, string | undefined> = {};
  for (const name of LOOKUP_SECRET_ENV) pairs[name] = env[name];
  registerSecrets(pairs);
}

/**
 * What a failed request is told. Deliberately says nothing about WHAT failed:
 * not the upstream, not the status, not the host. Everything diagnostic lives in
 * the log line under the same incident id.
 */
export const GENERIC_ERROR_MESSAGE =
  "internal error — quote the incident id when reporting this";

export interface PublicError {
  error: string;
  incident: string;
}

/** 8 hex chars — short enough to read over the phone, wide enough not to collide
 *  within a log file. node:crypto only; no dependency added. */
export function newIncidentId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Build the PUBLIC error body and write the REAL error to the server log.
 *
 * Returns only { error, incident }. The stack is logged (scrubbed) rather than
 * just the message, so this is strictly MORE diagnosable than the old behaviour
 * for the operator — and strictly less for everyone else.
 *
 * `where` names the failing surface (e.g. "static", "request") so a log line is
 * useful even before the id is looked up.
 */
export function errBody(e: unknown, where?: string): PublicError {
  const incident = newIncidentId();
  const real = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
  console.error(`[incident ${incident}]${where ? ` [${where}]` : ""} ${redactSecrets(real)}`);
  return { error: GENERIC_ERROR_MESSAGE, incident };
}

/**
 * Scrub a string that is about to be written to the server's own log (not to a
 * response). Re-exported so server.ts has one import for its whole error
 * surface — the watchlist bootstrap warning uses it, since a bad DATABASE_URL
 * puts the connection string (and its password) straight into that message.
 */
export { redactSecrets };
