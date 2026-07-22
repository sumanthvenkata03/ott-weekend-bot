// src/content/news/news-score.ts
// NEWS DESK · C — DETERMINISTIC scoring. No I/O, no LLM, no clock: every input
// that moves a number is a printable field on ScoredCluster, so the shadow-week
// scoring table IS the audit trail. Nothing here is tuned in secret.
//
// Four signals feed the score:
//   class          — keyword-matched story type (editable table below)
//   tier           — outlet credibility, from the EXISTING verdict-research registry
//   cross-outlet   — how many DISTINCT outlets carry the same story (clustered
//                    by normalized-title token overlap)
//   judged overlap — does the story name a film we've already judged (★ chip)
//
// TIER MATCHING IS NAME-PRIMARY (ruling R2 + the gather-layer finding): Google
// News <link> is always a news.google.com redirect, so hostOf() is useless on a
// gathered item. We import the EXPORTED registry data constants and run a local
// matcher over the <source> NAME (host still checked, for the day an item
// arrives with a real URL). We never fabricate a CriticRating to reach tierOf()
// — that type demands explicitScore/sentimentScore a headline cannot supply.

import { TIER_A_SOURCES, TIER_C_SOURCES } from "../weekend/verdict-research.js";
import type { NewsItem } from "./news-gather.js";
import type { JudgedFilm } from "../../jobs/reddit-radar.js";

export type OutletTier = "A" | "B" | "C";

/**
 * Story classes — EDITABLE. Order is significant: the first match wins, so the
 * SUPPRESSORS sit at the top. `weight` feeds the score; `suppressed` drops the
 * cluster out of the edition entirely regardless of tier or coverage.
 *
 * The two suppressors encode ruling R3, both drawn from real feed samples:
 *   roundup  — "'Oh..! Sukumari' Twitter review", netizen/public-talk pieces.
 *              Same CONCEPT as verdict-research's ROUNDUP_RE (audience noise is
 *              not a critic anchor); its own regex, because that one is tuned
 *              for review pages and this one for headlines.
 *   listicle — "OTT Releases This Week", "12 Best OTT Movies…", weekly guides
 *              and date-range wraps. These are aggregation, not news: they
 *              report no event, so they can never be verified as one.
 */
export const STORY_CLASSES: ReadonlyArray<{
  name: string;
  re: RegExp;
  weight: number;
  suppressed?: boolean;
}> = [
  // ── suppressors (R3) ──────────────────────────────────────────────────────
  {
    name: "roundup",
    re: /twitter review|\btweets?\b|netizen|public[-\s]?talk|fan[-\s]?reaction|audience[-\s]?reaction|social[-\s]?media reaction/i,
    weight: 0,
    suppressed: true,
  },
  {
    name: "listicle",
    re: new RegExp(
      [
        // Weekly-wrap furniture
        String.raw`\b(this week|this weekend|the weekend)\b`,
        String.raw`\bott releases\b`,
        String.raw`\bnew releases\b`,
        String.raw`\bwhat to watch\b`,
        // Ranked lists
        String.raw`\b\d+\s+best\b`,
        String.raw`\btop\s+\d+\b`,
        // "5 Priyanka Chopra-Produced Movies …" / "6 New Films …"
        String.raw`\b\d+\s+(?:[\w'’-]+\s+){0,4}(?:movies|films|shows|series|titles|picks)\b`,
        // "…7 titles to watch" / "…10 things streaming"
        String.raw`\b\d+\s+(?:[\w'’-]+\s+){0,4}(?:to watch|streaming)\b`,
        // Catalogue pages
        String.raw`movies\s*&\s*web series`,
        String.raw`streaming online`,
        // Date-range wraps: "(July 13 - July 19)"
        String.raw`\([A-Za-z]+ \d+\s*[-–]\s*[A-Za-z]+ \d+\)`,
        // PIPE-STUFFED SEO headlines: 2+ pipe-delimited segments
        // ("… | Prime Video, Netflix, Sonyliv, Jiohotstar, Zee5 …").
        String.raw`(?:\|[^|]{2,}){2,}`,
      ].join("|"),
      "i"
    ),
    weight: 0,
    suppressed: true,
  },
  // ── real story classes, strongest first ───────────────────────────────────
  { name: "obituary",     re: /passes? away|passed away|\bdemise\b|no more at \d+|dies at|dead at \d+/i, weight: 5 },
  // RUMOR sits ABOVE the factual classes on purpose: "reportedly locks a release
  // date" is a rumour about a date, not a date. Misordering it would let
  // unconfirmed trade chatter render as a RADAR announcement.
  { name: "rumor",        re: /\breportedly\b|\bin talks\b|\brumou?r|\bbuzz is\b|\bsaid to be\b|\bspeculation\b/i, weight: 2 },
  // `national (film )?awards?` — the ruled fix. The 2026-07-18 shadow run missed
  // "72nd National Awards: Complete list of winners is here" (classed `general`,
  // weight 1) because the old matcher required the literal "national film award".
  // Outlets drop "Film" freely; the score gap that caused cost the day's edition
  // its CAROUSEL.
  { name: "awards",       re: /national (film )?awards?|filmfare|\boscars?\b|academy award|\bwins? best\b|award (winners?|ceremony)|bags? (top honours?|national award)/i, weight: 4 },
  { name: "ott-date",     re: /\bott (release|debut|premiere)\b|when and where to watch|streaming (from|on) [A-Z]|digital (release|premiere)/i, weight: 4 },
  { name: "release-date", re: /release date|to (release|hit) (on|theatres|theaters)|theatrical release|locks? (its )?release|confirms? release/i, weight: 3 },
  { name: "boxoffice",    re: /box office|\bcollections?\b|\d+\s*crore|worldwide gross|day \d+ (collection|box)/i, weight: 3 },
  { name: "trailer",      re: /\btrailer\b|\bteaser\b|first look|\bglimpse\b|motion poster/i, weight: 2 },
  { name: "casting",      re: /roped in|joins the cast|to star|signs (on|up)|next film with|cast(ing)? (announcement|update)/i, weight: 2 },
];

