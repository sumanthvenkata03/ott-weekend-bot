// src/rendering/render-archives.ts
// Orchestrator: an Archives deck → 1 square cover PNG + N square card PNGs.
// Full-bleed poster family (Evergreens v2). No verdict, no heat chip, no critic
// research — Archives sells an OLDER film, sealed on the TBSI consolidated rating
// (the existing tbsiScore blend, recomputed at render so seal == receipts) with
// its blend-input receipts + printed vote count.

import { promises as fs } from "node:fs";
import sharp from "sharp";
import { ofetch } from "ofetch";
import { renderToPNG } from "./renderer.js";
import { editorialTodayStamp, editorialCoverDate } from "../shared/editorial-clock.js";
import { log } from "../shared/logger.js";
import type { Release } from "../shared/types.js";
import type { ArchivesKind } from "../content/archives/archives-ledger.js";
import { formatVolume } from "../content/archives/archives-ledger.js";
import { computeTbsiScore } from "../ingestion/ratings/mdblist.js";
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

/** The TBSI consolidated score for the seal — the EXISTING blend, recomputed at
 *  render from the release's raw ratings so the seal number and its receipts can
 *  never diverge. `"—"` only if not one blended source exists (gate makes that
 *  impossible in production). */
function sealScore(r: Release): string {
  const { tbsiScore } = computeTbsiScore({
    imdbRating: r.imdbRating,
    rottenTomatoes: r.rottenTomatoes,
    metacritic: r.metacritic,
    letterboxd: r.letterboxd,
  });
  return typeof tbsiScore === "number" ? tbsiScore.toFixed(1) : "—";
}

/** Seal receipts — ONLY the sources that ACTUALLY feed the blend (IMDb · MC ·
 *  LB), fixed order, present-only. RT/rtAudience are consensus %, not blend
 *  ingredients, so they never appear here (a receipt shows the blend's work). */
function sealReceipts(r: Release): string {
  const parts: string[] = [];
  if (typeof r.imdbRating === "number") parts.push(`IMDb ${r.imdbRating.toFixed(1)}`);
  if (typeof r.metacritic === "number") parts.push(`MC ${Math.round(r.metacritic)}`);
  if (typeof r.letterboxd === "number") parts.push(`LB ${r.letterboxd.toFixed(1)}`);
  return parts.join(" · ");
}

// ── L3 ADAPTIVE STRIP INK ────────────────────────────────────────────────────
// The cover's veil + per-letter halo carry most legibility, but a poster that is
// bright exactly where a veil sits (white title slab, sky) still washes text out.
// Before rendering we sample each cover strip's TOP 35% and BOTTOM 30% luminance
// and emit a per-strip ink-boost opacity the template lays inside the veil zones
// only. Render-time, free (CDN fetch, no billed API); fails SOFT toward MORE ink.

/** Fraction of poster height sampled from the top / bottom for the veil zones. */
const TOP_SAMPLE_FRACTION = 0.35;
const BOTTOM_SAMPLE_FRACTION = 0.30;
/** Max boost — also the value a fetch/decode failure degrades to (more ink, never less). */
const BOOST_MAX = 0.30;

/** Per-strip ink boost added inside a veil zone. */
interface StripBoost {
  top: number;
  bottom: number;
}

/** Mean-luminance → boost ladder. Brighter band ⇒ more backing ink under text. */
function boostForLuminance(lum: number): number {
  if (lum <= 80) return 0;
  if (lum <= 140) return 0.15;
  return 0.30;
}

/** Rec.709 perceived luminance of a sharp region's stats (grayscale-safe). */
function luminanceOf(stats: sharp.Stats): number {
  const [r, g, b] = stats.channels;
  if (!r) return 0;
  return g && b ? 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean : r.mean;
}

/**
 * Load poster bytes for sampling. Reuses ofetch (the poster-crop client) for
 * http(s); decodes `data:` URIs in-process (ofetch can't fetch them) so the
 * synthetic bright-strip fixture genuinely runs the >140 → 0.30 branch rather
 * than a hardcoded value. sharp rasterizes SVG payloads.
 */
async function loadImageBytes(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma); // e.g. "image/svg+xml;base64"
    const payload = url.slice(comma + 1);
    return meta.includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
  }
  const bytes = await ofetch(url, { responseType: "arrayBuffer" });
  return Buffer.from(bytes as ArrayBuffer);
}

