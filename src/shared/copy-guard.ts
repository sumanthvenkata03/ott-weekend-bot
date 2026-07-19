// src/shared/copy-guard.ts
// THE Name Sweep. One implementation, four call sites.
//
// This module ends the ⚠ SCHEDULED DUPLICATE ⚠ that lived in
// content/archives/copy-guard.ts as a hand-mirrored copy of the module-private
// guard inside content/weekend/wednesday-drop.ts. Both copies are now gone; the
// logic below is the single source of truth for Wed Drop, Archives, the News
// Desk, and the future Saturday port.
//
// ── WHY THE VOCABULARY IS A PARAMETER (the extraction's one real subtlety) ───
// The two original copies were byte-identical in every function AND DIFFERENT in
// their NON_PERSON_WORDS lists. Wednesday's carried pillar furniture ("box",
// "office", "drop", "hidden", "gem", "pick"); Archives' carried its own
// ("vintage", "classic", "missed") plus all 8 languages and 16 genres.
//
// Unioning them would NOT be behaviour-preserving, and the direction of the
// error is the dangerous one: every word added to `nonPerson` makes one more
// token count as filler, which means FEWER names are swept, which means a
// hallucination guard gets LOOSER. So the vocabulary is injected per call site
// and each site keeps its own list verbatim. That is what lets the 21 legacy
// fixtures pass unmodified — the proof that this extraction changed nothing.

/** Honorifics carry no identity — strip so "Mr. Bachchan" ~ "Bachchan". */
const HONORIFICS = new Set(["mr", "mrs", "ms", "dr", "sri", "smt", "shri"]);

export interface NameAllowlist {
  /** One token-set per real person (for strict subset backing). */
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

/**
 * Assemble an allowlist from already-extracted strings. Call sites differ in
 * WHERE their people and filler come from (Wed/Archives read Release fields;
 * News reads its own cluster text), so this takes plain strings and stays
 * shape-agnostic.
 */
export function buildAllowlist(input: {
  /** Full names of real people. Each becomes one strict-subset backing set. */
  personNames: readonly (string | undefined)[];
  /** Free text whose tokens are all filler (titles, platforms, languages…). */
  nonPersonText: readonly (string | undefined)[];
  /** The call site's own non-person vocabulary. NOT shared — see header. */
  nonPersonWords: readonly string[];
}): NameAllowlist {
  const persons: Set<string>[] = [];
  const nonPerson = new Set<string>(input.nonPersonWords);
  for (const s of input.personNames) {
    if (!s) continue;
    const toks = nameTokens(s);
    if (toks.length) persons.push(new Set(toks));
  }
  for (const s of input.nonPersonText) {
    if (s) for (const t of nameTokens(s)) nonPerson.add(t);
  }
  return { persons, nonPerson };
}

/** Name-tokens with non-person filler removed. */
export function personTokens(raw: string, allow: NameAllowlist): string[] {
  return nameTokens(raw).filter((t) => !allow.nonPerson.has(t));
}

/**
 * STRICT person-backing: every name-token of the candidate must appear in ONE
 * person's full-name token set ({kapoor} ⊆ {anil,kapoor} is OK; a cross-person
 * blend {shahid,kapoor} ⊄ any single person is NOT; a misspelling {govindh} ⊄
 * {govind} is NOT). Empty → vacuously backed (pure boilerplate).
 */
export function isPersonBacked(toks: string[], persons: Set<string>[]): boolean {
  if (toks.length === 0) return true;
  return persons.some((p) => toks.every((t) => p.has(t)));
}

// A capitalized "name word": Unicode-uppercase start, allowing internal
// apostrophes/hyphens and initials' periods ("S.", "A.R.", "D'Cruz", "Mr.").
const CAP_WORD = String.raw`\p{Lu}[\p{L}'’.\-]*`;
/** (a) A run of 2–3 consecutive capitalized words = a name-shaped N-gram. */
export const NGRAM_RE = new RegExp(`(${CAP_WORD}(?:\\s+${CAP_WORD}){1,2})`, "gu");
// (b) A join-trigger + a SINGLE capitalized token NOT followed by another capital
//     (multi-word runs after a trigger are already the N-gram rule's job). Triggers
//     are matched WITHOUT the /i flag, which would defeat \p{Lu}.
const TRIGGER = String.raw`(?:\b[Ww]ith|\b[Ss]tarring|\b[Aa]longside|\b[Ff]eaturing|\b[Ff]eat\.?|\b[Aa]nd|&|×|,)`;
// The first lookahead pins the capture to a WHOLE word (so greedy \p{L}* can't
// backtrack to a partial like "Ani" from "Anil"); the second keeps a multi-word
// name (whose 2nd word is capitalized) as the N-gram rule's job, not a lone single.
export const TRIGGER_SINGLE_RE = new RegExp(
  `${TRIGGER}\\s+(${CAP_WORD})(?![\\p{L}'’.\\-])(?!\\s+\\p{Lu})`,
  "gu"
);

/** Every name-shaped candidate in a string (N-grams + join-trigger singles). */
export function nameCandidates(text: string): Set<string> {
  const cands = new Set<string>();
  for (const m of text.matchAll(NGRAM_RE)) cands.add(m[1]!);
  for (const m of text.matchAll(TRIGGER_SINGLE_RE)) cands.add(m[1]!);
  return cands;
}

/**
 * Sweep one string and return the UNBACKED name-shaped runs it names (deduped,
 * original casing). Empty array ⇒ clean.
 */
export function sweepNames(text: string, allow: NameAllowlist): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of nameCandidates(text)) {
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
