// scripts/movie-lookup/server.ts
// Standalone internal "movie lookup" server. Runs locally AND on Render.
// Run it with:
//
//   npx tsx scripts/movie-lookup/server.ts
//
// then open http://127.0.0.1:5178 . Searches + detail lookups make live (free)
// TMDb/OMDb reads; nothing is posted, no job runs, no billed LLM call is made.
//
// Deployment (Render): binds process.env.PORT on 0.0.0.0 automatically, and is
// gated by HTTP Basic Auth when MOVIE_LOOKUP_USER + MOVIE_LOOKUP_PASS are set.
// A PWA (manifest + service worker) makes it installable to a phone home screen.
//
// Uses node:http (repo has no HTTP-server dependency, so per the brief we add
// none). dotenv/config (an existing repo dep) loads the SAME .env the pipeline
// uses locally so TMDB_API_KEY / OMDB_API_KEY are read by name, never hardcoded;
// on Render there is no .env and the keys come straight from process.env.

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  movieDetail,
  allMovieImages,
  movieVideos,
  movieBackground,
  movieProviders,
  fullCredits,
  personDetail,
  isAllowedImageUrl,
} from "./lookup.js";
import { rankedSearch, DEFAULT_SEARCH_LIMIT } from "./search.js";
import { authConfigFromEnv, authEnabled, checkBasicAuth, wwwAuthenticateHeader } from "./auth.js";
import { TtlCache } from "./cache.js";
import { movieReleases } from "./releases.js";
import { createWatchlistBackend, isWatchType, MemoryWatchlist, type WatchlistBackend, type Queryable } from "./watchlist.js";
import { createLimiter } from "./ratelimit.js";
import pg from "pg";

// In-memory TTL+LRU cache for API responses (tool-only; NOT cache.sqlite). Makes
// repeat lookups of the same query/id instant within the TTL window. Live calls
// still happen on a miss. TTL configurable via MOVIE_LOOKUP_CACHE_TTL_MS.
const CACHE_TTL_MS = Number.parseInt(process.env.MOVIE_LOOKUP_CACHE_TTL_MS ?? "", 10);
const apiCache = new TtlCache({ ttlMs: Number.isFinite(CACHE_TTL_MS) && CACHE_TTL_MS > 0 ? CACHE_TTL_MS : undefined });

// ── Per-IP rate limiting for /api/* (token bucket; see ratelimit.ts). Protects the
// live TMDb/OMDb-backed endpoints from a hot loop or a scraper without ever touching
// /healthz (UptimeRobot pings it) or static assets. Knobs via env, sane defaults. ──
const RL_PER_MIN = Number.parseInt(process.env.MOVIE_LOOKUP_RATE_PER_MIN ?? "", 10);
const RL_BURST = Number.parseInt(process.env.MOVIE_LOOKUP_RATE_BURST ?? "", 10);
const RL_MAX_IPS = Number.parseInt(process.env.MOVIE_LOOKUP_RATE_MAX_IPS ?? "", 10);
const RATE_PER_MIN = Number.isFinite(RL_PER_MIN) && RL_PER_MIN > 0 ? RL_PER_MIN : 120;
const RATE_BURST = Number.isFinite(RL_BURST) && RL_BURST > 0 ? RL_BURST : 40;
const RATE_MAX_IPS = Number.isFinite(RL_MAX_IPS) && RL_MAX_IPS > 0 ? RL_MAX_IPS : 5000;
const RETRY_AFTER_S = String(Math.max(1, Math.ceil(60 / RATE_PER_MIN)));
const rateLimiter = createLimiter({ perMin: RATE_PER_MIN, burst: RATE_BURST, maxIps: RATE_MAX_IPS });
// Client IP: first hop of X-Forwarded-For (Render sets it) else the socket peer.
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

