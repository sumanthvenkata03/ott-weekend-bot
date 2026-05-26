// src/rendering/render-sat-verdict.ts
// Orchestrator: SaturdayVerdictDraft → 1 cover PNG + N body card PNGs

import { promises as fs } from "node:fs";
import { renderToPNG, closeBrowser } from "./renderer.js";
import { format } from "date-fns";
import { log } from "../shared/logger.js";
import type { SaturdayVerdictDraft } from "../delivery/notion.js";
import type { Release, Verdict } from "../shared/types.js";
import type {
  SatVerdictCard,
  SatVerdictCoverContext,
  SatVerdictCardContext,
} from "./types.js";

/**
 * Delete any stale sat-verdict PNGs for this date before re-rendering, so a
 * previous run's orphan cards (e.g. card-04 left over when this run only
 * produces 3) don't get uploaded next time someone runs `npm run thumbnails`.
 */
async function cleanOldRenders(outputDir: string, datePrefix: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return; // dir doesn't exist yet — nothing to clean
  }
  const prefix = `sat-verdict-${datePrefix}-`;
  const stale = entries.filter(e => e.startsWith(prefix) && e.endsWith(".png"));
  await Promise.all(stale.map(e => fs.unlink(`${outputDir}/${e}`)));
  if (stale.length > 0) log.info(`  Cleaned ${stale.length} stale Sat Verdict PNG(s)`);
}

/** Per-language fallback color when TMDb has no poster */
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

function verdictKind(v: Verdict): "must-watch" | "worth-a-try" | "skip" {
  if (v.includes("Must Watch")) return "must-watch";
  if (v.includes("Worth a Try")) return "worth-a-try";
  return "skip";
}

function platformLogoStem(p: string): string {
  return p
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/\+/g, "-plus")
    .replace(/\./g, "")
    .replace(/jio-?hotstar/g, "jiohotstar");
}

function buildCard(
  slide: SaturdayVerdictDraft["verdicts"][number],
  release: Release | undefined
): SatVerdictCard {
  return {
    filmTitle: slide.filmTitle,
    language: slide.language,
    platform: slide.platform,
    platformLogos: slide.platform.map(platformLogoStem),
    verdict: slide.verdict,
    verdictKind: verdictKind(slide.verdict),
    oneLineVerdict: slide.oneLineVerdict,
    watchIf: slide.watchIf,
    posterUrl: release?.posterUrl,
    fallbackColor: LANGUAGE_FALLBACK_COLORS[slide.language] ?? "#1A1614",
    runtime: release?.runtime,
    director: release?.director,
    cast: release?.cast ?? [],
  };
}

function pickHero(cards: SatVerdictCard[]): SatVerdictCard {
  return cards.find(c => c.verdictKind === "must-watch") ?? cards[0];
}

export interface RenderResult {
  coverPath: string;
  cardPaths: string[];
}

