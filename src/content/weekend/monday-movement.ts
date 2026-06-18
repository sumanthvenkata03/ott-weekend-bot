// src/content/weekend/monday-movement.ts
import { format, parseISO } from "date-fns";
import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { MovementDraft } from "../../delivery/notion.js";
import { notableComposersBlock, enrichmentBlock } from "./_shared.js";

const MovementSlideSchema = z.object({
  slideNumber: z.number(),
  type: z.enum(["cover", "headline", "arrival", "gem", "cta"]),
  title: z.string(),
  body: z.string(),
  // .default(false) (not .optional()) so the inferred type is a required boolean,
  // which stays assignable to MovementSlide's exact-optional isMusicDirectorNotable
  // under exactOptionalPropertyTypes. Missing in the reply → coerced to false.
  isMusicDirectorNotable: z.boolean().default(false),
});

// Mon's design contract — folded into the schema so a wrong count triggers the
// retry instead of a late throw: carouselSlides is empty (LLM judged the week not
// worth a post) OR contains 4–10 arrival/gem body slides. The ≥1-per-bucket rule
// is conditional on the INPUT buckets (zod can't see them), so it lives in the
// business guard below alongside the title↔Release matching guard.
const MonMovementSchema = z.object({
  weekHeadline: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
  carouselSlides: z.array(MovementSlideSchema).refine(
    slides => {
      if (slides.length === 0) return true;
      const body = slides.filter(s => s.type === "arrival" || s.type === "gem").length;
      return body >= 4 && body <= 10;
    },
    { message: "carouselSlides must be empty (skip) or have 4–10 arrival/gem body slides" }
  ),
});

type LLMOutput = z.infer<typeof MonMovementSchema>;

// ─── Body-slide ordering (rating-then-buzz) ─────────────────────────────────
// Order body cards so unrated BRAND-NEW arrivals surface by curiosity instead of
// sinking below older rated catalog. Brand-new arrivals spike in TMDb popularity
// at launch, so the popularity band floats buzzy new films UP — but the band is
// capped strictly below the rated range, so a low-buzz unrated film can never
// outrank a genuinely high-rated gem.
//
// Tunable constants:
const MIN_VOTES = 50;        // min TMDb vote_count to trust vote_average as a rating
const POP_BAND_BASE = 6.0;   // floor of the popularity band (no rating, no trusted votes)
const POP_BAND_RANGE = 2.0;  // band spans [6.0, 8.0] — capped below a genuinely high IMDb gem
const POP_SCALE = 60;        // popularity / POP_SCALE → band offset; a hot new release
                             // (TMDb popularity ~60–150 at launch) lands ~7.0–8.0

function sortScore(film: Release): number {
  // 1. real IMDb rating wins
  if (typeof film.imdbRating === "number") return film.imdbRating;
  // 2. else a TMDb vote_average we have enough votes to trust
  if (typeof film.tmdbVoteAverage === "number" && (film.tmdbVoteCount ?? 0) >= MIN_VOTES) {
    return film.tmdbVoteAverage;
  }
  // 3. else a curiosity band from launch popularity, capped below the rated range
  return POP_BAND_BASE + Math.min((film.tmdbPopularity ?? 0) / POP_SCALE, POP_BAND_RANGE);
}

function releaseForPrompt(r: Release, isArrival: boolean): string {
  return [
    `[${isArrival ? "NEW ARRIVAL" : "HIDDEN GEM"}] ${r.title} (${r.language})`,
    `  Released: ${r.releaseDate}`,
    `  Platform: ${r.platform.length ? r.platform.join(", ") : "TBA"}`,
    `  Director: ${r.director ?? "—"}`,
    `  Cast: ${r.cast.slice(0, 3).join(", ") || "—"}`,
    `  Genres: ${r.genre.join(", ") || "—"}`,
    r.imdbRating ? `  IMDb: ${r.imdbRating} (${r.imdbVotes ?? 0} votes)` : "",
    enrichmentBlock(r),
    `  Synopsis: ${r.synopsis.slice(0, 200)}${r.synopsis.length > 200 ? "..." : ""}`,
  ].filter(Boolean).join("\n");
}

