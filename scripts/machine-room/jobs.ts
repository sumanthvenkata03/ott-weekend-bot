// scripts/machine-room/jobs.ts
// THE JOB REGISTRY — what a button is allowed to run, and in what mode.
//
// M1 IS BUTTONS, NOT DIALS. There is no approve-hash field and no WED_DROP_*
// input anywhere in this file or the UI. Recon flagged that those dials are
// applied POST-gate and are documented hash-neutral, so an --approve token
// stays valid while WED_DROP_EXCLUDE quietly changes the published set. Putting
// them next to an Approve button arms that gap. Solving it deliberately is a
// later milestone's job; M1 simply does not offer them.
//
// MODES ARE THE SAFEST THE JOB SUPPORTS, and they are FORCED — not defaults the
// operator can override:
//   wednesday  → plain. Its own GATE is the safety: an unapproved run writes
//                the review and stops without rendering or publishing.
//   saturday   → --no-deliver   (skips R2 / Notion / Slack)
//   archives   → --no-deliver
//   news       → --no-slack     (dry run; nothing marked seen)
//   radar      → --no-slack
//   monday / sunday / thursday → NO dry-run flag exists in these jobs at all
//                (verified against each entry file). So the button demands the
//                operator TYPE "LIVE", and the UI says plainly what will be
//                sent. An unavailable safety must be stated, never simulated.

// ── MR-M2: THE NEWS DESK IS THREE JOBS, NOT ONE ─────────────────────────────
//
// The interactive News Desk splits the pipeline at the two points where a human
// decides something: WHICH stories, and WHETHER they were actually posted. Each
// step is its own spec with its own LITERAL flag, so the operator's choice never
// becomes an argument.
//
//   news-discover     --discover      feed reads only; zero model calls
//   news-generate     --from-picks    reads the SERVER-written picks file
//   news-mark-posted  --mark-posted   reads the package artifact
//
// buildArgv is untouched and still concatenates entry + frozen flags. The pick
// SET travels as a file at a fixed literal path that the server writes and
// validates; there is no argument through which it could reach a command line.

export type JobId =
  | "wednesday"
  | "saturday"
  | "archives"
  | "news"
  | "radar"
  | "monday"
  | "sunday"
  | "thursday"
  | "news-discover"
  | "news-generate"
  | "news-mark-posted";

export type RunMode = "gated" | "no-deliver" | "no-slack" | "live";

export interface JobSpec {
  id: JobId;
  label: string;
  /** Repo-relative entry, executed as `npx tsx <entry>` from the repo root. */
  entry: string;
  /** Flags M1 FORCES. Not operator-editable. */
  flags: string[];
  mode: RunMode;
  /** Live jobs demand a typed confirmation before the server will spawn them. */
  requiresLiveConfirm: boolean;
  /** Plain-language: what this run WILL send outward. */
  willSend: string;
  /** Plain-language: what it will NOT. */
  willNotSend: string;
  /** Rough cost note for the button. */
  spend: string;
}

export const LIVE_CONFIRM_PHRASE = "LIVE";

