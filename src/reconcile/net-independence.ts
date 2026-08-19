// src/reconcile/net-independence.ts
// WHAT COUNTS AS A SECOND OPINION — and what only looks like one.
//
// ── WHY THIS EXISTS (WD-ENG-19) ─────────────────────────────────────────────
// The tier rule used to read `foundIn.includes("tmdb") && foundIn.includes("ai-net")`
// against a foundIn that was HARDCODED to that pair. So District — which
// independently confirmed Hushar Pittalu's date and language off its own
// ticketing catalogue — could not count, while a scraped press headline could.
// That is backwards on evidence quality, and it made the tier misreport how well
// evidenced a film actually was.
//
// ── INDEPENDENCE IS ENCODED, NOT ASSUMED ────────────────────────────────────
// The failure mode this file exists to prevent is FALSE corroboration: two nets
// agreeing because they read the same upstream. WD-ENG-15 found the clearest
// case — JustWatch resells TMDb's provider data, so wiring both would have
// manufactured agreement out of one source. It was never wired, but the lesson
// is encoded here rather than remembered.
//
// The subtle live case is PRESS. The ai-net searches the open web via Tavily,
// the news net reads Google News RSS, and the ott-calendar net reads a Filmibeat
// roundup. All three can — and demonstrably do — surface the SAME article. Two
// press nets agreeing is ONE observation reported twice, so they share a class
// and cannot corroborate each other. That is a deliberate TIGHTENING relative to
// counting raw net names.
//
// A class is "who actually observed the release", not "which module fetched it".
export type IndependenceClass = "tmdb" | "wikipedia" | "district" | "press";

/**
 * net tag → independence class. Tags absent from this map do not count toward
 * corroboration at all, which is the safe default:
 *
 *   · "omdb" / "mdblist" / "tmdb-search" are ENRICHMENT, not discovery. They
 *     describe a film the pool already had; they never found one.
 *   · "manual" is an operator assertion. WD-ENG-11 fixed it at yellow and said
 *     no evidence basis promotes it — so it must not contribute a class either,
 *     or a manual add plus one net would reach green through the back door.
 */
const CLASS_OF: Readonly<Record<string, IndependenceClass>> = {
  // Algorithmic catalogues — each its own upstream.
  tmdb: "tmdb",
  wikipedia: "wikipedia",
  district: "district",
  // PRESS — one class, deliberately. Tavily, Google News and the Filmibeat
  // roundup all read the same open web and routinely surface the same story.
  "ai-net": "press",
  "ai-ott": "press",
  news: "press",
  "ott-calendar": "press",
};

/** The distinct independent classes a film's provenance actually represents. */
export function independenceClasses(foundIn: readonly string[]): Set<IndependenceClass> {
  const out = new Set<IndependenceClass>();
  for (const tag of foundIn) {
    const c = CLASS_OF[tag];
    if (c) out.add(c);
  }
  return out;
}

/** How many genuinely independent sources observed this film. */
export function independentNetCount(foundIn: readonly string[]): number {
  return independenceClasses(foundIn).size;
}

/**
 * THE TIER RULE (WD-ENG-19). Two or more independent classes corroborate.
 *
 * Note what this does NOT change: tmdb + ai-net is {tmdb, press} = 2, so every
 * film that was green before is still green. What it adds is tmdb + district
 * — the Hushar Pittalu case — and what it removes is ai-net + news, which was
 * never reachable before but would have been once discovery provenance started
 * flowing through.
 */
export function isCorroborated(foundIn: readonly string[]): boolean {
  return independentNetCount(foundIn) >= 2;
}

/**
 * THE AUTO-PUBLISH RULE (WD-ENG-19 PART 3). DELIBERATELY NARROWER THAN THE TIER.
 *
 * This is today's eligibility, unchanged and unwidened: TMDb plus the reconcile
 * ai-net. Publishing with no human in the loop is a strictly higher bar than
 * reporting a film as well-evidenced, and the operator's ruling was to widen the
 * tier WITHOUT widening what ships unattended.
 *
 * 🔴 DO NOT COLLAPSE THIS INTO isCorroborated / the green check. They are two
 * different questions:
 *     isCorroborated      → "how well evidenced is this film?"   (tier, review)
 *     isAutoPublishEligible → "may this ship with nobody looking?" (gate only)
 * A test asserts they are distinct call sites for exactly this reason.
 */
export function isAutoPublishEligible(foundIn: readonly string[]): boolean {
  return foundIn.includes("tmdb") && foundIn.includes("ai-net");
}

/**
 * Discovery tags that may enter a ReconciledFilm's foundIn. Enrichment tags
 * (omdb, mdblist, tmdb-search) are filtered out here so provenance means
 * "who found it", never "who decorated it".
 */
export function discoveryTagsOf(sources: readonly string[] | undefined): string[] {
  return [...new Set((sources ?? []).filter((s) => s in CLASS_OF))];
}
