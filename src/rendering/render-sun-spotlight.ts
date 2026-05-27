// src/rendering/render-sun-spotlight.ts
// Orchestrator: SundaySpotlightDraft → 4 PNGs
//   - feed cover (1080x1350)
//   - reel cover (1080x1920)
//   - card-why-it-works (1080x1080)
//   - card-case-against (1080x1080)

import { renderToPNG, closeBrowser } from "./renderer.js";
import { format } from "date-fns";
import { log } from "../shared/logger.js";
import type { SundaySpotlightDraft } from "../delivery/notion.js";
import type { SunSpotlightRenderContext } from "./types.js";
import { getPlatformStyle, computeDensity, hasMetadataLine1, hasMetadataLine2 } from "./_shared.js";

// Same per-language fallback color map used inline by the other pillar orchestrators.
// (Kept inline here to match the established pattern — see render-mon-movement.ts.)
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

// Same platform → filename-stem rule the other orchestrators inline
// (kebab, "+" → "-plus", drop ".", and collapse "jio-hotstar"/"jiohotstar").
function platformLogoStem(platform: string): string {
  return platform
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/\+/g, "-plus")
    .replace(/\./g, "")
    .replace(/jio-?hotstar/g, "jiohotstar");
}

function formatIssueDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  return `${dd}·${mm}·${yy}`;
}

function buildContext(
  draft: SundaySpotlightDraft,
  date: Date,
  issueNumber: number | string
): SunSpotlightRenderContext {
  const film = draft.film;
  const firstPlatform = film.platform[0];
  const platformStyle = getPlatformStyle(firstPlatform);
  // Phase 5.5 enrichment fields, lifted from the picked film
  const enrichment = {
    ...(film.leadCast && film.leadCast.length > 0 ? { leadCast: film.leadCast } : {}),
    ...(film.musicDirector ? { musicDirector: film.musicDirector } : {}),
    ...(draft.isMusicDirectorNotable ? { isMusicDirectorNotable: true } : {}),
    ...(film.audioLanguages ? { audioLanguages: film.audioLanguages } : {}),
  };
  const density = computeDensity({
    bodyLength: draft.reelScript.whyItWorks.length,
    hasLine1: hasMetadataLine1(film),
    hasLine2: hasMetadataLine2({
      ...(film.leadCast && film.leadCast.length > 0 ? { leadCast: film.leadCast } : {}),
      ...(film.musicDirector ? { musicDirector: film.musicDirector } : {}),
      ...(draft.isMusicDirectorNotable ? { isMusicDirectorNotable: true } : {}),
    }),
  });
  return {
    filmTitle: film.title,
    language: film.language,
    ...(film.director ? { director: film.director } : {}),
    ...(film.runtime ? { runtime: film.runtime } : {}),
    ...(film.posterUrl ? { posterUrl: film.posterUrl } : {}),
    posterFallbackColor: LANGUAGE_FALLBACK_COLORS[film.language] ?? "#1A1614",
    hook: draft.reelScript.hook,
    issueNumber: String(issueNumber).padStart(3, "0"),
    issueDate: formatIssueDate(date),
    whyItWorks: draft.reelScript.whyItWorks,
    platform: firstPlatform ?? "",
    platformLogoStem: firstPlatform ? platformLogoStem(firstPlatform) : "",
    caseAgainstSkepticism: draft.caseAgainstSkepticism,
    ctaTagline: "The film paper of record.",
    ...platformStyle,
    density,
    ...enrichment,
  };
}

export interface RenderResult {
  feedCoverPath: string;
  reelCoverPath: string;
  card1Path: string;
  card2Path: string;
}

