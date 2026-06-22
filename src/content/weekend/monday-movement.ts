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
// retry instead of a late throw: carouselSlides is empty (LLM judged the slate not
// worth a post) OR contains 4–10 arrival/gem body slides. Mon is now gems-only, so
// in practice every body slide is type "gem" — the "arrival" type stays in the
// enum for shape compatibility but the prompt never asks for it.
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

// Data-backed leaders for the deck, computed in the job over the candidate pool.
// These are the ONLY superlatives/exclusivity claims the copywriter may make —
// each field is present only when the data unambiguously supports it (a tie or a
// missing field omits it, so no false "best/most/only" can be minted). Built with
// conditional spreads upstream, so under exactOptionalPropertyTypes a field is
// either a real string or absent, never explicitly `undefined`.
export interface DeckFacts {
  topImdbTitle?: string;                    // unique max imdbRating
  topTbsiTitle?: string;                    // unique max tbsiScore
  topVotesTitle?: string;                   // unique max imdbVotes
  soleLanguageMap?: Record<string, string>; // language -> the one film that lists it
}

// ─── Body-slide ordering (rating-then-buzz) ─────────────────────────────────
// Order body cards so unrated catalog films surface by curiosity instead of
// sinking below older rated catalog. A film with no trusted rating still spikes
// in TMDb popularity, so the popularity band floats buzzy titles UP — but the
// band is capped strictly below the rated range, so a low-buzz unrated film can
// never outrank a genuinely high-rated gem.
//
// Tunable constants:
const MIN_VOTES = 50;        // min TMDb vote_count to trust vote_average as a rating
const POP_BAND_BASE = 6.0;   // floor of the popularity band (no rating, no trusted votes)
const POP_BAND_RANGE = 2.0;  // band spans [6.0, 8.0] — capped below a genuinely high IMDb gem
const POP_SCALE = 60;        // popularity / POP_SCALE → band offset; a buzzy title
                             // (TMDb popularity ~60–150) lands ~7.0–8.0

function sortScore(film: Release): number {
  // 1. real IMDb rating wins
  if (typeof film.imdbRating === "number") return film.imdbRating;
  // 2. else a TMDb vote_average we have enough votes to trust
  if (typeof film.tmdbVoteAverage === "number" && (film.tmdbVoteCount ?? 0) >= MIN_VOTES) {
    return film.tmdbVoteAverage;
  }
  // 3. else a curiosity band from popularity, capped below the rated range
  return POP_BAND_BASE + Math.min((film.tmdbPopularity ?? 0) / POP_SCALE, POP_BAND_RANGE);
}

function releaseForPrompt(r: Release): string {
  // Cast is fed via enrichmentBlock's leadCast (top-billed) ONLY — the exact
  // names the card prints. The broader r.cast array is intentionally NOT shown,
  // so the model can't name an actor the card omits (see CAST-NAMING HARD RULE).
  return [
    `[HIDDEN GEM] ${r.title} (${r.language})`,
    `  Released: ${r.releaseDate}`,
    `  Platform: ${r.platform.length ? r.platform.join(", ") : "TBA"}`,
    `  Director: ${r.director ?? "—"}`,
    `  Genres: ${r.genre.join(", ") || "—"}`,
    r.imdbRating ? `  IMDb: ${r.imdbRating} (${r.imdbVotes ?? 0} votes)` : "",
    enrichmentBlock(r),
    `  Synopsis: ${r.synopsis.slice(0, 200)}${r.synopsis.length > 200 ? "..." : ""}`,
  ].filter(Boolean).join("\n");
}