/** Class assigned when no keyword matches — real, but weakly newsworthy. */
export const DEFAULT_CLASS = { name: "general", weight: 1, suppressed: false } as const;

// ── TUNING CONSTANTS — all printed in the run's scoring table (R2). ──────────

/** Points by best outlet tier in the cluster. Tier C is a penalty, not a zero. */
export const TIER_POINTS: Record<OutletTier, number> = { A: 3, B: 1, C: -3 };

/** Distinct-outlet bonus is min(outlets - 1, this) — coverage saturates. */
export const MAX_CROSS_OUTLET_BONUS = 4;

/** Bonus when the story names a film we've already judged (★ chip earned). */
export const JUDGED_BONUS = 2;

/** Token-overlap ratio at/above which two headlines are the SAME story. */
export const CLUSTER_MIN_OVERLAP = 0.45;

/**
 * VERIFICATION-ELIGIBILITY FLOOR (ruling R2) — N1 given teeth at the INPUT, not
 * just the output. A cluster reaches news-verify only if:
 *   (a) it carries at least one Tier-A outlet, OR
 *   (b) it has broad multi-outlet coverage (≥ this many DISTINCT outlets) AND
 *       no Tier-C anchor.
 * Everything else is held before we spend a verification slot on it. This is
 * what excludes the untiered single-outlet SEO story (the Mshale case).
 */
export const TIER_FLOOR_BROAD_OUTLETS = 3;

/** A confirmed story at/above this score makes the edition a CAROUSEL. */
export const BIG_SCORE_THRESHOLD = 9;

// ── INDIA-SCOPE GATE (Mastul's lesson, news edition) ────────────────────────
//
// The Mastul case: a Bangladeshi film was admitted on a Bengali-language ticket
// and reached a published deck. Language is not nationality. The feeds are
// India-shaped but not India-only — a Google News query for "Bengali cinema"
// returns Dhaka, and an OTT query returns K-drama listicles.
//
// This runs BEFORE verification, deterministically, so an out-of-scope story
// never spends a verification slot (that call is the expensive step).
//
// FAIL-OPEN BY DESIGN: in-scope requires an Indian marker, but a borderline
// story with no foreign marker stays IN. A false hold is invisible — the story
// silently never appears. A false admit is caught by the editor, who is the
// final gate. Wrong-and-visible beats wrong-and-silent.

