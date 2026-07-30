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
//
// ── ISSUE 032: THE EXTRACTION WAS WRONG, THE POLICY WAS RIGHT ────────────────
// A live run 2-strike DROPPED "Chinna Chinna Aasai" on four flags, none of which
// was a real violation:
//     "Side Heroes. Five"     — a candidate fused ACROSS a sentence-ending period
//     "Netflix. Not"          — same period-boundary fusion
//     "Director Chidambaram"  — a role-title prefix on a name that IS in card data
// The two-strike drop behaved correctly on garbage input. The fix is therefore in
// the EXTRACTION, not in the strike count, the drop behaviour, or the allowlist
// source — all three are untouched.
//
// The repair is two length-preserving text rewrites applied to a SCAN COPY only
// (segmentSentences, then neutralizeRoleTitles), so the extractor's regexes see
// clean spans. Everything reported still comes from the ORIGINAL string — see
// "LABELS COME FROM THE ORIGINAL" below, which is a hard rule, not an optimisation.
//
// ⚠ THE REJECTED FIX, so nobody re-invents it: stripping role words from the
// CANDIDATE's token list (rather than from the scan text) LOOKS equivalent and is
// not — it opens a hole. NGRAM_RE captures at most 3 capitalised words and is
// greedy, so "Music Director Aparna Vasantha" yields the candidate
// "Music Director Aparna" and `Vasantha` is never examined at all. With the role
// words still in the tuple, {music,director,aparna} backs nobody and the run is
// flagged; strip them at candidate level and {aparna} backs a real person, so the
// cross-person blend "Aparna Vasantha" sails through. The role words were
// ACCIDENTALLY LOAD-BEARING. Neutralising them in the TEXT instead moves the
// 3-word window onto the real name, which is why this version flags it.
// The founding fixture for that hole is pinned in __tests__/copy-guard.test.ts.

/** Honorifics carry no identity — strip so "Mr. Bachchan" ~ "Bachchan". */
const HONORIFICS = new Set(["mr", "mrs", "ms", "dr", "sri", "smt", "shri"]);

/**
 * Role/title words that PREFIX a name in editorial copy ("Director Chidambaram",
 * "Music Director Anirudh"). Neutralised out of the scan text so the extractor's
 * window lands on the name itself.
 *
 * This is deliberately NOT done by adding these words to a call site's
 * `nonPersonWords`: that would make them filler ANYWHERE in a run, so
 * "Fakename Director" would stop counting too — a global loosening. Here, only a
 * role word acting as a PREFIX (followed by a capitalised word) is neutralised; a
 * trailing one is left in place and still counts as part of the unbacked run.
 *
 * 🔴 HONORIFICS ARE DELIBERATELY ABSENT FROM THIS LIST. Do not "improve" this by
 * adding Dr/Mr/Mrs/Ms/Sri/Smt/Shri. Neutralising "Dr." in "Dr. Fakename" would
 * orphan "Fakename" into a lone capital that NEITHER extractor captures (NGRAM_RE
 * needs 2+ capitalised words; TRIGGER_SINGLE_RE needs a join trigger), and a real
 * hallucination would silently vanish. The cost of leaving them out is a residual
 * false positive on a legitimate "Dr. Chidambaram", which costs exactly one retry.
 * Under-flagging costs an accuracy failure on a published card. Same reasoning
 * governs the honorific exception inside segmentSentences.
 */
const ROLE_PREFIXES = [
  "director", "producer", "music", "composer", "actor", "actress",
  "star", "writer", "cinematographer", "editor",
] as const;

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
// Intra-line whitespace ONLY. A plain \s+ crosses newlines, so the last word of
// one paragraph and the first word of the next fused into a phantom name: a live
// dry run held a valid caption over "Variety.\nOh..", which is two paragraphs,
// not a person. Names do not span line breaks.
//
// This is also what makes the two rewrites below work: both emit "\n", and GAP
// refuses to cross it, so neither the regexes nor the 2–3 word window can reach
// across a sentence end or a neutralised role title.
const GAP = String.raw`[^\S\r\n]+`;
// The `d` flag (hasIndices) is REQUIRED: nameCandidates uses the capture group's
// offsets to slice the label out of the ORIGINAL text. See that function.
/** (a) A run of 2–3 consecutive capitalized words = a name-shaped N-gram. */
export const NGRAM_RE = new RegExp(`(${CAP_WORD}(?:${GAP}${CAP_WORD}){1,2})`, "gud");
// (b) A join-trigger + a SINGLE capitalized token NOT followed by another capital
//     (multi-word runs after a trigger are already the N-gram rule's job). Triggers
//     are matched WITHOUT the /i flag, which would defeat \p{Lu}.
const TRIGGER = String.raw`(?:\b[Ww]ith|\b[Ss]tarring|\b[Aa]longside|\b[Ff]eaturing|\b[Ff]eat\.?|\b[Aa]nd|&|×|,)`;
// The first lookahead pins the capture to a WHOLE word (so greedy \p{L}* can't
// backtrack to a partial like "Ani" from "Anil"); the second keeps a multi-word
// name (whose 2nd word is capitalized) as the N-gram rule's job, not a lone single.
export const TRIGGER_SINGLE_RE = new RegExp(
  `${TRIGGER}${GAP}(${CAP_WORD})(?![\\p{L}'’.\\-])(?!${GAP}\\p{Lu})`,
  "gud"
);

