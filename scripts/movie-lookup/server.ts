// scripts/movie-lookup/server.ts
// Standalone internal "movie lookup" server. Localhost only. Part of the tool.
// Run it with:
//
//   npx tsx scripts/movie-lookup/server.ts
//
// then open http://127.0.0.1:5178 . Searches + detail lookups make live (free)
// TMDb/OMDb reads; nothing is posted, no job runs, no billed LLM call is made.
//
// Uses node:http (repo has no HTTP-server dependency, so per the brief we add
// none). dotenv/config (an existing repo dep) loads the SAME .env the pipeline
// uses so TMDB_API_KEY / OMDB_API_KEY are read by name, never hardcoded.

import "dotenv/config";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  movieDetail,
  allMovieImages,
  movieVideos,
  movieBackground,
  fullCredits,
  personDetail,
  isAllowedImageUrl,
} from "./lookup.js";
import { rankedSearch, DEFAULT_SEARCH_LIMIT } from "./search.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.MOVIE_LOOKUP_PORT ?? "5178", 10);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function errBody(e: unknown): { error: string } {
  return { error: e instanceof Error ? e.message : String(e) };
}

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/movie.html": "movie.html",
};

async function serveStatic(file: string, res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(join(HERE, "public", file));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    sendJson(res, 500, errBody(e));
  }
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

    if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });

    // ── Static pages ──
    if (STATIC[path]) return void (await serveStatic(STATIC[path]!, res));

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
      if (seg[3] === "videos") return sendJson(res, 200, await movieVideos(id));
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

    sendJson(res, 404, { error: `no route ${path}` });
  } catch (e) {
    sendJson(res, 500, errBody(e));
  }
});

server.listen(PORT, HOST, () => {
  const tmdb = !!process.env.TMDB_API_KEY;
  const omdb = !!process.env.OMDB_API_KEY;
  console.log(`\n🎬 TBSI Movie Lookup — internal, localhost only`);
  console.log(`   ▶ http://${HOST}:${PORT}`);
  console.log(`   TMDB_API_KEY: ${tmdb ? "set ✓" : "MISSING ✗  (lookups will 500 until set in .env)"}`);
  console.log(`   OMDB_API_KEY: ${omdb ? "set ✓ (OMDb poster + IMDb/RT/Metacritic)" : "unset (OMDb source skipped — TMDb only)"}`);
  console.log(`   Stop with Ctrl+C\n`);
});
