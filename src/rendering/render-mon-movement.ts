// src/rendering/render-mon-movement.ts
// Orchestrator: MovementDraft → 1 cover PNG + N body card PNGs

import { promises as fs } from "node:fs";
import { renderToPNG, closeBrowser } from "./renderer.js";
import { format } from "date-fns";
import { log } from "../shared/logger.js";
import type { MovementDraft } from "../delivery/notion.js";
import type { Release } from "../shared/types.js";
import type {
  MonMovementCoverContext,
  MonMovementCardContext,
  MonMovementGridItem,
} from "./types.js";
import {
  getPlatformStyle,
  computeDensity,
  hasMetadataLine1,
  hasMetadataLine2,
  hasReleasedSection,
  hasLanguagesSection,
  buildStampContext,
} from "./_shared.js";

/**
 * Delete any stale mon-movement PNGs for this date before re-rendering,
 * so an earlier run's orphan cards don't get picked up by `npm run thumbnails`
 * or re-uploaded on the next invocation.
 */
async function cleanOldRenders(outputDir: string, datePrefix: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return;
  }
  const prefix = `mon-movement-${datePrefix}-`;
  const stale = entries.filter(e => e.startsWith(prefix) && e.endsWith(".png"));
  await Promise.all(stale.map(e => fs.unlink(`${outputDir}/${e}`)));
  if (stale.length > 0) log.info(`  Cleaned ${stale.length} stale Mon Movement PNG(s)`);
}

const LANGUAGE_FALLBACK_COLORS: Record<string, string> = {
  "Hindi":     "#A33223",
  "Malayalam": "#2E5742",
  "Telugu":    "#C49A3F",
  "Tamil":     "#1A1614",
  "Kannada":   "#A33223",
  "Marathi":   "#2E5742",
  "Bengali":   "#C49A3F",
  "Punjabi":   "#A33223",
  "Other":     "#1A1614",
};

function buildGridItem(r: Release, isGem: boolean): MonMovementGridItem {
  return {
    filmTitle: r.title,
    language: r.language,
    platform: r.platform,
    platformLogos: r.platform.map(p => p.toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/\+/g, "-plus")
      .replace(/\./g, "")
      .replace(/jio-?hotstar/g, "jiohotstar")),
    posterUrl: r.posterUrl,
    fallbackColor: LANGUAGE_FALLBACK_COLORS[r.language] ?? "#1A1614",
    isGem,
  };
}

// Gem slide titles come in as "Hidden Gem: <film>" per the LLM prompt — strip prefix for lookup.
function normalizeSlideTitle(t: string): string {
  return t.replace(/^Hidden Gem:\s*/i, "").trim();
}

export interface RenderResult {
  coverPath: string;
  cardPaths: string[];
}

