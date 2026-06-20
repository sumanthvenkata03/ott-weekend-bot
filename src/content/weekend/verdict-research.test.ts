// src/content/weekend/verdict-research.test.ts
// Pure-function fixtures for computeVerdictScore — NO API, NO web search, free.
// Run: npx tsx src/content/weekend/verdict-research.test.ts
//
// Covers the grounded-score fixes:
//   1) STAR ↔ VERDICT consistency — verdict derives from the FINAL (capped) ★, so
//      ★ and the stamp can never disagree at a tier boundary.
//   2) EVIDENCE CAP — a thin film (few credible critics, no vote floor) can't show
//      ★4.0+/"Must Watch"; the raw star is clamped to 3.9 ("Worth a Try").
//   3) SOURCE TIERING — Tier C (rave farms) and social roundups are excluded from
//      the critic consensus AND the credible-critic count; only Tier A/B critics
//      with a published score anchor a verdict. Audience NEVER grounds one alone.
//   4) Outlier-robust critic consensus — MEDIAN, not mean.
//
// Each fixture prints the OLD (mean consensus + score-threshold, no tiering, no
// cap) vs NEW (tiered median + evidence cap + star-threshold) result so a flip is
// visible, then asserts NEW.

import assert from "node:assert/strict";
import {
  computeVerdictScore,
  tierOf,
  isRoundup,
  type CriticRating,
  type AudienceSignal,
  CRITIC_WEIGHT,
  AUDIENCE_WEIGHT,
  REVIEW_TONE_WEIGHT,
} from "./verdict-research.js";

// ── Old behaviour, re-implemented here ONLY to print the before/after columns ──
// (mean consensus, every rating counts, score-threshold verdict, NO evidence cap)
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
    { w: REVIEW_TONE_WEIGHT, v: buzz },
  ];
  const ws = signals.reduce((a, s) => a + s.w, 0);
  const tbsiScore = round1(signals.reduce((a, s) => a + s.w * s.v, 0) / ws);
  const star = round1(tbsiScore / 2);
  const verdict =
    tbsiScore >= OLD_MUST_WATCH_MIN ? "Must Watch" : tbsiScore >= OLD_WORTH_TRY_MIN ? "Worth a Try" : "Skip";
  return { tbsiScore, star, verdict };
}

// ── Rating builders ──
// Default source/url ("outlet" / example.com) classify as Tier B with a real
// review url, so a plain critic() is a credible critic when it has an explicitScore.
const critic = (
  explicitScore: number | null,
  sentimentScore: number,
  source = "outlet",
  url = "https://example.com/review"
): CriticRating => ({ source, url, explicitScore, sentimentScore });

const tierA = (explicitScore: number | null, sentimentScore: number): CriticRating =>
  critic(explicitScore, sentimentScore, "The Hindu", "https://www.thehindu.com/reviews/film");
const tierC = (explicitScore: number | null, sentimentScore: number): CriticRating =>
  critic(explicitScore, sentimentScore, "indian.community", "https://indian.community/film-review");
// A social/tweet roundup — no explicit score and a roundup url slug → AUDIENCE.
const roundup = (sentimentScore: number): CriticRating =>
  critic(null, sentimentScore, "Pinkvilla", "https://www.pinkvilla.com/film-twitter-review");

// ── Audience signal builders ──
const aud = (
  imdbRating: number | null,
  imdbVotes: number | null = null,
  extra: Partial<AudienceSignal> = {}
): AudienceSignal => ({
  imdbRating, imdbVotes, letterboxd: null, tmdbVoteAverage: null, tmdbVoteCount: null, ...extra,
});
const NO_AUD = aud(null);

// ── Asserting helpers (self-counting) ──
let assertions = 0;
const eq = (actual: unknown, expected: unknown, msg?: string) => { assert.equal(actual, expected, msg); assertions++; };
const ok = (cond: unknown, msg?: string) => { assert.ok(cond, msg); assertions++; };

