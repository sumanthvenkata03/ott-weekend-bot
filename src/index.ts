// src/index.ts
import { addDays, format, nextFriday, startOfDay } from "date-fns";
import { ingestReleases } from "./ingestion/releases/index.js";
import { log } from "./shared/logger.js";
import { purgeExpired, cacheStats } from "./shared/cache.js";

async function main() {
  log.info("🎬 OTT Weekend Bot — ingestion run starting");

  purgeExpired();
  const stats = cacheStats();
  log.info(`Cache: ${stats.total} entries (${stats.expired} expired)`);

  const today = startOfDay(new Date());
  // src/index.ts
  const friday = nextFriday(today);
  const sunday = addDays(friday, 21);

  const startDate = format(friday, "yyyy-MM-dd");
  const endDate = format(sunday, "yyyy-MM-dd");

  log.info(`Window: ${startDate} → ${endDate}`);

  const releases = await ingestReleases(startDate, endDate);

  if (releases.length === 0) {
    log.warn("No releases found.");
    return;
  }

  // Language breakdown
  log.info("\nBy language:");
  const byLang = new Map<string, number>();
  for (const r of releases) byLang.set(r.language, (byLang.get(r.language) ?? 0) + 1);
  for (const [lang, count] of [...byLang.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${lang.padEnd(12)} ${count}`);
  }

  // Platform breakdown
  log.info("\nBy platform (films streaming):");
  const byPlat = new Map<string, number>();
  for (const r of releases) {
    for (const p of r.platform) byPlat.set(p, (byPlat.get(p) ?? 0) + 1);
  }
  if (byPlat.size === 0) {
    console.log("  (none — most upcoming releases don't have platforms assigned yet)");
  } else {
    for (const [plat, count] of [...byPlat.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${plat.padEnd(15)} ${count}`);
    }
  }

  // Top rated
  const rated = releases
    .filter(r => r.imdbRating !== undefined)
    .sort((a, b) => (b.imdbRating ?? 0) - (a.imdbRating ?? 0));

  if (rated.length > 0) {
    log.info("\nTop-rated:");
    for (const r of rated.slice(0, 3)) {
      console.log(`\n  ${r.title} (${r.language})`);
      console.log(`    ${r.releaseDate}  |  IMDb ${r.imdbRating} (${r.imdbVotes ?? 0} votes)`);
      console.log(`    Streaming: ${r.platform.length > 0 ? r.platform.join(", ") : "—"}`);
      console.log(`    Director: ${r.director ?? "—"}`);
      console.log(`    Cast: ${r.cast.slice(0, 3).join(", ") || "—"}`);
    }
  }

  // Streaming-ready upcoming
  const streamingUpcoming = releases.filter(r => r.platform.length > 0 && r.imdbRating === undefined);
  if (streamingUpcoming.length > 0) {
    log.info(`\nUpcoming, already on a platform (${streamingUpcoming.length}):`);
    for (const r of streamingUpcoming.slice(0, 5)) {
      console.log(`  • ${r.title.padEnd(36)} ${r.language.padEnd(10)} ${r.platform.join(", ")}`);
    }
  }
}

main().catch(err => {
  log.error("Pipeline failed", err);
  process.exit(1);
});