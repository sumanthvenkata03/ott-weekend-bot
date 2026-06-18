// src/jobs/sunday-spotlight.ts
import { addDays, format, startOfDay } from "date-fns";
import { ingestReleases } from "../ingestion/releases/index.js";
import { pickSpotlight } from "../content/weekend/spotlight-picker.js";
import { generateSundaySpotlight } from "../content/weekend/sunday-spotlight.js";
import { writeSundaySpotlightToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { buildHashtags } from "../shared/hashtags.js";
import { renderSunSpotlight } from "../rendering/render-sun-spotlight.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";

/**
 * Sunday Spotlight runs on Sunday morning, targeting the just-passed weekend.
 * If run any other day, targets the most recent Fri-Sun.
 */
function pickWeekend(now: Date): { startDate: string; endDate: string } {
  const today = startOfDay(now);
  const dow = today.getDay();   // 0=Sun

  let sunday: Date;
  if (dow === 0) sunday = today;                // It's Sunday — target today
  else if (dow >= 1 && dow <= 4) sunday = addDays(today, -dow);   // Mon-Thu → most recent Sun
  else sunday = addDays(today, dow === 5 ? 2 : 1);                // Fri/Sat → upcoming Sun

  const friday = addDays(sunday, -2);
  return {
    startDate: format(friday, "yyyy-MM-dd"),
    endDate: format(sunday, "yyyy-MM-dd"),
  };
}

async function main() {
  log.info("🎬 Sunday Spotlight job — starting");

  purgeExpired();

  const { startDate, endDate } = pickWeekend(new Date());
  log.info(`Target weekend: ${startDate} → ${endDate}`);

  const allReleases = await ingestReleases(startDate, endDate);
  if (allReleases.length === 0) {
    log.warn("No releases for spotlight — aborting");
    return;
  }

  // Pick the ONE film
  const film = pickSpotlight(allReleases);
  if (!film) {
    log.warn("Picker returned null — aborting");
    return;
  }

  log.success(`Spotlight pick: ${film.title} (${film.language})`);

  const draft = await generateSundaySpotlight(film, startDate, endDate);

  log.info(`Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  log.info(`Reel hook: "${draft.reelScript.hook}"`);

  const today = new Date();
  const issueNumber = getIssueNumberForToday();
  const dateStr = format(today, "yyyy-MM-dd");

  log.info(`Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderSunSpotlight(draft, today, issueNumber, "output/posts");

  log.info("Uploading to R2...");
  const [coverFeed, coverReel, card1, card2] = await uploadPngsToR2([
    { localPath: renderResult.feedCoverPath, r2Key: `sun-spotlight/${dateStr}/cover-feed.png` },
    { localPath: renderResult.reelCoverPath, r2Key: `sun-spotlight/${dateStr}/cover-reel.png` },
    { localPath: renderResult.card1Path,     r2Key: `sun-spotlight/${dateStr}/card-01.png` },
    { localPath: renderResult.card2Path,     r2Key: `sun-spotlight/${dateStr}/card-02.png` },
  ]);

  // Build richer factual hashtags from metadata + industry/platform umbrella
  // tags, merging the LLM's thematic tags. Used for BOTH Notion and Slack.
  const enrichedHashtags = buildHashtags([film], draft.hashtags);
  draft.hashtags = enrichedHashtags;

  // Write to Notion. If this throws, the R2 uploads above are already written
  // (immutable, 1-year cache) — log the orphaned keys for traceability, then
  // re-throw so the job's catch still fires the Slack failure alert.
  log.info("Writing Notion draft...");
  let url: string;
  try {
    url = await writeSundaySpotlightToNotion(draft, {
      coverFeed: coverFeed.publicUrl,
      coverReel: coverReel.publicUrl,
      card1: card1.publicUrl,
      card2: card2.publicUrl,
    });
  } catch (err) {
    log.warn(
      `Notion write failed after R2 upload — 4 orphaned R2 object(s) ` +
      `(immutable, 1-year cache): ${[coverFeed, coverReel, card1, card2].map(u => u?.key).join(", ")}`
    );
    throw err;
  }

  log.info("Sending Slack notification...");
  await notifyDraftReady({
    pillar: "Sun Spotlight",
    emoji: "🎬",
    title: `${film.title} (${film.language})`,
    subtitle: draft.reelScript.hook,
    notionUrl: url,
    metadata: {
      "Issue": issueNumber,
      "Language": film.language,
      "Platform": film.platform.length ? film.platform.join(", ") : "TBA",
      ...(film.imdbRating ? { "IMDb": `${film.imdbRating} (${film.imdbVotes ?? 0} votes)` } : {}),
    },
    coverImageUrl: coverFeed.publicUrl,
    bodyCardImageUrls: [card1.publicUrl, card2.publicUrl],
    hashtags: enrichedHashtags,
  });

  log.success(`\n✅ Sun Spotlight ${issueNumber} delivered`);
  log.success(`   Notion: ${url}`);
  log.success(`   Cover:  ${coverFeed.publicUrl}`);
}

main()
  .catch(async (err) => {
    log.error("Sunday Spotlight job failed", err);
    await notifyJobFailure("Sun Spotlight", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
  });
