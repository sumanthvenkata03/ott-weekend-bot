// src/content/weekend/heat.test.ts
// Pure-function fixtures for computeHeat — NO API, NO web, free.
// Run: npx tsx src/content/weekend/heat.test.ts
//
// Proves the two hard requirements:
//   1) ISOLATION — heat ⊥ verdict: a HIGH-BUZZ Skip and a QUIET Must Watch both
//      exist, and the verdict is a function of (ratings, audience) ONLY — there is
//      structurally no heat input, so heat cannot move ★/verdict/confidence.
//   2) VISIBLE FAILURE — null (no signal) ≠ QUIET (real low signal): absent heat
//      emits NO sticker field; a present-but-low signal emits QUIET.
//   3) ABSOLUTE bands — fixed cutoffs, not derived from any slate.

import assert from "node:assert/strict";
import { computeHeat } from "./heat.js";
import { computeVerdictScore, NO_AUDIENCE, type CriticRating } from "./verdict-research.js";

let n = 0;
const eq = (a: unknown, e: unknown, m?: string) => { assert.equal(a, e, m); n++; };
const ok = (c: unknown, m?: string) => { assert.ok(c, m); n++; };

const critic = (explicitScore: number | null, sentimentScore: number): CriticRating =>
  ({ source: "outlet", url: "https://example.com/review", explicitScore, sentimentScore });

console.log("── heat.ts fixtures (display-only, isolated from the verdict) ──\n");

// ════════════════════════════════════════════════════════════════════════════
// (1) INDEPENDENCE — heat ⊥ verdict.
// ════════════════════════════════════════════════════════════════════════════
{
  const skipRatings = [2, 2, 2, 2, 2].map(s => critic(s, s));   // 5 credible → ★2.0 Skip
  const mwRatings = [4.5, 4.5, 4.5].map(s => critic(s, s));     // 3 credible → ★4.5 Must Watch
  const vSkip = computeVerdictScore({ found: true, criticRatings: skipRatings }, NO_AUDIENCE);
  const vMW = computeVerdictScore({ found: true, criticRatings: mwRatings }, NO_AUDIENCE);

  const hotHeat = computeHeat({ tmdbPopularity: 90 });   // HIGH BUZZ
  const quietHeat = computeHeat({ tmdbPopularity: 3 });  // QUIET

  // A HOT film that is a Skip, and a QUIET film that is a Must Watch.
  eq(vSkip.verdict, "Skip");
  eq(hotHeat?.label, "HIGH BUZZ");
  console.log(`  hot Skip:         verdict=${vSkip.verdict}  ★${vSkip.star}  heat=${hotHeat?.label}`);
  eq(vMW.verdict, "Must Watch");
  eq(quietHeat?.label, "QUIET");
  console.log(`  quiet Must Watch: verdict=${vMW.verdict}  ★${vMW.star}  heat=${quietHeat?.label}`);

  // Byte-identical: the verdict takes (ratings, audience) ONLY — no heat channel —
  // so the same inputs yield the same result regardless of the film's popularity.
  const vSkipAgain = computeVerdictScore({ found: true, criticRatings: skipRatings }, NO_AUDIENCE);
  assert.deepEqual(vSkip, vSkipAgain); n++;
  ok(hotHeat!.label !== quietHeat!.label, "heat varies while the verdict logic is blind to it");
}

// ════════════════════════════════════════════════════════════════════════════
// (2) VISIBLE FAILURE — null (absent) ≠ QUIET (present low).
// ════════════════════════════════════════════════════════════════════════════
{
  const absent = computeHeat({});                       // no popularity, no votes
  eq(absent, null, "no signal at all → null (absent), NEVER a default QUIET");
  const present0 = computeHeat({ tmdbPopularity: 0 });  // present, genuinely lowest
  eq(present0?.label, "QUIET", "tmdbPopularity 0 PRESENT → QUIET (real low), not null");

  // Renderer spread `...(heat ? { heat } : {})`: null → key never emitted.
  const ctxAbsent: Record<string, unknown> = { ...(absent ? { heat: absent } : {}) };
  ok(!("heat" in ctxAbsent), "null heat → NO sticker field emitted (not 0/QUIET)");
  const ctxPresent: Record<string, unknown> = { ...(present0 ? { heat: present0 } : {}) };
  ok("heat" in ctxPresent, "present heat → sticker field emitted");
}

// ════════════════════════════════════════════════════════════════════════════
// (3) ABSOLUTE BANDS — fixed cutoffs HOT_WARM=33 / HOT_HIGH=66 (straddled).
// ════════════════════════════════════════════════════════════════════════════
{
  const band = (pop: number) => {
    const h = computeHeat({ tmdbPopularity: pop })!;
    console.log(`  pop ${pop} → score ${h.score} → ${h.label}`);
    return h;
  };
  eq(band(3).label, "QUIET", "pop 3 (score 30) < 33 → QUIET");
  eq(band(4).label, "WARM", "pop 4 (score 35) ≥ 33 → WARM");
  eq(band(19).label, "WARM", "pop 19 (score 65) < 66 → WARM");
  eq(band(20).label, "HIGH BUZZ", "pop 20 (score 66) ≥ 66 → HIGH BUZZ");
  eq(band(50).score, 85);
  eq(band(50).label, "HIGH BUZZ");
}

// ════════════════════════════════════════════════════════════════════════════
// (4) VOTE BONUS — engagement volume adds on top of popularity, capped at +15.
// ════════════════════════════════════════════════════════════════════════════
{
  const noVotes = computeHeat({ tmdbPopularity: 50 })!;
  const bigVotes = computeHeat({ tmdbPopularity: 50, imdbVotes: 50000 })!;
  console.log(`  pop50 no-votes → ${noVotes.score}; pop50 + 50k votes → ${bigVotes.score}`);
  eq(noVotes.score, 85);
  eq(bigVotes.score, 100, "popPart 85 + full vote bonus 15 = 100");
  const votesOnly = computeHeat({ imdbVotes: 1000 });   // pop absent, votes present
  ok(votesOnly !== null, "votes present, popularity absent → computed, not null");
  eq(votesOnly?.label, "QUIET");
}

console.log(`\n✅ all ${n} assertions passed`);