export const JOBS: Record<JobId, JobSpec> = {
  wednesday: {
    id: "wednesday",
    label: "Wed Drop",
    entry: "src/jobs/wednesday-drop.ts",
    flags: [],
    mode: "gated",
    requiresLiveConfirm: false,
    willSend: "a REVIEW to Notion + Slack if the gate blocks (the normal case)",
    willNotSend: "no cards render or publish without an --approve token, which M1 does not offer",
    spend: "~34 Tavily credits + ~7 claude calls on a cold cache",
  },
  saturday: {
    id: "saturday",
    label: "Sat Verdict",
    entry: "src/jobs/saturday-verdict.ts",
    flags: ["--no-deliver"],
    mode: "no-deliver",
    requiresLiveConfirm: false,
    willSend: "nothing outward",
    willNotSend: "no R2 upload, no Notion page, no Slack ping",
    spend: "claude calls for verdict research + copy",
  },
  archives: {
    id: "archives",
    label: "TBSI Archives",
    entry: "src/jobs/friday-archives.ts",
    flags: ["--no-deliver"],
    mode: "no-deliver",
    requiresLiveConfirm: false,
    willSend: "nothing outward",
    willNotSend: "no R2 upload, no Notion page, no Slack ping, no ledger write",
    spend: "one claude copy call",
  },
  news: {
    id: "news",
    label: "News Desk",
    entry: "src/jobs/news-edition.ts",
    flags: ["--no-slack"],
    mode: "no-slack",
    requiresLiveConfirm: false,
    willSend: "nothing outward",
    willNotSend: "no Slack post, and NOTHING is marked seen — the scheduled cadence is untouched",
    spend: "feed reads + one claude caption call",
  },
  radar: {
    id: "radar",
    label: "Reddit Radar",
    entry: "src/jobs/reddit-radar.ts",
    flags: ["--no-slack"],
    mode: "no-slack",
    requiresLiveConfirm: false,
    willSend: "nothing outward",
    willNotSend: "no Slack ping, nothing marked seen",
    spend: "free — RSS only",
  },
  monday: {
    id: "monday",
    label: "Mon Movement",
    entry: "src/jobs/monday-movement.ts",
    flags: [],
    mode: "live",
    requiresLiveConfirm: true,
    willSend: "R2 upload + a Notion page + a Slack draft ping — for real",
    willNotSend: "nothing is withheld; this job has no dry-run mode",
    spend: "one claude copy call + R2 puts",
  },
  sunday: {
    id: "sunday",
    label: "Sun Spotlight",
    entry: "src/jobs/sunday-spotlight.ts",
    flags: [],
    mode: "live",
    requiresLiveConfirm: true,
    willSend: "R2 upload + a Notion page + a Slack draft ping — for real",
    willNotSend: "nothing is withheld; this job has no dry-run mode",
    spend: "one claude copy call + R2 puts",
  },
  thursday: {
    id: "thursday",
    label: "Thu Compare",
    entry: "src/jobs/thursday-compare.ts",
    flags: [],
    mode: "live",
    requiresLiveConfirm: true,
    willSend: "a Notion page + a Slack draft ping — for real",
    willNotSend: "nothing is withheld; this job has no dry-run mode",
    spend: "one claude copy call",
  },

  // ── MR-M2 NEWS DESK — three steps, three literal flags ────────────────────
  "news-discover": {
    id: "news-discover",
    label: "News · Get the latest news",
    entry: "src/jobs/news-edition.ts",
    flags: ["--discover"],
    mode: "no-slack",
    requiresLiveConfirm: false,
    willSend: "nothing outward",
    willNotSend: "no Slack post, no R2 upload, and NOTHING is marked seen",
    spend: "feed reads only — zero model calls",
  },
  "news-generate": {
    id: "news-generate",
    label: "News · Generate cards for selected",
    entry: "src/jobs/news-edition.ts",
    flags: ["--from-picks"],
    mode: "no-slack",
    requiresLiveConfirm: false,
    willSend: "nothing outward",
    willNotSend: "no Slack post, no R2 upload, no zip, and NOTHING is marked seen",
    spend: "one batched verify call + one caption call + card renders",
  },
  "news-mark-posted": {
    id: "news-mark-posted",
    label: "News · Mark as posted",
    entry: "src/jobs/news-edition.ts",
    flags: ["--mark-posted"],
    mode: "no-slack",
    requiresLiveConfirm: false,
    willSend: "nothing outward",
    willNotSend:
      "no Slack post, no R2 upload — it writes ONLY the seen ledger, and only the URLs of stories that made the package",
    spend: "nothing — a local ledger write",
  },
};

export function isJobId(v: unknown): v is JobId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(JOBS, v);
}

/**
 * The exact argv handed to spawn, AFTER the executable.
 *
 * `npx tsx <entry> [flags]` — matching claude.ts's precedent of going through
 * the shell so Windows resolves the .cmd shim. The entry is a fixed string from
 * this registry and the flags are literals; nothing operator-supplied is ever
 * interpolated into the command line.
 */
export function buildArgv(spec: JobSpec): string[] {
  return ["tsx", spec.entry, ...spec.flags];
}

/** Full command for display and for spawn. */
export function buildCommand(spec: JobSpec): { command: string; args: string[]; display: string } {
  const args = buildArgv(spec);
  return { command: "npx", args, display: `npx ${args.join(" ")}` };
}
