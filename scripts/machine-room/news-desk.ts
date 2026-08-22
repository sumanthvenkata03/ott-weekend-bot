// scripts/machine-room/news-desk.ts
// THE OPERATOR'S PICK, TURNED INTO A FILE - by the SERVER, never by the client.
//
// THE THREAT THIS MODULE EXISTS TO CLOSE. The News Desk panel lets an operator
// tick stories and press a button. That selection has to reach a spawned job.
// The obvious implementation - pass the ids as arguments - is the same class of
// footgun artifacts.ts refuses for filenames, and worse: these ids would land in
// an argv that is concatenated into a shell command line (runner.ts spawns with
// shell:true, because npx and tsx are .cmd shims on Windows). One quote, one
// caret, one ampersand and the operator's browser is choosing what runs.
//
// So the selection NEVER becomes an argument. The registry's flags stay literal
// (--from-picks and nothing else), and the pick set travels as a file:
//
//   1. the browser POSTs { ids: [...] }
//   2. THIS module checks every id by exact equality against the candidates
//      artifact the server itself wrote, and checks that artifact is fresh
//   3. THIS module writes output/machine-room/news-picks.json
//   4. the job reads that file and re-validates it from scratch
//
// The client contributes a SELECTION FROM A SERVER-SUPPLIED SET. It cannot
// contribute a string that reaches disk: even candidatesGeneratedAt is filled in
// from the artifact, never copied from the request.
//
// NEVER A PARTIAL FILE. Validation is complete before a single byte is written,
// and the write is one call. A refused request leaves whatever was there before
// exactly as it was, which matters: the previous picks file may still be the
// input of a run in flight.

import {
  CANDIDATES_MAX_AGE_HOURS,
  MACHINE_ROOM_DIR,
  REDISCOVER_REMEDY,
  checkFreshness,
  readCandidates,
  validatePickedIds,
  writePicks,
  type NewsCandidates,
  type NewsPicks,
} from "../../src/content/news/news-picks.js";

/**
 * The verification cap, restated here as the SERVER's limit.
 *
 * It is deliberately a literal rather than an import from src/jobs/news-edition:
 * that module pulls in puppeteer, the Anthropic client, R2 and Slack at import
 * time, and the machine room must not load any of them to answer a POST. The
 * pin in news-desk.check.ts asserts the two stay equal.
 */
export const MAX_PICKS = 5;

export type PicksOutcome =
  | { ok: true; picks: NewsPicks; candidates: NewsCandidates; path: string }
  | { ok: false; status: number; error: string };

/**
 * Load the candidates artifact and prove it is still usable.
 *
 * 404 when there is none (the operator has not discovered yet, or the file was
 * removed); 409 when it is stale, because a request against a moved-on news
 * window is a conflict with the world, not a malformed request.
 */
export function loadUsableCandidates(nowMs: number, dir: string = MACHINE_ROOM_DIR): PicksOutcome | { ok: true; candidates: NewsCandidates } {
  const read = readCandidates(dir);
  if (!read.ok) {
    return { ok: false, status: 404, error: `${read.reason} - run "Get the latest news" first` };
  }
  const fresh = checkFreshness(read.value.generatedAt, nowMs, CANDIDATES_MAX_AGE_HOURS, "candidates", REDISCOVER_REMEDY);
  if (!fresh.fresh) {
    return { ok: false, status: 409, error: fresh.reason };
  }
  return { ok: true, candidates: read.value };
}

/**
 * Validate a POSTed selection and, only if every check passes, write the picks
 * file. Returns what was written so the caller can report it back honestly.
 *
 * `rawIds` is `unknown` on purpose: it comes straight off a parsed request body
 * and this function is the place that decides what it is.
 */
export function validateAndWritePicks(rawIds: unknown, nowMs: number, dir: string = MACHINE_ROOM_DIR): PicksOutcome {
  const loaded = loadUsableCandidates(nowMs, dir);
  if ("status" in loaded) return loaded;
  const candidates = loaded.candidates;

  const valid = validatePickedIds(candidates, rawIds, MAX_PICKS);
  if (!valid.ok) {
    return { ok: false, status: 400, error: valid.reason };
  }

  // candidatesGeneratedAt comes from the ARTIFACT, never from the request. The
  // job compares the two, so letting a client supply it would let a client
  // defeat the mismatch check it exists to fail.
  const picks: NewsPicks = {
    candidatesGeneratedAt: candidates.generatedAt,
    pickedIds: valid.ids,
  };
  const path = writePicks(picks, dir);
  return { ok: true, picks, candidates, path };
}

/** One picker row as the UI needs it - the resume payload is not shipped. */
export interface CandidateRow {
  id: string;
  headline: string;
  score: number;
  storyClass: string;
  bestTier: string;
  outletCount: number;
  outlets: string[];
  judgedTitle: string | null;
  eligible: boolean;
  holdReason: string;
  itemCount: number;
}

export interface CandidatesView {
  generatedAt: string;
  istDate: string;
  windowHours: number;
  hiddenSeenCount: number;
  gatheredCount: number;
  ageHours: number | null;
  stale: boolean;
  maxPicks: number;
  clusters: CandidateRow[];
}

/**
 * Project the artifact for the browser.
 *
 * The full serialized cluster payload is dropped: it exists so the JOB can
 * resume without re-gathering, and shipping tens of NewsItems per row to a
 * picker that renders one line each is bytes for nothing. `itemCount` is the
 * part of it the UI actually shows.
 */
export function toCandidatesView(c: NewsCandidates, nowMs: number): CandidatesView {
  const fresh = checkFreshness(c.generatedAt, nowMs, CANDIDATES_MAX_AGE_HOURS, "candidates", REDISCOVER_REMEDY);
  return {
    generatedAt: c.generatedAt,
    istDate: c.istDate,
    windowHours: c.windowHours,
    hiddenSeenCount: c.hiddenSeenCount,
    gatheredCount: c.gatheredCount,
    ageHours: fresh.ageHours,
    stale: !fresh.fresh,
    maxPicks: MAX_PICKS,
    clusters: c.clusters.map((row) => ({
      id: row.id,
      headline: row.headline,
      score: row.score,
      storyClass: row.storyClass,
      bestTier: row.bestTier,
      outletCount: row.outletCount,
      outlets: row.outlets,
      judgedTitle: row.judgedTitle,
      eligible: row.eligible,
      holdReason: row.holdReason,
      itemCount: row.cluster.items.length,
    })),
  };
}
