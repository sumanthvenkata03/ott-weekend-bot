// src/jobs/reddit-radar.ts
// PART B — the Reddit thread radar. READS ONLY (L1): it pings Slack, a human does
// the rest (no posting/commenting/voting/auth). Two detectors across the sub map:
//   1. REQUEST THREADS — r/<sub>/new, ≤7 days, title matching a keyword list.
//   2. JUDGED-FILM MENTIONS — thread titles naming a film we've judged in the
//      last 30 days (verdicts archive, latest-per-film) or an Evergreens pick.
// Each thread pings ONCE ever (radar_seen). Max 5 pings/run. ZERO cost.
//
// Pings carry ONLY already-published copy (L3): title · ★ · verdict · the
// movie.html link WITH &src=reddit (the GoatCounter scoreboard — never omitted).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBREDDIT_MAP, fetchSubredditNew, type RedditPost } from "../ingestion/reddit-rss.js";
import { alreadySeen, markSeen } from "../ingestion/radar-seen.js";
import { postToWebhook } from "../delivery/slack.js";
import { db } from "../shared/cache.js";
import { editorialTodayStamp } from "../shared/editorial-clock.js";
import { log } from "../shared/logger.js";
import type { VerdictLogEntry } from "../content/weekend/research-archive.js";

const SITE = "https://thebigscreenindex.com";
const MAX_PINGS = 5;
const ARCHIVE_ROOT = join("data", "research-archive");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Request-thread keyword list — EDITABLE. Matched case-insensitively. */
export const REQUEST_KEYWORDS = [
  "what to watch",
  "recommend",
  "suggestion",
  "suggestions",
  "weekend",
  "kya dekhu",
  "enna padam",
];

export interface JudgedFilm {
  title: string;
  imdbId?: string;
  star: number | null;
  verdict: string | null;
  source: "verdict" | "evergreens";
  vol?: number;
}

export interface RadarHit {
  post: RedditPost;
  reason: string;
  judged?: JudgedFilm;
}

// ── Pure matchers (unit-tested) ──────────────────────────────────────────────

/** The request keyword a title matches, or null. */
export function matchesRequestKeyword(title: string): string | null {
  const t = title.toLowerCase();
  for (const kw of REQUEST_KEYWORDS) if (t.includes(kw.toLowerCase())) return kw;
  return null;
}

/** The first judged film named in a title (case-insensitive substring), or null.
 *  Titles < 3 chars are skipped — too short to match without noise. */
export function findJudgedMention(title: string, films: JudgedFilm[]): JudgedFilm | null {
  const t = title.toLowerCase();
  for (const f of films) {
    if (f.title.length >= 3 && t.includes(f.title.toLowerCase())) return f;
  }
  return null;
}

/** True if `publishedISO` is within `days` before `nowMs` (and not in the future). */
export function withinDays(publishedISO: string, days: number, nowMs: number): boolean {
  const t = Date.parse(publishedISO);
  if (Number.isNaN(t)) return false;
  return t <= nowMs && nowMs - t <= days * DAY_MS;
}

// ── Judged-film sources (fresh-checkout tolerant — RE) ───────────────────────

/** Last-30-days judged films from the verdicts archive, reduced latest-per-film.
 *  Absent dir / unreadable files / empty archive → [] (never throws). */
