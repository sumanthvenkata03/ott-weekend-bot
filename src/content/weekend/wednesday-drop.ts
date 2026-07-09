// src/content/weekend/wednesday-drop.ts
import { format, parseISO } from "date-fns";
import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { WednesdayDropDraft } from "../../delivery/notion.js";
import type { WedDropEdition } from "../../shared/wed-drop-edition.js";
import { notableComposersBlock, enrichmentBlock } from "./_shared.js";
import { compareByProminence } from "../../shared/prominence.js";

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
  // Every real person named anywhere in caption/slide bodies (name-discipline,
  // Phase 4). The deterministic validator checks this against the film data's
  // allowlist; a name outside it triggers a retry, then a drop.
  namesUsed: z.array(z.string()).default([]),
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
 * Reorder a Wed Drop draft into deterministic PROMINENCE-descending order (the
 * biggest film first, irrespective of rating/verdict — see prominence.ts),
 * overriding the LLM's own ordering. The releases array is sorted by
 * compareByProminence (fixing the cover, which reads releases[0..3]); the
 * 'release' slides are reordered to match the sorted releases by exact title
 * (fixing the body cards AND the Notion markdown, which both flow from slide
 * order). Non-release slides (cover / index / cta) keep their positions, and
 * every slide is renumbered so slideNumber stays ascending in the Notion
 * markdown. Inputs are not mutated; new arrays are returned. Array.sort is
 * stable, so the vote-count/title tiebreakers fully determine equal-popularity
 * ties. This is presentation order only — it never touches the gate hash.
 */
export function sortWedDropByProminence<
  S extends { type: string; title: string; slideNumber: number }
>(slides: S[], releases: Release[]): { slides: S[]; releases: Release[] } {
  const sortedReleases = [...releases].sort(compareByProminence);
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

// ── Copy name-discipline (Phase 4) — deterministic, in code ──────────────────
//
// The LLM must never name a person absent from the provided film data (the
// "Tabu" hallucination nothing checked). The allowlist per drop is the UNION of
// every picked film's cast + leadCast + director + musicDirector + title words +
// platform + language. A named person is a VIOLATION when it shares ZERO token
// with that allowlist — deliberately LENIENT (any token overlap passes) so a
// legitimate blurb is never dropped, while a wholly-unbacked name is always caught.

type LLMSlide = z.infer<typeof WedDropSlideSchema>;
interface NameViolation {
  name: string;
  /** The release-slide TITLE the name sits in, or "caption" (can't drop a film). */
  where: string;
}

/** Lowercased significant tokens (≥2 chars) of a free-text name/phrase. */
function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function buildNameAllowlist(releases: Release[]): Set<string> {
  const allow = new Set<string>();
  const addAll = (s?: string) => {
    if (s) for (const t of nameTokens(s)) allow.add(t);
  };
  for (const r of releases) {
    (r.cast ?? []).forEach(addAll);
    (r.leadCast ?? []).forEach(addAll);
    addAll(r.director);
    addAll(r.musicDirector);
    addAll(r.title);
    for (const p of r.platform) addAll(p);
    addAll(r.language);
  }
  return allow;
}

/** A name is allowed if ANY of its tokens overlaps the allowlist (lenient). */
function isNameAllowed(name: string, allow: Set<string>): boolean {
  const toks = nameTokens(name);
  if (toks.length === 0) return true;
  return toks.some((t) => allow.has(t));
}

/** Which release slide's body contains this name, else "caption". */
function locateName(name: string, output: LLMOutput): string {
  const needle = name.toLowerCase();
  const rel = output.carouselSlides.find(
    (s) => s.type === "release" && s.body.toLowerCase().includes(needle)
  );
  return rel ? rel.title : "caption";
}

/**
 * Find name-discipline violations: (1) any self-reported `namesUsed` entry
 * outside the allowlist, and (2) belt-and-braces — a Capitalized name introduced
 * by "with/starring/alongside/featuring/&" in a body/caption that is outside the
 * allowlist (catches names the model failed to self-report).
 */
function findNameViolations(output: LLMOutput, allow: Set<string>): NameViolation[] {
  const violations: NameViolation[] = [];
  const seen = new Set<string>();
  const push = (name: string, where: string) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ name, where });
  };

  for (const nm of output.namesUsed ?? []) {
    if (!isNameAllowed(nm, allow)) push(nm, locateName(nm, output));
  }

  const texts: Array<{ text: string; where: string }> = [
    { text: output.caption, where: "caption" },
    ...output.carouselSlides.filter((s) => s.type === "release").map((s) => ({ text: s.body, where: s.title })),
  ];
  const re = /\b(?:with|starring|alongside|featuring|feat\.?|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g;
  for (const { text, where } of texts) {
    for (const m of text.matchAll(re)) {
      const nm = m[1]!;
      if (!isNameAllowed(nm, allow)) push(nm, where);
    }
  }
  return violations;
}

/**
 * Generate a Wednesday Drop draft from a list of releases for a given edition
 * ("theatrical" → In Theaters | "ott" → Now Streaming). Each edition is an
 * independent draft built from its own pool. Returns the draft plus `nameFlags`
 * — copy name-discipline violations that survived one retry (offending film
 * dropped, or a caption violation kept-but-flagged) for the job to surface in
 * Slack. `nameFlags` is a plain widening; it never changes WednesdayDropDraft.
 */