function check(name: string, ratings: CriticRating[], audience: AudienceSignal) {
  const old = computeOld(ratings, audience.imdbRating);
  const now = computeVerdictScore({ found: true, criticRatings: ratings }, audience);
  const rawStar = now.tbsiScore !== null ? round1(now.tbsiScore / 2) : null;
  const flip = old.verdict !== now.verdict ? "  ⟵ TIER MOVES" : "";
  console.log(
    `${name}\n` +
    `  OLD  tbsi=${old.tbsiScore}  ★${old.star}  ${old.verdict}\n` +
    `  NEW  tbsi=${now.tbsiScore}  raw★${rawStar} → ★${now.star}  ${now.verdict}` +
    `  (conf ${now.confidence}, ${now.credibleCriticCount} credible)${flip}`
  );
  return now;
}

console.log("── computeVerdictScore fixtures (tiered median + evidence cap + star verdict) ──\n");

// ════════════════════════════════════════════════════════════════════════════
// (0) SOURCE CLASSIFICATION — the registry + roundup heuristic, directly.
// ════════════════════════════════════════════════════════════════════════════
console.log("(0) source classification");
eq(tierOf(tierA(4, 4)), "A", "thehindu.com → Tier A");
eq(tierOf(critic(4, 4)), "B", "example.com (unknown) → Tier B");
eq(tierOf(tierC(5, 5)), "C", "indian.community → Tier C");
ok(isRoundup(roundup(4)), "pinkvilla twitter-review slug → roundup");
ok(!isRoundup(critic(4, 4)), "plain /review slug → NOT a roundup");
console.log("  Tier A/B/C + roundup classification OK\n");

// ════════════════════════════════════════════════════════════════════════════
// (1) EVIDENCE CAP — the core fix.
// ════════════════════════════════════════════════════════════════════════════

// (cap-1) Two credible critics RAVING (raw ★4.8). Only 2 critics, no vote floor →
// cap clamps to ★3.9 → "Worth a Try". ★ and verdict AGREE on the capped star.
{
  const r = check("(cap-1) 2 critics raving, raw ★4.8", [critic(4.8, 4.8), critic(4.8, 4.8)], NO_AUD);
  eq(r.tbsiScore, 9.6);
  eq(round1(r.tbsiScore! / 2), 4.8, "raw star would be 4.8");
  eq(r.star, 3.9, "capped just under the Must Watch line");
  eq(r.verdict, "Worth a Try", "★3.9 ⇒ Worth a Try — ★ and verdict agree");
  eq(r.credibleCriticCount, 2);
  eq(r.confidence, "medium");
}

// (cap-2) ONE credible critic (raw ★4.1) → ★3.9 "Worth a Try", confidence low
// (single-critic EARLY read).
{
  const r = check("(cap-2) 1 critic, raw ★4.1", [critic(4.1, 4.1)], NO_AUD);
  eq(r.tbsiScore, 8.2);
  eq(round1(r.tbsiScore! / 2), 4.1, "raw star would be 4.1");
  eq(r.star, 3.9);
  eq(r.verdict, "Worth a Try");
  eq(r.credibleCriticCount, 1);
  eq(r.confidence, "low", "a single credible critic is an EARLY read");
}

// (cap-3) SEVEN credible critics, same raw ★4.1 — evidence bar met (≥3) → NO cap →
// ★4.1 "Must Watch". Same raw star as cap-2, opposite outcome: evidence decides.
{
  const r = check("(cap-3) 7 critics, raw ★4.1", Array.from({ length: 7 }, () => critic(4.1, 4.1)), NO_AUD);
  eq(r.tbsiScore, 8.2);
  eq(r.star, 4.1, "uncapped — 7 credible critics clear the bar");
  eq(r.verdict, "Must Watch");
  eq(r.credibleCriticCount, 7);
  eq(r.confidence, "high");
}

