// src/content/weekend/wednesday-drop.ts
import { format, parseISO } from "date-fns";
import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { WednesdayDropDraft } from "../../delivery/notion.js";
import type { WedDropEdition } from "../../shared/wed-drop-edition.js";
import { notableComposersBlock, enrichmentBlock } from "./_shared.js";
import { TMDB_FALLBACK_MIN_VOTES } from "../../rendering/_shared.js";

/**
 * Wed Drop is a variable-count post now that it spans both this weekend's
 * theatrical premieres AND this week's OTT drops: the LLM returns 0 release
 * slides (skip the pillar) OR 1..MAX_WED_DROP_FILMS, one body card per pick.
 * Cover stays a curated top-4 preview; the swipe cue shows the full count.
 */
export const MAX_WED_DROP_FILMS = 15;

const WedDropSlideSchema = z.object({
  slideNumber: z.number(),
  type: z.enum(["cover", "index", "release", "cta"]),
  title: z.string(),
  body: z.string(),
  // .default(false) (not .optional()) so the inferred type is a required boolean,
  // assignable to WedDropSlide's exact-optional isMusicDirectorNotable.
  isMusicDirectorNotable: z.boolean().default(false),
});

// Wed's design contract folded into the schema (wrong count → retry): empty
// (skip the pillar) OR 1..MAX_WED_DROP_FILMS 'release' slides. Title↔Release
// matching stays a cross-referential business guard below.
const WedDropSchema = z.object({
  caption: z.string(),
  hashtags: z.array(z.string()),
  carouselSlides: z.array(WedDropSlideSchema).refine(
    slides => {
      const n = slides.filter(s => s.type === "release").length;
      return slides.length === 0 || (n >= 1 && n <= MAX_WED_DROP_FILMS);
    },
    { message: `carouselSlides must be empty (skip) or contain 1–${MAX_WED_DROP_FILMS} 'release' slides` }
  ),
});

type LLMOutput = z.infer<typeof WedDropSchema>;

/**
 * Format a release for the LLM in a compact, structured way.
 */
function releaseForPrompt(r: Release): string {
  const lines = [
    `Title: ${r.title}`,
    `Language: ${r.language}`,
    `Release date: ${r.releaseDate}`,
    `Genres: ${r.genre.join(", ") || "—"}`,
    `Platform: ${r.platform.length ? r.platform.join(", ") : "TBA"}`,
    `Director: ${r.director ?? "—"}`,
    `Cast: ${r.cast.slice(0, 3).join(", ") || "—"}`,
    `Runtime: ${r.runtime ? `${r.runtime} min` : "—"}`,
    r.imdbRating ? `IMDb: ${r.imdbRating} (${r.imdbVotes ?? 0} votes)` : "IMDb: not yet rated",
  ];
  const enr = enrichmentBlock(r);
  if (enr) lines.push(enr);
  lines.push(`Synopsis: ${r.synopsis}`);
  return lines.join("\n");
}

/**
 * Per-edition LLM framing. The two Wed Drop editions are generated from
 * SEPARATE pools and never merged, so each gets its own task line, slate
 * header, pick instruction, cover brief, and per-film "why" angle. Everything
 * else in the prompt (page identity, tone, output rules, the 0-or-1..MAX
 * contract, the title-match + cast-overlap guards) is shared.
 */
