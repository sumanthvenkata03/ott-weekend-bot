// src/reconcile/types.ts
// Shared shapes for the Wed Drop reconciliation layer. No I/O here — pure types.
//
// Provenance discipline (locked): the AI-search net contributes
// title / language-hint / platform / date / source ONLY. Cast, poster, and the
// canonical title ALWAYS come from TMDb — never the LLM. A film with no TMDb
// match stays "unverified" and carries title + source only (no fabricated
// fields), and is hard-pinned 🔴 (cannot pass the gate, even in auto mode).

import type { Platform, Release } from "../shared/types.js";

/** Review tier. green = clean + cross-net corroborated, yellow = one issue, red = blocked. */
export type Tier = "green" | "yellow" | "red";

/** A snippet citation the LLM must attach to every extracted film. */
export interface ExtractedSource {
  url: string;
  snippet?: string;
}

/**
 * One film as extracted from the AI-net snippets. The LLM may ONLY populate
 * title / language / platform / date / source / confidence — never cast,
 * synopsis, or poster (those come from TMDb downstream). `sources` is required
 * (>=1) so nothing is ever emitted without provenance.
 */
export interface ExtractedFilm {
  title: string;
  language?: string;
  platform?: string;
  date?: string;
  /** Every distinct date the snippets attach to this film — so conflicts are visible. */
  datesSeen?: string[];
  isSeries: boolean;
  sources: ExtractedSource[];
  confidence?: "high" | "medium" | "low";
}

/**
 * A rejected lead, surfaced in the review for auditability. `reason` is the
 * category (e.g. "series", "non-Indian-language"); originalLanguage + sourceUrl
 * are carried when known so a reviewer can see WHY without re-deriving it.
 */
export interface RejectedExtraction {
  title?: string;
  reason: string;
  originalLanguage?: string;
  sourceUrl?: string;
}

export interface DateConflictExtraction {
  title?: string;
  datesSeen?: string[];
  note?: string;
}

/** Full output of ONE per-edition extraction call (the only new LLM use). */
export interface ExtractionResult {
  films: ExtractedFilm[];
  rejected: RejectedExtraction[];
  dateConflict: DateConflictExtraction[];
}

/** Resolution status after the TMDb cross-check. */
export type ReconStatus = "confirmed" | "unverified" | "series-rejected";

/** Landing-window verdict, mirroring the post-validator's pass/warn/fail. */
export type LandingStatus = "pass" | "warn" | "fail";

/**
 * AI-review verdict (advisory). The first FOUR come from the search-grounded
 * model; "unavailable" is set by fail-soft code when the review call errors.
 *   confirm     — search corroborates the release + date
 *   doubt       — search found a reason for concern (cite sourceUrl)
 *   reject      — search shows it is NOT releasing as claimed (cite sourceUrl)
 *   unverified  — search returned nothing usable ("couldn't confirm", no source)
 *   unavailable — the review call failed; verify manually (NEVER a pass)
 */
export type AiVerdict = "confirm" | "doubt" | "reject" | "unverified" | "unavailable";

/**
 * Trust verdict (Phase 1) — the ENFORCEMENT axis, computed IN CODE (never by the
 * LLM) from the raw AiVerdict + the source-domain trust. Orthogonal to the
 * display AiVerdict/glyph, which stays as-is.
 *   confirmed    — a confirm backed by a non-denylisted source
 *   contradicted — a sourced reject (a confident negative)
 *   unconfirmed  — doubt / unverified, OR a confirm whose ONLY source is
 *                  denylisted (piracy/mirror) — code refuses to trust it
 * NB: an "unavailable" (infra failure) film gets NO trust verdict — it is
 * uncertain, demotes nothing, and forces the manual gate.
 */
export type TrustVerdict = "confirmed" | "contradicted" | "unconfirmed";

/**
 * Source-domain trust tier (Phase 1), computed in code from the sourceUrl host.
 *   allow   — trade press / mainstream outlet (can corroborate a single-net film)
 *   deny    — piracy / mirror / low-trust aggregator (never counts as corroboration)
 *   unknown — neither list (a real but unclassified source)
 */
export type SourceDomainTrust = "allow" | "deny" | "unknown";

/**
 * Advisory AI-review annotation. The DISPLAY verdict/reason/source ANNOTATE only
 * and stay OUTSIDE the gate hash. The Phase-1 trust fields (`trust`,
 * `sourceDomainTrust`, `platformFound`, `platformAgrees`) are the structured,
 * code-computed inputs the SEPARATE enforcement pass (enforceVerification) acts
 * on. The reviewer may FLAG a wrong date/cast in `reason` but must NOT rewrite
 * the film's date/cast/title.
 */
