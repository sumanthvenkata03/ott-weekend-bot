// src/jobs/monday-movement.ts
import { addDays, format, startOfDay } from "date-fns";
import { ingestReleases, ingestOTTArrivals } from "../ingestion/releases/index.js";
import { pickHiddenGems } from "../content/weekend/spotlight-picker.js";
import { generateMondayMovement } from "../content/weekend/monday-movement.js";
import { writeMovementToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { buildHashtags } from "../shared/hashtags.js";
import { renderMonMovement } from "../rendering/render-mon-movement.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";
import { excludedKeysFor, recordFeatured, filmKey } from "../shared/featured-ledger.js";
import { buildManifest, manifestToLog, manifestToSlack, saveManifest, assertOrFlag } from "../shared/post-validator.js";

async function main() {
  log.info("📰 Monday Movement job — starting");

  purgeExpired();

  // Issue number is a pure function of today's date — compute once and reuse for
  // the ledger's same-issue self-exclusion AND for rendering/Slack below.
  const issueNumber = getIssueNumberForToday();

  const today = startOfDay(new Date());
  const weekEnd = today;                       // up to and including today
  const weekStart = addDays(weekEnd, -7);      // last 7 days

  const startStr = format(weekStart, "yyyy-MM-dd");
  const endStr = format(weekEnd, "yyyy-MM-dd");

  log.info(`Window: ${startStr} → ${endStr}`);

  // Path A: OTT-arrival flagged films (release_type=4)
  const arrivals = await ingestOTTArrivals(startStr, endStr);
  log.info(`Confirmed OTT arrivals: ${arrivals.length}`);

  // Path B: Pull a wider pool for hidden-gem picking (last 90 days)
  const gemPoolStart = format(addDays(today, -90), "yyyy-MM-dd");
  log.info(`Fetching gem pool: ${gemPoolStart} → ${endStr}`);
  const gemPool = await ingestReleases(gemPoolStart, endStr);
  log.info(`Gem pool: ${gemPool.length} candidates`);

  // Cross-pillar dedup: Mon shares a lane with Wed Drop (OTT), so drop anything
  // that lane featured recently (excludeIssue lets a same-issue re-run ignore
  // its own prior featuring). Catch-up framing means the overlooked, not the
  // films midweek already covered.
  const excluded = excludedKeysFor("mon", { excludeIssue: issueNumber });
  const arrivalsDeduped = arrivals.filter(r => !excluded.has(filmKey(r)));
  const gemPoolDeduped = gemPool.filter(r => !excluded.has(filmKey(r)));
  const droppedDupes = (arrivals.length - arrivalsDeduped.length) + (gemPool.length - gemPoolDeduped.length);
  if (droppedDupes > 0) log.info(`Dedup: removed ${droppedDupes} already-featured film(s) (arrivals + gems)`);

  // Exclude arrivals from gem candidates (don't double-feature)
  const arrivalIds = new Set(arrivalsDeduped.map(r => r.id));
  const gems = pickHiddenGems(gemPoolDeduped, 7, arrivalIds);

  log.info(`Top hidden gems picked:`);
  for (const g of gems) {
    console.log(
      `  ${g.title.padEnd(34)} ${g.language.padEnd(10)} ${g.platform.join(", ") || "TBA"}` +
      (g.imdbRating ? ` — IMDb ${g.imdbRating}` : "")
    );
  }

  // Cap arrivals at 10 (carousel real-estate); LLM picks the best UP TO 10 across both buckets.
  const featuredArrivals = arrivalsDeduped.slice(0, 10);

  if (featuredArrivals.length === 0 && gems.length === 0) {
    log.warn("No films to feature — aborting");
    return;
  }

  const draft = await generateMondayMovement(featuredArrivals, gems, startStr, endStr);

  if (draft.slides.length === 0) {
    log.info("Mon Movement: LLM returned no worthwhile films this week — skipping pillar.");
    return;
  }

  const bodySlideMix = draft.slides.filter(s => s.type === "arrival" || s.type === "gem");
  const arrivalCount = bodySlideMix.filter(s => s.type === "arrival").length;
  const gemCount = bodySlideMix.filter(s => s.type === "gem").length;

  log.info(`Week headline: "${draft.weekHeadline}"`);
  log.info(`Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  log.info(`Mix: ${arrivalCount} NEW + ${gemCount} GEM (${bodySlideMix.length} body slides)`);

  // Render PNGs
  const dateStr = format(new Date(), "yyyy-MM-dd");
  log.info(`Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderMonMovement(draft, issueNumber, "output/posts");

  // Strict guard — Mon Movement's design contract is 4–10 body cards (up to 10).
  if (renderResult.cardPaths.length < 4 || renderResult.cardPaths.length > 10) {
    throw new Error(
      `Mon Movement produced ${renderResult.cardPaths.length} cards; expected 4–10. ` +
      `Check the prompt or rerun.`
    );
  }

  // Upload to R2
  log.info("Uploading to R2...");
  const uploads = await uploadPngsToR2([
    { localPath: renderResult.coverPath, r2Key: `mon-movement/${dateStr}/cover.png` },
    ...renderResult.cardPaths.map((p, i) => ({
      localPath: p,
      r2Key: `mon-movement/${dateStr}/card-${String(i + 1).padStart(2, "0")}.png`,
    })),
  ]);
  const cover = uploads[0]!;
  const cardUploads = uploads.slice(1);

  // Build imageUrls keyed card1..cardN dynamically (sorted body-slide order, up to 10)
  const imageUrls: { cover: string; [k: string]: string } = { cover: cover.publicUrl };
  cardUploads.forEach((upload, i) => {
    imageUrls[`card${i + 1}`] = upload.publicUrl;
  });

  // Build richer factual hashtags from metadata + industry/platform umbrella
  // tags, merging the LLM's thematic tags. Used for BOTH Notion and Slack.
  const enrichedHashtags = buildHashtags([...draft.newArrivals, ...draft.hiddenGems], draft.hashtags);
  draft.hashtags = enrichedHashtags;

  // Write to Notion. If this throws, the R2 uploads above are already written
  // (immutable, 1-year cache) — log the orphaned keys for traceability, then
  // re-throw so the job's catch still fires the Slack failure alert.
  log.info("Writing Notion draft...");
  let url: string;
  try {
    url = await writeMovementToNotion(draft, imageUrls);
  } catch (err) {
    log.warn(
      `Notion write failed after R2 upload — ${uploads.length} orphaned R2 object(s) ` +
      `(immutable, 1-year cache): ${uploads.map(u => u.key).join(", ")}`
    );
    throw err;
  }

  // Resolve the films actually placed on the published cards (slide titles →
  // Release records; gem titles arrive prefixed "Hidden Gem: "). Used for BOTH
  // the landing manifest below and the cross-pillar ledger after Slack.
  const featuredTitles = new Set(
    draft.slides
      .filter(s => s.type === "arrival" || s.type === "gem")
      .map(s => s.title.replace(/^Hidden Gem:\s*/i, "").trim().toLowerCase())
  );
  const featured = [...draft.newArrivals, ...draft.hiddenGems]
    .filter(r => featuredTitles.has(r.title.trim().toLowerCase()));

  // Landing verifier: each carded arrival must show an OTT date inside the 7-day
  // arrivals window; each gem a release date inside the 90-day pool window. Flags
  // drift loudly (log + Slack); HARD_FAIL_ON_INVALID (default off) would abort.
  const featuredArrivalIds = new Set(draft.newArrivals.map(r => r.id));
  const filmsForCheck = featured.map(f => ({ film: f, bucket: featuredArrivalIds.has(f.id) ? ("arrival" as const) : ("gem" as const) }));
  const manifest = buildManifest("Mon Movement", issueNumber, filmsForCheck, {
    arrival: { start: startStr, end: endStr, dateField: "ott", label: "New Arrivals · OTT · 7d" },
    gem: { start: gemPoolStart, end: endStr, dateField: "release", label: "Hidden Gems · 90d" },
  });
  log.info("\n" + manifestToLog(manifest));
  saveManifest(manifest, `output/manifests/mon-movement-${dateStr}.json`);
  assertOrFlag(manifest);

  // Slack with cover preview + all body-card previews (up to 10)
  log.info("Sending Slack notification...");
  await notifyDraftReady({
    pillar: "Mon Movement",
    emoji: "📰",
    title: draft.weekLabel,
    subtitle: draft.weekHeadline,
    notionUrl: url,
    metadata: {
      "Issue": String(issueNumber),
      "Mix": `${arrivalCount} NEW · ${gemCount} GEM`,
      "Films": String(bodySlideMix.length),
    },
    coverImageUrl: cover.publicUrl,
    bodyCardImageUrls: cardUploads.map(u => u.publicUrl),
    hashtags: enrichedHashtags,
    validation: manifestToSlack(manifest),
  });

  // Cross-pillar ledger: record the featured films AFTER notifyDraftReady so a
  // colliding pillar (Mon shares the OTT lane with Wed Drop) can't re-feature them.
  recordFeatured(featured, "mon", issueNumber);

  log.success(`\n✅ Mon Movement PREVIEW delivered — Notion page: ${url}`);
  log.success(`   Cover: ${cover.publicUrl}`);
}

main()
  .catch(async (err) => {
    log.error("Monday Movement job failed", err);
    await notifyJobFailure("Mon Movement", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
  });
