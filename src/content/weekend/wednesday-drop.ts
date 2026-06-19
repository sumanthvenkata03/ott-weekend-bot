// src/content/weekend/wednesday-drop.ts
import { format, parseISO } from "date-fns";
import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { WednesdayDropDraft } from "../../delivery/notion.js";
import type { WedDropEdition } from "../../shared/wed-drop-edition.js";
import { notableComposersBlock, enrichmentBlock } from "./_shared.js";

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
      pick: `Pick UP TO ${MAX_WED_DROP_FILMS} films from the slate above genuinely worth SEEING IN CINEMAS this weekend.`,
      cover: `Write a cinema-weekend cover headline (≤6 words) + subtitle (≤10 words) that makes people want to get out to the theater.`,
      why: `For each pick, the body is a one-line "why see it in theaters this weekend" — a reason to buy a ticket, NOT a synopsis.`,
    };
  }
  return {
    task: `Generate a Wednesday "The Drop — Now Streaming" Instagram carousel for the films STREAMING this week (Mon–Sun).`,
    slateHeader: `THESE FILMS ARE STREAMING THIS WEEK (${weekendDates}) — this week's digital arrivals, watchable all weekend`,
    pick: `Pick UP TO ${MAX_WED_DROP_FILMS} films from the slate above genuinely worth STREAMING this weekend.`,
    cover: `Write a streaming-weekend cover headline (≤6 words) + subtitle (≤10 words) that sells a great weekend on the couch.`,
    why: `For each pick, NAME THE PLATFORM it streams on, and write a one-line "why stream it" — a reason to hit play, NOT a synopsis.`,
  };
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

CARD COUNT — quality over coverage:
- ${framing.pick}
- ${framing.cover}
- ${framing.why}
- Quality over coverage: if fewer are worthwhile, pick fewer; do NOT pad to ${MAX_WED_DROP_FILMS} with weak titles. If NONE are worth talking about, return carouselSlides: [] (empty array) to skip this edition.
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
    "… one 'release' slide per picked film — a VARIABLE count, up to ${MAX_WED_DROP_FILMS} total (not a fixed 4) …",
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

  // Render carousel slides as markdown for the Notion body
  const carouselSlides = output.carouselSlides
    .map(s => `**Slide ${s.slideNumber}** (${s.type}): **${s.title}** — ${s.body}`)
    .join("\n\n");

  return {
    pillar: "Wed Drop",
    weekendDates,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    slides: output.carouselSlides,
    carouselSlides,
    releases: pickedReleases,
  };
}