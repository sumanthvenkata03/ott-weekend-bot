// scripts/wed-drop-review-dump.ts
//
// READ-ONLY console reconstruction of the Wednesday Drop reconcile REVIEW.
//
// It replicates the wednesday-drop job's read-only prefix EXACTLY —
//   Promise.all(getCandidates ×2) → sequential verifyCandidates(theatrical, ott)
//   → annotateWithAiReview(results) → computeDropHash(results)
// — and STOPS before decideGate. It then prints the reconciled review as a
// copy-pasteable JSON block + a human summary, with the approve hash at the top
// and bottom.
//
// It is INCAPABLE of publishing or rendering: it imports none of writeReview /
// writeWednesdayDropToNotion / render-* / uploadPngsToR2 / recordFeatured /
// notify*, honours no --approve / --write-review flag, and never calls
// produceEdition / capPoolForSelector. The only exported symbol pulled from
// gate.ts is the pure `computeDropHash` (so the printed hash is byte-identical to
// the Slack approve token); importing that module instantiates an inert Notion
// Client at load but makes zero network calls without an explicit method call.
//
// Within ~24h of the original job run the Tavily / LLM / AI-review calls are
// cache hits, so this spends nothing beyond cache. Run with:
//   npx tsx scripts/wed-drop-review-dump.ts

import "dotenv/config";
import { addDays, endOfWeek, format, startOfDay, startOfWeek } from "date-fns";
import { getCandidates } from "../src/discovery/candidates.js";
import { verifyCandidates } from "../src/reconcile/verify.js";
import { annotateWithAiReview } from "../src/reconcile/ai-review.js";
import { editionWindow, RECONCILE_LANGUAGES } from "../src/reconcile/run.js";
import { computeDropHash } from "../src/reconcile/gate.js";
import type { ReconcileResult, ReconciledFilm } from "../src/reconcile/types.js";

// ── JSON projection (the primary, paste-back output) ─────────────────────────

/** Flag tokens present on a film, in the order the review lists them. */
function flagsOf(f: ReconciledFilm): string[] {
  const out: string[] = [];
  if (f.ottDateFromPress) out.push("ottDateFromPress");
  if (f.wasBelowCap) out.push("wasBelowCap");
  if (f.ambiguousMatch) out.push("ambiguousMatch");
  if (f.possibleDuplicate) out.push("possibleDuplicate");
  if (f.conflictDetail) out.push(`conflictDetail:${f.conflictDetail}`);
  return out;
}

function filmJson(f: ReconciledFilm) {
  return {
    tier: f.tier,
    title: f.title,
    language: f.language,
    platform: f.platform ?? null,
    date: f.date ?? null,
    dateSource: f.dateSource,
    foundIn: f.foundIn,
    status: f.status,
    flags: flagsOf(f),
    aiReview: f.aiReview
      ? { verdict: f.aiReview.verdict, reason: f.aiReview.reason, sourceUrl: f.aiReview.sourceUrl ?? null }
      : null,
    aiDemoted: f.aiDemoted
      ? { originalTier: f.aiDemoted.originalTier, verdict: f.aiDemoted.verdict, reason: f.aiDemoted.reason, sourceUrl: f.aiDemoted.sourceUrl }
      : null,
    tmdbId: f.tmdbId ?? null,
  };
}

function editionJson(r: ReconcileResult) {
  return {
    pillar: r.pillar,
    counts: {
      total: r.counts.total,
      green: r.counts.green,
      yellow: r.counts.yellow,
      red: r.counts.red,
      addedByAiNet: r.counts.addedByAiNet,
      flagged: r.counts.flagged,
    },
    films: r.reconciled.map(filmJson),
    rejected: r.rejected.map((rej) => ({
      title: rej.title ?? null,
      reason: rej.reason,
      ...(rej.sourceUrl ? { sourceUrl: rej.sourceUrl } : {}),
    })),
  };
}

// ── Human-readable projection (for eyeballing) ───────────────────────────────

const TIER_EMOJI: Record<string, string> = { green: "🟢", yellow: "🟡", red: "🔴" };
const AI_GLYPH: Record<string, string> = { confirm: "✅", doubt: "⚠️", reject: "🛑", unverified: "❓", unavailable: "⚠️" };

function filmSummaryLine(f: ReconciledFilm): string {
  const bits = [
    `${TIER_EMOJI[f.tier] ?? f.tier} ${f.title} (${f.language})`,
    f.platform ? `· ${f.platform}` : "",
    f.date ? `· ${f.date} [${f.dateSource}]` : "· no date",
    `· nets: ${f.foundIn.join("+")}`,
    f.tmdbId !== undefined ? `· tmdb ${f.tmdbId}` : "· tmdb —",
  ];
  const flags = flagsOf(f);
  if (flags.length) bits.push(`· flags: ${flags.join(", ")}`);
  if (f.aiReview) bits.push(`· AI ${AI_GLYPH[f.aiReview.verdict] ?? f.aiReview.verdict}: ${f.aiReview.reason}${f.aiReview.sourceUrl ? ` [${f.aiReview.sourceUrl}]` : ""}`);
  if (f.aiDemoted) bits.push(`· ✂️ AUTO-REMOVED (${TIER_EMOJI[f.aiDemoted.originalTier]}→🛑): ${f.aiDemoted.reason} [${f.aiDemoted.sourceUrl}]`);
  return "    " + bits.filter(Boolean).join(" ");
}

