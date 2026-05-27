// src/rendering/render-wed-drop.ts
// Orchestrator: WednesdayDropDraft → 1 cover PNG + N body card PNGs

import { promises as fs } from "node:fs";
import { renderToPNG, closeBrowser } from "./renderer.js";
import { format } from "date-fns";
import { log } from "../shared/logger.js";
import type { WednesdayDropDraft, WedDropSlide } from "../delivery/notion.js";
import type { Release } from "../shared/types.js";
import type {
  WedDropCoverContext,
  WedDropCardContext,
  WedDropGridItem,
} from "./types.js";
import {
  getPlatformStyle,
  computeDensity,
  hasMetadataLine1,
  hasMetadataLine2,
  hasReleasedSection,
  hasLanguagesSection,
} from "./_shared.js";

/**
 * Delete any stale wed-drop PNGs for this date before re-rendering, so an
 * earlier run's orphan cards don't get picked up by `npm run thumbnails`
 * or shipped to R2 on a subsequent invocation.
 */
async function cleanOldRenders(outputDir: string, datePrefix: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return;
  }
  const prefix = `wed-drop-${datePrefix}-`;
  const stale = entries.filter(e => e.startsWith(prefix) && e.endsWith(".png"));
  await Promise.all(stale.map(e => fs.unlink(`${outputDir}/${e}`)));
  if (stale.length > 0) log.info(`  Cleaned ${stale.length} stale Wed Drop PNG(s)`);
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

function buildGridItem(r: Release): WedDropGridItem {
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
  };
}

export interface RenderResult {
  coverPath: string;
  cardPaths: string[];
}