export async function renderMonMovement(
  draft: MovementDraft,
  issueNumber: string | number,
  outputDir = "output/posts"
): Promise<RenderResult> {
  log.info(`Rendering Mon Movement — Issue №${issueNumber}`);

  const coverSlide = draft.slides.find(s => s.type === "cover");
  const bodySlides = draft.slides.filter(
    s => s.type === "arrival" || s.type === "gem"
  );

  log.info(
    `  Arrivals: ${draft.newArrivals.length} | Gems: ${draft.hiddenGems.length} | Body slides: ${bodySlides.length}`
  );

  const today = new Date();
  const baseCtx = {
    vol: "01",
    issue: String(issueNumber).padStart(3, "0"),
    date: format(today, "yyyy-MM-dd"),
    displayDate: format(today, "dd·MM·yy"),
    pillarLabel: "MON MOVEMENT" as const,
  };

  await cleanOldRenders(outputDir, baseCtx.date);

  // 1. Cover grid — balance arrivals/gems narratively, cap 4, interleave.
  //    Gems are half the point of Mon Movement, so don't let arrivals crowd them out.
  const allArrivals = draft.newArrivals.map(r => buildGridItem(r, false));
  const allGems = draft.hiddenGems.map(r => buildGridItem(r, true));

  let arrivalsCount: number;
  let gemsCount: number;
  if (allArrivals.length >= 2 && allGems.length >= 2) {
    arrivalsCount = 2;
    gemsCount = 2;
  } else if (allGems.length === 1) {
    arrivalsCount = Math.min(allArrivals.length, 3);
    gemsCount = 1;
  } else if (allArrivals.length === 1) {
    arrivalsCount = 1;
    gemsCount = Math.min(allGems.length, 3);
  } else {
    arrivalsCount = Math.min(allArrivals.length, 4);
    gemsCount = Math.min(allGems.length, 4 - arrivalsCount);
  }

  const pickedArrivals = allArrivals.slice(0, arrivalsCount);
  const pickedGems = allGems.slice(0, gemsCount);

  // Interleave [arrival, gem, arrival, gem] when both buckets have items
  const gridItems: MonMovementGridItem[] = [];
  const maxLen = Math.max(pickedArrivals.length, pickedGems.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < pickedArrivals.length) gridItems.push(pickedArrivals[i]);
    if (i < pickedGems.length) gridItems.push(pickedGems[i]);
  }

  const coverPath = `${outputDir}/mon-movement-${baseCtx.date}-cover.png`;
  const coverCtx: MonMovementCoverContext = {
    ...baseCtx,
    weekLabel: draft.weekLabel,
    weekHeadline: draft.weekHeadline,
    arrivalCount: draft.newArrivals.length,
    gemCount: draft.hiddenGems.length,
    coverHeadline: coverSlide?.title ?? draft.weekHeadline,
    coverSubtext: coverSlide?.body ?? "The films worth catching up on.",
    gridItems,
  };
  await renderToPNG({
    templateName: "mon-movement-cover",
    data: coverCtx as unknown as Record<string, unknown>,
    width: 1080, height: 1350,
    outputPath: coverPath,
  });

  // 2. Body cards — one per arrival/gem slide. Match slide → Release by title.
  const cardPaths: string[] = [];
  for (let i = 0; i < bodySlides.length; i++) {
    const slide = bodySlides[i];
    const cleanTitle = normalizeSlideTitle(slide.title);

    // Lookup priority depends on slide type — but fall back to the other bucket
    // if the LLM mis-tagged (and remember which bucket actually contained it,
    // because that's what determines slotKind, not the slide.type label).
    let release: Release | undefined;
    let slotKind: "arrival" | "gem";

    const primaryBucket = slide.type === "arrival" ? draft.newArrivals : draft.hiddenGems;
    const fallbackBucket = slide.type === "arrival" ? draft.hiddenGems : draft.newArrivals;
    const matches = (r: Release) => r.title === slide.title || r.title === cleanTitle;

    release = primaryBucket.find(matches);
    if (release) {
      slotKind = slide.type as "arrival" | "gem";
    } else {
      release = fallbackBucket.find(matches);
      slotKind = slide.type === "arrival" ? "gem" : "arrival";
    }

    if (!release) {
      log.warn(`  ⚠ No Release for slide "${slide.title}" — skipping`);
      continue;
    }

    const enrichedRelease = {
      ...buildGridItem(release, slotKind === "gem"),
      ...(release.director ? { director: release.director } : {}),
      cast: release.cast,
      ...(release.runtime ? { runtime: release.runtime } : {}),
      // Phase 5.5 enrichment
      ...(release.leadCast && release.leadCast.length > 0 ? { leadCast: release.leadCast } : {}),
      ...(release.musicDirector ? { musicDirector: release.musicDirector } : {}),
      ...(slide.isMusicDirectorNotable ? { isMusicDirectorNotable: true } : {}),
      ...(release.audioLanguages ? { audioLanguages: release.audioLanguages } : {}),
      // Phase 5.6 enrichment
      ...(release.releaseDates ? { releaseDates: release.releaseDates } : {}),
    };
    const platformStyle = getPlatformStyle(release.platform[0]);
    const density = computeDensity({
      bodyLength: slide.body.length,
      hasLine1: hasMetadataLine1(enrichedRelease),
      hasLine2: hasMetadataLine2(enrichedRelease),
      hasReleased: hasReleasedSection(enrichedRelease),
      hasLanguages: hasLanguagesSection(enrichedRelease),
    });
    const cardCtx: MonMovementCardContext = {
      ...baseCtx,
      title: cleanTitle,
      body: slide.body,
      release: enrichedRelease,
      slotKind,
      slotNumber: i + 1,
      totalSlots: bodySlides.length,
      ...platformStyle,
      density,
      ...buildStampContext(release),
    };
    const cardPath = `${outputDir}/mon-movement-${baseCtx.date}-card-${String(i + 1).padStart(2, "0")}.png`;
    await renderToPNG({
      templateName: "mon-movement-card",
      data: cardCtx as unknown as Record<string, unknown>,
      width: 1080, height: 1080,
      outputPath: cardPath,
    });
    cardPaths.push(cardPath);
  }

  return { coverPath, cardPaths };
}

