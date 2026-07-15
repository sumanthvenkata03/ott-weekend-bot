// src/rendering/render-archives.ts
// Orchestrator: an Archives deck → 1 square cover PNG + N square card PNGs.
// Design family is Wednesday's (cream / ink / vermillion / brass). No verdict,
// no heat chip, no critic research — Archives sells an OLDER film that is highly
// rated and streaming TONIGHT, sealed on its IMDb rating + printed vote count.

import { promises as fs } from "node:fs";
import { renderToPNG } from "./renderer.js";
import { editorialTodayStamp, editorialDisplayDate } from "../shared/editorial-clock.js";
import { log } from "../shared/logger.js";
import type { Release } from "../shared/types.js";
import type { ArchivesKind } from "../content/archives/archives-ledger.js";
import { formatVolume } from "../content/archives/archives-ledger.js";
import { getPlatformStyle } from "./_shared.js";

/** File slug — matches the deck-zip slug so delivery finds these PNGs. */
export const ARCHIVES_SLUG = "tbsi-archives";

export interface ArchivesRenderCard {
  release: Release;
  kind: ArchivesKind;
  primaryGenre?: string;
  whyLine: string;
}

export interface ArchivesDeck {
  cards: ArchivesRenderCard[];
  vol: number;
}

export interface ArchivesRenderResult {
  coverPath: string;
  cardPaths: string[];
}

/** Per-language fallback color when TMDb has no poster (shared with Sat Verdict). */
const LANGUAGE_FALLBACK_COLORS: Record<string, string> = {
  Hindi: "#A33223",
  Malayalam: "#2E5742",
  Telugu: "#C49A3F",
  Tamil: "#1A1614",
  Kannada: "#A33223",
  Marathi: "#2E5742",
  Bengali: "#C49A3F",
  Punjabi: "#A33223",
  Other: "#1A1614",
};

function platformLogoStem(p: string): string {
  return p
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/\+/g, "-plus")
    .replace(/\./g, "")
    .replace(/jio-?hotstar/g, "jiohotstar");
}

function yearOf(r: Release): string {
  return r.releaseDate?.slice(0, 4) || "";
}

/** Kicker: "COMEDY · TAMIL · 2021" — genre FIRST, then language, then year. */
function kickerFor(card: ArchivesRenderCard): string {
  const genre = (card.primaryGenre ?? card.release.genre[0] ?? "").toUpperCase();
  const parts = [genre, card.release.language.toUpperCase(), yearOf(card.release)].filter(Boolean);
  return parts.join(" · ");
}

/** "24,312 votes" (thousands-grouped) or "" when the count is unknown. */
function votesLine(r: Release): string {
  return typeof r.imdbVotes === "number" ? `${r.imdbVotes.toLocaleString("en-US")} votes` : "";
}

/** Delete stale Archives PNGs for this date so an old longer deck can't leak. */
async function cleanOldRenders(outputDir: string, datePrefix: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return;
  }
  const prefix = `${ARCHIVES_SLUG}-${datePrefix}-`;
  const stale = entries.filter((e) => e.startsWith(prefix) && e.endsWith(".png"));
  await Promise.all(stale.map((e) => fs.unlink(`${outputDir}/${e}`)));
  if (stale.length > 0) log.info(`  Cleaned ${stale.length} stale Archives PNG(s)`);
}

interface CardContext {
  vol: string;
  issueDate: string;
  checkedDate: string;
  slotNumber: number;
  totalSlots: number;
  isTreasure: boolean;
  kicker: string;
  title: string;
  whyLine: string;
  imdbRating: string;
  votesLine: string;
  platform?: string;
  platformLogo?: string;
  platformColor: string;
  platformIsGradient: boolean;
  posterUrl?: string;
  fallbackColor: string;
  language: string;
}

function buildCardContext(
  card: ArchivesRenderCard,
  i: number,
  total: number,
  vol: number,
  displayDate: string
): CardContext {
  const r = card.release;
  const style = getPlatformStyle(r.platform[0]);
  const platform = r.platform[0];
  return {
    vol: formatVolume(vol),
    issueDate: displayDate,
    checkedDate: displayDate,
    slotNumber: i + 1,
    totalSlots: total,
    isTreasure: card.kind === "treasure",
    kicker: kickerFor(card),
    title: r.title,
    whyLine: card.whyLine,
    imdbRating: typeof r.imdbRating === "number" ? r.imdbRating.toFixed(1) : "—",
    votesLine: votesLine(r),
    ...(platform ? { platform: platform.toUpperCase() } : {}),
    ...(platform ? { platformLogo: platformLogoStem(platform) } : {}),
    platformColor: style.platformColor,
    platformIsGradient: style.platformIsGradient,
    ...(r.posterUrl ? { posterUrl: r.posterUrl } : {}),
    fallbackColor: LANGUAGE_FALLBACK_COLORS[r.language] ?? "#1A1614",
    language: r.language,
  };
}