/**
 * Indian-cinema markers — EDITABLE. Any one admits the story.
 *
 * "bengali" was REMOVED. It is the one language marker that is not evidence of
 * Indian cinema: Bengali is the national language of Bangladesh, so "Bengali
 * cinema" admitted Dhaka stories on an Indian ticket — and because the Indian
 * list is checked first, that admission beat the "dhaka"/"bangladeshi" foreign
 * markers sitting right below it. Removing it does not blind the gate to West
 * Bengal: "india"/"indian"/"kolkata-tagged trade terms still admit, and the
 * fail-open branch admits anything unmarked. Nationality proper is now enforced
 * downstream by shared/country-gate.ts at news-resolve.
 */
export const INDIA_SCOPE_MARKERS: readonly string[] = [
  // The editorial languages that are unambiguously Indian markers
  "telugu", "tamil", "malayalam", "kannada", "hindi", "marathi",
  // Industry names
  "tollywood", "kollywood", "bollywood", "mollywood", "pollywood", "sandalwood",
  // Nation / region
  "india", "indian", "desi", "punjabi", "bhojpuri", "south indian",
  // Indian platform + trade context
  "zee5", "aha", "sunnxt", "sun nxt", "jiohotstar", "hotstar", "sonyliv",
  "hoichoi", "manoramamax", "chaupal", "etv win", "nizam", "ott india",
  "crore", "lakh", "box office india",
];

/**
 * EXCLUSIVE foreign markers — EDITABLE. Present AND no Indian marker ⇒ out of
 * scope. Kept tight: these are cues that a story is about a NON-Indian
 * industry, not merely that a foreign name appears.
 */
export const FOREIGN_SCOPE_MARKERS: readonly string[] = [
  "k-drama", "kdrama", "korean drama", "korean film", "korean movie",
  "j-drama", "jdrama", "japanese drama", "anime series",
  "c-drama", "chinese drama", "thai drama", "turkish drama",
  "hollywood", "marvel", "dc studios", "netflix original series us",
  "bangladeshi", "dhaka", "pakistani", "lollywood",
  "hallyu", "bts", "blackpink", "squid game",
];

export interface ScopeVerdict {
  inScope: boolean;
  /** Printable — which marker decided it. */
  reason: string;
}

/**
 * Decide whether a story is Indian-cinema news. PURE. `text` should be the
 * headline plus its outlet names (an outlet like "Varnam Malaysia" is not a
 * scope signal, but "123telugu" is).
 */
export function indiaScope(text: string): ScopeVerdict {
  const t = text.toLowerCase();
  const indian = INDIA_SCOPE_MARKERS.filter((m) => t.includes(m));
  const foreign = FOREIGN_SCOPE_MARKERS.filter((m) => t.includes(m));

  if (indian.length > 0) {
    return { inScope: true, reason: `Indian marker: ${indian.slice(0, 2).join(", ")}` };
  }
  if (foreign.length > 0) {
    return { inScope: false, reason: `foreign marker with no Indian marker: ${foreign.slice(0, 2).join(", ")}` };
  }
  // Fail open — no marker either way is not evidence of foreignness.
  return { inScope: true, reason: "no scope marker either way — fail-open, editor decides" };
}

// ── Outlet tiering (local matcher over the EXPORTED registry data) ───────────

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function matchesRegistry(
  reg: { domains: string[]; names: string[] },
  host: string,
  name: string
): boolean {
  return (
    (host !== "" && reg.domains.some((d) => host === d || host.endsWith(`.${d}`))) ||
    (name !== "" && reg.names.some((n) => name.includes(n)))
  );
}

/**
 * Tier of a gathered item from its outlet name (+ host when one is available).
 * `news.google.com` is ignored as a host so a redirect stub never matches — the
 * name carries the decision.
 */
export function tierOfOutlet(url: string, source: string): OutletTier {
  const rawHost = hostOf(url);
  const host = rawHost === "news.google.com" ? "" : rawHost;
  const name = source.toLowerCase();
  if (matchesRegistry(TIER_C_SOURCES, host, name)) return "C";
  if (matchesRegistry(TIER_A_SOURCES, host, name)) return "A";
  return "B";
}

