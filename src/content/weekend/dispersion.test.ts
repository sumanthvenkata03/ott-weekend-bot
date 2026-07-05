// dispersion.test.ts — the critic-dispersion axis behind the DIVISIVE tier, and
// a CALIBRATION LOCK that runs the real scoreResearch over the committed
// issue-013 fixtures (audience as cached, i.e. null) and asserts the published
// verdicts + the single expected flip (Gatta Kusthi 2 → Divisive).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeDispersion,
  scoreResearch,
  NO_AUDIENCE,
  type CriticRating,
  type AudienceSignal,
  type RawResearch,
} from "./verdict-research.js";

const cr = (explicit: number | null, sentiment: number): CriticRating => ({
  source: "Outlet",
  url: "https://example.com/review",
  explicitScore: explicit,
  sentimentScore: sentiment,
});

describe("computeDispersion", () => {
  it("flat consensus → nothing fires", () => {
    const d = computeDispersion([cr(3, 3), cr(3, 3), cr(3, 3), cr(3, 3)], NO_AUDIENCE, 6);
    expect(d.fired).toBe(false);
    expect(d.signals.tailSplit.value).toBe(0);
    expect(d.signals.range.value).toBe(0);
  });

  it("2-vs-2 explicit love/pan split → tailSplit fires", () => {
    const d = computeDispersion([cr(4, 4), cr(4, 4), cr(2, 2), cr(2, 2)], NO_AUDIENCE, 6); // [8,8,4,4]
    expect(d.signals.tailSplit.valid).toBe(true);
    expect(d.signals.tailSplit.value).toBe(1); // 4·0.5·0.5
    expect(d.signals.tailSplit.fired).toBe(true);
    expect(d.fired).toBe(true);
  });

  it("explicit 8-vs-4 across 3 critics → range fires; tailSplit invalid (n<4)", () => {
    const d = computeDispersion([cr(4, 4), cr(3, 3), cr(2, 2)], NO_AUDIENCE, 6); // [8,6,4]
    expect(d.signals.range.valid).toBe(true);
    expect(d.signals.range.value).toBe(4.0);
    expect(d.signals.range.fired).toBe(true);
    expect(d.signals.tailSplit.valid).toBe(false);
    expect(d.fired).toBe(true);
  });

  it("sentiment love/pan split with m>=6 → sentSplit fires (explicit empty)", () => {
    const rs = [cr(null, 4), cr(null, 4), cr(null, 4), cr(null, 2), cr(null, 2), cr(null, 2)]; // [8×3,4×3]
    const d = computeDispersion(rs, NO_AUDIENCE, 6);
    expect(d.signals.sentSplit.valid).toBe(true);
    expect(d.signals.sentSplit.value).toBe(1);
    expect(d.signals.sentSplit.fired).toBe(true);
    expect(d.signals.range.valid).toBe(false); // no explicit scores
    expect(d.fired).toBe(true);
  });

  it("thin-n guards: explicit n=3 → tailSplit invalid; sentiment m=5 → sentSplit invalid", () => {
    const rs = [cr(4, 4), cr(3, 3), cr(2, 2), cr(null, 4), cr(null, 2)]; // 3 explicit, 5 sentiments
    const d = computeDispersion(rs, NO_AUDIENCE, 6);
    expect(d.signals.tailSplit.valid).toBe(false);
    expect(d.signals.sentSplit.valid).toBe(false);
  });

  it("boundary values fire (>= semantics): tailSplit exactly 0.5 and range exactly 4.0", () => {
    // explicit10 [8,4,4,6] → love 1/4, pan 2/4 → tailSplit 4·0.25·0.5 = 0.5; range 8−4 = 4.0
    const d = computeDispersion([cr(4, 4), cr(2, 2), cr(2, 2), cr(3, 3)], NO_AUDIENCE, 6);
    expect(d.signals.tailSplit.value).toBeCloseTo(0.5, 10);
    expect(d.signals.tailSplit.fired).toBe(true);
    expect(d.signals.range.value).toBe(4.0);
    expect(d.signals.range.fired).toBe(true);
  });

  it("gap invalid when audience is null", () => {
    const d = computeDispersion([cr(4, 4), cr(2, 2), cr(3, 3)], NO_AUDIENCE, 6);
    expect(d.signals.gap.valid).toBe(false);
    expect(d.signals.gap.fired).toBe(false);
  });

  it("gap fires with real audience (imdbVotes >= floor) and a wide critic-vs-audience gap", () => {
    const audience: AudienceSignal = { imdbRating: 5, imdbVotes: 500, letterboxd: null, tmdbVoteAverage: null, tmdbVoteCount: null };
    const d = computeDispersion([cr(4, 4), cr(4, 4)], audience, 8); // |8 − 5| = 3 ≥ 2
    expect(d.signals.gap.valid).toBe(true);
    expect(d.signals.gap.value).toBe(3);
    expect(d.signals.gap.fired).toBe(true);
  });

  it("gap invalid below the vote floor with no letterboxd", () => {
    const audience: AudienceSignal = { imdbRating: 5, imdbVotes: 100, letterboxd: null, tmdbVoteAverage: null, tmdbVoteCount: null };
    const d = computeDispersion([cr(4, 4), cr(4, 4)], audience, 8);
    expect(d.signals.gap.valid).toBe(false);
  });
});

