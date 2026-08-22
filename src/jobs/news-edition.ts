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
import {
  CANDIDATES_MAX_AGE_HOURS,
  MACHINE_ROOM_DIR,
  PACKAGE_MAX_AGE_HOURS,
  REDISCOVER_REMEDY,
  REGENERATE_REMEDY,
  buildPackageText,
  checkFreshness,
  packageStoryUrls,
  readCandidates,
  readPackage,
  readPicks,
  toCandidateRecord,
  toScoredCluster,
  validatePickedIds,
  writeCandidates,
  writePackage,
  type NewsCandidates,
  type NewsPackageArtifact,
  type PackageStory,
} from "../content/news/news-picks.js";
import { renderNews, NEWS_SLUG, type CardCopyMap, type NewsRenderResult } from "../rendering/render-news.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngToR2 } from "../delivery/r2-upload.js";
import { buildAndUploadDeckZip, writeCaptionFile } from "../delivery/deliver-deck-zip.js";
import { postToWebhook } from "../delivery/slack.js";
import { config } from "../shared/config.js";
import { editorialTodayStamp } from "../shared/editorial-clock.js";
import { log } from "../shared/logger.js";
import { startRunLog } from "../shared/run-artifacts.js";

function escapeMd(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slack hard-rejects (400) a section whose text exceeds 3000 chars. */
const SLACK_SECTION_LIMIT = 2900;
const SLACK_MAX_BLOCKS = 45;

/** Slack's hard ceiling on blocks per message. Exceeding it is a 400. */
export const SLACK_BLOCK_CEILING = 50;
/** Cards shown as inline images; the rest become links + a zip pointer. */
export const MAX_INLINE_IMAGES = 5;

/**
 * Enforce Slack's 50-block ceiling on the assembled message.
 *
 * The per-section chunker already bounds TEXT size, but the checklist adds
 * image and divider blocks that chunking cannot merge — block COUNT is a
 * separate limit from block SIZE, and only the audit tail is expendable. Trims
 * from the end (audit first, checklist last) and says what it dropped, so the
 * post-first section is never the part that gets cut.
 */
export function capBlocks(blocks: unknown[]): unknown[] {
  if (blocks.length <= SLACK_BLOCK_CEILING) return blocks;
  const kept = blocks.slice(0, SLACK_BLOCK_CEILING - 1);
  kept.push(context(`_…audit trail truncated — ${blocks.length - kept.length} block(s) over Slack's ${SLACK_BLOCK_CEILING}-block ceiling._`));
  return kept;
}

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
    section(`*FORMAT:* \`${edition.format}\`
_${escapeMd(edition.why)}_`),
  ];
  const plain: string[] = [head, `${istDate} (IST)`, "", `FORMAT: ${edition.format}`, edition.why];

  // ══ POST CHECKLIST — everything needed to publish, in the order you do it ══
  // Deliberately post-first, audit-second. The owner opens this to POST, not to
  // review scoring; the audit trail keeps its full detail but moves below.

  // 1️⃣ IMAGES — inline so the cards are visible without opening a link.
  blocks.push(divider(), section("*1️⃣ IMAGES*"));
  const inline = delivery.previewUrls.slice(0, MAX_INLINE_IMAGES);
  inline.forEach((url, i) => {
    // Slack needs a non-empty alt_text; the cover is always previewUrls[0]
    // because renderNews emits it first.
    const alt = i === 0 && delivery.previewUrls.length > 1 ? "cover" : `card ${String(i).padStart(2, "0")}`;
    blocks.push({ type: "image", image_url: url, alt_text: alt });
  });
  const overflow = delivery.previewUrls.length - inline.length;
  if (overflow > 0) {
    const links = delivery.previewUrls.slice(MAX_INLINE_IMAGES)
      .map((u, i) => `<${u}|card ${String(i + MAX_INLINE_IMAGES).padStart(2, "0")}>`).join("  ·  ");
    blocks.push(section(`${links}
_(+${overflow} more in the zip)_`));
  }
  // A zip cannot be inlined — it stays a link line.
  blocks.push(section(delivery.zipUrl ? `📦 <${delivery.zipUrl}|download deck .zip>` : "_single card — no zip_"));
  plain.push("", "1. IMAGES", ...delivery.previewUrls, delivery.zipUrl ?? "(no zip — single card)");

  // 2️⃣ CAPTION — its own fence.
  const captionLines = pkg.heldFor.length
    ? ["*2️⃣ CAPTION — HELD*", `_unbacked names: ${pkg.heldFor.join(", ")}_`]
    : ["*2️⃣ CAPTION*", "```", `${pkg.caption}

${pkg.captionHashtags.join(" ")}`, "```"];
  blocks.push(divider(), ...toSectionBlocks(captionLines));
  plain.push("", ...captionLines);

  // 3️⃣ FIRST COMMENT — its own fence.
  if (pkg.commentHashtags.length > 0) {
    const lines = ["*3️⃣ FIRST COMMENT*", "```", pkg.commentHashtags.join(" "), "```"];
    blocks.push(...toSectionBlocks(lines));
    plain.push("", ...lines);
  }

  // 4️⃣ PINNED COMMENT — its own fence.
  if (pkg.pinnedComment) {
    const lines = ["*4️⃣ PINNED COMMENT*", "```", pkg.pinnedComment, "```"];
    blocks.push(...toSectionBlocks(lines));
    plain.push("", ...lines);
  }

  // 5️⃣ TAG CHECK — unchanged rules: no tick, no tag.
  if (pkg.badgeCheckBoard.length > 0) {
    const rows = pkg.badgeCheckBoard.map(
      (b) => `• ${escapeMd(b.name)} — ${b.candidateHandle ? `candidate \`${escapeMd(b.candidateHandle)}\`` : "_no handle suggested_"}`
    );
    const lines = [
      "*5️⃣ TAG CHECK — verify before tagging*",
      "_No tick, no tag. These are candidates only; nothing is auto-tagged._",
      ...rows,
    ];
    blocks.push(...toSectionBlocks(lines));
    plain.push("", ...lines);
  }

  // ══ AUDIT — the full trail, preserved, below the checklist ══
  const shown = edition.cover
    ? [edition.cover, ...edition.cards.filter((c) => c !== edition.cover)]
    : edition.cards;
  if (shown.length > 0) {
    const lines = ["*STORIES*"];
    for (const s2 of shown) {
      const c = s2.resolved.story.cluster;
      const film = s2.resolved.film;
      const art = film?.posterUrl ? `poster (${film.confidence})` : "typographic";
      const chip = c.judgedTitle ? ` · ★ ${escapeMd(c.judgedTitle)}` : "";
      const link = s2.resolved.story.sourceUrl
        ? `*<${s2.resolved.story.sourceUrl}|${escapeMd(c.headline)}>*`
        : `*${escapeMd(c.headline)}*`;
      lines.push(
        `\`${s2.segment.badge}\`  ${link}
` +
          `${escapeMd(c.outlets.slice(0, 4).join(", "))} · Tier ${c.bestTier} · ${c.storyClass} · score ${c.score}${chip}
` +
          `_${escapeMd(s2.segmentReason)} · art: ${art}_`
      );
      plain.push(`[${s2.segment.badge}] ${c.headline} — ${c.outlets.join(", ")} · score ${c.score} · ${art}`);
    }
    blocks.push(divider(), ...toSectionBlocks(lines));
  }

  const heldVerified = verified.filter((v) => !v.confirmed);
  const droppedLines = edition.dropped.map((d) => `• ${escapeMd(d.headline)}
   _${escapeMd(d.reason)}_`);
  if (heldVerified.length || ineligible.length || droppedLines.length) {
    const lines = ["*HELD*"];
    for (const v of heldVerified) lines.push(`• ${escapeMd(v.cluster.headline)}
   _${escapeMd(v.basis)}_`);
    lines.push(...droppedLines);
    for (const c of ineligible.slice(0, 5)) lines.push(`• ${escapeMd(c.headline)}
   _${escapeMd(c.holdReason)}_`);
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

  return { blocks: capBlocks(blocks), text: `${head} — ${istDate}: ${edition.format}`, plain: plain.join("\n") };
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
  startRunLog("news-edition");

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
    // Block-structure summary: the dry run's job is to prove the message would
    // be ACCEPTED, not just that the copy reads well. Counts here are what
    // Slack validates against (block ceiling, section size, image blocks).
    const byType = new Map<string, number>();
    for (const b of blocks as { type: string }[]) byType.set(b.type, (byType.get(b.type) ?? 0) + 1);
    const fences = (blocks as { text?: { text?: string } }[])
      .filter((b) => (b.text?.text ?? "").includes("```")).length;
    const maxSection = Math.max(
      0,
      ...(blocks as { text?: { text?: string } }[]).map((b) => (b.text?.text ?? "").length)
    );
    // eslint-disable-next-line no-console
    console.log(
      `BLOCK STRUCTURE: ${blocks.length}/${SLACK_BLOCK_CEILING} blocks · ` +
        [...byType].map(([t, n]) => `${n} ${t}`).join(" · ") +
        ` · ${fences} fenced block(s) · largest section ${maxSection}/3000 chars`
    );
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

// ============================================================================
// MR-M2 NEWSDESK - the INTERACTIVE path: discover -> pick -> generate -> mark.
//
// This is a SECOND way to drive the same pipeline, not a change to the first.
// main() above is untouched: a bare run, --now and --test-banner behave exactly
// as they did, and the flags below are dispatched before main is ever reached.
//
// The four steps are four separate processes because the operator sits between
// them, so the state has to survive on disk (news-picks.ts owns those files):
//
//   --discover     gather -> seen-filter (READ ONLY) -> cluster -> score, then
//                  write news-candidates.json. ZERO model calls, nothing marked
//                  seen, nothing sent.
//   --from-picks   read news-picks.json (written by the SERVER, never by a
//                  browser), then verify -> resolve -> compose -> package ->
//                  render over EXACTLY the picked clusters. Cards land in
//                  output/posts as usual; the posting kit is written to
//                  news-package.json. NOTHING outward: no Slack, no R2, no zip.
//   --mark-posted  read news-package.json and mark seen EXACTLY the story URLs
//                  of the stories that made the package.
//
// TWO INVARIANTS THAT MUST NEVER SOFTEN:
//   1. An OPERATOR OVERRIDE (picking a story the desk HELD) changes what gets
//      VERIFIED, never what gets CONFIRMED. verifyStories runs over the pick
//      exactly as it would over any story, and an unconfirmed pick is dropped
//      with its basis. The override is carried into the package text so the
//      person about to post knows the desk disagreed.
//   2. Nothing here marks seen except --mark-posted, and --mark-posted marks
//      only the URLs of stories that actually made the package. A dropped
//      story must remain available to a later run.
// ============================================================================

/** The desk verifies at most this many stories per run, so a pick set is capped. */
export const MAX_PICKS = MAX_VERIFIED_STORIES;

export interface DiscoverDeps {
  gather: (nowMs: number) => Promise<NewsItem[]>;
  isSeen: (url: string) => boolean;
  loadJudged: (nowMs: number) => JudgedFilm[];
}

export const LIVE_DISCOVER_DEPS: DiscoverDeps = {
  gather: gatherNews,
  isSeen: alreadySeen,
  loadJudged: (nowMs) => [...readVerdictArchive(nowMs), ...readEvergreensPicks()],
};

/**
 * DISCOVER. Everything up to and including scoring, and not one step further.
 *
 * The seen filter is applied on READ and nothing is written back: an item the
 * ledger already knows is HIDDEN from the picker (it has been reported once
 * already) and the artifact records how many were hidden, so the operator can
 * tell "quiet news day" from "the morning run already took today's stories".
 */
export async function runDiscover(
  nowMs: number = Date.now(),
  deps: DiscoverDeps = LIVE_DISCOVER_DEPS,
  dir: string = MACHINE_ROOM_DIR
): Promise<NewsCandidates> {
  const istDate = editorialTodayStamp(new Date(nowMs));
  log.info(`  News Desk DISCOVER - ${istDate} IST - feed reads only, ZERO model calls`);

  const fresh: NewsItem[] = await deps.gather(nowMs);
  const unseen = fresh.filter((i) => !deps.isSeen(i.url));
  const hiddenSeenCount = fresh.length - unseen.length;
  log.info(
    `  ${fresh.length} fresh - ${hiddenSeenCount} hidden by the seen ledger (READ ONLY) - ${unseen.length} on offer`
  );

  const judged: JudgedFilm[] = deps.loadJudged(nowMs);
  const clusters = clusterItems(unseen);
  const scored = scoreClusters(clusters, judged, findJudgedMention);
  log.info(`  ${clusters.length} cluster(s) scored (judged scope ${judged.length}):`);
  printScoringTable(scored);

  const artifact: NewsCandidates = {
    generatedAt: new Date(nowMs).toISOString(),
    istDate,
    windowHours: WINDOW_HOURS,
    hiddenSeenCount,
    gatheredCount: fresh.length,
    clusters: scored.map(toCandidateRecord),
  };
  const path = writeCandidates(artifact, dir);
  log.success(`  ${artifact.clusters.length} candidate(s) -> ${path}`);
  log.info("  Nothing marked seen. Nothing sent. No model called.");
  return artifact;
}

export interface FromPicksDeps {
  loadJudged: (nowMs: number) => JudgedFilm[];
  verify: (clusters: ScoredCluster[], istDate: string) => Promise<VerifiedStory[]>;
  resolve: (
    confirmed: VerifiedStory[],
    judged: JudgedFilm[],
    findJudged: typeof findJudgedMention,
    windowYear: number
  ) => Promise<ResolvedStory[]>;
  buildPkg: (edition: ComposedEdition, istDate: string) => Promise<NewsPackage>;
  render: (edition: ComposedEdition, istDate: string, cardCopy: CardCopyMap) => Promise<NewsRenderResult>;
  shutdownBrowser: () => Promise<void>;
}

export const LIVE_FROM_PICKS_DEPS: FromPicksDeps = {
  loadJudged: (nowMs) => [...readVerdictArchive(nowMs), ...readEvergreensPicks()],
  verify: verifyStories,
  resolve: resolveStories,
  buildPkg: buildPackage,
  render: renderNews,
  shutdownBrowser: closeBrowser,
};

/**
 * GENERATE from the operator's picks.
 *
 * Every refusal below is LOUD and terminal. Guessing here is worse than
 * stopping: a mismatched or stale artifact means the ids in the picks file no
 * longer denote the stories the operator was looking at when they ticked them,
 * and generating anyway would render a set nobody chose.
 */
export async function runFromPicks(
  nowMs: number = Date.now(),
  deps: FromPicksDeps = LIVE_FROM_PICKS_DEPS,
  dir: string = MACHINE_ROOM_DIR
): Promise<NewsPackageArtifact> {
  const istDate = editorialTodayStamp(new Date(nowMs));
  log.info(`  News Desk GENERATE FROM PICKS - ${istDate} IST`);

  const picksRead = readPicks(dir);
  if (!picksRead.ok) throw new Error(`--from-picks refused: ${picksRead.reason}`);
  const candRead = readCandidates(dir);
  if (!candRead.ok) throw new Error(`--from-picks refused: ${candRead.reason}`);
  const picks = picksRead.value;
  const candidates = candRead.value;

  if (picks.candidatesGeneratedAt !== candidates.generatedAt) {
    throw new Error(
      `--from-picks refused: the picks were made against candidates generated at ` +
        `${picks.candidatesGeneratedAt}, but the artifact on disk was generated at ` +
        `${candidates.generatedAt} - ${REDISCOVER_REMEDY}, then pick again.`
    );
  }
  const freshness = checkFreshness(
    candidates.generatedAt,
    nowMs,
    CANDIDATES_MAX_AGE_HOURS,
    "candidates",
    REDISCOVER_REMEDY
  );
  if (!freshness.fresh) throw new Error(`--from-picks refused: ${freshness.reason}`);

  const valid = validatePickedIds(candidates, picks.pickedIds);
  if (!valid.ok) throw new Error(`--from-picks refused: ${valid.reason}`);

  const byId = new Map(candidates.clusters.map((c) => [c.id, c]));
  const pickedRecords = valid.ids.map((id) => byId.get(id)!);
  const picked: ScoredCluster[] = pickedRecords.map(toScoredCluster);

  // A picked-but-HELD story is an OVERRIDE. Recorded here, carried all the way
  // to the package text, and at no point allowed to skip verification.
  const overrideById = new Map<string, string>();
  for (const r of pickedRecords) {
    if (!r.eligible) overrideById.set(r.id, r.holdReason || "held by the desk (no reason recorded)");
  }
  for (const [id, reason] of overrideById) {
    log.warn(`  OPERATOR OVERRIDE - ${id} was HELD by the desk: ${reason}`);
  }

  const dropped: { headline: string; reason: string }[] = [];

  // The verification cap is a real ceiling, not a suggestion - verifyStories
  // slices to it. Saying so out loud beats letting a pick silently vanish.
  const slate = picked.slice(0, MAX_PICKS);
  for (const c of picked.slice(MAX_PICKS)) {
    const reason = `beyond the ${MAX_PICKS}-story verification cap - NOT verified, NOT in this package`;
    dropped.push({ headline: c.headline, reason });
    log.warn(`  OVER CAP - "${c.headline}": ${reason}`);
  }

  log.info(`  Verifying ${slate.length} operator-picked story/stories - ONE batched call over the PICKS only`);
  const verified = await deps.verify(slate, istDate);
  const confirmed = verified.filter((v) => v.confirmed);
  for (const held of verified.filter((v) => !v.confirmed)) {
    const ov = overrideById.get(held.cluster.id);
    dropped.push({
      headline: held.cluster.headline,
      reason: ov
        ? `OPERATOR OVERRIDE did NOT bypass verification - ${held.basis} (the desk had held it: ${ov})`
        : held.basis,
    });
  }
  log.info(`  ${confirmed.length} of ${verified.length} confirmed`);

  const judged: JudgedFilm[] = deps.loadJudged(nowMs);
  const windowYear = Number.parseInt(istDate.slice(0, 4), 10);
  const resolved: ResolvedStory[] = confirmed.length
    ? await deps.resolve(confirmed, judged, findJudgedMention, windowYear)
    : [];
  for (const r of resolved) log.info(`  resolve - ${r.reason}`);

  // gatheredCount is the PICKED count here, not the day's gather: the quiet-day
  // line must describe what the operator actually put in front of the pipeline.
  const edition = composeEdition(resolved, picked.length);
  log.info(`  FORMAT: ${edition.format}`);
  log.info(`  WHY: ${edition.why}`);
  for (const d of edition.dropped) log.info(`  dropped - ${d.headline} - ${d.reason}`);
  dropped.push(...edition.dropped);

  const pkg = await deps.buildPkg(edition, istDate);
  if (pkg.heldFor.length) log.warn(`  Caption HELD - unbacked names: ${pkg.heldFor.join(", ")}`);

  let render: NewsRenderResult = { cardPaths: [], notes: [] };
  if (edition.format !== "none") {
    render = await deps.render(edition, istDate, pkg.cardCopy);
    for (const n of render.notes) log.info(`  render - ${n}`);
    await deps.shutdownBrowser();
  }
  const cardFiles = [render.coverPath, ...render.cardPaths]
    .filter((p): p is string => Boolean(p))
    .map((p) => p.split(/[\\/]/).pop()!);

  // Same ordering rule as the Slack package: cover first, then the rest.
  const shown = edition.cover
    ? [edition.cover, ...edition.cards.filter((c) => c !== edition.cover)]
    : edition.cards;
  const stories: PackageStory[] = shown.map((s) => {
    const c = s.resolved.story.cluster;
    return {
      id: c.id,
      headline: c.headline,
      badge: s.segment.badge,
      segmentReason: s.segmentReason,
      sourceUrl: s.resolved.story.sourceUrl,
      score: c.score,
      storyClass: c.storyClass,
      operatorOverride: overrideById.get(c.id) ?? null,
      itemUrls: c.items.map((i) => i.url),
    };
  });

  const packageText = buildPackageText({
    istDate,
    format: edition.format,
    why: edition.why,
    caption: pkg.caption,
    captionHashtags: pkg.captionHashtags,
    commentHashtags: pkg.commentHashtags,
    pinnedComment: pkg.pinnedComment,
    badgeCheckBoard: pkg.badgeCheckBoard,
    heldFor: pkg.heldFor,
    stories,
    dropped,
    cardFiles,
  });

  const artifact: NewsPackageArtifact = {
    generatedAt: new Date(nowMs).toISOString(),
    istDate,
    format: edition.format,
    why: edition.why,
    caption: pkg.caption,
    captionHashtags: pkg.captionHashtags,
    commentHashtags: pkg.commentHashtags,
    pinnedComment: pkg.pinnedComment,
    badgeCheckBoard: pkg.badgeCheckBoard,
    heldFor: pkg.heldFor,
    overrides: stories
      .filter((s) => s.operatorOverride !== null)
      .map((s) => ({ id: s.id, headline: s.headline, holdReason: s.operatorOverride! })),
    stories,
    dropped,
    cardFiles,
    packageText,
  };
  const path = writePackage(artifact, dir);

  // eslint-disable-next-line no-console
  console.log(`\n${packageText}\n`);
  log.success(`  Package -> ${path} - NOTHING sent, nothing marked seen.`);
  return artifact;
}

export interface MarkPostedDeps {
  markAll: (urls: string[], now: number) => void;
}

export const LIVE_MARK_POSTED_DEPS: MarkPostedDeps = { markAll: markAllSeen };

/**
 * MARK AS POSTED. The ONLY step in this path that writes the seen ledger.
 *
 * It marks EXACTLY the item URLs behind the stories that made the package.
 * Dropped stories are excluded on purpose: a story the desk held, the verifier
 * refused, or the composer cut was never reported, so burning it here would
 * silently delete it from every future run.
 *
 * Idempotent by construction - markAllSeen is INSERT OR IGNORE on the URL key.
 */
export async function runMarkPosted(
  nowMs: number = Date.now(),
  deps: MarkPostedDeps = LIVE_MARK_POSTED_DEPS,
  dir: string = MACHINE_ROOM_DIR
): Promise<{ marked: number; urls: string[] }> {
  const read = readPackage(dir);
  if (!read.ok) throw new Error(`--mark-posted refused: ${read.reason}`);
  const pkg = read.value;

  const freshness = checkFreshness(
    pkg.generatedAt,
    nowMs,
    PACKAGE_MAX_AGE_HOURS,
    "package",
    REGENERATE_REMEDY
  );
  if (!freshness.fresh) throw new Error(`--mark-posted refused: ${freshness.reason}`);

  const urls = packageStoryUrls(pkg);
  deps.markAll(urls, nowMs);
  log.success(
    `  ${urls.length} story URL(s) from ${pkg.stories.length} posted story/stories marked seen (${pkg.istDate}).`
  );
  if (pkg.dropped.length > 0) {
    log.info(`  ${pkg.dropped.length} dropped story/stories were NOT marked - they never made the package.`);
  }
  return { marked: urls.length, urls };
}

// Hardened truthiness guard — endsWith("") is vacuously true, so the argv1.length
// clause stops a bare import from running main (the runs-main-on-import landmine).
const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMainModule = argv1.length > 0 && import.meta.url.endsWith(argv1);

if (isMainModule) {
  const args = process.argv.slice(2);
  // MR-M2: the three interactive flags are dispatched BEFORE the scheduled
  // path, and each returns. The `else` branch below is the original entry,
  // unchanged, so a bare run / --now / --test-banner is byte-identical.
  const fail = (err: unknown) => {
    log.error("News Desk failed", err);
    process.exit(1);
  };
  if (args.includes("--discover")) {
    startRunLog("news-edition");
    runDiscover(Date.now()).catch(fail);
  } else if (args.includes("--from-picks")) {
    startRunLog("news-edition");
    runFromPicks(Date.now()).catch(fail);
  } else if (args.includes("--mark-posted")) {
    startRunLog("news-edition");
    runMarkPosted(Date.now()).catch(fail);
  } else {
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
}