export async function renderArchives(
  deck: ArchivesDeck,
  outputDir = "output/posts"
): Promise<ArchivesRenderResult> {
  const now = new Date();
  const date = editorialTodayStamp(now);
  const displayDate = editorialDisplayDate(now);
  log.info(`Rendering TBSI Archives — VOL. ${formatVolume(deck.vol)} (${deck.cards.length} cards)`);

  await cleanOldRenders(outputDir, date);

  // Distinct-genre count for the cover line.
  const genres = new Set(deck.cards.map((c) => (c.primaryGenre ?? c.release.genre[0] ?? "").toLowerCase()));
  const coverCtx = {
    vol: formatVolume(deck.vol),
    issueDate: displayDate,
    filmCount: deck.cards.length,
    genreCount: genres.size,
    tiles: deck.cards.map((c) => ({
      ...(c.release.posterUrl ? { posterUrl: c.release.posterUrl } : {}),
      fallbackColor: LANGUAGE_FALLBACK_COLORS[c.release.language] ?? "#1A1614",
      language: c.release.language.toUpperCase(),
      title: c.release.title,
    })),
  };

  const coverPath = `${outputDir}/${ARCHIVES_SLUG}-${date}-cover.png`;
  await renderToPNG({
    templateName: "archives-cover",
    data: coverCtx as unknown as Record<string, unknown>,
    width: 1080,
    height: 1080,
    outputPath: coverPath,
  });

  const cardPaths: string[] = [];
  for (let i = 0; i < deck.cards.length; i++) {
    const ctx = buildCardContext(deck.cards[i]!, i, deck.cards.length, deck.vol, displayDate);
    const cardPath = `${outputDir}/${ARCHIVES_SLUG}-${date}-card-${String(i + 1).padStart(2, "0")}.png`;
    await renderToPNG({
      templateName: "archives-card",
      data: ctx as unknown as Record<string, unknown>,
      width: 1080,
      height: 1080,
      deviceScaleFactor: 3,
      outputPath: cardPath,
    });
    cardPaths.push(cardPath);
  }

  return { coverPath, cardPaths };
}

// ── Standalone sample render (npm run render:archives) — NO API, sample data ──
const isMainModule = import.meta.url.endsWith((process.argv[1] ?? "").replace(/\\/g, "/"));

if (isMainModule) {
  const { closeBrowser } = await import("./renderer.js");
  const sample: ArchivesDeck = {
    vol: 1,
    cards: [
      {
        kind: "pick",
        primaryGenre: "Comedy",
        whyLine: "A featherlight farce that has quietly become the group-chat comfort rewatch.",
        release: {
          id: "s1", tmdbId: 1, title: "Aa Okkati Adakku", language: "Telugu", isSeries: false,
          platform: ["Aha"], releaseDate: "2020-05-10", genre: ["Comedy", "Romance"],
          cast: [], synopsis: "", subtitleLanguages: [], sources: ["sample"], fetchedAt: "",
          imdbRating: 8.1, imdbVotes: 24312,
          posterUrl: "https://image.tmdb.org/t/p/w500/snQLwRrfQAl5YFKVefZq9Lbscki.jpg",
        },
      },
      {
        kind: "pick",
        primaryGenre: "Thriller",
        whyLine: "Ninety minutes of clockwork tension that still has no wasted frame.",
        release: {
          id: "s2", tmdbId: 2, title: "Ratsasan", language: "Tamil", isSeries: false,
          platform: ["Netflix"], releaseDate: "2018-10-05", genre: ["Thriller", "Crime"],
          cast: [], synopsis: "", subtitleLanguages: [], sources: ["sample"], fetchedAt: "",
          imdbRating: 8.4, imdbVotes: 41208,
        },
      },
      {
        kind: "treasure",
        primaryGenre: "Drama",
        whyLine: "A box-office miss in 2016 that the internet has since crowned a modern classic.",
        release: {
          id: "s3", tmdbId: 3, title: "Kammatipaadam", language: "Malayalam", isSeries: false,
          platform: ["SonyLIV"], releaseDate: "2016-05-20", genre: ["Drama", "Crime"],
          cast: [], synopsis: "", subtitleLanguages: [], sources: ["sample"], fetchedAt: "",
          imdbRating: 8.2, imdbVotes: 15903,
          posterUrl: "https://image.tmdb.org/t/p/w500/snQLwRrfQAl5YFKVefZq9Lbscki.jpg",
        },
      },
    ],
  };
  try {
    const result = await renderArchives(sample, "output/review/archives");
    log.success(`\n✓ Archives render complete:`);
    log.success(`   Cover : ${result.coverPath}`);
    for (const p of result.cardPaths) log.info(`           ${p}`);
  } catch (err) {
    log.error("Archives render failed", err);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}