// ── Class matching ───────────────────────────────────────────────────────────

export interface StoryClass {
  name: string;
  weight: number;
  suppressed: boolean;
}

/** First-match-wins class for a headline. PURE. */
export function classify(title: string): StoryClass {
  for (const c of STORY_CLASSES) {
    if (c.re.test(title)) {
      return { name: c.name, weight: c.weight, suppressed: c.suppressed === true };
    }
  }
  return { ...DEFAULT_CLASS };
}

// ── Clustering ───────────────────────────────────────────────────────────────

/** Headline noise that carries no story identity. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "from",
  "with", "by", "is", "are", "was", "were", "be", "as", "it", "its", "this",
  "that", "his", "her", "their", "how", "what", "when", "where", "who", "why",
  "new", "out", "up", "you", "your", "s", "movie", "film", "says", "said",
]);

/**
 * Headline → comparable token set. Lowercased, punctuation stripped, stopwords
 * dropped, and crudely singularized (trailing "s" off tokens longer than 3) so
 * "wins"/"win" and "awards"/"award" cluster — the single highest-value
 * normalization on real headlines, and cheap enough to stay obvious.
 */
export function titleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
  return new Set(words);
}

/**
 * Overlap ratio = |A∩B| / min(|A|,|B|). Deliberately NOT Jaccard: a terse
 * headline ("Raayan Wins Best Tamil Film at National Awards") and a long one
 * covering the same event are the same story, and Jaccard's union denominator
 * punishes exactly that asymmetry. PURE.
 */
export function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / Math.min(a.size, b.size);
}

export interface Cluster {
  /** Stable id for the verification round-trip. */
  id: string;
  /** Highest-tier item's headline — the cluster's public face. */
  headline: string;
  items: NewsItem[];
  /** Distinct outlet names across the cluster. */
  outlets: string[];
}

/**
 * Greedy SINGLE-LINK clustering: each item joins the first cluster containing
 * ANY member it overlaps at/above CLUSTER_MIN_OVERLAP, else opens its own.
 *
 * Single-link (vs. comparing only against the cluster's first member) is a
 * structural choice, not a tuning knob, and it is load-bearing. Real coverage of
 * one event fans out in vocabulary: the long "72nd National Film Awards |
 * 'Raayan,' 'Amaran' bag top honours; 'Meiyazhagan'…'Maharaja' miss marquee
 * categories" headline overlaps the first-filed story at only 0.444 — a hair
 * under threshold — but overlaps the terser "Raayan Wins Best Tamil Film at
 * National Awards" at 0.5. Chaining through the shorter headline is what makes
 * it one story. Lowering the threshold to catch that pair directly would have
 * loosened EVERY comparison to fix one; this fixes the shape instead.
 *
 * Greedy is the right call for the rest: the sets are small (tens of items), the
 * signal is strong (shared proper nouns), and a deterministic single pass is
 * trivially testable where a centroid re-fit is not.
 */
