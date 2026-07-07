// scripts/movie-lookup/features.check.ts
// Tool-local tests for the four new features: watchlist store (memory + pg SQL),
// compare (cast overlap / shared films), upcoming/now-playing mapping, and the
// filmography sort/filter. Named *.check.ts so the repo's default `npx vitest
// run` never collects them — the main suite stays exactly 190. Run with:
//   npx vitest run --config scripts/movie-lookup/vitest.config.ts
//
// Fully offline: the pipeline SQLite cache + network are mocked so importing the
// releases/sources chain opens no DB and makes no live call; the Postgres layer
// is exercised through an injected mock (no real driver).

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/shared/cache.js", () => ({ cached: (_k: string, loader: () => unknown) => loader() }));
vi.mock("ofetch", () => ({ ofetch: vi.fn() }));

import {
  MemoryWatchlist,
  PostgresWatchlist,
  createWatchlistBackend,
  isWatchType,
  type Queryable,
} from "./watchlist.js";
import { castOverlap, sharedFilms, sortFilmography, filterFilmography, type FilmoLike } from "./compute.js";
import { mapReleases } from "./releases.js";

// ── Watchlist: in-memory fallback (device-scoped) ─────────────────────────────
describe("Watchlist — in-memory backend add/list/remove", () => {
  it("adds, lists newest-first, dedupes by (device,type,id), and removes", async () => {
    const wl = new MemoryWatchlist();
    await wl.init();
    await wl.add({ type: "film", tmdbId: 1, title: "RRR" }, "devA");
    await wl.add({ type: "person", tmdbId: 2, title: "Rajamouli" }, "devA");
    await wl.add({ type: "film", tmdbId: 1, title: "RRR (dup)" }, "devA"); // same key → update, not duplicate
    const list = await wl.list("devA");
    expect(list.length).toBe(2); // deduped
    expect(list.some((i) => i.type === "film" && i.tmdbId === 1 && i.title === "RRR (dup)")).toBe(true);
    await wl.remove("film", 1, "devA");
    const after = await wl.list("devA");
    expect(after.map((i) => `${i.type}:${i.tmdbId}`)).toEqual(["person:2"]);
  });

  it("isolates lists across two devices — same (type,id) lives independently", async () => {
    const wl = new MemoryWatchlist();
    await wl.init();
    await wl.add({ type: "film", tmdbId: 1, title: "RRR" }, "devA");
    await wl.add({ type: "film", tmdbId: 1, title: "RRR" }, "devB"); // same key, different device
    await wl.add({ type: "film", tmdbId: 9, title: "Eega" }, "devB");
    expect((await wl.list("devA")).map((i) => i.tmdbId)).toEqual([1]);
    expect((await wl.list("devB")).map((i) => i.tmdbId).sort((x, y) => x - y)).toEqual([1, 9]);
    // removing from one device leaves the other untouched
    await wl.remove("film", 1, "devA");
    expect(await wl.list("devA")).toEqual([]);
    expect((await wl.list("devB")).map((i) => i.tmdbId).sort((x, y) => x - y)).toEqual([1, 9]);
  });

  it("carries posterUrl through add/list; an item saved without it lists without it", async () => {
    const wl = new MemoryWatchlist();
    await wl.init();
    await wl.add({ type: "film", tmdbId: 1, title: "RRR", posterUrl: "https://image.tmdb.org/t/p/w500/rrr.jpg" }, "devA");
    await wl.add({ type: "person", tmdbId: 2, title: "Sneha" }, "devA"); // no poster
    const list = await wl.list("devA");
    const rrr = list.find((i) => i.tmdbId === 1)!;
    const sneha = list.find((i) => i.tmdbId === 2)!;
    expect(rrr.posterUrl).toBe("https://image.tmdb.org/t/p/w500/rrr.jpg");
    expect(sneha).not.toHaveProperty("posterUrl"); // omitted, not stored as undefined
  });
});