export async function renderSunSpotlight(
  draft: SundaySpotlightDraft,
  date: Date,
  issueNumber: number | string,
  outputDir = "output/posts"
): Promise<RenderResult> {
  log.info(`Rendering Sun Spotlight — Issue №${issueNumber}`);

  const ctx = buildContext(draft, date, issueNumber);
  const dateStr = format(date, "yyyy-MM-dd");
  const data = ctx as unknown as Record<string, unknown>;

  const feedCoverPath = `${outputDir}/sun-spotlight-${dateStr}-cover-feed.png`;
  const reelCoverPath = `${outputDir}/sun-spotlight-${dateStr}-cover-reel.png`;
  const card1Path     = `${outputDir}/sun-spotlight-${dateStr}-card-01.png`;
  const card2Path     = `${outputDir}/sun-spotlight-${dateStr}-card-02.png`;

  await renderToPNG({
    templateName: "sun-spotlight-cover-feed",
    data,
    width: 1080, height: 1350,
    outputPath: feedCoverPath,
  });
  await renderToPNG({
    templateName: "sun-spotlight-cover-reel",
    data,
    width: 1080, height: 1920,
    outputPath: reelCoverPath,
  });
  await renderToPNG({
    templateName: "sun-spotlight-card-why-it-works",
    data,
    width: 1080, height: 1080,
    outputPath: card1Path,
  });
  await renderToPNG({
    templateName: "sun-spotlight-card-case-against",
    data,
    width: 1080, height: 1080,
    outputPath: card2Path,
  });

  return { feedCoverPath, reelCoverPath, card1Path, card2Path };
}

// Standalone test mode
const isMainModule = import.meta.url.endsWith(
  (process.argv[1] ?? "").replace(/\\/g, "/")
);

if (isMainModule) {
  const sampleDraft: SundaySpotlightDraft = {
    pillar: "Sun Spotlight",
    weekendDates: "May 30 — June 1, 2026",
    film: {
      id: "ms-1",
      title: "Manjummel Boys",
      language: "Malayalam",
      isSeries: false,
      platform: ["SonyLIV"],
      releaseDate: "2024-02-22",
      genre: ["Survival", "Thriller"],
      runtime: 135,
      director: "Chidambaram",
      cast: ["Soubin Shahir", "Sreenath Bhasi"],
      synopsis: "Friends trapped in caves during a Kodaikanal trip.",
      // Intentionally broken URL — verifies onerror handler hides the <img>
      // cleanly so the Gallery fallback (bottle-green typographic panel) shows through.
      posterUrl: "https://image.tmdb.org/t/p/w500/this-file-does-not-exist.jpg",
      
      subtitleLanguages: ["English"],
      sources: ["TMDb"],
      fetchedAt: new Date().toISOString(),
    },
    caption: "Manjummel Boys is the survival drama Mollywood gave us in 2024.",
    hashtags: "#ManjummelBoys #MollywoodWatch #IndianCinema",
    reelScript: {
      hook: "The survival thriller that owned 2024 — and nobody outside Kerala talked about it.",
      whyItWorks: "Eleven friends descend into a cave in Kodaikanal. One falls. What follows is 135 minutes of dread and unbroken brotherhood — the kind of survival drama Hollywood used to make. Mollywood made this one for ₹20 crore. It earned ₹240.",
      watchNote: "Subtitles in English.",
      cta: "Watch it this weekend.",
      onScreenText: [],
      visualDirection: "",
    },
    caseAgainstSkepticism: "If you skip a film because the actors don't share your language, you're letting Hindi cinema's marketing budget pick what counts as Indian. Manjummel Boys runs 135 minutes with subtitles you'll forget after twenty.",
  };

  // Fixed date — issueDate "31·05·26" per spec. Using year/month/day form
  // to avoid the new Date("2026-05-31") UTC-vs-local timezone quirk.
  const fixedDate = new Date(2026, 4, 31);

  try {
    const result = await renderSunSpotlight(sampleDraft, fixedDate, 44);
    log.success(`\n✓ Render complete:`);
    log.success(`   Feed cover  : ${result.feedCoverPath}`);
    log.success(`   Reel cover  : ${result.reelCoverPath}`);
    log.success(`   Card 1      : ${result.card1Path}`);
    log.success(`   Card 2      : ${result.card2Path}`);
  } catch (err) {
    log.error("Render failed", err);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}
