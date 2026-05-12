// src/jobs/sunday-spotlight.ts
import { addDays, format, startOfDay } from "date-fns";
import { ingestReleases } from "../ingestion/releases/index.js";
import { pickSpotlight } from "../content/weekend/spotlight-picker.js";
import { generateSundaySpotlight } from "../content/weekend/sunday-spotlight.js";
import { writeSundaySpotlightToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";

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
  
  const url = await writeSundaySpotlightToNotion(draft);
  
  log.success(`\n🎉 Sunday Spotlight draft is in Notion:\n   ${url}\n   Review and post manually.`);
}

main().catch(err => {
  log.error("Sunday Spotlight job failed", err);
  process.exit(1);
});