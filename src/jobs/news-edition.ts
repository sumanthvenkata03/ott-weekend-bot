// src/jobs/news-edition.ts
// NEWS DESK · G — The Evening Edition, PHASE 1 (SHADOW).
//
// N2 — SHADOW MEANS SHADOW. This job renders nothing, posts nothing, and writes
// no ledger except news_seen. Its ONLY outward action is a single Slack draft,
// headed so no one can mistake it for output. Run it with `npm run news`.
//
// N5 — the edition's identity is the IST DATE. No issue number, no volume
// counter: like the Evergreens, this pillar has its own life and does not
// borrow the drop's numbering.
//
// Cost: RSS is free. Two Claude CLI calls (verify + caption) over the Max plan —
// no per-call charge — and the verify call is cached 24h, so a same-day re-run
// makes ONE call at most (the caption).
//
// ── RADAR IMPORT NOTE (ruling R4) ────────────────────────────────────────────
// We import readVerdictArchive / readEvergreensPicks / findJudgedMention from
// jobs/reddit-radar.ts. Importing a JOB module is normally the wednesday-drop
// landmine — a bare import executing main() as a side effect. It is SAFE here
// and only here because reddit-radar.ts carries the hardened truthiness guard
// (`argv1.length > 0 && import.meta.url.endsWith(argv1)`), so importing it runs
// nothing. If that guard is ever weakened, this import becomes a live grenade.

import {
  findJudgedMention,
  readEvergreensPicks,
  readVerdictArchive,
  type JudgedFilm,
} from "./reddit-radar.js";
import { gatherNews, WINDOW_HOURS, type NewsItem } from "../content/news/news-gather.js";
import { alreadySeen, markAllSeen } from "../content/news/news-seen.js";
import { clusterItems, scoreClusters, BIG_SCORE_THRESHOLD, TIER_FLOOR_BROAD_OUTLETS, type ScoredCluster } from "../content/news/news-score.js";
import { verifyStories, MAX_VERIFIED_STORIES, type VerifiedStory } from "../content/news/news-verify.js";
import { composeEdition, type ComposedEdition } from "../content/news/news-compose.js";
import { draftCaption } from "../content/news/news-caption.js";
import { postToWebhook } from "../delivery/slack.js";
import { config } from "../shared/config.js";
import { editorialTodayStamp } from "../shared/editorial-clock.js";
import { log } from "../shared/logger.js";

function escapeMd(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slack hard-rejects (400) a section whose text exceeds 3000 chars. */
const SLACK_SECTION_LIMIT = 2900;
/** Slack caps a message at 50 blocks; stay clear of it. */
const SLACK_MAX_BLOCKS = 45;

/**
 * Pack lines into as few section blocks as fit under Slack's per-section limit.
 * A full edition draft (confirmed + held + caption + stats) runs 5-8k chars —
 * comfortably over 3000 — so this is required, not defensive: the first live
 * send failed with a 400 until the draft was chunked. A single line longer than
 * the limit is hard-split rather than dropped.
 */
export function toSectionBlocks(lines: string[]): unknown[] {
  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf !== "") chunks.push(buf);
    buf = "";
  };

  for (const line of lines) {
    let rest = line;
    // Hard-split a single oversized line (a very long headline + basis pair).
    while (rest.length > SLACK_SECTION_LIMIT) {
      flush();
      chunks.push(rest.slice(0, SLACK_SECTION_LIMIT));
      rest = rest.slice(SLACK_SECTION_LIMIT);
    }
    if (buf.length + rest.length + 1 > SLACK_SECTION_LIMIT) flush();
    buf = buf === "" ? rest : `${buf}\n${rest}`;
  }
  flush();

  const kept = chunks.slice(0, SLACK_MAX_BLOCKS);
  if (chunks.length > SLACK_MAX_BLOCKS) {
    kept[kept.length - 1] += `\n_…draft truncated at ${SLACK_MAX_BLOCKS} blocks._`;
  }
  return kept.map((text) => ({ type: "section", text: { type: "mrkdwn", text } }));
}

/** Run counters, reported verbatim in the draft — the honesty surface. */
interface RunStats {
  gathered: number;
  fresh: number;
  deduped: number;
  clusters: number;
  eligible: number;
  verified: number;
  confirmed: number;
}

/**
 * The scoring table — every input that moved a number, printed. This is the
 * artifact the shadow week is FOR: it is how we learn which threshold to move.
 */
function printScoringTable(scored: ScoredCluster[]): void {
  // eslint-disable-next-line no-console
  console.table(
    scored.map((c) => ({
      id: c.id,
      score: c.score,
      class: `${c.storyClass}(${c.classWeight})`,
      tier: `${c.bestTier}(${c.tierPoints})`,
      outlets: `${c.outletCount}(+${c.crossOutletPoints})`,
      judged: c.judgedTitle ? `${c.judgedTitle}(+${c.judgedPoints})` : "—",
      elig: c.eligible ? "yes" : "no",
      why: c.holdReason || "",
      headline: c.headline.slice(0, 54),
    }))
  );
}

