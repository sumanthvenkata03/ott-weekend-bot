// src/reconcile/manual-adds.ts
// THE MANUAL-ADD DIAL — a narrow, evidence-carrying operator path INTO the gate.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
// Real films exist with no TMDb record. Panchali Panchabhartruka (WD-ENG-07: 33
// live queries across 11 spellings, no record), Nijame Rujuvainadhi and
// Chargesheet 03-08 (WD-ENG-08, WD-ENG-17C) all released and were all
// unreportable. WD-ENG-15 surveyed the whole source space and found nothing that
// closes it: four of the five misses have no structured record anywhere.
//
// THE TMDb-BACKED POOL RULE STANDS. This does not relax it. It adds a path that
// goes THROUGH the gate — hash, review, AI-review, enforcement, copy guard — and
// never around it. An operator cannot publish with this; they can only propose,
// with evidence, and then approve at the same gate as every other film.
//
// ── WHY A CHECKED-IN FILE AND NOT AN ENV VAR ────────────────────────────────
// The sticky-env failure. An env var set for one run silently persists into the
// next; a file keyed by the EDITION WINDOW cannot, because next week's run looks
// for a different filename and finds nothing.
//
// ── WHY THE WINDOW START AND NOT THE ISSUE NUMBER (WD-ENG-11C) ──────────────
// WD-ENG-11B specified an issue-keyed file. That is unimplementable here: manual
// entries must be injected BEFORE decideGate so the gate hash covers them, but
// the WD-ENG-02 issue number is read from an anchor keyed BY that hash, which
// does not exist yet. The only mechanism that yields a number earlier is the
// wall-clock helper, and two standing WD-ENG-02 pins forbid it inside
// wednesday-drop.ts. Those pins are correct and stay untouched.
//
// The THEATRICAL WINDOW START is strictly better for this job anyway. It is
// computed by snapping editorialDateUTC() back to the ISO week's Monday and
// adding two, so every run inside one IST week — including a Wednesday-night
// gate and its Thursday-morning --approve — derives the SAME Wednesday and reads
// the SAME file. No wall-clock issue numbering, no anchor dependency, no drift
// across the midnight that WD-ENG-02 was about.
//
// ONE FILE PER EDITION, named for the Wednesday, e.g. data/manual-adds/
// 2026-08-12.json. Both pillars read it; each entry is routed to the theatrical
// or OTT edition by its own dateField, and the 2-entry cap is per FILE, which is
// per edition.
//
// ── WORKED EXAMPLE — copy this ─────────────────────────────────────────────
//   data/manual-adds/2026-08-12.json
//   {
//     "entries": [
//       {
//         "title": "Panchali Panchabhartruka",
//         "language": "Telugu",
//         "date": "2026-08-14",
//         "dateField": "theatrical",
//         "audioLanguages": { "original": "Telugu" },
//         "sourceUrls": ["https://en.wikipedia.org/wiki/List_of_Telugu_films_of_2026"],
//         "evidenceBasis": "wiki-list",
//         "cast": ["Vishwadev Rachakonda", "Komalee Prasad"],
//         "synopsis": "Four friends tangled in a deadly underworld mess."
//       }
//     ]
//   }
//
// For an OTT entry set "dateField": "ott" and add "platform": "ETV Win". If you
// supply "posterPath" you MUST also supply "posterSourceUrl".
//
// ── WHAT THIS MODULE REFUSES TO DO ──────────────────────────────────────────
// It never invents a field. Every value on the Release it builds came from the
// evidence file or is left absent. It never marks a film TMDb-confirmed, never
// promotes to green, and never lets an unverifiable claim masquerade as a
// verified one: wiki-list is machine-checked, and the other two bases are
// labelled as operator assertions in the review, the manifest and the logs.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { log } from "../shared/logger.js";
import { normalizeTitle } from "../discovery/normalize.js";
import { toPlatform } from "../shared/platform.js";
import type { Language, Platform, Release } from "../shared/types.js";
import type { ReconciledFilm } from "./types.js";

/** Where an edition's evidence file lives. Window-start-keyed — see the header. */
export const MANUAL_ADDS_DIR = "data/manual-adds";

