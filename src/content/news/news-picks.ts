// src/content/news/news-picks.ts
// NEWS DESK - MR-M2 NEWSDESK. The three operator artifacts and their contracts.
//
// The Machine Room lets an operator DISCOVER stories, PICK some, GENERATE cards
// from exactly those, and later MARK the posted ones as seen. Those four steps
// are four separate processes, so the state between them has to live on disk.
//
// ONE RULE GOVERNS THE WHOLE FILE, and it is a security rule, not a style one:
// NOTHING AN OPERATOR TYPES EVER REACHES A COMMAND LINE. The Machine Room's
// registry forces literal flags (--discover / --from-picks / --mark-posted) and
// the operator's SELECTION travels only as a server-written, server-validated
// JSON file at a fixed literal path. The job reads that file itself. There is no
// argument through which a pick could become argv.
//
// THE THREE PATHS ARE FIXED LITERALS, resolved from THIS module's own location
// rather than process.cwd(). The job runs with cwd=REPO_ROOT and the server
// resolves everything from REPO_ROOT too, but "everything resolves the same way
// from anywhere" is cheaper than remembering which is which. The `dir` parameter
// on every reader/writer exists for TESTS only; production always takes the
// default, which is the literal.
//
// FRESHNESS IS PART OF THE CONTRACT. A candidates artifact older than 12h
// describes a news window that has moved on, so generating from it would render
// yesterday's picks under today's date. A package artifact older than 48h is no
// longer plausibly the thing the operator just posted, so marking its URLs seen
// would burn stories nobody published. Both refuse rather than guess.

import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutletTier, ScoredCluster } from "./news-score.js";
import type { NewsItem } from "./news-gather.js";
import type { Language } from "../../shared/types.js";

/** src/content/news/ */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo root - three levels up from src/content/news/. */
export const REPO_ROOT = join(HERE, "..", "..", "..");

/** THE fixed literal directory. Both the job and the server use this constant. */
export const MACHINE_ROOM_DIR = join(REPO_ROOT, "output", "machine-room");

export const CANDIDATES_FILENAME = "news-candidates.json";
export const PICKS_FILENAME = "news-picks.json";
export const PACKAGE_FILENAME = "news-package.json";

/** A candidates artifact older than this cannot be generated from. */
export const CANDIDATES_MAX_AGE_HOURS = 12;
/** A package artifact older than this cannot be marked posted. */
export const PACKAGE_MAX_AGE_HOURS = 48;

export const candidatesPath = (dir: string = MACHINE_ROOM_DIR): string => join(dir, CANDIDATES_FILENAME);
export const picksPath = (dir: string = MACHINE_ROOM_DIR): string => join(dir, PICKS_FILENAME);
export const packagePath = (dir: string = MACHINE_ROOM_DIR): string => join(dir, PACKAGE_FILENAME);

// -- SCHEMAS ----------------------------------------------------------------
//
// Every artifact is validated on READ as well as on write. A hand-edited or
// half-written file is a malformed file, and the caller refuses loudly rather
// than running a pipeline over `undefined`.

export const NewsItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  source: z.string(),
  publishedISO: z.string(),
  language: z.string(),
});

/**
 * The FULL ScoredCluster payload. This is what makes stages 4-8 resumable from
 * the artifact: verify needs id/headline/outlets/language, resolve needs the
 * confirmed story, compose needs score/items.length/storyClass, and the caption
 * needs the headline. All of it is here, so --from-picks never re-gathers.
 */
export const ScoredClusterSchema = z.object({
  id: z.string(),
  headline: z.string(),
  language: z.string(),
  items: z.array(NewsItemSchema),
  outlets: z.array(z.string()),
  outletCount: z.number(),
  bestTier: z.enum(["A", "B", "C"]),
  hasTierC: z.boolean(),
  storyClass: z.string(),
  classWeight: z.number(),
  suppressed: z.boolean(),
  tierPoints: z.number(),
  crossOutletPoints: z.number(),
  judgedTitle: z.string().nullable(),
  judgedPoints: z.number(),
  score: z.number(),
  eligible: z.boolean(),
  holdReason: z.string(),
});