export async function generateWednesdayDrop(
  releases: Release[],
  edition: WedDropEdition,
  weekendStart: string,
  weekendEnd: string
): Promise<WednesdayDropDraft & { nameFlags: string[] }> {
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

ANCHOR THIS EDITION ON THE STANDOUT FILM:
- Choose the single STANDOUT film from the list to anchor this edition — normally the highest-rated marquee title (use the rating data provided); if no film is rated, the most anticipated / highest-profile release.
- OPEN the caption with a specific, catchy hook about that film (name it, its star/director, the angle) — never a generic "N films this week" opener.
- Write the COVER headline and subtitle around that same standout (or the week's theme led by it). ${framing.cover} Stay specific and editorial.

DELIVERABLES (respond as JSON):

{
  "caption": "Instagram caption text under 150 words. OPEN with a specific, catchy hook on the STANDOUT film (name it + its star/director + the angle) — not a generic 'N films this week' opener. Then mention the other notable drop, the hidden gem, the regional spotlight if any, and close with 'Save this' / 'DM us' / 'Which one are you watching?' CTA.",
  "hashtags": ["array", "of", "10-12", "hashtags", "with", "the", "# prefix"],
  "namesUsed": ["every", "real person", "you name anywhere in the caption or slide bodies"],
  "carouselSlides": [
    { "slideNumber": 1, "type": "cover", "title": "<6-word headline anchored on the standout film>", "body": "<10-word subtext>" },
    { "slideNumber": 2, "type": "index", "title": "This weekend", "body": "<quick visual list: Title (Language) → Platform>" },
    { "slideNumber": 3, "type": "release", "title": "<exact film title>", "body": "<one-line WHY this matters — not a synopsis, a reason to care>", "isMusicDirectorNotable": false },
    { "slideNumber": 4, "type": "release", "title": "<exact film title>", "body": "<...>", "isMusicDirectorNotable": false },
    "… one 'release' slide per INCLUDED film — a VARIABLE, potentially long list of up to ${MAX_WED_DROP_FILMS} releases (one per real film in this medium, not a fixed 4) …",
    { "slideNumber": "<last>", "type": "cta", "title": "<short CTA>", "body": "<which one are you starting with?>" }
  ]
}

${notableComposersBlock()}

NAME DISCIPLINE (hard rule — non-negotiable): NEVER name a person (actor,
director, composer, character-as-actor) who is NOT present in the provided
film data for that film (its Cast / Lead cast / Director / Music director).
Do NOT recall a star from memory, and do NOT attribute a film to a person you
"think" is in it. If you are unsure who is in a film, describe it WITHOUT
naming anyone. List EVERY person you name anywhere (caption + slide bodies) in
the top-level "namesUsed" array — this is checked against the film data, and a
name that is not in the data will cause the copy to be regenerated or the film
dropped.

CAST OVERLAP RULE for release slide body copy — whenever you name an actor
in a slide's body, at least one of the actors you name MUST also appear in
that film's "Lead cast (top-billed)" line from the input. Both that line
and the broader "Cast:" list are available; reference whichever actor sells
the slide best, but make sure one name overlaps with leadCast so the body
and the card's metadata line stay aligned. If leadCast already contains the
recognizable name, just use those.

Be specific. Take stands. Lean South-heavy where the films justify it.`;
  
  let output = await callClaudeJSON(prompt, WedDropSchema, "sonnet");

  // Copy name-discipline (Phase 4). Validate names against the film-data
  // allowlist; ONE retry naming the exact violation; a SECOND violation drops
  // the offending film(s) (never silently strips, never fails the whole run).
  const allow = buildNameAllowlist(releases);
  const nameFlags: string[] = [];
  let violations = findNameViolations(output, allow);
  if (violations.length > 0) {
    log.warn(
      `Wed Drop [${edition}]: name-discipline violation(s), retrying once — ${violations.map(v => `"${v.name}" @${v.where}`).join("; ")}`
    );
    const retryPrompt =
      `${prompt}\n\nNAME-DISCIPLINE VIOLATION — your previous response named ` +
      `${violations.map(v => `"${v.name}"`).join(", ")}, which is NOT in the provided film data. ` +
      `Regenerate the ENTIRE response: never name a person absent from a film's Cast / Lead cast / ` +
      `Director / Music director, and list every person you name in "namesUsed".`;
    output = await callClaudeJSON(retryPrompt, WedDropSchema, "sonnet");
    violations = findNameViolations(output, allow);
  }
  if (violations.length > 0) {
    const dropTitles = new Set(violations.filter(v => v.where !== "caption").map(v => v.where));
    for (const v of violations) {
      nameFlags.push(
        v.where === "caption"
          ? `copy name-discipline: "${v.name}" not in film data — in CAPTION, kept but review copy manually`
          : `copy name-discipline: "${v.name}" not in film data — DROPPED film "${v.where}"`
      );
    }
    if (dropTitles.size > 0) {
      log.error(
        `Wed Drop [${edition}]: name-discipline — 2 strikes, dropping ${dropTitles.size} film(s): ${[...dropTitles].join(", ")}`
      );
      const kept = output.carouselSlides.filter(s => !(s.type === "release" && dropTitles.has(s.title)));
      // If every real film was dropped, skip the edition (empty carousel).
      const anyReleaseLeft = kept.some(s => s.type === "release");
      output = { ...output, carouselSlides: anyReleaseLeft ? kept : [] };
    }
  }

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

  // Deterministic PROMINENCE sort — supersedes the LLM's own "order best-first"
  // ordering (that prompt rule is now redundant but harmless). Sorting both the
  // releases and the 'release' slides here makes the cover (releases[0..3]),
  // the body cards (release-slide order) and the Notion draft (markdown + the
  // featured-releases bullets) all lead with the biggest film. Presentation
  // order only — the gate already ran (and hashed) upstream, so this is
  // hash-neutral by construction.
  const sorted = sortWedDropByProminence(output.carouselSlides, pickedReleases);

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
    nameFlags,
  };
}