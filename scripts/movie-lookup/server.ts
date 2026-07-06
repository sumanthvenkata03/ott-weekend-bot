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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const path = url.pathname;

    // Unauthenticated health check (Render pings this; must stay open + 200).
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return void res.end("ok");
    }

    // ── Auth gate (all other routes) ──
    if (!passesAuth(req, res)) return;

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
      if (!seg[3]) return sendJson(res, 200, await movieDetail(id));
      if (seg[3] === "images") {
        const imdbId = url.searchParams.get("imdbId") ?? undefined;
        return sendJson(res, 200, await allMovieImages(id, imdbId));
      }
      if (seg[3] === "credits") return sendJson(res, 200, await fullCredits(id));
      if (seg[3] === "videos") {
        const title = url.searchParams.get("title") ?? undefined;
        const yr = Number.parseInt(url.searchParams.get("year") ?? "", 10);
        return sendJson(res, 200, await movieVideos(id, title, Number.isFinite(yr) ? yr : undefined));
      }
      if (seg[3] === "providers") {
        return sendJson(res, 200, await movieProviders(id, url.searchParams.get("country") ?? "IN"));
      }
      if (seg[3] === "wiki") {
        const title = (url.searchParams.get("title") ?? "").trim();
        if (!title) return sendJson(res, 400, { error: "title is required for wiki lookup" });
        const yr = Number.parseInt(url.searchParams.get("year") ?? "", 10);
        return sendJson(res, 200, await movieBackground(id, title, Number.isFinite(yr) ? yr : undefined));
      }
      return sendJson(res, 404, { error: `no route ${path}` });
    }
    if (seg[0] === "api" && seg[1] === "person" && seg[2]) {
      const id = intId(seg[2]);
      if (id === undefined) return sendJson(res, 400, { error: "person id must be an integer" });
      return sendJson(res, 200, await personDetail(id));
    }

    // ── Query-style API (kept for the search page + compatibility) ──
    if (path === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return sendJson(res, 400, { error: "q (movie name) is required" });
      const lr = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(lr) && lr > 0 ? Math.min(lr, 60) : DEFAULT_SEARCH_LIMIT;
      return sendJson(res, 200, await rankedSearch(q, limit));
    }
    if (path === "/api/movie") {
      const id = intId(url.searchParams.get("id") ?? undefined);
      if (id === undefined) return sendJson(res, 400, { error: "id (TMDb movie id) is required" });
      return sendJson(res, 200, await movieDetail(id));
    }
    if (path === "/api/images") {
      const id = intId(url.searchParams.get("id") ?? undefined);
      if (id === undefined) return sendJson(res, 400, { error: "id (TMDb movie id) is required" });
      const imdbId = url.searchParams.get("imdbId") ?? undefined;
      return sendJson(res, 200, await allMovieImages(id, imdbId));
    }
    if (path === "/api/download") {
      return void (await proxyDownload(url.searchParams.get("url") ?? "", res));
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
  if (authOn) {
    console.log(`   Auth: ENABLED ✓ (HTTP Basic — MOVIE_LOOKUP_USER/PASS)`);
  } else {
    console.warn(`   ⚠️  AUTH DISABLED — set MOVIE_LOOKUP_USER/MOVIE_LOOKUP_PASS to require a login (anyone who can reach this port can use it)`);
  }
  console.log(`   Stop with Ctrl+C\n`);
});