function editionFraming(edition: WedDropEdition, weekendDates: string) {
  if (edition === "theatrical") {
    return {
      task: `Generate a Wednesday "The Drop — In Theaters" Instagram carousel for the films OPENING IN CINEMAS this weekend (Wed–Sun).`,
      slateHeader: `THESE FILMS OPEN IN THEATERS THIS WEEKEND (${weekendDates})`,
      pick: `Include EVERY genuine film in the slate above that is a REAL theatrical release worth SEEING IN CINEMAS this weekend, UP TO A MAXIMUM OF ${MAX_WED_DROP_FILMS}. If MORE than ${MAX_WED_DROP_FILMS} real films are present, include the ${MAX_WED_DROP_FILMS} most-worth-watching and drop the rest; otherwise include them ALL — do NOT curate down to a favourites shortlist when fewer than ${MAX_WED_DROP_FILMS} exist. The goal is a COMPLETE weekend guide to this weekend's cinema openings.`,
      cover: `Write a cinema-weekend cover headline (≤6 words) + subtitle (≤10 words) that makes people want to get out to the theater.`,
      why: `For each pick, the body is a one-line "why see it in theaters this weekend" — a reason to buy a ticket, NOT a synopsis.`,
    };
  }
  return {
    task: `Generate a Wednesday "The Drop — Now Streaming" Instagram carousel for the films STREAMING this week (Mon–Sun).`,
    slateHeader: `THESE FILMS ARE STREAMING THIS WEEK (${weekendDates}) — this week's digital arrivals, watchable all weekend`,
    pick: `Include EVERY genuine film in the slate above that is a REAL streaming release worth STREAMING this weekend, UP TO A MAXIMUM OF ${MAX_WED_DROP_FILMS}. If MORE than ${MAX_WED_DROP_FILMS} real films are present, include the ${MAX_WED_DROP_FILMS} most-worth-watching and drop the rest; otherwise include them ALL — do NOT curate down to a favourites shortlist when fewer than ${MAX_WED_DROP_FILMS} exist. The goal is a COMPLETE weekend guide to this week's streaming arrivals.`,
    cover: `Write a streaming-weekend cover headline (≤6 words) + subtitle (≤10 words) that sells a great weekend on the couch.`,
    why: `For each pick, NAME THE PLATFORM it streams on, and write a one-line "why stream it" — a reason to hit play, NOT a synopsis.`,
  };
}

/**
 * Rating tier for the deterministic sort. The three tiers MUST mirror
 * buildStampContext's seal logic (TBSI blend → TMDb community fallback → NEW /
 * unrated) so a card's position never disagrees with its stamp: a TBSI-blended
 * film always outranks a TMDb-fallback one, which always outranks an unrated
 * premiere that merely happens to be popular.
 *   0  TBSI blend exists (tbsiScore defined)
 *   1  TMDb average that clears the same vote floor the stamp uses
 *   2  no verdict yet
 */
function ratingTier(r: Release): 0 | 1 | 2 {
  if (r.tbsiScore !== undefined) return 0;
  if (
    typeof r.tmdbVoteAverage === "number" &&
    (r.tmdbVoteCount ?? 0) >= TMDB_FALLBACK_MIN_VOTES
  ) {
    return 1;
  }
  return 2;
}

/** The score the sort ranks by WITHIN a tier (see ratingTier). */
function scoreWithinTier(r: Release): number {
  switch (ratingTier(r)) {
    case 0: return r.tbsiScore ?? 0;
    case 1: return r.tmdbVoteAverage ?? 0;
    default: return r.tmdbPopularity ?? 0;
  }
}

/**
 * Deterministic rating comparator: tier ASC, then score-within-tier DESC.
 * Tiebreakers (tmdbPopularity DESC, then title ASC) make the order fully
 * deterministic for equal scores, independent of the LLM's pick order.
 */
function compareByRating(a: Release, b: Release): number {
  const tierA = ratingTier(a);
  const tierB = ratingTier(b);
  if (tierA !== tierB) return tierA - tierB;                  // tier ASC
  const scoreA = scoreWithinTier(a);
  const scoreB = scoreWithinTier(b);
  if (scoreA !== scoreB) return scoreB - scoreA;             // score DESC
  const popA = a.tmdbPopularity ?? 0;
  const popB = b.tmdbPopularity ?? 0;
  if (popA !== popB) return popB - popA;                     // popularity DESC
  return a.title.localeCompare(b.title);                     // title ASC
}

/**
 * Reorder a Wed Drop draft into deterministic rating-descending order,
 * overriding the LLM's own ordering. The releases array is sorted by
 * compareByRating (fixing the cover, which reads releases[0..3]); the
 * 'release' slides are reordered to match the sorted releases by exact title
 * (fixing the body cards AND the Notion markdown, which both flow from slide
 * order). Non-release slides (cover / index / cta) keep their positions, and
 * every slide is renumbered so slideNumber stays ascending in the Notion
 * markdown. Inputs are not mutated; new arrays are returned. Array.sort is
 * stable, so the popularity/title tiebreakers fully determine equal-score ties.
 */
export function sortWedDropByRating<
  S extends { type: string; title: string; slideNumber: number }
