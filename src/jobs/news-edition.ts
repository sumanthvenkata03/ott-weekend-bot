// src/jobs/news-edition.ts
// NEWS DESK · G — TBSI NEWS DESK, PHASE 2 (post package).
//
// The desk no longer emits a text draft. It emits a POST PACKAGE: segment-
// classified stories, card(s) rendered in the published design system, a SWEPT
// caption, hashtag split, badge-check board, and pinned-comment text — delivered
// to #tbsi-news-desk as previews + zip. The owner posts by hand, anytime.
//
// "THE EVENING EDITION" is gone from every user-visible surface (the file and
// job names stay — internal identity is not a user surface).
//
// N4 (quiet-day honesty) and N5 (IST date is the identity — no issue numbers)
// are unchanged. markAllSeen still runs ONLY after a successful send.
//
// ── RADAR IMPORT NOTE (ruling R4, Phase 1) ───────────────────────────────────
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
import {
  clusterItems,
  scoreClusters,
  BIG_SCORE_THRESHOLD,
  TIER_FLOOR_BROAD_OUTLETS,
  type ScoredCluster,
} from "../content/news/news-score.js";
import { verifyStories, MAX_VERIFIED_STORIES, type VerifiedStory } from "../content/news/news-verify.js";
import { resolveStories, type ResolvedStory } from "../content/news/news-resolve.js";
import { composeEdition, type ComposedEdition } from "../content/news/news-compose.js";
import { buildPackage, type NewsPackage } from "../content/news/news-caption.js";
import { renderNews, NEWS_SLUG, type NewsRenderResult } from "../rendering/render-news.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngToR2 } from "../delivery/r2-upload.js";
import { buildAndUploadDeckZip, writeCaptionFile } from "../delivery/deliver-deck-zip.js";
import { postToWebhook } from "../delivery/slack.js";
import { config } from "../shared/config.js";
import { editorialTodayStamp } from "../shared/editorial-clock.js";
import { log } from "../shared/logger.js";

function escapeMd(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slack hard-rejects (400) a section whose text exceeds 3000 chars. */
const SLACK_SECTION_LIMIT = 2900;
const SLACK_MAX_BLOCKS = 45;

/**
 * Pack lines into as few section blocks as fit under Slack's per-section limit.
 * Required, not defensive: the first Phase-1 live send failed with a 400 until
 * the draft was chunked. A single oversized line is hard-split, never dropped.
 */
export function toSectionBlocks(lines: string[]): unknown[] {
  const chunks: string[] = [];
  let buf = "";
  const flush = () => { if (buf !== "") chunks.push(buf); buf = ""; };

  for (const line of lines) {
    let rest = line;
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
    kept[kept.length - 1] += `\n_…truncated at ${SLACK_MAX_BLOCKS} blocks._`;
  }
  return kept.map((text) => ({ type: "section", text: { type: "mrkdwn", text } }));
}

interface RunStats {
  gathered: number;
  deduped: number;
  clusters: number;
  eligible: number;
  verified: number;
  confirmed: number;
  resolved: number;
  rendered: number;
}

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
      headline: c.headline.slice(0, 50),
    }))
  );
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const divider = () => ({ type: "divider" });

/**
 * EPHEMERAL RUNS — one internal mechanism, two user-facing modes.
 *
 *   --now          on-demand editorial run. A REAL surface: no TEST label, the
 *                  owner is meant to act on it.
 *   --test-banner  verification run. Labelled TEST.
 *
 * Both share exactly the same three deviations from the scheduled run:
 *   (a) the seen-ledger is BYPASSED ON READ — you get the full current 26h
 *       picture, so stories already reported this morning CAN repeat;
 *   (b) markAllSeen is NEVER called;
 *   (c) the Slack header says which mode it was.
 *
 * TRADEOFF, stated deliberately: because (b) writes nothing, an on-demand run
 * does NOT consume the day's items, so the 7 AM scheduled cadence is completely
 * untouched by it — but the same story may therefore appear in both an
 * on-demand package and the next scheduled one. That is the right way round:
 * the automated cadence is the thing that must stay predictable, and a human
 * asking "what's happening right now" wants the full picture, not the
 * remainder after the morning already took its share.
 */
// ── STANDING LAW: DRY-RUN BEFORE SEND ───────────────────────────────────────
//
//   npm run news -- --no-slack
//
// Builds the FULL package — gather, score, scope gate, verify, resolve, compose,
// the caption call WITH schema validation and the name sweep, and every card
// render — then prints it and sends NOTHING. No Slack post, no R2 upload, no
// zip, no ledger write.
//
// This is now the required first step of any verification. It exists because
// three live sends were burned on faults a dry run would have caught for free:
// a caption schema mismatch, a sweep firing on false positives, and a broken
// pill asset. Live sends are for proving delivery, not for finding bugs.
export type RunMode = "scheduled" | "now" | "test";

