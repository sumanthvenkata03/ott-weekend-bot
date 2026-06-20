// src/jobs/saturday-verdict.ts
import { addDays, format, startOfDay, previousFriday, isFriday } from "date-fns";
import { ingestReleases } from "../ingestion/releases/index.js";
import type { Release } from "../shared/types.js";
import type { SaturdayVerdictDraft, VerdictSlide } from "../delivery/notion.js";
import {
  generateVerdictCover,
  formatWindowDates,
  type GroundedCoverFilm,
} from "../content/weekend/saturday-verdict.js";
import {
  researchVerdict,
  notFound,
  type VerdictResearch,
  type GroundedVerdict,
} from "../content/weekend/verdict-research.js";
import { writeSaturdayVerdictToNotion } from "../delivery/notion.js";
import { purgeExpired, cached } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { buildHashtags } from "../shared/hashtags.js";
import { renderSatVerdict } from "../rendering/render-sat-verdict.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";

// ── Grounded-research dials (Phase 1) ──
/** Deep-research (web search) only the top N films by importance; the rest get
 *  an honest "not found" with no search spend. Tunable editorial dial. */
const MAX_RESEARCH_FILMS = 15;
/** Research cache TTL — a Friday-eve re-run picks up new reviews; same-session
 *  re-runs are free. Keyed by IMDb id (fallback title+releaseDate). */
const RESEARCH_CACHE_TTL_HOURS = 24;
/** How many research web-search calls run at once (politeness + cost pacing). */
const RESEARCH_CONCURRENCY = 3;
/**
 * Pick the verdict window for "this Friday" — Wednesday → Friday of the release
 * week (3 days). The window anchors on that week's Friday, then opens two days
 * earlier (Wednesday) and closes on the Friday itself, so it judges ONLY films
 * already released by Friday — no look-ahead to the weekend's openings:
 * - If today IS Fri/Sat/Sun: this week's Wed–Fri
 * - If today is Mon-Thu: the upcoming Wed–Fri
 *
 * For the Friday Verdict cron, this runs on Friday morning targeting the
 * Wednesday that just passed through today (Friday).
 */
export function pickVerdictWindow(now: Date): { startDate: string; endDate: string } {
  const today = startOfDay(now);
  const dow = today.getDay();   // 0=Sun, 5=Fri, 6=Sat

  let friday: Date;
  if (dow === 5) friday = today;                              // It's Friday
  else if (dow === 6) friday = addDays(today, -1);            // Saturday → yesterday
  else if (dow === 0) friday = addDays(today, -2);            // Sunday → two days ago
  else friday = isFriday(today) ? today : previousFriday(addDays(today, 7));  // Mon-Thu → upcoming Fri

  const wednesday = addDays(friday, -2);   // open the window on Wednesday
  return {
    startDate: format(wednesday, "yyyy-MM-dd"),
    endDate: format(friday, "yyyy-MM-dd"),   // close on Friday itself (the anchor)
  };
}

/** Buzz/notability-first importance, mirroring Wed Drop's tmdbPopularity sort,
 *  with quality (tbsiScore) and audience-size (imdbVotes) tie-breaks so equally
 *  buzzy films still order sensibly. A missing release scores 0 (sorts last). */
function importanceOf(r: Release | undefined): [number, number, number] {
  return [r?.tmdbPopularity ?? 0, r?.tbsiScore ?? 0, r?.imdbVotes ?? 0];
}

function compareImportanceDesc(a: VerdictEntry, b: VerdictEntry): number {
  const ai = importanceOf(a.release);
  const bi = importanceOf(b.release);
  return (bi[0] - ai[0]) || (bi[1] - ai[1]) || (bi[2] - ai[2]);
}

function verdictKind(v: VerdictSlide["verdict"]): "must-watch" | "worth-a-try" | "skip" {
  if (v.includes("Must Watch")) return "must-watch";
  if (v.includes("Worth a Try")) return "worth-a-try";
  return "skip";
}

interface VerdictEntry {
  slide: VerdictSlide;
  // Explicit | undefined (not optional) so `.find()`'s result assigns cleanly
  // under exactOptionalPropertyTypes — a film may have no matching release.
  release: Release | undefined;
  /** Grounded research backing this entry (the slide also carries it). */
  research: VerdictResearch;
}