/**
 * One row in the picker. The flat fields are what the UI renders; `cluster` is
 * the payload the run resumes from. They are deliberately duplicated rather
 * than derived in the browser: the UI must never have to understand the scoring
 * model to draw a row.
 */
export const CandidateSchema = z.object({
  id: z.string(),
  headline: z.string(),
  score: z.number(),
  storyClass: z.string(),
  bestTier: z.enum(["A", "B", "C"]),
  outletCount: z.number(),
  outlets: z.array(z.string()),
  judgedTitle: z.string().nullable(),
  eligible: z.boolean(),
  holdReason: z.string(),
  cluster: ScoredClusterSchema,
});

export const NewsCandidatesSchema = z.object({
  generatedAt: z.string(),
  istDate: z.string(),
  windowHours: z.number(),
  /** How many gathered items the seen filter hid. READ ONLY - nothing marked. */
  hiddenSeenCount: z.number(),
  gatheredCount: z.number(),
  clusters: z.array(CandidateSchema),
});

export const NewsPicksSchema = z.object({
  /** Must equal the candidates artifact's generatedAt, or the run refuses. */
  candidatesGeneratedAt: z.string(),
  pickedIds: z.array(z.string()),
});

export const PackageStorySchema = z.object({
  id: z.string(),
  headline: z.string(),
  badge: z.string(),
  segmentReason: z.string(),
  sourceUrl: z.string(),
  score: z.number(),
  storyClass: z.string(),
  /** Non-null when the operator picked a HELD story - carries the hold reason. */
  operatorOverride: z.string().nullable(),
  /** The gathered item URLs behind this story. --mark-posted marks EXACTLY these. */
  itemUrls: z.array(z.string()),
});

export const NewsPackageArtifactSchema = z.object({
  generatedAt: z.string(),
  istDate: z.string(),
  format: z.string(),
  why: z.string(),
  caption: z.string(),
  captionHashtags: z.array(z.string()),
  commentHashtags: z.array(z.string()),
  pinnedComment: z.string(),
  badgeCheckBoard: z.array(z.object({ name: z.string(), candidateHandle: z.string().nullable() })),
  heldFor: z.array(z.string()),
  /** Picked-though-held stories that SURVIVED verification and made the deck. */
  overrides: z.array(z.object({ id: z.string(), headline: z.string(), holdReason: z.string() })),
  stories: z.array(PackageStorySchema),
  dropped: z.array(z.object({ headline: z.string(), reason: z.string() })),
  cardFiles: z.array(z.string()),
  /** The whole posting kit as text - caption, board, pinned comment, overrides. */
  packageText: z.string(),
});

export type NewsItemRecord = z.infer<typeof NewsItemSchema>;
export type CandidateRecord = z.infer<typeof CandidateSchema>;
export type NewsCandidates = z.infer<typeof NewsCandidatesSchema>;
export type NewsPicks = z.infer<typeof NewsPicksSchema>;
export type PackageStory = z.infer<typeof PackageStorySchema>;
export type NewsPackageArtifact = z.infer<typeof NewsPackageArtifactSchema>;

// -- READ / WRITE -----------------------------------------------------------

