# TBSI Movie Lookup

A standalone film / person / poster lookup, deployed publicly at
**thebigscreenindex.com** (Render auto-deploys `main`; it's an installable PWA).
Type a movie name, get its full details + a gallery of every official poster &
backdrop TMDb offers (click to view full-size / download).

Nothing is posted, no job runs, no billed LLM call is made — it reuses the
pipeline's existing TMDb resolution code read-only. Debug views (raw JSON,
relevance scores, TMDb popularity, the "· Localhost" brand tag) render **only on a
localhost dev host**, never on the deployed site.

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

## API keys (env vars)

All read from the environment (`.env` or shell). **Every key-requiring adapter
degrades gracefully** — if a key is absent that source simply contributes nothing;
no crash, other sources still work.

| Env var | Powers | Needed? |
|---|---|---|
| `TMDB_API_KEY` | Search, detail, images, credits, **videos (TMDb)**, **watch-providers**, person detail + filmography | **Required** (already set for the pipeline) |
| `OMDB_API_KEY` | OMDb poster + IMDb/RT/Metacritic ratings | Optional (already set for the pipeline) |
| `FANART_API_KEY` | Extra movie art via **Fanart.tv** (posters/backgrounds/thumbs) | Optional — set to enable |
| `TVDB_API_KEY` | Extra movie art via **TheTVDB** (v4 login → artworks) | Optional — set to enable |
| `YOUTUBE_API_KEY` | Extra genuine trailer/clip links via the **YouTube Data API** | Optional — set to enable |

Get keys: Fanart.tv → `fanart.tv/get-an-api-key`; TVDB → `thetvdb.com/api-information` (v4);
YouTube → Google Cloud Console → enable "YouTube Data API v3" → API key.

## Key health check

Verify every key actually WORKS (live) — so a missing/expired/wrong key reads
FAIL/SKIPPED instead of the tool silently returning empty:

```bash
npx tsx scripts/movie-lookup/keycheck.ts
```

It hits each source once with a fixed well-known target and prints one line each:

| Status | Meaning |
|---|---|
| ✅ **OK** | Key is set **and** the live call succeeded (brief evidence shown) |
| ⏭️ **SKIPPED** | No key set for that source — not a failure, that source is just off |
| ❌ **FAIL** | Key **is** set but the call failed (reason shown: 401 bad key / 403 quota / bad token exchange / network) |

