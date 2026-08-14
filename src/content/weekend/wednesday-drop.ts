// src/content/weekend/wednesday-drop.ts
import { format, parseISO } from "date-fns";
import { editorialCoverRange } from "../../shared/editorial-clock.js";
import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { WednesdayDropDraft } from "../../delivery/notion.js";
import type { WedDropEdition } from "../../shared/wed-drop-edition.js";
import { notableComposersBlock, enrichmentBlock } from "./_shared.js";
import { compareByProminence } from "../../shared/prominence.js";
import { hasRealVoteBase } from "../../shared/post-validator.js";
// THE Name Sweep — one implementation, shared with Archives + the News Desk.
// Wed keeps its OWN vocabulary (WED_DROP_NON_PERSON_WORDS below) and its own
// self-report/superlative rules; only the sweep mechanics are shared.
import {
  buildAllowlist,
  isPersonBacked,
  nameCandidates,
  nameTokens,
  personTokens,
  scrubDroppedFilms,
  type CopyNotice,
  type NameAllowlist,
} from "../../shared/copy-guard.js";

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
/**
 * Every score-bearing field on a Release. Listed explicitly (not pattern-matched)
 * so adding a new rating source is a deliberate decision about whether the LLM
 * may see it.
 */
const SCORE_FIELDS = [
  "tbsiScore", "tbsiSourceCount", "imdbRating", "imdbVotes",
  "rottenTomatoes", "rtAudience", "metacritic", "letterboxd",
  "tmdbVoteAverage", "tmdbVoteCount",
] as const satisfies readonly (keyof Release)[];

/**
 * THE LLM NEVER SEES WHAT IT MAY NOT PRINT (WD-042 Part 3).
 *
 * A film whose score has no real audience behind it renders a NEW stamp, not a
 * number — buildStampContext refuses the seal (see rendering/_shared.ts). But
 * the copy model was still handed the number, and a model handed "IMDb 8.3"
 * will write about 8.3. Prompt instructions are not a control surface; absence
 * is. So: if a film fails hasRealVoteBase — the SAME predicate that governs the
 * seal and the landing verifier — every score field is stripped before the
 * payload is built. Films that pass keep theirs untouched.
 *
 * The predicate is evaluated BEFORE stripping, because it reads vote counts.
 */
export function stripScoresForPrompt(r: Release): Release {
  if (hasRealVoteBase(r)) return r;
  const out = { ...r };
  for (const f of SCORE_FIELDS) delete out[f];
  return out;
}

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

/**
 * Manual audio-language override (WED_DROP_LANG operator dial — mirrors
 * WED_DROP_PLATFORM). A ';'-separated list of `Title=Lang1|Lang2|…` pairs; the
 * first language becomes audioLanguages.original, the rest become dubbed. The job
 * applies these POST-GATE, before the LLM + render, so the card's language row
 * reflects the operator-verified track — killing wrong-film bleed (e.g. an OMDb
 * "Russian" mismatch on a mismatched hit) without a code edit. Post-gate ⇒
 * hash-neutral (the --approve token stays valid; only the rendered set changes).
 */
export function parseLangOverrides(
  raw: string | undefined
): Map<string, { original: string; dubbed?: string[] }> {
  const map = new Map<string, { original: string; dubbed?: string[] }>();
  for (const pair of (raw ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const title = pair.slice(0, eq).trim().toLowerCase();
    const langs = pair
      .slice(eq + 1)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!title || langs.length === 0) continue;
    const [original, ...dubbed] = langs;
    map.set(title, dubbed.length ? { original: original!, dubbed } : { original: original! });
  }
  return map;
}

/** Apply WED_DROP_LANG overrides to a pool, returning a new pool + the count set. */
export function applyLangOverrides(
  pool: Release[],
  overrides: Map<string, { original: string; dubbed?: string[] }>
): { pool: Release[]; applied: number } {
  if (overrides.size === 0) return { pool, applied: 0 };
  let applied = 0;
  const out = pool.map((r) => {
    const lang = overrides.get(r.title.trim().toLowerCase());
    if (!lang) return r;
    applied += 1;
    return { ...r, audioLanguages: lang };
  });
  return { pool: out, applied };
}

