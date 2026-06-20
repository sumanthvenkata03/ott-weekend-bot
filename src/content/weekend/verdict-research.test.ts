// src/content/weekend/verdict-research.test.ts
// Pure-function fixtures for computeVerdictScore — NO API, NO web search, free.
// Run: npx tsx src/content/weekend/verdict-research.test.ts
//
// Covers the two fixes:
//   1) STAR ↔ VERDICT consistency — verdict derives from the rounded ★ the reader
//      sees, so ★4.0 is always "Must Watch" (no ★4.0 + "Worth a Try" split).
//   2) Outlier-robust critic consensus — MEDIAN, not mean, so one 1.5/5 dissent
//      can't drag an acclaimed film below its tier.
//
// Each fixture prints the OLD (mean consensus + score-threshold) vs NEW (median
// consensus + star-threshold) result so a flip is visible, then asserts NEW.

import assert from "node:assert/strict";
import {
  computeVerdictScore,
  type CriticRating,
  CRITIC_WEIGHT,
  AUDIENCE_WEIGHT,
  BUZZ_WEIGHT,
} from "./verdict-research.js";

// ── Old behaviour, re-implemented here ONLY to print the before/after columns ──
const OLD_MUST_WATCH_MIN = 8.0;
const OLD_WORTH_TRY_MIN = 6.0;
const meanOf = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (n: number): number => Math.round(n * 10) / 10;

function computeOld(ratings: CriticRating[], audience: number | null) {
  if (ratings.length === 0) return { tbsiScore: null, star: null, verdict: null as string | null };
  const criticConsensus = meanOf(
    ratings.map(r => (r.explicitScore !== null ? r.explicitScore : r.sentimentScore) * 2)
  );
  const buzz = meanOf(ratings.map(r => r.sentimentScore * 2));
  const signals = [
    { w: CRITIC_WEIGHT, v: criticConsensus },
    ...(audience !== null ? [{ w: AUDIENCE_WEIGHT, v: audience }] : []),
    { w: BUZZ_WEIGHT, v: buzz },
  ];
  const ws = signals.reduce((a, s) => a + s.w, 0);
  const tbsiScore = round1(signals.reduce((a, s) => a + s.w * s.v, 0) / ws);
  const star = round1(tbsiScore / 2);
  const verdict =
    tbsiScore >= OLD_MUST_WATCH_MIN ? "Must Watch" : tbsiScore >= OLD_WORTH_TRY_MIN ? "Worth a Try" : "Skip";
  return { tbsiScore, star, verdict };
}

const critic = (explicitScore: number | null, sentimentScore: number): CriticRating => ({
  source: "outlet",
  url: "https://example.com/review",
  explicitScore,
  sentimentScore,
});

let passed = 0;
function check(name: string, ratings: CriticRating[], audience: number | null) {
  const old = computeOld(ratings, audience);
  const now = computeVerdictScore({ found: true, criticRatings: ratings }, audience);
  const flip = old.verdict !== now.verdict ? "  ⟵ TIER MOVES" : "";
  console.log(
    `${name}\n` +
    `  OLD  tbsi=${old.tbsiScore}  ★${old.star}  ${old.verdict}\n` +
    `  NEW  tbsi=${now.tbsiScore}  ★${now.star}  ${now.verdict}  (conf ${now.confidence})${flip}`
  );
  return now;
}

console.log("── computeVerdictScore fixtures (median consensus + star-derived verdict) ──\n");

// (a) BOUNDARY — star/verdict consistency at the Must Watch line.
// tbsi lands 7.9 → ★ rounds to 4.0. OLD: 7.9 < 8.0 → "Worth a Try" while ★ shows
// 4.0 (the split bug). NEW: ★4.0 ⇒ "Must Watch".
{
  const r = check("(a1) boundary ★4.0", [critic(4.0, 3.5), critic(4.0, 3.5)], 8.0);
  assert.equal(r.tbsiScore, 7.9);
  assert.equal(r.star, 4.0);
  assert.equal(r.verdict, "Must Watch", "★4.0 must be Must Watch, never Worth a Try");
  assert.equal(r.confidence, "high");
}

// (a) INVERSE — a score that rounds ★ to 3.9 stays "Worth a Try" (no over-promotion).
{
  const r = check("(a2) inverse ★3.9", [critic(4.0, 3.5), critic(4.0, 3.5)], 7.4);
  assert.equal(r.tbsiScore, 7.7);
  assert.equal(r.star, 3.9);
  assert.equal(r.verdict, "Worth a Try", "★3.9 must be Worth a Try");
}

// (b) OUTLIER — Bramayugam-shape critic set with one 1.5/5 dissent.
// OLD mean consensus = 7.5 → tbsi 7.9 → "Worth a Try" (dragged below tier, AND a
// ★4.0/Worth-a-Try split). NEW median consensus = 8.5 → tbsi 8.4 → "Must Watch".
{
  const ratings = [4.5, 4.5, 4.0, 4.5, 3.5, 1.5].map(s => critic(s, s));
  const r = check("(b) outlier set", ratings, 8.5);
  // Median consensus is ~4.25/5 (8.5/10), NOT the ~7.5/10 mean.
  assert.equal(r.tbsiScore, 8.4);
  assert.equal(r.star, 4.2);
  assert.equal(r.verdict, "Must Watch", "median must hold the acclaimed tier despite the 1.5 dissent");
  assert.equal(r.confidence, "high");
  // Dissent is still PRESENT in the collected ratings — we only changed how the
  // consensus is AGGREGATED, not what's captured.
  assert.ok(ratings.some(x => x.explicitScore === 1.5), "1.5/5 dissent preserved in criticRatings");
}

// (c) ORIGINAL 3 FIXTURES (high / low / none) — must still pass under new thresholds.
{
  // HIGH — Pennum Porattum sample (2 explicit critics, strong audience).
  const r = check("(c-high) Pennum Porattum", [critic(4.5, 4.5), critic(4.0, 4.0)], 8.8);
  assert.equal(r.tbsiScore, 8.6);
  assert.equal(r.star, 4.3);
  assert.equal(r.verdict, "Must Watch");
  assert.equal(r.confidence, "high");
}
{
  // LOW — Bramayugam sample (one sentiment-only early review).
  const r = check("(c-low) Bramayugam early", [critic(null, 3)], 7);
  assert.equal(r.tbsiScore, 6.4);
  assert.equal(r.star, 3.2);
  assert.equal(r.verdict, "Worth a Try");
  assert.equal(r.confidence, "low");
}
{
  // (d) CLEAN consensus, no outlier ("Balan-shape") — median == mean here, so the
  // median change is a NO-OP: the fix targets outlier sets, it doesn't shift clean
  // ones. Stays Must Watch both ways.
  const r = check("(d) clean consensus", [4.5, 4.0, 4.5, 4.0].map(s => critic(s, s)), 8.5);
  assert.equal(r.tbsiScore, 8.5);
  assert.equal(r.star, 4.3);
  assert.equal(r.verdict, "Must Watch");
  assert.equal(r.confidence, "high");
}
{
  // NONE — found:false → no fabricated score (gate unchanged).
  const r = computeVerdictScore({ found: false, criticRatings: [] }, null);
  console.log(`(c-none) not found\n  NEW  tbsi=${r.tbsiScore}  ★${r.star}  ${r.verdict}  (conf ${r.confidence})`);
  assert.equal(r.tbsiScore, null);
  assert.equal(r.star, null);
  assert.equal(r.verdict, null);
  assert.equal(r.confidence, "none");
}

passed = 13;
console.log(`\n✅ all ${passed} assertions passed`);