// Persistent watchlist store. Postgres when DATABASE_URL is set (survives
// redeploys, syncs across devices); in-memory fallback otherwise. `pg` is only
// touched here (kept out of watchlist.ts so its tests need no real driver).
function makePgClient(url: string): Queryable {
  // Render's INTERNAL connection string needs no SSL; external URLs (or a forced
  // PGSSL=1) do. Enable SSL only when asked so internal connections just work.
  const needsSsl = /sslmode=require/i.test(url) || process.env.PGSSL === "1";
  const pool = new pg.Pool({ connectionString: url, max: 3, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
  return { query: (text, params) => pool.query(text, params) };
}
let watchlist: WatchlistBackend = createWatchlistBackend(process.env, makePgClient);

/** Read a request body (bounded) — used by the watchlist POST route. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Render assigns the port via process.env.PORT and expects a bind on 0.0.0.0.
// Locally there is no PORT, so we stay on 127.0.0.1:5178 (MOVIE_LOOKUP_PORT can
// override the local port).
const PORT = Number.parseInt(process.env.PORT ?? process.env.MOVIE_LOOKUP_PORT ?? "5178", 10);
const HOST = process.env.PORT ? "0.0.0.0" : "127.0.0.1";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function errBody(e: unknown): { error: string } {
  return { error: e instanceof Error ? e.message : String(e) };
}

// Static app-shell assets served from ./public. Each maps a URL path to a file
// plus its content type and cache policy (the service-worker script + manifest
// must not be long-cached so new deploys propagate — see sw.js).
interface Asset { file: string; type: string; cache: string; }
const HTML_CACHE = "no-cache";
const STATIC: Record<string, Asset> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8", cache: HTML_CACHE },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8", cache: HTML_CACHE },
  "/movie.html": { file: "movie.html", type: "text/html; charset=utf-8", cache: HTML_CACHE },
  "/person.html": { file: "person.html", type: "text/html; charset=utf-8", cache: HTML_CACHE },
  "/compare.html": { file: "compare.html", type: "text/html; charset=utf-8", cache: HTML_CACHE },
  "/watchlist.html": { file: "watchlist.html", type: "text/html; charset=utf-8", cache: HTML_CACHE },
  "/releases.html": { file: "releases.html", type: "text/html; charset=utf-8", cache: HTML_CACHE },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8", cache: "no-cache" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/icon-192.png": { file: "icon-192.png", type: "image/png", cache: "public, max-age=86400" },
  "/icon-512.png": { file: "icon-512.png", type: "image/png", cache: "public, max-age=86400" },
};

async function serveStatic(asset: Asset, res: ServerResponse): Promise<void> {
  try {
    const body = await readFile(join(HERE, "public", asset.file));
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": asset.cache });
    res.end(body);
  } catch (e) {
    sendJson(res, 500, errBody(e));
  }
}

// ── HTTP Basic Auth gate ──────────────────────────────────────────────────────
// Returns true when the request may proceed. When auth is enabled and the creds
// are missing/wrong it writes a 401 (with WWW-Authenticate so the browser shows
// a native login prompt) and returns false. Open (returns true) when unconfigured.
function passesAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const cfg = authConfigFromEnv();
  if (!authEnabled(cfg)) return true;
  if (checkBasicAuth(req.headers.authorization, cfg)) return true;
  res.writeHead(401, {
    "WWW-Authenticate": wwwAuthenticateHeader(),
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("401 Unauthorized — TBSI Movie Lookup");
  return false;
}

// Stream a whitelisted image host through our origin with an attachment header so
// the browser downloads full-res reliably (cross-origin <a download> can't force
// it). SSRF-guarded to TMDb + Amazon/IMDb image CDNs (see isAllowedImageUrl).
async function proxyDownload(url: string, res: ServerResponse): Promise<void> {
  if (!isAllowedImageUrl(url)) {
    sendJson(res, 400, { error: "url must be a whitelisted image host (tmdb / amazon image CDN)" });
    return;
  }
  const upstream = await fetch(url);
  if (!upstream.ok) {
    sendJson(res, 502, { error: `upstream ${upstream.status}` });
    return;
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const filename = (url.split("?")[0]?.split("/").pop()) || "image.jpg";
  res.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": String(buf.length),
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

/** Parse an int id from a path segment; NaN ⇒ undefined. */
function intId(seg: string | undefined): number | undefined {
  if (!seg) return undefined;
  const n = Number.parseInt(seg, 10);
  return Number.isFinite(n) ? n : undefined;
}

// Per-device watchlist scoping. The client sends a stable id (localStorage) in the
// `X-TBSI-Device` header; we accept only a conservative charset/length and otherwise
// fall back to the shared "legacy" bucket (also where all pre-device rows live).
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
function deviceIdFromReq(req: IncomingMessage): string {
  const raw = req.headers["x-tbsi-device"];
  const val = Array.isArray(raw) ? raw[0] : raw;
  return val && DEVICE_ID_RE.test(val) ? val : "legacy";
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const path = url.pathname;

    // Unauthenticated health check (Render pings this; must stay open + 200).
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return void res.end("ok");
    }

    // ── Rate limit /api/* only (never /healthz above; never static assets / HTML
    // navigations below — those don't start with "/api/"). Over the limit → 429. ──
    if (path.startsWith("/api/") && !rateLimiter.take(clientIp(req))) {
      res.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": RETRY_AFTER_S,
      });
      return void res.end(JSON.stringify({ error: "rate limit exceeded — slow down and retry shortly" }));
    }

    // ── Auth gate (all other routes) ──
    if (!passesAuth(req, res)) return;

    // ── Watchlist API (GET list · POST add · DELETE remove) — handled before the
    // GET-only guard since it accepts writes. Single shared list, no users. ──
    const wseg = path.split("/").filter(Boolean); // ["api","watchlist",type,id]
    if (wseg[0] === "api" && wseg[1] === "watchlist") {
      const deviceId = deviceIdFromReq(req); // scopes every op to this device (else "legacy")
      if (!wseg[2]) {
        if (req.method === "GET") return sendJson(res, 200, { items: await watchlist.list(deviceId), store: watchlist.kind });
        if (req.method === "POST") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
          const type = body.type;
          const tmdbId = intId(String(body.id ?? body.tmdbId ?? ""));
          const title = String(body.title ?? "").trim();
          if (!isWatchType(type) || tmdbId === undefined || !title) return sendJson(res, 400, { error: "type (film|person), id, title are required" });
          const note = body.note ? String(body.note) : undefined;
          const item = await watchlist.add({ type, tmdbId, title, note }, deviceId);
          return sendJson(res, 200, { item, store: watchlist.kind });
        }
        return sendJson(res, 405, { error: "GET or POST only" });
      }
      if (wseg[2] && wseg[3]) { // /api/watchlist/:type/:id
        if (req.method === "DELETE") {
          const type = wseg[2];
          const tmdbId = intId(wseg[3]);
          if (!isWatchType(type) || tmdbId === undefined) return sendJson(res, 400, { error: "bad type/id" });
          await watchlist.remove(type, tmdbId, deviceId);
          return sendJson(res, 200, { ok: true, store: watchlist.kind });
        }
        return sendJson(res, 405, { error: "DELETE only" });
      }
    }

    if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });

    // ── Static pages + PWA assets (manifest, service worker, icons) ──
    // Normalise the site root and any trailing slash so "", "/" and e.g.
    // "/movie.html/" all resolve to their asset. (A host/proxy can present the
    // root differently than a local run; the served file is read via an ABSOLUTE
    // path anchored to this file — see HERE — so cwd never matters.)
    const staticKey = path === "" ? "/" : path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    if (STATIC[staticKey]) return void (await serveStatic(STATIC[staticKey]!, res));

    // ── Path-style detail API: /api/movie/:id[/images|/credits], /api/person/:id ──
    const seg = path.split("/").filter(Boolean); // e.g. ["api","movie","801688","images"]
    if (seg[0] === "api" && seg[1] === "movie" && seg[2]) {
      const id = intId(seg[2]);
      if (id === undefined) return sendJson(res, 400, { error: "movie id must be an integer" });
      if (!seg[3]) return sendJson(res, 200, await apiCache.wrap(`movie:${id}`, () => movieDetail(id)));
      if (seg[3] === "images") {
        const imdbId = url.searchParams.get("imdbId") ?? undefined;
        return sendJson(res, 200, await apiCache.wrap(`images:${id}:${imdbId ?? ""}`, () => allMovieImages(id, imdbId)));
      }
      if (seg[3] === "credits") return sendJson(res, 200, await apiCache.wrap(`credits:${id}`, () => fullCredits(id)));
      if (seg[3] === "videos") {
        const title = url.searchParams.get("title") ?? undefined;
        const yr = Number.parseInt(url.searchParams.get("year") ?? "", 10);
        const year = Number.isFinite(yr) ? yr : undefined;
        return sendJson(res, 200, await apiCache.wrap(`videos:${id}:${title ?? ""}:${year ?? ""}`, () => movieVideos(id, title, year)));
      }
      if (seg[3] === "providers") {
        const country = url.searchParams.get("country") ?? "IN";
        return sendJson(res, 200, await apiCache.wrap(`providers:${id}:${country}`, () => movieProviders(id, country)));
      }
      if (seg[3] === "wiki") {
        const title = (url.searchParams.get("title") ?? "").trim();
        if (!title) return sendJson(res, 400, { error: "title is required for wiki lookup" });
        const yr = Number.parseInt(url.searchParams.get("year") ?? "", 10);
        const year = Number.isFinite(yr) ? yr : undefined;
        return sendJson(res, 200, await apiCache.wrap(`wiki:${id}:${title}:${year ?? ""}`, () => movieBackground(id, title, year)));
      }
      return sendJson(res, 404, { error: `no route ${path}` });
    }
    if (seg[0] === "api" && seg[1] === "person" && seg[2]) {
      const id = intId(seg[2]);
      if (id === undefined) return sendJson(res, 400, { error: "person id must be an integer" });
      return sendJson(res, 200, await apiCache.wrap(`person:${id}`, () => personDetail(id)));
    }

    // ── Query-style API (kept for the search page + compatibility) ──
    if (path === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return sendJson(res, 400, { error: "q (movie name) is required" });
      const lr = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(lr) && lr > 0 ? Math.min(lr, 60) : DEFAULT_SEARCH_LIMIT;
      return sendJson(res, 200, await apiCache.wrap(`search:${limit}:${q}`, () => rankedSearch(q, limit)));
    }
    if (path === "/api/movie") {
      const id = intId(url.searchParams.get("id") ?? undefined);
      if (id === undefined) return sendJson(res, 400, { error: "id (TMDb movie id) is required" });
      return sendJson(res, 200, await apiCache.wrap(`movie:${id}`, () => movieDetail(id)));
    }
    if (path === "/api/images") {
      const id = intId(url.searchParams.get("id") ?? undefined);
      if (id === undefined) return sendJson(res, 400, { error: "id (TMDb movie id) is required" });
      const imdbId = url.searchParams.get("imdbId") ?? undefined;
      return sendJson(res, 200, await apiCache.wrap(`images:${id}:${imdbId ?? ""}`, () => allMovieImages(id, imdbId)));
    }
    if (path === "/api/download") {
      return void (await proxyDownload(url.searchParams.get("url") ?? "", res));
    }
    // ── Upcoming / Now-playing feeds (default region India) ──
    if (path === "/api/releases/now-playing" || path === "/api/releases/upcoming") {
      const region = (url.searchParams.get("region") ?? "IN").toUpperCase();
      const kind = path.endsWith("upcoming") ? "upcoming" : "now_playing";
      return sendJson(res, 200, await apiCache.wrap(`releases:${kind}:${region}`, () => movieReleases(kind, region)));
    }

    // ── App-shell fallback ──
    // A browser navigation (Accept: text/html) that matched no static asset and
    // no API route serves the search page instead of a bare "Not Found" — so the
    // site root, the installed home-screen launch, and any deep link always land
    // on the app regardless of how the host presents the path. API routes keep
    // their JSON 404 (this only catches HTML navigations, never /api/*).
    if (!path.startsWith("/api/") && (req.headers.accept ?? "").includes("text/html")) {
      return void (await serveStatic(STATIC["/index.html"]!, res));
    }

    sendJson(res, 404, { error: `no route ${path}` });
  } catch (e) {
    sendJson(res, 500, errBody(e));
  }
});

