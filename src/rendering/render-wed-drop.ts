// src/rendering/render-wed-drop.ts
// Orchestrator: WednesdayDropDraft → 1 cover PNG + N body card PNGs

import { promises as fs } from "node:fs";
import { renderToPNG, closeBrowser } from "./renderer.js";
import { editorialTodayStamp, editorialDisplayDate } from "../shared/editorial-clock.js";
import { log } from "../shared/logger.js";
import type { WednesdayDropDraft, WedDropSlide } from "../delivery/notion.js";
import type { Release } from "../shared/types.js";
import { EDITION_META, type WedDropEdition } from "../shared/wed-drop-edition.js";
import { sortWedDropByProminence } from "../content/weekend/wednesday-drop.js";
import { computeCropPosition } from "./poster-crop.js";
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
  buildStampContext,
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
  edition: WedDropEdition,
  outputDir = "output/posts"
): Promise<RenderResult> {
  const meta = EDITION_META[edition];
  log.info(`Rendering Wed Drop [${edition}] — Issue №${issueNumber}`);

  // The LLM outputs slides typed cover / index / release / cta.
  // The redesigned cover no longer uses the LLM cover slide (its plain h1 is
  // derived from the edition); we only need the release slides → body cards.
  const releaseSlides = draft.slides.filter(s => s.type === "release");

  log.info(`  Films: ${draft.releases.length} | Release slides: ${releaseSlides.length}`);

  // IST-anchored stamps (see editorial-clock: THE TRAP) — never date-fns format().
  const now = new Date();
  const baseCtx = {
    vol: "01",
    issue: String(issueNumber).padStart(3, "0"),
    date: editorialTodayStamp(now),
    displayDate: editorialDisplayDate(now),
    pillarLabel: "WED DROP" as const,
    editionLabel: meta.mastheadLabel,
  };

  // Scope the stale-render sweep to THIS edition's files so the two editions
  // (same date) don't delete each other's PNGs.
  await cleanOldRenders(outputDir, `${meta.slug}-${baseCtx.date}`);

  // 1. Cover: poster-wall grid of the TOP 4 films (draft.releases is already in
  //    prominence order, so the biggest film leads the wall). The dark-crop
  //    safeguard samples each poster's top band and shifts the crop when it's
  //    near-black; posterless films render the typographic fallback cell.
  const gridItems = draft.releases.slice(0, 4).map(buildGridItem);
  await Promise.all(gridItems.map(async gi => {
    gi.cropPosition = await computeCropPosition(gi.posterUrl);
  }));
  const coverPath = `${outputDir}/wed-drop-${meta.slug}-${baseCtx.date}-cover.png`;
  const coverCtx: WedDropCoverContext = {
    ...baseCtx,
    weekendDates: draft.weekendDates,
    filmCount: draft.releases.length,
    coverTitle: edition === "ott" ? "This Week's OTT Drops." : "This Week's Theatrical Drops.",
    gridClass: `count-${Math.min(gridItems.length, 4)}`,
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
      ...buildStampContext(release),
    };
    const cardPath = `${outputDir}/wed-drop-${meta.slug}-${baseCtx.date}-card-${String(i + 1).padStart(2, "0")}.png`;
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
  // Standalone render check for BOTH editions (NO LLM, sample data only).
  // Builds a theatrical-only sample and an OTT-only sample so the masthead
  // labels (IN THEATERS vs NOW STREAMING), the RELEASED marquee, and the
  // "SWIPE FOR ALL {n}" count can be eyeballed per edition. Also exercises the
  // graceful <4-film cover and the 0-film skip guard.

  // Compact Release factory — fills required fields; override per film.
  const mk = (
    over: Partial<Release> & { id: string; title: string; language: Release["language"] }
  ): Release => ({
    isSeries: false,
    platform: [],
    releaseDate: "2026-06-19",
    genre: ["Drama"],
    cast: [],
    synopsis: "Sample synopsis for a standalone render check.",
    subtitleLanguages: ["English"],
    sources: ["TMDb"],
    fetchedAt: new Date().toISOString(),
    ...over,
  });

  // Assemble a draft from a cover + a list of { body, release } picks. The
  // sample items are deliberately passed in NON-prominence order;
  // sortWedDropByProminence (the SAME function the production generator runs)
  // reorders both the releases and the 'release' slides into prominence order
  // (biggest film first), so this no-LLM render demonstrates exactly what
  // job:wednesday produces.
  const draftOf = (
    weekendDates: string,
    cover: { title: string; body: string },
    items: Array<{ body: string; release: Release }>
  ): WednesdayDropDraft => {
    const rawSlides: WedDropSlide[] = [
      { slideNumber: 1, type: "cover", title: cover.title, body: cover.body },
      ...items.map((it, i) => ({
        slideNumber: i + 2,
        type: "release" as const,
        title: it.release.title,
        body: it.body,
      })),
      { slideNumber: items.length + 2, type: "cta", title: "Which one?", body: "DM us. Save this." },
    ];
    const sorted = sortWedDropByProminence(rawSlides, items.map(it => it.release));
    return {
      pillar: "Wed Drop",
      weekendDates,
      caption: `${cover.title} — ${cover.body}`,
      hashtags: "#WeekendWatch #TBSI",
      carouselSlides: "(legacy markdown blob)",
      slides: sorted.slides,
      releases: sorted.releases,
    };
  };

  // Known-good TMDb poster (reused across sample cells so the poster wall shows
  // real images without needing many distinct URLs).
  const SAMPLE_POSTER = "https://image.tmdb.org/t/p/w500/snQLwRrfQAl5YFKVefZq9Lbscki.jpg";

  // ── THEATRICAL edition (In Theaters): all releaseDates.theatrical, cinema-bound ──
  // No posters → exercises the ALL-FALLBACK poster wall (every cell typographic).
  // tmdbPopularity drives the order now (biggest first), NOT the rating fields.
  // Expected prominence order: Cocktail 2 (900) → Deewana (750) → Nooru Sami
  // (400) → Abhhiman (250) → Lifeline (120).
  const theatricalDraft = draftOf(
    "Jun 17 — Jun 21, 2026",
    { title: "Five for the big screen.", body: "This weekend belongs in a theater." },
    [
      { body: "A glossy reboot that coasts on its leads. Fun, forgettable.", release: mk({ id: "t1", title: "Cocktail 2", language: "Hindi", genre: ["Romance"], releaseDates: { theatrical: "2026-06-19" }, director: "Homi Adajania", cast: ["Rashmika Mandanna", "Shahid Kapoor"], runtime: 138, tbsiScore: 5.4, tbsiSourceCount: 2, imdbRating: 5.5, rottenTomatoes: 48, tmdbPopularity: 900 }) },
      { body: "A throwback romance that wears its sincerity well.", release: mk({ id: "t2", title: "Deewana", language: "Telugu", genre: ["Romance"], releaseDates: { theatrical: "2026-06-19" }, director: "Trivikram Srinivas", cast: ["Vijay Deverakonda"], runtime: 144, tbsiScore: 6.8, tbsiSourceCount: 3, imdbRating: 6.9, rottenTomatoes: 62, metacritic: 60, tmdbPopularity: 750 }) },
      { body: "Devotional drama for a specific crowd — earnest if uneven.", release: mk({ id: "t3", title: "Nooru Sami", language: "Tamil", releaseDates: { theatrical: "2026-06-19" }, director: "Sasikumar", cast: ["Sasikumar"], runtime: 132, tmdbPopularity: 400 }) },
      { body: "Bengali courtroom drama that builds to a real payoff.", release: mk({ id: "t4", title: "Abhhiman", language: "Bengali", releaseDates: { theatrical: "2026-06-19" }, director: "Raj Chakraborty", cast: ["Prosenjit Chatterjee"], runtime: 126, tmdbPopularity: 250 }) },
      { body: "Bengali medical drama with a big heart, if a thin plot.", release: mk({ id: "t5", title: "Lifeline", language: "Bengali", releaseDates: { theatrical: "2026-06-21" }, director: "Atanu Ghosh", cast: ["Jaya Ahsan"], runtime: 118, tmdbPopularity: 120 }) },
    ]
  );

  // ── OTT edition (Now Streaming): all releaseDates.ott + a platform ──
  // Items are passed in DELIBERATELY NON-prominence order to prove the source
  // sort reorders them. Posters on the top-3 films + a POSTERLESS film (Athiradi)
  // in the top 4 exercises BOTH the poster wall AND the typographic fallback cell.
  // Expected prominence order (tmdbPopularity DESC):
  //   1. Drishyam 3    — 950 (poster)   ← biggest film LEADS, though not top-rated
  //   2. Razor         — 700 (poster)
  //   3. Sitting       — 500 (poster)
  //   4. Athiradi      — 300 (NO poster → fallback cell in the wall)
  //   5. Kenatha Kanom —  50 (off the top-4 cover, still card 5)
  const ottDraft = draftOf(
    "Jun 15 — Jun 21, 2026",
    { title: "Five to stream this weekend.", body: "Couch sorted, all weekend long." },
    [
      { body: "Mass-y action that knows exactly what it is. Now on JioHotstar.", release: mk({ id: "o5", title: "Athiradi", language: "Malayalam", genre: ["Action"], platform: ["JioHotstar"], releaseDate: "2026-06-19", releaseDates: { ott: "2026-06-19" }, director: "Lal Jose", cast: ["Tovino Thomas"], runtime: 142, tmdbPopularity: 300 }) },
      { body: "A one-room chamber piece that quietly arrived on Aha. A real find.", release: mk({ id: "o3", title: "Sitting", language: "Telugu", platform: ["Aha"], releaseDate: "2026-06-20", releaseDates: { ott: "2026-06-20" }, posterUrl: SAMPLE_POSTER, director: "Praveen Kandregula", cast: ["Priyadarshi"], runtime: 96, tmdbVoteAverage: 7.4, tmdbVoteCount: 300, tmdbPopularity: 500 }) },
      { body: "Lean Telugu thriller dropping straight to Netflix. A sharp 100 minutes.", release: mk({ id: "o2", title: "Razor", language: "Telugu", genre: ["Thriller"], platform: ["Netflix"], releaseDate: "2026-06-19", releaseDates: { ott: "2026-06-19" }, posterUrl: SAMPLE_POSTER, director: "Sailesh Kolanu", cast: ["Nani"], runtime: 104, tbsiScore: 6.5, tbsiSourceCount: 3, imdbRating: 6.6, tmdbPopularity: 700 }) },
      { body: "Slow-burn rural drama that finally hit SonyLIV this week. Worth the wait.", release: mk({ id: "o4", title: "Kenatha Kanom", language: "Tamil", platform: ["SonyLIV"], releaseDate: "2026-06-16", releaseDates: { ott: "2026-06-16" }, director: "Ameer", cast: ["Vikram Prabhu"], runtime: 128, tmdbPopularity: 50 }) },
      { body: "The franchise everyone swore was over returns — and it still grips. Now on Prime Video.", release: mk({ id: "o1", title: "Drishyam 3", language: "Malayalam", genre: ["Thriller"], platform: ["Prime Video"], releaseDate: "2026-06-18", releaseDates: { ott: "2026-06-18" }, posterUrl: SAMPLE_POSTER, director: "Jeethu Joseph", cast: ["Mohanlal"], runtime: 151, tbsiScore: 8.3, tbsiSourceCount: 4, imdbRating: 8.1, rottenTomatoes: 85, metacritic: 73, letterboxd: 4.0, tmdbPopularity: 950 }) },
    ]
  );

  // ── Adaptive 3-film grid (two on top, one full-width below) ──
  // Lead + bottom cell carry posters so the full-width bottom tile shows an image.
  // Expected prominence order: Kingdom (800) → Mirage (500) → Echo (200).
  const threeDraft = draftOf(
    "Jun 17 — Jun 21, 2026",
    { title: "Three to stream.", body: "A tighter week, still worth it." },
    [
      { body: "A sweeping period epic that finally lands on Netflix.", release: mk({ id: "d3-1", title: "Kingdom", language: "Telugu", genre: ["Action"], platform: ["Netflix"], releaseDate: "2026-06-18", releaseDates: { ott: "2026-06-18" }, posterUrl: SAMPLE_POSTER, director: "Gowtam Tinnanuri", cast: ["Vijay Deverakonda"], runtime: 150, tmdbPopularity: 800 }) },
      { body: "A twisty mid-budget thriller worth a quiet evening.", release: mk({ id: "d3-2", title: "Mirage", language: "Tamil", genre: ["Thriller"], platform: ["Aha"], releaseDate: "2026-06-19", releaseDates: { ott: "2026-06-19" }, director: "Karthik Naren", cast: ["Arun Vijay"], runtime: 118, tmdbPopularity: 500 }) },
      { body: "A tender indie that rewards patience.", release: mk({ id: "d3-3", title: "Echo", language: "Malayalam", genre: ["Drama"], platform: ["SonyLIV"], releaseDate: "2026-06-17", releaseDates: { ott: "2026-06-17" }, posterUrl: SAMPLE_POSTER, director: "Lijo Jose Pellissery", cast: ["Fahadh Faasil"], runtime: 104, tmdbPopularity: 200 }) },
    ]
  );

  // ── Graceful-degrade: a theatrical edition with only 2 films (cover 2x2 half-fills) ──
  const miniDraft = draftOf(
    "Jun 17 — Jun 21, 2026",
    { title: "Two openings worth the trip.", body: "A quiet weekend at the movies." },
    [
      { body: "A glossy reboot that coasts on its leads.", release: mk({ id: "m1", title: "Cocktail 2", language: "Hindi", releaseDates: { theatrical: "2026-06-19" }, director: "Homi Adajania", cast: ["Rashmika Mandanna"], runtime: 138 }) },
      { body: "A throwback romance that wears its sincerity well.", release: mk({ id: "m2", title: "Deewana", language: "Telugu", releaseDates: { theatrical: "2026-06-19" }, director: "Trivikram Srinivas", cast: ["Vijay Deverakonda"], runtime: 144 }) },
    ]
  );

  // ── 0-film edition: the LLM declined (empty slides) → produceEdition skips it. ──
  const emptyDraft: WednesdayDropDraft = {
    pillar: "Wed Drop",
    weekendDates: "Jun 17 — Jun 21, 2026",
    caption: "",
    hashtags: "",
    carouselSlides: "",
    slides: [],
    releases: [],
  };

  // Mirror produceEdition's skip guard for this render check (the real guard
  // lives in src/jobs/wednesday-drop.ts and runs BEFORE renderWedDrop). Each
  // sample writes to its OWN review folder — renderWedDrop's cleanOldRenders is
  // scoped per (slug, date), so same-edition samples would otherwise overwrite
  // one another. Distinct dirs keep every cover on disk for pixel review.
  const renderOrSkip = async (label: string, draft: WednesdayDropDraft, edition: WedDropEdition) => {
    if (draft.slides.length === 0) {
      log.info(`  [${label}] edition skipped — no films (no cover, no cards rendered)`);
      return;
    }
    const safe = label.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const dir = `output/review/wed-cover/${safe}`;
    log.info(`  [${label}] prominence order: ${draft.releases.map((r, i) => `${i + 1}. ${r.title}`).join("  →  ")}`);
    const result = await renderWedDrop(draft, 2, edition, dir);
    log.success(`  [${label}] cover: ${result.coverPath} | cards: ${result.cardPaths.length}`);
    for (const p of result.cardPaths) log.info(`           ${p}`);
  };

  try {
    await renderOrSkip("theatrical", theatricalDraft, "theatrical");
    await renderOrSkip("ott", ottDraft, "ott");
    await renderOrSkip("ott-three (3 films)", threeDraft, "ott");
    await renderOrSkip("theatrical-mini (2 films)", miniDraft, "theatrical");
    await renderOrSkip("theatrical-empty (0 films)", emptyDraft, "theatrical");
    log.success("\n✓ Render complete for both editions.");
  } catch (err) {
    log.error("Render failed", err);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}