// src/reconcile/ai-review.ts
// AI-REVIEW tier — an ADVISORY, search-grounded fact-check that runs AFTER
// reconcile has tiered the films and BEFORE the gate writes the review. It does
// the external check a human would (is the release real? does the date hold? is
// it the right film?) and ANNOTATES each 🟢/🟡 film with a verdict + source so
// the human's final review is a glance at a pre-flagged page.
//
// AUTHORITY BOUNDARY: annotateWithAiReview changes NO tier and demotes NOTHING.
// It ATTACHES facts — the advisory `aiReview` verdict/reason/source PLUS the
// Phase-1 code-owned trust fields (`trust`, `sourceDomainTrust`, `platformFound`,
// `platformAgrees`) — and does the seam-#3 platform fact-fill. The SEPARATE
// enforceVerification pass (post-annotate, pre-gate) is the one that ACTS on
// those facts: PROMOTE a search-corroborated single-net 🟡 to effective-🟢,
// DEMOTE a contradicted/unconfirmed film (or an OTT film with no confirmed
// platform) out of the renderable pool, and SUPPRESS a conflicting platform. The
// verdict TEXT stays outside the gate hash; `aiDemoted` is folded in
// (filmFingerprint), so the approved review and what renders stay identical.
//
// Budget + determinism: ONE batched callClaudeJSON-with-web-search per edition
// (≤2/drop), CACHED by (version + window + reviewed-film projection). It now runs
// BEFORE the gate, on BOTH the review run AND the --approve re-run — but the
// re-run is a cache HIT (no LLM call), so verdicts / demotion / hash reproduce
// exactly and the ≤2-call budget holds. FAIL SOFT toward MORE caution: any call
// error annotates every reviewed film "unavailable" ("verify manually") and
// demotes NOTHING (an infra failure is not a verdict).

import { z } from "zod";
import { createHash } from "node:crypto";
import { callClaudeJSON } from "../content/claude.js";
import { cached } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { toPlatform } from "../shared/platform.js";
import { normalizeTitle } from "../discovery/normalize.js";
import { isManualAdd } from "./reconcile.js";
import type {
  AiReviewVerdict,
  ReconciledFilm,
  ReconcileResult,
  SourceDomainTrust,
  TrustVerdict,
} from "./types.js";

// The model returns these FOUR verdicts. "unavailable" is set only by fail-soft
// code here, never by the model.
//
// ── WD-ENG-21: tmdbId IS NULLABLE, AND `ref` IS THE REAL KEY ────────────────
// `tmdbId: z.number()` made a TMDb-less film UNASSESSABLE. Manual adds carry no
// tmdbId, the projection dropped the key entirely, the prompt demanded
// `"tmdbId": <number>`, and the model — correctly — returned null for Judaa and
// Brahmakamala. Schema validation failed; the retry "succeeded" by silently
// OMITTING both rows; they fell through to "not returned by AI-review" and were
// auto-removed as unconfirmed. Every manual add would have died that way, which
// makes the WD-ENG-11 contract ("AI-review MAY contradict a manual entry")
// unreachable: it could never assess one in the first place.
//
// Two changes, both deliberate:
//   · tmdbId is nullable AND optional — a null is now the honest answer for a
//     film that has no id, not a validation failure.
//   · `ref` is the row's real handle (see reviewRef): it exists for EVERY
//     reviewable film, TMDb-backed or not.
//
// NOT added: a `.refine()` requiring one of the two. That would re-introduce the
// exact failure class this closes — a hard schema failure that costs a billed
// retry and takes the whole edition's verdicts with it. A row that matches
// nothing degrades to the honest "not returned by AI-review" instead.
const VerdictSchema = z.object({
  /** The film's `ref` from the prompt, echoed back. The primary match key. */
  ref: z.string().nullable().optional(),
  /** TMDb id when the film has one; null/absent for operator-added films. */
  tmdbId: z.number().nullable().optional(),
  verdict: z.enum(["confirm", "doubt", "reject", "unverified"]),
  reason: z.string(),
  sourceUrl: z.string().optional(),
  // Seam #3 — the OTT streaming platform, ONLY when a source the search found
  // explicitly states it (fabrication-guarded; null otherwise). Orthogonal to the
  // verdict: it fact-fills a gap in release.platform, it does not judge the film.
  platform: z.string().nullable().optional(),
});
/**
 * Exported so the schema itself can be pinned directly. The mocked-transport
 * tests replace callClaudeJSON, which is where zod actually runs — so without a
 * test that parses a real payload through THIS object, the very validation that
 * broke gate 7c07f9ce0a38 would go uncovered.
 */
