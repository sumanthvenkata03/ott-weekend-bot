// src/content/weekend/wednesday-drop.ts
import { format, parseISO } from "date-fns";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { WednesdayDropDraft } from "../../delivery/notion.js";
import { notableComposersBlock, enrichmentBlock } from "./_shared.js";

interface LLMOutput {
  caption: string;
  hashtags: string[];
  carouselSlides: {
    slideNumber: number;
    type: "cover" | "index" | "release" | "cta";
    title: string;
    body: string;
    isMusicDirectorNotable?: boolean;
  }[];
}

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
 * Generate a Wednesday Drop draft from a list of releases.
 */
export async function generateWednesdayDrop(
  releases: Release[],
  weekendStart: string,
  weekendEnd: string
): Promise<WednesdayDropDraft> {
  if (releases.length === 0) {
    throw new Error("Cannot generate Wednesday Drop with zero releases");
  }
  
  const weekendDates = `${format(parseISO(weekendStart), "MMM d")} — ${format(parseISO(weekendEnd), "MMM d, yyyy")}`;
  
  log.info(`Generating Wednesday Drop for ${weekendDates} (${releases.length} releases)`);
  
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

TASK: Generate a Wednesday "The Drop" Instagram carousel post for this weekend.

WEEKEND: ${weekendDates}

THIS WEEKEND'S RELEASES (${releases.length} total):

${releaseBlocks}

CARD COUNT — quality over coverage:
- Pick EXACTLY 4 films from the slate above — the 4 most worth talking about for an OTT-decision audience.
- Title strings on release slides must match the input title exactly (case + punctuation) so the renderer can match them to the Release records.
- If fewer than 4 films are worth talking about this week, return carouselSlides: [] (empty array) to skip the pillar rather than padding with weak picks.

DELIVERABLES (respond as JSON):

{
  "caption": "Instagram caption text under 150 words. Opens with a hook, mentions the biggest drop, the hidden gem, the regional spotlight if any, closes with 'Save this' / 'DM us' / 'Which one are you watching?' CTA.",
  "hashtags": ["array", "of", "10-12", "hashtags", "with", "the", "# prefix"],
  "carouselSlides": [
    { "slideNumber": 1, "type": "cover", "title": "<6-word headline>", "body": "<10-word subtext>" },
    { "slideNumber": 2, "type": "index", "title": "This weekend", "body": "<quick visual list: Title (Language) → Platform>" },
    { "slideNumber": 3, "type": "release", "title": "<exact film title>", "body": "<one-line WHY this matters — not a synopsis, a reason to care>", "isMusicDirectorNotable": false },
    { "slideNumber": 4, "type": "release", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 5, "type": "release", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 6, "type": "release", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    { "slideNumber": 7, "type": "cta", "title": "<short CTA>", "body": "<which one are you starting with?>" }
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
  
  const output = await callClaudeJSON<LLMOutput>(prompt, "sonnet");

  // Runtime guard: design contract is exactly 4 release slides, OR all-empty
  // (the "skip the pillar this week" branch). Anything else is a prompt regression.
  const releaseSlideCount = output.carouselSlides.filter(s => s.type === "release").length;
  if (output.carouselSlides.length !== 0 && releaseSlideCount !== 4) {
    throw new Error(
      `Wed Drop LLM returned ${releaseSlideCount} release slides; expected exactly 4 or 0 (skip)`
    );
  }

  // Trim draft.releases to the films the LLM actually picked, keeping the
  // slide order. This keeps the cover's 2x2 grid and the body cards aligned
  // on the same 4 films (otherwise the cover would show the first 4 releases
  // by ingestion order while the cards show the LLM's picks).
  const pickedTitles = output.carouselSlides
    .filter(s => s.type === "release")
    .map(s => s.title);
  const pickedReleases = pickedTitles
    .map(t => releases.find(r => r.title === t))
    .filter((r): r is Release => r !== undefined);

  if (output.carouselSlides.length !== 0 && pickedReleases.length !== 4) {
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