// src/reconcile/gate.ts
// The human-approval GATE.
//
//   - decideGate(results, opts) is PURE: it computes a content hash over the
//     reconciled list and decides whether to render. The first run (no matching
//     --approve hash, auto-pass off or not all-green) is BLOCKED → the job writes
//     the review and STOPS. A re-run with `--approve <hash>` renders ONLY if the
//     hash still matches (a data change since review ⇒ new hash ⇒ stale approval
//     rejected). autoPassGreen (default false): an ALL-🟢 edition may render
//     unattended; ANY 🟡/🔴 forces the manual gate. 🔴 NEVER renders.
//
//   - writeReview() is the only I/O. It delivers the "Wed Drop — REVIEW" artifact:
//       * Notion: a new page with EVERY film across both editions, written in
//         ≤100-block batches (create + blocks.children.append) so it never trips
//         Notion's 100-children-per-request cap, for any candidate count.
//       * Slack: a COMPACT ping (per-tier counts, AI-net-added names, AI-review
//         tally + flags, rejected count, the approve hash, and a button to the
//         Notion page) — bounded well under Slack's limits.
//     Both writers FAIL SOFT and INDEPENDENTLY; writeReview ALWAYS surfaces the
//     approve hash + a safety line.
//
//   The AI-review verdict (f.aiReview) is ADVISORY: it renders next to the tier
//   but feeds NOTHING here — not the hash, not the decision, not renderableFor.

import { createHash } from "node:crypto";
import { Client } from "@notionhq/client";
import { ofetch } from "ofetch";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";
import type { Release } from "../shared/types.js";
import type { WedDropEdition } from "../shared/wed-drop-edition.js";
import { EDITION_META } from "../shared/wed-drop-edition.js";
import type { AiVerdict, ReconciledFilm, ReconcileResult, Tier } from "./types.js";

const TIER_EMOJI: Record<Tier, string> = { green: "🟢", yellow: "🟡", red: "🔴" };
// Distinct AI-review glyphs — ❓/unavailable must read as "needs your eyes", NOT a pass.
const AI_GLYPH: Record<AiVerdict, string> = {
  confirm: "✅",
  doubt: "⚠️",
  reject: "🛑",
  unverified: "❓",
  unavailable: "⚠️",
};

/**
 * Per-pillar labels for the review artifact, so the gate isn't welded to Wed Drop
 * copy. Wednesday passes WED_DROP_LABELS (the exact historical strings); any other
 * pillar passes its own. `labelFor` resolves a pillar VALUE to display titles,
 * defaulting (in WED_DROP_LABELS) to EDITION_META for the wed editions.
 */
export interface GateLabels {
  /** Review page title prefix + Slack header body, e.g. "Wed Drop — REVIEW". */
  reviewTitle: string;
  /** Approve command shown in the review, e.g. "npm run job:wednesday -- --approve". */
  approveCommand: string;
  /** Notion "Pillar" select value, e.g. "Wed Drop". */
  notionPillar: string;
  /** pillar value → display titles (EDITION_META-backed for the wed editions). */
  labelFor: (pillar: string) => { notionTitle: string; slackLabel: string };
}

/** Wednesday's labels — reproduce today's EXACT strings (the regression anchor). */
export const WED_DROP_LABELS: GateLabels = {
  reviewTitle: "Wed Drop — REVIEW",
  approveCommand: "npm run job:wednesday -- --approve",
  notionPillar: "Wed Drop",
  labelFor: (p) => EDITION_META[p as WedDropEdition] ?? { notionTitle: p, slackLabel: p },
};

export interface GateOptions {
  /** Hash supplied via `--approve <hash>` (binds approval to the reviewed list). */
  approveHash?: string;
  /** When true, an all-🟢 drop may render with no manual approval. Default false. */
  autoPassGreen: boolean;
}