// A word, then sentence-ending punctuation, then an optional closer, then ONE
// horizontal space. Groups: 1 = word, 2 = punctuation + closer, 3 = the space.
const SENTENCE_END_RE = new RegExp(
  String.raw`([\p{L}\p{N}][\p{L}\p{N}'’.\-]*)([.!?]+["'”’»)\]]?)([^\S\r\n])`,
  "gu"
);

// A role word acting as a PREFIX: immediately followed by whitespace and a
// capitalised word. A trailing role word is NOT matched, on purpose.
const ROLE_PREFIX_RE = new RegExp(
  String.raw`\b(?:${ROLE_PREFIXES.join("|")})(?=[^\S\r\n]+\p{Lu})`,
  "giu"
);

/**
 * Turn every SENTENCE boundary into a newline, so the extractors cannot build a
 * candidate that straddles one. LENGTH-PRESERVING: exactly one horizontal space
 * becomes "\n".
 *
 * THE HARD PART is telling a sentence period from an INITIAL's period, because
 * both look like <period><space><capital>:
 *     "S. Shankar"    → one name    → must NOT break
 *     "A.R. Rahman"   → one name    → must NOT break
 *     "Dr. Rajkumar"  → one name    → must NOT break
 *     "Heroes. Five"  → two names   → MUST break
 * The discriminator is the token immediately before the period: an initial is a
 * single letter, and an honorific is a known word. Both exceptions FAIL CLOSED —
 * declining to break leaves the old, stricter fusion behaviour in place for that
 * span, so a wrong call here can only over-flag, never under-flag. That is why
 * "Dr. Fakename" must stay fused: broken apart, "Fakename" would be a lone
 * capital that neither extractor captures, and a real violation would escape.
 */
export function segmentSentences(text: string): string {
  return text.replace(SENTENCE_END_RE, (match, word: string, punct: string) => {
    // The word's trailing alphanumeric run: "A.R" → "R", "Heroes" → "Heroes".
    const lastRun = /[\p{L}\p{N}]+$/u.exec(word)?.[0] ?? "";
    if (lastRun.length < 2) return match;                       // initial — keep fused
    if (HONORIFICS.has(lastRun.toLowerCase())) return match;    // honorific — keep fused
    return `${word}${punct}\n`;
  });
}

/**
 * Blank out role titles that PREFIX a capitalised word, so the extractor's 2–3
 * word window lands on the name rather than being eaten by the title.
 * LENGTH-PRESERVING: each removed character becomes "\n", which GAP cannot cross.
 */
export function neutralizeRoleTitles(text: string): string {
  return text.replace(ROLE_PREFIX_RE, (word) => "\n".repeat(word.length));
}

/**
 * The scan copy the extractor regexes run against. Both rewrites preserve length
 * and only ever REPLACE a character with "\n", so every offset in the result maps
 * 1:1 onto the original string. nameCandidates relies on that to slice labels out
 * of the original.
 */
export function scanText(text: string): string {
  return neutralizeRoleTitles(segmentSentences(text));
}

/**
 * Every name-shaped candidate in a string (N-grams + join-trigger singles).
 *
 * ── LABELS COME FROM THE ORIGINAL, NEVER THE SCAN COPY ──────────────────────
 * Matching happens on scanText(text); the returned strings are sliced out of
 * `text` using each capture group's offsets (hence the `d` flag on both regexes).
 * The scan copy is an internal artefact: it contains injected newlines and
 * blanked-out role words, and it must never reach a violation label, a log line,
 * a Slack ping, a Notion draft, or a card. Slicing from the original is what
 * guarantees that structurally rather than by convention.
 *
 * The length invariant is checked, not assumed: if a future rewrite ever breaks
 * it, we fall back to scanning the raw text — stricter (the old fusion behaviour)
 * rather than silently mis-sliced.
 */
export function nameCandidates(text: string): Set<string> {
  const scan = scanText(text);
  const aligned = scan.length === text.length;
  const haystack = aligned ? scan : text;
  const cands = new Set<string>();
  for (const re of [NGRAM_RE, TRIGGER_SINGLE_RE]) {
    for (const m of haystack.matchAll(re)) {
      const span = m.indices?.[1];
      // Slice from `text`, not from `haystack` — see the note above.
      cands.add(span ? text.slice(span[0], span[1]) : m[1]!);
    }
  }
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
