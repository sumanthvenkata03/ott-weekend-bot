// src/shared/issue-number.ts
// Deterministic global issue numbering across all 5 pillars.
//
// LAUNCH ANCHOR: 2026-06-16T00:00:00Z. Issue 001 is the first POSTING DAY
// at or after this anchor — which is June 17, 2026 (Wed Drop), because
// June 16 is a Tuesday and Tuesday is not in the posting set.
//
// Posting days (5/week): Mon, Wed, Thu, Sat, Sun.
// Posts BEFORE the launch anchor → "PREVIEW".

import { log } from "./logger.js";

const LAUNCH = new Date("2026-06-16T00:00:00Z");

// 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
const POSTING_DAYS_OF_WEEK = new Set<number>([0, 1, 3, 4, 6]);

export function getIssueNumber(postDate: Date): string {
  if (postDate < LAUNCH) return "PREVIEW";

  let count = 0;
  const cursor = new Date(LAUNCH);
  while (cursor <= postDate) {
    if (POSTING_DAYS_OF_WEEK.has(cursor.getUTCDay())) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return String(count).padStart(3, "0");
}

export function getIssueNumberForToday(): string {
  return getIssueNumber(new Date());
}

// Cross-platform main-module check (matches the pattern used in
// src/rendering/render-sun-spotlight.ts — Windows path safety).
const isMainModule = import.meta.url.endsWith(
  (process.argv[1] ?? "").replace(/\\/g, "/")
);

if (isMainModule) {
  const cases: Array<{ label: string; date: Date; expect?: string }> = [
    { label: "May 31, 2026 (Sun, pre-launch)", date: new Date("2026-05-31T12:00:00Z"), expect: "PREVIEW" },
    { label: "June 16, 2026 (Tue, launch day — not a posting day)", date: new Date("2026-06-16T12:00:00Z"), expect: "000" },
    { label: "June 17, 2026 (Wed Drop — first ever post)", date: new Date("2026-06-17T12:00:00Z"), expect: "001" },
    { label: "June 18, 2026 (Thu Compare)", date: new Date("2026-06-18T12:00:00Z"), expect: "002" },
    { label: "June 20, 2026 (Sat Verdict)", date: new Date("2026-06-20T12:00:00Z"), expect: "003" },
    { label: "June 21, 2026 (Sun Spotlight)", date: new Date("2026-06-21T12:00:00Z"), expect: "004" },
    { label: "June 22, 2026 (Mon Movement)", date: new Date("2026-06-22T12:00:00Z"), expect: "005" },
    { label: "Today (real)", date: new Date() },
  ];

  for (const c of cases) {
    const got = getIssueNumber(c.date);
    const tag = c.expect ? (got === c.expect ? "✓" : "✗ FAIL") : " ";
    const want = c.expect ? `  (expected ${c.expect})` : "";
    log.info(`${tag} ${c.label.padEnd(48)} → ${got}${want}`);
  }
}