export type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function readArtifactFile<T>(path: string, schema: z.ZodType<T>, label: string): ReadResult<T> {
  if (!existsSync(path)) {
    return { ok: false, reason: `no ${label} artifact at ${path}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, reason: `${label} artifact is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? first.path.join(".") || "(root)" : "(root)";
    return { ok: false, reason: `${label} artifact is malformed at ${where}: ${first ? first.message : "unknown"}` };
  }
  return { ok: true, value: parsed.data };
}

function writeArtifactFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readCandidates(dir: string = MACHINE_ROOM_DIR): ReadResult<NewsCandidates> {
  return readArtifactFile(candidatesPath(dir), NewsCandidatesSchema, "candidates");
}

export function readPicks(dir: string = MACHINE_ROOM_DIR): ReadResult<NewsPicks> {
  return readArtifactFile(picksPath(dir), NewsPicksSchema, "picks");
}

export function readPackage(dir: string = MACHINE_ROOM_DIR): ReadResult<NewsPackageArtifact> {
  return readArtifactFile(packagePath(dir), NewsPackageArtifactSchema, "package");
}

/** Validate before writing: an artifact we cannot read back is not written. */
export function writeCandidates(value: NewsCandidates, dir: string = MACHINE_ROOM_DIR): string {
  const path = candidatesPath(dir);
  writeArtifactFile(path, NewsCandidatesSchema.parse(value));
  return path;
}

export function writePicks(value: NewsPicks, dir: string = MACHINE_ROOM_DIR): string {
  const path = picksPath(dir);
  writeArtifactFile(path, NewsPicksSchema.parse(value));
  return path;
}

export function writePackage(value: NewsPackageArtifact, dir: string = MACHINE_ROOM_DIR): string {
  const path = packagePath(dir);
  writeArtifactFile(path, NewsPackageArtifactSchema.parse(value));
  return path;
}

// -- FRESHNESS --------------------------------------------------------------

export function ageHours(generatedAt: string, nowMs: number): number | null {
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) return null;
  return (nowMs - t) / 3_600_000;
}

export interface FreshnessVerdict {
  fresh: boolean;
  /** Printable. Empty string when fresh. */
  reason: string;
  ageHours: number | null;
}

/**
 * A stale artifact is a REFUSAL, not a warning. An unparseable generatedAt is
 * also stale: we cannot prove it is fresh, and "cannot prove" fails closed.
 */
export function checkFreshness(
  generatedAt: string,
  nowMs: number,
  maxHours: number,
  label: string,
  remedy: string
): FreshnessVerdict {
  const age = ageHours(generatedAt, nowMs);
  if (age === null) {
    return {
      fresh: false,
      ageHours: null,
      reason: `${label} artifact has an unreadable generatedAt (${generatedAt}) - ${remedy}`,
    };
  }
  if (age > maxHours) {
    return {
      fresh: false,
      ageHours: age,
      reason: `${label} artifact is ${age.toFixed(1)}h old (limit ${maxHours}h) - ${remedy}`,
    };
  }
  return { fresh: true, ageHours: age, reason: "" };
}

/** The one wording for a stale candidates artifact. Server and job share it. */
export const REDISCOVER_REMEDY = "re-discover before generating";
/** The one wording for a stale package artifact. */
export const REGENERATE_REMEDY = "generate a fresh package before marking anything posted";

// -- PICK VALIDATION --------------------------------------------------------
//
// Used by BOTH the server (before it writes the picks file) and the job (before
// it spends anything). Two gates, one rule set, no drift.

export interface PickValidation {
  ok: boolean;
  /** Ids present in the artifact, in ARTIFACT order (score order), deduped. */
  ids: string[];
  /** Ids the operator sent that the artifact does not contain. */
  unknownIds: string[];
  /** Printable refusal. Empty string when ok. */
  reason: string;
}

/**
 * Ids are checked against the artifact by EXACT equality, exactly as the
 * artifact endpoint checks filenames. An id that is not in the whitelist does
 * not exist, whatever it looks like.
 *
 * The returned order is the ARTIFACT's, never the operator's: the desk verifies
 * in score order, and letting a request reorder that would let a click change
 * which story lands in the last verification slot.
 */