export const AiReviewSchema = z.object({
  reviews: z.array(VerdictSchema).default([]),
});

// ── Source-domain trust (Phase 1) — computed IN CODE, never by the LLM ───────
//
// The LLM is optimistic and cannot be trusted to judge its OWN sources. So the
// domain trust is decided here: a `confirm` whose ONLY cite is a denylisted
// piracy/mirror domain is NOT corroboration — code coerces it to `unconfirmed`
// regardless of what the model said (Issue 016: a film whose only date source
// was a Bangla piracy aggregator). The allowlist is trade press we trust to
// corroborate a single-net film (it feeds the promotion path). Both lists are
// CONSERVATIVE and trivially extensible — add a line, add a comment.

/** Piracy / mirror / low-trust aggregators. A `confirm` sourced ONLY here ⇒ unconfirmed. */
const DENYLIST_DOMAINS: string[] = [
  "mlsbd.tv", // Bangla piracy aggregator — Issue 016's lone date source for a film
];
/**
 * Mirror STEM patterns — piracy sites cycle TLDs/subdomains constantly, so an
 * exact-host list rots. Match the recognizable stem anywhere in the host. Keep
 * these tight (word-bounded) so a legit outlet is never swept in.
 */
const DENYLIST_PATTERNS: RegExp[] = [
  /(^|\.)ml[sw]bd\b/i, // mlsbd / mlwbd family (mlsbd.tv, mlsbd.shop, mlwbd.*, …)
  /(^|\.)(tamilrockers|tamilmv|movierulz|ibomma|filmyzilla|filmywap|9xmovies|katmovie|hdhub4u|vegamovies|sdmoviespoint|desiremovies|worldfree4u|skymovies)\b/i,
];
/** Trade press / mainstream outlets trusted to corroborate a single-net film. */
const ALLOWLIST_DOMAINS: string[] = [
  "pinkvilla.com",
  "bollywoodhungama.com",
  "variety.com",
  "thehindu.com",
  "hindustantimes.com",
  "filmibeat.com",
  "123telugu.com",
  "deccanchronicle.com",
  "indianexpress.com",
  "news9live.com",
  "keralatv.in",
];

/** Registrable-ish host (lowercased, www-stripped); undefined for a non-URL. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Classify a source URL's domain trust. A missing/unparseable URL is "unknown". */
export function classifyDomainTrust(url: string | undefined): SourceDomainTrust {
  const host = hostOf(url);
  if (!host) return "unknown";
  const suffixMatch = (d: string) => host === d || host.endsWith(`.${d}`);
  if (DENYLIST_DOMAINS.some(suffixMatch) || DENYLIST_PATTERNS.some((re) => re.test(host))) return "deny";
  if (ALLOWLIST_DOMAINS.some(suffixMatch)) return "allow";
  return "unknown";
}

/**
 * Map the raw AiVerdict + domain trust → the code-owned TrustVerdict. The ONE
 * place the denylist overrides LLM optimism: a `confirm` whose only source is
 * denylisted is downgraded to `unconfirmed`. "unavailable" never reaches here
 * (it stays uncertain, demotes nothing).
 */
function trustVerdictFor(verdict: AiReviewVerdict["verdict"], domainTrust: SourceDomainTrust): TrustVerdict {
  if (verdict === "confirm") return domainTrust === "deny" ? "unconfirmed" : "confirmed";
  if (verdict === "reject") return "contradicted";
  return "unconfirmed"; // doubt / unverified
}

