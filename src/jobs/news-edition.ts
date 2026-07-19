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

export interface PackageDelivery {
  previewUrls: string[];
  zipUrl?: string;
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
  test: boolean
): { blocks: unknown[]; text: string; plain: string } {
  const head = `${test ? "🧪 TEST · " : ""}🗞 TBSI NEWS DESK — today's suggestions`;
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

async function main(opts: { slack: boolean; testBanner: boolean }): Promise<void> {
  const nowMs = Date.now();
  const istDate = editorialTodayStamp(new Date(nowMs));
  log.info(`🗞  TBSI News Desk — ${istDate} (IST) · slack=${opts.slack}${opts.testBanner ? " · 🧪 test" : ""}`);

  // 1 — gather
  log.info("  Gathering across 7 languages…");
  const fresh: NewsItem[] = await gatherNews(nowMs);

  // 2 — dedupe (--test-banner bypasses on READ and writes nothing)
  const unseen = opts.testBanner ? fresh : fresh.filter((i) => !alreadySeen(i.url));
  log.info(
    opts.testBanner
      ? `  ${fresh.length} fresh · dedupe BYPASSED for --test-banner (nothing marked seen)`
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

  // 7 — render + 8 — caption/package (skipped entirely on a quiet day)
  let render: NewsRenderResult = { cardPaths: [], notes: [] };
  const delivery: PackageDelivery = { previewUrls: [] };
  if (edition.format !== "none") {
    render = await renderNews(edition, istDate);
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
          await writeCaptionFile("output/posts", istDate, "(see Slack package)", NEWS_SLUG);
          const zip = await buildAndUploadDeckZip({ outputDir: "output/posts", date: istDate, slug: NEWS_SLUG });
          delivery.zipUrl = zip.url;
        } catch (err) {
          log.warn(`  deck zip skipped — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  const pkg = await buildPackage(edition, istDate);
  if (pkg.heldFor.length) log.warn(`  Caption HELD — unbacked names: ${pkg.heldFor.join(", ")}`);

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
    istDate, edition, pkg, delivery, verified, ineligible, stats, opts.testBanner
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

  if (opts.testBanner) {
    log.success("  🧪 test package sent · nothing marked seen (dedupe untouched).");
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
  main({
    slack: !args.includes("--no-slack"),
    testBanner: args.includes("--test-banner"),
  }).catch((err) => {
    log.error("News Desk failed", err);
    process.exit(1);
  });
}