/** Confirmed stories rendered as their own rich section; the rest overflow. */
export const RICH_STORY_CAP = 5;
/** Held entries listed with a basis line before the count-only overflow. */
const HELD_LIST_CAP = 8;

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const divider = () => ({ type: "divider" });

/**
 * Build the ONE Slack draft as a Block Kit banner. Exported so the suite can
 * assert its shape.
 *
 * Two invariants carried over from the first live send and NOT to be undone:
 *   • every long text segment goes through toSectionBlocks (Slack 400s on a
 *     section over 3000 chars — the failure that broke send #1);
 *   • the caption is its OWN segment, so a chunk boundary can never fall inside
 *     its ``` fence.
 */
export function buildEditionDraft(
  istDate: string,
  edition: ComposedEdition,
  verified: VerifiedStory[],
  ineligible: ScoredCluster[],
  caption: string,
  stats: RunStats
): { blocks: unknown[]; text: string; plain: string } {
  const head = "🗞 THE EVENING EDITION — SHADOW";
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: head, emoji: true } },
    context(`${istDate} · IST · _shadow draft — not for posting_`),
    section(`*FORMAT:* ${edition.format}\n_${escapeMd(edition.why)}_`),
  ];

  // Plain-text mirror for the console, built alongside so a --no-slack run
  // reads the same as what lands in the channel.
  const plainParts: string[] = [
    `*${head}*`,
    `${istDate} (IST)`,
    "",
    `*FORMAT:* ${edition.format}`,
    `_${edition.why}_`,
  ];

  const confirmed = verified.filter((v) => v.confirmed);
  if (confirmed.length > 0) {
    blocks.push(divider());
    plainParts.push("", "*CONFIRMED*");
    for (const v of confirmed.slice(0, RICH_STORY_CAP)) {
      const c = v.cluster;
      const chip = c.judgedTitle ? ` · ★ ${escapeMd(c.judgedTitle)}` : "";
      // Headline itself is the link — one click to the receipt (N1).
      blocks.push(
        section(
          `*<${v.sourceUrl}|${escapeMd(c.headline)}>*\n` +
            `${escapeMd(c.outlets.join(", "))} · Tier ${c.bestTier} · ${c.storyClass} · score ${c.score}${chip}\n` +
            `_${escapeMd(v.basis)}_`
        )
      );
      plainParts.push(
        `• *${c.headline}*\n   ${c.outlets.join(", ")} · Tier ${c.bestTier} · ${c.storyClass} · score ${c.score}${chip}\n   <${v.sourceUrl}|source> — _${v.basis}_`
      );
    }
    if (confirmed.length > RICH_STORY_CAP) {
      const extra = confirmed.length - RICH_STORY_CAP;
      blocks.push(context(`_…and ${extra} more confirmed ${extra === 1 ? "story" : "stories"} not shown._`));
      plainParts.push(`_…and ${extra} more confirmed._`);
    }
  }

  // Held = verified-but-unconfirmed PLUS everything the eligibility floor
  // stopped before it spent a slot. Both carry a stated reason (N1).
  const heldVerified = verified.filter((v) => !v.confirmed);
  if (heldVerified.length > 0 || ineligible.length > 0) {
    const heldLines: string[] = ["*HELD — UNCONFIRMED*"];
    for (const v of heldVerified) {
      heldLines.push(`• ${escapeMd(v.cluster.headline)}\n   _${escapeMd(v.basis)}_`);
    }
    for (const c of ineligible.slice(0, HELD_LIST_CAP)) {
      heldLines.push(`• ${escapeMd(c.headline)}\n   _not verified: ${escapeMd(c.holdReason)}_`);
    }
    if (ineligible.length > HELD_LIST_CAP) {
      heldLines.push(`_…and ${ineligible.length - HELD_LIST_CAP} more below the eligibility floor._`);
    }
    blocks.push(divider(), ...toSectionBlocks(heldLines));
    plainParts.push("", ...heldLines);
  }

  // Caption: its own segment, fence intact.
  const captionLines = ["*DRAFT CAPTION*", "```", caption, "```"];
  blocks.push(divider(), ...toSectionBlocks(captionLines));

  const statsLine =
    `run: ${stats.gathered} gathered · ${stats.fresh} in ${WINDOW_HOURS}h window · ` +
    `${stats.deduped} new after dedupe · ${stats.clusters} clusters · ` +
    `${stats.eligible} eligible · ${stats.verified} verified · ${stats.confirmed} confirmed`;
  const thresholdLine =
    `thresholds: BIG≥${BIG_SCORE_THRESHOLD} · tier-floor ${TIER_FLOOR_BROAD_OUTLETS} outlets · max ${MAX_VERIFIED_STORIES} verified`;
  blocks.push(context(`_${statsLine}_\n_${thresholdLine}_`));

  const text = `${head} — ${istDate}: ${edition.format}`;
  const plain = [plainParts.join("\n"), captionLines.join("\n"), `_${statsLine}_\n_${thresholdLine}_`].join("\n\n");
  return { blocks, text, plain };
}

