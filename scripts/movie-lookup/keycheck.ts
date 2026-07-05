// scripts/movie-lookup/keycheck.ts
// Key-health diagnostic for the movie-lookup tool. Hits EACH real API source once
// with a fixed, well-known test target and reports per-source whether the key
// WORKS — so a missing/expired/wrong key reads FAIL/SKIPPED immediately instead
// of the tool silently returning empty.
//
// Run:  npx tsx scripts/movie-lookup/keycheck.ts
//
// READ-ONLY toward the system (no cache.sqlite writes, no job). It DOES make live
// API calls — that is the whole point (verifying keys). It deliberately makes its
// OWN instrumented calls (not the error-swallowing adapters) so it can tell a
// MISSING key (skipped) apart from a PRESENT-but-BROKEN key (fail + reason).
//
// Env vars (exact names, loaded from .env exactly like the server):
//   TMDB_API_KEY · OMDB_API_KEY · FANART_API_KEY · TVDB_API_KEY · YOUTUBE_API_KEY
// Keys are never printed (masked/omitted).

import "dotenv/config";
import { ofetch } from "ofetch";

export type Status = "OK" | "SKIPPED" | "FAIL";
export interface CheckResult { source: string; envVar: string; status: Status; detail: string; }

/** Turn an unknown thrown value into a short, human reason (no key leakage). */
export function describeError(e: unknown): string {
  const err = e as { status?: number; statusCode?: number; response?: { status?: number }; data?: { error?: unknown; status_message?: string }; message?: string; name?: string };
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  let msg = "";
  const d = err?.data;
  if (d && typeof d === "object") {
    const de = (d as { error?: unknown; status_message?: string }).error;
    if (typeof de === "string") msg = de;
    else if (de && typeof de === "object" && typeof (de as { message?: string }).message === "string") msg = (de as { message: string }).message;
    else if (typeof (d as { status_message?: string }).status_message === "string") msg = (d as { status_message: string }).status_message;
  }
  if (!msg && typeof err?.message === "string") msg = err.message;
  const statusText =
    status === 401 ? "401 unauthorized (bad/expired key)" :
    status === 403 ? "403 forbidden (quota/permission)" :
    status === 400 ? "400 bad request (invalid key?)" :
    status === 404 ? "404 not found" :
    status ? `HTTP ${status}` : "";
  const parts = [statusText, msg].filter(Boolean);
  return parts.length ? parts.join(" — ").slice(0, 160) : "network/unknown error";
}

/**
 * Core status mapping (pure-ish, exported for offline tests):
 *  - env var unset            -> SKIPPED (missing is not a failure)
 *  - probe resolves           -> OK   (with evidence)
 *  - probe throws             -> FAIL (with a short reason)
 * `probe` receives the key and should throw on ANY problem (bad status, bad body).
 */
export async function runCheck(
  source: string,
  envVar: string,
  probe: (key: string) => Promise<string>,
  env: NodeJS.ProcessEnv = process.env
): Promise<CheckResult> {
  const key = env[envVar];
  if (!key) return { source, envVar, status: "SKIPPED", detail: `no ${envVar} set` };
  try {
    const evidence = await probe(key);
    return { source, envVar, status: "OK", detail: `key valid — ${evidence}` };
  } catch (e) {
    return { source, envVar, status: "FAIL", detail: `${envVar} set but call failed: ${describeError(e)}` };
  }
}

const OPTS = { retry: 0 as const, timeout: 12000 };

// ── Per-source live probes (fixed, well-known targets) ───────────────────────
async function probeTmdb(key: string): Promise<string> {
  const res = await ofetch<{ title?: string }>("https://api.themoviedb.org/3/movie/693134", { query: { api_key: key }, ...OPTS });
  if (!res?.title) throw new Error("no title in TMDb response");
  return `got "${res.title}"`;
}

