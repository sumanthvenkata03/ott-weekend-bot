// scripts/machine-room/job-artifacts.ts
// WHAT EACH JOB CAN ACTUALLY WRITE — and therefore what "it worked" means.
//
// THE BUG THIS EXISTS TO KILL. An Archives dry run produced a summary that
// contradicted itself in two adjacent lines:
//
//     NO ARTIFACTS for this date — the run stopped before it produced anything
//     5 of 7 PNG(s) written by THIS run
//
// Both statements came from the same object. The verdict was computed from a
// Wednesday-shaped assumption — "no manifest ⇒ nothing happened" — and Archives
// NEVER writes a manifest. It has no saveManifest call anywhere. So the only
// artifact class it can produce was the one class the verdict ignored.
//
// The fix is to stop asking "did the generic artifacts appear" and start asking
// "did THIS job produce what THIS job produces". Which means a registry, and
// the registry has to be read out of the jobs rather than guessed.
//
// ── HOW THIS TABLE WAS DERIVED (read, not assumed) ──────────────────────────
//   wednesday  src/jobs/wednesday-drop.ts:245 saveManifest · :551 saveRunArtifact
//              results · :224 draft · :271 renderWedDrop("output/posts")
//              · :394 recordFeatured. The GATE can stop the run after results
//              are written and before anything renders — the review-only case.
//   saturday   :295 saveManifest and :299 render BOTH precede the deliver gate
//              at :315, so a --no-deliver run still writes manifest + PNGs.
//   archives   :202 renderArchives precedes the dry-run return at :204, so a
//              dry run writes PNGs — and ONLY PNGs. No saveManifest exists in
//              the file. Zip, caption and the picks ledger are all after :210.
//   news       :415 renderNews runs only when edition.format !== "none", so a
//              quiet day legitimately produces nothing at all.
//   radar      writes nothing to output/ — it pings Slack and marks seen.
//   monday     :137 render · :204 saveManifest, both unconditional.
//   sunday     :86 saveManifest · :90 render, both unconditional.
//   thursday   writes nothing to output/ — Notion + Slack only, no renderer.
//
// PNG prefixes come from the renderers: wed-drop- / sat-verdict- /
// tbsi-archives- (render-archives.ts:21) / tbsi-news- (render-news.ts:30) /
// mon-movement- / sun-spotlight-.
//
// PURE. No I/O — the caller counts files and hands the counts in.

import type { JobId } from "./jobs.js";

/** The artifact classes the machine room can observe on disk. */
export type ArtifactClass = "manifests" | "results" | "pngs";

export interface JobArtifactSpec {
  /**
   * What a NORMAL completed run writes, in the mode M1 forces. Absence of any
   * of these is what makes a run "partial".
   */
  expects: ArtifactClass[];
  /**
   * May or may not appear; absence is NOT a fault. Wednesday's manifest and
   * PNGs live here because the gate blocking is a correct outcome, not a
   * failure.
   */
  optional: ArtifactClass[];
  /** Filename prefix for this job's PNGs, or null when it renders none. */
  pngPrefix: string | null;
  /** Set when producing nothing is a legitimate outcome, with the reason. */
  emptyIsNormal?: string;
  /** Is M1's forced mode a dry run (nothing leaves the box)? */
  dryRun: boolean;
  /** What the forced mode withholds, for the verdict wording. */
  withheld?: string;
}

export const JOB_ARTIFACTS: Record<JobId, JobArtifactSpec> = {
  wednesday: {
    // The gate is the normal outcome, and a gated run writes ONLY results.
    expects: ["results"],
    optional: ["manifests", "pngs"],
    pngPrefix: "wed-drop-",
    dryRun: false,
  },
  saturday: {
    expects: ["manifests", "pngs"],
    optional: [],
    pngPrefix: "sat-verdict-",
    dryRun: true,
    withheld: "no R2 upload, no Notion page, no Slack ping",
  },
  archives: {
    // THE FOUNDING CASE. Archives writes no manifest, ever.
    expects: ["pngs"],
    optional: [],
    pngPrefix: "tbsi-archives-",
    dryRun: true,
    withheld: "no R2 upload, no Notion page, no Slack ping, no ledger write",
  },
  news: {
    expects: ["pngs"],
    optional: [],
    pngPrefix: "tbsi-news-",
    emptyIsNormal: "a quiet news day renders nothing at all (edition.format === \"none\")",
    dryRun: true,
    withheld: "no Slack post, and nothing marked seen",
  },
  radar: {
    expects: [],
    optional: [],
    pngPrefix: null,
    emptyIsNormal: "this job writes no artifacts — it reads RSS and pings Slack",
    dryRun: true,
    withheld: "no Slack ping, nothing marked seen",
  },
  monday: {
    expects: ["manifests", "pngs"],
    optional: [],
    pngPrefix: "mon-movement-",
    dryRun: false,
  },
  sunday: {
    expects: ["manifests", "pngs"],
    optional: [],
    pngPrefix: "sun-spotlight-",
    dryRun: false,
  },
  thursday: {
    expects: [],
    optional: [],
    pngPrefix: null,
    emptyIsNormal: "this job writes no artifacts — it drafts to Notion and pings Slack",
    dryRun: false,
  },

  // ── MR-M2 NEWS DESK ───────────────────────────────────────────────────────
  // These three write to output/machine-room/, which is NOT one of the three
  // artifact classes this registry observes (manifests / results / posts PNGs).
  // Saying "expects: []" is therefore the honest entry, not a shrug: the News
  // Desk panel reads its own artifacts over its own endpoints, and the generic
  // summary's job is only to avoid claiming a failure that did not happen.
  "news-discover": {
    expects: [],
    optional: [],
    pngPrefix: null,
    emptyIsNormal:
      "discovery renders nothing — it writes output/machine-room/news-candidates.json, which the News Desk panel reads",
    dryRun: true,
    withheld: "no Slack post, no R2 upload, nothing marked seen",
  },
  "news-generate": {
    // Cards ARE the point here, but a picked set can legitimately render none:
    // an unconfirmed pick drops, and fewer than two confirmed stories is law N4.
    expects: ["pngs"],
    optional: [],
    pngPrefix: "tbsi-news-",
    emptyIsNormal:
      "the picked stories can fail verification, and fewer than two confirmed stories is a quiet day (edition.format === \"none\")",
    dryRun: true,
    withheld: "no Slack post, no R2 upload, no zip, nothing marked seen",
  },
  "news-mark-posted": {
    expects: [],
    optional: [],
    pngPrefix: null,
    emptyIsNormal:
      "this step renders nothing — it writes the seen ledger for the stories that made the package",
    // NOT a dry run: the seen ledger is exactly what it exists to write.
    dryRun: false,
  },
};

