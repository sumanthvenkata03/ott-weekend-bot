// scripts/movie-lookup/ratelimit.check.ts
// Tool-local tests for the per-IP token-bucket rate limiter (ratelimit.ts). Named
// *.check.ts so the repo's default `npx vitest run` never collects them — the main
// suite stays exactly 190. Run with:
//   npx vitest run --config scripts/movie-lookup/vitest.config.ts
//
// Fully deterministic + offline: `now` is injected on every take(), so refill timing
// is exact and nothing sleeps or touches the wall clock / network.

import { describe, it, expect } from "vitest";
import { createLimiter } from "./ratelimit.js";

describe("rate limiter — burst ceiling", () => {
  it("allows exactly `burst` requests up-front, then blocks", () => {
    const rl = createLimiter({ perMin: 60, burst: 5, maxIps: 100 });
    const results = Array.from({ length: 6 }, () => rl.take("ip", 0));
    expect(results).toEqual([true, true, true, true, true, false]); // 5 allowed, 6th blocked
  });

  it("never accumulates beyond the burst ceiling over a long idle", () => {
    const rl = createLimiter({ perMin: 60, burst: 3, maxIps: 100 });
    expect(rl.take("ip", 0)).toBe(true); // 3 → 2
    // Idle a full hour: the refill is capped at burst (3), NOT 2 + 3600 tokens.
    expect(rl.take("ip", 3_600_000)).toBe(true); // refilled to 3, take → 2
    expect(rl.take("ip", 3_600_000)).toBe(true); // 2 → 1
    expect(rl.take("ip", 3_600_000)).toBe(true); // 1 → 0
    expect(rl.take("ip", 3_600_000)).toBe(false); // ceiling was 3, not unbounded
  });
});

describe("rate limiter — lazy refill math", () => {
  it("refills at perMin tokens/minute from elapsed time (injected now)", () => {
    const rl = createLimiter({ perMin: 60, burst: 2, maxIps: 100 }); // 1 token/sec
    expect(rl.take("ip", 0)).toBe(true); // 2 → 1
    expect(rl.take("ip", 0)).toBe(true); // 1 → 0
    expect(rl.take("ip", 0)).toBe(false); // empty
    expect(rl.take("ip", 500)).toBe(false); // +0.5s → 0.5 token, still < 1
    expect(rl.take("ip", 1500)).toBe(true); // +1s more → ≥1 token available again
  });

  it("refill is proportional to the rate (perMin=120 → ~1 token per 500ms)", () => {
    const rl = createLimiter({ perMin: 120, burst: 1, maxIps: 100 });
    expect(rl.take("ip", 0)).toBe(true); // 1 → 0
    expect(rl.take("ip", 400)).toBe(false); // 400ms → ~0.8 token, < 1
    expect(rl.take("ip", 600)).toBe(true); // cumulatively past a full token
  });
});

describe("rate limiter — per-IP isolation", () => {
  it("keeps a separate bucket per IP (one IP's spend never limits another)", () => {
    const rl = createLimiter({ perMin: 60, burst: 1, maxIps: 100 });
    expect(rl.take("a", 0)).toBe(true);
    expect(rl.take("a", 0)).toBe(false); // a exhausted
    expect(rl.take("b", 0)).toBe(true); // b untouched
    expect(rl.take("c", 0)).toBe(true); // c untouched
  });
});

describe("rate limiter — maxIps bound (LRU eviction)", () => {
  it("never retains more than maxIps buckets", () => {
    const rl = createLimiter({ perMin: 60, burst: 5, maxIps: 3 });
    for (let i = 0; i < 10; i++) rl.take("ip" + i, i);
    expect(rl.size()).toBe(3);
  });

  it("evicts the least-recently-used IP; an evicted IP returns with a fresh full bucket", () => {
    const rl = createLimiter({ perMin: 60, burst: 1, maxIps: 2 });
    expect(rl.take("a", 0)).toBe(true); // a: 1 → 0
    expect(rl.take("a", 0)).toBe(false); // a exhausted (still most-recent so far)
    rl.take("b", 1); // buckets: {a, b}
    rl.take("c", 2); // adding c evicts the LRU (a) → buckets: {b, c}
    expect(rl.size()).toBe(2);
    // 'a' was evicted, so it comes back as a brand-new full bucket → allowed again.
    expect(rl.take("a", 3)).toBe(true);
  });

  it("clamps a non-positive maxIps to at least 1 bucket", () => {
    const rl = createLimiter({ perMin: 60, burst: 5, maxIps: 0 });
    rl.take("a", 0);
    rl.take("b", 1);
    expect(rl.size()).toBe(1);
  });
});