export function clusterItems(items: NewsItem[]): Cluster[] {
  const clusters: { items: NewsItem[]; tokenSets: Set<string>[] }[] = [];

  for (const item of items) {
    const tokens = titleTokens(item.title);
    const home = clusters.find((c) =>
      c.tokenSets.some((t) => overlapRatio(tokens, t) >= CLUSTER_MIN_OVERLAP)
    );
    if (home) {
      home.items.push(item);
      home.tokenSets.push(tokens);
    } else {
      clusters.push({ items: [item], tokenSets: [tokens] });
    }
  }

  return clusters.map((c, i) => {
    // The public face is the best-tiered item, tie-broken by earliest published
    // (the outlet that broke it), so the headline is stable across runs.
    const ranked = [...c.items].sort((x, y) => {
      const tx = TIER_POINTS[tierOfOutlet(x.url, x.source)];
      const ty = TIER_POINTS[tierOfOutlet(y.url, y.source)];
      if (tx !== ty) return ty - tx;
      return Date.parse(x.publishedISO) - Date.parse(y.publishedISO);
    });
    return {
      id: `c${i + 1}`,
      headline: ranked[0]!.title,
      items: c.items,
      outlets: [...new Set(c.items.map((it) => it.source).filter((s) => s !== ""))],
    };
  });
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface ScoredCluster {
  id: string;
  headline: string;
  language: string;
  items: NewsItem[];
  outlets: string[];
  outletCount: number;
  bestTier: OutletTier;
  hasTierC: boolean;
  storyClass: string;
  classWeight: number;
  suppressed: boolean;
  tierPoints: number;
  crossOutletPoints: number;
  judgedTitle: string | null;
  judgedPoints: number;
  score: number;
  /** Passes the R2 eligibility floor — may spend a verification slot. */
  eligible: boolean;
  /** Why it was held, when it was. Empty string when eligible. */
  holdReason: string;
}

const BEST_TIER = (tiers: OutletTier[]): OutletTier =>
  tiers.includes("A") ? "A" : tiers.includes("B") ? "B" : "C";

/**
 * Score every cluster and stamp its eligibility. PURE — `judged` is passed in
 * (the caller reads the archive), so this whole module is driveable off
 * fixtures with no filesystem and no clock.
 */
export function scoreClusters(
  clusters: Cluster[],
  judged: JudgedFilm[],
  findJudged: (title: string, films: JudgedFilm[]) => JudgedFilm | null
): ScoredCluster[] {
  const scored = clusters.map((c) => {
    const tiers = c.items.map((it) => tierOfOutlet(it.url, it.source));
    const bestTier = BEST_TIER(tiers);
    const hasTierC = tiers.includes("C");
    const cls = classify(c.headline);

    const outletCount = c.outlets.length;
    const tierPoints = TIER_POINTS[bestTier];
    const crossOutletPoints = Math.min(Math.max(outletCount - 1, 0), MAX_CROSS_OUTLET_BONUS);

    const judgedFilm = findJudged(c.headline, judged);
    const judgedPoints = judgedFilm ? JUDGED_BONUS : 0;

    const score = cls.suppressed
      ? 0
      : cls.weight + tierPoints + crossOutletPoints + judgedPoints;

    // Eligibility floor (R2) — evaluated in order so holdReason names the FIRST
    // thing that disqualified it.
    // Scope is checked against the headline PLUS the outlet names: "123telugu"
    // carrying a story is itself an Indian-cinema signal.
    const scope = indiaScope(`${c.headline} ${c.outlets.join(" ")}`);

    let eligible = true;
    let holdReason = "";
    if (cls.suppressed) {
      eligible = false;
      holdReason = `suppressed class: ${cls.name}`;
    } else if (!scope.inScope) {
      // Held BEFORE verification — an out-of-scope story never spends a slot.
      eligible = false;
      holdReason = `out of scope — not Indian cinema (${scope.reason})`;
    } else if (bestTier === "A") {
      eligible = true;
    } else if (outletCount >= TIER_FLOOR_BROAD_OUTLETS && !hasTierC) {
      eligible = true;
    } else if (hasTierC) {
      // Reached only when bestTier is B or C — the Tier-A branch above already
      // returned, so no `bestTier !== "A"` guard is needed (or type-correct).
      eligible = false;
      holdReason = "Tier-C anchor without a Tier-A source";
    } else {
      eligible = false;
      holdReason = `below tier floor (no Tier-A, ${outletCount} outlet${outletCount === 1 ? "" : "s"} < ${TIER_FLOOR_BROAD_OUTLETS})`;
    }

    return {
      id: c.id,
      headline: c.headline,
      language: c.items[0]!.language,
      items: c.items,
      outlets: c.outlets,
      outletCount,
      bestTier,
      hasTierC,
      storyClass: cls.name,
      classWeight: cls.weight,
      suppressed: cls.suppressed,
      tierPoints,
      crossOutletPoints,
      judgedTitle: judgedFilm ? judgedFilm.title : null,
      judgedPoints,
      score,
      eligible,
      holdReason,
    } satisfies ScoredCluster;
  });

  // Highest score first; ties broken by coverage then id, so the order is total
  // and a re-run reproduces it exactly.
  return scored.sort(
    (a, b) => b.score - a.score || b.outletCount - a.outletCount || a.id.localeCompare(b.id)
  );
}
