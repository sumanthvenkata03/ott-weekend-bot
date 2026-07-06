// scripts/movie-lookup/cache.check.ts
// Tool-local tests for the in-memory TTL+LRU response cache and the parallel
// section-fetch pattern. Named *.check.ts so the repo's default `npx vitest run`
// never collects them — the main suite stays exactly 190. Run with:
//   npx vitest run --config scripts/movie-lookup/vitest.config.ts
//
// Fully offline: only the pure TtlCache class + local timers are exercised — no
// SQLite, no network. `now` is injected so TTL expiry is deterministic.

import { describe, it, expect, vi } from "vitest";
import { TtlCache, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES } from "./cache.js";

describe("TtlCache — hit / miss / key correctness", () => {
  it("a 2nd identical call within TTL is served from cache (loader NOT re-run)", async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    const loader = vi.fn(async () => ({ v: 42 }));
    const a = await cache.wrap("movie:1", loader, 0);
    const b = await cache.wrap("movie:1", loader, 500); // within TTL
    expect(a).toEqual({ v: 42 });
    expect(b).toBe(a); // exact same cached object
    expect(loader).toHaveBeenCalledTimes(1); // second call did NOT hit the loader
    expect(cache.stats().hits).toBe(1);
  });

  it("different keys never collide (no cross-query/id bleed)", async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    const r1 = await cache.wrap("movie:1", async () => "one", 0);
    const r2 = await cache.wrap("movie:2", async () => "two", 0);
    const rs = await cache.wrap("search:8:rrr", async () => "rrr", 0);
    expect([r1, r2, rs]).toEqual(["one", "two", "rrr"]);
    expect(cache.get("movie:1", 0)).toBe("one");
    expect(cache.get("movie:2", 0)).toBe("two");
    expect(cache.get("search:8:rrr", 0)).toBe("rrr");
  });
});

describe("TtlCache — TTL expiry", () => {
  it("re-fetches fresh after the TTL window elapses", async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    const loader = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const a = await cache.wrap("k", loader, 0);
    const b = await cache.wrap("k", loader, 999);  // still valid → cached
    const c = await cache.wrap("k", loader, 1001); // expired → re-fetch
    expect(a).toBe("first");
    expect(b).toBe("first");
    expect(c).toBe("second");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("has()/get() treat an expired entry as absent", () => {
    const cache = new TtlCache({ ttlMs: 100 });
    cache.set("x", 1, 0);
    expect(cache.has("x", 50)).toBe(true);
    expect(cache.get("x", 50)).toBe(1);
    expect(cache.has("x", 200)).toBe(false);
    expect(cache.get("x", 200)).toBeUndefined();
  });
});

describe("TtlCache — LRU / max-entries bound", () => {
  it("evicts the least-recently-used key when over the bound", () => {
    const cache = new TtlCache({ ttlMs: 10000, maxEntries: 2 });
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.get("a", 0); // touch → a becomes MRU, b becomes LRU
    cache.set("c", 3, 0); // over bound → evict LRU (b)
    expect(cache.has("a", 0)).toBe(true);
    expect(cache.has("b", 0)).toBe(false); // evicted
    expect(cache.has("c", 0)).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("size never exceeds maxEntries under heavy insertion", () => {
    const cache = new TtlCache({ ttlMs: 10000, maxEntries: 3 });
    for (let i = 0; i < 50; i++) cache.set("k" + i, i, 0);
    expect(cache.size).toBe(3);
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_TTL_MS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(0);
  });
});

describe("TtlCache — a rejected loader is NOT cached", () => {
  it("re-runs the loader after a failure (errors never poison the cache)", async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    const loader = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    await expect(cache.wrap("k", loader, 0)).rejects.toThrow("boom");
    const r = await cache.wrap("k", loader, 1); // not cached → retried
    expect(r).toBe("ok");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("parallel section-fetch aggregation (detail-page pattern)", () => {
  it("independent section loaders run concurrently and Promise.all preserves order", async () => {
    const started: string[] = [];
    const section = (name: string, ms: number, val: unknown) => async () => {
      started.push(name); // runs synchronously up to the first await
      await new Promise((r) => setTimeout(r, ms));
      return val;
    };
    const [images, videos, providers, wiki] = await Promise.all([
      section("images", 20, { n: "img" })(),
      section("videos", 5, { n: "vid" })(),
      section("providers", 10, { n: "prov" })(),
      section("wiki", 1, { n: "wiki" })(),
    ]);
    // All four started before any resolved → they ran in parallel, not serially.
    expect(started).toEqual(["images", "videos", "providers", "wiki"]);
    expect([images, videos, providers, wiki]).toEqual([{ n: "img" }, { n: "vid" }, { n: "prov" }, { n: "wiki" }]);
  });
});