/** Hard cap per edition. Exceeding it FAILS the run; it never truncates. */
export const MANUAL_ADD_CAP = 2;

/**
 * The three evidence bases.
 *  - wiki-list        MACHINE-VERIFIED against the WD-ENG-07 wikiLanguageIndex.
 *                     Requires no trust: either the title is in the list the
 *                     discovery run already fetched, or the entry is rejected.
 *  - platform-official / trade-press
 *                     OPERATOR ASSERTIONS. Nothing machine-checks these, so they
 *                     are labelled unverified everywhere they surface. Trade
 *                     press especially: in one week Filmibeat produced two wrong
 *                     dates (Shabara, Goodachari 2), and WD-ENG-16 found TMDb
 *                     itself carrying the wrong Shabara date.
 */
export const EVIDENCE_BASES = ["wiki-list", "platform-official", "trade-press"] as const;
export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

/** True when the basis is an operator assertion rather than a machine check. */
export function isOperatorAssertion(basis: EvidenceBasis): boolean {
  return basis !== "wiki-list";
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HTTP = /^https?:\/\/\S+$/i;

const EntrySchema = z
  .object({
    title: z.string().min(1),
    language: z.string().min(1),
    date: z.string().regex(ISO, "date must be YYYY-MM-DD"),
    dateField: z.enum(["ott", "theatrical"]),
    audioLanguages: z.object({
      original: z.string().min(1),
      dubbed: z.array(z.string()).optional(),
    }),
    platform: z.string().optional(),
    sourceUrls: z.array(z.string().regex(HTTP, "sourceUrl must be an http(s) URL")).min(1),
    evidenceBasis: z.enum(EVIDENCE_BASES),
    // Optional enrichment. posterPath is special-cased below.
    posterPath: z.string().optional(),
    posterSourceUrl: z.string().regex(HTTP).optional(),
    cast: z.array(z.string()).optional(),
    director: z.string().optional(),
    synopsis: z.string().optional(),
    runtime: z.number().int().positive().optional(),
  })
  .strict();

export type ManualEntry = z.infer<typeof EntrySchema>;

const FileSchema = z.object({ entries: z.array(EntrySchema) }).strict();

export interface ManualAddRejection {
  title: string;
  reason: string;
}

export interface ManualAddResult {
  /** Entries that passed every check, as reconciled films ready to inject. */
  films: ReconciledFilm[];
  /** Entries refused, with the precise reason — surfaced in the review. */
  rejected: ManualAddRejection[];
}

/**
 * Conventional path for an edition's evidence file.
 *
 * `windowStart` is the THEATRICAL window start — utcStamp(wednesday), yyyy-MM-dd,
 * the same stamp convention the job uses for `startDate` and its run artifacts.
 */
export function manualAddsPath(windowStart: string, dir: string = MANUAL_ADDS_DIR): string {
  return `${dir}/${windowStart}.json`;
}

/**
 * Read + parse the evidence file for THIS issue. A missing file is the normal
 * case and returns []; it is not an error and not a warning.
 *
 * A malformed file IS an error and throws — an operator who wrote an evidence
 * file and typo'd it must not have it silently ignored, because the silent-skip
 * is indistinguishable from "the dial did nothing" and that is how a film gets
 * quietly dropped a second time.
 */
export function readManualAdds(windowStart: string, dir: string = MANUAL_ADDS_DIR): ManualEntry[] {
  const path = manualAddsPath(windowStart, dir);
  if (!existsSync(path)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `manual-adds: ${path} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    // Name the field. "invalid file" sends an operator hunting; "entries.0.date
    // must be YYYY-MM-DD" is actionable.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`manual-adds: ${path} failed validation — ${issues}`);
  }

  if (parsed.data.entries.length > MANUAL_ADD_CAP) {
    // LOUD, never a silent truncation. Truncating would publish some of an
    // operator's intent and drop the rest without saying which.
    throw new Error(
      `manual-adds: ${path} declares ${parsed.data.entries.length} entries; the hard cap is ` +
        `${MANUAL_ADD_CAP} per edition. Remove entries or split across issues — nothing was truncated.`
    );
  }

  return parsed.data.entries;
}

/**
 * Per-entry checks the schema cannot express.
 *
 * posterPath ⇒ posterSourceUrl is the operator amendment to WD-ENG-09: a poster
 * with no provenance is exactly the kind of unattributed asset the copy/receipt
 * discipline exists to prevent, and it would render on the card.
 */
export function validateEntry(
  entry: ManualEntry,
  wikiLanguageIndex: ReadonlyMap<string, string> | undefined
): string | null {
  if (entry.posterPath !== undefined && entry.posterSourceUrl === undefined) {
    return `posterPath supplied without posterSourceUrl — a poster must carry its own source`;
  }
  if (entry.dateField === "ott" && !entry.platform) {
    return `dateField "ott" requires a platform`;
  }

  if (entry.evidenceBasis === "wiki-list") {
    // THE MACHINE CHECK. The index is built from the Wikipedia list pages the
    // discovery run already fetched, so this costs nothing and cannot be
    // asserted around.
    if (!wikiLanguageIndex || wikiLanguageIndex.size === 0) {
      return `evidenceBasis "wiki-list" claimed but no Wikipedia list index is available this run — cannot verify`;
    }
    const key = normalizeTitle(entry.title);
    if (!wikiLanguageIndex.has(key)) {
      return (
        `evidenceBasis "wiki-list" claimed but "${entry.title}" is NOT in the ` +
        `Wikipedia list index for this run — the claim is unverifiable, so the entry is refused`
      );
    }
  }
  return null;
}

/** Human label for the review / manifest / logs. Never omitted for assertions. */
export function evidenceLabel(entry: ManualEntry, verified: boolean): string {
  if (entry.evidenceBasis === "wiki-list") {
    return verified
      ? `wiki-list (MACHINE-VERIFIED against the Wikipedia list index)`
      : `wiki-list (VERIFICATION FAILED)`;
  }
  return `${entry.evidenceBasis} (UNVERIFIED OPERATOR ASSERTION — not machine-checked)`;
}

/**
 * Build the Release directly from the evidence — the WD-ENG-11B entry point.
 *
 * This is the buildFromNewAi shape with the operator's file standing in for the
 * TMDb hit. Every field is either supplied or absent; nothing is invented. The
 * id is namespaced `manual-` so it can never collide with a `tmdb-` id, and so a
 * manual film is identifiable in any downstream record without a flag.
 */
export function buildManualRelease(entry: ManualEntry): Release {
  const platform = toPlatform(entry.platform);
  return {
    id: `manual-${normalizeTitle(entry.title)}`,
    title: entry.title,
    language: entry.language as Language,
    isSeries: false,
    platform: platform ? ([platform] as Platform[]) : [],
    releaseDate: entry.date,
    // Lands on the field this pillar's landing check and card actually read, so
    // contract:band-released passes and the ★ RELEASED band renders.
    releaseDates: { [entry.dateField]: entry.date },
    // contract:band-available-in FAILs without this — it is why the evidence
    // file makes it mandatory.
    audioLanguages: {
      original: entry.audioLanguages.original,
      ...(entry.audioLanguages.dubbed ? { dubbed: entry.audioLanguages.dubbed } : {}),
    },
    genre: [],
    cast: entry.cast ?? [],
    ...(entry.cast && entry.cast.length > 0 ? { leadCast: entry.cast } : {}),
    ...(entry.director ? { director: entry.director } : {}),
    synopsis: entry.synopsis ?? "",
    ...(entry.posterPath ? { posterUrl: entry.posterPath } : {}),
    ...(entry.runtime !== undefined ? { runtime: entry.runtime } : {}),
    subtitleLanguages: [],
    sources: ["manual"],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Build the reconciled film. status stays "unverified" because that is the
 * truth — there is no TMDb match — and the NARROW tier bypass in assignTier is
 * what makes it yellow rather than red. See the comment there.
 */
export function buildManualFilm(entry: ManualEntry, pillar: string, verified: boolean): ReconciledFilm {
  return {
    title: entry.title,
    language: entry.language,
    pillar,
    ...(entry.platform ? { platform: entry.platform } : {}),
    date: entry.date,
    dateSource: "press",
    ...(entry.sourceUrls[0] ? { sourceUrl: entry.sourceUrls[0] } : {}),
    foundIn: ["manual"],
    status: "unverified",
    landingStatus: "pass",
    tier: "yellow",
    reasons: ["single-net"],
    release: buildManualRelease(entry),
    manualAdd: {
      evidenceBasis: entry.evidenceBasis,
      verified,
      assertion: isOperatorAssertion(entry.evidenceBasis),
      sourceUrls: [...entry.sourceUrls],
      ...(entry.posterSourceUrl ? { posterSourceUrl: entry.posterSourceUrl } : {}),
      label: evidenceLabel(entry, verified),
    },
  } as ReconciledFilm;
}

/**
 * THE SEAM. Load, validate, and convert this issue's manual adds for ONE pillar.
 *
 * Entries are matched to a pillar by their dateField, so an OTT entry cannot
 * appear in the theatrical edition or vice versa.
 */
export function loadManualAdds(opts: {
  /** THEATRICAL window start, yyyy-MM-dd — the edition key. See the header. */
  windowStart: string;
  pillar: string;
  wikiLanguageIndex?: ReadonlyMap<string, string>;
  dir?: string;
}): ManualAddResult {
  const entries = readManualAdds(opts.windowStart, opts.dir ?? MANUAL_ADDS_DIR);
  const mine = entries.filter((e) => e.dateField === (opts.pillar === "ott" ? "ott" : "theatrical"));
  const films: ReconciledFilm[] = [];
  const rejected: ManualAddRejection[] = [];

  for (const entry of mine) {
    const problem = validateEntry(entry, opts.wikiLanguageIndex);
    if (problem) {
      rejected.push({ title: entry.title, reason: problem });
      log.warn(`  ⛔ manual-add REFUSED "${entry.title}" — ${problem}`);
      continue;
    }
    const verified = entry.evidenceBasis === "wiki-list";
    films.push(buildManualFilm(entry, opts.pillar, verified));
    const label = evidenceLabel(entry, verified);
    (isOperatorAssertion(entry.evidenceBasis) ? log.warn : log.info)(
      `  ✚ manual-add [${opts.pillar}] "${entry.title}" — ${label}; sources: ${entry.sourceUrls.join(", ")}`
    );
  }

  return { films, rejected };
}

/**
 * THE JOB SEAM — load and INJECT for every pillar in one call.
 *
 * Exported as one function so the job's wiring and the WD-ENG-11C replay
 * exercise the same code path rather than two similar ones. Mutates each
 * result in place and returns what happened, so the caller logs the movement
 * instead of silently growing the deck.
 *
 * MUST be called BEFORE decideGate: computeDropHash fingerprints every
 * reconciled film, so injecting here is what puts manual entries inside the
 * hash the operator approves.
 *
 * PER-PILLAR BY CONSTRUCTION — loadManualAdds filters on the entry's own
 * dateField, so a theatrical entry cannot reach the OTT edition or vice versa.
 */
export function injectManualAdds(
  results: Array<{ pillar: string; reconciled: ReconciledFilm[]; rejected: Array<{ title?: string; reason: string }> }>,
  opts: { windowStart: string; wikiLanguageIndex?: ReadonlyMap<string, string>; dir?: string }
): { injected: number; refused: number } {
  let injected = 0;
  let refused = 0;

  for (const r of results) {
    const { films, rejected } = loadManualAdds({
      windowStart: opts.windowStart,
      pillar: r.pillar,
      ...(opts.wikiLanguageIndex ? { wikiLanguageIndex: opts.wikiLanguageIndex } : {}),
      ...(opts.dir ? { dir: opts.dir } : {}),
    });

    r.reconciled.push(...films);
    injected += films.length;
    for (const rej of rejected) {
      r.rejected.push({ title: rej.title, reason: `manual-add refused — ${rej.reason}` });
      refused++;
    }

    if (films.length > 0) {
      log.warn(
        `  ✚ ${films.length} OPERATOR-ADDED film(s) injected into [${r.pillar}] — inside the gate ` +
          `hash, and requiring approval like any other film: ${films.map((f) => f.title).join(", ")}`
      );
    }
  }
  return { injected, refused };
}