// (cap-4) AUDIENCE OVERRIDE — 2 credible critics (raw ★4.2). With ≥1000 IMDb votes
// the 2-critic anchor substitutes for the 3rd → NO cap → "Must Watch". WITHOUT the
// votes the SAME ratings cap to ★3.9 → "Worth a Try". Both the anchor AND the vote
// floor are required, so a brigaded number alone can't mint a Must Watch.
{
  const ratings = [critic(4.3, 4.3), critic(4.3, 4.3)];
  const withVotes = check("(cap-4a) 2 critics + 5000 votes, raw ★4.2", ratings, aud(8.0, 5000));
  eq(withVotes.tbsiScore, 8.4);
  eq(withVotes.star, 4.2, "override holds the raw star");
  eq(withVotes.verdict, "Must Watch");
  eq(withVotes.credibleCriticCount, 2);
  eq(withVotes.confidence, "high");

  const noVotes = check("(cap-4b) SAME 2 critics, votes < 1000", ratings, aud(8.0, 300));
  eq(noVotes.tbsiScore, 8.4, "blend unchanged — votes gate the cap, not the score");
  eq(noVotes.star, 3.9, "no vote floor → cap fires");
  eq(noVotes.verdict, "Worth a Try");
  eq(noVotes.confidence, "medium");
}

// ════════════════════════════════════════════════════════════════════════════
// (2) SOURCE TIERING — Tier C + roundups excluded from consensus AND the count.
// ════════════════════════════════════════════════════════════════════════════

// (tier-1) [Tier-A 4/5, Tier-C(indian.community) 5/5]. The 5/5 rave farm is
// EXCLUDED: consensus uses the Tier-A 4/5 only (8.0, not the 9.0 a 2-rating median
// would give), and credibleCriticCount = 1 (not 2) → cap fires → "Worth a Try".
{
  const r = check("(tier-1) Tier-A 4/5 + Tier-C 5/5", [tierA(4, 4), tierC(5, 5)], NO_AUD);
  eq(r.credibleCriticCount, 1, "Tier C excluded from the credible count");
  eq(r.tbsiScore, 8.0, "consensus is the Tier-A 4/5 alone — rave farm dropped");
  eq(r.star, 3.9, "1 credible critic → cap fires");
  eq(r.verdict, "Worth a Try");
  eq(r.confidence, "low");
}

// (tier-2) [Tier-C only], WITH a strong audience signal (IMDb 9.0, 5000 votes).
// Zero credible critics → NO grounded score, regardless of audience. Audience can
// never anchor a verdict on its own (P3: critics anchor, audience corroborates).
{
  const r = check("(tier-2) Tier-C only + strong audience", [tierC(5, 5)], aud(9.0, 5000));
  eq(r.tbsiScore, null, "no credible critic → no score, even with strong audience");
  eq(r.star, null);
  eq(r.verdict, null);
  eq(r.confidence, "none");
  eq(r.credibleCriticCount, 0);
}

// (tier-3) MIXED Tier A/B/C + a social roundup. 4 ratings found, but only the
// Tier-A and Tier-B star reviews are credible (count = 2): the rave farm is
// dropped and the tweet roundup feeds AUDIENCE, not the critic axis. 2 credible
// critics, votes < 1000 → cap fires → ★3.9 "Worth a Try".
{
  const ratings = [tierA(4.5, 4.5), critic(4.0, 4.0), tierC(5, 5), roundup(4.0)];
  const r = check("(tier-3) A 4.5 + B 4.0 + C 5.0 + roundup", ratings, aud(7.5, 300));
  eq(r.credibleCriticCount, 2, "4 found → 2 credible (Tier C + roundup excluded)");
  eq(r.tbsiScore, 8.2);
  eq(round1(r.tbsiScore! / 2), 4.1, "raw star 4.1");
  eq(r.star, 3.9, "credible-count drop trips the cap");
  eq(r.verdict, "Worth a Try");
  eq(r.confidence, "medium");
}

// ════════════════════════════════════════════════════════════════════════════
// (4) CREDIBILITY = OUTLET, NOT PARSED SCORE — the overshoot fix + a regression
//     pin for the median sentiment-fallback.
// ════════════════════════════════════════════════════════════════════════════

