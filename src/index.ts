// src/index.ts
import { addDays, format, nextFriday, startOfDay } from "date-fns";
import { ingestReleases } from "./ingestion/releases/index.js";
import { log } from "./shared/logger.js";

async function main() {
  log.info("🎬 OTT Weekend Bot — ingestion run starting");
  
  const today = startOfDay(new Date());
  const friday = nextFriday(today);
const sunday = addDays(friday, 21);
  
  const startDate = format(friday, "yyyy-MM-dd");
  const endDate = format(sunday, "yyyy-MM-dd");
  
  log.info(`Window: ${startDate} → ${endDate}`);
  
  const releases = await ingestReleases(startDate, endDate);
  
  if (releases.length === 0) {
    log.warn("No releases found. Try widening the date range further.");
    return;
  }
  
  log.success(`Pipeline OK — ${releases.length} releases fully enriched`);
  
  // Sort by IMDb rating desc, show top 5 with full enrichment
  const rated = releases
    .filter(r => r.imdbRating !== undefined)
    .sort((a, b) => (b.imdbRating ?? 0) - (a.imdbRating ?? 0));
  
  log.info("\nTop-rated releases (by IMDb):");
  for (const r of rated.slice(0, 5)) {
    console.log(`\n  ${r.title} (${r.language})`);
    console.log(`    Released: ${r.releaseDate}`);
    console.log(`    Director: ${r.director ?? "—"}`);
    console.log(`    Cast: ${r.cast.slice(0, 3).join(", ") || "—"}`);
    console.log(`    Runtime: ${r.runtime ? `${r.runtime} min` : "—"}`);
    console.log(`    IMDb: ${r.imdbRating ?? "—"} (${r.imdbVotes ?? 0} votes)`);
    console.log(`    Rotten Tomatoes: ${r.rottenTomatoes ?? "—"}%`);
    console.log(`    Genres: ${r.genre.join(", ") || "—"}`);
  }
  
  // Show the unrated ones too — most upcoming films won't have IMDb ratings yet
  const unrated = releases.filter(r => r.imdbRating === undefined);
  if (unrated.length > 0) {
    log.info(`\n${unrated.length} releases without IMDb ratings yet (normal for unreleased films):`);
    for (const r of unrated.slice(0, 3)) {
      console.log(`  • ${r.title} (${r.language}) — ${r.releaseDate}`);
    }
  }
}

main().catch(err => {
  log.error("Pipeline failed", err);
  process.exit(1);
});