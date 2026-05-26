// src/content/weekend/monday-movement.ts
import { format, parseISO } from "date-fns";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { MovementDraft } from "../../delivery/notion.js";

interface LLMOutput {
  weekHeadline: string;
  caption: string;
  hashtags: string[];
  carouselSlides: {
    slideNumber: number;
    type: "cover" | "headline" | "arrival" | "gem" | "cta";
    title: string;
    body: string;
  }[];
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
- Pick EXACTLY 5 films for the body cards — a mix of NEW ARRIVALS (type "arrival") and HIDDEN GEMS (type "gem").
- REQUIRED: at least 1 of each variant. The pillar loses meaning if it's all NEW or all GEM.
- LLM judges the split based on the week. Strong week of arrivals → lean arrival-heavy (e.g. 4 NEW + 1 GEM). Quiet week → lean gem-heavy (e.g. 1 NEW + 4 GEM). Balanced week → 3+2 or 2+3.
- Title strings on arrival/gem slides MUST match the input title exactly so the renderer can map them to Release records.
- If fewer than 5 worthwhile films exist across both buckets combined, return carouselSlides: [] (empty array) to skip the pillar rather than padding with weak picks.

DELIVERABLES (respond as JSON):

{
  "weekHeadline": "ONE bold line. The post's spine. Pattern-recognition statement about what this week's movement reveals. e.g., 'Three Malayalam thrillers landed this week and not one Hindi drama. Mollywood is running the genre clock.'",
  "caption": "Under 140 words. Open with the weekHeadline or a variant. Walk through 2-3 specific arrivals with one-line takes. Mention 1-2 hidden gems. End with CTA: 'Save this. DM us if you've watched any.'",
  "hashtags": ["10-12 hashtags array with # prefix"],
  "carouselSlides": [
    { "slideNumber": 1, "type": "cover", "title": "<6-word headline based on weekHeadline>", "body": "<short subtext>" },
    { "slideNumber": 2, "type": "headline", "title": "This week in OTT", "body": "<the weekHeadline expanded to 2 sentences>" },
    { "slideNumber": 3, "type": "arrival", "title": "<exact film title>", "body": "<one-line why this matters — platform, language, genre angle>" },
    { "slideNumber": 4, "type": "arrival|gem", "title": "<exact film title>", "body": "<...>" },
    { "slideNumber": 5, "type": "arrival|gem", "title": "<exact film title>", "body": "<...>" },
    { "slideNumber": 6, "type": "arrival|gem", "title": "<exact film title>", "body": "<...>" },
    { "slideNumber": 7, "type": "gem", "title": "Hidden Gem: <exact film title>", "body": "<why this is worth pulling up from your watch list>" },
    { "slideNumber": 8, "type": "cta", "title": "<CTA>", "body": "Save. DM us. Which one are you starting?" }
  ]
}

IMPORTANT:
- The weekHeadline is the most important line in the entire post. Make it specific, opinionated, and pattern-aware.
- Don't dilute. If there's only 1 great arrival, lead with it and don't pad with weak ones.
- Hidden gems should feel like "you missed this and you shouldn't have" — not just "another good film."

HEADLINE MIX RULE — the weekHeadline must acknowledge BOTH variants in this week's slate, the new arrivals (type "arrival") AND the hidden gems (type "gem"). Mon Movement always has ≥1 of each by design constraint, so this rule applies on every standard run. When the mix is heavily skewed (4 arrival + 1 gem, or 1 arrival + 4 gem), the lighter variant needs only a brief acknowledgment — a half-clause is enough — but it must appear.

Acceptable headline shapes:
- Lead with arrivals, acknowledge gems at the end: "...meanwhile Mollywood's March catalog is still the strongest watch"
- Lead with the gem angle, acknowledge arrivals: "Two Malayalam thrillers worth catching up on while Hindi delivers its one big Sonakshi face-off"
- Frame the contrast directly: "Telugu Prime Video's loud week vs. Mollywood's quiet excellence"

Not acceptable: headline that only mentions arrivals when gems exist, or only mentions gems when arrivals exist.`;
  
  const output = await callClaudeJSON<LLMOutput>(prompt, "sonnet");

  // Runtime guard: design contract is exactly 5 body slides (arrival + gem types
  // combined) with at least 1 of each variant. OR carouselSlides: [] (LLM judged
  // the week not worth a pillar post). Anything else is a prompt regression.
  const arrivalSlides = output.carouselSlides.filter(s => s.type === "arrival");
  const gemSlides     = output.carouselSlides.filter(s => s.type === "gem");
  const bodyCount     = arrivalSlides.length + gemSlides.length;

  if (output.carouselSlides.length !== 0) {
    if (bodyCount !== 5) {
      throw new Error(
        `Mon Movement LLM returned ${bodyCount} body slides ` +
        `(${arrivalSlides.length} arrival + ${gemSlides.length} gem); expected exactly 5 or 0 (skip)`
      );
    }
    if (arrivalSlides.length < 1 || gemSlides.length < 1) {
      throw new Error(
        `Mon Movement mix invalid: ${arrivalSlides.length} NEW + ${gemSlides.length} GEM ` +
        `(need at least 1 of each variant)`
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

  if (output.carouselSlides.length !== 0 && pickedArrivals.length + pickedGems.length !== 5) {
    throw new Error(
      `Mon Movement: LLM picked ${bodyCount} titles but only ${pickedArrivals.length + pickedGems.length} ` +
      `matched a Release record. Check that title strings match the input exactly.`
    );
  }

  const carouselSlides = output.carouselSlides
    .map(s => `**Slide ${s.slideNumber}** (${s.type}): **${s.title}** — ${s.body}`)
    .join("\n\n");

  return {
    pillar: "Mon Movement",
    weekLabel,
    weekHeadline: output.weekHeadline,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    slides: output.carouselSlides,
    carouselSlides,
    newArrivals: pickedArrivals,
    hiddenGems: pickedGems,
  };
}