/**
 * One model row, normalized. The source-stated `platform` rides WITH its verdict
 * (it used to live in a parallel map keyed by tmdbId, which no manual add has).
 */
interface RawReview {
  verdict: AiReviewVerdict["verdict"];
  reason: string;
  sourceUrl?: string;
  platform?: string;
}

/** The 🟢/🟡 films an edition submits for review (🔴 is gate-excluded; skip it). */
function reviewableFilms(r: ReconcileResult): ReconciledFilm[] {
  return r.reconciled.filter((f) => f.tier === "green" || f.tier === "yellow");
}

/**
 * WD-ENG-21 — THE STABLE HANDLE A REVIEW ROW ECHOES BACK.
 *
 * `Release.id` is the choice, and it is COLLISION-SAFE where the exact title is
 * not. Every reviewable film has a release (🔴 unverified leads are the only
 * release-less rows, and they are gate-excluded from review), and the id is
 * namespaced by origin: `tmdb-<id>` for a TMDb-backed film, `manual-<slug>` for
 * an operator add, `disc-<slug>` for a TMDb-less discovery find.
 *
 * TITLE WOULD NOT DO. Reconcile can legitimately hold two reviewable rows with
 * the same title — this very window had a TMDb "Judaa" (1649723, country-rejected
 * at ingest) alongside the operator's Punjabi "Judaa", and a week where the TMDb
 * one survives the country gate would give two 🟢/🟡 rows named "Judaa". Keying
 * on title would hand one film's verdict to the other. The `manual-` / `tmdb-`
 * prefixes make that impossible.
 *
 * The fallback exists only so this function is total; it is not expected to fire.
 */
export function reviewRef(f: ReconciledFilm): string {
  return f.release?.id ?? `t:${normalizeTitle(f.title)}`;
}

/**
 * Batch-unique refs, positionally aligned to `films`.
 *
 * Release ids are unique in practice, but "in practice" is not a guarantee worth
 * betting a verdict on: two manual entries whose titles normalize identically
 * would share `manual-<slug>`. A deterministic `#2` suffix keeps every submitted
 * row addressable without inventing a new identity scheme.
 */
