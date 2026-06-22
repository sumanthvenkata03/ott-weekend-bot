// src/jobs/wednesday-drop.ts
import { addDays, endOfWeek, format, startOfDay, startOfWeek } from "date-fns";
import { ingestReleases, ingestOTTArrivals } from "../ingestion/releases/index.js";
import type { Release } from "../shared/types.js";
import { generateWednesdayDrop, MAX_WED_DROP_FILMS } from "../content/weekend/wednesday-drop.js";
import { writeWednesdayDropToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { buildHashtags } from "../shared/hashtags.js";
import { renderWedDrop } from "../rendering/render-wed-drop.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";
import { EDITION_META, type WedDropEdition } from "../shared/wed-drop-edition.js";
import { excludedKeysFor, recordFeatured, filmKey, type PillarKey } from "../shared/featured-ledger.js";
import { buildManifest, manifestToLog, manifestToSlack, saveManifest, assertOrFlag } from "../shared/post-validator.js";

/**
 * Produce ONE Wed Drop edition end-to-end from its own (un-merged) pool:
 * generate → (skip if 0 picks) → render → R2 → Notion → Slack. The two
 * editions ("theatrical" = In Theaters, "ott" = Now Streaming) are published
 * independently from the SAME issue number; the pools never merge.
 */
async function produceEdition(
  edition: WedDropEdition,
  pool: Release[],
  issueNumber: string,
  windowStart: string,
  windowEnd: string
): Promise<void> {
  const meta = EDITION_META[edition];
  log.info(`\n— ${meta.notionTitle} — ${pool.length} candidate(s) in pool —`);

  // Cross-pillar dedup: drop any film this edition's lane featured recently.
  // OTT shares Mon Movement's lane (the real collision); Theatrical is its own.
  const pillarKey: PillarKey = edition === "ott" ? "wed-ott" : "wed-theatrical";
  const excluded = excludedKeysFor(pillarKey, { excludeIssue: issueNumber });
  const deduped = pool.filter(r => !excluded.has(filmKey(r)));
  const droppedDupes = pool.length - deduped.length;
  if (droppedDupes > 0) log.info(`  Dedup: dropped ${droppedDupes} already-featured film(s) from the ${edition} pool`);
  if (deduped.length === 0) {
    log.info(`  ${meta.notionTitle}: every candidate was featured recently — edition skipped.`);
    return;
  }

  // Per-edition candidate cap: sort THIS pool by popularity, feed up to 40 so
  // a large pool can still reach MAX_WED_DROP_FILMS (or skip) without the tail
  // being crowded out — 40 comfortably exceeds the 15 cap with headroom, and the
  // popularity sort means the strongest survive if a pool is ever huge.
  const featured = [...deduped]
    .sort((a, b) => (b.tmdbPopularity ?? 0) - (a.tmdbPopularity ?? 0))
    .slice(0, 40);
  log.info(`  Feeding ${featured.length} ${edition} candidates to the LLM (picks up to ${MAX_WED_DROP_FILMS} or skips)`);

  // Generate the edition's draft via Claude.
  const draft = await generateWednesdayDrop(featured, edition, windowStart, windowEnd);

  if (draft.slides.length === 0) {
    log.info(`  ${meta.notionTitle}: edition skipped — no films worth publishing this week.`);
    return;
  }

  log.info(`  Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  log.info(`  LLM picked: ${draft.releases.map(r => `${r.title} (${r.language})`).join(", ")}`);

  // Render PNGs (edition-scoped filenames: wed-drop-{slug}-{date}-…).
  const dateStr = format(new Date(), "yyyy-MM-dd");

  // Landing verifier: every carded film must show the right kind of date inside
  // this edition's window — OTT date for "Now Streaming", theatrical date for
  // "In Theaters". Flags drift loudly; HARD_FAIL_ON_INVALID (off) would abort.
  const vbucket = edition === "ott" ? ("ott" as const) : ("theatrical" as const);
  const manifest = buildManifest(`Wed Drop · ${meta.slackLabel}`, issueNumber,
    draft.releases.map(f => ({ film: f, bucket: vbucket })),
    { [vbucket]: { start: windowStart, end: windowEnd, dateField: vbucket === "ott" ? "ott" : "theatrical", label: meta.notionTitle } });
  log.info("\n" + manifestToLog(manifest));
  saveManifest(manifest, `output/manifests/wed-drop-${meta.slug}-${dateStr}.json`);
  assertOrFlag(manifest);

  log.info(`  Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderWedDrop(draft, issueNumber, edition, "output/posts");

  // Strict guard — one card per picked film. The 0-films (skip) case already
  // returned above, so at render time we expect 1..MAX.
  if (renderResult.cardPaths.length < 1 || renderResult.cardPaths.length > MAX_WED_DROP_FILMS) {
    throw new Error(
      `Wed Drop [${edition}] produced ${renderResult.cardPaths.length} cards; expected 1–${MAX_WED_DROP_FILMS}. ` +
      `Check the prompt or rerun.`
    );
  }

  // Upload to R2 under an edition-specific folder: wed-drop/{date}/{slug}/…
  log.info("  Uploading to R2...");
  const uploads = await uploadPngsToR2([
    { localPath: renderResult.coverPath, r2Key: `wed-drop/${dateStr}/${meta.slug}/cover.png` },
    ...renderResult.cardPaths.map((p, i) => ({
      localPath: p,
      r2Key: `wed-drop/${dateStr}/${meta.slug}/card-${String(i + 1).padStart(2, "0")}.png`,
    })),
  ]);
  const cover = uploads[0]!;
  const cardUploads = uploads.slice(1);

  // Build imageUrls keyed card1..cardN dynamically
  const imageUrls: { cover: string; [k: string]: string } = { cover: cover.publicUrl };
  cardUploads.forEach((upload, i) => {
    imageUrls[`card${i + 1}`] = upload.publicUrl;
  });

  // Build richer factual hashtags from metadata + industry/platform umbrella
  // tags, merging the LLM's thematic tags. Used for BOTH Notion and Slack.
  const enrichedHashtags = buildHashtags(draft.releases, draft.hashtags);
  draft.hashtags = enrichedHashtags;

  // Write to Notion (edition-titled page). If this throws, the R2 uploads above
  // are already written (immutable, 1-year cache) — log the orphaned keys for
  // traceability, then re-throw so the job's catch still fires the Slack alert.
  log.info("  Writing Notion draft...");
  let url: string;
  try {
    url = await writeWednesdayDropToNotion(draft, imageUrls, meta.notionTitle);
  } catch (err) {
    log.warn(
      `Notion write failed after R2 upload — ${uploads.length} orphaned R2 object(s) ` +
      `(immutable, 1-year cache): ${uploads.map(u => u.key).join(", ")}`
    );
    throw err;
  }

  // Slack notification (edition-labeled) with cover preview + card previews
  log.info("  Sending Slack notification...");
  await notifyDraftReady({
    pillar: `Wed Drop · ${meta.slackLabel}`,
    emoji: "🎬",
    title: `${meta.slackLabel} · ${windowStart} → ${windowEnd}`,
    subtitle: draft.caption.slice(0, 200) + (draft.caption.length > 200 ? "…" : ""),
    notionUrl: url,
    metadata: {
      "Issue": String(issueNumber),
      "Films": String(draft.releases.length),
      "Languages": Array.from(new Set(draft.releases.map(r => r.language))).join(", "),
    },
    coverImageUrl: cover.publicUrl,
    bodyCardImageUrls: cardUploads.map(u => u.publicUrl),
    hashtags: enrichedHashtags,
    validation: manifestToSlack(manifest),
  });

  // Log the films actually placed on this edition's published cards so a
  // colliding pillar (Mon Movement shares the OTT lane) can't re-feature them.
  recordFeatured(draft.releases, pillarKey, issueNumber);

  log.success(`✅ ${meta.notionTitle} delivered — Notion page: ${url}`);
  log.success(`   Cover: ${cover.publicUrl}`);
}

async function main() {
  log.info("🎬 Wednesday Drop job — starting");

  purgeExpired();

  // Two deliberately different windows, both anchored on the CURRENT calendar
  // week (Mon..Sun, weekStartsOn: 1):
  //  - THEATRICAL = this weekend's cinema openings → Wed→Sun. Users check
  //    midweek for the weekend's theatrical releases, so the window opens on
  //    Wednesday. Mon/Tue theatrical is intentionally Mon Movement's domain and
  //    is left out here.
  //  - OTT = this week's digital drops → Mon→Sun. Streaming stays watchable all
  //    weekend, so this week's earlier OTT arrivals still belong in the post.
  const today = startOfDay(new Date());
  const weekStartMon = startOfWeek(today, { weekStartsOn: 1 }); // Monday
  const wednesday = addDays(weekStartMon, 2);                   // Wednesday
  const sunday = endOfWeek(today, { weekStartsOn: 1 });         // Sunday (end-of-day; discover funcs format to YYYY-MM-DD, so it's fine)

  const startDate = format(wednesday, "yyyy-MM-dd");
  const endDate = format(sunday, "yyyy-MM-dd");
  const ottStartDate = format(weekStartMon, "yyyy-MM-dd");

  log.info(`Theatrical window: ${startDate} → ${endDate}  |  OTT window: ${ottStartDate} → ${endDate}`);

  // 1. Ingest the two pools SEPARATELY — they are NOT merged. Each becomes its
  //    own independent edition (theatrical = In Theaters, ott = Now Streaming).
  const [theatrical, ott] = await Promise.all([
    ingestReleases(startDate, endDate),       // THEATRICAL — Wed→Sun (this weekend's openings)
    ingestOTTArrivals(ottStartDate, endDate), // OTT — Mon→Sun (this week's drops, streamable all weekend)
  ]);
  log.info(`Candidates: ${theatrical.length} theatrical (In Theaters) + ${ott.length} OTT (Now Streaming)`);

  if (theatrical.length === 0 && ott.length === 0) {
    log.warn("No releases in either pool this week — aborting");
    return;
  }

  // 2. Both editions share ONE issue number (it's a pure function of today's
  //    date — see issue-number.ts — so calling the producer twice can't
  //    double-increment it).
  const issueNumber = getIssueNumberForToday();

  // 3. Publish each non-empty edition independently. An edition with an empty
  //    pool, or one the LLM declines (0 picks), publishes nothing.
  if (theatrical.length > 0) {
    await produceEdition("theatrical", theatrical, issueNumber, startDate, endDate);
  } else {
    log.info("In Theaters: no theatrical openings this week — edition skipped.");
  }

  if (ott.length > 0) {
    await produceEdition("ott", ott, issueNumber, ottStartDate, endDate);
  } else {
    log.info("Now Streaming: no OTT arrivals this week — edition skipped.");
  }

  log.success(`\n✅ Wed Drop run complete (Issue №${issueNumber}).`);
}

main()
  .catch(async (err) => {
    log.error("Wednesday Drop job failed", err);
    await notifyJobFailure("Wed Drop", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
  });