export function validatePickedIds(
  candidates: NewsCandidates,
  rawIds: unknown,
  /**
   * The SERVER passes the real cap so an over-picked request is a 400 before
   * anything is written. The JOB passes nothing: its refusal list is fixed, and
   * an over-cap picks file (hand-written, or left by an older server) is
   * reported as an over-cap DROP rather than a refusal that discards the picks
   * that would have fitted.
   */
  maxPicks: number = Number.POSITIVE_INFINITY
): PickValidation {
  if (!Array.isArray(rawIds) || rawIds.some((v) => typeof v !== "string")) {
    return { ok: false, ids: [], unknownIds: [], reason: "ids must be an array of strings" };
  }
  const asked = [...new Set(rawIds as string[])];
  if (asked.length === 0) {
    return { ok: false, ids: [], unknownIds: [], reason: "pick at least one story" };
  }
  const known = new Set(candidates.clusters.map((c) => c.id));
  const unknownIds = asked.filter((id) => !known.has(id));
  if (unknownIds.length > 0) {
    return {
      ok: false,
      ids: [],
      unknownIds,
      reason: `not a story in the current candidates artifact: ${unknownIds.join(", ")}`,
    };
  }
  if (asked.length > maxPicks) {
    return {
      ok: false,
      ids: [],
      unknownIds: [],
      reason: `${asked.length} stories picked - the desk verifies at most ${maxPicks} in one run`,
    };
  }
  const askedSet = new Set(asked);
  const ids = candidates.clusters.filter((c) => askedSet.has(c.id)).map((c) => c.id);
  return { ok: true, ids, unknownIds: [], reason: "" };
}

// -- ARTIFACT <-> RUNTIME ---------------------------------------------------

/**
 * Rehydrate a ScoredCluster from its artifact record.
 *
 * The two casts are the seam between a schema that must accept any string and
 * the runtime unions the pipeline uses. Both are safe by construction: the
 * artifact is written by scoreClusters output in this same repo, so `language`
 * came from the seven-language gather table and `bestTier` came from
 * tierOfOutlet. A hand-edited language does not crash anything downstream - it
 * only mislabels one hashtag - so a runtime union check here would buy nothing
 * a schema failure does not already buy.
 */
export function toScoredCluster(rec: CandidateRecord): ScoredCluster {
  const c = rec.cluster;
  const items: NewsItem[] = c.items.map((i) => ({
    title: i.title,
    url: i.url,
    source: i.source,
    publishedISO: i.publishedISO,
    language: i.language as Language,
  }));
  return {
    id: c.id,
    headline: c.headline,
    language: c.language as Language,
    items,
    outlets: c.outlets,
    outletCount: c.outletCount,
    bestTier: c.bestTier as OutletTier,
    hasTierC: c.hasTierC,
    storyClass: c.storyClass,
    classWeight: c.classWeight,
    suppressed: c.suppressed,
    tierPoints: c.tierPoints,
    crossOutletPoints: c.crossOutletPoints,
    judgedTitle: c.judgedTitle,
    judgedPoints: c.judgedPoints,
    score: c.score,
    eligible: c.eligible,
    holdReason: c.holdReason,
  };
}

/** Serialize a scored cluster into one picker row. PURE. */
export function toCandidateRecord(c: ScoredCluster): CandidateRecord {
  return {
    id: c.id,
    headline: c.headline,
    score: c.score,
    storyClass: c.storyClass,
    bestTier: c.bestTier,
    outletCount: c.outletCount,
    outlets: c.outlets,
    judgedTitle: c.judgedTitle,
    eligible: c.eligible,
    holdReason: c.holdReason,
    cluster: {
      id: c.id,
      headline: c.headline,
      language: c.language,
      items: c.items.map((i) => ({
        title: i.title,
        url: i.url,
        source: i.source,
        publishedISO: i.publishedISO,
        language: i.language,
      })),
      outlets: c.outlets,
      outletCount: c.outletCount,
      bestTier: c.bestTier,
      hasTierC: c.hasTierC,
      storyClass: c.storyClass,
      classWeight: c.classWeight,
      suppressed: c.suppressed,
      tierPoints: c.tierPoints,
      crossOutletPoints: c.crossOutletPoints,
      judgedTitle: c.judgedTitle,
      judgedPoints: c.judgedPoints,
      score: c.score,
      eligible: c.eligible,
      holdReason: c.holdReason,
    },
  };
}

// -- PACKAGE TEXT -----------------------------------------------------------

/** ASCII rule line. The package text is pasted into terminals and text fields. */
const RULE = "".padEnd(66, "=");