export async function renderSatVerdict(
  draft: SaturdayVerdictDraft,
  issueNumber: string | number,
  outputDir = "output/posts"
): Promise<RenderResult> {
  log.info(`Rendering Sat Verdict — Issue №${issueNumber}`);

  const cards = draft.verdicts.map(slide => {
    const release = draft.releases.find(r => r.title === slide.filmTitle);
    return buildCard(slide, release);
  });
  const hero = pickHero(cards);

  log.info(`  Cards: ${cards.length}  |  Hero: ${hero.filmTitle} (${hero.verdict})`);

  const today = new Date();
  const baseCtx = {
    vol: "01",
    issue: String(issueNumber).padStart(3, "0"),
    date: format(today, "yyyy-MM-dd"),
    displayDate: format(today, "dd·MM·yy"),
    pillarLabel: "SAT VERDICT" as const,
  };

  await cleanOldRenders(outputDir, baseCtx.date);

  // 1. Cover slide
  const coverPath = `${outputDir}/sat-verdict-${baseCtx.date}-cover.png`;
  const posterStrip = cards.slice(0, 3).map(c => ({
    posterUrl: c.posterUrl,
    posterFallbackColor: c.fallbackColor,
    filmTitle: c.filmTitle,
    language: c.language,
  }));
  const coverCtx: SatVerdictCoverContext = {
    ...baseCtx,
    hotTake: draft.hotTake,
    filmCount: cards.length,
    weekendDates: draft.weekendDates,
    hero,
    posterStrip,
  };
  await renderToPNG({
    templateName: "sat-verdict-cover",
    data: coverCtx as unknown as Record<string, unknown>,
    width: 1080, height: 1350,
    outputPath: coverPath,
  });

  // 2. Body cards
  const cardPaths: string[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const cardCtx: SatVerdictCardContext = {
      ...baseCtx,
      card,
      slotNumber: i + 1,
      totalSlots: cards.length,
    };
    const cardPath = `${outputDir}/sat-verdict-${baseCtx.date}-card-${String(i + 1).padStart(2, "0")}.png`;
    await renderToPNG({
      templateName: "sat-verdict-card",
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
  const sampleDraft: SaturdayVerdictDraft = {
    pillar: "Sat Verdict",
    weekendDates: "May 16 — May 18, 2026",
    caption: "Three verdicts, three different calls.",
    hashtags: "#OTTReleases #Malayalam #WeekendWatch",
    hotTake: "A quiet Malayalam film about siblings cleaning out their dead mother's house has more to say in 90 minutes than three Hindi releases combined this weekend.",
    verdicts: [
      {
        filmTitle: "Pennum Porattum",
        language: "Malayalam",
        platform: ["Aha"],
        verdict: "🔥 Must Watch",
        oneLineVerdict: "Watch the Malayalam grief drama instead.",
        watchIf: "Watch if you liked Joji or The Great Indian Kitchen — slow-burn family drama with real teeth.",
        skipIf: "Skip if you want loud emotional payoff.",
        whereItWins: "The sibling dynamic in the second act.",
        whereItLoses: "The first 20 minutes are slow.",
        watchSetup: "Saturday afternoon, full attention.",
      },
      {
        filmTitle: "Bramayugam",
        language: "Malayalam",
        platform: ["SonyLIV"],
        verdict: "👀 Worth a Try",
        oneLineVerdict: "Atmospheric black-and-white horror, rough finish.",
        watchIf: "Watch if you liked The Lighthouse or any slow folk-horror.",
        skipIf: "Skip if pacing under 90 mins matters to you.",
        whereItWins: "Mammootty's central performance and the production design.",
        whereItLoses: "Last act doesn't land its mythology.",
        watchSetup: "Night, headphones on.",
      },
      {
        filmTitle: "Pati Patni Aur Woh Do",
        language: "Hindi",
        platform: ["JioHotstar"],
        verdict: "⏭️ Skip",
        oneLineVerdict: "Tired franchise extension with nothing to add.",
        watchIf: "Watch if you actively enjoy formulaic Hindi rom-coms.",
        skipIf: "Skip if you've seen the first two — same beats, less wit.",
        whereItWins: "Tabu is still doing real work even here.",
        whereItLoses: "Script, pacing, third act, entire premise.",
        watchSetup: "Don't.",
      },
    ],
    releases: [
      {
        id: "sample-1",
        title: "Pennum Porattum",
        language: "Malayalam",
        isSeries: false,
        platform: ["Aha"],
        releaseDate: "2026-05-16",
        genre: ["Drama"],
        runtime: 92,
        director: "Mathew Thomas",
        cast: ["Parvathy Thiruvothu", "Tovino Thomas"],
        synopsis: "Two siblings return home to clean out their late mother's house.",
        posterUrl: undefined,
        audioLanguages: ["Malayalam"],
        subtitleLanguages: ["English"],
        sources: ["TMDb"],
        fetchedAt: new Date().toISOString(),
      },
      {
        id: "sample-2",
        title: "Bramayugam",
        language: "Malayalam",
        isSeries: false,
        platform: ["SonyLIV"],
        releaseDate: "2024-02-15",
        genre: ["Horror"],
        runtime: 138,
        director: "Rahul Sadasivan",
        cast: ["Mammootty", "Arjun Ashokan", "Sidharth Bharathan"],
        synopsis: "A 17th-century horror set in a forsaken mansion.",
        // Real verified TMDb poster URL — tests CDN fetch end-to-end
        posterUrl: "https://image.tmdb.org/t/p/w500/snQLwRrfQAl5YFKVefZq9Lbscki.jpg",
        audioLanguages: ["Malayalam"],
        subtitleLanguages: ["English"],
        sources: ["TMDb"],
        fetchedAt: new Date().toISOString(),
      },
      {
        id: "sample-3",
        title: "Pati Patni Aur Woh Do",
        language: "Hindi",
        isSeries: false,
        platform: ["JioHotstar"],
        releaseDate: "2026-05-16",
        genre: ["Romance", "Comedy"],
        runtime: 142,
        director: "Mudassar Aziz",
        cast: ["Ayushmann Khurrana", "Tabu", "Wamiqa Gabbi"],
        synopsis: "The third installment of a franchise nobody asked for.",
        posterUrl: undefined,
        audioLanguages: ["Hindi"],
        subtitleLanguages: ["English"],
        sources: ["TMDb"],
        fetchedAt: new Date().toISOString(),
      },
    ],
  };

  try {
    const result = await renderSatVerdict(sampleDraft, 42);
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