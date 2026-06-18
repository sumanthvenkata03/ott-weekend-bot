// src/jobs/thursday-compare.ts
import { addDays, format, nextFriday, startOfDay } from "date-fns";
import { ingestReleases } from "../ingestion/releases/index.js";
import { pickFaceOff } from "../content/weekend/compare-picker.js";
import { generateThursdayCompare } from "../content/weekend/thursday-compare.js";
import { writeCompareToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
async function main() {
  log.info("⚔️  Thursday Compare job — starting");
  
  purgeExpired();
  
  // Target the upcoming Fri-Sun
  const today = startOfDay(new Date());
const friday = nextFriday(today);
const sunday = addDays(friday, 2);
  
  const startDate = format(friday, "yyyy-MM-dd");
  const endDate = format(sunday, "yyyy-MM-dd");
  
  log.info(`Target weekend: ${startDate} → ${endDate}`);
  
  const releases = await ingestReleases(startDate, endDate);
  if (releases.length < 2) {
    log.warn(`Only ${releases.length} releases — need at least 2 for a compare. Aborting.`);
    return;
  }
  
  const pair = pickFaceOff(releases);
  if (!pair) {
    log.warn("Face-off picker rejected all pairs (weak production signal). Skipping Thu Compare this week — better to post nothing than a weak compare.");
    return;
  }
  
  const [filmA, filmB] = pair;
  log.success(`Face-off: ${filmA.title} (${filmA.language}) vs ${filmB.title} (${filmB.language})`);
  
  const draft = await generateThursdayCompare(filmA, filmB, startDate, endDate);
  
  log.info(`Hook: "${draft.reelScript.hook}"`);
  log.info(`Deciding line: "${draft.reelScript.decidingLine}"`);
  log.info(`Pinned hot take: "${draft.pinnedCommentSeed}"`);
  
  const url = await writeCompareToNotion(draft);
  await notifyDraftReady({
    pillar: "Thu Compare",
    emoji: "⚔️",
    title: `${filmA.title} (${filmA.language}) vs ${filmB.title} (${filmB.language})`,
    subtitle: draft.reelScript.decidingLine,
    notionUrl: url,
    metadata: {
      "Hot take": draft.pinnedCommentSeed.slice(0, 150),
    },
  });
  log.success(`\n🎉 Thursday Compare draft is in Notion:\n   ${url}\n   Review and post manually.`);
}

main().catch(async (err) => {
  log.error("Thursday Compare job failed", err);
  await notifyJobFailure("Thu Compare", err instanceof Error ? err.message : String(err));
  process.exit(1);
});