Ends with a `OK · SKIPPED · FAIL` summary. **Exit code**: `0` if no *set* key failed
(missing keys don't fail the gate), non-zero if any set key FAILED — so it's usable
as a health gate. Keys are never printed. It makes live calls on purpose; it writes
nothing to `cache.sqlite` and runs no job. (The offline *status-mapping* logic is unit
-tested in `tool.check.ts`; the live calls stay in this on-demand script, out of
`regression.ts`.)

## Pages

| Page | Purpose |
|---|---|
| `GET /` | Search page with **fast auto-suggest** (debounced live dropdown, in-memory cache, stale-request cancellation, ↑↓/Enter keyboard nav). Click a suggestion → detail; Enter → full ranked results grid. |
| `GET /movie.html?id={tmdbId}` | Full detail page: all fields, **merged image gallery** (TMDb + OMDb + Fanart.tv + TVDB), **Where to Watch** (providers), **Videos/Trailers** (TMDb + YouTube), **Wikipedia background**, full clickable cast + crew, and a combined **raw-JSON** view (movie · credits · omdb · images · videos · wiki · providers). |
| `GET /person.html?id={personId}` | Rich person page: bio, **age** (or age-at-death), birthday/place, a.k.a., profile, **filmography poster grid** (click a film → its detail), and full image gallery (view + download). |

## Search — cinema-wide & intelligent (search.ts)

One box, one ranked dropdown of **PEOPLE** (actors/directors/composers/producers/
writers), **MOVIES**, **SERIES**, and **PRODUCTION COMPANIES**. Type any words in
any order. `/api/search`:

1. **Tokenizes** the query. **Language** (telugu/…), **4-digit year**, and soft
   **TYPE/ROLE keywords** are pulled out as RANK signals (they boost, never
   exclude); the rest is the name/title query.
   - `movie`/`film` → boost MOVIE · `actor`/`actress`/`cast` → PERSON (Acting) ·
     `director` → PERSON (Directing) · `composer`/`music`/`musician` → PERSON
     (Sound) · `producer` → PERSON (Production) · `writer` → PERSON (Writing) ·
     `series`/`show`/`tv` → SERIES · `studio`/`company`/`production`/`banner` →
     COMPANY. ("music director" → Sound; Sound outranks Directing.)
2. **Default priority PEOPLE > MOVIES > SERIES > COMPANIES** — a person outranks a
   same-name movie by default (even a more popular one). A matching TYPE/ROLE
   keyword strongly steers that type to the top **without excluding** the others.
3. **Order-independent**: `actor sneha` ≡ `sneha actor`, `director rajamouli` ≡
   `rajamouli director` (tokens sorted for the API query; scoring is set-based).
4. **Sources** (all via the existing `TMDB_API_KEY`): `/search/multi` (person +
   movie + tv) + dedicated `/search/person` & `/search/movie` recall (so a type
   buried in the popularity-mixed multi still enters the set) + `/search/company`.
5. **Ranks**: name relevance (exact > all-tokens > partial) dominates; small type
   base sets the default priority; explicit TYPE keyword +100 and ROLE match +35
   steer; language/year soft boosts; popularity/votes tiebreak. Caps ~30
   (`&limit=` up to 60).

Live behavior: `sneha` → person Sneha first; `actor sneha` → person top; `sneha
movie` → movie top; `director rajamouli` → S. S. Rajamouli (Directing) top;
`thaman` → S. Thaman (Sound); `mythri company` → the studio top.

Dropdown rows show a TYPE badge (PERSON/FILM/SERIES/COMPANY), thumbnail, and a
secondary line (people: dept + top known-for; movies: year + language; companies:
country). **Click-through**: person → person page, movie → movie page, series →
"not supported" message, **company → label-only** (non-clickable) for now.

All search calls are **uncached** (no `cache.sqlite` writes).

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/search?q={words}[&limit=N]` | Google-style tokenized/ranked search (movies + series), order-independent |
| `GET /api/movie/:id` | Full detail incl. full cast + crew, ratings, and `rawData` (complete source payloads) |
| `GET /api/movie/:id/images[?imdbId=tt…]` | ALL posters + backdrops aggregated across TMDb + OMDb + Fanart.tv + TVDB, deduped, full-res |
| `GET /api/movie/:id/credits` | Full cast + crew (name, role/character, department, person id, profile photo) |
| `GET /api/movie/:id/videos[?title=…&year=…]` | Trailers/teasers/clips: TMDb `/videos` **+ YouTube Data API**, deduped by video id, official-first |
| `GET /api/movie/:id/providers[?country=IN]` | Where to watch — TMDb watch-providers (JustWatch): per-country flatrate/free/ads/rent/buy |
| `GET /api/movie/:id/wiki?title=…&year=…` | Wikipedia background: article summary/extract + canonical link, confidence-guarded |
| `GET /api/person/:id` | Rich person detail: bio, age, place, a.k.a., **filmography** (cast+crew with posters) + FULL image gallery |
| `GET /api/download?url={imageUrl}` | Streams an image with an attachment header (SSRF-guarded to TMDb + Amazon/IMDb image CDNs) |
| `GET /api/movie?id={tmdbId}` · `GET /api/images?id={tmdbId}` | Query-style aliases kept for compatibility |

## Source-adapter pattern (add sources without a rewrite)

`sources.ts` defines `SourceAdapter { name, getMovieImages, getPersonImages, getMovieVideos? }`
— each method returns `{ items, raw }` so raw payloads flow into the raw-JSON view.
Endpoints call `aggregateMovieImages` / `aggregatePersonImages` / `aggregateMovieVideos`,
which run every adapter in `SOURCES` and dedupe. `wiki.ts` mirrors the pattern for
background (`BACKGROUND_SOURCES`). To add **Fanart.tv / TVDB** later, write one adapter
and push it into the registry — no endpoint changes.

Registered now: `tmdbSource` (movie/person images + videos), `omdbSource` (movie
poster), `fanartSource` (Fanart.tv movie art — key), `tvdbSource` (TheTVDB movie
art + **people images** — key), `youtubeSource` (YouTube trailers — key),
`wikidataSource` (**person images** via Wikidata P18 + Commons — no key),
`wikipediaPersonSource` (**person lead image** — no key), `wikipediaSource`
(background). Key-gated adapters return empty when their key is unset.

### Person image gallery — multi-source (no new keys)

A person's gallery aggregates + dedupes across, and the person page groups them as
**Portraits** vs **Film stills**:

**Portraits** (verified person images): **TMDb** person images · **Wikidata →
Wikimedia Commons** (P18 + P373 category **with one level of subcategory
traversal**) · **Wikipedia** lead image (search-resolved, name-guarded) ·
**other-language Wikipedias** (ta/te/hi/ml/kn/bn/mr, resolved via Wikidata
sitelinks so the exact per-language article is used) · **TheTVDB** people images
(reuses `TVDB_API_KEY`). The person is resolved once (TMDb `external_ids` →
`wikidata_id` / `imdb_id`; SPARQL `P345` fallback).

**Film stills** (the person appears in these — film backdrops, not verified
portraits): the backdrops of their **top-N films** (movies, by popularity) pulled
from the existing movie-image aggregation (TMDb + Fanart.tv + TVDB), each tagged
`still · <film title>`. Bounded-concurrency, cost-capped.

- **No NEW key required** — Wikidata / Commons / Wikipedia are keyless; TVDB reuses
  the existing `TVDB_API_KEY`. (Fanart.tv has **no** actor/person image API.)
- Wikimedia rate-limits parallelism, so ALL Wikimedia calls go through a small
  serial limiter with retry/backoff — reliable, polite, no self-inflicted 429s.
- Live yield (branch): Sneha 3 → **89** · Nayanthara 12 → **123** · Samantha 32 →
  **269**. Duplicate URLs across sources are merged (portraits win over stills).

**Env knobs** (all optional):
`MOVIE_LOOKUP_STILL_FILMS` (default 12) — films to harvest stills from ·
`MOVIE_LOOKUP_WIKI_LANGS` (default `en,ta,te,hi,ml,kn,bn,mr`) — language wikis ·
`MOVIE_LOOKUP_COMMONS_MAX` (default 60) — max Commons files per person ·
`MOVIE_LOOKUP_WM_CONCURRENCY` (default 1) — concurrent Wikimedia requests.

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
