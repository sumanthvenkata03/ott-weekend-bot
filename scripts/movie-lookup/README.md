# TBSI Movie Lookup (internal, localhost only)

A small standalone tool: type a movie name, get its full details + a gallery of
every official poster & backdrop TMDb offers (click to view full-size / download).

For internal reference only. Nothing is posted, no job runs, no billed LLM call
is made. It reuses the pipeline's existing TMDb resolution code read-only.

## Why it lives in `scripts/` (not `tools/`)

`tsconfig.json` has `rootDir: "src"` and no `include`, so **any** `.ts` file
outside `src/` trips `TS6059 (not under rootDir)` and inflates the `tsc`
baseline. `scripts/` is the repo's already-excluded home for offline runners
(see the tsconfig `exclude`), so building here keeps `tsc` at its exact baseline
without editing any existing file.

## Run

```bash
npx tsx scripts/movie-lookup/server.ts
```

Then open: **http://127.0.0.1:5178**

- Requires `TMDB_API_KEY` in `.env` (the same var the pipeline uses; read by
  name, never hardcoded). The server prints whether it's set on startup.
- Change the port with `MOVIE_LOOKUP_PORT=5200 npx tsx scripts/movie-lookup/server.ts`.
- Stop with `Ctrl+C`.

## Pages

| Page | Purpose |
|---|---|
| `GET /` | Search page with **fast auto-suggest** (debounced live dropdown, in-memory cache, stale-request cancellation, ↑↓/Enter keyboard nav). Click a suggestion → detail; Enter → full ranked results grid. |
| `GET /movie.html?id={tmdbId}` | Full detail page: all fields, **full image gallery** (posters + backdrops, view + full-res download), **Videos/Trailers** (YouTube), **Wikipedia background** (summary + link), full clickable cast + crew, person modal with their own gallery, and a combined **raw-JSON** view (movie · credits · omdb · images · videos · wiki). |

## Search — Google-style (search.ts)

Type any words in any order. `/api/search`:
1. **Tokenizes** the query; **language words** (telugu, tamil, hindi, …) and a
   **4-digit year** are pulled out as SOFT signals — they BOOST matching results,
   they never exclude anything. The remaining words are the title query.
2. **Order-independent**: title tokens are sorted before querying and scoring is
   fully set-based, so `telugu boss` and `boss telugu` return byte-identical sets.
3. **Broadens recall**: TMDb `/search/multi` (movies + series), combined query +
   per-token merge/dedupe. When a language/year signal is present it pages deeper
   (TMDb `/search` has no content-language filter, so a low-popularity match like a
   Telugu "Boss" sits on page ~10) so the boost has candidates to lift.
4. **Ranks** best-first: token presence (whole-word > substring) + same-word-set
   exact bonus + language/year boost + popularity/votes tiebreakers.
5. **Caps** to top ~30 (`&limit=` up to 60). Recall depth tunable via
   `MOVIE_LOOKUP_DEEP_PAGES` (default 10) / `MOVIE_LOOKUP_PLAIN_PAGES` (default 2).

All search calls are **uncached** (no `cache.sqlite` writes). Series are included
and labelled; series have no detail page (detail is movie-only).

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/search?q={words}[&limit=N]` | Google-style tokenized/ranked search (movies + series), order-independent |
| `GET /api/movie/:id` | Full detail incl. full cast + crew, ratings, and `rawData` (complete source payloads) |
| `GET /api/movie/:id/images[?imdbId=tt…]` | ALL posters + backdrops aggregated across every registered image source, deduped, full-res |
| `GET /api/movie/:id/credits` | Full cast + crew (name, role/character, department, person id, profile photo) |
| `GET /api/movie/:id/videos` | Trailers/teasers/clips aggregated across sources (TMDb → YouTube), deduped, sorted official-trailer-first |
| `GET /api/movie/:id/wiki?title=…&year=…` | Wikipedia background: article summary/extract + canonical link, confidence-guarded (no wrong-article guessing) |
| `GET /api/person/:id` | Person detail + FULL image gallery (profile + all images) aggregated across sources |
| `GET /api/download?url={imageUrl}` | Streams an image with an attachment header (SSRF-guarded to TMDb + Amazon/IMDb image CDNs) |
| `GET /api/movie?id={tmdbId}` · `GET /api/images?id={tmdbId}` | Query-style aliases kept for compatibility |

## Source-adapter pattern (add sources without a rewrite)

`sources.ts` defines `SourceAdapter { name, getMovieImages, getPersonImages, getMovieVideos? }`
— each method returns `{ items, raw }` so raw payloads flow into the raw-JSON view.
Endpoints call `aggregateMovieImages` / `aggregatePersonImages` / `aggregateMovieVideos`,
which run every adapter in `SOURCES` and dedupe. `wiki.ts` mirrors the pattern for
background (`BACKGROUND_SOURCES`). To add **Fanart.tv / TVDB** later, write one adapter
and push it into the registry — no endpoint changes.

Registered now: `tmdbSource` (movie images + person images + videos), `omdbSource`
(movie poster), `wikipediaSource` (background).

## Tests + full regression

Tool-local tests live in `tool.check.ts` (named `*.check.ts`, NOT `*.test.ts`, so the
repo's default `npx vitest run` never collects them — the main suite stays exactly 190).

```bash
# tool tests only
npx vitest run --config scripts/movie-lookup/vitest.config.ts

# full regression: tsc==44 + main suite==190 + drop-hash green + tool tests
npx tsx scripts/movie-lookup/regression.ts
```

They cover: tokenizer + ranking (order-independence, soft language/year boosts,
non-matching-language is soft, dedupe, series included), adapter aggregation/dedupe,
TMDb adapter shapes (mocked network), and the Wikipedia matching helpers.

## Notes / limits

- **Ratings**: TMDb (score, votes, popularity) **plus** IMDb / Rotten Tomatoes /
  Metacritic when `OMDB_API_KEY` is set. Those come from a tool-local **uncached**
  OMDb GET in `sources.ts` (the existing `omdb.ts` drops OMDb's Poster/ratings we
  need and editing it is out of scope), so no `shared/config.ts` fail-fast is
  pulled in. Absent OMDb key ⇒ TMDb-only, gracefully.
- **Cache**: all NEW detail/image/person/raw calls are **uncached direct reads**
  (they bypass `shared/cache.ts`) → they write **nothing** to `data/cache.sqlite`.
  The reused resolution helpers (`searchTitleTmdb`, `getCreditsAndLanguages`,
  `getStreamingPlatforms`) still use the pipeline's read-through cache internally
  (TTL'd, additive; touches no editorial/render data). See the report for the
  reuse-vs-zero-write trade-off.
- **Series** appear in search results but detail is movie-only (the reused
  enrichment helper is movie-only).