// ── Copy self-policing (Phase 4 → Name Sweep v2 + Superlative Guard) ─────────
//
// Two deterministic, in-code guards vet the copy before it can render, both
// feeding the SAME one-retry / two-strike machinery in generateWednesdayDrop:
//
//  1. NAME SWEEP v2 — the LLM must never name a person absent from the provided
//     film data (the "Tabu"/"Madhuri" hallucinations nothing caught). v1 leaned on
//     the model's self-reported `namesUsed` plus a narrow "starring <Name>" regex,
//     so a name joined by "and"/"," (the actual escapes) or simply omitted from
//     `namesUsed` sailed through. v2 sweeps the REAL text for name-shaped runs and
//     checks each against the film data, independent of self-report.
//  2. SUPERLATIVE GUARD — a "top/highest/best-rated" claim must belong to the single
//     highest-tbsiScore film in the edition, else it is an unbacked rating claim.
//
// STRICT person-backing (Decision 2): a swept person-name is backed only when ALL
// its name-tokens are a subset of ONE film-data person's full name. This refuses the
// union-allowlist laundering of same-surname pattern-completions ("Shahid Kapoor"
// riding a real "Janhvi Kapoor"). A rare false drop is recoverable via WED_DROP_FORCE
// + the loud audit line; a laundered hallucination on a card is not.

interface CopyViolation {
  /** "name" = unbacked/undeclared person · "superlative" = false rating claim. */
  kind: "name" | "superlative";
  /** The offending text — the name, or the matched "top-rated"-style phrase. */
  name: string;
  /** The release-slide TITLE it sits in, or "caption" (a caption can't drop a film). */
  where: string;
  /** Superlatives only: the film that actually leads, named in the retry prompt. */
  leader?: string;
}

// Words that legitimately appear Titlecased in Wed Drop copy but are NOT people
// (pillar boilerplate + join words + streaming brands). Any of these tokens inside
// a swept run is treated as filler, so single non-name caps (Prayagraj, Eid,
// Netflix) and editorial phrases ("This Weekend", "Now Streaming", "Prime Video")
// are never mistaken for a name.
// WED-DROP-SPECIFIC — deliberately not merged with Archives'/News' lists. Adding
// a word here makes one more token count as filler, which makes the guard
// LOOSER; the lists stay per-pillar so no site inherits another's blind spots.
export const WED_DROP_NON_PERSON_WORDS: readonly string[] = [
  "the", "this", "that", "these", "now", "new", "our", "your", "one", "which",
  "weekend", "week", "weeks", "streaming", "stream", "theaters", "theatres",
  "theater", "cinema", "cinemas", "screen", "big", "box", "office", "drop",
  "watch", "watching", "must", "binge", "hidden", "gem", "arrival", "arrivals",
  "pick", "picks", "save", "dm", "us", "start", "starting", "south", "north",
  "indian", "india", "film", "films", "movie", "movies", "series", "show",
  // Genre/subject staples that read as capitalised nouns in editorial copy and
  // get owned by a possessive ("Rajkumar Santoshi's Partition" — Issue 041).
  // The sweep-unit fix in shared/copy-guard.ts already handles that shape; this
  // is the belt-and-braces half, and it also covers the non-possessive phrasings
  // ("a Partition love story") where no possessive terminates the run.
  // "yakshini" joins it for the same reason: Issue 042's copy called Aroopi's
  // spirit "A Yakshini", a capitalised folklore noun the sweep read as a person,
  // and it 2-struck the film out of the deck.
  "partition", "yakshini",
  "in", "on", "at", "of", "and", "or", "for", "with", "to", "from",
  "starring", "featuring", "alongside", "feat",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // Streaming brands (so "Prime Video", "Jio Hotstar", "Sony LIV" are not names)
  //
  // EVERY TOKEN OF A MULTI-WORD BRAND BELONGS HERE — "prime"+"video",
  // "jio"+"hotstar", "sony"+"liv", "sun"+"nxt". WD-ENG-01 found "lionsgate"
  // present and "play" MISSING, which made "Lionsgate Play" safe only by
  // accident: the phrase reaches the allowlist as non-person TEXT from the film
  // record's `platform` field, so it is covered when — and only when — the film
  // being written about actually carries that platform. Copy naming the service
  // for any other reason left "Play" as an unbacked token. Post-WD-ENG-01 that
  // is caption-level only and can no longer drop a film, but it is still a
  // spurious flag and a spurious retry.
  //
  // Adding a word here LOOSENS the guard, so it is a real decision, not a
  // formality: "Play" is not a person-name token in Indian film credits, and it
  // is markedly less name-like than "Sun", "Max", "Prime", "Aha" and "Zee",
  // which this list already carries. The brand-completeness pin in
  // wd-eng-01-authority.test.ts now enforces the rule rather than trusting it.
  "netflix", "prime", "video", "hotstar", "disney", "jiocinema", "jiohotstar",
  "jio", "sonyliv", "sony", "liv", "zee5", "zee", "aha", "hoichoi", "sunnxt",
  "sun", "nxt", "mubi", "lionsgate", "play", "apple", "tv", "manoramamax", "max",
];

