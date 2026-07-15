// src/jobs/friday-archives.ts
// TBSI ARCHIVES — the Friday catalog-recommendation pillar. Resurfaces 3–4 OLDER
// films (≥ ARCHIVE_MIN_AGE_YEARS), each a different primary genre, all streaming
// in India TONIGHT, IMDb-sealed, never repeated (permanent ledger). Gateless:
// there is no approve token — the owner is the gate. NO verdicts, NO heat chip,
// NO critic research. It owns a VOL. NNN counter and NEVER touches the global
// issue system.
//
// CRASH-SAFE ORDER (ruling R5): the volume is read BEFORE selection; the ledger
// is written ONLY after a successful render + deliver, so a failed run burns no
// picks and no volume number.

import { enrichReleases } from "../ingestion/releases/index.js";
import { filmKey } from "../shared/featured-ledger.js";
import { log } from "../shared/logger.js";
import {
  discoverArchivesLanguage,
  fetchArchivesStubById,
} from "../content/archives/archives-discover.js";
import {
  selectArchives,
  selectArchivesManual,
  ineligibilityReason,
  toSelected,
  minAgeYears,
  archivesCutoffDate,
  parseLangOverride,
  parsePickOverride,
  parseTreasure,
  rotateLanguages,
  ARCHIVES_LANGUAGES,
  ARCHIVES_TARGET_MIN,
  ARCHIVES_TARGET_MAX,
  ROTATION_WINDOW,
  type SelectedArchive,
} from "../content/archives/archives-select.js";
import {
  nextVolume,
  excludedArchivesKeys,
  recordArchivesPicks,
  formatVolume,
} from "../content/archives/archives-ledger.js";
import { generateArchivesCopy } from "../content/archives/archives-copy.js";
import { renderArchives, ARCHIVES_SLUG, type ArchivesDeck } from "../rendering/render-archives.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { buildAndUploadDeckZip, writeCaptionFile } from "../delivery/deliver-deck-zip.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { buildHashtags } from "../shared/hashtags.js";
import { purgeExpired } from "../shared/cache.js";
import { editorialTodayStamp, editorialDisplayDate, warnIfNotPostingDay } from "../shared/editorial-clock.js";
import type { Release } from "../shared/types.js";

// Enrichment is the cost center (IMDb + platforms + credits + OMDb + MDBList per
// film), so cap how many coarse candidates per language get enriched. The coarse
// net is sorted vote_count.desc, so the top slice holds the strongest gate
// candidates (votes ≥ 2000 clears easily up here); deeper rows are weaker + pricier.
const MAX_ENRICH_PER_LANG = 15;

/** One-line WHY (machine reasoning) so the owner can read every call. */
function whyLine(p: SelectedArchive): string {
  const plat = p.release.platform[0] ?? "—";
  return (
    `  ✓ ${p.release.title} — IMDb ${p.imdbRating ?? "—"} · ${p.imdbVotes ?? "—"} votes · ` +
    `${plat} · ${p.tier}${p.kind === "treasure" ? " · TREASURE" : ""} · genre ${p.primaryGenre ?? "—"}`
  );
}

/** Deterministic caption (no extra LLM call — the one copy call is the why-lines). */
function buildCaption(deck: ArchivesDeck): string {
  const lines = deck.cards.map((c) => {
    const yr = c.release.releaseDate?.slice(0, 4) ?? "";
    return `• ${c.release.title} (${c.release.language}${yr ? `, ${yr}` : ""}) → ${c.release.platform[0] ?? "—"}`;
  });
  return (
    `🎞️ TBSI ARCHIVES · VOL. ${formatVolume(deck.vol)}\n\n` +
    `Older films worth your night — every one highly rated and streaming right now:\n\n` +
    `${lines.join("\n")}\n\n` +
    `Save this for tonight. Which one are you starting with?`
  );
}

