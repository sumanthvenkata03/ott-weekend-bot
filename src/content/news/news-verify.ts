// src/content/news/news-verify.ts
// NEWS DESK · D — VERIFICATION. Law N1 lives here: a headline reaches the draft
// as CONFIRMED with a citable sourceUrl, or it is HELD with a stated reason.
// There is no third state and no "probably".
//
// Mirrors the ai-review discipline (ruling R5): ONE batched callClaudeJSON with
// web search per run, wrapped in cached() so a same-day re-run is a cache HIT
// (no second call, identical verdicts). Schema validation + retry-once come free
// from the transport (callClaudeJSON re-prompts once on a zod failure).
//
// CODE OVERRIDES MODEL OPTIMISM — the ai-review lesson, applied to receipts
// rather than domains: a `confirmed: true` whose sourceUrl is missing,
// unparseable, or just points back at the aggregator (news.google.com) is NOT a
// receipt, and this module demotes it to held regardless of what the model said.
// The model can report; it cannot self-certify.
//
// FAIL SOFT toward SILENCE: any error holds EVERY story. An infra failure is not
// a confirmation, and a quiet day is a legal outcome (N4) — so there is never a
// reason to publish through a broken verifier.

import { z } from "zod";
import { createHash } from "node:crypto";
import { callClaudeJSON } from "../claude.js";
import { cached } from "../../shared/cache.js";
import { log } from "../../shared/logger.js";
import type { ScoredCluster } from "./news-score.js";

/** Verification slots per run — the batched call covers at most this many. */
export const MAX_VERIFIED_STORIES = 5;

const CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * A HELD story legitimately has no receipt. Requiring `sourceUrl: string`
 * unconditionally meant every run containing an unconfirmed story failed schema
 * validation and burned the retry — ~2 minutes of wall clock, observed live,
 * for a response that was editorially correct.
 *
 * So the field is optional/nullable IN THE SHAPE, and the receipt rule moves
 * into a refinement: `confirmed: true` still REQUIRES a non-empty string. The
 * requirement did not loosen — it moved to where it is actually true. Nothing
 * can be confirmed without a receipt, and applyReceiptRule then re-checks that
 * the URL is a real, non-aggregator page.
 */
/**
 * A film the story is ABOUT, as the primary page prints it. This is what makes
 * multi-film art possible: an awards story names many films, and a register
 * quadrant needs one per film, not one per story.
 *
 * `title` must be verbatim from the page — the resolver's sanity gate compares
 * it against TMDb, so a paraphrase becomes a rejection. `note` is that film's
 * ROLE in this story, which becomes the quadrant's gold fact line.
 */
const FilmRefSchema = z.object({
  title: z.string(),
  note: z.string(),
});

const StoryVerdictSchema = z
  .object({
    id: z.string(),
    confirmed: z.boolean(),
    sourceUrl: z.string().nullish(),
    basis: z.string(),
    /** Present on CONFIRMED stories that are about films; omitted otherwise. */
    films: z.array(FilmRefSchema).max(6).optional(),
  })
  .refine((v) => !v.confirmed || (typeof v.sourceUrl === "string" && v.sourceUrl.trim() !== ""), {
    message: "confirmed=true requires a non-empty sourceUrl — a confirmation without a receipt is not a confirmation",
    path: ["sourceUrl"],
  });
export const NewsVerifySchema = z.object({
  stories: z.array(StoryVerdictSchema).default([]),
});

/** A film named by the verified page, with its role in this story. */
export interface FilmRef {
  title: string;
  note: string;
}

export interface VerifiedStory {
  cluster: ScoredCluster;
  confirmed: boolean;
  /** Citable receipt — non-empty ONLY when confirmed. */
  sourceUrl: string;
  basis: string;
  /** Films the page names. Empty for held or person-only stories. */
  films: FilmRef[];
}

/** Aggregator/redirect hosts that can never serve as a receipt. */
const NON_RECEIPT_HOSTS = ["news.google.com", "google.com", "bing.com"];

/**
 * A sourceUrl is a receipt only if it is a real http(s) URL on a host that
 * isn't the aggregator we gathered from. PURE.
 */