// Rating superlatives that require the film to be the edition's strict-max
// tbsiScore. Hyphen/space/case tolerant — covers the production wart "our
// top-rated pick" verbatim. Bare curation ("our top pick") is intentionally NOT
// here: no score backing required.
const SUPERLATIVE_RE = /\b(?:top|highest|best)[-\s]?rated\b/i;

function buildNameAllowlist(releases: Release[]): NameAllowlist {
  const personNames: (string | undefined)[] = [];
  const nonPersonText: (string | undefined)[] = [];
  for (const r of releases) {
    personNames.push(...(r.cast ?? []), ...(r.leadCast ?? []), r.director, r.musicDirector);
    nonPersonText.push(r.title, ...r.platform, r.language);
  }
  return buildAllowlist({
    personNames,
    nonPersonText,
    nonPersonWords: WED_DROP_NON_PERSON_WORDS,
  });
}

/** True when the candidate's tokens are covered by some self-reported namesUsed entry. */
function isDeclared(toks: string[], declared: Set<string>[]): boolean {
  return declared.some((d) => toks.every((t) => d.has(t)) || [...d].every((t) => toks.includes(t)));
}

/** Which release slide's body contains this name, else "caption". */
function locateName(name: string, output: LLMOutput): string {
  const needle = name.toLowerCase();
  const rel = output.carouselSlides.find(
    (s) => s.type === "release" && s.body.toLowerCase().includes(needle)
  );
  return rel ? rel.title : "caption";
}

/** Text surfaces the sweep reads: the caption + every release-slide body. */
function copyTexts(output: LLMOutput): Array<{ text: string; where: string }> {
  return [
    { text: output.caption, where: "caption" },
    ...output.carouselSlides
      .filter((s) => s.type === "release")
      .map((s) => ({ text: s.body, where: s.title })),
  ];
}

/**
 * Every copy violation feeding the retry/two-strike path:
 *  • NAME SWEEP v2 — name-shaped runs (2–3 word N-grams + join-trigger singles) plus
 *    every self-reported namesUsed entry. A run that is not film-data-backed, or a
 *    backed run the model failed to declare in namesUsed, is a violation.
 *  • SUPERLATIVE GUARD — a "top/highest/best-rated" phrase on a film that is not the
 *    strict, UNIQUE-max tbsiScore film among the edition's scored picks.
 */