server.listen(PORT, HOST, () => {
  const tmdb = !!process.env.TMDB_API_KEY;
  const omdb = !!process.env.OMDB_API_KEY;
  const authOn = authEnabled(authConfigFromEnv());
  const shownHost = HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  console.log(`\n🎬 TBSI Movie Lookup`);
  console.log(`   ▶ http://${shownHost}:${PORT}`);
  console.log(`   TMDB_API_KEY: ${tmdb ? "set ✓" : "MISSING ✗  (lookups will 500 until set)"}`);
  console.log(`   OMDB_API_KEY: ${omdb ? "set ✓ (OMDb poster + IMDb/RT/Metacritic)" : "unset (OMDb source skipped — TMDb only)"}`);
  const ttlMs = Number.isFinite(CACHE_TTL_MS) && CACHE_TTL_MS > 0 ? CACHE_TTL_MS : 20 * 60 * 1000;
  const ttlHuman = ttlMs >= 60000 ? `${Math.round(ttlMs / 60000)}m` : `${Math.round(ttlMs / 1000)}s`;
  console.log(`   Cache: in-memory TTL ${ttlHuman} (MOVIE_LOOKUP_CACHE_TTL_MS)`);
  console.log(`   Rate limit: ${RATE_PER_MIN}/min per IP · burst ${RATE_BURST} · ≤${RATE_MAX_IPS} IPs (/api/* only)`);
  // Bring up the watchlist store; if the DB init fails, fall back to memory so
  // the server never crashes over a bad/absent DATABASE_URL.
  void (async () => {
    try {
      await watchlist.init();
      if (watchlist.kind === "postgres") console.log(`   Watchlist: PostgreSQL ✓ (persistent, cross-device — DATABASE_URL)`);
      else console.warn(`   ⚠️  Watchlist: in-memory (NOT persisted) — set DATABASE_URL to a Render PostgreSQL to sync across devices & survive redeploys`);
    } catch (e) {
      console.warn(`   ⚠️  Watchlist DB init failed — using in-memory fallback: ${(e as Error).message}`);
      watchlist = new MemoryWatchlist();
      await watchlist.init();
    }
  })();
  if (authOn) {
    console.log(`   Auth: ENABLED ✓ (HTTP Basic — MOVIE_LOOKUP_USER/PASS)`);
  } else {
    console.warn(`   ⚠️  AUTH DISABLED — set MOVIE_LOOKUP_USER/MOVIE_LOOKUP_PASS to require a login (anyone who can reach this port can use it)`);
  }
  console.log(`   Stop with Ctrl+C\n`);
});