export interface AiReviewVerdict {
  verdict: AiVerdict;
  reason: string;
  /** A real URL found via search — required for doubt/reject; absent for unverified/unavailable. */
  sourceUrl?: string;
  /** Trust verdict computed in code (Phase 1). Absent for "unavailable" (uncertain). */
  trust?: TrustVerdict;
  /** Domain-trust of sourceUrl (Phase 1): allow=trade press, deny=piracy/mirror, unknown=neither. */
  sourceDomainTrust?: SourceDomainTrust;
  /** The OTT platform a found source explicitly stated (structured; Phase 1). */
  platformFound?: string;
  /**
   * Whether `platformFound` AGREES with the film's existing release.platform.
   * `false` ⇒ a platform CONFLICT (press says X, our data says Y) — enforcement
   * SUPPRESSES the platform (never auto-substitutes). Absent when there is no
   * existing platform to compare against (seam-#3 fills that case instead).
   */
  platformAgrees?: boolean;
  /**
   * WD-ENG-22A — WHERE THIS VERDICT CAME FROM. "ledger" marks a verdict replayed
   * from a persisted CONFIRM (shared/verdict-ledger.ts) instead of a fresh
   * search. Absent ⇒ the model produced it on this run.
   *
   * ADVISORY ONLY, like the verdict text beside it: nothing enforces on this
   * field, it is not in the gate hash, and a ledger-sourced verdict carries the
   * SAME trust/sourceDomainTrust a billed one would have, so enforcement's
   * behaviour is provenance-blind by construction.
   */
  provenance?: "ledger";
  /**
   * WD-ENG-22B — `confirmed_at` of the ledger row this verdict was replayed
   * from, so the review can render "ledger - confirmed <date>" without parsing
   * it back out of `reason`. Present only alongside `provenance: "ledger"`.
   * Display only; not enforced on, not hashed.
   */
  ledgerConfirmedAt?: number;
}

/**
 * One reconciled, provenance-tagged, tiered film — the review payload AND the
 * unit the gate decides on. `release` is the Release record fed to the renderer
 * (absent for unverified / series — they carry title + source only).
 */
export interface ReconciledFilm {
  // Identity / display
  tmdbId?: number;
  title: string;              // display title (TMDb canonical when resolved, else AI title)
  language: string;
  // Pillar LABEL — value-stable widen from WedDropEdition to string so any pillar
  // can be verified. Wednesday keeps the exact values "theatrical"/"ott", so the
  // gate hash (filmFingerprint joins this) is unchanged.
  pillar: string;

  // AI-net contributed (title / platform / date / source only)
  platform?: string;
  date?: string;
  dateSource: "tmdb" | "press" | "none";
  sourceUrl?: string;
  confidence?: "high" | "medium" | "low";

  // Provenance + tier
  /**
   * Which DISCOVERY nets found this film — threaded from Release.sources, not
   * hardcoded (WD-ENG-19). May contain tmdb / wikipedia / district / ai-net /
   * news / ott-calendar, or exactly ["manual"] for an operator add. Tiering
   * counts INDEPENDENT classes over this (net-independence.ts); auto-publish
   * reads it through its own, narrower predicate.
   */
  foundIn: string[];
  status: ReconStatus;
  landingStatus?: LandingStatus;
  /** The precise landing-check reason from assessDates (e.g. "no qualifying date"). */
  landingReason?: string;
  tier: Tier;
  reasons: string[];          // human-readable "why this tier"

  /**
   * WD-ENG-20 — the row(s) folded into this one because they shared its tmdbId.
   * Present ONLY on a merged row. Provenance for the review: it names the
   * spellings and language variants the deck no longer shows separately, so a
   * collapsed pair is visible as a merge rather than as a film that vanished.
   */
  mergedVariants?: Array<{ title: string; language: string; foundIn: string[] }>;

  // Flags
  possibleDuplicate?: boolean;
  ambiguousMatch?: boolean;
  ottDateFromPress?: boolean;
  wasBelowCap?: boolean;
  conflictDetail?: string;

  /**
   * WD-ENG-11B — set ONLY on an operator manual-add. Its presence is what the
   * narrow tier bypass in assignTier keys on, and what the review artifact
   * renders as OPERATOR-ADDED. Absent on every other film.
   */
  manualAdd?: {
    evidenceBasis: "wiki-list" | "platform-official" | "trade-press";
    /** True only for wiki-list, and only when the index actually contained it. */
    verified: boolean;
    /** True for platform-official / trade-press — nothing machine-checked these. */
    assertion: boolean;
    sourceUrls: string[];
    posterSourceUrl?: string;
    /** Pre-rendered label, so review / manifest / logs cannot word it differently. */
    label: string;
  };

  // TMDb-resolved enrichment (NEVER from the LLM)
  resolvedTitle?: string;
  posterUrl?: string;
  cast?: string[];
  year?: number;

  /**
   * AI-review annotation (advisory). Attached before the gate (Step 1), for
   * 🟢/🟡 films. The verdict TEXT stays OUTSIDE the gate hash and is NOT read by
   * assignTier / decideGate / renderableFor — it only renders into the review.
   * The SEPARATE `aiDemoted` field below is its one actionable consequence.
   */
  aiReview?: AiReviewVerdict;