export interface GateDecision {
  proceed: boolean;
  mode: "auto" | "approved" | "blocked";
  hash: string;
  /** Renderable Release records per edition (🔴 always excluded). */
  renderable: Partial<Record<string, Release[]>>;
  reason: string;
}

// ── Pure hashing ────────────────────────────────────────────────────────────

/**
 * Canonical, timestamp-free fingerprint of one film for the gate hash. The
 * advisory AI-review verdict is DELIBERATELY excluded — it's non-deterministic
 * (web search) and must not churn the hash. A future auto-demote would act
 * through `tier` (already hashed), so safety never needs the verdict text.
 */
function filmFingerprint(f: ReconciledFilm): string {
  return [
    f.pillar,
    f.tmdbId ?? `t:${f.title.trim().toLowerCase()}`,
    f.tier,
    f.date ?? "",
    f.dateSource,
    [...f.foundIn].sort().join("+"),
    f.status,
  ].join("|");
}

/**
 * Stable content hash over BOTH editions' reconciled lists. Excludes timestamps
 * so the same reviewed data always hashes the same (the --approve binding); any
 * change to a film/tier/date/provenance changes the hash.
 */
export function computeDropHash(results: ReconcileResult[]): string {
  const lines = results
    .flatMap((r) => r.reconciled.map(filmFingerprint))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}

// ── Pure decision ───────────────────────────────────────────────────────────

function renderableFor(result: ReconcileResult, greenOnly: boolean): Release[] {
  const out: Release[] = [];
  const seen = new Set<string>();
  for (const f of result.reconciled) {
    if (!f.release) continue;                          // unverified / series — never render
    if (greenOnly ? f.tier !== "green" : f.tier === "red") continue;
    if (seen.has(f.release.id)) continue;
    seen.add(f.release.id);
    out.push(f.release);
  }
  return out;
}

/**
 * Decide whether to render, with no I/O. allGreen requires every edition to be
 * non-empty and free of 🟡/🔴.
 */
export function decideGate(results: ReconcileResult[], opts: GateOptions): GateDecision {
  const hash = computeDropHash(results);
  const allGreen = results.every((r) => r.counts.total > 0 && r.counts.yellow === 0 && r.counts.red === 0);

  if (opts.autoPassGreen && allGreen) {
    const renderable: Partial<Record<string, Release[]>> = {};
    for (const r of results) renderable[r.pillar] = renderableFor(r, true);
    return { proceed: true, mode: "auto", hash, renderable, reason: "autoPassGreen: every edition is all-🟢" };
  }

  if (opts.approveHash && opts.approveHash === hash) {
    const renderable: Partial<Record<string, Release[]>> = {};
    for (const r of results) renderable[r.pillar] = renderableFor(r, false);
    return { proceed: true, mode: "approved", hash, renderable, reason: `approved hash ${hash} — rendering 🟢+🟡 (🔴 excluded)` };
  }

  const why = opts.approveHash
    ? `--approve ${opts.approveHash} does not match current hash ${hash} (list changed since review)`
    : `awaiting approval — re-run with --approve ${hash}`;
  return { proceed: false, mode: "blocked", hash, renderable: {}, reason: why };
}

// ── Review artifact (Notion + Slack) ────────────────────────────────────────

const notion = new Client({ auth: config.NOTION_TOKEN });

function filmLine(f: ReconciledFilm): string {
  const parts = [
    `${TIER_EMOJI[f.tier]} ${f.title} (${f.language})`,
    f.platform ? `· ${f.platform}` : "",
    f.date ? `· ${f.date} [${f.dateSource}]` : "· no date",
    `· nets: ${f.foundIn.join("+")}`,
  ];
  const flags: string[] = [];
  if (f.ottDateFromPress) flags.push("ott-date-from-press");
  if (f.wasBelowCap) flags.push("press-corroborated/was-below-cap");
  if (f.ambiguousMatch) flags.push("ambiguous-match");
  if (f.possibleDuplicate) flags.push("possible-duplicate");
  if (f.conflictDetail) flags.push(`conflict(${f.conflictDetail})`);
  if (f.reasons.length) flags.push(f.reasons.join("; "));
  return `${parts.filter(Boolean).join(" ")}${flags.length ? ` — ${flags.join(" | ")}` : ""}`;
}