function findCopyViolations(
  output: LLMOutput,
  allow: NameAllowlist,
  releases: Release[]
): { violations: CopyViolation[]; undeclared: string[] } {
  const violations: CopyViolation[] = [];
  const undeclared: string[] = [];
  const undeclaredSeen = new Set<string>();
  const seen = new Set<string>();
  // Trailing sentence punctuation carries no identity, so "Gopi Sundar." (swept
  // from a sentence-final position) and "Gopi Sundar" (the model's namesUsed
  // entry) are ONE violation, not two. Issue 041/042 both showed the same name
  // striking twice this way, which double-counts a single problem in the retry
  // prompt and in the operator-facing flags.
  //
  // KEY ONLY — the label stays the ORIGINAL slice, per the module's hard rule
  // that reported strings come from the source text (see copy-guard.ts). This
  // changes nothing about which films drop: an offender still drops, on the same
  // strike, keyed by the same `where`.
  const stripTail = (s: string) => s.replace(/[.,;:!?"'’]+$/u, "").trim();
  const dedupeName = (s: string) => stripTail(s).toLowerCase();
  const seenAt = new Map<string, number>();
  const push = (v: CopyViolation) => {
    const key = `${v.kind}:${dedupeName(v.name)}:${v.where.toLowerCase()}`;
    const prev = seenAt.get(key);
    if (prev !== undefined) {
      // Same violation, two spellings. Keep the punctuation-free one: it reads
      // correctly in the retry prompt ("Tabu", not "Tabu.") and in the operator
      // flag. Still an ORIGINAL slice either way, never a scan-copy artefact.
      const held = violations[prev]!;
      if (held.name !== stripTail(held.name) && v.name === stripTail(v.name)) violations[prev] = v;
      return;
    }
    seenAt.set(key, violations.length);
    seen.add(key);
    violations.push(v);
  };

  // ── Name sweep v2 ──
  const declared = (output.namesUsed ?? []).map((n) => new Set(nameTokens(n)));
  for (const { text, where } of copyTexts(output)) {
    for (const raw of nameCandidates(text)) {
      const toks = personTokens(raw, allow);
      if (toks.length === 0) continue;                              // fully boilerplate → not a name
      if (!isPersonBacked(toks, allow.persons)) { push({ kind: "name", name: raw, where }); continue; }
      // ── BACKED BUT UNDECLARED — INFO ONLY (WD-042 Option 1) ────────────────
      // The name IS in this edition's film data (cast / leadCast / director /
      // musicDirector — every field the card prints). The model merely failed to
      // list it in its self-reported namesUsed. That is a bookkeeping slip in the
      // LLM's own paperwork, NOT an accuracy risk: nothing unverified reached the
      // copy. It used to be a full violation, which meant a retry and — on a
      // second miss — a DROPPED FILM, reported with the flatly false message
      // "not in film data". Issue 042 struck Vaani Kapoor, Ishwak Singh, Pritam,
      // Rajesh Murugesan and Gopi Sundar this way, all five backed.
      // It is now an info line and nothing more: no violation, no retry, no drop.
      if (!isDeclared(toks, declared)) {
        const key = dedupeName(raw);
        if (!undeclaredSeen.has(key)) {
          undeclaredSeen.add(key);
          undeclared.push(`"${raw}" @${where} — backed but undeclared in namesUsed`);
        }
      }
    }
  }
  // Self-report cannot launder: a declared name that is not film-data-backed is a
  // violation too (catches a hallucination named only in a non-scanned slide).
  for (const nm of output.namesUsed ?? []) {
    const toks = personTokens(nm, allow);
    if (toks.length === 0) continue;
    if (!isPersonBacked(toks, allow.persons)) push({ kind: "name", name: nm, where: locateName(nm, output) });
  }

  // ── Superlative guard (Phase 2) ──
  const scored = output.carouselSlides
    .filter((s) => s.type === "release")
    .map((s) => ({ title: s.title, score: releases.find((r) => r.title === s.title)?.tbsiScore }))
    .filter((x): x is { title: string; score: number } => typeof x.score === "number");
  let leader: string | undefined;
  if (scored.length > 0) {
    const max = Math.max(...scored.map((x) => x.score));
    const top = scored.filter((x) => x.score === max);
    if (top.length === 1) leader = top[0]!.title; // strict UNIQUE max only
  }
  for (const s of output.carouselSlides) {
    if (s.type !== "release") continue;
    const m = s.body.match(SUPERLATIVE_RE);
    if (!m) continue;
    if (s.title !== leader) {
      push({ kind: "superlative", name: m[0]!, where: s.title, ...(leader ? { leader } : {}) });
    }
  }
  return { violations, undeclared };
}

/** Build the one-retry prompt naming the exact violations (unbacked names + false ratings). */
function retryPromptFor(prompt: string, violations: CopyViolation[]): string {
  const names = violations.filter((v) => v.kind === "name");
  const supers = violations.filter((v) => v.kind === "superlative");
  let out = prompt;
  if (names.length) {
    out +=
      `\n\nNAME-DISCIPLINE VIOLATION — your previous response named ` +
      `${names.map((v) => `"${v.name}"`).join(", ")}, which is NOT backed by the provided film data ` +
      `(every named person must appear in that film's Cast / Lead cast / Director / Music director), ` +
      `or was used without being listed in "namesUsed". Regenerate the ENTIRE response: never name a ` +
      `person absent from a film's data, and list EVERY person you name in "namesUsed".`;
  }
  if (supers.length) {
    out +=
      `\n\nRATING-CLAIM VIOLATION — ` +
      supers
        .map((v) =>
          v.leader
            ? `"${v.where}" says "${v.name}" but the highest-rated film here is "${v.leader}"`
            : `"${v.where}" makes a "${v.name}" claim but no film here has a verified top rating`
        )
        .join("; ") +
      `. Regenerate: only the single highest-rated film may use a "top/highest/best-rated" phrase; ` +
      `every other film must sell itself WITHOUT a comparative rating claim.`;
  }
  return out;
}

/**
 * The Slack issue line for a surviving violation.
 *
 * WD-ENG-01 PART 1 — the slide-level outcome is no longer a single "DROPPED
 * film". `fed` decides it, and `fed` means one thing: was this title in the pool
 * the gate approved and handed to the LLM?
 *   fed   → copy-fallback. The blurb is replaced, THE FILM SHIPS.
 *   unfed → copy-drop. A title no Release backs is a hallucination; it goes.
 * A caption violation still cannot touch a film either way.
 */
function copyFlagFor(v: CopyViolation, fed: boolean): string {
  if (v.kind === "superlative") {
    const tail = v.leader ? ` (edition leader: "${v.leader}")` : "";
    if (v.where === "caption")
      return `copy rating-claim: "${v.name}" in CAPTION is not the edition's top-rated film${tail} — kept, review copy`;
    return fed
      ? `copy-fallback: ${v.where} — "${v.name}" is not the edition's top-rated film${tail}; blurb replaced with deterministic copy, film SHIPS`
      : `copy-drop: ${v.where} — "${v.name}" rating claim on a film not in the fed pool${tail}; slide removed`;
  }
  if (v.where === "caption")
    return `copy name-discipline: "${v.name}" not in film data — in CAPTION, kept but review copy manually`;
  return fed
    ? `copy-fallback: ${v.where} — "${v.name}" not in film data; blurb replaced with deterministic copy, film SHIPS`
    : `copy-drop: ${v.where} — "${v.name}" not in film data, and no Release backs this title; slide removed`;
}

/**
 * The deterministic, NAME-FREE blurb that replaces an offending one. Honest
 * metadata only — the exact mechanism Archives' `safeWhyLine` uses when a
 * why-line cannot be certified (and the state contract:why-line-grounding
 * demands when a synopsis is too thin to ground a claim).
 *
 * Every token it can emit is already allowlist filler: `language` and `platform`
 * enter `nonPersonText` from the film's own record, the genre is lowercased so no
 * extractor can see it, and the remaining words are in WED_DROP_NON_PERSON_WORDS.
 * So the replacement is provably sweep-clean — pinned by a test, not by
 * inspection, because a fallback that itself violated would loop.
 */
export function safeBlurb(r: Release, edition: WedDropEdition): string {
  const genre = (r.genre[0] ?? "film").toLowerCase();
  if (edition === "theatrical") {
    return `A new ${r.language} ${genre} opening in cinemas this weekend.`;
  }
  const platform = r.platform[0];
  return platform
    ? `A new ${r.language} ${genre} streaming on ${platform} this week.`
    : `A new ${r.language} ${genre} streaming this week.`;
}

/**
 * Generate a Wednesday Drop draft from a list of releases for a given edition
 * ("theatrical" → In Theaters | "ott" → Now Streaming). Each edition is an
 * independent draft built from its own pool. Returns the draft plus:
 *   `nameFlags`    — human-readable lines for Slack: copy violations that
 *                    survived one retry (blurb replaced, slide dropped, or a
 *                    caption violation kept-but-flagged).
 *   `copyNotices`  — the SAME events, structured, for the manifest. A
 *                    copy-fallback is a non-blocking warn; a copy-drop whose
 *                    scrub could not be certified is a FAIL, and the 4c render
 *                    gate stops the edition on it.
 * Both are plain widenings; neither changes WednesdayDropDraft.
 */
export async function generateWednesdayDrop(
  releases: Release[],
  edition: WedDropEdition,
  weekendStart: string,
  weekendEnd: string
): Promise<WednesdayDropDraft & { nameFlags: string[]; copyNotices: CopyNotice[] }> {
  if (releases.length === 0) {
    throw new Error("Cannot generate Wednesday Drop with zero releases");
  }

  const weekendDates = `${format(parseISO(weekendStart), "MMM d")} — ${format(parseISO(weekendEnd), "MMM d, yyyy")}`;
  const framing = editionFraming(edition, weekendDates);

  log.info(`Generating Wednesday Drop [${edition}] for ${weekendDates} (${releases.length} releases)`);
  
  // Score-strip BEFORE serialising: a film with no real vote base reaches the
  // model with no number to repeat (WD-042 Part 3). The un-stripped `releases`
  // stays the source of truth for the allowlist, the selector and the cards.
  const releaseBlocks = releases
    .map((r, i) => `--- RELEASE ${i + 1} ---\n${releaseForPrompt(stripScoresForPrompt(r))}`)
    .join("\n\n");
  
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
- Skip an entry ONLY if it is not a real film — a trailer or promo clip, a mislabeled or duplicate entry, something with no real release, a SERIES or show, or adult content. Everything else that is a genuine release belongs in the guide.
- MINI-FILMS AND SHORT FEATURES ARE IN SCOPE. A genuine, standalone, professionally released short or mini-film (the ETV Win mini-film slate, for instance) is a real film and belongs in the guide on the same terms as a feature. Runtime is NOT an eligibility test — only "is it a real, standalone, non-series release".
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

  // Copy self-policing (Phase 4). NAME SWEEP v2 + SUPERLATIVE GUARD share ONE
  // path: validate the copy, ONE retry naming the exact violation(s); a SECOND
  // strike drops the offending film(s) (never silently strips, never fails the
  // whole run). A caption-only violation is kept-but-flagged (can't drop a film).
  const allow = buildNameAllowlist(releases);
  const nameFlags: string[] = [];
  const copyNotices: CopyNotice[] = [];
  let { violations, undeclared } = findCopyViolations(output, allow, releases);
  // Backed-but-undeclared names are INFO ONLY — logged, never acted on. They do
  // not gate the retry and they never reach nameFlags or a drop (WD-042).
  const logUndeclared = (lines: string[]) => {
    if (lines.length === 0) return;
    log.info(`Wed Drop [${edition}]: name bookkeeping — ${lines.join("; ")}`);
  };
  logUndeclared(undeclared);
  if (violations.length > 0) {
    log.warn(
      `Wed Drop [${edition}]: copy self-policing violation(s), retrying once — ${violations.map(v => `${v.kind}:"${v.name}" @${v.where}`).join("; ")}`
    );
    output = await callClaudeJSON(retryPromptFor(prompt, violations), WedDropSchema, "sonnet");
    ({ violations, undeclared } = findCopyViolations(output, allow, releases));
    logUndeclared(undeclared);
  }
  if (violations.length > 0) {
    // ── WD-ENG-01 PART 1 — THE FED POOL IS UNDROPPABLE ────────────────────
    // A film in `releases` has already cleared discovery, reconciliation, the
    // AI net, the country gate, the ledger dedup and the operator's gate hash.
    // The copy guard's job is to keep an unverified PHRASE off a card; deleting
    // the FILM was always a category error, and it cost Batwara 1947 (041) and
    // Aroopi (042) their slots on phrases that were never names at all.
    //
    // Fed → the blurb is replaced with deterministic copy and the film ships.
    // Unfed → the model named a title no Release backs. That is the genuine
    // hallucination case, and it still drops. Note the ordering: the drop MUST
    // stay ahead of the picked-titles reconciliation below, which throws on an
    // unmatched title — that throw is what this branch spares the run.
    const fedTitles = new Set(releases.map(r => r.title));
    const fallbackTitles = new Set<string>();
    const dropTitles = new Set<string>();
    for (const v of violations) {
      if (v.where === "caption") continue;
      (fedTitles.has(v.where) ? fallbackTitles : dropTitles).add(v.where);
    }
    for (const v of violations) {
      const fed = v.where !== "caption" && fedTitles.has(v.where);
      nameFlags.push(copyFlagFor(v, fed));
      if (v.where === "caption") continue;
      copyNotices.push({
        kind: fed ? "copy-fallback" : "copy-drop",
        title: v.where,
        term: v.name,
      });
    }

    if (fallbackTitles.size > 0) {
      log.warn(
        `Wed Drop [${edition}]: copy self-policing — 2 strikes on ${fallbackTitles.size} GATE-APPROVED film(s); ` +
        `blurb replaced with deterministic copy, film(s) SHIP: ${[...fallbackTitles].join(", ")}`
      );
      const byTitle = new Map(releases.map(r => [r.title, r]));
      output = {
        ...output,
        carouselSlides: output.carouselSlides.map(s =>
          s.type === "release" && fallbackTitles.has(s.title) && byTitle.has(s.title)
            ? { ...s, body: safeBlurb(byTitle.get(s.title)!, edition) }
            : s
        ),
      };
    }

    if (dropTitles.size > 0) {
      log.error(
        `Wed Drop [${edition}]: copy self-policing — 2 strikes, dropping ${dropTitles.size} UNFED film(s): ${[...dropTitles].join(", ")}`
      );
      const kept = output.carouselSlides.filter(s => !(s.type === "release" && dropTitles.has(s.title)));
      // If every real film was dropped, skip the edition (empty carousel).
      const anyReleaseLeft = kept.some(s => s.type === "release");
      output = { ...output, carouselSlides: anyReleaseLeft ? kept : [] };

      // ── WD-ENG-01 PART 3 — ANY DROP IS LOUD AND CLEAN ───────────────────
      // The card is gone; every other surface must stop referring to it. Scrub
      // the caption, the index slide and the count words, then check the work.
      // An uncertifiable scrub marks the notices `scrubFailed`, and the job's
      // manifest turns that into ok:false so the 4c gate blocks the edition —
      // a blocked edition beats a self-contradicting one.
      if (anyReleaseLeft) {
        const dropped = [...dropTitles];
        const keptCount = kept.filter(s => s.type === "release").length;
        const indexSlide = kept.find(s => s.type === "index");
        const scrub = scrubDroppedFilms(output.caption, indexSlide?.body ?? "", dropped, keptCount);
        output = {
          ...output,
          caption: scrub.caption,
          carouselSlides: output.carouselSlides.map(s =>
            s.type === "index" ? { ...s, body: scrub.indexBody } : s
          ),
        };
        if (scrub.clean) {
          log.warn(
            `Wed Drop [${edition}]: post-drop scrub clean — caption + index carry no trace of ` +
            `${dropped.join(", ")}; counts retargeted to ${keptCount}`
          );
        } else {
          log.error(
            `Wed Drop [${edition}]: post-drop scrub COULD NOT BE CERTIFIED — ${scrub.problems.join("; ")}. ` +
            `Marking the edition unshippable.`
          );
          for (const n of copyNotices) if (n.kind === "copy-drop") n.scrubFailed = true;
        }
      }
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
    weekendRange: editorialCoverRange(weekendStart, weekendEnd),
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    slides: sorted.slides,
    carouselSlides,
    releases: sorted.releases,
    nameFlags,
    copyNotices,
  };
}