// src/jobs/wednesday-drop.ts
import { addDays, format, nextFriday, startOfDay } from "date-fns";
import { ingestReleases } from "../ingestion/releases/index.js";
import { generateWednesdayDrop } from "../content/weekend/wednesday-drop.js";
import { writeWednesdayDropToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";

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
  
  // 2. Pick top N by signal — for now, just take all (max 8)
  // Week 2 will replace this with proper Hype Score ranking
  const featured = allReleases.slice(0, 8);
  log.info(`Featuring ${featured.length} releases in the drop`);
  
  // 3. Generate the draft via Claude Code
  const draft = await generateWednesdayDrop(featured, startDate, endDate);
  log.info(`Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  
  // 4. Write to Notion
  const url = await writeWednesdayDropToNotion(draft);
  
  log.success(`\n🎉 Wednesday Drop draft is in Notion:\n   ${url}\n   Review and post manually.`);
}

main().catch(err => {
  log.error("Wednesday Drop job failed", err);
  process.exit(1);
});