export type RunVerdictKind =
  | "as-expected"
  | "review-only"
  | "partial"
  | "produced-nothing"
  | "nothing-expected";

export interface FreshCounts {
  manifests: number;
  results: number;
  pngs: number;
}

export interface RunVerdict {
  kind: RunVerdictKind;
  /** The headline. Never contradicts the counts beneath it. */
  text: string;
  /** Classes the job should have written and did not. */
  missing: ArtifactClass[];
}

const LABEL: Record<ArtifactClass, string> = {
  manifests: "a manifest",
  results: "reconcile results",
  pngs: "rendered card(s)",
};

function count(f: FreshCounts, c: ArtifactClass): number {
  return c === "manifests" ? f.manifests : c === "results" ? f.results : f.pngs;
}

/**
 * The job-aware verdict, computed from FRESH counts only — artifacts this run
 * actually caused, never ones it merely shares a date with.
 *
 * The wording is deliberately positive when a job did what it is supposed to
 * do. "No manifest" is not a failure for a job that never writes one, and a dry
 * run that renders cards and delivers nothing is a SUCCESS, not an absence.
 */
export function classifyRun(job: JobId, fresh: FreshCounts): RunVerdict {
  const spec = JOB_ARTIFACTS[job];
  const produced = fresh.manifests + fresh.results + fresh.pngs;
  const missing = spec.expects.filter((c) => count(fresh, c) === 0);
  const dry = spec.dryRun ? ` — nothing delivered (${spec.withheld ?? "by design"})` : "";

  // A job that writes nothing by design, and wrote nothing. This is success.
  if (spec.expects.length === 0 && produced === 0) {
    return {
      kind: "nothing-expected",
      missing: [],
      text: `COMPLETE — ${spec.emptyIsNormal ?? "this job writes no artifacts"}. Nothing to show here is the correct outcome.`,
    };
  }

  // Wednesday's gate: results written, nothing rendered. Correct, not a failure.
  if (job === "wednesday" && fresh.results > 0 && fresh.pngs === 0 && fresh.manifests === 0) {
    return {
      kind: "review-only",
      missing: [],
      text:
        "REVIEW ONLY — reconciled and wrote the review, then the GATE stopped it. " +
        "Nothing rendered and nothing published, which is the normal outcome without an --approve token.",
    };
  }

  if (produced === 0) {
    if (spec.emptyIsNormal) {
      return {
        kind: "nothing-expected",
        missing: [],
        text: `NOTHING PRODUCED — and that can be normal here: ${spec.emptyIsNormal}.`,
      };
    }
    return {
      kind: "produced-nothing",
      missing,
      text:
        `PRODUCED NOTHING — this run wrote no ${spec.expects.map((c) => LABEL[c]).join(" and no ")}. ` +
        `Read the log above; the run stopped before it got there.`,
    };
  }

  if (missing.length > 0) {
    return {
      kind: "partial",
      missing,
      text:
        `PARTIAL — produced some artifacts but not ${missing.map((c) => LABEL[c]).join(" and not ")}. ` +
        `Check the log for where it stopped.`,
    };
  }

  // Did everything it should. Lead with the concrete count.
  const bits: string[] = [];
  if (fresh.pngs > 0) bits.push(`${fresh.pngs} PNG(s) rendered`);
  if (fresh.manifests > 0) bits.push(`${fresh.manifests} manifest(s) written`);
  if (fresh.results > 0) bits.push(`reconcile results written`);
  return {
    kind: "as-expected",
    missing: [],
    text: `${spec.dryRun ? "DRY RUN" : "COMPLETE"} — ${bits.join(", ")}${dry}.`,
  };
}
