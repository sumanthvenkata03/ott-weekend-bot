// src/jobs/monday-movement.ts
import { addDays, format, startOfDay } from "date-fns";
import { ingestReleases, ingestOTTArrivals } from "../ingestion/releases/index.js";
import { pickHiddenGems } from "../content/weekend/spotlight-picker.js";
import { generateMondayMovement } from "../content/weekend/monday-movement.js";
import { writeMovementToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { renderMonMovement } from "../rendering/render-mon-movement.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";

async function main() {
  log.info("📰 Monday Movement job — starting");

  purgeExpired();

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

  // Exclude arrivals from gem candidates (don't double-feature)
  const arrivalIds = new Set(arrivals.map(r => r.id));
  const gems = pickHiddenGems(gemPool, 3, arrivalIds);

  log.info(`Top hidden gems picked:`);
  for (const g of gems) {
    console.log(
      `  ${g.title.padEnd(34)} ${g.language.padEnd(10)} ${g.platform.join(", ") || "TBA"}` +
      (g.imdbRating ? ` — IMDb ${g.imdbRating}` : "")
    );
  }

  // Cap arrivals at 4 (carousel real-estate); LLM will pick exactly 5 across both buckets.
  const featuredArrivals = arrivals.slice(0, 4);

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
  const issueNumber = getIssueNumberForToday();
  const dateStr = format(new Date(), "yyyy-MM-dd");
  log.info(`Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderMonMovement(draft, issueNumber, "output/posts");

  // Strict guard — Mon Movement's design contract is exactly 5 body cards
  if (renderResult.cardPaths.length !== 5) {
    throw new Error(
      `Mon Movement produced ${renderResult.cardPaths.length} cards; expected exactly 5. ` +
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

  // Build imageUrls keyed card1..card5 dynamically (slide order, not bucket order)
  const imageUrls: { cover: string; [k: string]: string } = { cover: cover.publicUrl };
  cardUploads.forEach((upload, i) => {
    imageUrls[`card${i + 1}`] = upload.publicUrl;
  });

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

  // Slack with cover preview + all 5 card previews
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
  });

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
