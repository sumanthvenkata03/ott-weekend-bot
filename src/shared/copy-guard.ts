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

/**
 * What the copy guard DID to a film, in a shape the manifest can render.
 *
 * ── WD-ENG-01 PART 1: THE GUARD LOST ITS AUTHORITY TO DELETE VERIFIED FILMS ──
 * Two outcomes, and which one applies is decided by ONE fact — was the film in
 * the pool the gate approved and fed to the LLM?
 *
 *   copy-fallback  the film WAS fed. It is gate-approved, reconciled, verified
 *                  and rendered; a phrase in its blurb is not grounds to delete
 *                  it. The blurb is replaced with deterministic, name-free copy
 *                  and THE FILM SHIPS. Non-blocking warn.
 *   copy-drop      the film was NOT fed — the model invented a title that no
 *                  Release record backs. This is the true-hallucination defence
 *                  and it is preserved exactly. Blocking when the post-drop
 *                  scrub cannot be proven consistent (Part 3).
 *
 * Lives here rather than in post-validator so the content module can emit these
 * without importing the validator, and the validator can consume them without
 * importing the content module.
 */
export interface CopyNotice {
  kind: "copy-fallback" | "copy-drop";
  /** The film the guard acted on. */
  title: string;
  /** The exact offending slice, sourced from the ORIGINAL copy (see below). */
  term: string;
  /**
   * copy-drop only. True when the caption/index/count scrub could NOT be proven
   * to have removed every trace of `title` — the edition must be blocked rather
   * than delivered self-contradicting.
   */
  scrubFailed?: boolean;
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

// A POSSESSIVE token followed by another capitalised word. Group 1 = the
// possessive word (kept intact), group 2 = the single space that gets broken.
// CAP_WORD allows internal apostrophes, so "Santoshi's" is ONE capitalised word
// and the 2–3 word window would otherwise swallow whatever it owns.
//
// The trailing (?=\p{Lu}) is what keeps this surgical: when the possessive owns a
// LOWERCASE noun ("Govindh Vasantha's music"), the run already ended there and
// this rewrite must not fire — that path stays byte-identical to before.
const POSSESSIVE_RE = new RegExp(
  String.raw`(\p{Lu}[\p{L}'’.\-]*['’][sS])([^\S\r\n])(?=\p{Lu})`,
  "gu"
);

// A capitalised token carrying an INTERNAL HYPHEN followed by a LOWERCASE letter:
// "Lights-off", "Coming-of-age", "Must-watch", "Slow-burn". Group 0 is the WHOLE
// token (the leading \p{Lu} plus every hyphen/letter/apostrophe that follows), so
// severHyphenLowercase can blank all of it and leave nothing for the 2–3 word
// window to grab.
//
// The `-\p{Ll}` is the entire discriminator, and it is what keeps a real
// hyphenated surname intact: "Abdul-Jabbar", "Smith-Jones" and "Ram-Charan" put a
// CAPITAL after the hyphen, never match, and remain full name tokens.
//
// The leading (?<![\p{L}'’.\-]) pins the match to the START of a token so a
// mid-word position can never anchor it, and the trailing [\p{L}'’.\-]* consumes
// the rest of the token (including further hyphenated segments) so
// "Coming-of-age" is blanked whole rather than leaving a dangling "age".
const HYPHEN_LOWER_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}'’.\-])\p{Lu}[\p{L}'’.]*-\p{Ll}[\p{L}'’.\-]*`,
  "gu"
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
 * Terminate a name-shaped run at a POSSESSIVE. A person's name ends where their
 * possessive does: what follows is the thing they own, not more of their name.
 * LENGTH-PRESERVING: the single space after the possessive becomes "\n", which
 * GAP cannot cross, so the window stops at the pre-possessive n-gram.
 *
 * ── ISSUE 041: THE EXTRACTION WAS WRONG AGAIN, THE POLICY WAS STILL RIGHT ────
 * A live run 2-strike DROPPED "Batwara 1947" — a green, gate-approved film — on
 * one flag: "Rajkumar Santoshi's Partition". The director IS in the film data and
 * IS in the allowlist, but CAP_WORD treats "Santoshi's" as an ordinary word, so
 * the greedy 3-word window fused the man with the noun he owned, and
 * {rajkumar, santoshi, partition} backs nobody. Same shape as Issue 032: the
 * two-strike drop behaved correctly on a malformed candidate. The fix is in the
 * EXTRACTION — the strike count, the drop behaviour and the allowlist source are
 * all untouched.
 *
 * Note this only ever SHORTENS a candidate, and a shorter run is a STRICTER test
 * (fewer tokens must each be backed by one person). It cannot hide a
 * hallucination: "Fakename Person's Movie" still yields "Fakename Person's",
 * whose tokens back nobody, and still flags.
 */
export function terminatePossessives(text: string): string {
  return text.replace(POSSESSIVE_RE, (_m, word: string) => `${word}\n`);
}

/**
 * Blank a capitalised token whose internal hyphen is followed by a LOWERCASE
 * letter. Such a token is a compound MODIFIER, never a person: "Lights-off",
 * "Coming-of-age", "Must-watch", "Slow-burn". LENGTH-PRESERVING: every character
 * of the token becomes "\n", which GAP cannot cross — so the token cannot START a
 * name-shaped run, cannot JOIN one, and cannot EXTEND one. It is invisible to
 * both extractors rather than merely filtered afterwards.
 *
 * ── WD-ENG-01 PART 2: THE EXTRACTION WAS WRONG A THIRD TIME ──────────────────
 * Issue 042's final run 2-strike DROPPED "Aroopi" — a green, gate-approved,
 * platform-resolved film — on ONE flag: "Lights-off Malayalam". CAP_WORD accepts
 * an internal hyphen, so "Lights-off" read as one capitalised word, the 2-word
 * window fused it with the language, {lights, off} backed nobody, and the film
 * left the deck. Same shape as Issues 032 and 041: the guard behaved correctly on
 * a candidate that was never a name. The fix is in the EXTRACTION.
 *
 * WHY NOT the non-person vocabulary: adding "lights"/"off"/"watch"/"burn" would
 * make those tokens filler ANYWHERE in a run, so "Fakename Lights" would stop
 * counting too — a global loosening, and an endless one (the model can coin a new
 * compound modifier every week). Keying on the token's SHAPE ends the class.
 *
 * WHY the capital after the hyphen is load-bearing: a real hyphenated surname
 * capitalises its second segment — "Abdul-Jabbar", "Smith-Jones" — so it never
 * matches here and stays a full name token, subject to the same strict backing as
 * any other. Only the lowercase-continued form is discarded.
 *
 * RESIDUAL, accepted: a person written with a lowercase second segment
 * ("Jean-luc") is now invisible, and a lone capital beside it ("Picard") is below
 * both extractors' thresholds, so that spelling escapes the sweep. Weighed
 * against a compound modifier costing a verified film its slot every issue, and
 * bounded by Part 1 — a fed film can no longer be dropped by this guard at all.
 */
export function severHyphenLowercase(text: string): string {
  return text.replace(HYPHEN_LOWER_RE, (tok) => "\n".repeat(tok.length));
}

/**
 * The scan copy the extractor regexes run against. All four rewrites preserve
 * length and only ever REPLACE a character with "\n", so every offset in the
 * result maps 1:1 onto the original string. nameCandidates relies on that to
 * slice labels out of the original.
 */
export function scanText(text: string): string {
  return terminatePossessives(neutralizeRoleTitles(segmentSentences(severHyphenLowercase(text))));
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

// ── WD-ENG-01 PART 3 — THE GHOST SCRUB ──────────────────────────────────────
//
// A drop that removes a CARD but leaves the film's name in the caption and the
// index slide does not remove the film — it publishes a deck that contradicts
// itself. Two live editions proved it:
//
//   Issue 041  "Batwara 1947" was struck off the theatrical deck; the caption
//              still sold it and the index still listed it. THE BATWARA GHOST.
//   Issue 042  "Aroopi" was struck off the OTT deck; the caption still said
//              "Seven drops", still named Aroopi, and the index still carried
//              "Aroopi (Malayalam) → Prime Video" against six rendered cards.
//
// The scrub is DETERMINISTIC — no second LLM call, no cost, no new failure mode.
// It removes the title-bearing segments, re-derives the count words, and then
// VERIFIES its own work. Verification is the point: a scrub that cannot prove it
// left no trace reports failure, and Part 4c blocks the edition instead of
// delivering it. The guarantee is deliberately scoped to what a deterministic
// pass can actually prove — TITLE references and COUNT lines — and an oblique
// allusion ("the week's only Malayalam horror") is out of its reach by
// construction. That limit is stated, not papered over.

/**
 * Number words the copy uses for counts, indexed so N ⇒ NUMBER_WORDS[N].
 *
 * Deliberately runs PAST MAX_WED_DROP_FILMS (15). The table is used for two
 * different jobs: picking the word to write (never above 15) and RECOGNISING a
 * word already in the caption (which a miscounting model can write at any
 * value). A table that stopped at fifteen would simply not see "Sixteen drops",
 * so a stale overcount would survive the scrub unreported.
 */
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
] as const;

/** Nouns a Wed Drop count word can quantify ("Seven drops", "six films"). */
const COUNTED_NOUNS = "drops?|films?|releases?|titles?|picks?|arrivals?|movies?";

const COUNT_RE = new RegExp(
  String.raw`\b(${NUMBER_WORDS.join("|")})(\s+(?:fresh\s+|new\s+|great\s+)?(?:${COUNTED_NOUNS}))\b`,
  "gi"
);

/** Preserve the original casing of a replaced count word ("Seven" → "Six"). */
function matchCase(sample: string, word: string): string {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return word.toUpperCase();
  if (sample[0] === sample[0]?.toUpperCase()) return word[0]!.toUpperCase() + word.slice(1);
  return word;
}

/**
 * Rewrite every count word that quantifies a Wed Drop noun to `n`. Counts above
 * the NUMBER_WORDS table are left alone (and the verifier below then refuses to
 * certify the scrub, which is the correct outcome — better blocked than wrong).
 */
export function retargetCounts(text: string, n: number): string {
  const want = NUMBER_WORDS[n];
  if (!want) return text;
  return text.replace(COUNT_RE, (_m, num: string, tail: string) => `${matchCase(num, want)}${tail}`);
}

/** Case-insensitive whole-phrase test for a film title inside free text. */
export function mentionsTitle(text: string, title: string): boolean {
  const t = title.trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b is wrong at a non-word boundary (a title may start or end with punctuation
  // or a digit), so the edges are asserted as "not a word character" instead.
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${esc}(?![\p{L}\p{N}])`, "iu").test(text);
}

/**
 * Drop every SENTENCE that names one of `titles`. Sentence boundaries reuse the
 * extractor's own segmenter, so "A.R. Rahman" and "Dr. Rajkumar" cannot be split
 * mid-name here either — one segmentation rule, not two.
 */
export function scrubSentences(text: string, titles: readonly string[]): string {
  if (titles.length === 0) return text;
  // segmentSentences marks each boundary with "\n"; split there, not on periods.
  const kept = segmentSentences(text)
    .split("\n")
    .filter((s) => s.trim().length > 0 && !titles.some((t) => mentionsTitle(s, t)));
  return kept.join(" ").replace(/[^\S\r\n]{2,}/g, " ").trim();
}

/**
 * Drop every SEGMENT of an index slide that names one of `titles`. The index body
 * is a delimited list — newline-separated in the OTT edition, "•"-separated in the
 * theatrical one — so the separator is detected rather than assumed, and the
 * surviving segments are rejoined with the one the model actually used.
 */
export function scrubIndexBody(body: string, titles: readonly string[]): string {
  if (titles.length === 0) return body;
  const sep = body.includes("\n") ? "\n" : body.includes("•") ? "•" : null;
  if (sep === null) return scrubSentences(body, titles);
  const parts = body.split(sep);
  const kept = parts.filter((p) => p.trim().length > 0 && !titles.some((t) => mentionsTitle(p, t)));
  // Rejoin exactly as found: "\n" was already the delimiter; "•" carried spaces.
  return sep === "\n" ? kept.map((p) => p.trim()).join("\n") : kept.map((p) => p.trim()).join(" • ");
}

export interface ScrubResult {
  caption: string;
  indexBody: string;
  /** True when NO trace of any dropped title, and no stale count, survives. */
  clean: boolean;
  /** Why it could not be certified. Empty when `clean`. */
  problems: string[];
}

/**
 * Remove every reference to `dropped` from the caption and the index slide, then
 * retarget the count words to `keptCount` — and VERIFY the result. `clean:false`
 * is not a failure of nerve; it is the signal that the edition must be blocked.
 */
export function scrubDroppedFilms(
  caption: string,
  indexBody: string,
  dropped: readonly string[],
  keptCount: number
): ScrubResult {
  const problems: string[] = [];
  const newCaption = retargetCounts(scrubSentences(caption, dropped), keptCount);
  const newIndex = scrubIndexBody(indexBody, dropped);

  for (const t of dropped) {
    if (mentionsTitle(newCaption, t)) problems.push(`caption still names "${t}"`);
    if (mentionsTitle(newIndex, t)) problems.push(`index slide still lists "${t}"`);
  }
  // A caption scrubbed to nothing cannot carry the edition — the whole caption
  // was about the dropped film.
  if (newCaption.trim().length === 0) problems.push("caption scrubbed empty");
  if (newIndex.trim().length === 0) problems.push("index slide scrubbed empty");
  // Every surviving count word must now read the rendered card count.
  const want = NUMBER_WORDS[keptCount];
  for (const m of newCaption.matchAll(COUNT_RE)) {
    const phrase = m[0];
    if (!want) { problems.push(`count "${phrase}" exceeds the number-word table`); continue; }
    if ((m[1] ?? "").toLowerCase() !== want) problems.push(`caption count "${phrase}" ≠ ${keptCount}`);
  }

  return { caption: newCaption, indexBody: newIndex, clean: problems.length === 0, problems };
}