// (cred-1) A SINGLE Tier-A review we couldn't parse a score from (explicit=null)
// → counts as 1 credible critic (the credible-requires-score build scored this 0).
// Still capped below Must Watch — one critic can't clear the ≥3 bar.
{
  const r = check("(cred-1) Tier-A sentiment-only ×1", [tierA(null, 4)], aud(7.0));
  eq(r.credibleCriticCount, 1, "named Tier-A review counts even with no parsed score");
  eq(r.tbsiScore, 7.7);
  eq(r.star, 3.9, "single credible critic → cap holds it under Must Watch");
  eq(r.verdict, "Worth a Try");
  eq(r.confidence, "low");
}

// (cred-2) THREE Tier-A sentiment-only reviews → 3 credible → CLEAR the ≥3 cap →
// can reach Must Watch when the star qualifies. Proves sentiment-only ratings
// count toward the evidence bar, not just toward the blend.
{
  const r = check("(cred-2) Tier-A sentiment-only ×3 (raving)", [tierA(null, 4), tierA(null, 4.5), tierA(null, 5)], NO_AUD);
  eq(r.credibleCriticCount, 3);
  eq(r.tbsiScore, 9.0);
  eq(r.star, 4.5, "≥3 credible clears the cap → star stands");
  eq(r.verdict, "Must Watch");
  eq(r.confidence, "high");
}

// (cred-3) REGRESSION PIN for the median sentiment-fallback. Three sentiment-only
// ratings with DISTINCT sentiments [2.0, 4.0, 4.5] → ×2 = [4, 8, 9]. The CRITIC
// consensus must be the MEDIAN of those, 8.0 (not the mean 7.0, not 0). If a
// future edit reintroduces `explicitScore!` (→ null*2 = 0), the consensus
// collapses to 0, tbsi crashes ~7.8 → ~1.1 and the verdict flips Worth-a-Try →
// Skip — so these assertions BREAK. That is the point: they lock the fallback in.
{
  const r = check("(cred-3) median sentiment-fallback pin", [tierA(null, 2.0), tierA(null, 4.0), tierA(null, 4.5)], NO_AUD);
  eq(r.credibleCriticCount, 3);
  eq(r.tbsiScore, 7.8, "consensus = median([4,8,9])=8 via sentiment fallback (NOT 0, NOT mean 7)");
  eq(r.star, 3.9);
  eq(r.verdict, "Worth a Try");
}

// (cred-4) Roundup STILL → audience, never credible — even under the relaxed rule.
// 1 Tier-A sentiment-only (credible) + 1 roundup (audience). The roundup lifts the
// blend but does NOT count toward credibility, so the lone credible critic trips
// the cap: raw ★4.2 → ★3.9.
{
  const r = check("(cred-4) Tier-A sentiment-only + roundup", [tierA(null, 4.0), roundup(4.5)], NO_AUD);
  eq(r.credibleCriticCount, 1, "roundup feeds audience, not the credible count");
  eq(r.tbsiScore, 8.4);
  eq(round1(r.tbsiScore! / 2), 4.2, "raw star 4.2 (roundup boosts the audience axis)");
  eq(r.star, 3.9, "only 1 credible critic → cap fires");
  eq(r.verdict, "Worth a Try");
  eq(r.confidence, "low");
}

// ════════════════════════════════════════════════════════════════════════════
// (5) TMDb VOTE FLOOR — a zero-vote tmdbVoteAverage (0.0) must NOT enter the
//     audience mean as a real 0/10 pan. Gated behind TMDB_FALLBACK_MIN_VOTES (50),
//     the same floor the stamp path uses.
// ════════════════════════════════════════════════════════════════════════════