export async function renderWedDrop(
  draft: WednesdayDropDraft,
  issueNumber: string | number,
  outputDir = "output/posts"
): Promise<RenderResult> {
  log.info(`Rendering Wed Drop — Issue №${issueNumber}`);

  // The LLM outputs slides typed cover / index / release / cta.
  // For rendering we care about: cover (slide 1) → headline, release slides → body cards.
  const coverSlide = draft.slides.find(s => s.type === "cover");
  const releaseSlides = draft.slides.filter(s => s.type === "release");

  log.info(`  Films: ${draft.releases.length} | Release slides: ${releaseSlides.length}`);

  const today = new Date();
  const baseCtx = {
    vol: "01",
    issue: String(issueNumber).padStart(3, "0"),
    date: format(today, "yyyy-MM-dd"),
    displayDate: format(today, "dd·MM·yy"),
    pillarLabel: "WED DROP" as const,
  };

  await cleanOldRenders(outputDir, baseCtx.date);

  // 1. Cover: shows up to 4 films in a 2x2 grid + the LLM's cover headline
  const gridItems = draft.releases.slice(0, 4).map(buildGridItem);
  const coverPath = `${outputDir}/wed-drop-${baseCtx.date}-cover.png`;
  const coverCtx: WedDropCoverContext = {
    ...baseCtx,
    weekendDates: draft.weekendDates,
    filmCount: draft.releases.length,
    coverHeadline: coverSlide?.title ?? `${draft.releases.length} films.`,
    coverSubtext: coverSlide?.body ?? "Your weekend, sorted.",
    gridItems,
  };
  await renderToPNG({
    templateName: "wed-drop-cover",
    data: coverCtx as unknown as Record<string, unknown>,
    width: 1080, height: 1350,
    outputPath: coverPath,
  });

  // 2. Body cards: one per LLM release slide
  const cardPaths: string[] = [];
  for (let i = 0; i < releaseSlides.length; i++) {
    const slide = releaseSlides[i];
    // Find the Release object whose title matches the slide title
    const release = draft.releases.find(r => r.title === slide.title);
    if (!release) {
      log.warn(`  ⚠ No Release for slide "${slide.title}" — skipping`);
      continue;
    }
    const enrichedRelease = {
      ...buildGridItem(release),
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
    const cardCtx: WedDropCardContext = {
      ...baseCtx,
      title: slide.title,
      body: slide.body,
      release: enrichedRelease,
      slotNumber: i + 1,
      totalSlots: releaseSlides.length,
      ...platformStyle,
      density,
    };
    const cardPath = `${outputDir}/wed-drop-${baseCtx.date}-card-${String(i + 1).padStart(2, "0")}.png`;
    await renderToPNG({
      templateName: "wed-drop-card",
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
  const sampleDraft: WednesdayDropDraft = {
    pillar: "Wed Drop",
    weekendDates: "May 16 — May 18, 2026",
    caption: "Eight films. Five languages. Skip the Hindi blockbuster, watch the Malayalam grief drama.",
    hashtags: "#OTTReleases #WeekendWatch",
    carouselSlides: "(legacy markdown blob)",
    slides: [
      { slideNumber: 1, type: "cover", title: "8 films. 5 languages.", body: "Your weekend, sorted." },
      { slideNumber: 2, type: "index", title: "This weekend", body: "Pennum Porattum (Mal) · Bramayugam (Mal) · Pati Patni 2 (Hin) · Sattendru (Tam)" },
      { slideNumber: 3, type: "release", title: "Pennum Porattum", body: "A quiet grief drama that earns every minute. The kind of film Mollywood does better than anyone right now." },
      { slideNumber: 4, type: "release", title: "Bramayugam", body: "Mammootty's black-and-white horror is still the year's most atmospheric watch. Worth revisiting if you missed it." },
      { slideNumber: 5, type: "release", title: "Pati Patni Aur Woh Do", body: "Third installment of a franchise nobody asked for. Tabu deserves better than this." },
      { slideNumber: 6, type: "release", title: "Sattendru Maarudhu", body: "Tamil thriller about a small-town election going sideways. Tight 110 minutes, surprising end." },
      { slideNumber: 7, type: "cta", title: "Which one are you starting?", body: "DM us. Save this. Tag a friend who needs the verdict." },
    ],
    releases: [
      {
        id: "sample-1", title: "Pennum Porattum", language: "Malayalam", isSeries: false,
        platform: ["Aha"], releaseDate: "2026-05-16", genre: ["Drama"], runtime: 92,
        director: "Mathew Thomas", cast: ["Parvathy Thiruvothu"], synopsis: "Siblings clean out their late mother's house.",
        subtitleLanguages: ["English"], sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
      {
        id: "sample-2", title: "Bramayugam", language: "Malayalam", isSeries: false,
        platform: ["SonyLIV"], releaseDate: "2024-02-15", genre: ["Horror"], runtime: 138,
        director: "Rahul Sadasivan", cast: ["Mammootty"], synopsis: "17th-century horror.",
        posterUrl: "https://image.tmdb.org/t/p/w500/snQLwRrfQAl5YFKVefZq9Lbscki.jpg",
        subtitleLanguages: ["English"], sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
      {
        id: "sample-3", title: "Pati Patni Aur Woh Do", language: "Hindi", isSeries: false,
        platform: ["JioHotstar"], releaseDate: "2026-05-16", genre: ["Romance"], runtime: 142,
        director: "Mudassar Aziz", cast: ["Ayushmann Khurrana", "Tabu"], synopsis: "Third installment.",
        subtitleLanguages: ["English"], sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
      {
        id: "sample-4", title: "Sattendru Maarudhu", language: "Tamil", isSeries: false,
        platform: ["Sun NXT"], releaseDate: "2026-05-17", genre: ["Thriller"], runtime: 110,
        director: "Karthik Subbaraj", cast: ["Vijay Sethupathi"], synopsis: "Small-town election thriller.",
        subtitleLanguages: ["English"], sources: ["TMDb"], fetchedAt: new Date().toISOString(),
      },
    ],
  };

  try {
    const result = await renderWedDrop(sampleDraft, 43);
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