async function probeOmdb(key: string): Promise<string> {
  // OMDb returns HTTP 200 with { Response:"False", Error:"Invalid API key!" } for a
  // bad key — so we MUST inspect the body, not just the HTTP status.
  const res = await ofetch<{ Response?: string; Title?: string; Error?: string }>("https://www.omdbapi.com/", { query: { apikey: key, i: "tt0111161" }, ...OPTS });
  if (res?.Response !== "True") throw new Error(res?.Error || "OMDb Response=False");
  return `got "${res.Title}"`;
}

async function probeFanart(key: string): Promise<string> {
  const res = await ofetch<Record<string, unknown>>("https://webservice.fanart.tv/v3/movies/693134", { query: { api_key: key }, ...OPTS });
  // A bad key returns 401 (ofetch throws). A valid key returns art arrays.
  const count = ["movieposter", "moviebackground", "moviethumb", "moviebanner", "hdmovielogo", "movielogo"]
    .reduce((n, k) => n + (Array.isArray(res[k]) ? (res[k] as unknown[]).length : 0), 0);
  return `${count} artworks`;
}

async function probeTvdb(key: string): Promise<string> {
  // 1) token exchange (the failure-prone step)
  let token: string | undefined;
  try {
    const login = await ofetch<{ data?: { token?: string } }>("https://api4.thetvdb.com/v4/login", {
      method: "POST", body: { apikey: key }, headers: { Accept: "application/json" }, ...OPTS,
    });
    token = login?.data?.token;
  } catch (e) {
    throw new Error(`login/token exchange failed: ${describeError(e)}`);
  }
  if (!token) throw new Error("login/token exchange returned no token");
  // 2) one authenticated fetch to confirm the token is actually accepted
  const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const list = await ofetch<{ data?: unknown[] }>("https://api4.thetvdb.com/v4/movies", { query: { page: "0" }, headers: auth, ...OPTS });
  const n = Array.isArray(list?.data) ? list.data.length : 0;
  return `token acquired, authed fetch ok (${n} movies)`;
}

async function probeYoutube(key: string): Promise<string> {
  const res = await ofetch<{ items?: unknown[] }>("https://www.googleapis.com/youtube/v3/search", {
    query: { part: "snippet", type: "video", maxResults: "3", q: "Inception trailer", key }, ...OPTS,
  });
  const n = Array.isArray(res?.items) ? res.items.length : 0;
  if (n === 0) throw new Error("no items returned");
  return `${n} results`;
}

// ── Keyless person-image sources — a reachability ping (no key to verify) ─────
const WIKI_UA = "TBSI-movie-lookup/1.0 (internal reference tool)";
async function probeWikidata(): Promise<string> {
  const res = await ofetch<{ entities?: Record<string, unknown> }>("https://www.wikidata.org/w/api.php", {
    query: { action: "wbgetentities", ids: "Q42", props: "labels", format: "json", origin: "*" }, headers: { "User-Agent": WIKI_UA }, ...OPTS,
  });
  if (!res?.entities?.["Q42"]) throw new Error("no entity");
  return "reachable (Q42)";
}
async function probeCommons(): Promise<string> {
  const res = await ofetch<{ query?: { pages?: Record<string, { imageinfo?: { url?: string }[] }> } }>("https://commons.wikimedia.org/w/api.php", {
    query: { action: "query", titles: "File:Example.jpg", prop: "imageinfo", iiprop: "url", format: "json", origin: "*" }, headers: { "User-Agent": WIKI_UA }, ...OPTS,
  });
  if (!Object.values(res?.query?.pages ?? {}).some((p) => p.imageinfo?.[0]?.url)) throw new Error("no imageinfo");
  return "imageinfo reachable";
}
async function probeWikipedia(): Promise<string> {
  const res = await ofetch<{ extract?: string }>("https://en.wikipedia.org/api/rest_v1/page/summary/Film", { headers: { "User-Agent": WIKI_UA, Accept: "application/json" }, ...OPTS });
  if (!res?.extract) throw new Error("no summary");
  return "summary reachable";
}

