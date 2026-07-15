// src/content/archives/copy-guard.ts
//
// ⚠ SCHEDULED DUPLICATE — DO NOT let this drift silently. ⚠
// This is a self-contained copy of the Name Sweep v2 logic that currently lives
// module-private in src/content/weekend/wednesday-drop.ts (findCopyViolations &
// friends). It is duplicated here on purpose: wednesday-drop.ts is in the
// never-touch pillar set, so its private guard cannot be exported without editing
// it. UNIFICATION IS QUEUED: when the Saturday name-sweep port lands, all THREE
// call sites (Wed Drop, Sat Verdict, Archives) merge into one shared module and
// this file is deleted. Until then, any fix to the sweep here must be mirrored to
// wednesday-drop.ts (and vice-versa).
//
// Backing-set semantics are IDENTICAL to Wednesday's (ruling R2c): a swept
// person-name is backed only when ALL its name-tokens are a subset of ONE film's
// cast/crew/director/composer full name. Film data only — there is no self-report
// to launder (Archives copy is a single why-line per card, not an LLM name list),
// so the sweep reads the real text directly. This catches both an invented name
// AND a misspelled real credit (the "Govindh" for "Govind" class — {govindh} is
// not a subset of {govind}).

import type { Release } from "../../shared/types.js";

// Honorifics carry no identity — strip so "Mr. Bachchan" ~ "Bachchan".
const HONORIFICS = new Set(["mr", "mrs", "ms", "dr", "sri", "smt", "shri"]);

// Titlecased words that are NOT people: pillar boilerplate + join words +
// streaming brands. A swept run made only of these is filler, never a name.
const NON_PERSON_WORDS: readonly string[] = [
  "the", "this", "that", "these", "now", "new", "our", "your", "one", "which",
  "tonight", "weekend", "week", "weeks", "streaming", "stream", "watch", "watching",
  "archive", "archives", "vintage", "classic", "classics", "gem", "gems", "missed",
  "must", "binge", "again", "still", "years", "year", "ago", "back", "then", "now",
  "in", "on", "at", "of", "and", "or", "for", "with", "to", "from", "a", "an",
  "starring", "featuring", "alongside", "feat", "directed", "director", "dir",
  "comedy", "drama", "thriller", "action", "romance", "horror", "crime", "mystery",
  "fantasy", "adventure", "family", "musical", "war", "western", "history", "sport",
  "telugu", "tamil", "malayalam", "kannada", "hindi", "bengali", "marathi", "punjabi",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // Streaming brands
  "netflix", "prime", "video", "hotstar", "disney", "jiocinema", "jiohotstar",
  "jio", "sonyliv", "sony", "liv", "zee5", "zee", "aha", "hoichoi", "sunnxt",
  "sun", "nxt", "mubi", "lionsgate", "apple", "tv", "manoramamax", "max", "chaupal",
];

export interface NameAllowlist {
  /** One token-set per real film-data person (for strict subset backing). */
  persons: Set<string>[];
  /** Flat token set of non-person words: title / platform / language / boilerplate. */
  nonPerson: Set<string>;
}

/** Diacritic-, case- and honorific-normalized significant tokens (≥2 chars). */
export function nameTokens(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !HONORIFICS.has(t));
}

/** Build the per-film allowlist: every real person's token-set + all non-person filler. */
export function buildArchivesNameAllowlist(releases: Release[]): NameAllowlist {
  const persons: Set<string>[] = [];
  const nonPerson = new Set<string>(NON_PERSON_WORDS);
  const addPerson = (s?: string) => {
    if (!s) return;
    const toks = nameTokens(s);
    if (toks.length) persons.push(new Set(toks));
  };
  const addNonPerson = (s?: string) => {
    if (s) for (const t of nameTokens(s)) nonPerson.add(t);
  };
  for (const r of releases) {
    (r.cast ?? []).forEach(addPerson);
    (r.leadCast ?? []).forEach(addPerson);
    addPerson(r.director);
    addPerson(r.musicDirector);
    addNonPerson(r.title);
    for (const p of r.platform) addNonPerson(p);
    addNonPerson(r.language);
  }
  return { persons, nonPerson };
}

/** Name-tokens with non-person filler removed. */
function personTokens(raw: string, allow: NameAllowlist): string[] {
  return nameTokens(raw).filter((t) => !allow.nonPerson.has(t));
}

/**
 * STRICT person-backing: every name-token of the candidate must appear in ONE
 * person's full-name token set ({kapoor} ⊆ {anil,kapoor} is OK; a cross-person
 * blend {shahid,kapoor} ⊄ any single person is NOT; a misspelling {govindh} ⊄
 * {govind} is NOT). Empty → vacuously backed (pure boilerplate).
 */
function isPersonBacked(toks: string[], persons: Set<string>[]): boolean {
  if (toks.length === 0) return true;
  return persons.some((p) => toks.every((t) => p.has(t)));
}

// A capitalized "name word": Unicode-uppercase start, internal apostrophes/
// hyphens and initials' periods ("S.", "A.R.", "D'Cruz", "Mr.").
const CAP_WORD = String.raw`\p{Lu}[\p{L}'’.\-]*`;
// (a) A run of 2–3 consecutive capitalized words = a name-shaped N-gram.
const NGRAM_RE = new RegExp(`(${CAP_WORD}(?:\\s+${CAP_WORD}){1,2})`, "gu");
// (b) A join-trigger + a SINGLE capitalized token NOT followed by another capital.
const TRIGGER = String.raw`(?:\b[Ww]ith|\b[Ss]tarring|\b[Aa]longside|\b[Ff]eaturing|\b[Ff]eat\.?|\b[Aa]nd|&|×|,)`;
const TRIGGER_SINGLE_RE = new RegExp(`${TRIGGER}\\s+(${CAP_WORD})(?![\\p{L}'’.\\-])(?!\\s+\\p{Lu})`, "gu");

/**
 * Sweep a single copy string and return the UNBACKED name-shaped runs it names
 * (deduped, original casing). Empty array ⇒ clean. This is the whole guard for
 * an Archives why-line: any name that isn't backed by that film's own cast/crew
 * data is a violation.
 */
export function sweepNames(text: string, allow: NameAllowlist): string[] {
  const cands = new Set<string>();
  for (const m of text.matchAll(NGRAM_RE)) cands.add(m[1]!);
  for (const m of text.matchAll(TRIGGER_SINGLE_RE)) cands.add(m[1]!);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of cands) {
    const toks = personTokens(raw, allow);
    if (toks.length === 0) continue; // fully boilerplate → not a name
    if (isPersonBacked(toks, allow.persons)) continue; // backed → OK
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}
