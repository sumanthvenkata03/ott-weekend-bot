// src/index.ts
import { addDays, format, nextFriday, startOfDay } from "date-fns";
import { discoverIndianReleases } from "./ingestion/releases/tmdb.js";
import { log } from "./shared/logger.js";

async function main() {
  log.info("🎬 OTT Weekend Bot — ingestion run starting");
  
  // Calculate "this weekend" — next Friday through Sunday
  const today = startOfDay(new Date());
  const friday = nextFriday(today);
  const sunday = addDays(friday, 2);
  
  const startDate = format(friday, "yyyy-MM-dd");
  const endDate = format(sunday, "yyyy-MM-dd");
  
  log.info(`Weekend window: ${startDate} → ${endDate}`);
  
  const releases = await discoverIndianReleases(startDate, endDate);
  
  if (releases.length === 0) {
    log.warn("No releases found. Either it's a quiet weekend or TMDb is slow to update.");
    log.info("Try expanding the date range — e.g., next 14 days — to confirm pipeline works.");
    return;
  }
  
  log.success(`Pipeline OK — ${releases.length} releases ingested`);
  
  // Show top 5 by language coverage
  log.info("\nSample releases:");
  for (const r of releases.slice(0, 5)) {
    console.log(`\n  ${r.title} (${r.language})`);
    console.log(`    Released: ${r.releaseDate}`);
    console.log(`    Genres: ${r.genre.join(", ") || "—"}`);
    console.log(`    Synopsis: ${r.synopsis.slice(0, 100)}${r.synopsis.length > 100 ? "..." : ""}`);
  }
}

main().catch(err => {
  log.error("Pipeline failed", err);
  process.exit(1);
});