>(slides: S[], releases: Release[]): { slides: S[]; releases: Release[] } {
  const sortedReleases = [...releases].sort(compareByRating);
  const orderByTitle = new Map(sortedReleases.map((r, i) => [r.title, i]));
  const sortedReleaseSlides = slides
    .filter(s => s.type === "release")
    .sort((a, b) => (orderByTitle.get(a.title) ?? 0) - (orderByTitle.get(b.title) ?? 0));
  let releaseIdx = 0;
  const sortedSlides = slides
    .map(s => (s.type === "release" ? sortedReleaseSlides[releaseIdx++]! : s))
    .map((s, i) => ({ ...s, slideNumber: i + 1 }));
  return { slides: sortedSlides, releases: sortedReleases };
}

/**
 * Generate a Wednesday Drop draft from a list of releases for a given edition
 * ("theatrical" → In Theaters | "ott" → Now Streaming). Each edition is an
 * independent draft built from its own pool.
 */
export async function generateWednesdayDrop(
  releases: Release[],
  edition: WedDropEdition,
  weekendStart: string,
  weekendEnd: string
): Promise<WednesdayDropDraft> {
  if (releases.length === 0) {
    throw new Error("Cannot generate Wednesday Drop with zero releases");
  }

  const weekendDates = `${format(parseISO(weekendStart), "MMM d")} — ${format(parseISO(weekendEnd), "MMM d, yyyy")}`;
  const framing = editionFraming(edition, weekendDates);

  log.info(`Generating Wednesday Drop [${edition}] for ${weekendDates} (${releases.length} releases)`);
  
  const releaseBlocks = releases.map((r, i) => `--- RELEASE ${i + 1} ---\n${releaseForPrompt(r)}`).join("\n\n");
  
  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page.

PAGE IDENTITY:
- Niche: Indian OTT weekend release decision-maker + always-on film industry pulse
- Coverage: Hindi, Telugu, Tamil, Malayalam, Kannada, Marathi, Bengali cinema + Indian content on international platforms
- Positioning: We don't just LIST releases. We help people DECIDE what to watch.
- Differentiation: Verdicts (not just hype), mood tags, family filter, regional depth, OTT movement tracking.

TONE & VOICE:
- English-first with light Hinglish sprinkled naturally ("must-watch", "binge-worthy", "skip kar do", "weekend sorted", "kya scene hai")
- Confident and opinionated — we take stands, not safe hedges
- Conversational, like a friend texting recommendations
- Hook-first: open with curiosity, contrast, or a strong claim
- South-heavy: when 2+ languages compete, lean into the South where the action is
- Never generic. Never "Here are the releases this week." Always specific.

OUTPUT RULES:
- Never use AI-cliche phrases ("dive into", "delve", "in today's fast-paced world", "buckle up", "look no further")
- Caption: under 150 words, opens with a hook, closes with a CTA
- 10-12 hashtags mixing broad + niche + platform + language
- South-Indian films get equal-or-greater attention than Hindi when they're stronger

TASK: ${framing.task}

WEEKEND: ${weekendDates}

${framing.slateHeader} — ${releases.length} total:

${releaseBlocks}

SELECTION — include every REAL release in this medium, capped at ${MAX_WED_DROP_FILMS} (a COMPLETE weekend guide, not a favourites shortlist):
- ${framing.pick}
- ${framing.cover}
- ${framing.why}
- Skip an entry ONLY if it is not a real film — a short, a trailer, a mislabeled or duplicate entry, something with no real release, or adult content. Everything else that is a genuine release belongs in the guide.
- ORDER the films best / most-worth-watching FIRST — this matters both because the first four become the cover AND because when more than ${MAX_WED_DROP_FILMS} films exist, only the top ${MAX_WED_DROP_FILMS} are kept.
- Never invent or duplicate films to reach ${MAX_WED_DROP_FILMS} — the count must equal the number of REAL distinct films available, capped at ${MAX_WED_DROP_FILMS}. For a film you do not recognize, write a SHORT FACTUAL blurb from the provided metadata only (language, genre, lead cast, director, platform) — do NOT invent plot, themes, or critical praise.
- If after skipping junk there are 0 real films, return carouselSlides: [] (empty array) to skip this edition.
- Title strings on release slides must match the input title exactly (case + punctuation) so the renderer can match them to the Release records.

DELIVERABLES (respond as JSON):

{
  "caption": "Instagram caption text under 150 words. Opens with a hook, mentions the biggest drop, the hidden gem, the regional spotlight if any, closes with 'Save this' / 'DM us' / 'Which one are you watching?' CTA.",
  "hashtags": ["array", "of", "10-12", "hashtags", "with", "the", "# prefix"],
  "carouselSlides": [
    { "slideNumber": 1, "type": "cover", "title": "<6-word headline>", "body": "<10-word subtext>" },
    { "slideNumber": 2, "type": "index", "title": "This weekend", "body": "<quick visual list: Title (Language) → Platform>" },
    { "slideNumber": 3, "type": "release", "title": "<exact film title>", "body": "<one-line WHY this matters — not a synopsis, a reason to care>", "isMusicDirectorNotable": false },
    { "slideNumber": 4, "type": "release", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    "… one 'release' slide per INCLUDED film — a VARIABLE, potentially long list of up to ${MAX_WED_DROP_FILMS} releases (one per real film in this medium, not a fixed 4) …",
    { "slideNumber": "<last>", "type": "cta", "title": "<short CTA>", "body": "<which one are you starting with?>" }
  ]
}

${notableComposersBlock()}

CAST OVERLAP RULE for release slide body copy — whenever you name an actor
in a slide's body, at least one of the actors you name MUST also appear in
that film's "Lead cast (top-billed)" line from the input. Both that line
and the broader "Cast:" list are available; reference whichever actor sells
the slide best, but make sure one name overlaps with leadCast so the body
and the card's metadata line stay aligned. If leadCast already contains the
recognizable name, just use those.

Be specific. Take stands. Lean South-heavy where the films justify it.`;
  
  const output = await callClaudeJSON(prompt, WedDropSchema, "sonnet");

  // Runtime guard: design contract is 1..MAX_WED_DROP_FILMS release slides, OR
  // all-empty (the "skip the pillar this week" branch). Anything else is a
  // prompt regression.
  const releaseSlideCount = output.carouselSlides.filter(s => s.type === "release").length;
  if (output.carouselSlides.length !== 0 && (releaseSlideCount < 1 || releaseSlideCount > MAX_WED_DROP_FILMS)) {
    throw new Error(
      `Wed Drop LLM returned ${releaseSlideCount} release slides; expected 0 (skip) or 1–${MAX_WED_DROP_FILMS}`
    );
  }

  // Trim draft.releases to the films the LLM actually picked, keeping the
  // slide order. This keeps the cover's top-4 preview grid and the body cards
  // aligned on the same films (otherwise the cover would show the first
  // releases by ingestion order while the cards show the LLM's picks).
  const pickedTitles = output.carouselSlides
    .filter(s => s.type === "release")
    .map(s => s.title);
  const pickedReleases = pickedTitles
    .map(t => releases.find(r => r.title === t))
    .filter((r): r is Release => r !== undefined);

  // Every picked title must resolve to a Release record (exact title match).
  if (output.carouselSlides.length !== 0 && pickedReleases.length !== releaseSlideCount) {
    throw new Error(
      `Wed Drop: LLM picked ${releaseSlideCount} titles but only ${pickedReleases.length} matched a Release record. ` +
      `Check that title strings match the input exactly.`
    );
  }

  // Deterministic rating sort — supersedes the LLM's own "order best-first"
  // ordering (that prompt rule is now redundant but harmless). Sorting both the
  // releases and the 'release' slides here makes the cover (releases[0..3]),
  // the body cards (release-slide order) and the Notion draft (markdown + the
  // featured-releases bullets) all follow the same rating-descending order.
  const sorted = sortWedDropByRating(output.carouselSlides, pickedReleases);

  // Render carousel slides as markdown for the Notion body
  const carouselSlides = sorted.slides
    .map(s => `**Slide ${s.slideNumber}** (${s.type}): **${s.title}** — ${s.body}`)
    .join("\n\n");

  return {
    pillar: "Wed Drop",
    weekendDates,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    slides: sorted.slides,
    carouselSlides,
    releases: sorted.releases,
  };
}