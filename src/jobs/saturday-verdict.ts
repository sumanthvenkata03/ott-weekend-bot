// src/jobs/saturday-verdict.ts
import { addDays, format, startOfDay, previousFriday, isFriday } from "date-fns";
import { ingestReleases } from "../ingestion/releases/index.js";
import { generateSaturdayVerdict } from "../content/weekend/saturday-verdict.js";
import { writeSaturdayVerdictToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady } from "../delivery/slack.js";
/**
 * Pick the weekend window for "this Saturday":
 * - If today IS Sat/Sun: this weekend (Fri-Sun)
 * - If today is Mon-Fri: the upcoming Fri-Sun
 *
 * For the Saturday Verdict cron, this runs on Saturday morning targeting
 * the Friday that just passed through the Sunday coming up.
 */
function pickWeekend(now: Date): { startDate: string; endDate: string } {
  const today = startOfDay(now);
  const dow = today.getDay();   // 0=Sun, 5=Fri, 6=Sat
  
  let friday: Date;
  if (dow === 5) friday = today;                              // It's Friday
  else if (dow === 6) friday = addDays(today, -1);            // Saturday → yesterday
  else if (dow === 0) friday = addDays(today, -2);            // Sunday → two days ago
  else friday = isFriday(today) ? today : previousFriday(addDays(today, 7));  // Mon-Thu → upcoming Fri
  
  const sunday = addDays(friday, 2);
  return {
    startDate: format(friday, "yyyy-MM-dd"),
    endDate: format(sunday, "yyyy-MM-dd"),
  };
}

async function main() {
  log.info("⚖️  Saturday Verdict job — starting");
  
  purgeExpired();
  
  const { startDate, endDate } = pickWeekend(new Date());
  log.info(`Target weekend: ${startDate} → ${endDate}`);
  
  const releases = await ingestReleases(startDate, endDate);
  if (releases.length === 0) {
    log.warn("No releases for this weekend — aborting");
    return;
  }
  
  // Cap at 6 — verdict carousels get long fast and engagement drops past slide 7
  const featured = releases.slice(0, 6);
  log.info(`Featuring ${featured.length} releases in the verdict`);
  
  const draft = await generateSaturdayVerdict(featured, startDate, endDate);
  log.info(`Hot take: "${draft.hotTake}"`);
  log.info(`Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  
  // Verdict tally for quick sanity check
  const tally = draft.verdicts.reduce<Record<string, number>>((acc, v) => {
    acc[v.verdict] = (acc[v.verdict] ?? 0) + 1;
    return acc;
  }, {});
  log.info(`Verdict tally: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join("  ")}`);
  
  const url = await writeSaturdayVerdictToNotion(draft);

  await notifyDraftReady({
    pillar: "Sat Verdict",
    emoji: "⚖️",
    title: `Weekend of ${startDate} → ${endDate}`,
    subtitle: draft.hotTake,
    notionUrl: url,
    metadata: {
      "Verdicts": Object.entries(tally).map(([k, v]) => `${k} ${v}`).join("  "),
      "Films": String(draft.verdicts.length),
    },
  });
  
  log.success(`\n🎉 Saturday Verdict draft is in Notion:\n   ${url}\n   Review and post manually.`);
}

main().catch(err => {
  log.error("Saturday Verdict job failed", err);
  process.exit(1);
});