// ── Watchlist: Postgres SQL layer (mock Queryable) ────────────────────────────
describe("Watchlist — Postgres backend issues correct SQL", () => {
  function mockDb() {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const db: Queryable = {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        if (/^\s*INSERT/i.test(text)) {
          // params are now [device_id, type, tmdb_id, title, note, poster_url]
          return { rows: [{ type: params![1], tmdb_id: params![2], title: params![3], note: params![4], poster_url: params![5], added_at: "2026-07-06T00:00:00.000Z" }] };
        }
        if (/^\s*SELECT/i.test(text)) {
          return { rows: [{ type: "film", tmdb_id: 42, title: "Kalki", note: null, added_at: "2026-07-06T00:00:00.000Z" }] };
        }
        return { rows: [] };
      },
    };
    return { db, calls };
  }

  it("init creates a device-scoped table + runs the defensive migration", async () => {
    const { db, calls } = mockDb();
    await new PostgresWatchlist(db).init();
    // Fresh-install CREATE: carries device_id, and has NO table-level UNIQUE(type,tmdb_id).
    expect(calls[0]!.text).toMatch(/CREATE TABLE IF NOT EXISTS watchlist/i);
    expect(calls[0]!.text).toMatch(/device_id TEXT NOT NULL DEFAULT 'legacy'/i);
    expect(calls[0]!.text).not.toMatch(/UNIQUE \(type, tmdb_id\)/i);
    // Defensive migration for a pre-existing table: add column, drop old constraint, add index.
    const all = calls.map((c) => c.text).join("\n");
    expect(all).toMatch(/ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS device_id/i);
    expect(all).toMatch(/DROP CONSTRAINT IF EXISTS watchlist_type_tmdb_id_key/i);
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS watchlist_device_type_tmdb_idx ON watchlist\(device_id, type, tmdb_id\)/i);
  });

  it("add upserts device-scoped (device_id + poster_url), poster_url round-trips to posterUrl", async () => {
    const { db, calls } = mockDb();
    const item = await new PostgresWatchlist(db).add(
      { type: "person", tmdbId: 7, title: "Sneha", note: "fav", posterUrl: "https://image.tmdb.org/t/p/w500/sneha.jpg" },
      "devX"
    );
    expect(calls[0]!.text).toMatch(/INSERT INTO watchlist \(device_id, type, tmdb_id, title, note, poster_url\)/i);
    expect(calls[0]!.text).toMatch(/ON CONFLICT \(device_id, type, tmdb_id\) DO UPDATE SET .*poster_url = EXCLUDED\.poster_url/i);
    expect(calls[0]!.params).toEqual(["devX", "person", 7, "Sneha", "fav", "https://image.tmdb.org/t/p/w500/sneha.jpg"]);
    expect(item).toEqual({ type: "person", tmdbId: 7, title: "Sneha", note: "fav", posterUrl: "https://image.tmdb.org/t/p/w500/sneha.jpg", addedAt: "2026-07-06T00:00:00.000Z" });
  });

  it("add stores NULL poster_url when none supplied (item has no posterUrl)", async () => {
    const { db, calls } = mockDb();
    const item = await new PostgresWatchlist(db).add({ type: "film", tmdbId: 5, title: "RRR" }, "devX");
    expect(calls[0]!.params).toEqual(["devX", "film", 5, "RRR", null, null]); // note + poster_url both null
    expect(item).toEqual({ type: "film", tmdbId: 5, title: "RRR", addedAt: "2026-07-06T00:00:00.000Z" });
    expect(item).not.toHaveProperty("posterUrl");
  });

  it("list selects THIS device's rows, ordered by added_at DESC", async () => {
    const { db, calls } = mockDb();
    const items = await new PostgresWatchlist(db).list("devX");
    expect(calls[0]!.text).toMatch(/SELECT .* FROM watchlist WHERE device_id = \$1 ORDER BY added_at DESC/i);
    expect(calls[0]!.params).toEqual(["devX"]);
    expect(items).toEqual([{ type: "film", tmdbId: 42, title: "Kalki", addedAt: "2026-07-06T00:00:00.000Z" }]);
  });

  it("remove deletes by (device_id, type, tmdb_id)", async () => {
    const { db, calls } = mockDb();
    await new PostgresWatchlist(db).remove("film", 99, "devX");
    expect(calls[0]!.text).toMatch(/DELETE FROM watchlist WHERE device_id = \$1 AND type = \$2 AND tmdb_id = \$3/i);
    expect(calls[0]!.params).toEqual(["devX", "film", 99]);
  });
});

describe("Watchlist — graceful backend selection", () => {
  it("falls back to in-memory when DATABASE_URL is unset", () => {
    const b = createWatchlistBackend({} as NodeJS.ProcessEnv, () => ({ query: async () => ({ rows: [] }) }));
    expect(b.kind).toBe("memory");
  });
  it("uses Postgres when DATABASE_URL is set AND a pg factory is provided", () => {
    const b = createWatchlistBackend({ DATABASE_URL: "postgres://x" } as unknown as NodeJS.ProcessEnv, () => ({ query: async () => ({ rows: [] }) }));
    expect(b.kind).toBe("postgres");
  });
  it("stays in-memory if a URL is set but no pg factory is available (defensive)", () => {
    const b = createWatchlistBackend({ DATABASE_URL: "postgres://x" } as unknown as NodeJS.ProcessEnv);
    expect(b.kind).toBe("memory");
  });
  it("isWatchType guards the type field", () => {
    expect(isWatchType("film")).toBe(true);
    expect(isWatchType("person")).toBe(true);
    expect(isWatchType("series")).toBe(false);
    expect(isWatchType(undefined)).toBe(false);
  });
});

