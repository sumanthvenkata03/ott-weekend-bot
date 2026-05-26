// src/jobs/wednesday-drop.ts
import { addDays, format, nextFriday, startOfDay } from "date-fns";
import { ingestReleases } from "../ingestion/releases/index.js";
import { generateWednesdayDrop } from "../content/weekend/wednesday-drop.js";
import { writeWednesdayDropToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady } from "../delivery/slack.js";
import { renderWedDrop } from "../rendering/render-wed-drop.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";

async function main() {
  log.info("🎬 Wednesday Drop job — starting");

  purgeExpired();

  // Target this weekend
  const today = startOfDay(new Date());
  const friday = nextFriday(today);
  const sunday = addDays(friday, 2);

  const startDate = format(friday, "yyyy-MM-dd");
  const endDate = format(sunday, "yyyy-MM-dd");

  log.info(`Target weekend: ${startDate} → ${endDate}`);

  // 1. Ingest
  const allReleases = await ingestReleases(startDate, endDate);

  if (allReleases.length === 0) {
    log.warn("No releases for this weekend — aborting");
    return;
  }

  // 2. Feed the LLM up to 8 candidates and let it pick the 4 most worth talking about.
  //    The content generator trims draft.releases to exactly those 4 picks.
  const featured = allReleases.slice(0, 8);
  log.info(`Feeding ${featured.length} candidates to the LLM (it will pick 4 or skip)`);

  // 3. Generate the draft via Claude
  const draft = await generateWednesdayDrop(featured, startDate, endDate);

  if (draft.slides.length === 0) {
    log.info("Wed Drop: LLM returned no worthwhile films this week — skipping pillar.");
    return;
  }

  log.info(`Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  log.info(`LLM picked: ${draft.releases.map(r => `${r.title} (${r.language})`).join(", ")}`);

  // 4. Render PNGs
  const issueNumber = getIssueNumberForToday();
  const dateStr = format(new Date(), "yyyy-MM-dd");
  log.info(`Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderWedDrop(draft, issueNumber, "output/posts");

  // Strict guard — Wed Drop's design contract is exactly 4 body cards
  if (renderResult.cardPaths.length !== 4) {
    throw new Error(
      `Wed Drop produced ${renderResult.cardPaths.length} cards; expected exactly 4. ` +
      `Check the prompt or rerun.`
    );
  }

  // 5. Upload to R2
  log.info("Uploading to R2...");
  const uploads = await uploadPngsToR2([
    { localPath: renderResult.coverPath, r2Key: `wed-drop/${dateStr}/cover.png` },
    ...renderResult.cardPaths.map((p, i) => ({
      localPath: p,
      r2Key: `wed-drop/${dateStr}/card-${String(i + 1).padStart(2, "0")}.png`,
    })),
  ]);
  const cover = uploads[0]!;
  const cardUploads = uploads.slice(1);

  // Build imageUrls keyed card1..card4 dynamically
  const imageUrls: { cover: string; [k: string]: string } = { cover: cover.publicUrl };
  cardUploads.forEach((upload, i) => {
    imageUrls[`card${i + 1}`] = upload.publicUrl;
  });

  // 6. Write to Notion
  log.info("Writing Notion draft...");
  const url = await writeWednesdayDropToNotion(draft, imageUrls);

  // 7. Slack notification with cover preview + 4 card previews
  log.info("Sending Slack notification...");
  await notifyDraftReady({
    pillar: "Wed Drop",
    emoji: "🎬",
    title: `Weekend of ${startDate} → ${endDate}`,
    subtitle: draft.caption.slice(0, 200) + (draft.caption.length > 200 ? "…" : ""),
    notionUrl: url,
    metadata: {
      "Issue": String(issueNumber),
      "Films": String(draft.releases.length),
      "Languages": Array.from(new Set(draft.releases.map(r => r.language))).join(", "),
    },
    coverImageUrl: cover.publicUrl,
    bodyCardImageUrls: cardUploads.map(u => u.publicUrl),
  });

  log.success(`\n✅ Wed Drop PREVIEW delivered — Notion page: ${url}`);
  log.success(`   Cover: ${cover.publicUrl}`);
}

main()
  .catch(err => {
    log.error("Wednesday Drop job failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
  });