function textRun(content: string) {
  return { text: { content: content.slice(0, 1900) } };
}
function linkRun(label: string, url: string) {
  return { text: { content: label.slice(0, 200), link: { url } } };
}

function paragraph(text: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: { rich_text: [textRun(text)] },
  };
}
function heading(text: string) {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: { rich_text: [textRun(text)] },
  };
}
function imageBlock(url: string) {
  return { object: "block" as const, type: "image" as const, image: { type: "external" as const, external: { url } } };
}

/** AI-review rich-text runs appended to a film's line: " · 🛑 AI-review: … [source]". */
function aiReviewRuns(f: ReconciledFilm): unknown[] {
  if (!f.aiReview) return [];
  const ar = f.aiReview;
  const runs: unknown[] = [textRun(` · ${AI_GLYPH[ar.verdict]} AI-review: ${ar.reason} `)];
  if (ar.sourceUrl) runs.push(linkRun("[source]", ar.sourceUrl));
  return runs;
}

/** One reconciled film → its line (tier + reconcile source + AI verdict) + (if confirmed) a TMDb line + poster. */
function filmBlocks(f: ReconciledFilm): unknown[] {
  const runs: unknown[] = [textRun(filmLine(f))];
  if (f.sourceUrl) {
    runs.push(textRun("  "));
    runs.push(linkRun("source", f.sourceUrl));
  }
  runs.push(...aiReviewRuns(f));

  const blocks: unknown[] = [
    { object: "block" as const, type: "paragraph" as const, paragraph: { rich_text: runs } },
  ];
  if (f.status === "confirmed") {
    const tmdb = [
      `TMDb: ${f.resolvedTitle ?? "?"}`,
      f.year !== undefined ? `(${f.year})` : "",
      f.tmdbId !== undefined ? `· id ${f.tmdbId}` : "",
      f.cast && f.cast.length ? `· cast: ${f.cast.join(", ")}` : "· cast: —",
    ].filter(Boolean).join(" ");
    blocks.push(paragraph(tmdb));
    if (f.posterUrl) blocks.push(imageBlock(f.posterUrl));
  }
  return blocks;
}

/** Flatten all results into the full Notion block list (any length). */
function buildReviewBlocks(results: ReconcileResult[], hash: string, labels: GateLabels): unknown[] {
  const children: unknown[] = [
    paragraph(`Reconciliation review · hash ${hash} · re-run with: ${labels.approveCommand} ${hash}`),
  ];
  for (const r of results) {
    const meta = labels.labelFor(r.pillar);
    children.push(heading(`${meta.notionTitle} — ${r.counts.green}🟢 / ${r.counts.yellow}🟡 / ${r.counts.red}🔴 (added by AI net: ${r.counts.addedByAiNet})`));
    // Order: red, yellow, green — surface the problems first.
    const order: Tier[] = ["red", "yellow", "green"];
    for (const tier of order) {
      for (const f of r.reconciled.filter((x) => x.tier === tier)) {
        for (const b of filmBlocks(f)) children.push(b);
      }
    }
    if (r.rejected.length > 0) {
      children.push(heading(`Rejected — series / non-film / non-Indian (${r.rejected.length})`));
      for (const rej of r.rejected) children.push(paragraph(`🚫 ${rej.title ?? "(untitled)"} — ${rej.reason}`));
    }
  }
  return children;
}

// ── Notion delivery (≤100-block batches) ────────────────────────────────────