export async function generateMondayMovement(
  newArrivals: Release[],
  hiddenGems: Release[],
  weekStart: string,
  weekEnd: string
): Promise<MovementDraft> {
  if (newArrivals.length === 0 && hiddenGems.length === 0) {
    throw new Error("Cannot generate Movement post with zero films");
  }
  
  const weekLabel = `Week of ${format(parseISO(weekStart), "MMM d")} — ${format(parseISO(weekEnd), "MMM d, yyyy")}`;
  log.info(`Generating Monday Movement: ${weekLabel} (${newArrivals.length} arrivals, ${hiddenGems.length} gems)`);
  
  const arrivalsBlock = newArrivals.length > 0
    ? newArrivals.map(r => releaseForPrompt(r, true)).join("\n\n")
    : "(no confirmed new OTT arrivals from TMDb this week — likely a quiet week or platforms didn't surface their adds)";
  
  const gemsBlock = hiddenGems.map(r => releaseForPrompt(r, false)).join("\n\n");
  
  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page. Monday is the OTT MOVEMENT post — what changed across the Indian streaming landscape this week.

PAGE IDENTITY:
- Pan-Indian, South-heavy. We track every platform, every language.
- Confident, opinionated, conversational. Light Hinglish where natural.
- Decision page, not info page — but Monday is the most "report" of our pillars, so leans observational.

CRITICAL TONE RULES:
- Don't just list films. Find the PATTERN. The post's spine is one line: what does this week's movement say about Indian OTT right now?
- Be specific. Name platforms, name languages, call out trends.
- Acknowledge gaps. If no Tamil arrivals dropped, say so — "Tamil OTT is quiet this week."
- NEVER use AI-cliche phrases: "dive into", "delve", "in today's fast-paced world", "buckle up", "look no further", "landscape" (overused), "elevates".

WEEK: ${weekLabel}

NEW OTT ARRIVALS (last 7 days):
${arrivalsBlock}

HIDDEN GEMS WORTH SURFACING:
${gemsBlock}

CARD COUNT + MIX — quality over coverage:
- Pick the best UP TO 10 films for the body cards — a mix of NEW ARRIVALS (type "arrival") and HIDDEN GEMS (type "gem"). Fewer is fine if fewer are genuinely worth featuring; NEVER pad with weak titles. Prefer 6–10 when the quality supports it.
- REQUIRED when BOTH buckets have films: at least 1 of each variant — the pillar loses meaning if it's all NEW or all GEM. (If only one bucket has films this week, an all-NEW or all-GEM slate is fine.)
- LLM judges the split based on the week. Strong week of arrivals → lean arrival-heavy. Quiet week → lean gem-heavy. Balanced week → an even mix.
- Title strings on arrival/gem slides MUST match the input title exactly so the renderer can map them to Release records.
- The JSON below shows a 5-card example for shape only — include as many body cards (4–10) as the slate genuinely warrants.
- If fewer than 4 worthwhile films exist across both buckets combined, return carouselSlides: [] (empty array) to skip the pillar rather than padding with weak picks.

DELIVERABLES (respond as JSON):

{
  "weekHeadline": "ONE bold line. The post's spine. Pattern-recognition statement about what this week's movement reveals. e.g., 'Three Malayalam thrillers landed this week and not one Hindi drama. Mollywood is running the genre clock.'",
  "caption": "Under 140 words. Open with the weekHeadline or a variant. Walk through 2-3 specific arrivals with one-line takes. Mention 1-2 hidden gems. End with CTA: 'Save this. DM us if you've watched any.'",
  "hashtags": ["10-12 hashtags array with # prefix"],
  "carouselSlides": [
    { "slideNumber": 1, "type": "cover", "title": "<6-word headline based on weekHeadline>", "body": "<short subtext>" },
    { "slideNumber": 2, "type": "headline", "title": "This week in OTT", "body": "<the weekHeadline expanded to 2 sentences>" },
    { "slideNumber": 3, "type": "arrival", "title": "<exact film title>", "body": "<one-line why this matters — platform, language, genre angle>", "isMusicDirectorNotable": false },
    { "slideNumber": 4, "type": "arrival|gem", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 5, "type": "arrival|gem", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 6, "type": "arrival|gem", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 7, "type": "gem", "title": "Hidden Gem: <exact film title>", "body": "<why this is worth pulling up from your watch list>", "isMusicDirectorNotable": false },
    { "slideNumber": 8, "type": "cta", "title": "<CTA>", "body": "Save. DM us. Which one are you starting?" }
  ]
}

${notableComposersBlock()}

IMPORTANT:
- The weekHeadline is the most important line in the entire post. Make it specific, opinionated, and pattern-aware.
- Don't dilute. If there's only 1 great arrival, lead with it and don't pad with weak ones.
- Hidden gems should feel like "you missed this and you shouldn't have" — not just "another good film."

CAST OVERLAP RULE for arrival/gem slide body copy — whenever you name an
actor in a slide's body, at least one of the actors you name MUST also
appear in that film's "Lead cast (top-billed)" line from the input. Both
that line and the broader "Cast:" list are available; reference whichever
actor sells the slide best, but make sure one name overlaps with leadCast
so the body and the card's metadata line stay aligned. If leadCast already
contains the recognizable name, just use those — don't reach into the
broader cast for a less-billed actor.

HEADLINE MIX RULE — WHEN both variants are present this week, the weekHeadline must acknowledge BOTH the new arrivals (type "arrival") AND the hidden gems (type "gem"). That is the standard case. When the mix is heavily skewed (e.g. arrival-heavy or gem-heavy), the lighter variant needs only a brief acknowledgment — a half-clause is enough — but it must appear. (If only one bucket has films this week, just lead with that variant.)

Acceptable headline shapes:
- Lead with arrivals, acknowledge gems at the end: "...meanwhile Mollywood's March catalog is still the strongest watch"
- Lead with the gem angle, acknowledge arrivals: "Two Malayalam thrillers worth catching up on while Hindi delivers its one big Sonakshi face-off"
- Frame the contrast directly: "Telugu Prime Video's loud week vs. Mollywood's quiet excellence"

Not acceptable: headline that only mentions arrivals when gems exist, or only mentions gems when arrivals exist.`;
  
  const output = await callClaudeJSON(prompt, MonMovementSchema, "sonnet");

  // Runtime guard: design contract is 4–10 body slides (arrival + gem types
  // combined), OR carouselSlides: [] (LLM judged the week not worth a pillar
  // post). The ≥1-per-bucket rule only applies when BOTH input buckets had films
  // — a one-bucket week (all-NEW or all-GEM) is legitimate. Anything else is a
  // prompt regression.
  const arrivalSlides = output.carouselSlides.filter(s => s.type === "arrival");
  const gemSlides     = output.carouselSlides.filter(s => s.type === "gem");
  const bodyCount     = arrivalSlides.length + gemSlides.length;

  if (output.carouselSlides.length !== 0) {
    if (bodyCount < 4 || bodyCount > 10) {
      throw new Error(
        `Mon Movement LLM returned ${bodyCount} body slides ` +
        `(${arrivalSlides.length} arrival + ${gemSlides.length} gem); expected 4–10 or 0 (skip)`
      );
    }
    if (newArrivals.length > 0 && hiddenGems.length > 0 && (arrivalSlides.length < 1 || gemSlides.length < 1)) {
      throw new Error(
        `Mon Movement mix invalid: ${arrivalSlides.length} NEW + ${gemSlides.length} GEM ` +
        `(both buckets had films, so need at least 1 of each variant)`
      );
    }
  }

  // Trim draft.newArrivals / draft.hiddenGems to the films the LLM actually
  // picked. The cover's 2×2 grid is fed from these arrays (algorithmically,
  // not from slides), so without trimming the cover could show films that
  // never appear on the body cards. Mirrors the Wed Drop fix.
  //
  // Gem slide titles sometimes arrive prefixed with "Hidden Gem: " — strip
  // that for matching, same as render-mon-movement.ts:normalizeSlideTitle.
  const stripGemPrefix = (t: string) => t.replace(/^Hidden Gem:\s*/i, "").trim();
  const pickedArrivalTitles = new Set(arrivalSlides.map(s => stripGemPrefix(s.title)));
  const pickedGemTitles     = new Set(gemSlides.map(s => stripGemPrefix(s.title)));

  const pickedArrivals = newArrivals.filter(r =>
    pickedArrivalTitles.has(r.title) || pickedGemTitles.has(r.title)
  );
  const pickedGems = hiddenGems.filter(r =>
    pickedGemTitles.has(r.title) || pickedArrivalTitles.has(r.title)
  );

  if (output.carouselSlides.length !== 0 && pickedArrivals.length + pickedGems.length !== bodyCount) {
    throw new Error(
      `Mon Movement: LLM picked ${bodyCount} titles but only ${pickedArrivals.length + pickedGems.length} ` +
      `matched a Release record. Check that title strings match the input exactly.`
    );
  }

  // Reorder BODY CARDS only (arrival/gem slides) by rating-then-buzz score, DESC.
  // Stable: equal scores keep the LLM's order. Non-body slides (cover/headline/
  // cta) stay in place. The cover grid is fed from the newArrivals/hiddenGems
  // arrays (not slide order), so it is completely unaffected by this reorder.
  const filmByTitle = new Map<string, Release>();
  for (const r of [...pickedArrivals, ...pickedGems]) filmByTitle.set(r.title, r);
  const scoreForSlide = (s: LLMOutput["carouselSlides"][number]): number => {
    const film = filmByTitle.get(stripGemPrefix(s.title));
    return film ? sortScore(film) : -Infinity;
  };
  const sortedBody = output.carouselSlides
    .filter(s => s.type === "arrival" || s.type === "gem")
    .sort((a, b) => scoreForSlide(b) - scoreForSlide(a)); // Array.sort is stable (ES2019+)
  let bi = 0;
  const orderedSlides = output.carouselSlides.map(s =>
    (s.type === "arrival" || s.type === "gem") ? sortedBody[bi++]! : s
  );

  const carouselSlides = orderedSlides
    .map(s => `**Slide ${s.slideNumber}** (${s.type}): **${s.title}** — ${s.body}`)
    .join("\n\n");

  return {
    pillar: "Mon Movement",
    weekLabel,
    weekHeadline: output.weekHeadline,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    slides: orderedSlides,
    carouselSlides,
    newArrivals: pickedArrivals,
    hiddenGems: pickedGems,
  };
}