// Standalone test mode
const isMainModule = import.meta.url.endsWith(
  (process.argv[1] ?? "").replace(/\\/g, "/")
);

if (isMainModule) {
  console.warn(
    "\n╔══════════════════════════════════════════════════════════════════╗\n" +
    "║  ⚠  STANDALONE SMOKE TEST — using hardcoded sample data.         ║\n" +
    "║  This is NOT a production render. For real Notion/TMDb-backed   ║\n" +
    "║  output, run: npm run job:monday                                 ║\n" +
    "╚══════════════════════════════════════════════════════════════════╝\n"
  );
  const sampleDraft: MovementDraft = {
    pillar: "Mon Movement",
    weekLabel: "Week of May 18 — May 24, 2026",
    weekHeadline: "Three Malayalam thrillers landed and not one Hindi drama. Mollywood owns the genre clock.",
    caption: "Mollywood is running the clock this week.",
    hashtags: "#OTTReleases #WeekendWatch #IndianCinema",
    carouselSlides: "(legacy markdown blob)",
    slides: [
      { slideNumber: 1, type: "cover", title: "Three thrillers. One language.", body: "Mollywood owns the genre clock." },
      { slideNumber: 2, type: "headline", title: "This week in OTT", body: "Three Malayalam thrillers, no Hindi drama." },
      { slideNumber: 3, type: "arrival", title: "Pennum Porattum", body: "A grief drama that earns every minute. Mollywood at its quietest and best." },
      { slideNumber: 4, type: "arrival", title: "Bramayugam", body: "Mammootty's black-and-white horror, still the year's most atmospheric watch." },
      { slideNumber: 5, type: "arrival", title: "Sattendru Maarudhu", body: "Tamil thriller — tight 110 minutes with a surprising end." },
      { slideNumber: 6, type: "gem", title: "Hidden Gem: Manjummel Boys", body: "Best survival thriller of 2024 you probably skipped. Now on SonyLIV." },
      { slideNumber: 7, type: "gem", title: "Hidden Gem: Jaane Jaan", body: "Kareena Kapoor in a noir nobody talked about. Worth a Sunday." },
      { slideNumber: 8, type: "cta", title: "Which one are you starting?", body: "Save. DM us. Tag a friend." },
    ],
    newArrivals: [
      {
        id: "arr-1", title: "Pennum Porattum", language: "Malayalam", isSeries: false,
        platform: ["Aha"], releaseDate: "2026-05-20", genre: ["Drama"], runtime: 92,
        director: "Mathew Thomas", cast: ["Parvathy Thiruvothu"],
        leadCast: ["Parvathy Thiruvothu", "Soubin Shahir"],
        audioLanguages: { original: "Malayalam", dubbed: ["Tamil", "Telugu"] },
        releaseDates: { theatrical: "2026-05-10", ott: "2026-05-20" },
        synopsis: "Siblings clean out their late mother's house.",
        // Sample ratings — 4-source stamp (tbsiScore 8.2)
        tbsiScore: 8.2, tbsiSourceCount: 4,
        imdbRating: 8.8, rottenTomatoes: 87, metacritic: 74, letterboxd: 4.2,
        subtitleLanguages: ["English"],
        sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
      {
        id: "arr-2", title: "Bramayugam", language: "Malayalam", isSeries: false,
        platform: ["SonyLIV"], releaseDate: "2024-02-15", genre: ["Horror"], runtime: 138,
        director: "Rahul Sadasivan", cast: ["Mammootty"],
        leadCast: ["Mammootty", "Arjun Ashokan"],
        audioLanguages: { original: "Malayalam", dubbed: ["Hindi", "Tamil", "Telugu"] },
        releaseDates: { theatrical: "2024-02-15", ott: "2024-03-29" },
        synopsis: "17th-century black-and-white horror.",
        posterUrl: "https://image.tmdb.org/t/p/w500/snQLwRrfQAl5YFKVefZq9Lbscki.jpg",
        subtitleLanguages: ["English"],
        sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
      {
        id: "arr-3", title: "Sattendru Maarudhu", language: "Tamil", isSeries: false,
        platform: ["Sun NXT"], releaseDate: "2026-05-22", genre: ["Thriller"], runtime: 110,
        director: "Karthik Subbaraj", cast: ["Vijay Sethupathi"],
        leadCast: ["Vijay Sethupathi", "Aishwarya Rajesh"],
        audioLanguages: { original: "Tamil", dubbed: ["Telugu"] },
        releaseDates: { ott: "2026-05-22" },
        synopsis: "Small-town election thriller.",
        // Sample ratings — 1-source stamp (tbsiScore 6.9, IMDb only)
        tbsiScore: 6.9, tbsiSourceCount: 1, imdbRating: 6.9,
        subtitleLanguages: ["English"],
        sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
    ],
    hiddenGems: [
      {
        id: "gem-1", title: "Manjummel Boys", language: "Malayalam", isSeries: false,
        platform: ["SonyLIV"], releaseDate: "2024-02-22",
        genre: ["Survival", "Thriller"], runtime: 135,
        director: "Chidambaram", cast: ["Soubin Shahir", "Sreenath Bhasi"],
        leadCast: ["Soubin Shahir", "Sreenath Bhasi"],
        audioLanguages: { original: "Malayalam", dubbed: ["Tamil", "Telugu", "Hindi"] },
        releaseDates: { theatrical: "2024-02-22", ott: "2024-04-05" },
        synopsis: "Friends trapped in caves during a Kodaikanal trip.",
        // Sample ratings — 4-source stamp on a GEM card (tbsiScore 8.5)
        tbsiScore: 8.5, tbsiSourceCount: 4,
        imdbRating: 8.4, rottenTomatoes: 90, metacritic: 78, letterboxd: 4.3,
        subtitleLanguages: ["English"],
        sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
      {
        id: "gem-2", title: "Jaane Jaan", language: "Hindi", isSeries: false,
        platform: ["Netflix"], releaseDate: "2023-09-21",
        genre: ["Mystery", "Thriller"], runtime: 130,
        director: "Sujoy Ghosh", cast: ["Kareena Kapoor", "Jaideep Ahlawat"],
        leadCast: ["Kareena Kapoor", "Jaideep Ahlawat"],
        audioLanguages: { original: "Hindi" },
        releaseDates: { ott: "2023-09-21" },
        synopsis: "A single mother in Kalimpong is drawn into a murder investigation.",
        subtitleLanguages: ["English"],
        sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
    ],
  };

  try {
    const { getIssueNumberForToday } = await import("../shared/issue-number.js");
    const result = await renderMonMovement(sampleDraft, getIssueNumberForToday());
    log.success(`\n✓ Render complete:`);
    log.success(`   Cover : ${result.coverPath}`);
    log.success(`   Cards : ${result.cardPaths.length}`);
    for (const p of result.cardPaths) log.info(`           ${p}`);
  } catch (err) {
    log.error("Render failed", err);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}