// (tmdb-a) NOORU SAMI PIN — tmdbVoteAverage=0 on 0 votes, two sentiment-only
// credible critics at 7.5/10, no imdb/letterboxd. The phantom 0 is DROPPED →
// audienceScore null → blend re-normalizes over critic+tone → ★3.8 "Worth a Try".
// With the bug (0 counted) audience would be 0 → tbsi 4.9 → ★2.5 SKIP (the false Skip).
{
  const r = check("(tmdb-a) zero-vote TMDb (Nooru Sami)", [critic(null, 4), critic(null, 3.5)],
    aud(null, null, { tmdbVoteAverage: 0, tmdbVoteCount: 0 }));
  eq(r.tbsiScore, 7.5, "critic+tone only — phantom 0 dropped (would be 4.9 if counted)");
  eq(r.star, 3.8);
  eq(r.verdict, "Worth a Try", "leaves Skip once the phantom 0 is gone");
  eq(r.credibleCriticCount, 2);
  eq(r.confidence, "medium");
}

// (tmdb-b) REAL TMDb (control, Maa Inti shape) — tmdbVoteAverage=7 on 100 votes
// (≥ floor) → counts as a genuine audience signal. Unchanged behavior.
{
  const r = check("(tmdb-b) real TMDb (≥50 votes)", [critic(3, 3), critic(3, 3)],
    aud(null, null, { tmdbVoteAverage: 7, tmdbVoteCount: 100 }));
  eq(r.tbsiScore, 6.4, "tmdbAvg=7 counts (would be 6.0 if wrongly dropped)");
  eq(r.star, 3.2);
  eq(r.verdict, "Worth a Try");
  eq(r.credibleCriticCount, 2);
}

// (tmdb-c) BALAN SHAPE — real IMDb 8.3 + phantom tmdbVoteAverage=0/0 votes. Audience
// axis = 8.3 ALONE (not mean(8.3,0)=4.15). With 3 credible critics the un-halved
// audience lets it reach ★4.0 "Must Watch"; the bug (audience 4.15) caps it to ★3.3.
{
  const r = check("(tmdb-c) IMDb 8.3 + phantom TMDb 0 (Balan)", [critic(null, 4), critic(null, 4), critic(null, 3)],
    aud(8.3, null, { tmdbVoteAverage: 0, tmdbVoteCount: 0 }));
  eq(r.tbsiScore, 8.0, "audience = imdb 8.3 alone, NOT mean(8.3,0)=4.15");
  eq(r.star, 4.0);
  eq(r.verdict, "Must Watch", "un-halved audience clears Must Watch");
  eq(r.credibleCriticCount, 3);
  eq(r.confidence, "high");
}

// (tmdb-d) BELOW-FLOOR NONZERO — tmdbVoteAverage=6 on 10 votes (< 50) → dropped,
// not counted. Two credible critics at 8/10; audience drops out → ★3.9 "Worth a
// Try". If counted (audience=6) tbsi would fall 8.0 → 7.3.
{
  const r = check("(tmdb-d) below-floor TMDb (10 votes)", [critic(4, 4), critic(4, 4)],
    aud(null, null, { tmdbVoteAverage: 6, tmdbVoteCount: 10 }));
  eq(r.tbsiScore, 8.0, "10 votes < floor → tmdbAvg=6 dropped (would be 7.3 if counted)");
  eq(r.star, 3.9);
  eq(r.verdict, "Worth a Try");
  eq(r.credibleCriticCount, 2);
}

// ════════════════════════════════════════════════════════════════════════════
// (3) EXISTING FIXTURES re-run under the new gate (before/after reported).
// ════════════════════════════════════════════════════════════════════════════

// (a1) BOUNDARY ★4.0 — star↔verdict consistency at the Must Watch line. tbsi lands
// 7.9 → raw ★ rounds to 4.0. With 2 critics this now REQUIRES the vote floor to
// reach Must Watch; with ≥1000 votes the boundary holds: ★4.0 ⇒ "Must Watch".
// (OLD bug: 7.9 < 8.0 → "Worth a Try" while ★ showed 4.0 — the split. Still fixed.)
{
  const r = check("(a1) boundary ★4.0 (+1500 votes)", [critic(4.0, 3.5), critic(4.0, 3.5)], aud(8.0, 1500));
  eq(r.tbsiScore, 7.9);
  eq(r.star, 4.0);
  eq(r.verdict, "Must Watch", "★4.0 must be Must Watch, never Worth a Try");
  eq(r.confidence, "high");
  eq(r.credibleCriticCount, 2);
}

