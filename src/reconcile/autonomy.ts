// src/reconcile/autonomy.ts
// CHECKPOINT 2 of 3 — the completeness confirmation (ruling R9).
//
// The publishing path has three gates, in this order:
//
//   1. decideGate(results)          pre-draft   — tiers, enforcement, uncertainty
//   2. confirmAutoPublish(manifest) post-manifest, pre-render  ← THIS FILE
//   3. auditRender(artifacts)       post-render, pre-delivery
//
// WHY A SECOND CHECKPOINT EXISTS AT ALL. The obvious design is to fold
// completeness into decideGate. It cannot be done: decideGate runs BEFORE the
// LLM picks its films, and the manifest validates the PICKS. There is nothing to
// be complete about yet at gate time. So completeness gets its own checkpoint,
// placed where the information first exists.
//
// DOWNGRADE-ONLY, BY CONSTRUCTION. This function can turn "auto" into "blocked".
// It can NEVER turn "blocked" into "auto", never re-admit a film, never soften a
// tier, and never touch the approved path — an operator who reviewed and typed
// --approve keeps exactly the authority they had. R1's "only ever adds blocks"
// therefore holds across the whole chain: every checkpoint is an AND.
//
// PURE. Takes a manifest, returns a verdict. No I/O, no clock, no env.

import type { PostManifest, ManifestRow } from "../shared/post-validator.js";

export type AutoBlockLayer = "contract" | "gate" | "ai-review" | "audit";

export interface AutoBlocker {
  /** Film title, or "" for an edition-level blocker. */
  title: string;
  /** Which layer refused. Drives the red ping's grouping. */
  layer: AutoBlockLayer;
  /** The specific failing check, verbatim from the manifest row. */
  check: string;
  /**
   * Can a re-run plausibly fix this without human judgement? A missing TMDb
   * field may resolve on the next fetch; a pre-release score will not until the
   * film actually releases. The ping says which, so the operator knows whether
   * to wait or to act.
   */
  recoverable: boolean;
}

export interface AutoConfirmation {
  /** May this edition still auto-publish? */
  auto: boolean;
  blockers: AutoBlocker[];
  /** Printable one-liner. */
  reason: string;
}

/**
 * Checks whose failure a later run might clear on its own. A pre-release seal
 * cannot: it is a fact about the calendar, not about our data. An empty
 * why-line cannot: the LLM already produced nothing usable.
 */
const UNRECOVERABLE = ["contract:pre-release-seal", "contract:why-line"];