export interface PackageTextInput {
  istDate: string;
  format: string;
  why: string;
  caption: string;
  captionHashtags: string[];
  commentHashtags: string[];
  pinnedComment: string;
  badgeCheckBoard: { name: string; candidateHandle: string | null }[];
  heldFor: string[];
  stories: PackageStory[];
  dropped: { headline: string; reason: string }[];
  cardFiles: string[];
}

/**
 * The whole posting kit, as text.
 *
 * OVERRIDES ARE RENDERED LOUDLY and TWICE - once in the story list and once in
 * a block of their own at the top. An operator who overrode the desk's hold
 * three clicks ago is about to paste this into Instagram; the reason the desk
 * held it has to be impossible to miss at that moment, not discoverable.
 */
export function buildPackageText(p: PackageTextInput): string {
  const out: string[] = [];
  out.push(RULE);
  out.push(`TBSI NEWS DESK - OPERATOR PACKAGE - ${p.istDate}`);
  out.push(`FORMAT: ${p.format}`);
  out.push(p.why);
  out.push(RULE);

  const overridden = p.stories.filter((s) => s.operatorOverride !== null);
  if (overridden.length > 0) {
    out.push("");
    out.push("!! OPERATOR OVERRIDE !!");
    out.push(`!! ${overridden.length} story/stories in this package were HELD by the desk and picked anyway.`);
    out.push("!! Each was still verified - an unconfirmed pick was dropped - but the desk's");
    out.push("!! reason for holding it stands. Read it before posting.");
    for (const s of overridden) {
      out.push(`!!   [${s.id}] ${s.headline}`);
      out.push(`!!      HELD BECAUSE: ${s.operatorOverride}`);
    }
    out.push("");
  }

  out.push("1. IMAGES");
  if (p.cardFiles.length === 0) {
    out.push("   (no cards rendered)");
  } else {
    for (const f of p.cardFiles) out.push(`   output/posts/${f}`);
  }

  out.push("");
  if (p.heldFor.length > 0) {
    out.push("2. CAPTION - HELD");
    out.push(`   unbacked names: ${p.heldFor.join(", ")}`);
    out.push("   Do not post this deck until the copy is rewritten.");
  } else {
    out.push("2. CAPTION");
    out.push(p.caption);
    out.push("");
    out.push(p.captionHashtags.join(" "));
  }

  if (p.commentHashtags.length > 0) {
    out.push("");
    out.push("3. FIRST COMMENT");
    out.push(p.commentHashtags.join(" "));
  }

  if (p.pinnedComment) {
    out.push("");
    out.push("4. PINNED COMMENT");
    out.push(p.pinnedComment);
  }

  if (p.badgeCheckBoard.length > 0) {
    out.push("");
    out.push("5. TAG CHECK - verify before tagging. No tick, no tag.");
    for (const b of p.badgeCheckBoard) {
      out.push(`   - ${b.name} - ${b.candidateHandle ? `candidate ${b.candidateHandle}` : "no handle suggested"}`);
    }
  }

  out.push("");
  out.push("STORIES IN THIS PACKAGE");
  for (const s of p.stories) {
    out.push(`   [${s.badge}] ${s.headline}`);
    out.push(`      score ${s.score} - ${s.storyClass} - ${s.sourceUrl || "(no receipt)"}`);
    if (s.operatorOverride !== null) {
      out.push(`      !! OPERATOR OVERRIDE - the desk HELD this: ${s.operatorOverride}`);
    }
  }

  if (p.dropped.length > 0) {
    out.push("");
    out.push("DROPPED");
    for (const d of p.dropped) out.push(`   - ${d.headline}: ${d.reason}`);
  }

  out.push("");
  out.push(RULE);
  out.push("NOTHING WAS SENT. No Slack, no R2, no zip upload, nothing marked seen.");
  out.push('Use "Mark as posted" only AFTER you have actually posted.');
  out.push(RULE);
  return out.join("\n");
}

/** Every item URL behind the stories that made the package, deduped, in order. */
export function packageStoryUrls(pkg: NewsPackageArtifact): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of pkg.stories) {
    for (const u of s.itemUrls) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
