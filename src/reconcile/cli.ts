// src/reconcile/cli.ts
// Standalone reconciliation runner — Phase 3 low-cost test harness.
//   Usage: tsx src/reconcile/cli.ts <from> <to> [lang,lang,...] [--write-review] [--approve <hash>]
//   e.g.   tsx src/reconcile/cli.ts 2026-06-22 2026-06-28 te,ta,ml,hi,kn
//
// Runs BOTH editions (theatrical + ott) over ONE window, augmenting each TMDb
// pool with the AI-search net (Tavily + 1 LLM extraction per edition = 2 total),
// prints the full provenance-tagged tiered list, then demonstrates the gate:
// no-approve (blocked), wrong-hash (blocked), right-hash (approved). It does NOT
// render and does NOT publish. Pass --write-review to actually write the Notion +
// Slack review artifact once.
import "dotenv/config";

import { ingestReleases, ingestOTTArrivals } from "../ingestion/releases/index.js";
import { editionWindow, RECONCILE_LANGUAGES } from "./run.js";
import { verifyCandidates } from "./verify.js";
import { decideGate, computeDropHash, writeReview } from "./gate.js";
import type { ReconciledFilm, ReconcileResult } from "./types.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TIER = { green: "🟢", yellow: "🟡", red: "🔴" } as const;

const CODE_TO_NAME: Record<string, string> = {
  te: "Telugu", ta: "Tamil", ml: "Malayalam", kn: "Kannada",
  hi: "Hindi", bn: "Bengali", mr: "Marathi", pa: "Punjabi",
};

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  console.error("Usage: tsx src/reconcile/cli.ts <from> <to> [lang,lang,...] [--write-review] [--approve <hash>]");
  process.exit(1);
}

function resolveLanguages(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const name = CODE_TO_NAME[t.toLowerCase()] ?? (RECONCILE_LANGUAGES.includes(t) ? t : undefined);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function printFilm(f: ReconciledFilm): void {
  const head = `  ${TIER[f.tier]} ${f.title} (${f.language}) · ${f.pillar}`;
  const meta = [
    f.platform ? `platform=${f.platform}` : "",
    f.date ? `date=${f.date}[${f.dateSource}]` : "date=—",
    `nets=${f.foundIn.join("+")}`,
    `status=${f.status}`,
    f.landingStatus ? `landing=${f.landingStatus}` : "",
  ].filter(Boolean).join(" · ");
  console.log(head);
  console.log(`      ${meta}`);
  const flags: string[] = [];
  if (f.ottDateFromPress) flags.push("ott-date-from-press");
  if (f.wasBelowCap) flags.push("was-below-cap");
  if (f.ambiguousMatch) flags.push("ambiguous-match");
  if (f.possibleDuplicate) flags.push("possible-duplicate");
  if (f.conflictDetail) flags.push(`conflict[${f.conflictDetail}]`);
  if (flags.length) console.log(`      flags: ${flags.join(" · ")}`);
  console.log(`      why: ${f.reasons.join("; ")}`);
  if (f.status === "confirmed") {
    console.log(
      `      TMDb: "${f.resolvedTitle ?? "?"}"` +
      `${f.year !== undefined ? ` (${f.year})` : ""}` +
      `${f.tmdbId !== undefined ? ` id=${f.tmdbId}` : ""}` +
      ` cast=[${(f.cast ?? []).join(", ") || "—"}]` +
      `${f.posterUrl ? ` poster=yes` : " poster=no"}`
    );
  }
  if (f.sourceUrl) console.log(`      source: ${f.sourceUrl}`);
}

function printResult(r: ReconcileResult): void {
  console.log(`\n=== ${r.pillar.toUpperCase()} · ${r.window.start} → ${r.window.end} ===`);
  console.log(`counts: ${r.counts.green}🟢 / ${r.counts.yellow}🟡 / ${r.counts.red}🔴 · total ${r.counts.total} · added by AI net ${r.counts.addedByAiNet}`);
  const order = ["red", "yellow", "green"] as const;
  for (const tier of order) {
    for (const f of r.reconciled.filter(x => x.tier === tier)) printFilm(f);
  }
  if (r.rejected.length) {
    console.log(`  rejected (series / non-film): ${r.rejected.length}`);
    for (const rej of r.rejected) console.log(`    🚫 ${rej.title ?? "(untitled)"} — ${rej.reason}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const writeReviewFlag = argv.includes("--write-review");
  const approveIdx = argv.indexOf("--approve");
  const approveHash = approveIdx !== -1 ? argv[approveIdx + 1] : undefined;
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(approveIdx !== -1 && i === approveIdx + 1));
  const [from, to, langArg] = positional;

  if (!from || !to) fail("missing <from> and/or <to>");
  if (!ISO.test(from) || !ISO.test(to)) fail("dates must be ISO yyyy-mm-dd");
  if (from > to) fail("<from> must be <= <to>");

  const languages = langArg ? resolveLanguages(langArg.split(",").map(s => s.trim()).filter(Boolean)) : RECONCILE_LANGUAGES;
  if (langArg && languages.length === 0) fail("no valid languages");

  console.log(`\nReconcile test · window ${from} → ${to} · languages ${languages.join(", ")}`);
  console.log("Ingesting TMDb pools (theatrical + ott)...");
  const [theatrical, ott] = await Promise.all([
    ingestReleases(from, to),
    ingestOTTArrivals(from, to),
  ]);
  console.log(`TMDb pools: ${theatrical.length} theatrical · ${ott.length} ott`);

  console.log("\nRunning AI-search net + reconcile (2 LLM extractions)...");
  const results: ReconcileResult[] = [
    await verifyCandidates(theatrical, { pillar: "theatrical", window: editionWindow("theatrical", from, to), languages }),
    await verifyCandidates(ott, { pillar: "ott", window: editionWindow("ott", from, to), languages }),
  ];

  for (const r of results) printResult(r);

  // ── Gate demonstration (pure; no render, no publish) ──────────────────────
  const hash = computeDropHash(results);
  console.log(`\n=== GATE ===`);
  console.log(`drop hash: ${hash}`);

  const blocked = decideGate(results, { autoPassGreen: false });
  console.log(`no --approve            → proceed=${blocked.proceed} mode=${blocked.mode} (${blocked.reason})`);

  const wrong = decideGate(results, { approveHash: "deadbeef0000", autoPassGreen: false });
  console.log(`--approve deadbeef0000  → proceed=${wrong.proceed} mode=${wrong.mode} (stale-hash guard)`);

  const right = decideGate(results, { approveHash: hash, autoPassGreen: false });
  const renderCount = Object.values(right.renderable).reduce((a, x) => a + (x?.length ?? 0), 0);
  console.log(`--approve ${hash}  → proceed=${right.proceed} mode=${right.mode} · renderable films=${renderCount} (🔴 excluded)`);

  const auto = decideGate(results, { autoPassGreen: true });
  console.log(`autoPassGreen=true      → proceed=${auto.proceed} mode=${auto.mode} (${auto.reason})`);

  if (approveHash) {
    const d = decideGate(results, { approveHash, autoPassGreen: false });
    console.log(`\nsupplied --approve ${approveHash}: proceed=${d.proceed} mode=${d.mode} — ${d.reason}`);
  }

  if (writeReviewFlag) {
    console.log(`\nWriting review artifact (Notion + Slack)...`);
    const url = await writeReview(results, hash);
    console.log(`review: ${url}`);
  } else {
    console.log(`\n(no --write-review: skipped Notion/Slack write. Job path calls writeReview() when blocked.)`);
  }

  console.log("");
}

main().catch((err) => {
  console.error("✗ reconcile cli failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