/**
 * Resolve the Slack target. The desk posts to #tbsi-news-desk; if that webhook
 * is unset it falls back to the main channel with a stated notice — a draft is
 * never silently dropped, and never silently rerouted either.
 */
export function resolveNewsWebhook(
  newsUrl: string | undefined,
  mainUrl: string | undefined
): { url: string | undefined; fellBack: boolean } {
  if (newsUrl) return { url: newsUrl, fellBack: false };
  return { url: mainUrl, fellBack: true };
}

async function main(opts: { slack: boolean; testBanner: boolean }): Promise<void> {
  const nowMs = Date.now();
  const istDate = editorialTodayStamp(new Date(nowMs));
  log.info(`🗞  Evening Edition (SHADOW) — ${istDate} (IST) · slack=${opts.slack}${opts.testBanner ? " · 🧪 test-banner" : ""}`);

  // 1 — gather (free RSS, already window-filtered)
  log.info("  Gathering across 7 languages…");
  const fresh: NewsItem[] = await gatherNews(nowMs);

  // 2 — dedupe: an item reports once, ever.
  // --test-banner re-renders the day's REAL edition to inspect the banner: it
  // IGNORES the seen-ledger on read and (below) writes nothing to it, so the
  // dedupe contract is untouched and a normal run tomorrow is unaffected. It is
  // NOT a fixture path — no sample data ever enters this job.
  const unseen = opts.testBanner ? fresh : fresh.filter((i) => !alreadySeen(i.url));
  log.info(
    opts.testBanner
      ? `  ${fresh.length} fresh · dedupe BYPASSED for --test-banner (nothing will be marked seen)`
      : `  ${fresh.length} fresh · ${unseen.length} new after dedupe`
  );

  // 3 — cluster + score
  const judged: JudgedFilm[] = [...readVerdictArchive(nowMs), ...readEvergreensPicks()];
  log.info(`  Judged scope: ${judged.length} film(s) for the ★ chip`);
  const clusters = clusterItems(unseen);
  const scored = scoreClusters(clusters, judged, findJudgedMention);
  log.info(`  ${clusters.length} cluster(s) scored:`);
  printScoringTable(scored);

  const eligible = scored.filter((c) => c.eligible);
  const ineligible = scored.filter((c) => !c.eligible);

  // 4 — verify (ONE batched call, cached 24h)
  const verified = await verifyStories(eligible, istDate);

  // 5 — compose
  const edition = composeEdition(verified, fresh.length);
  log.info(`  FORMAT: ${edition.format}`);
  log.info(`  WHY: ${edition.why}`);

  // 6 — caption (labelled UNSWEPT per N3)
  const caption = await draftCaption(edition, istDate);

  const stats: RunStats = {
    gathered: fresh.length,
    fresh: fresh.length,
    deduped: unseen.length,
    clusters: clusters.length,
    eligible: eligible.length,
    verified: verified.length,
    confirmed: verified.filter((v) => v.confirmed).length,
  };

  const { blocks, text, plain } = buildEditionDraft(istDate, edition, verified, ineligible, caption, stats);

  // Always print the draft locally, so a --no-slack run is fully reviewable.
  // eslint-disable-next-line no-console
  console.log(`\n${plain}\n`);

  if (!opts.slack) {
    log.info("  --no-slack: dry run — nothing sent, nothing marked seen.");
    return;
  }

  const { url, fellBack } = resolveNewsWebhook(
    config.SLACK_NEWS_WEBHOOK_URL,
    config.SLACK_WEBHOOK_URL
  );
  if (fellBack) {
    log.info("  ℹ SLACK_NEWS_WEBHOOK_URL unset — posting the draft to the main webhook instead.");
  }
  await postToWebhook(blocks, text, url);

  if (opts.testBanner) {
    log.success("  🧪 test-banner sent · nothing marked seen (dedupe untouched).");
    return;
  }

  // Mark seen only AFTER a successful send (the radar's ordering): a run that
  // failed to deliver must not burn the day's items. Everything CONSIDERED is
  // marked, not just what was published — B's "reports once, ever" is about the
  // item having had its shot, and it keeps the quiet-day path honest.
  markAllSeen(unseen.map((i) => i.url), nowMs);
  log.success(`  Draft sent · ${unseen.length} item(s) marked seen.`);
}

// Hardened truthiness guard — endsWith("") is vacuously true, so the argv1.length
// clause stops a bare import from running main (the runs-main-on-import landmine).
const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMainModule = argv1.length > 0 && import.meta.url.endsWith(argv1);

if (isMainModule) {
  const args = process.argv.slice(2);
  main({
    slack: !args.includes("--no-slack"),
    testBanner: args.includes("--test-banner"),
  }).catch((err) => {
    log.error("Evening Edition failed", err);
    process.exit(1);
  });
}
