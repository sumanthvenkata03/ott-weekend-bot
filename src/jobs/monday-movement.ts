// src/jobs/monday-movement.ts
import { addDays, format, startOfDay } from "date-fns";
import { ingestReleases, ingestOTTArrivals } from "../ingestion/releases/index.js";
import { pickHiddenGems } from "../content/weekend/spotlight-picker.js";
import { generateMondayMovement } from "../content/weekend/monday-movement.js";
import { writeMovementToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";

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
  // Films that have IMDb data + platform availability tend to be the gems
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
  
  // Cap arrivals at 4 (carousel real-estate)
  const featuredArrivals = arrivals.slice(0, 4);
  
  if (featuredArrivals.length === 0 && gems.length === 0) {
    log.warn("No films to feature — aborting");
    return;
  }
  
  const draft = await generateMondayMovement(featuredArrivals, gems, startStr, endStr);
  
  log.info(`Week headline: "${draft.weekHeadline}"`);
  log.info(`Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  
  const url = await writeMovementToNotion(draft);
  
  log.success(`\n🎉 Monday Movement draft is in Notion:\n   ${url}\n   Review and post manually.`);
}

main().catch(err => {
  log.error("Monday Movement job failed", err);
  process.exit(1);
});