// ── CALIBRATION LOCK ────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const loadFixture = (slug: string): RawResearch =>
  JSON.parse(readFileSync(join(HERE, "__fixtures__", "issue-013", `${slug}.json`), "utf8")) as RawResearch;

const EXPECTED: Record<string, string> = {
  "alpha": "Skip",
  "nagabandham": "Skip",
  "rao-bahadur": "Skip",
  "gatta-kusthi-2": "Divisive",
  "satluj": "Worth a Try",
  "baby-do-die-do": "Worth a Try",
  "nevermind": "Worth a Try",
};

describe("issue-013 calibration (real scoreResearch over committed fixtures)", () => {
  for (const [slug, expected] of Object.entries(EXPECTED)) {
    it(`${slug} → ${expected}`, () => {
      expect(scoreResearch(loadFixture(slug)).verdict).toBe(expected);
    });
  }

  it("exactly ONE flip vs published 013 (only Gatta Kusthi 2 → Divisive)", () => {
    const divisive = Object.keys(EXPECTED).filter(s => scoreResearch(loadFixture(s)).verdict === "Divisive");
    expect(divisive).toEqual(["gatta-kusthi-2"]);
  });

  it("Nevermind stays low-confidence (EARLY)", () => {
    expect(scoreResearch(loadFixture("nevermind")).confidence).toBe("low");
  });

  it("prints the per-film calibration table (star + per-signal value/valid/fired)", () => {
    const med10 = (rs: CriticRating[]): number => {
      const xs = rs.map(c => (c.explicitScore ?? c.sentimentScore) * 2).sort((a, b) => a - b);
      const m = Math.floor(xs.length / 2);
      return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
    };
    const fmt = (s: { value: number; valid: boolean; fired: boolean }) =>
      `${s.value.toFixed(2)}/${s.valid ? "v" : "–"}/${s.fired ? "FIRE" : "·"}`;
    console.log("\n=== issue-013 DIVISIVE calibration ===");
    for (const slug of Object.keys(EXPECTED)) {
      const raw = loadFixture(slug);
      const r = scoreResearch(raw);
      const d = computeDispersion(raw.criticRatings, raw.audience, raw.criticRatings.length ? med10(raw.criticRatings) : 0);
      const sg = d.signals;
      console.log(
        `  ${slug.padEnd(16)} ★${r.star ?? "—"} ${String(r.verdict).padEnd(11)}` +
        ` tail=${fmt(sg.tailSplit)} range=${fmt(sg.range)} sent=${fmt(sg.sentSplit)} gap=${fmt(sg.gap)}`
      );
    }
    expect(true).toBe(true);
  });
});