/** The failing check names carried by one row, split out of its reason string. */
export function checksInRow(row: ManifestRow): string[] {
  if (!row.reason) return [];
  return row.reason
    .split(";")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

function isRecoverable(check: string): boolean {
  return !UNRECOVERABLE.some((u) => check.startsWith(u));
}

/**
 * CHECKPOINT 2. A manifest with any FAIL row blocks auto-publish.
 *
 * WARN rows never block — that is the whole point of the warn/fail split. A
 * missing poster (R5) or a discover-fallback date (R2) is a real signal worth
 * surfacing, and neither is a reason to withhold a correct deck.
 */
export function confirmAutoPublish(manifest: PostManifest): AutoConfirmation {
  const failed = manifest.rows.filter((r) => r.status === "fail");
  if (failed.length === 0) {
    const warns = manifest.warnCount;
    return {
      auto: true,
      blockers: [],
      reason: `contract clean — ${manifest.passCount}/${manifest.rows.length} films complete${warns ? ` (${warns} warn, non-blocking)` : ""}`,
    };
  }

  const blockers: AutoBlocker[] = [];
  for (const row of failed) {
    for (const check of checksInRow(row)) {
      blockers.push({
        title: row.title,
        layer: "contract",
        check,
        recoverable: isRecoverable(check),
      });
    }
  }
  return {
    auto: false,
    blockers,
    reason: `contract FAILED — ${failed.length} of ${manifest.rows.length} film(s) would render incomplete`,
  };
}

/**
 * Apply the confirmation to a gate mode. DOWNGRADE-ONLY:
 *   auto     + blocked contract ⇒ blocked
 *   approved + blocked contract ⇒ approved  (the human already looked)
 *   blocked  + anything         ⇒ blocked
 */
export function applyAutoConfirmation(
  mode: "auto" | "approved" | "blocked",
  confirmation: AutoConfirmation
): "auto" | "approved" | "blocked" {
  if (mode === "auto" && !confirmation.auto) return "blocked";
  return mode;
}

// ── R6 · PER-EDITION EMPTINESS ──────────────────────────────────────────────
//
// An edition with nothing to say is not a failure. Wednesday routinely has a
// quiet OTT week, and the old all-editions-non-empty rule meant one empty
// edition could gate the OTHER edition's perfectly good deck. An empty edition
// now SKIPS its own post and says so; its sibling is unaffected.

export interface EditionOutcome {
  edition: string;
  kind: "publish" | "skip-empty";
  note: string;
}

export function editionOutcome(edition: string, renderableCount: number): EditionOutcome {
  if (renderableCount === 0) {
    return {
      edition,
      kind: "skip-empty",
      note: `${edition}: no films this week — post SKIPPED (not a failure, and it does not gate the other edition)`,
    };
  }
  return { edition, kind: "publish", note: `${edition}: ${renderableCount} film(s) to publish` };
}

// ── R8 · THE PINGS ──────────────────────────────────────────────────────────

export interface RedPingInput {
  edition: string;
  hash: string;
  blockers: AutoBlocker[];
  headSha: string;
}

/**
 * The RED ping. Today's gated ping says only "GATED (hash …)" and points at a
 * review — the operator has to go read a Notion page to learn WHAT broke. This
 * one names the film, the failing check, the layer that refused, and whether a
 * re-run might clear it, before they open anything.
 */
export function buildRedPing(input: RedPingInput): string {
  const { edition, hash, blockers, headSha } = input;
  const lines: string[] = [
    `:red_circle: *Wed Drop ${edition} — BLOCKED* (hash \`${hash}\`)`,
    `Nothing rendered or published.`,
    "",
  ];
  const byLayer = new Map<AutoBlockLayer, AutoBlocker[]>();
  for (const b of blockers) {
    const arr = byLayer.get(b.layer) ?? [];
    arr.push(b);
    byLayer.set(b.layer, arr);
  }
  for (const [layer, items] of byLayer) {
    lines.push(`*Failing layer: ${layer}*`);
    for (const b of items) {
      lines.push(`• *${b.title}* — ${b.check} _(${b.recoverable ? "may clear on re-run" : "needs a decision"})_`);
    }
    lines.push("");
  }
  lines.push(`Approve after review:  \`npm run job:wednesday -- --approve ${hash}\``);
  lines.push(`_code: ${headSha || "unknown"}_`);
  return lines.join("\n");
}

export interface GreenPingInput {
  edition: string;
  headSha: string;
  manifest: PostManifest;
  imageCount: number;
  checklist: string[];
}

/**
 * The GREEN ping. Auto-approved means no human tapped anything, so the package
 * must carry its own receipts: what was checked, what passed, and the code that
 * produced it. Instagram posting stays manual — this is the terminus.
 */
export function buildGreenPing(input: GreenPingInput): string {
  const { edition, headSha, manifest, imageCount, checklist } = input;
  const lines: string[] = [
    `:large_green_circle: *Wed Drop ${edition} — auto-approved: all checks green*`,
    `_gate · completeness contract · render audit — no human tap required._`,
    "",
    `*Package:* ${imageCount} image(s) · Issue ${manifest.issue}`,
    `*Landing + contract:* ${manifest.passCount} pass · ${manifest.warnCount} warn · ${manifest.failCount} fail`,
  ];
  const warns = manifest.rows.filter((r) => r.status === "warn");
  if (warns.length > 0) {
    lines.push("", "*Non-blocking warnings:*");
    for (const w of warns) lines.push(`• *${w.title}* — ${w.reason}`);
  }
  lines.push("", "*Post checklist:*");
  checklist.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  lines.push("", `_code: ${headSha || "unknown"}_`);
  return lines.join("\n");
}