/** Map a grounded verdict to the emoji tier the renderer/selector key on. */
function toEmojiVerdict(v: GroundedVerdict): VerdictSlide["verdict"] {
  return v === "Must Watch" ? "🔥 Must Watch" : v === "Worth a Try" ? "👀 Worth a Try" : "⏭️ Skip";
}

/** Run `fn` over `items` with at most `limit` in flight at once. Order preserved. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Research one film, cached by IMDb id (fallback title+releaseDate). The loader
 * runs only on a cache miss, so a silent run = a hit, which we log. The billed
 * web-search call lives behind this cache.
 */
async function researchFilmCached(film: Release): Promise<VerdictResearch> {
  const key = `verdict-research:${film.imdbId ?? `${film.title}|${film.releaseDate}`}`;
  let miss = false;
  const result = await cached<VerdictResearch>(
    key,
    async () => { miss = true; return researchVerdict(film); },
    { ttlSeconds: RESEARCH_CACHE_TTL_HOURS * 3600 }
  );
  if (!miss) log.info(`  cache hit — ${film.title}`);
  return result;
}

/**
 * EDITORIAL DIAL — how many ⏭️ Skip cards the carousel is allowed to spend.
 * Skips are the least engaging slides, so we cap them low and route the rest to
 * the cover's "ALSO SKIPPING" footer (the verdict stays complete without
 * bloating the carousel). Tune this up/down to taste; it never affects Must
 * Watch or Worth a Try, only how many Skips get a full card.
 */
const MAX_SKIP_CARDS = 2;

/**
 * Deterministic card selection — the JOB decides the count, not the LLM.
 *
 * Buckets the LLM's tier assignments and fills up to `maxCards` slots by
 * priority: ALL Must Watch (cap-exempt — never trimmed), then Worth a Try by
 * importance desc, then Skip by notability desc but only up to MAX_SKIP_CARDS
 * (and never past the remaining slots).
 *
 * Returns the cards in carousel order — hero first (top Must Watch, else top
 * Worth a Try), then the remaining Must Watch, then Worth a Try, then Skip —
 * plus EVERY judged Skip that didn't get a card (for the cover's "ALSO
 * SKIPPING" footer, so the verdict stays complete without spending extra cards).
 */
export function selectVerdictCards(
  entries: VerdictEntry[],
  maxCards = 10
): { selected: VerdictEntry[]; trimmedSkips: VerdictEntry[] } {
  const must  = entries.filter(e => verdictKind(e.slide.verdict) === "must-watch").sort(compareImportanceDesc);
  const worth = entries.filter(e => verdictKind(e.slide.verdict) === "worth-a-try").sort(compareImportanceDesc);
  const skip  = entries.filter(e => verdictKind(e.slide.verdict) === "skip").sort(compareImportanceDesc);

  // 1. ALL Must Watch — exempt from the cap. If they alone exceed maxCards,
  //    every one of them still ships (Worth a Try / Skip then get nothing).
  const selected: VerdictEntry[] = [...must];

  // 2. Worth a Try (importance desc) until the carousel reaches maxCards.
  for (const e of worth) {
    if (selected.length >= maxCards) break;
    selected.push(e);
  }

  // 3. Skip (notable first) — capped at MAX_SKIP_CARDS AND the remaining slots.
  let skipsCarded = 0;
  for (const e of skip) {
    if (selected.length >= maxCards) break;
    if (skipsCarded >= MAX_SKIP_CARDS) break;
    selected.push(e);
    skipsCarded++;
  }

  // EVERY judged Skip not carded — surfaced on the cover, not rendered as cards.
  const selectedSet = new Set(selected);
  const trimmedSkips = skip.filter(e => !selectedSet.has(e));

  // `selected` is already hero-first: Must Watch leads, so selected[0] is the
  // top Must Watch; when there are none it's the top Worth a Try.
  return { selected, trimmedSkips };
}