export function reviewRefs(films: readonly ReconciledFilm[]): string[] {
  const seen = new Map<string, number>();
  return films.map((f) => {
    const base = reviewRef(f);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

/** Compact, fact-only projection of a film for the reviewer (no fabricated fields). */
function projectForReview(f: ReconciledFilm, ref: string) {
  return {
    ref,
    // WD-ENG-21 — `?? null` makes the ABSENCE EXPLICIT. Previously an undefined
    // tmdbId made JSON.stringify drop the key altogether, so the model saw a film
    // object with no id at all while the output spec demanded `<number>`. Stating
    // `null` is what lets it answer honestly instead of guessing or dropping the
    // row. For a film that HAS an id this is byte-identical to before.
    tmdbId: f.tmdbId ?? null,
    title: f.title,
    ...(f.resolvedTitle ? { resolvedTitle: f.resolvedTitle } : {}),
    ...(f.year !== undefined ? { year: f.year } : {}),
    language: f.language,
    ...(f.date ? { date: f.date } : {}),
    dateSource: f.dateSource,
    ...(f.platform ? { platform: f.platform } : {}),
    foundIn: f.foundIn,
    ...(f.sourceUrl ? { sourceUrl: f.sourceUrl } : {}),
  };
}

/** The exact JSON the reviewer sees — one projection per film, refs assigned. */
function projectAll(films: readonly ReconciledFilm[]) {
  const refs = reviewRefs(films);
  return films.map((f, i) => projectForReview(f, refs[i]!));
}

export function buildReviewPrompt(edition: string, windowLabel: string, films: ReconciledFilm[]): string {
  const filmsJson = JSON.stringify(projectAll(films), null, 2);
  return `You are a release fact-checker for The Big Screen Index. Using WEB SEARCH, you verify whether each film below is ACTUALLY releasing as claimed, in the stated window. You output DATA ONLY (strict JSON).

#1 RULE — BASE EVERY VERDICT ONLY ON WHAT WEB SEARCH RETURNS (most important):
- Use the WebSearch tool to check each film. Base your verdict ONLY on what you find in the search results — NOT on assumptions, memory, or the fact that the film was given to you.
- Cite a real sourceUrl (a URL you actually found in search) for every "doubt" and "reject", and for "confirm" where you can.
- If search cannot confirm the release, return verdict "unverified" with reason "couldn't confirm via search" and NO sourceUrl. NEVER invent, guess, or construct a URL.

YOU ASSESS ONLY — you do NOT rewrite anything:
- If a source shows a DIFFERENT date or cast, FLAG it in the reason (e.g. "source says August, not June — <url>"). Do NOT output a corrected date/cast/title. The film's data stays exactly as given to you.

PLATFORM (the ONE fact you MAY return, fabrication-guarded):
- If a source you found explicitly states the OTT streaming platform for this film, return it as \`platform\` (the platform's common name, e.g. "Netflix", "SonyLIV", "JioHotstar", "Prime Video"). If no source states a platform, return null. Never guess or infer the platform — it must be explicitly stated in a source you actually found.

OPERATOR-ADDED / TMDb-LESS FILMS — ASSESS THEM, NEVER SKIP THEM:
- Some films have \`"tmdbId": null\`. These are real films an operator entered by hand from trade press because no TMDb record exists for them. A null tmdbId is EXPECTED and is NOT a reason to doubt, reject, or omit a film.
- Assess them on exactly the same basis as every other film: what WEB SEARCH says about the release and the date. Their \`foundIn\` is \`["manual"]\`, which tells you no automated net found them — it tells you nothing about whether the release is real.
- For these, "is this the RIGHT film?" is a TITLE + LANGUAGE + DATE question, not an id question. Judge whether the film the press describes is the film described here.
- Return the row with \`"tmdbId": null\`. Do NOT invent an id, do NOT substitute a same-title film's id, and do NOT drop the row because you have no id for it.

FOR EACH FILM, check via search:
- Is this release actually CONFIRMED to happen in ${windowLabel}? (Official announcement / trade press / CBFC clearance — vs. stalled, postponed, cancelled, or "expected".)
- Does the DATE hold up? (Does the press corroborate the given date, or a different one?)
- Is this the RIGHT film? (Does the title / language / year — and the TMDb id where one is given — match the film actually releasing, not a same-title different film?)

SEARCH STRATEGY — release dates CHANGE, and old articles dominate generic results:
- Do NOT rely on one generic "<title> release date" query per film. Dates get preponed/postponed, and months-old SEO articles often outrank the newer announcement — a generic query can show you ONLY the stale date.
- For each film ALSO run recency-targeted queries, e.g. "<title> release date latest", "<title> release date postponed preponed new date", "<title> release date <current month and year>".
- Check the PUBLICATION DATE of each result and weight the most recently PUBLISHED authoritative source. A generic "<title> release date" query alone is NEVER sufficient basis for a "reject".

DATE RECENCY — when sources DISAGREE on the date, prefer the NEWER report, but ONLY when it is AUTHORITATIVE (bias toward KEEPING real films):
- Release dates are often announced months ahead and then changed, so a newer report can override older ones. BUT recency alone is NOT enough: weight RECENT + AUTHORITATIVE sources (official studio/distributor, trade press, CBFC, or the platform itself) over BOTH older announcements AND recent low-authority chatter (fan posts, rumor aggregators, unsourced "reportedly"). A recent RUMOR does NOT override an older OFFICIAL confirmation — when they conflict, that is "doubt", not "reject".
- Return "reject" on a date basis ONLY for a CONFIRMED negative from a recent authoritative source:
  (a) it gives a NEW release date you can place CLEARLY OUTSIDE ${windowLabel} — a concrete date after the window's end, NOT "TBA" / "delayed indefinitely" / a vague "early/mid/late <month>" that could still fall in the window; OR
  (b) the film ALREADY RELEASED on THIS pillar's own platform/region BEFORE this window. A prior THEATRICAL, festival, or other-region release does NOT disqualify a later OTT or wider release that lands in the window — that staggered in-window arrival is exactly what we want, so "confirm" (or "doubt") it, never "reject" on that basis.
- REJECT-SAFETY when the film's GIVEN date is already INSIDE ${windowLabel}: rejecting on a date basis ADDITIONALLY requires the out-of-window source to be CLEARLY NEWER (by publication date) than the given date's information. A single out-of-window date whose recency you CANNOT establish as newer is "doubt", NOT "reject" — the given in-window date may itself be the later change (preponed/re-dated films look exactly like this). If you cannot confirm you have the LATEST word on the date, return "doubt" — it keeps the film for the human; "reject" removes it silently.
- Everything short of that is "doubt", not "reject": a postponement with no concrete new date, an imprecise new date that might still fall in the window, two equally-recent sources that disagree, or a recent-but-unofficial claim against an official one. When unsure, prefer "doubt" — it keeps the film for the human to judge, whereas "reject" auto-removes it.

VERDICTS (exactly one per film):
- "confirm": search corroborates the release AND the date.
- "doubt": search found an UNRESOLVED reason for concern — a contested date where no source is clearly newer AND more authoritative, a postponement with no confirmed out-of-window date, an imprecise date that may still fall in the window, an open CBFC/legal issue, or a wrong-film risk. Cite the source.
- "reject": a recent AUTHORITATIVE source shows the release is NOT happening in this window — stalled, cancelled, a different film, a CONFIRMED new date clearly outside ${windowLabel}, or an earlier release on THIS pillar's own platform/region. Cite the recent source.
- "unverified": search returned nothing usable. reason = "couldn't confirm via search". NO sourceUrl.

FILMS (${edition} edition · window ${windowLabel}):
${filmsJson}

OUTPUT — STRICT JSON ONLY (no prose, no markdown). Exactly ONE entry per film above — same count, same order — keyed by its \`ref\`:
{ "reviews": [ { "ref": "<copy the film's ref string EXACTLY>", "tmdbId": <number or null>, "verdict": "confirm|doubt|reject|unverified", "reason": "...", "sourceUrl": "https://...", "platform": "Netflix|null" } ] }
- \`ref\` is REQUIRED on every row and must be copied character-for-character from the film above. It is how each verdict is matched back to its film.
- \`tmdbId\` mirrors the film's value: the number when it has one, \`null\` when it does not.
- NEVER omit a film. If you could not assess one, return it with verdict "unverified" — a missing row is treated as a failure to assess and removes the film.`;
}

/**
 * Cache version for the RAW AI-review output ({reviews}). BUMP only when the
 * review PROMPT (buildReviewPrompt) or the AiReviewSchema SHAPE changes — a
 * cached blob would otherwise no longer mean what a fresh call produces. The
 * discipline-guard + auto-demote mapping run FRESH outside the cache, so changing
 * those needs NO bump. (Mirrors RESEARCH_CACHE_VERSION.)
 */
// v3: search-strategy guidance + in-window reject-safety added to buildReviewPrompt.
// v4: WD-ENG-21 — `ref` added to the projection and required in the output, tmdbId
//     nullable, and the operator-added section added to the prompt. Both the prompt
//     AND the schema shape moved, so every v3 blob is stale by definition.
export const AI_REVIEW_CACHE_VERSION = "v4";

/** Verdicts are stable within a drop cycle; a same-day --approve must hit. */
const AI_REVIEW_CACHE_TTL_HOURS = 24;

/**
 * Stable cache key over the EXACT reviewer input (the projected 🟢/🟡 films) +
 * window + version. Identical input ⇒ identical cached verdicts ⇒ identical
 * demotion ⇒ identical gate hash (the --approve determinism spine). ANY data
 * change to a reviewable film changes the projection ⇒ new key ⇒ a fresh call
 * (and the gate hash changes too, correctly forcing a re-review).
 */
function reviewCacheKey(r: ReconcileResult, films: ReconciledFilm[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(projectAll(films)))
    .digest("hex")
    .slice(0, 16);
  return `ai-review:${AI_REVIEW_CACHE_VERSION}:${r.pillar}:${r.window.start}-${r.window.end}:${digest}`;
}

/** Fail-soft annotation: every reviewed film gets "unavailable" → pushes the operator to look closer. */
function markUnavailable(films: ReconciledFilm[]): void {
  for (const f of films) {
    f.aiReview = { verdict: "unavailable", reason: "AI-review unavailable — verify manually" };
  }
}

/**
 * Review ONE edition's 🟢/🟡 films with a single web-search-grounded call, and
 * attach the verdicts. Never throws — on any failure the edition's films are
 * marked "unavailable".
 */
async function reviewEdition(r: ReconcileResult): Promise<void> {
  const films = reviewableFilms(r);
  if (films.length === 0) return;

  const windowLabel = `${r.window.start} → ${r.window.end}`;
  try {
    const prompt = buildReviewPrompt(r.pillar, windowLabel, films);
    // CACHE the raw model output, keyed by the exact reviewer input. The review
    // run misses (one live web-search call); the --approve re-run hits (no call)
    // → identical verdicts → identical demotion → identical gate hash. The mapping
    // + demotion below run FRESH outside the cache (mirrors verdict-research).
    let miss = false;
    const out = await cached(
      reviewCacheKey(r, films),
      async () => { miss = true; return callClaudeJSON(prompt, AiReviewSchema, "opus", { webSearch: true }); },
      { ttlSeconds: AI_REVIEW_CACHE_TTL_HOURS * 3600 }
    );

    // WD-ENG-21 — TWO indexes, and the raw platform now rides WITH its verdict
    // instead of in a parallel map keyed by an id a manual add does not have.
    // `ref` is the primary key (it exists for every reviewable film); tmdbId is
    // kept as a fallback so a model that echoes only the id still matches, which
    // is what keeps numeric-tmdbId behaviour identical to before.
    const byRef = new Map<string, RawReview>();
    const byId = new Map<number, RawReview>();
    for (const v of out.reviews) {
      const raw: RawReview = {
        verdict: v.verdict,
        reason: v.reason,
        ...(v.sourceUrl ? { sourceUrl: v.sourceUrl } : {}),
        ...(v.platform ? { platform: v.platform } : {}),
      };
      if (v.ref) byRef.set(v.ref, raw);
      if (typeof v.tmdbId === "number") byId.set(v.tmdbId, raw);
    }

    const refs = reviewRefs(films);
    let assessed = 0;
    for (const [i, f] of films.entries()) {
      const v = byRef.get(refs[i]!) ?? (f.tmdbId !== undefined ? byId.get(f.tmdbId) : undefined);
      if (v) {
        // Discipline guard: a doubt/reject with no source reads as a bare claim —
        // downgrade to "unverified" so it never looks authoritative without a cite
        // (this is ALSO what guarantees every actionable 🛑 carries a source).
        let review: AiReviewVerdict;
        if ((v.verdict === "doubt" || v.verdict === "reject") && !v.sourceUrl) {
          review = { verdict: "unverified", reason: `${v.reason} (no source cited)` };
        } else {
          review = {
            verdict: v.verdict,
            reason: v.reason,
            ...(v.sourceUrl ? { sourceUrl: v.sourceUrl } : {}),
          };
        }
        // Phase 1 — code-owned TRUST fields (the enforcement axis). The denylist
        // overrides LLM optimism here: a confirm sourced only from a piracy/mirror
        // domain becomes `unconfirmed`. These annotate; enforceVerification acts.
        review.sourceDomainTrust = classifyDomainTrust(review.sourceUrl);
        review.trust = trustVerdictFor(review.verdict, review.sourceDomainTrust);
        f.aiReview = review;

        // Structured PLATFORM fact (Phase 1). platformFound = what a found source
        // stated; platformAgrees = whether it matches our EXISTING platform,
        // computed against release.platform BEFORE the seam-#3 fill so a real
        // conflict is visible (press says X, our data says Y). A found platform
        // that maps to no enum can't be compared → leave platformAgrees undefined.
        const rawFound = v.platform;
        if (rawFound) {
          review.platformFound = rawFound;
          const foundEnum = toPlatform(rawFound);
          if (foundEnum && f.release && f.release.platform.length > 0) {
            review.platformAgrees = f.release.platform.includes(foundEnum);
          }
        }

        // Seam #3 — LAST-RESORT platform fill. Only for the OTT edition, and only
        // when release.platform is still EMPTY (JustWatch/stub/reconcile — seams
        // 1-2 — always win). Verdict-independent: a source-stated platform is a
        // fact regardless of the date verdict. Enum-normalized via toPlatform; an
        // unmappable/absent name leaves [] (the honest "STREAMING TBA" path).
        if (r.pillar === "ott" && f.release && f.release.platform.length === 0) {
          const p = toPlatform(rawFound);
          if (p) f.release.platform = [p];
        }
        assessed++;
      } else {
        // Call succeeded but this film wasn't returned — never silently blank.
        f.aiReview = { verdict: "unverified", reason: "not returned by AI-review", trust: "unconfirmed", sourceDomainTrust: "unknown" };
      }
    }
    log.info(`AI-review [${r.pillar}]: ${assessed}/${films.length} films assessed via web search${miss ? "" : " (cache hit)"}`);
  } catch (err) {
    log.warn(`AI-review [${r.pillar}] failed — marking films unavailable`, err instanceof Error ? err.message : err);
    markUnavailable(films);
  }
}

/**
 * Annotate every edition's 🟢/🟡 films with an advisory AI-review verdict. Runs
 * the two editions in parallel (independent calls). Mutates the films in place
 * (attaching `aiReview`) and returns the same results array for chaining. Never
 * throws — the whole tier fails soft to "unavailable" so the review still writes.
 */
export async function annotateWithAiReview(results: ReconcileResult[]): Promise<ReconcileResult[]> {
  const total = results.reduce((n, r) => n + reviewableFilms(r).length, 0);
  if (total === 0) return results;
  log.info(`\n🔬 AI-review — fact-checking ${total} 🟢/🟡 film(s) via web search (verdicts feed enforcement; changes no tier)...`);
  await Promise.all(results.map((r) => reviewEdition(r)));
  return results;
}

// ── Enforcement (Phase 2) — post-annotate, pre-gate. PURE + deterministic ────
//
// Reads only the facts annotate attached (no LLM, no Date/random) so a
// review-run and its --approve re-run enforce IDENTICALLY (the raw verdicts ride
// the 24h review cache upstream). Mutates films in place: aiDemoted / aiPromoted
// / platformSuppressed. It only ever TIGHTENS render — the ONE promotion turns a
// search-corroborated single-net 🟡 into effective-🟢 for the auto-publish
// predicate, but never adds a film to the rendered SET (a 🟡 already renders on
// --approve).

export interface EnforceOptions {
  /**
   * When true (WED_DROP_REQUIRE_PLATFORM default), an OTT-edition film with no
   * platform after all nets — including a platform SUPPRESSED for conflict — is
   * NOT renderable. Theatrical is unaffected.
   */
  requireOttPlatform: boolean;
}

/**
 * A 🟡 whose SOLE yellow-driver is `single-net` — no ambiguous match, possible
 * duplicate, date conflict, or manifest warn riding alongside. Only such a film
 * may be promoted by a mere search-confirm (Refinement 1): a 🟡 carrying a
 * real data problem must still face the human.
 */
function singleNetIsSoleYellowDriver(f: ReconciledFilm): boolean {
  // ── WD-ENG-21 — A MANUAL ADD IS NEVER PROMOTED, WHATEVER SEARCH SAYS ──────
  // WD-ENG-11 fixed the manual dial at YELLOW and said outright that no evidence
  // basis upgrades it: "corroboration reassures, it never promotes." Until now
  // that held by accident — a manual add could not receive a verdict at all, so
  // it could not reach this predicate. Making it assessable makes this branch
  // REACHABLE, and a manual add satisfies every other condition below (yellow,
  // foundIn ["manual"] ⇒ single-net, no ambiguity/duplicate/conflict, landing
  // pass). One search `confirm` would therefore set aiPromoted, and
  // isEffectiveGreen in gate.ts returns true on `!!f.aiPromoted` ALONE — so a
  // confirmed operator assertion could carry the whole drop into UNATTENDED
  // auto-publish. That is precisely the outcome WD-ENG-11 and WD-ENG-19 both
  // forbade, and it would have shipped as a side effect of a schema fix.
  //
  // The verdict is still attached, still shown to the operator, and a
  // CONTRADICTION still removes the film — assessment is unaffected. Only the
  // upgrade is refused.
  if (isManualAdd(f)) return false;

  const singleNet = !(f.foundIn.includes("tmdb") && f.foundIn.includes("ai-net"));
  return (
    f.tier === "yellow" &&
    singleNet &&
    !f.ambiguousMatch &&
    !f.possibleDuplicate &&
    !f.conflictDetail &&
    f.landingStatus !== "warn"
  );
}

type DemotionClass = "contradicted" | "unconfirmed" | "platform-conflict" | "no-platform";

function demote(
  f: ReconciledFilm,
  demotionClass: DemotionClass,
  reason: string,
  sourceUrl?: string
): void {
  f.aiDemoted = {
    originalTier: f.tier,
    verdict: f.aiReview!.verdict,
    reason,
    demotionClass,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

/**
 * ENFORCE the annotated verdicts across both editions. Order per film:
 *   1. SUPPRESS a conflicting platform (platformAgrees === false) on BOTH
 *      editions — clear it, record both values for the audit, never substitute.
 *   2. Act on the trust verdict: contradicted / unconfirmed → DEMOTE;
 *      confirmed → PROMOTE iff single-net is the sole yellow-driver and the
 *      source isn't denylisted.
 *   3. OTT platform requirement: a still-confirmed OTT film left with no
 *      platform → DEMOTE, with a TRUTHFUL reason (platform-conflict names both
 *      values; otherwise no-platform).
 * "unavailable" (infra failure) films are skipped — they demote nothing and (via
 * decideGate) force the manual gate.
 */
export function enforceVerification(results: ReconcileResult[], opts: EnforceOptions): void {
  for (const r of results) {
    const isOtt = r.pillar === "ott";
    for (const f of r.reconciled) {
      const ar = f.aiReview;
      if (!ar || ar.verdict === "unavailable" || !ar.trust) continue; // uncertain / not reviewed → leave for the human

      // 1) PLATFORM CONFLICT — suppress (never auto-substitute). Both editions.
      if (ar.platformAgrees === false && f.release && f.release.platform.length > 0) {
        f.platformSuppressed = { was: f.release.platform.join("/"), pressPlatform: ar.platformFound ?? "?" };
        f.release.platform = [];
      }

      // 2) TRUST verdict.
      if (ar.trust === "contradicted") {
        demote(f, "contradicted", ar.reason, ar.sourceUrl);
      } else if (ar.trust === "unconfirmed") {
        demote(f, "unconfirmed", ar.reason, ar.sourceUrl);
      } else {
        // confirmed → maybe promote a clean single-net 🟡 (the search is net #2).
        if (singleNetIsSoleYellowDriver(f) && ar.sourceDomainTrust !== "deny") {
          f.aiPromoted = {
            reason: "search-corroborated (single-net 🟡 confirmed by web search)",
            ...(ar.sourceUrl ? { sourceUrl: ar.sourceUrl } : {}),
          };
        }
      }

      // 3) OTT platform requirement — only reaches still-confirmed films.
      if (!f.aiDemoted && isOtt && opts.requireOttPlatform && f.release && f.release.platform.length === 0) {
        if (f.platformSuppressed) {
          demote(
            f,
            "platform-conflict",
            `platform conflict (JustWatch: ${f.platformSuppressed.was}, press: ${f.platformSuppressed.pressPlatform})`
          );
        } else {
          demote(f, "no-platform", "no OTT platform confirmed by any net");
        }
      }
    }
  }
}
