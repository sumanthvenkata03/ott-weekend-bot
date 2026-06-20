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
import {
  getPlatformStyle,
  computeDensity,
  hasMetadataLine1,
  hasMetadataLine2,
  hasReleasedSection,
  hasLanguagesSection,
  buildStampContext,
} from "./_shared.js";
// HEAT axis (🔥) — DISPLAY-ONLY, computed in isolation from the verdict pipeline.
// Reads only the release's popularity signals; cannot touch ★/verdict/seal.
import { computeHeat } from "../content/weekend/heat.js";

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
    ...(release?.posterUrl ? { posterUrl: release.posterUrl } : {}),
    fallbackColor: LANGUAGE_FALLBACK_COLORS[slide.language] ?? "#1A1614",
    ...(release?.runtime ? { runtime: release.runtime } : {}),
    ...(release?.director ? { director: release.director } : {}),
    cast: release?.cast ?? [],
    // Phase 5.5 enrichment
    ...(release?.leadCast && release.leadCast.length > 0 ? { leadCast: release.leadCast } : {}),
    ...(release?.musicDirector ? { musicDirector: release.musicDirector } : {}),
    ...(slide.isMusicDirectorNotable ? { isMusicDirectorNotable: true } : {}),
    ...(release?.audioLanguages ? { audioLanguages: release.audioLanguages } : {}),
    // Phase 5.6 enrichment
    ...(release?.releaseDates ? { releaseDates: release.releaseDates } : {}),
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
  outputDir = "output/posts",
  alsoSkipping: string[] = []
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
  // ALSO SKIPPING footer: show at most ALSO_SKIPPING_MAX_NAMES titles, then a
  // "+N MORE" tail, so a long trimmed-skip list can't overrun the single line.
  const ALSO_SKIPPING_MAX_NAMES = 4;
  const alsoSkippingNames = alsoSkipping.slice(0, ALSO_SKIPPING_MAX_NAMES);
  const alsoSkippingMore = Math.max(0, alsoSkipping.length - ALSO_SKIPPING_MAX_NAMES);
  const coverCtx: SatVerdictCoverContext = {
    ...baseCtx,
    hotTake: draft.hotTake,
    filmCount: cards.length,
    weekendDates: draft.weekendDates,
    hero,
    posterStrip,
    alsoSkipping: alsoSkippingNames,
    alsoSkippingMore,
  };
  await renderToPNG({
    templateName: "sat-verdict-cover",
    data: coverCtx as unknown as Record<string, unknown>,
    // 1:1 square to match the 1080x1080 body cards — a mixed-ratio carousel makes
    // Instagram crop the odd slide out (the 4:5 cover lost its masthead + footer).
    width: 1080, height: 1080,
    outputPath: coverPath,
  });

  // 2. Body cards
  const cardPaths: string[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    const platformStyle = getPlatformStyle(card.platform[0]);
    // Sat Verdict variant-specific fix: must-watch and worth-a-try cards use a
    // brass body background. When a card has no platform, getPlatformStyle's
    // fallback (brass) goes invisible against the brass bg. Force cream so the
    // "STREAMING TBA" platform line stays readable on those variants.
    if (card.platform.length === 0 && card.verdictKind !== "skip") {
      platformStyle.platformColor = "var(--cream)";
    }
    // Sat Verdict body length combines the one-line verdict with the watchIf rationale —
    // those are what visually fill the right-hand text column.
    const bodyLength = card.oneLineVerdict.length + card.watchIf.length;
    const density = computeDensity({
      bodyLength,
      hasLine1: hasMetadataLine1(card),
      hasLine2: hasMetadataLine2(card),
      hasReleased: hasReleasedSection(card),
      hasLanguages: hasLanguagesSection(card),
    });
    // Seal state. Phase 1: when the slide carries grounded research (job path),
    // the seal is DRIVEN by it — ★/5 prominent, IMDb/critics secondary, "EARLY"
    // for a low-confidence read, "NO SCORE YET" when nothing was found. Without
    // research (sample/render path) it falls back to the release's aggregator
    // rating. "NO SCORE YET" (not "NO VERDICT YET") because the card carries a
    // verdict stamp — the missing thing is the audience score, not the verdict.
    const release = draft.releases.find(r => r.title === card.filmTitle);
    const research = draft.verdicts[i]?.research;
    const stamp = buildStampContext(release, {
      scoreAbsenceLabel: "NO SCORE YET",
      ...(research ? {
        research: {
          tbsiScore: research.tbsiScore,
          star: research.star,
          confidence: research.confidence,
          audienceImdb: research.audienceScore,
          // Badge shows the CREDIBLE critic count (Tier A/B w/ a published score),
          // not every found rating — matches the count that gates the evidence cap.
          criticCount: research.credibleCriticCount,
        },
      } : {}),
    });
    const hasSeal = stamp.stampKind === "tbsi" || stamp.stampKind === "tmdb";
    // HEAT (🔥) — separate, display-only. Derived from the release's popularity
    // signals ONLY; null (→ no sticker) when there's no signal. Independent of the
    // seal/verdict above — it is never read by, and never feeds, the verdict.
    const heat = release ? computeHeat(release) : null;
    const cardCtx: SatVerdictCardContext = {
      ...baseCtx,
      card,
      slotNumber: i + 1,
      ...platformStyle,
      density,
      totalSlots: cards.length,
      hasSeal,
      ...stamp,
      ...(heat ? { heat } : {}),
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
    // Verification-only: a Wed→Fri (3-day) range so the cover footer crop shows
    // the narrowed window. In the live job this string is window-derived.
    weekendDates: "Jun 17 — Jun 19, 2026",
    caption: "Three verdicts, three different calls.",
    hashtags: "#OTTReleases #Malayalam #WeekendWatch",
    hotTake: "A quiet Malayalam grief drama says more in 90 minutes than three loud Hindi releases manage all week.",
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
        // Verification-only sample research: grounded HIGH-confidence read so the
        // seal renders ★4.3/5 + IMDb/critics. (Values match computeVerdictScore
        // on these ratings; the live job computes them for real.)
        research: {
          found: true,
          criticRatings: [
            { source: "The Hindu", url: "https://www.thehindu.com/reviews/pennum-porattum", explicitScore: 4.5, sentimentScore: 4.5 },
            { source: "Film Companion", url: "https://www.filmcompanion.in/reviews/pennum-porattum", explicitScore: 4, sentimentScore: 4 },
            { source: "123telugu", url: "https://www.123telugu.com/reviews/pennum-porattum", explicitScore: 4, sentimentScore: 4 },
          ],
          credibleCriticCount: 3,
          audienceScore: 8.8,
          buzzNote: "strong festival word-of-mouth",
          tbsiScore: 8.6,
          star: 4.3,
          verdict: "Must Watch",
          confidence: "high",
          summaryLine: "Watch the Malayalam grief drama instead.",
          theRead: "Critics single out the sibling dynamic and a devastating second act; the slow open is the one knock.",
          watchIf: "Watch if you liked Joji or The Great Indian Kitchen.",
          sources: ["The Hindu", "Film Companion"],
        },
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
        // Verification-only sample research: LOW-confidence (a single credible
        // critic) → seal labels it "EARLY" with the ★ still shown. The single
        // critic also trips the evidence cap, so the star can't reach Must Watch.
        research: {
          found: true,
          criticRatings: [
            { source: "Cinema Express", url: "https://www.cinemaexpress.com/reviews/bramayugam", explicitScore: 3, sentimentScore: 3 },
          ],
          credibleCriticCount: 1,
          audienceScore: 7,
          buzzNote: "",
          tbsiScore: 6.4,
          star: 3.2,
          verdict: "Worth a Try",
          confidence: "low",
          summaryLine: "Atmospheric black-and-white horror, rough finish.",
          theRead: "Early read: praised for mood and the lead turn, but only one review is in so far.",
          watchIf: "Watch if you liked The Lighthouse or slow folk-horror.",
          sources: ["Letterboxd"],
        },
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
        // Verification-only sample research: found:false → confidence 'none' →
        // the seal renders the "NO SCORE YET" state (no fabricated number). In
        // the live job a found:false film isn't carded (it goes to ALSO
        // SKIPPING); shown here only to exercise the no-score seal.
        research: {
          found: false,
          criticRatings: [],
          credibleCriticCount: 0,
          audienceScore: null,
          buzzNote: "",
          tbsiScore: null,
          star: null,
          verdict: null,
          confidence: "none",
          summaryLine: "",
          theRead: "",
          watchIf: "",
          sources: [],
        },
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
        // Verification-only: a real poster on the hero so the cover render shows
        // an actual image (not the no-poster fallback) — lets us check the
        // masthead scrim + chevron clearance over real poster art. (Reuses the
        // known-good Bramayugam TMDb URL; the live job uses each film's own.)
        posterUrl: "https://image.tmdb.org/t/p/w500/snQLwRrfQAl5YFKVefZq9Lbscki.jpg",
        // Sample ratings — 4-source stamp (tbsiScore 8.2)
        tbsiScore: 8.2, tbsiSourceCount: 4,
        imdbRating: 8.8, rottenTomatoes: 87, metacritic: 74, letterboxd: 4.2,
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
        // Sample ratings — 3-source stamp (tbsiScore 7.4, no Letterboxd)
        tbsiScore: 7.4, tbsiSourceCount: 3,
        imdbRating: 7.0, rottenTomatoes: 88, metacritic: 72,
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
        
        subtitleLanguages: ["English"],
        sources: ["TMDb"],
        fetchedAt: new Date().toISOString(),
      },
    ],
  };

  try {
    // Sample trimmed-skips (6 names) so the render exercises the cover's
    // "ALSO SKIPPING" overflow — shows 4 names then "+2 MORE". The live job
    // feeds the real trimmed list from selectVerdictCards. The unrated
    // "NO SCORE YET" seal is already exercised by card 3 (Pati Patni — no
    // ratings, older release → UNRATED).
    const result = await renderSatVerdict(sampleDraft, 42, "output/posts", [
      "Deewana", "Sitting", "Dark Giant", "Loafer Returns", "Nayagan 2", "Quick Cut",
    ]);
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