// src/jobs/saturday-verdict.ts
import { addDays, format, startOfDay, previousFriday, isFriday } from "date-fns";
import { ingestReleases } from "../ingestion/releases/index.js";
import { generateSaturdayVerdict } from "../content/weekend/saturday-verdict.js";
import { writeSaturdayVerdictToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { buildHashtags } from "../shared/hashtags.js";
import { renderSatVerdict } from "../rendering/render-sat-verdict.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";
/**
 * Pick the weekend window for "this Saturday":
 * - If today IS Sat/Sun: this weekend (Fri-Sun)
 * - If today is Mon-Fri: the upcoming Fri-Sun
 *
 * For the Saturday Verdict cron, this runs on Saturday morning targeting
 * the Friday that just passed through the Sunday coming up.
 */
function pickWeekend(now: Date): { startDate: string; endDate: string } {
  const today = startOfDay(now);
  const dow = today.getDay();   // 0=Sun, 5=Fri, 6=Sat
  
  let friday: Date;
  if (dow === 5) friday = today;                              // It's Friday
  else if (dow === 6) friday = addDays(today, -1);            // Saturday → yesterday
  else if (dow === 0) friday = addDays(today, -2);            // Sunday → two days ago
  else friday = isFriday(today) ? today : previousFriday(addDays(today, 7));  // Mon-Thu → upcoming Fri
  
  const sunday = addDays(friday, 2);
  return {
    startDate: format(friday, "yyyy-MM-dd"),
    endDate: format(sunday, "yyyy-MM-dd"),
  };
}

async function main() {
  log.info("⚖️  Saturday Verdict job — starting");
  
  purgeExpired();
  
  const { startDate, endDate } = pickWeekend(new Date());
  log.info(`Target weekend: ${startDate} → ${endDate}`);
  
  const releases = await ingestReleases(startDate, endDate);
  if (releases.length === 0) {
    log.warn("No releases for this weekend — aborting");
    return;
  }
  
  // Cap at 6 — verdict carousels get long fast and engagement drops past slide 7
  const featured = releases.slice(0, 6);
  log.info(`Featuring ${featured.length} releases in the verdict`);
  
  const draft = await generateSaturdayVerdict(featured, startDate, endDate);
  log.info(`Hot take: "${draft.hotTake}"`);
  log.info(`Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  
  // Verdict tally for quick sanity check
  const tally = draft.verdicts.reduce<Record<string, number>>((acc, v) => {
    acc[v.verdict] = (acc[v.verdict] ?? 0) + 1;
    return acc;
  }, {});
  log.info(`Verdict tally: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join("  ")}`);

  const today = new Date();
  const issueNumber = getIssueNumberForToday();
  const dateStr = format(today, "yyyy-MM-dd");

  log.info(`Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderSatVerdict(draft, issueNumber, "output/posts");

  // Quality gate: LLM is told to produce 3-5 cards. If it didn't, fail loudly
  // so we don't ship a malformed carousel.
  const cardCount = renderResult.cardPaths.length;
  if (cardCount < 3 || cardCount > 5) {
    throw new Error(
      `Sat Verdict produced ${cardCount} cards; expected 3-5. Check LLM prompt or rerun.`
    );
  }

  log.info("Uploading to R2...");
  const uploads = await uploadPngsToR2([
    { localPath: renderResult.coverPath, r2Key: `sat-verdict/${dateStr}/cover.png` },
    ...renderResult.cardPaths.map((p, i) => ({
      localPath: p,
      r2Key: `sat-verdict/${dateStr}/card-${String(i + 1).padStart(2, "0")}.png`,
    })),
  ]);
  const cover = uploads[0]!;
  const cardUploads = uploads.slice(1);

  // Build imageUrls keyed card1..cardN dynamically so Notion attaches one image per verdict.
  const imageUrls: { cover: string; [k: string]: string } = { cover: cover.publicUrl };
  cardUploads.forEach((upload, i) => {
    imageUrls[`card${i + 1}`] = upload.publicUrl;
  });

  // Build richer factual hashtags from metadata + industry/platform umbrella
  // tags, merging the LLM's thematic tags. Used for BOTH Notion and Slack.
  const enrichedHashtags = buildHashtags(draft.releases, draft.hashtags);
  draft.hashtags = enrichedHashtags;

  // Write to Notion. If this throws, the R2 uploads above are already written
  // (immutable, 1-year cache) — log the orphaned keys for traceability, then
  // re-throw so the job's catch still fires the Slack failure alert.
  log.info("Writing Notion draft...");
  let url: string;
  try {
    url = await writeSaturdayVerdictToNotion(draft, imageUrls);
  } catch (err) {
    log.warn(
      `Notion write failed after R2 upload — ${uploads.length} orphaned R2 object(s) ` +
      `(immutable, 1-year cache): ${uploads.map(u => u.key).join(", ")}`
    );
    throw err;
  }

  log.info("Sending Slack notification...");
  await notifyDraftReady({
    pillar: "Sat Verdict",
    emoji: "⚖️",
    title: `Weekend of ${startDate} → ${endDate}`,
    subtitle: draft.hotTake,
    notionUrl: url,
    metadata: {
      "Issue": String(issueNumber),
      "Verdicts": Object.entries(tally).map(([k, v]) => `${k} ${v}`).join("  "),
      "Films": String(draft.verdicts.length),
    },
    coverImageUrl: cover.publicUrl,
    bodyCardImageUrls: cardUploads.map(u => u.publicUrl),
    hashtags: enrichedHashtags,
  });

  log.success(`\n✅ Sat Verdict PREVIEW delivered — Notion page: ${url}`);
  log.success(`   Cover: ${cover.publicUrl}`);
}

main()
  .catch(async (err) => {
    log.error("Saturday Verdict job failed", err);
    await notifyJobFailure("Sat Verdict", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
  });