export const isEphemeral = (mode: RunMode): boolean => mode !== "scheduled";

/** "HH:mm" of the IST wall clock — the on-demand header's timestamp. */
export function istClockTime(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  return `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
}

/** The Slack header for a run. On-demand is a real editorial surface — no TEST. */
export function headerFor(mode: RunMode, clock: string): string {
  if (mode === "test") return "🧪 TEST · 🗞 TBSI NEWS DESK — today's suggestions";
  if (mode === "now") return `🗞 TBSI NEWS DESK — on-demand · ${clock} IST`;
  return "🗞 TBSI NEWS DESK — today's suggestions";
}

export interface PackageDelivery {
  previewUrls: string[];
  zipUrl?: string;
}

/**
 * The caption text embedded in the deck zip — everything needed to post without
 * opening anything else: caption, the in-caption hashtag set, the first-comment
 * set, and the pinned comment. A HELD caption says so in the file rather than
 * shipping a blank the owner might paste by accident.
 */
export function zipCaptionText(pkg: NewsPackage): string {
  if (pkg.heldFor.length > 0) {
    return `CAPTION HELD — unbacked names: ${pkg.heldFor.join(", ")}\nDo not post this deck until the copy is rewritten.`;
  }
  const parts = [pkg.caption.trim(), "", pkg.captionHashtags.join(" ")];
  if (pkg.commentHashtags.length > 0) {
    parts.push("", "— FIRST COMMENT —", pkg.commentHashtags.join(" "));
  }
  if (pkg.pinnedComment) parts.push("", "— PINNED COMMENT —", pkg.pinnedComment);
  return parts.join("\n");
}

/** Build the Slack package message. Exported so the suite can assert its shape. */
export function buildPackageMessage(
  istDate: string,
  edition: ComposedEdition,
  pkg: NewsPackage,
  delivery: PackageDelivery,
  verified: VerifiedStory[],
  ineligible: ScoredCluster[],
  stats: RunStats,
  mode: RunMode,
  clock = ""
): { blocks: unknown[]; text: string; plain: string } {
  const head = headerFor(mode, clock);
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: head, emoji: true } },
    context(`${istDate} · IST · _suggestions for manual posting — nothing is published automatically_`),
    section(`*FORMAT:* \`${edition.format}\`\n_${escapeMd(edition.why)}_`),
  ];
  const plain: string[] = [head, `${istDate} (IST)`, "", `FORMAT: ${edition.format}`, edition.why];

  // ── Stories, each with its SEGMENT badge ──
  const shown = edition.cover
    ? [edition.cover, ...edition.cards.filter((c) => c !== edition.cover)]
    : edition.cards;
  if (shown.length > 0) {
    blocks.push(divider());
    plain.push("", "STORIES");
    for (const s of shown) {
      const c = s.resolved.story.cluster;
      const film = s.resolved.film;
      const art = film?.posterUrl ? `poster (${film.confidence})` : "typographic";
      const chip = c.judgedTitle ? ` · ★ ${escapeMd(c.judgedTitle)}` : "";
      blocks.push(
        section(
          `\`${s.segment.badge}\`  *<${s.resolved.story.sourceUrl}|${escapeMd(c.headline)}>*\n` +
            `${escapeMd(c.outlets.slice(0, 4).join(", "))} · Tier ${c.bestTier} · ${c.storyClass} · score ${c.score}${chip}\n` +
            `_${escapeMd(s.segmentReason)} · art: ${art}_`
        )
      );
      plain.push(`[${s.segment.badge}] ${c.headline} — ${c.outlets.join(", ")} · score ${c.score} · ${art}`);
    }
  }

  // ── Card previews + zip ──
  if (delivery.previewUrls.length > 0) {
    blocks.push(divider());
    const links = delivery.previewUrls.map((u, i) => `<${u}|card ${String(i + 1).padStart(2, "0")}>`).join("  ·  ");
    blocks.push(section(`*CARDS*\n${links}${delivery.zipUrl ? `\n\n📦 <${delivery.zipUrl}|download deck .zip>` : "\n_single card — no zip_"}`));
    plain.push("", "CARDS", ...delivery.previewUrls, delivery.zipUrl ?? "(no zip — single card)");
  }

  // ── Caption ──
  blocks.push(divider());
  const captionLines = pkg.heldFor.length
    ? [`*CAPTION — HELD*`, `_unbacked names: ${pkg.heldFor.join(", ")}_`]
    : [
        "*CAPTION* _(copy below)_",
        "```",
        pkg.caption,
        "",
        pkg.captionHashtags.join(" "),
        "```",
        `_first comment:_ \`${pkg.commentHashtags.join(" ")}\``,
      ];
  blocks.push(...toSectionBlocks(captionLines));
  plain.push("", ...captionLines);

  // ── Badge-check board (§3 law 7 — no tick, no tag) ──
  if (pkg.badgeCheckBoard.length > 0) {
    const rows = pkg.badgeCheckBoard.map(
      (b) => `• ${escapeMd(b.name)} — ${b.candidateHandle ? `candidate \`${escapeMd(b.candidateHandle)}\`` : "_no handle suggested_"}`
    );
    blocks.push(divider(), ...toSectionBlocks([
      "*BADGE CHECK — verify before tagging*",
      "_No tick, no tag. These are candidates only; nothing is auto-tagged._",
      ...rows,
    ]));
    plain.push("", "BADGE CHECK", ...rows);
  }

  if (pkg.pinnedComment) {
    blocks.push(...toSectionBlocks(["*PINNED COMMENT*", "```", pkg.pinnedComment, "```"]));
  }

  // ── Held + stats ──
  const heldVerified = verified.filter((v) => !v.confirmed);
  const droppedLines = edition.dropped.map((d) => `• ${escapeMd(d.headline)}\n   _${escapeMd(d.reason)}_`);
  if (heldVerified.length || ineligible.length || droppedLines.length) {
    const lines = ["*HELD*"];
    for (const v of heldVerified) lines.push(`• ${escapeMd(v.cluster.headline)}\n   _${escapeMd(v.basis)}_`);
    lines.push(...droppedLines);
    for (const c of ineligible.slice(0, 5)) lines.push(`• ${escapeMd(c.headline)}\n   _${escapeMd(c.holdReason)}_`);
    if (ineligible.length > 5) lines.push(`_…and ${ineligible.length - 5} more below the eligibility floor._`);
    blocks.push(divider(), ...toSectionBlocks(lines));
    plain.push("", ...lines);
  }

  const statsLine =
    `run: ${stats.gathered} gathered · ${stats.deduped} new · ${stats.clusters} clusters · ` +
    `${stats.eligible} eligible · ${stats.verified} verified · ${stats.confirmed} confirmed · ` +
    `${stats.resolved} resolved · ${stats.rendered} rendered`;
  const thresholdLine =
    `thresholds: BIG≥${BIG_SCORE_THRESHOLD} · tier-floor ${TIER_FLOOR_BROAD_OUTLETS} · max ${MAX_VERIFIED_STORIES} verified · window ${WINDOW_HOURS}h`;
  blocks.push(context(`_${statsLine}_\n_${thresholdLine}_`));
  plain.push("", statsLine, thresholdLine);

  return { blocks, text: `${head} — ${istDate}: ${edition.format}`, plain: plain.join("\n") };
}

/** Route to #tbsi-news-desk; fall back to the main channel with a stated notice. */
export function resolveNewsWebhook(
  newsUrl: string | undefined,
  mainUrl: string | undefined
): { url: string | undefined; fellBack: boolean } {
  if (newsUrl) return { url: newsUrl, fellBack: false };
  return { url: mainUrl, fellBack: true };
}

async function main(opts: { slack: boolean; mode: RunMode }): Promise<void> {
  const nowMs = Date.now();
  const istDate = editorialTodayStamp(new Date(nowMs));
  const clock = istClockTime(new Date(nowMs));
  const ephemeral = isEphemeral(opts.mode);
  log.info(`🗞  TBSI News Desk — ${istDate} ${clock} IST · mode=${opts.mode} · slack=${opts.slack}`);

  // 1 — gather
  log.info("  Gathering across 7 languages…");
  const fresh: NewsItem[] = await gatherNews(nowMs);

  // 2 — dedupe (--test-banner bypasses on READ and writes nothing)
  const unseen = ephemeral ? fresh : fresh.filter((i) => !alreadySeen(i.url));
  log.info(
    ephemeral
      ? `  ${fresh.length} fresh · dedupe BYPASSED (--${opts.mode}) · nothing will be marked seen`
      : `  ${fresh.length} fresh · ${unseen.length} new after dedupe`
  );

  // 3 — cluster + score
  const judged: JudgedFilm[] = [...readVerdictArchive(nowMs), ...readEvergreensPicks()];
  const clusters = clusterItems(unseen);
  const scored = scoreClusters(clusters, judged, findJudgedMention);
  log.info(`  ${clusters.length} cluster(s) scored (judged scope ${judged.length}):`);
  printScoringTable(scored);
  const eligible = scored.filter((c) => c.eligible);
  const ineligible = scored.filter((c) => !c.eligible);

  // 4 — verify (ONE batched call, cached 24h)
  const verified = await verifyStories(eligible, istDate);
  const confirmed = verified.filter((v) => v.confirmed);

  // 5 — resolve film entities (POST-VERIFY, confirmed only)
  const windowYear = Number.parseInt(istDate.slice(0, 4), 10);
  const resolved: ResolvedStory[] = confirmed.length
    ? await resolveStories(confirmed, judged, findJudgedMention, windowYear)
    : [];
  for (const r of resolved) log.info(`  resolve · ${r.reason}`);

  // 6 — compose (poster-aware)
  const edition = composeEdition(resolved, fresh.length);
  log.info(`  FORMAT: ${edition.format}`);
  log.info(`  WHY: ${edition.why}`);
  for (const d of edition.dropped) log.info(`  dropped · ${d.headline} — ${d.reason}`);

  // 7 — caption + package. Built BEFORE delivery on purpose: the deck zip
  // embeds the real swept caption, so the caption has to exist first. A zip
  // that says "see Slack" is not grab-and-post — it forces the owner back to
  // another window at the moment they are trying to publish.
  const pkg = await buildPackage(edition, istDate);
  if (pkg.heldFor.length) log.warn(`  Caption HELD — unbacked names: ${pkg.heldFor.join(", ")}`);

  // 8 — render + deliver (skipped entirely on a quiet day)
  let render: NewsRenderResult = { cardPaths: [], notes: [] };
  const delivery: PackageDelivery = { previewUrls: [] };
  if (edition.format !== "none") {
    render = await renderNews(edition, istDate, pkg.cardCopy);
    for (const n of render.notes) log.info(`  render · ${n}`);
    await closeBrowser();

    if (opts.slack) {
      // PNGs → R2 under news/<date>/
      for (const p of [render.coverPath, ...render.cardPaths].filter((p): p is string => Boolean(p))) {
        const name = p.split(/[\\/]/).pop()!;
        const { publicUrl } = await uploadPngToR2(p, `news/${istDate}/${name}`);
        delivery.previewUrls.push(publicUrl);
      }
      // Deck zip only when there IS a deck (cover + cards). A single card ships
      // as a direct PNG link — zipping one image would be theatre.
      if (render.coverPath && render.cardPaths.length > 0) {
        try {
          await writeCaptionFile("output/posts", istDate, zipCaptionText(pkg), NEWS_SLUG);
          const zip = await buildAndUploadDeckZip({ outputDir: "output/posts", date: istDate, slug: NEWS_SLUG });
          delivery.zipUrl = zip.url;
        } catch (err) {
          log.warn(`  deck zip skipped — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  const stats: RunStats = {
    gathered: fresh.length,
    deduped: unseen.length,
    clusters: clusters.length,
    eligible: eligible.length,
    verified: verified.length,
    confirmed: confirmed.length,
    resolved: resolved.filter((r) => r.film).length,
    rendered: render.cardPaths.length + (render.coverPath ? 1 : 0),
  };

  const { blocks, text, plain } = buildPackageMessage(
    istDate, edition, pkg, delivery, verified, ineligible, stats, opts.mode, clock
  );

  // eslint-disable-next-line no-console
  console.log(`\n${plain}\n`);

  if (!opts.slack) {
    log.info("  --no-slack: dry run — nothing sent, nothing marked seen.");
    return;
  }

  const { url, fellBack } = resolveNewsWebhook(config.SLACK_NEWS_WEBHOOK_URL, config.SLACK_WEBHOOK_URL);
  if (fellBack) log.info("  ℹ SLACK_NEWS_WEBHOOK_URL unset — posting to the main webhook instead.");
  await postToWebhook(blocks, text, url);

  if (ephemeral) {
    log.success(`  Package sent (--${opts.mode}) · nothing marked seen — the scheduled cadence is untouched.`);
    return;
  }

  // Mark seen only AFTER a successful send: a run that failed to deliver must
  // not burn the day's items.
  markAllSeen(unseen.map((i) => i.url), nowMs);
  log.success(`  Package sent · ${unseen.length} item(s) marked seen.`);
}

// Hardened truthiness guard — endsWith("") is vacuously true, so the argv1.length
// clause stops a bare import from running main (the runs-main-on-import landmine).
const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMainModule = argv1.length > 0 && import.meta.url.endsWith(argv1);

if (isMainModule) {
  const args = process.argv.slice(2);
  const mode: RunMode = args.includes("--test-banner")
    ? "test"
    : args.includes("--now")
      ? "now"
      : "scheduled";
  main({ slack: !args.includes("--no-slack"), mode }).catch((err) => {
    log.error("News Desk failed", err);
    process.exit(1);
  });
}