// Render the data-backed leaders as prompt lines. Only non-empty facts appear;
// if nothing is verifiable, the copywriter is told to make no such claim.
function deckFactsBlock(deckFacts: DeckFacts): string {
  const lines: string[] = [];
  if (deckFacts.topImdbTitle) lines.push(`- Highest IMDb rating on this shelf: "${deckFacts.topImdbTitle}"`);
  if (deckFacts.topTbsiTitle) lines.push(`- Highest TBSI score on this shelf: "${deckFacts.topTbsiTitle}"`);
  if (deckFacts.topVotesTitle) lines.push(`- Most IMDb votes on this shelf: "${deckFacts.topVotesTitle}"`);
  if (deckFacts.soleLanguageMap) {
    for (const [lang, title] of Object.entries(deckFacts.soleLanguageMap)) {
      lines.push(`- Only ${lang} film on this shelf: "${title}"`);
    }
  }
  return lines.length > 0
    ? lines.join("\n")
    : "(none — every ranked dimension is a tie or unavailable; make NO superlative or exclusivity claim)";
}

export async function generateMondayMovement(
  newArrivals: Release[],
  hiddenGems: Release[],
  weekStart: string,
  weekEnd: string,
  deckFacts: DeckFacts = {}
): Promise<MovementDraft> {
  if (newArrivals.length === 0 && hiddenGems.length === 0) {
    throw new Error("Cannot generate Movement post with zero films");
  }

  // Catch-up framing: no "Week of X — Y" range. The masthead already carries the
  // issue date; the label just names the shelf's month.
  const weekLabel = `Catch-Up · ${format(parseISO(weekEnd), "MMMM yyyy")}`;
  log.info(`Generating Monday Movement (catch-up): ${weekLabel} (${hiddenGems.length} gems)`);

  const gemsBlock = hiddenGems.map(r => releaseForPrompt(r)).join("\n\n");
  const factsBlock = deckFactsBlock(deckFacts);

  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page. Monday is THE CATCH-UP SHELF — the catalog worth pulling up: films from roughly the last three months that are quietly worth watching right now. This is NOT this week's new drops (those run midweek as Wed Drop); Monday is pure catch-up — the overlooked and the evergreen you should already have on your list.

PAGE IDENTITY:
- Pan-Indian, South-heavy. We track every platform, every language.
- Confident, opinionated, conversational. Light Hinglish where natural.
- Decision page, not info page — but Monday is the most "report" of our pillars, so leans observational.

CRITICAL TONE RULES:
- Don't just list films. Find the PATTERN. The post's spine is one line: what do these catch-up picks say about what's quietly worth watching on Indian OTT right now — the strong films most people skipped?
- Be specific. Name platforms, name languages, call out trends.
- Acknowledge skews. If the shelf leans one language, say so — "It's a Malayalam-heavy shelf this month."
- NEVER use AI-cliche phrases: "dive into", "delve", "in today's fast-paced world", "buckle up", "look no further", "landscape" (overused), "elevates".

CATCH-UP SHELF: ${weekLabel}

THE CATALOG WORTH PULLING UP (last ~90 days):
${gemsBlock}

VERIFIED DECK FACTS — the ONLY data-backed superlatives/exclusivity claims available to you:
${factsBlock}

CARD COUNT — quality over coverage:
- Pick the best 4–10 films for the body cards. EVERY body slide is a hidden gem (type "gem") — there are no "arrival" slides on this pillar. Fewer is fine if fewer are genuinely worth featuring; NEVER pad with weak titles. Prefer 6–10 when the quality supports it.
- These are catch-up picks: "you missed this and you shouldn't have", not "this just dropped". Lean into films that flew under the radar but hold up.
- Title strings on gem slides MUST match the input title exactly so the renderer can map them to Release records.
- The JSON below shows a 5-card example for shape only — include as many body cards (4–10) as the slate genuinely warrants.
- If fewer than 4 worthwhile films exist, return carouselSlides: [] (empty array) to skip the pillar rather than padding with weak picks.

DELIVERABLES (respond as JSON):

{
  "weekHeadline": "ONE bold line. The post's spine. Pattern-recognition statement about the strongest catch-up picks — the films most people skipped that are quietly worth pulling up. e.g., 'The best Malayalam thriller of the last three months is sitting unwatched on Prime — and four more catalog gems deserve the same pull-up.'",
  "caption": "Under 140 words. Open with the weekHeadline or a variant. Walk through 3-4 specific gems with one-line takes on why each is worth catching up on now. End with CTA: 'Save this. DM us if you've watched any.'",
  "hashtags": ["10-12 hashtags array with # prefix"],
  "carouselSlides": [
    { "slideNumber": 1, "type": "cover", "title": "<6-word headline based on weekHeadline>", "body": "<short subtext>" },
    { "slideNumber": 2, "type": "headline", "title": "The catch-up shelf", "body": "<the weekHeadline expanded to 2 sentences>" },
    { "slideNumber": 3, "type": "gem", "title": "<exact film title>", "body": "<one-line why this is worth pulling up — platform, language, genre angle>", "isMusicDirectorNotable": false },
    { "slideNumber": 4, "type": "gem", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 5, "type": "gem", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 6, "type": "gem", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 7, "type": "gem", "title": "<exact film title>", "body": "<why this is worth pulling up from your watch list>", "isMusicDirectorNotable": false },
    { "slideNumber": 8, "type": "cta", "title": "<CTA>", "body": "Save. DM us. Which one are you starting?" }
  ]
}

SUPERLATIVE & EXCLUSIVITY — HARD RULES (accuracy guardrails for every blurb, caption line, and headline):
- A blurb may call a film the highest / top / most / best on a dimension ONLY if VERIFIED DECK FACTS above names that exact film for that dimension. Do not rank films against each other from the raw IMDb/TBSI numbers in the catalog list yourself.
- A film may be called the only / lone / sole "[Language]" film ONLY if VERIFIED DECK FACTS lists it as the sole title for that language.
- If a fact is absent above (a tie, or the data isn't available), make NO claim on that dimension. Never invent a superlative or an exclusivity claim, and never soften one to sneak it past this rule ("arguably the best", "one of the only", "quite possibly the highest-rated").
- At most ONE superlative per blurb. Never reuse the same superlative dimension on two different cards.

${notableComposersBlock()}

IMPORTANT:
- The weekHeadline is the most important line in the entire post. Make it specific, opinionated, and pattern-aware.
- Don't dilute. If there's only 1 truly great gem, lead with it and don't pad with weak ones.
- Hidden gems should feel like "you missed this and you shouldn't have" — not just "another good film".
- Every body slide MUST be type "gem". Do NOT emit "arrival" slides — new OTT drops are covered midweek, not here.

CAST-NAMING — HARD RULE: In any blurb, name only people listed in that
film's provided credit fields — its director, its leadCast, and its
musicDirector. These are exactly the names the card prints. Do NOT name any
actor, director, or crew member who is not in those fields — not from a
broader cast list, and not from your own knowledge of the film. If you write
"with X and Y", "X anchors it", or "Y scores it", every name must be that
film's director, a member of its leadCast, or its musicDirector.

HEADLINE RULE — the weekHeadline is about the catch-up shelf: the strongest
older films most people skipped and why they're worth pulling up now. Lead
with the single best pick, or with the clearest pattern across the slate (a
language run, a genre streak, a platform that's quietly stacked). Do NOT
frame anything as "new", "this week", or "just dropped" — this is catalog,
not new releases.

COVER & HEADLINE — DECK-ONLY RULE — the weekHeadline (cover title) and the
cover subtext may name ONLY films that appear in THIS deck (the gems listed
above). Do NOT name specific actors, films, or releases that are not among
these featured gems — even as a contrast or a "while X released" aside.
General framing is fine ("while the big headliners hogged the quarter's
attention", "the releases everyone talked about"); naming specific off-deck
people or titles is not.`;

  const output = await callClaudeJSON(prompt, MonMovementSchema, "sonnet");

  // Runtime guard: design contract is 4–10 body slides (arrival + gem types
  // combined), OR carouselSlides: [] (LLM judged the slate not worth a pillar
  // post). Mon is gems-only, so the body should be all "gem"; the ≥1-per-bucket
  // rule below only fires when BOTH input buckets had films, which never happens
  // now (arrivals is always empty). Anything else is a prompt regression.
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