export function isReceipt(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return !NON_RECEIPT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Apply N1 in code to one model verdict. Exported for the suite: this is the
 * rule that must never silently loosen.
 */
export function applyReceiptRule(v: {
  confirmed: boolean;
  sourceUrl: string;
  basis: string;
}): { confirmed: boolean; sourceUrl: string; basis: string } {
  if (!v.confirmed) {
    return { confirmed: false, sourceUrl: "", basis: v.basis || "model reported unconfirmed" };
  }
  if (!isReceipt(v.sourceUrl)) {
    return {
      confirmed: false,
      sourceUrl: "",
      basis: `confirmed without a citable source (${v.sourceUrl || "no url"}) — held by receipt rule`,
    };
  }
  return { confirmed: true, sourceUrl: v.sourceUrl, basis: v.basis };
}

function buildPrompt(clusters: ScoredCluster[]): string {
  const list = clusters
    .map((c) => {
      const outlets = c.outlets.join(", ");
      return `- id: ${c.id}\n  headline: ${c.headline}\n  reported by: ${outlets}\n  language: ${c.language}`;
    })
    .join("\n");

  return `You are fact-checking Indian film-industry headlines for an editorial desk.

For EACH story below, use web search to establish whether the event it reports ACTUALLY HAPPENED, and return a verdict.

STORIES:
${list}

RULES — read them as hard constraints:
1. "confirmed": true ONLY if you found a page from a real news outlet that independently states the same fact. Not the headline restated — the fact, on a page you actually retrieved.
2. "sourceUrl": the direct URL of that page. It MUST be the outlet's own URL. Never a news.google.com link, never a search-results page, never a homepage. If you cannot produce such a URL, "confirmed" MUST be false — and then "sourceUrl" may be null or omitted entirely. Do NOT invent a placeholder URL to fill the field.
3. "basis": ONE line, max 20 words, stating what you found — name the outlet. If unconfirmed, state what was missing (e.g. "only aggregator copies found, no primary outlet page").
4. Do NOT confirm from your own prior knowledge. A fact you remember but could not retrieve is UNCONFIRMED.
5. Return exactly one entry per id given. Do not invent ids.
6. FIGURES. If the headline's CENTRAL claim is a number (a box-office total, a deal value, a percentage drop) and your sources disagree on that number, set "confirmed": false and say which sources conflict — the story IS the figure, so an unsettled figure is an unsettled story. If the figure is INCIDENTAL to an event that is itself confirmed, confirm the event and mark the figure as an estimate in "basis" ("an estimated ...").

7. "films": for a CONFIRMED story ABOUT one or more films, list them (max 6) as {"title","note"}.
   - "title": EXACTLY as the primary page prints it. Do not translate, expand, abbreviate or add a year. A paraphrased title will fail the resolver's identity check and the film will be dropped.
   - "note": that film's role in THIS story, max 40 characters — "Best Feature Film", "steep second-day fall", "wins Best Telugu Film".
   - OMIT "films" entirely for a person-only story (an interview, a casting rumour about a person) and for any HELD story.

Return JSON: {"stories":[{"id":"...","confirmed":true,"sourceUrl":"...","basis":"...","films":[{"title":"...","note":"..."}]}]}`;
}

/** Cache key: the day's story set. Different stories ⇒ different call. */
function cacheKey(clusters: ScoredCluster[], dateStamp: string): string {
  const projection = clusters.map((c) => `${c.id}|${c.headline}`).join("\n");
  const hash = createHash("sha256").update(projection).digest("hex").slice(0, 16);
  // v2 — the response SHAPE changed (films[] added). A cached v1 verdict is
  // schema-valid but has no film list, which would silently disable multi-film
  // art for the cache's whole lifetime. A shape change must invalidate its cache.
  return `news:verify:v2:${dateStamp}:${hash}`;
}

/** Every story held, with one stated reason. The fail-soft shape. */
function allHeld(clusters: ScoredCluster[], basis: string): VerifiedStory[] {
  return clusters.map((cluster) => ({ cluster, confirmed: false, sourceUrl: "", basis, films: [] }));
}

/**
 * Verify the top `MAX_VERIFIED_STORIES` eligible clusters in ONE batched call.
 * Ineligible clusters never reach here — the caller filters on the R2 floor.
 */
export async function verifyStories(
  clusters: ScoredCluster[],
  dateStamp: string
): Promise<VerifiedStory[]> {
  const slate = clusters.slice(0, MAX_VERIFIED_STORIES);
  if (slate.length === 0) return [];

  let out: z.infer<typeof NewsVerifySchema>;
  try {
    out = await cached(
      cacheKey(slate, dateStamp),
      async () => {
        log.info(`  Verifying ${slate.length} story/stories — ONE batched web-search call…`);
        return callClaudeJSON(buildPrompt(slate), NewsVerifySchema, "opus", { webSearch: true });
      },
      { ttlSeconds: CACHE_TTL_SECONDS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`  Verification unavailable — holding every story. (${msg})`);
    return allHeld(slate, "verification unavailable — held (infra failure is not a verdict)");
  }

  const byId = new Map(out.stories.map((s) => [s.id, s]));
  return slate.map((cluster) => {
    const raw = byId.get(cluster.id);
    if (!raw) {
      return {
        cluster,
        confirmed: false,
        sourceUrl: "",
        basis: "no verdict returned for this story — held",
        films: [],
      };
    }
    // Normalize the nullable schema field before the receipt rule, which owns
    // the "is this actually a citable page" question.
    const ruled = applyReceiptRule({ ...raw, sourceUrl: raw.sourceUrl ?? "" });
    // Films ride ONLY on a surviving confirmation: a story the receipt rule
    // demoted has no verified page, so its film list has no provenance either.
    return { cluster, ...ruled, films: ruled.confirmed ? (raw.films ?? []) : [] };
  });
}