/**
 * Sample one strip's veil-zone luminances → ink boosts.
 * No poster (fallbackColor strip) → {0,0}. Any fetch/decode error → {MAX,MAX}:
 * degradation always adds ink, never removes legibility.
 */
async function sampleStripInk(posterUrl?: string): Promise<StripBoost> {
  if (!posterUrl) return { top: 0, bottom: 0 };
  try {
    const buf = await loadImageBytes(posterUrl);
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return { top: BOOST_MAX, bottom: BOOST_MAX };
    const { width, height } = meta;
    const topH = Math.max(1, Math.round(height * TOP_SAMPLE_FRACTION));
    const botH = Math.max(1, Math.round(height * BOTTOM_SAMPLE_FRACTION));
    const topStats = await sharp(buf).extract({ left: 0, top: 0, width, height: topH }).stats();
    const botStats = await sharp(buf)
      .extract({ left: 0, top: height - botH, width, height: botH })
      .stats();
    return { top: boostForLuminance(luminanceOf(topStats)), bottom: boostForLuminance(luminanceOf(botStats)) };
  } catch {
    return { top: BOOST_MAX, bottom: BOOST_MAX };
  }
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
  sealScore: string;
  receipts: string;
  votesLine: string;
  platform?: string;
  platformLogo?: string;
  platformColor: string;
  platformIsGradient: boolean;
  posterUrl?: string;
  fallbackColor: string;
  language: string;
  boostTop: number;
  boostBottom: number;
}

function buildCardContext(
  card: ArchivesRenderCard,
  i: number,
  total: number,
  vol: number,
  /** THE pixel date, "MMM D · YYYY" — the card's only date. */
  pixelDate: string,
  boost: StripBoost
): CardContext {
  const r = card.release;
  const style = getPlatformStyle(r.platform[0]);
  const platform = r.platform[0];
  return {
    vol: formatVolume(vol),
    // issueDate is retained for the context TYPE but no longer reaches pixels:
    // the mast-date span is gone, so the ✓ CHECKED chip is the card's one date.
    issueDate: pixelDate,
    checkedDate: pixelDate,
    slotNumber: i + 1,
    totalSlots: total,
    isTreasure: card.kind === "treasure",
    kicker: kickerFor(card),
    title: r.title,
    whyLine: card.whyLine,
    sealScore: sealScore(r),
    receipts: sealReceipts(r),
    votesLine: votesLine(r),
    ...(platform ? { platform: platform.toUpperCase() } : {}),
    ...(platform ? { platformLogo: platformLogoStem(platform) } : {}),
    platformColor: style.platformColor,
    platformIsGradient: style.platformIsGradient,
    ...(r.posterUrl ? { posterUrl: r.posterUrl } : {}),
    fallbackColor: LANGUAGE_FALLBACK_COLORS[r.language] ?? "#1A1614",
    language: r.language,
    boostTop: boost.top,
    boostBottom: boost.bottom,
  };
}