async function main(deliver = true) {
  log.info("🎞️  TBSI Archives job — starting");
  if (!deliver) {
    log.warn("DRY RUN — no delivery (--no-deliver): discover + gate + render run; R2/Slack/ledger skipped");
  }

  purgeExpired();
  warnIfNotPostingDay(5, "TBSI Archives"); // 5 = Friday (IST)

  const now = new Date();

  // Volume FIRST (crash-safe) — it also drives the language rotation window.
  const vol = nextVolume();
  const years = minAgeYears(process.env.ARCHIVE_MIN_AGE_YEARS);
  const cutoff = archivesCutoffDate(now, years);
  const langOverride = parseLangOverride(process.env.ARCHIVES_LANGS);
  const rotationLangs = rotateLanguages(vol, ROTATION_WINDOW, ARCHIVES_LANGUAGES, langOverride);
  const pickIds = parsePickOverride(process.env.ARCHIVES_PICKS);
  const treasureId = parseTreasure(process.env.ARCHIVES_TREASURE);
  const excluded = excludedArchivesKeys();

  log.info(
    `VOL. ${formatVolume(vol)} · films ≥ ${years}yr old (≤ ${cutoff}) · ` +
      (pickIds.length ? `CURATED picks [${pickIds.join(", ")}]` : `languages [${rotationLangs.join(", ")}]`) +
      (treasureId ? ` · treasure tmdb:${treasureId}` : "") +
      ` · ${excluded.size} film(s) permanently excluded`
  );

  // ── Build the candidate pool + select ──
  let picks: SelectedArchive[];
  let rejected: Array<{ title: string; reason: string }>;
  if (pickIds.length > 0) {
    // Curated edition — bypasses genre-distinctness + count, NOT eligibility.
    const stubs = (await Promise.all(pickIds.map(fetchArchivesStubById))).filter(
      (s): s is Release => s !== null
    );
    const enriched = await enrichReleases(stubs);
    const res = selectArchivesManual(enriched, pickIds, { excludedKeys: excluded, filmKey });
    picks = res.picks;
    rejected = res.rejected;
  } else {
    // Standard rotation edition.
    const stubs: Release[] = [];
    for (const lang of rotationLangs) {
      const found = await discoverArchivesLanguage(lang, cutoff);
      stubs.push(...found.slice(0, MAX_ENRICH_PER_LANG)); // top-voted slice → bounded enrich cost
    }
    log.info(`Coarse candidates to enrich: ${stubs.length} (≤ ${MAX_ENRICH_PER_LANG}/language)`);
    const enriched = await enrichReleases(stubs);
    const res = selectArchives(enriched, {
      excludedKeys: excluded,
      filmKey,
      min: ARCHIVES_TARGET_MIN,
      max: ARCHIVES_TARGET_MAX,
    });
    picks = res.picks;
    rejected = res.rejected;
  }

  // ── Treasure card (dial-only in v1) — SAME eligibility pipeline, kind='treasure' ──
  if (treasureId) {
    const stub = await fetchArchivesStubById(treasureId);
    if (!stub) {
      log.warn(`Treasure tmdb:${treasureId} not found — skipping treasure`);
    } else {
      const [enr] = await enrichReleases([stub]);
      const reason = enr ? ineligibilityReason(enr, excluded, filmKey) : "enrichment failed";
      if (!enr || reason) {
        log.warn(`Treasure tmdb:${treasureId} ineligible (${reason}) — skipping treasure`);
      } else if (picks.some((p) => p.release.tmdbId === treasureId)) {
        log.warn(`Treasure tmdb:${treasureId} already a pick — skipping treasure`);
      } else {
        picks.push(toSelected(enr, "treasure"));
        log.info(`Treasure card added: ${enr.title}`);
      }
    }
  }

  // ── Machine reasoning: the owner reads every call ──
  log.info(`\nSELECTED ${picks.length} card(s):`);
  for (const p of picks) log.info(whyLine(p));
  if (rejected.length > 0) {
    log.info(`Rejected ${rejected.length}:`);
    for (const r of rejected.slice(0, 20)) log.info(`  ✗ ${r.title} — ${r.reason}`);
  }

  // Count floor applies to the standard edition only (curated is the owner's call).
  if (pickIds.length === 0 && picks.length < ARCHIVES_TARGET_MIN) {
    log.warn(
      `Only ${picks.length} eligible film(s) — need ≥ ${ARCHIVES_TARGET_MIN}. Aborting (no ledger write).`
    );
    return;
  }
  if (picks.length === 0) {
    log.warn("No eligible films — aborting (no ledger write).");
    return;
  }

  // ── ONE LLM copy call — name-swept why-lines ──
  const { whyByTitle, nameFlags } = await generateArchivesCopy(
    picks.map((p) => ({
      release: p.release,
      kind: p.kind,
      ...(p.primaryGenre ? { primaryGenre: p.primaryGenre } : {}),
    }))
  );
  for (const f of nameFlags) log.warn(`  ⚑ ${f}`);

  const deck: ArchivesDeck = {
    vol,
    cards: picks.map((p) => ({
      release: p.release,
      kind: p.kind,
      ...(p.primaryGenre ? { primaryGenre: p.primaryGenre } : {}),
      whyLine: whyByTitle.get(p.release.title) ?? "",
    })),
  };

  log.info("Rendering PNGs…");
  const render = await renderArchives(deck, "output/posts");

  if (!deliver) {
    log.success(
      `\n✅ Archives DRY RUN complete — no delivery. ${render.cardPaths.length} card(s) + cover in output/posts`
    );
    return;
  }

  // ── Deliver (R2 → deck zip → Slack), THEN record the ledger (crash-safe) ──
  const dateStr = editorialTodayStamp(now);
  log.info("Uploading to R2…");
  const uploads = await uploadPngsToR2([
    { localPath: render.coverPath, r2Key: `archives/${dateStr}/cover.png` },
    ...render.cardPaths.map((p, i) => ({
      localPath: p,
      r2Key: `archives/${dateStr}/card-${String(i + 1).padStart(2, "0")}.png`,
    })),
  ]);
  const cover = uploads[0]!;
  const cardUploads = uploads.slice(1);

  const releases = picks.map((p) => p.release);
  const hashtags = buildHashtags(releases, "#TBSIArchives #StreamingNow #OTT #IndianCinema");
  const caption = buildCaption(deck);

  let deckZipLine: string;
  let deckUrl = cover.publicUrl;
  try {
    await writeCaptionFile("output/posts", dateStr, caption, ARCHIVES_SLUG);
    const zip = await buildAndUploadDeckZip({ outputDir: "output/posts", date: dateStr, slug: ARCHIVES_SLUG });
    const mb = (zip.sizeBytes / 1_048_576).toFixed(1);
    deckZipLine = `📦 IG-ready deck (${zip.slideCount} slides, ${mb} MB): ${zip.url}`;
    deckUrl = zip.url;
    log.success(`   Deck zip: ${zip.url}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`Deck zip step failed (non-fatal) — ${reason}`);
    deckZipLine = `📦 deck zip failed: ${reason}`;
  }

  log.info("Sending Slack notification…");
  await notifyDraftReady({
    pillar: "TBSI Archives",
    emoji: "🎞️",
    title: `Archives VOL. ${formatVolume(vol)} — ${picks.length} films`,
    ...(deck.cards[0]?.whyLine ? { subtitle: deck.cards[0].whyLine } : {}),
    notionUrl: deckUrl,
    primaryButtonLabel: "Open deck",
    metadata: {
      VOL: formatVolume(vol),
      Films: String(picks.length),
      Genres: [...new Set(picks.map((p) => p.primaryGenre).filter(Boolean))].join(", "),
      ...(nameFlags.length ? { "Copy flags": String(nameFlags.length) } : {}),
    },
    coverImageUrl: cover.publicUrl,
    bodyCardImageUrls: cardUploads.map((u) => u.publicUrl),
    hashtags,
    deckZip: deckZipLine,
  });

  // CRASH-SAFE: only now — after a successful render + deliver — is the ledger
  // written. A failure anywhere above throws before this line, burning no picks.
  recordArchivesPicks(
    picks.map((p) => ({ film: p.release, kind: p.kind })),
    vol
  );

  log.success(`\n✅ TBSI Archives VOL. ${formatVolume(vol)} delivered — cover: ${cover.publicUrl}`);
}

// Only run when invoked directly (npm run job:archives). Guarding on isMainModule
// lets tests import the selection/ledger helpers without firing main().
const isMainModule = import.meta.url.endsWith((process.argv[1] ?? "").replace(/\\/g, "/"));

if (isMainModule) {
  const deliver = !process.argv.includes("--no-deliver") && process.env.DELIVER !== "false";
  main(deliver)
    .catch(async (err) => {
      log.error("TBSI Archives job failed", err);
      await notifyJobFailure("TBSI Archives", err instanceof Error ? err.message : String(err));
      process.exit(1);
    })
    .finally(async () => {
      await closeBrowser();
    });
}