const NOTION_MAX_CHILDREN = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function transientNotion(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create the review page with the first ≤100 blocks, then append the remainder
 * in ≤100-block batches. Robust to any candidate count (200+). Each request
 * retries once on a transient (429 / 5xx) error. Returns the page URL.
 */
async function createReviewPageChunked(title: string, allChildren: unknown[], notionPillar: string): Promise<string> {
  const batches = chunk(allChildren, NOTION_MAX_CHILDREN);
  const firstBatch = batches[0] ?? [];

  const createArgs = {
    parent: { database_id: config.NOTION_RELEASES_DB_ID },
    properties: {
      Name: { title: [{ text: { content: title.slice(0, 1900) } }] },
      Status: { status: { name: "Draft" } },
      Pillar: { select: { name: notionPillar } },
      Verdict: { select: { name: "Pending" } },
    },
    children: firstBatch,
  } as Parameters<typeof notion.pages.create>[0];

  let page: { id: string; url?: string };
  try {
    page = (await notion.pages.create(createArgs)) as { id: string; url?: string };
  } catch (err) {
    if (!transientNotion(err)) throw err;
    await sleep(1500);
    page = (await notion.pages.create(createArgs)) as { id: string; url?: string };
  }

  for (const batch of batches.slice(1)) {
    const appendArgs = { block_id: page.id, children: batch } as Parameters<typeof notion.blocks.children.append>[0];
    try {
      await notion.blocks.children.append(appendArgs);
    } catch (err) {
      if (!transientNotion(err)) throw err;
      await sleep(1500);
      await notion.blocks.children.append(appendArgs);
    }
  }

  return page.url ?? "";
}

// ── Slack delivery (compact ping) ───────────────────────────────────────────

const SLACK_TEXT_MAX = 2900; // safely under Slack's 3000-char section-text limit

function isHttpUrl(u: string | undefined): u is string {
  return !!u && /^https?:\/\//i.test(u);
}

/** AI-net-only confirmed discoveries (the films TMDb discovery missed). */
function aiAddedNames(results: ReconcileResult[]): string[] {
  return results.flatMap((r) =>
    r.reconciled
      .filter((f) => f.status === "confirmed" && f.foundIn.length === 1 && f.foundIn[0] === "ai-net")
      .map((f) => f.title)
  );
}

/** Per-edition AI-review tally, e.g. " · AI: 1🛑 2⚠️ 1❓". Empty when no film was reviewed. */
function aiTally(r: ReconcileResult): string {
  const reviewed = r.reconciled.filter((f) => (f.tier === "green" || f.tier === "yellow") && f.aiReview);
  if (reviewed.length === 0) return "";
  const c: Record<AiVerdict, number> = { confirm: 0, doubt: 0, reject: 0, unverified: 0, unavailable: 0 };
  for (const f of reviewed) c[f.aiReview!.verdict] += 1;
  const parts: string[] = [];
  if (c.reject) parts.push(`${c.reject}🛑`);
  if (c.doubt) parts.push(`${c.doubt}⚠️`);
  if (c.unverified) parts.push(`${c.unverified}❓`);
  if (c.unavailable) parts.push(`${c.unavailable}⚠️unavail`);
  if (c.confirm) parts.push(`${c.confirm}✅`);
  return parts.length ? ` · AI: ${parts.join(" ")}` : "";
}

/** Films the AI flagged for a closer look (everything but a clean ✅). */
function aiFlaggedNames(results: ReconcileResult[]): string[] {
  return results.flatMap((r) =>
    r.reconciled
      .filter((f) => f.aiReview && f.aiReview.verdict !== "confirm")
      .map((f) => `${AI_GLYPH[f.aiReview!.verdict]} ${f.title}`)
  );
}

function truncList(names: string[], max = 8): string {
  if (names.length === 0) return "—";
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}

function section(text: string) {
  return { type: "section", text: { type: "mrkdwn", text: text.slice(0, SLACK_TEXT_MAX) } };
}

/**
 * Post a COMPACT review ping. Never sends per-film blocks (the full detail is in
 * Notion). The "Open review in Notion" button is attached ONLY when a valid page
 * URL exists; otherwise the message states the page wasn't created — we never
 * pass a non-URL as a button url. Throws on a non-2xx webhook response (the
 * caller fails soft). No-op when no webhook is configured.
 */
async function postReviewToSlack(
  results: ReconcileResult[],
  hash: string,
  windowLabel: string,
  notionUrl: string,
  labels: GateLabels
): Promise<void> {
  if (!config.SLACK_WEBHOOK_URL) {
    log.info("Slack webhook not configured — skipping review ping");
    return;
  }

  const editionLines = results.map((r) => {
    const m = labels.labelFor(r.pillar);
    return `*${m.slackLabel}:* ${r.counts.green}🟢 / ${r.counts.yellow}🟡 / ${r.counts.red}🔴 · +${r.counts.addedByAiNet} AI · ${r.rejected.length} rejected${aiTally(r)}`;
  });
  const flagged = aiFlaggedNames(results);

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `🕵️ ${labels.reviewTitle}`, emoji: true } },
    section(`*Reconciliation review · ${windowLabel}*\nRender is GATED — nothing published until approved.`),
    section(editionLines.join("\n")),
    section(`*AI net added:* ${truncList(aiAddedNames(results))}`),
    ...(flagged.length ? [section(`*AI-review — verify these:* ${truncList(flagged)}`)] : []),
    section(`*Approve:*\n\`\`\`${labels.approveCommand} ${hash}\`\`\``),
  ];

  if (isHttpUrl(notionUrl)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open review in Notion", emoji: true },
          url: notionUrl,
          style: "primary",
        },
      ],
    });
  } else {
    blocks.push(section(":warning: Notion review page was NOT created — check job logs; the full per-film review is unavailable."));
  }

  await ofetch(config.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { blocks, text: `🕵️ ${labels.reviewTitle}` },
  });
  log.success("Review Slack ping sent");
}