  /**
   * ENFORCEMENT DEMOTION. Set by enforceVerification when a reviewed 🟢/🟡 film
   * is NOT verification-clean — a `contradicted` (sourced reject), an
   * `unconfirmed` (doubt / unverified / denylist-only confirm), or a platform
   * failure (a `platform-conflict` on an OTT card, or `no-platform` when
   * WED_DROP_REQUIRE_PLATFORM is on). Folded into the gate hash (filmFingerprint
   * appends `|demoted:<verdict>`) and read by renderableFor: a demoted film is
   * REMOVED from the renderable pool. `originalTier` is preserved so the review
   * shows what was pulled (e.g. "🟡→🛑"). `sourceUrl` is optional — an
   * `unconfirmed`/`no-platform` demotion has no cite. `demotionClass` drives the
   * audit reason so it is always truthful (never a generic "no platform").
   */
  aiDemoted?: {
    originalTier: Tier;
    verdict: AiVerdict;
    reason: string;
    sourceUrl?: string;
    demotionClass?: "contradicted" | "unconfirmed" | "platform-conflict" | "no-platform";
  };

  /**
   * ENFORCEMENT PROMOTION. Set by enforceVerification when a 🟡 whose ONLY
   * yellow-driver is `single-net` is corroborated by a non-denylisted search
   * `confirm` — the web search IS the second net, so it becomes effective-🟢 for
   * the auto-publish predicate. NOT folded into the gate hash: it never changes
   * the renderable SET (a 🟡 already renders on --approve), only the auto/gate
   * decision. Recorded for the Slack audit.
   */
  aiPromoted?: {
    reason: string;
    sourceUrl?: string;
  };

  /**
   * PLATFORM-CONFLICT SUPPRESSION. Set by enforceVerification when a found source
   * states a platform that DISAGREES with release.platform. The platform is
   * cleared (release.platform = []) so the card renders the honest Streaming-TBA
   * path — never auto-substituted. Both values are recorded so the audit line
   * names them ("JustWatch: X, press: Y"). On an OTT card this then trips the
   * WED_DROP_REQUIRE_PLATFORM demote (a contradicted platform defeats the whole
   * point of a Now-Streaming card); theatrical keeps suppression only.
   */
  platformSuppressed?: {
    was: string;
    pressPlatform: string;
  };

  /**
   * WD-ENG-22B — THE FLIP MARKER. Set when this run's BILLED verdict disagrees
   * with an EXPIRED verdict-ledger row for the same film: the same search
   * question, asked a fortnight apart, answered two different ways.
   *
   * WD-ENG-22A logged that event; this makes it structured so the auto-publish
   * contract can refuse on it (auto-contract.ts, CLAUSE 3). An unstable verdict
   * is exactly what must not ship unattended — whichever reading is right, the
   * search is telling us it cannot answer this film consistently.
   *
   * `ref` is carried ON the marker rather than re-derived, so auto-contract.ts
   * needs no import of ai-review.ts (which would drag the LLM client into the
   * gate's import graph for the sake of one string).
   *
   * NOT IN THE GATE HASH. filmFingerprint hashes provenance and enforcement
   * outcomes, never advisory verdict data — a flip changes whether the drop may
   * ship UNATTENDED, and changes nothing about what an approved run renders. A
   * test pins that adding this field leaves computeDropHash value-stable.
   */
  verdictFlip?: {
    /** The ledger key (bare reviewRef) the flip was observed on. */
    ref: string;
    /** The verdict the expired row held. */
    previous: AiVerdict;
    /** What the fresh, billed search returned instead. */
    current: AiVerdict;
    /** The expired row's `expires_at`, epoch ms. */
    expiredAt: number;
  };

  /**
   * PLATFORM CONFIRMATION FILL (WD-ENG-03, "seam #3"). Set when this entry's
   * platform STRING was AI-review-confirmed and copied into an empty
   * release.platform, before enforcement classified the film. The counterpart to
   * platformSuppressed above: that one clears a contradicted platform, this one
   * lands a confirmed one that never crossed the field boundary.
   *
   * `skipped` records tokens that are not Platform members ("SimplySouth") —
   * they are never coerced, and their absence from the card is visible here and
   * in the gate review rather than being discovered on a published post.
   */
  platformFilled?: {
    /** The entry string the platforms were parsed out of. */
    from: string;
    platforms: Platform[];
    skipped: string[];
  };

  // The renderer-bound record (absent for unverified / series).
  release?: Release;
}

export interface ReconcileCounts {
  total: number;
  green: number;
  yellow: number;
  red: number;
  addedByAiNet: number;       // real films TMDb discovery missed (ai-net only, confirmed)
  flagged: number;            // yellow + red
}

export interface ReconcileResult {
  pillar: string;
  window: { start: string; end: string };
  reconciled: ReconciledFilm[];          // full annotated list (augment-only; nothing dropped)
  rejected: RejectedExtraction[];        // series / non-film / non-Indian-language
  counts: ReconcileCounts;
  /**
   * WD-ENG-22B — this edition's verdict-ledger tally, recorded by
   * annotateWithAiReview so the Notion review header can state it. Absent when
   * the edition had no reviewable film (no consult happened).
   *
   * Review rendering only: computeDropHash reads `reconciled` film fingerprints
   * and never touches the result envelope, so this cannot reach the gate hash.
   */
  ledgerStats?: { hit: number; billed: number; voided: number };
}
