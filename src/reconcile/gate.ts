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
//   - writeReview() is the only I/O: a "Wed Drop — REVIEW" Notion page (new page,
//     NOT bolted onto the post) + a Slack message (reusing notifyDraftReady's
//     validation block). Per film: title, language, pillar, platform, date +
//     dateSource, tier, foundIn nets, a CLICKABLE source link, conflict/dupe/
//     ambiguous detail, and the TMDb-resolved title + poster + year + cast so a
//     bad match is visible at a glance.

import { createHash } from "node:crypto";
import { Client } from "@notionhq/client";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady } from "../delivery/slack.js";
import type { Release } from "../shared/types.js";
import type { WedDropEdition } from "../shared/wed-drop-edition.js";
import { EDITION_META } from "../shared/wed-drop-edition.js";
import type { ReconciledFilm, ReconcileResult, Tier } from "./types.js";

const TIER_EMOJI: Record<Tier, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

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
  renderable: Partial<Record<WedDropEdition, Release[]>>;
  reason: string;
}

// ── Pure hashing ────────────────────────────────────────────────────────────

/** Canonical, timestamp-free fingerprint of one film for the gate hash. */
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
    const renderable: Partial<Record<WedDropEdition, Release[]>> = {};
    for (const r of results) renderable[r.pillar] = renderableFor(r, true);
    return { proceed: true, mode: "auto", hash, renderable, reason: "autoPassGreen: every edition is all-🟢" };
  }

  if (opts.approveHash && opts.approveHash === hash) {
    const renderable: Partial<Record<WedDropEdition, Release[]>> = {};
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

function paragraph(text: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: { rich_text: [{ text: { content: text.slice(0, 1900) } }] },
  };
}
function heading(text: string) {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: { rich_text: [{ text: { content: text.slice(0, 1900) } }] },
  };
}
function imageBlock(url: string) {
  return { object: "block" as const, type: "image" as const, image: { type: "external" as const, external: { url } } };
}

/** One reconciled film → a paragraph + (if resolved) a TMDb provenance line + poster. */
function filmBlocks(f: ReconciledFilm): unknown[] {
  const blocks: unknown[] = [];
  if (f.sourceUrl) {
    blocks.push({
      object: "block" as const,
      type: "paragraph" as const,
      paragraph: {
        rich_text: [
          { text: { content: filmLine(f) + "  " } },
          { text: { content: "source", link: { url: f.sourceUrl } } },
        ],
      },
    });
  } else {
    blocks.push(paragraph(filmLine(f)));
  }
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

async function createReviewPage(title: string, children: unknown[]): Promise<string> {
  const args = {
    parent: { database_id: config.NOTION_RELEASES_DB_ID },
    properties: {
      Name: { title: [{ text: { content: title.slice(0, 1900) } }] },
      Status: { status: { name: "Draft" } },
      Pillar: { select: { name: "Wed Drop" } },
      Verdict: { select: { name: "Pending" } },
    },
    children,
  } as Parameters<typeof notion.pages.create>[0];
  try {
    const res = await notion.pages.create(args);
    return (res as { url?: string }).url ?? "(no URL)";
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 429 || (typeof status === "number" && status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await notion.pages.create(args);
      return (res as { url?: string }).url ?? "(no URL)";
    }
    throw err;
  }
}

/**
 * Write the "Wed Drop — REVIEW" artifact (Notion page + Slack) and return the
 * Notion URL. Called by the job ONLY when the gate is blocked (i.e. the job is
 * about to STOP and render nothing).
 */
export async function writeReview(results: ReconcileResult[], hash: string): Promise<string> {
  const win = results[0]?.window;
  const windowLabel = win ? `${win.start} → ${win.end}` : "";
  const pageTitle = `Wed Drop — REVIEW — ${windowLabel} — ${hash}`;

  const children: unknown[] = [
    paragraph(`Reconciliation review · hash ${hash} · re-run with: npm run job:wednesday -- --approve ${hash}`),
  ];
  const flaggedForSlack: string[] = [];

  for (const r of results) {
    const meta = EDITION_META[r.pillar];
    children.push(heading(`${meta.notionTitle} — ${r.counts.green}🟢 / ${r.counts.yellow}🟡 / ${r.counts.red}🔴 (added by AI net: ${r.counts.addedByAiNet})`));
    // Order: red, yellow, green — surface the problems first.
    const order: Tier[] = ["red", "yellow", "green"];
    for (const tier of order) {
      for (const f of r.reconciled.filter((x) => x.tier === tier)) {
        for (const b of filmBlocks(f)) children.push(b);
        if (f.tier !== "green") flaggedForSlack.push(`${TIER_EMOJI[f.tier]} *${f.title}* (${meta.slackLabel}) — ${f.reasons.join("; ")}`);
      }
    }
    if (r.rejected.length > 0) {
      children.push(heading(`Rejected — series / non-film (${r.rejected.length})`));
      for (const rej of r.rejected) children.push(paragraph(`🚫 ${rej.title ?? "(untitled)"} — ${rej.reason}`));
    }
  }

  let url = "(notion disabled)";
  try {
    url = await createReviewPage(pageTitle, children);
    log.success(`Review page written: ${url}`);
  } catch (err) {
    log.error("Review Notion write failed", err instanceof Error ? err.message : err);
  }

  const totals = results.reduce(
    (a, r) => ({ green: a.green + r.counts.green, yellow: a.yellow + r.counts.yellow, red: a.red + r.counts.red, added: a.added + r.counts.addedByAiNet }),
    { green: 0, yellow: 0, red: 0, added: 0 }
  );
  const issuesBlock =
    `*Reconciliation — hash \`${hash}\`*\nRe-run to publish: \`npm run job:wednesday -- --approve ${hash}\`` +
    (flaggedForSlack.length ? `\n${flaggedForSlack.join("\n")}` : "\nAll films 🟢.");

  await notifyDraftReady({
    pillar: "Wed Drop — REVIEW",
    emoji: "🕵️",
    title: `Reconciliation review · ${windowLabel}`,
    subtitle: "Render is GATED — nothing published until approved.",
    notionUrl: url,
    metadata: {
      Hash: hash,
      "🟢 / 🟡 / 🔴": `${totals.green} / ${totals.yellow} / ${totals.red}`,
      "Added by AI net": String(totals.added),
    },
    validation: { metaValue: `Gate: review before publishing · hash ${hash}`, issuesBlock },
  });

  return url;
}