function editionSummary(r: ReconcileResult): string {
  const c = r.counts;
  const lines: string[] = [];
  lines.push(`  ── ${r.pillar} — ${c.green}🟢 / ${c.yellow}🟡 / ${c.red}🔴 · total ${c.total} · +${c.addedByAiNet} AI-net · ${r.rejected.length} rejected ──`);
  // red, yellow, green (problems first) then any left over
  const order = ["red", "yellow", "green"];
  const shown = new Set<ReconciledFilm>();
  for (const tier of order) {
    for (const f of r.reconciled.filter((x) => x.tier === tier)) {
      lines.push(filmSummaryLine(f));
      shown.add(f);
    }
  }
  for (const f of r.reconciled) if (!shown.has(f)) lines.push(filmSummaryLine(f));
  if (r.reconciled.length === 0) lines.push("    (no reconciled films)");
  if (r.rejected.length) {
    lines.push(`    Rejected (${r.rejected.length}):`);
    for (const rej of r.rejected) lines.push(`      🚫 ${rej.title ?? "(untitled)"} — ${rej.reason}${rej.sourceUrl ? ` [${rej.sourceUrl}]` : ""}`);
  }
  return lines.join("\n");
}

// ── Main — replicate the job's read-only prefix, then print ──────────────────

async function main(): Promise<void> {
  // Windows — IDENTICAL arithmetic to wednesday-drop.ts main().
  const today = startOfDay(new Date());
  const weekStartMon = startOfWeek(today, { weekStartsOn: 1 }); // Monday
  const wednesday = addDays(weekStartMon, 2);                   // Wednesday
  const sunday = endOfWeek(today, { weekStartsOn: 1 });         // Sunday

  const startDate = format(wednesday, "yyyy-MM-dd");
  const endDate = format(sunday, "yyyy-MM-dd");
  const ottStartDate = format(weekStartMon, "yyyy-MM-dd");

  console.error(`\n[dump] Theatrical window: ${startDate} → ${endDate}  |  OTT window: ${ottStartDate} → ${endDate}`);

  // 1. FIND both pools (Promise.all), exactly as the job.
  const [theatrical, ott] = await Promise.all([
    getCandidates({ from: startDate, to: endDate, intent: "theatrical" }),
    getCandidates({ from: ottStartDate, to: endDate, intent: "ott" }),
  ]);
  console.error(`[dump] Candidates: ${theatrical.length} theatrical + ${ott.length} OTT`);

  // 2. VERIFY — sequential array literal (theatrical first, then ott). aiReview
  //    OFF (default), cap 40 (default), languages = RECONCILE_LANGUAGES.
  const results: ReconcileResult[] = [
    await verifyCandidates(theatrical, { pillar: "theatrical", window: editionWindow("theatrical", startDate, endDate), languages: RECONCILE_LANGUAGES }),
    await verifyCandidates(ott, { pillar: "ott", window: editionWindow("ott", ottStartDate, endDate), languages: RECONCILE_LANGUAGES }),
  ];

  // 3. AI-REVIEW — Wednesday's explicit pre-gate annotate (mutates results).
  await annotateWithAiReview(results);

  // 4. HASH — the SAME pure fn decideGate computes; STOP before decideGate.
  const approveHash = computeDropHash(results);

  // ── Emit ──
  const output = {
    generatedAt: new Date().toISOString(),
    windows: {
      theatrical: { start: startDate, end: endDate },
      ott: { start: ottStartDate, end: endDate },
    },
    approveHash,
    editions: results.map(editionJson),
  };

  const bar = "═".repeat(64);
  console.log(`\n${bar}`);
  console.log(`  APPROVE HASH:  ${approveHash}`);
  console.log(`${bar}\n`);

  console.log("```json");
  console.log(JSON.stringify(output, null, 2));
  console.log("```\n");

  console.log("── Human-readable summary ─────────────────────────────────────");
  console.log(`  Theatrical: ${startDate} → ${endDate}   |   OTT: ${ottStartDate} → ${endDate}`);
  for (const r of results) console.log("\n" + editionSummary(r));

  console.log(`\n${bar}`);
  console.log(`  APPROVE HASH:  ${approveHash}`);
  console.log(`${bar}`);
  console.log(
    "This is a READ-ONLY reconstruction — nothing was published, rendered, or approved.\n" +
    "If this approveHash matches your Slack ping, the dump is faithful to what's gated."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[dump] FAILED:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
