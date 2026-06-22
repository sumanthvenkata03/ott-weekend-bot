// src/shared/featured-ledger.test.ts
// Pure-logic self-test for the cross-pillar dedup ledger. No db writes, no
// network, no LLM. Run: npx tsx src/shared/featured-ledger.test.ts
import { log } from "./logger.js";
import {
  filmKey,
  laneFor,
  selectExcludedKeys,
  COOLDOWN_DAYS,
  type FeaturedRow,
} from "./featured-ledger.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) { pass++; log.info(`  ✓ ${label}`); }
  else { fail++; log.error(`  ✗ FAIL: ${label}`); }
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

check("filmKey prefers imdbId", filmKey({ imdbId: "tt1", tmdbId: 9, title: "X" }) === "tt1");
check("filmKey falls back to tmdb", filmKey({ tmdbId: 9, title: "X" }) === "tmdb:9");
check("filmKey falls back to title slug", filmKey({ title: "Thank You Subbarao!" }) === "title:thank-you-subbarao");

check("mon lane includes wed-ott", laneFor("mon").includes("wed-ott"));
check("wed-ott lane includes mon", laneFor("wed-ott").includes("mon"));
check("sat lane is independent", laneFor("sat").length === 1 && laneFor("sat")[0] === "sat");
check("wed-theatrical is its own lane", !laneFor("wed-theatrical").includes("wed-ott"));

const rows: FeaturedRow[] = [
  { film_key: "ttRecentWed", pillar: "wed-ott", issue: "001", featured_at: now - 3 * DAY, title: "Recent Wed" },
  { film_key: "ttOldWed", pillar: "wed-ott", issue: "000", featured_at: now - (COOLDOWN_DAYS + 5) * DAY, title: "Old Wed" },
  { film_key: "ttSat", pillar: "sat", issue: "003", featured_at: now - 1 * DAY, title: "Sat film" },
  { film_key: "ttSelf", pillar: "mon", issue: "005", featured_at: now - 1 * DAY, title: "This issue" },
];
const excl = selectExcludedKeys(rows, { lane: laneFor("mon"), cooldownDays: COOLDOWN_DAYS, now, excludeIssue: "005" });

check("recent wed-ott film is excluded for mon", excl.has("ttRecentWed"));
check("film past cooldown is NOT excluded", !excl.has("ttOldWed"));
check("sat film does NOT block mon (per-pair)", !excl.has("ttSat"));
check("same-issue self-featuring is ignored", !excl.has("ttSelf"));

log.info(`\nfeatured-ledger: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