export const CHECKS: { source: string; envVar: string; probe: (key: string) => Promise<string> }[] = [
  { source: "TMDb",           envVar: "TMDB_API_KEY",    probe: probeTmdb },
  { source: "OMDb",           envVar: "OMDB_API_KEY",    probe: probeOmdb },
  { source: "Fanart.tv",      envVar: "FANART_API_KEY",  probe: probeFanart },
  { source: "TheTVDB",        envVar: "TVDB_API_KEY",    probe: probeTvdb },
  { source: "YouTube Data",   envVar: "YOUTUBE_API_KEY", probe: probeYoutube },
];

// Keyless person-image sources — reachability only (no key to verify). A failure
// here is a network/service issue, not a key problem, so it does NOT gate the
// exit code (which stays about SET keys).
export const KEYLESS_CHECKS: { source: string; probe: () => Promise<string> }[] = [
  { source: "Wikidata",       probe: probeWikidata },
  { source: "Commons",        probe: probeCommons },
  { source: "Wikipedia",      probe: probeWikipedia },
];

/** Reachability check for a keyless source: OK on success, FAIL on any error. */
export async function runReachability(source: string, probe: () => Promise<string>): Promise<CheckResult> {
  try {
    return { source, envVar: "(keyless)", status: "OK", detail: `reachable — ${await probe()}` };
  } catch (e) {
    return { source, envVar: "(keyless)", status: "FAIL", detail: `unreachable: ${describeError(e)}` };
  }
}

const ICON: Record<Status, string> = { OK: "✅ OK     ", SKIPPED: "⏭️ SKIPPED", FAIL: "❌ FAIL   " };

async function main(): Promise<void> {
  console.log("\n=== TBSI movie-lookup · key health check (live) ===\n");
  console.log("  — Keyed API sources —");
  const keyed: CheckResult[] = [];
  for (const c of CHECKS) {
    const r = await runCheck(c.source, c.envVar, c.probe);
    keyed.push(r);
    console.log(`  ${ICON[r.status]} ${r.source.padEnd(13)} — ${r.detail}`);
  }
  console.log("\n  — Keyless person-image sources (reachability) —");
  const keyless: CheckResult[] = [];
  for (const c of KEYLESS_CHECKS) {
    const r = await runReachability(c.source, c.probe);
    keyless.push(r);
    console.log(`  ${ICON[r.status]} ${r.source.padEnd(13)} — ${r.detail}`);
  }

  const all = [...keyed, ...keyless];
  const ok = all.filter((r) => r.status === "OK").length;
  const skipped = all.filter((r) => r.status === "SKIPPED").length;
  const fail = all.filter((r) => r.status === "FAIL").length;
  const keyedFail = keyed.filter((r) => r.status === "FAIL").length;
  console.log(`\n=== SUMMARY: ${ok} OK · ${skipped} SKIPPED · ${fail} FAIL ===`);
  if (keyedFail > 0) console.log("  ❌ one or more SET keys failed — fix the key(s) above.");
  else if (fail > 0) console.log("  ⚠️ all keys OK; a keyless source is momentarily unreachable (not a key problem).");
  else if (skipped > 0) console.log("  ⏭️ all present keys work; skipped sources just have no key set.");
  else console.log("  ✅ all sources reachable and all keys working.");
  console.log("");
  // Health gate: non-zero ONLY if a SET key failed. Missing keys = skipped;
  // keyless reachability blips don't gate.
  process.exit(keyedFail > 0 ? 1 : 0);
}

// Only auto-run when invoked directly (so tests can import without side effects).
const invokedDirectly = process.argv[1] ? process.argv[1].replace(/\\/g, "/").endsWith("keycheck.ts") : false;
if (invokedDirectly) {
  main().catch((e) => { console.error("keycheck crashed:", e); process.exit(2); });
}