// (a2) INVERSE ★3.9 — a sub-4.0 score is unaffected by the cap (the cap only
// blocks ≥4.0). Stays "Worth a Try" with or without votes.
{
  const r = check("(a2) inverse ★3.9", [critic(4.0, 3.5), critic(4.0, 3.5)], aud(7.4));
  eq(r.tbsiScore, 7.7);
  eq(r.star, 3.9);
  eq(r.verdict, "Worth a Try", "★3.9 must be Worth a Try");
  eq(r.confidence, "medium");
}

// (b) OUTLIER — Bramayugam-shape set with one 1.5/5 dissent. 6 credible critics
// clear the evidence bar → no cap. Median consensus (8.5) holds the acclaimed tier
// against the dissent; OLD mean consensus (7.5) dragged it to "Worth a Try".
{
  const ratings = [4.5, 4.5, 4.0, 4.5, 3.5, 1.5].map(s => critic(s, s));
  const r = check("(b) outlier set", ratings, aud(8.5));
  eq(r.tbsiScore, 8.4);
  eq(r.star, 4.2);
  eq(r.verdict, "Must Watch", "median holds the tier despite the 1.5 dissent");
  eq(r.confidence, "high");
  eq(r.credibleCriticCount, 6);
  ok(ratings.some(x => x.explicitScore === 1.5), "1.5/5 dissent preserved in criticRatings");
}

// (c-high) Pennum Porattum — 2 explicit critics + strong audience. Under the new
// gate this needs the vote floor (≥1000) to stay Must Watch; with 4200 votes the
// 2-critic anchor + audience holds ★4.3 "Must Watch".
{
  const r = check("(c-high) Pennum Porattum (+4200 votes)", [critic(4.5, 4.5), critic(4.0, 4.0)], aud(8.8, 4200));
  eq(r.tbsiScore, 8.6);
  eq(r.star, 4.3);
  eq(r.verdict, "Must Watch");
  eq(r.confidence, "high");
  eq(r.credibleCriticCount, 2);
}

// (c-low) Single SENTIMENT-ONLY review from a real outlet. Credibility is the
// OUTLET's, not the parser's, so this counts as 1 credible critic → ★3.2 "Worth a
// Try", confidence low. (The credible-requires-a-parsed-score build wrongly made
// this 0-credible / no-score — the overshoot this build fixes. The cap still
// holds a lone critic below Must Watch.)
{
  const r = check("(c-low) one sentiment-only review", [critic(null, 3)], aud(7.0));
  eq(r.tbsiScore, 6.4);
  eq(r.star, 3.2);
  eq(r.verdict, "Worth a Try");
  eq(r.confidence, "low");
  eq(r.credibleCriticCount, 1, "a sentiment-only outlet review still counts as credible");
}

// (d) CLEAN consensus, no outlier — 4 credible critics, median == mean here, bar
// cleared → no cap. Stays "Must Watch" (the median change is a no-op on clean sets).
{
  const r = check("(d) clean consensus", [4.5, 4.0, 4.5, 4.0].map(s => critic(s, s)), aud(8.5));
  eq(r.tbsiScore, 8.5);
  eq(r.star, 4.3);
  eq(r.verdict, "Must Watch");
  eq(r.confidence, "high");
  eq(r.credibleCriticCount, 4);
}

// (c-none) found:false → no fabricated score (gate unchanged).
{
  const r = computeVerdictScore({ found: false, criticRatings: [] }, NO_AUD);
  console.log(`(c-none) not found\n  NEW  tbsi=${r.tbsiScore}  ★${r.star}  ${r.verdict}  (conf ${r.confidence})`);
  eq(r.tbsiScore, null);
  eq(r.star, null);
  eq(r.verdict, null);
  eq(r.confidence, "none");
  eq(r.credibleCriticCount, 0);
}

console.log(`\n✅ all ${assertions} assertions passed`);