// ── Compare: cast overlap + shared films ──────────────────────────────────────
describe("Compare — cast/crew overlap between two films", () => {
  const filmA = {
    cast: [{ id: 1, name: "NTR", character: "Bheem" }, { id: 2, name: "Ram Charan", character: "Raju" }],
    crew: [{ id: 9, name: "Rajamouli", job: "Director" }],
  };
  const filmB = {
    cast: [{ id: 2, name: "Ram Charan", character: "Vikram" }],
    crew: [{ id: 9, name: "Rajamouli", job: "Director" }, { id: 5, name: "Keeravani", job: "Music" }],
  };
  it("returns only people present in BOTH, with each side's role", () => {
    const ov = castOverlap(filmA, filmB).sort((a, b) => a.id - b.id);
    expect(ov.map((o) => o.id)).toEqual([2, 9]); // NTR (1) & Keeravani (5) not shared
    expect(ov.find((o) => o.id === 2)).toEqual({ id: 2, name: "Ram Charan", roleA: "as Raju", roleB: "as Vikram" });
    expect(ov.find((o) => o.id === 9)).toEqual({ id: 9, name: "Rajamouli", roleA: "Director", roleB: "Director" });
  });
  it("empty when there is no shared cast/crew", () => {
    expect(castOverlap({ cast: [{ id: 1, name: "A" }] }, { cast: [{ id: 2, name: "B" }] })).toEqual([]);
  });
});

describe("Compare — shared films between two people", () => {
  const a: FilmoLike[] = [{ id: 10, title: "RRR", year: 2022 }, { id: 11, title: "Eega", year: 2012 }, { id: 12, title: "Solo", year: 2020 }];
  const b: FilmoLike[] = [{ id: 12, title: "Solo", year: 2020 }, { id: 10, title: "RRR", year: 2022 }, { id: 13, title: "X", year: 2019 }];
  it("returns films in both filmographies, newest first, deduped", () => {
    const s = sharedFilms(a, b);
    expect(s.map((f) => f.id)).toEqual([10, 12]); // RRR (2022) before Solo (2020)
  });
  it("empty when no collaboration", () => {
    expect(sharedFilms([{ id: 1, title: "A" }], [{ id: 2, title: "B" }])).toEqual([]);
  });
});

// ── Upcoming / Now-playing mapping ────────────────────────────────────────────
describe("Releases — mapping + region + sort", () => {
  const raw = {
    results: [
      { id: 1, title: "Now A", release_date: "2026-06-01", poster_path: "/a.jpg", popularity: 50, vote_average: 7.2, original_language: "te" },
      { id: 2, title: "Now B", release_date: "2026-05-01", poster_path: null, popularity: 90, vote_average: 6 },
    ],
  };
  it("now_playing: most-popular first, maps poster/language/scores, carries the region", () => {
    const out = mapReleases(raw, "now_playing", "IN");
    expect(out.region).toBe("IN");
    expect(out.kind).toBe("now_playing");
    expect(out.results.map((r) => r.id)).toEqual([2, 1]); // popularity 90 before 50
    const a = out.results.find((r) => r.id === 1)!;
    expect(a.posterUrl).toBe("https://image.tmdb.org/t/p/w342/a.jpg");
    expect(a.language).toBe("Telugu");
    expect(a.year).toBe(2026);
  });
  it("upcoming: soonest release date first", () => {
    const out = mapReleases(raw, "upcoming", "IN");
    expect(out.results.map((r) => r.id)).toEqual([2, 1]); // 2026-05-01 before 2026-06-01
  });
  it("tolerates an empty/absent results array", () => {
    expect(mapReleases({}, "now_playing", "IN").results).toEqual([]);
  });
});

// ── Filmography sort + filter ─────────────────────────────────────────────────
describe("Filmography — sort + filter", () => {
  const filmo: FilmoLike[] = [
    { id: 1, title: "Old Cast", year: 2005, department: "cast", role: "as Hero", popularity: 3, mediaType: "movie" },
    { id: 2, title: "New Direct", year: 2022, department: "crew", role: "Director", popularity: 20, mediaType: "movie" },
    { id: 3, title: "Mid Crew", year: 2015, department: "crew", role: "Producer", popularity: 50, mediaType: "movie" },
  ];
  it("sorts newest / oldest / popular", () => {
    expect(sortFilmography(filmo, "newest").map((f) => f.id)).toEqual([2, 3, 1]);
    expect(sortFilmography(filmo, "oldest").map((f) => f.id)).toEqual([1, 3, 2]);
    expect(sortFilmography(filmo, "popular").map((f) => f.id)).toEqual([3, 2, 1]);
  });
  it("filters all / acting / directing / crew", () => {
    expect(filterFilmography(filmo, "all").map((f) => f.id)).toEqual([1, 2, 3]);
    expect(filterFilmography(filmo, "acting").map((f) => f.id)).toEqual([1]);
    expect(filterFilmography(filmo, "directing").map((f) => f.id)).toEqual([2]); // crew + role matches /direct/i
    expect(filterFilmography(filmo, "crew").map((f) => f.id)).toEqual([2, 3]);
  });
  it("does not mutate the input array", () => {
    const before = filmo.map((f) => f.id);
    sortFilmography(filmo, "popular");
    expect(filmo.map((f) => f.id)).toEqual(before);
  });
});