export async function renderArchives(
  deck: ArchivesDeck,
  outputDir = "output/posts"
): Promise<ArchivesRenderResult> {
  const now = new Date();
  const date = editorialTodayStamp(now);
  log.info(`Rendering TBSI Archives — VOL. ${formatVolume(deck.vol)} (${deck.cards.length} cards)`);

  await cleanOldRenders(outputDir, date);

  // Distinct-genre count for the cover line.
  const genres = new Set(deck.cards.map((c) => (c.primaryGenre ?? c.release.genre[0] ?? "").toLowerCase()));
  // THE pixel date — "MMM D · YYYY" (clean pixels). Replaces the old
  // displayDate.slice(0,5) "dd·MM", which was both a second date format and a
  // brittle substring of another string's formatting.
  const coverDate = editorialCoverDate(now);

  // L3: sample each strip's veil-zone luminance → per-strip ink boosts (additive
  // cover-context fields). Parallel, free CDN fetches; fails soft toward more ink.
  const boosts = await Promise.all(deck.cards.map((c) => sampleStripInk(c.release.posterUrl)));

  const coverCtx = {
    vol: formatVolume(deck.vol),
    issueDate: coverDate,
    coverDate,
    filmCount: deck.cards.length,
    genreCount: genres.size,
    tiles: deck.cards.map((c, i) => ({
      ...(c.release.posterUrl ? { posterUrl: c.release.posterUrl } : {}),
      fallbackColor: LANGUAGE_FALLBACK_COLORS[c.release.language] ?? "#1A1614",
      language: c.release.language.toUpperCase(),
      title: c.release.title,
      boostTop: boosts[i]!.top,
      boostBottom: boosts[i]!.bottom,
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
    // Same deck-sampled boosts drive the card's full-bleed adaptive ink.
    const ctx = buildCardContext(deck.cards[i]!, i, deck.cards.length, deck.vol, coverDate, boosts[i]!);
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
  // SYNTHETIC bright-strip legibility regression: a flat #cfe4ee poster (the
  // Saturday synthetic-bright trick). Repointed onto the LEFTMOST sample strip so
  // the bright case sits behind the bottom-left FILMS/VOL block AND the left half
  // of the centered eyebrow/wordmark/subline — exercising L3's >140 → 0.30 branch
  // on every render forever. sharp rasterizes the SVG; the <img> renders it flat.
  const SYNTHETIC_BRIGHT_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750"><rect width="100%" height="100%" fill="#cfe4ee"/></svg>`;
  const SYNTHETIC_BRIGHT_POSTER =
    `data:image/svg+xml;base64,${Buffer.from(SYNTHETIC_BRIGHT_SVG).toString("base64")}`;
  const sample: ArchivesDeck = {
    vol: 1,
    cards: [
      {
        kind: "pick",
        primaryGenre: "Comedy",
        whyLine: "A featherlight farce that has quietly become the group-chat comfort rewatch.",
        release: {
          // Full-receipt seal (IMDb+MC+LB) on the SYNTHETIC bright poster — the
          // contrast bar. tbsiScore = mean(8.1, 78/10, 4.2*2) = 8.1.
          id: "s1", tmdbId: 1, title: "Aa Okkati Adakku", language: "Telugu", isSeries: false,
          platform: ["Aha"], releaseDate: "2020-05-10", genre: ["Comedy", "Romance"],
          cast: [], synopsis: "", subtitleLanguages: [], sources: ["sample"], fetchedAt: "",
          imdbRating: 8.1, imdbVotes: 24312, rottenTomatoes: 94, metacritic: 78, letterboxd: 4.2,
          posterUrl: SYNTHETIC_BRIGHT_POSTER, // SYNTHETIC bright-poster legibility regression
        },
      },
      {
        kind: "pick",
        primaryGenre: "Thriller",
        whyLine: "Ninety minutes of clockwork tension that still has no wasted frame.",
        release: {
          // Permanent double regression: a long TITLE (title ladder → smallest
          // tier) + JioHotstar (platform plat-sm ladder + gradient + reserved
          // chip) + the NO-POSTER fallback card + a DEGENERATE seal (IMDb only →
          // one-line receipt "IMDb 8.4", tbsiScore = 8.4, honest by construction).
          id: "s2", tmdbId: 2, title: "Agent Sai Srinivasa Athreya", language: "Tamil", isSeries: false,
          platform: ["JioHotstar"], releaseDate: "2018-10-05", genre: ["Thriller", "Crime"],
          cast: [], synopsis: "", subtitleLanguages: [], sources: ["sample"], fetchedAt: "",
          imdbRating: 8.4, imdbVotes: 41208,
        },
      },
      {
        kind: "treasure",
        primaryGenre: "Drama",
        whyLine: "A box-office miss in 2016 that the internet has since crowned a modern classic.",
        release: {
          // TREASURE stamp on a dark real poster + PARTIAL receipts (no RT/LB…
          // actually IMDb+MC+LB, RT omitted): tbsiScore = mean(8.2, 72/10, 4.0*2) = 7.8.
          id: "s3", tmdbId: 3, title: "Kammatipaadam", language: "Malayalam", isSeries: false,
          platform: ["SonyLIV"], releaseDate: "2016-05-20", genre: ["Drama", "Crime"],
          cast: [], synopsis: "", subtitleLanguages: [], sources: ["sample"], fetchedAt: "",
          imdbRating: 8.2, imdbVotes: 15903, metacritic: 72, letterboxd: 4.0,
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