export function readVerdictArchive(nowMs: number): JudgedFilm[] {
  if (!existsSync(ARCHIVE_ROOT)) return [];
  let files: string[];
  try {
    files = readdirSync(ARCHIVE_ROOT).filter((f) => /^verdicts-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const cutoff = nowMs - 30 * DAY_MS;
  const latest = new Map<string, VerdictLogEntry>();
  for (const file of files) {
    const dateMs = Date.parse(`${file.slice(9, 19)}T00:00:00Z`);
    if (!Number.isNaN(dateMs) && dateMs < cutoff) continue; // file older than 30d
    let text: string;
    try {
      text = readFileSync(join(ARCHIVE_ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: VerdictLogEntry;
      try {
        e = JSON.parse(line) as VerdictLogEntry;
      } catch {
        continue;
      }
      if (!e.title) continue;
      const prev = latest.get(e.title);
      if (!prev || e.runAt > prev.runAt) latest.set(e.title, e); // latestPerFilm
    }
  }
  return [...latest.values()].map((e) => ({
    title: e.title,
    ...(e.imdbId ? { imdbId: e.imdbId } : {}),
    star: e.star,
    verdict: e.verdict,
    source: "verdict" as const,
  }));
}

/** Evergreens picks (title + VOL) from the shared ledger table. Table absent → []. */
export function readEvergreensPicks(): JudgedFilm[] {
  try {
    const rows = db
      .prepare("SELECT title, vol FROM archives_featured")
      .all() as { title: string | null; vol: number }[];
    return rows
      .filter((r) => r.title)
      .map((r) => ({ title: r.title as string, star: null, verdict: null, source: "evergreens" as const, vol: r.vol }));
  } catch {
    return []; // fresh checkout / table never created
  }
}

// ── Ping (extracted helper) ──────────────────────────────────────────────────

function escapeMd(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function movieLink(imdbId: string): string {
  return `${SITE}/movie.html?id=${encodeURIComponent(imdbId)}&src=reddit`;
}

/** Build the Slack blocks + fallback text for one thread ping. Exported for test. */
export function buildThreadPing(hit: RadarHit, test = false): { blocks: unknown[]; text: string } {
  const { post, reason, judged } = hit;
  const head = `${test ? "🧪 TEST · " : ""}🛰️ Reddit radar`;
  const parts = [
    `*${head}*`,
    `r/${escapeMd(post.sub)} · <${post.link}|${escapeMd(post.title)}>`,
    `_${escapeMd(reason)}_`,
  ];
  if (judged?.source === "verdict") {
    const star = judged.star != null ? `★${judged.star}` : "★—";
    const link = judged.imdbId ? ` → <${movieLink(judged.imdbId)}|thebigscreenindex.com>` : "";
    parts.push(`Our take: *${escapeMd(judged.title)}* ${star} · ${escapeMd(judged.verdict ?? "—")}${link}`);
  } else if (judged?.source === "evergreens") {
    const link = judged.imdbId ? ` → <${movieLink(judged.imdbId)}|thebigscreenindex.com>` : "";
    parts.push(`The Evergreens · VOL. ${String(judged.vol ?? 0).padStart(3, "0")} · *${escapeMd(judged.title)}*${link}`);
  }
  return { blocks: [{ type: "section", text: { type: "mrkdwn", text: parts.join("\n") } }], text: `${head}: ${post.title}` };
}

// ── Scan ─────────────────────────────────────────────────────────────────────

/** Scan every mapped sub's /new feed, apply both detectors, dedupe, cap at
 *  MAX_PINGS. Pure of side effects except the RSS reads + alreadySeen lookups. */
async function scan(judged: JudgedFilm[], nowMs: number): Promise<RadarHit[]> {
  const subs = [...new Set(Object.values(SUBREDDIT_MAP))];
  const hits: RadarHit[] = [];
  for (const sub of subs) {
    if (hits.length >= MAX_PINGS) break;
    const posts = await fetchSubredditNew(sub);
    for (const post of posts) {
      if (hits.length >= MAX_PINGS) break;
      if (alreadySeen(post.id)) continue;
      const mention = findJudgedMention(post.title, judged);
      if (mention) {
        hits.push({ post, reason: `judged mention: ${mention.title}`, judged: mention });
        continue;
      }
      const kw = matchesRequestKeyword(post.title);
      if (kw && withinDays(post.publishedISO, 7, nowMs)) {
        hits.push({ post, reason: `request thread: "${kw}"` });
      }
    }
  }
  return hits;
}

async function main(opts: { slack: boolean; test: boolean }): Promise<void> {
  const nowMs = Date.now();
  log.info(`🛰️  Reddit radar — ${editorialTodayStamp()} (IST) · slack=${opts.slack} test=${opts.test}`);

  const judged = [...readVerdictArchive(nowMs), ...readEvergreensPicks()];
  log.info(`  Judged scope: ${judged.length} film(s) (verdicts 30d + Evergreens picks)`);

  const hits = (await scan(judged, nowMs)).slice(0, MAX_PINGS);
  log.info(`  Detected ${hits.length} new thread(s) (cap ${MAX_PINGS}):`);
  // eslint-disable-next-line no-console
  console.table(
    hits.map((h) => ({
      sub: `r/${h.post.sub}`,
      reason: h.reason,
      title: h.post.title.slice(0, 56),
      link: h.judged?.imdbId ? movieLink(h.judged.imdbId) : h.post.link,
    }))
  );

  if (opts.test) {
    // ONE real ping, marked 🧪 TEST, NOT marked seen (repeatable). Uses the first
    // real hit, or a synthetic demo so the Slack path is exercised with no data.
    const hit: RadarHit =
      hits[0] ??
      {
        post: {
          id: "test-synthetic",
          title: "[demo] what to watch this weekend?",
          link: `${SITE}/`,
          author: "/u/tbsi",
          sub: "tollywood",
          publishedISO: new Date(nowMs).toISOString(),
          snippet: "",
        },
        reason: 'request thread: "what to watch" (synthetic demo)',
      };
    const { blocks, text } = buildThreadPing(hit, true);
    await postToWebhook(blocks, text);
    log.success("  🧪 TEST ping sent (not marked seen).");
    return;
  }

  if (!opts.slack) {
    log.info("  --no-slack: dry run — nothing pinged, nothing marked seen.");
    return;
  }

  for (const hit of hits) {
    const { blocks, text } = buildThreadPing(hit);
    await postToWebhook(blocks, text);
    markSeen(hit.post.id); // once ever — only after a real ping
  }
  log.success(`  Pinged ${hits.length} thread(s).`);
}

// Hardened truthiness guard — endsWith("") is vacuously true, so the argv1.length
// clause stops a bare import from running main (the runs-main-on-import landmine).
const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMainModule = argv1.length > 0 && import.meta.url.endsWith(argv1);

if (isMainModule) {
  const args = process.argv.slice(2);
  const opts = { slack: !args.includes("--no-slack"), test: args.includes("--test") };
  main(opts).catch((err) => {
    log.error("Reddit radar failed", err);
    process.exit(1);
  });
}