/**
 * Write the "Wed Drop — REVIEW" artifact and return the Notion page URL (empty
 * string when the Notion write failed). Called by the job ONLY when the gate is
 * blocked. Notion and Slack are delivered independently and fail soft; the
 * approve hash and a safety verdict are ALWAYS printed to the console so the
 * operator can tell whether it's safe to approve.
 */
export async function writeReview(
  results: ReconcileResult[],
  hash: string,
  labels: GateLabels = WED_DROP_LABELS
): Promise<string> {
  const win = results[0]?.window;
  const windowLabel = win ? `${win.start} → ${win.end}` : "";
  const pageTitle = `${labels.reviewTitle} — ${windowLabel} — ${hash}`;
  const children = buildReviewBlocks(results, hash, labels);

  // 1) NOTION — chunked create + append. Fail soft.
  let notionUrl = "";
  try {
    notionUrl = await createReviewPageChunked(pageTitle, children, labels.notionPillar);
    log.success(`Review written to Notion (${children.length} blocks): ${notionUrl}`);
  } catch (err) {
    log.error("Review Notion write failed", err instanceof Error ? err.message : err);
  }

  // 2) SLACK — compact ping. Independent of Notion. Fail soft.
  let slackOk = true;
  try {
    await postReviewToSlack(results, hash, windowLabel, notionUrl, labels);
  } catch (err) {
    slackOk = false;
    log.warn("Review Slack ping failed", err instanceof Error ? err.message : err);
  }

  // 3) ALWAYS surface the hash + a safety verdict keyed to what actually landed.
  if (isHttpUrl(notionUrl)) {
    log.success(`Review written to Notion: ${notionUrl} — review it, then approve ${hash}.`);
    if (!slackOk) log.warn("Slack ping skipped/failed — use the Notion page above (review is intact).");
  } else {
    log.error(`⚠ REVIEW NOT AVAILABLE (Notion write failed) — do NOT approve blind. Fix and re-run.`);
    log.error(`   gate hash ${hash} — withheld pending a readable review.`);
  }

  return isHttpUrl(notionUrl) ? notionUrl : "";
}