async function main() {
  log.info("⚖️  Saturday Verdict job — starting");
  
  purgeExpired();
  
  const { startDate, endDate } = pickVerdictWindow(new Date());
  log.info(`Target window (Wed → Fri): ${startDate} → ${endDate}`);

  const releases = await ingestReleases(startDate, endDate);
  if (releases.length === 0) {
    log.warn("No releases in this window — aborting");
    return;
  }

  // Importance-sorted pool. A generous safety ceiling keeps a huge window
  // bounded; the deep-research cap below is the real spend control.
  const MAX_POOL = 40;
  const pool = [...releases]
    .sort((a, b) => (b.tmdbPopularity ?? 0) - (a.tmdbPopularity ?? 0))
    .slice(0, MAX_POOL);
  if (releases.length > MAX_POOL) {
    log.warn(`Window has ${releases.length} releases; capping pool to ${MAX_POOL} by popularity`);
  }

  // ── GROUNDED RESEARCH: real review aggregation per film (billed web search). ──
  // Deep-research the top MAX_RESEARCH_FILMS by importance; the long tail gets an
  // honest "not found" (no search spend) → confidence 'none' → ALSO SKIPPING.
  const deepFilms = pool.slice(0, MAX_RESEARCH_FILMS);
  const tailFilms = pool.slice(MAX_RESEARCH_FILMS);
  log.info(
    `Researching ${deepFilms.length} film(s) via web search (≤${RESEARCH_CONCURRENCY} concurrent)` +
    (tailFilms.length ? ` · ${tailFilms.length} tail film(s) not searched` : "")
  );
  const deepResults = await mapWithConcurrency(deepFilms, RESEARCH_CONCURRENCY, film => researchFilmCached(film));
  const researched: { film: Release; research: VerdictResearch }[] = [
    ...deepFilms.map((film, i) => ({ film, research: deepResults[i]! })),
    ...tailFilms.map(film => ({
      film,
      research: notFound(typeof film.imdbRating === "number" ? film.imdbRating : null),
    })),
  ];

  // Per-film research log line.
  for (const { film, research } of researched) {
    if (research.verdict !== null && research.star !== null) {
      log.info(
        `  ${film.title} — ★${research.star.toFixed(1)} (${research.verdict}, conf ${research.confidence})` +
        ` · ${research.criticRatings.length} critic(s)`
      );
    } else {
      log.info(`  ${film.title} — no grounded score (conf ${research.confidence})`);
    }
  }

  // Partition: only films with a grounded verdict become carousel candidates;
  // 'none'-confidence films are routed straight to ALSO SKIPPING (never a
  // fabricated verdict, never a card).
  const scoredFilms = researched.filter(r => r.research.verdict !== null);
  const noScoreFilms = researched.filter(r => r.research.verdict === null);

  if (scoredFilms.length === 0) {
    log.warn("No film earned a grounded verdict this window — nothing to publish. Aborting.");
    return;
  }

  // Build verdict slides from research, then run the deterministic selector
  // (unchanged) on the grounded tiers.
  const entries: VerdictEntry[] = scoredFilms.map(({ film, research }) => ({
    slide: {
      filmTitle: film.title,
      language: film.language,
      platform: film.platform,
      verdict: toEmojiVerdict(research.verdict!),
      oneLineVerdict: research.summaryLine,
      watchIf: research.watchIf,
      research,
    },
    release: film,
    research,
  }));
  const { selected, trimmedSkips } = selectVerdictCards(entries, 10);

  // Tier counts across all grounded candidates, for the selection log.
  const poolTally = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.slide.verdict] = (acc[e.slide.verdict] ?? 0) + 1;
    return acc;
  }, {});
  log.info(
    `Grounded tiers: ${Object.entries(poolTally).map(([k, v]) => `${k} ${v}`).join("  ")} ` +
    `→ selected ${selected.length} card(s)` +
    (trimmedSkips.length ? `, trimmed ${trimmedSkips.length} skip(s)` : "") +
    (noScoreFilms.length ? `, ${noScoreFilms.length} no-score` : "")
  );

  // Cover editorial from the grounded SELECTED films (cover matches the calls).
  const coverFilms: GroundedCoverFilm[] = selected.map(e => ({
    filmTitle: e.slide.filmTitle,
    language: e.slide.language,
    verdict: e.slide.verdict,
    star: e.research.star,
    summaryLine: e.slide.oneLineVerdict,
  }));
  const coverCopy = await generateVerdictCover(coverFilms, startDate, endDate);
  log.info(`Hot take: "${coverCopy.hotTake}"`);
  log.info(`Caption (${coverCopy.caption.length} chars): ${coverCopy.caption.slice(0, 100)}...`);

  // Assemble the draft from the grounded selection + cover editorial. This is
  // the single source of truth everything downstream reads.
  const draft: SaturdayVerdictDraft = {
    pillar: "Sat Verdict",
    weekendDates: formatWindowDates(startDate, endDate),
    caption: coverCopy.caption,
    hashtags: coverCopy.hashtags,
    hotTake: coverCopy.hotTake,
    verdicts: selected.map(e => e.slide),
    releases: selected.map(e => e.release).filter((r): r is Release => r !== undefined),
  };

  // ALSO SKIPPING = trimmed grounded Skips + every no-score film (named, not carded).
  const alsoSkipping = [
    ...trimmedSkips.map(e => e.slide.filmTitle),
    ...noScoreFilms.map(r => r.film.title),
  ];

  // Verdict tally for the SELECTED carousel (what actually ships).
  const tally = draft.verdicts.reduce<Record<string, number>>((acc, v) => {
    acc[v.verdict] = (acc[v.verdict] ?? 0) + 1;
    return acc;
  }, {});
  log.info(`Verdict tally (selected): ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join("  ")}`);

  const today = new Date();
  const issueNumber = getIssueNumberForToday();
  const dateStr = format(today, "yyyy-MM-dd");

  log.info(`Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderSatVerdict(draft, issueNumber, "output/posts", alsoSkipping);

  // Single-source-of-truth gate: rendered cards must equal the selected count.
  // (Count is now deterministic — this only fires if render/selection drift.)
  const cardCount = renderResult.cardPaths.length;
  if (cardCount !== draft.verdicts.length) {
    throw new Error(
      `Sat Verdict rendered ${cardCount} cards but selected ${draft.verdicts.length}. ` +
      `Render/selection out of sync.`
    );
  }

  log.info("Uploading to R2...");
  const uploads = await uploadPngsToR2([
    { localPath: renderResult.coverPath, r2Key: `sat-verdict/${dateStr}/cover.png` },
    ...renderResult.cardPaths.map((p, i) => ({
      localPath: p,
      r2Key: `sat-verdict/${dateStr}/card-${String(i + 1).padStart(2, "0")}.png`,
    })),
  ]);
  const cover = uploads[0]!;
  const cardUploads = uploads.slice(1);

  // Build imageUrls keyed card1..cardN dynamically so Notion attaches one image per verdict.
  const imageUrls: { cover: string; [k: string]: string } = { cover: cover.publicUrl };
  cardUploads.forEach((upload, i) => {
    imageUrls[`card${i + 1}`] = upload.publicUrl;
  });

  // Build richer factual hashtags from metadata + industry/platform umbrella
  // tags, merging the LLM's thematic tags. Used for BOTH Notion and Slack.
  const enrichedHashtags = buildHashtags(draft.releases, draft.hashtags);
  draft.hashtags = enrichedHashtags;

  // Write to Notion. If this throws, the R2 uploads above are already written
  // (immutable, 1-year cache) — log the orphaned keys for traceability, then
  // re-throw so the job's catch still fires the Slack failure alert.
  log.info("Writing Notion draft...");
  let url: string;
  try {
    url = await writeSaturdayVerdictToNotion(draft, imageUrls);
  } catch (err) {
    log.warn(
      `Notion write failed after R2 upload — ${uploads.length} orphaned R2 object(s) ` +
      `(immutable, 1-year cache): ${uploads.map(u => u.key).join(", ")}`
    );
    throw err;
  }

  log.info("Sending Slack notification...");
  await notifyDraftReady({
    pillar: "Sat Verdict",
    emoji: "⚖️",
    title: `Verdict window ${startDate} → ${endDate}`,
    subtitle: draft.hotTake,
    notionUrl: url,
    metadata: {
      "Issue": String(issueNumber),
      "Verdicts": Object.entries(tally).map(([k, v]) => `${k} ${v}`).join("  "),
      "Films": String(draft.verdicts.length),
    },
    coverImageUrl: cover.publicUrl,
    bodyCardImageUrls: cardUploads.map(u => u.publicUrl),
    hashtags: enrichedHashtags,
  });

  log.success(`\n✅ Sat Verdict PREVIEW delivered — Notion page: ${url}`);
  log.success(`   Cover: ${cover.publicUrl}`);
}

// Only run the pipeline when invoked directly (npm run job:saturday). Guarding
// on isMainModule lets tests import selectVerdictCards without firing main()
// (and its live API calls). Mirrors the render scripts' standalone-mode check.
const isMainModule = import.meta.url.endsWith(
  (process.argv[1] ?? "").replace(/\\/g, "/")
);

if (isMainModule) {
  main()
    .catch(async (err) => {
      log.error("Saturday Verdict job failed", err);
      await notifyJobFailure("Sat Verdict", err instanceof Error ? err.message : String(err));
      process.exit(1);
    })
    .finally(async () => {
      await closeBrowser();
    });
}