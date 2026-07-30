// scripts/machine-room/preflight.ts
// EVERYTHING THAT MUST BE TRUE BEFORE THE FIRST SPEND.
//
// The failure this exists to prevent: a Wednesday run checked the working tree,
// then spent ~3 minutes and ~34 Tavily credits on discovery and enrichment
// before it ever touched `claude` — which then hung on the workspace-trust
// dialog. Every precondition below is therefore verified BEFORE the spawn, and
// the first RED aborts the run outright.
//
// ── ORDERING ────────────────────────────────────────────────────────────────
// The packet asks for "cheapest-first, stop at first RED" and then lists the
// checks a–g with the two expensive probes (claude, Chromium) ahead of the two
// cheapest (disk, lock). Those two instructions conflict, so this follows the
// PRINCIPLE rather than the list order: token → keys → tree → disk → lock →
// claude → Chromium. That way a full disk or a held lock aborts BEFORE the
// claude call is paid for, which is the entire point of checking before spend.
// Every check from the list is present; only the sequence differs.
//
// The only thing preflight spends is one trivial Max-plan `claude -p`.
//
// PURE CLASSIFIERS, INJECTED PROBES. Each classify* function is a total
// function from an observation to a verdict, so the interesting logic is
// unit-tested with fakes and no real spawn, launch, or filesystem ever runs in
// the suite.

import { statfsSync } from "node:fs";
import { spawn } from "node:child_process";
import { redactSecrets } from "../../src/shared/redact.js";
import { PUBLISH_LOCK, inspectLock, type LockHolder } from "./lock.js";
import { OUTPUT_DIR, REPO_ROOT } from "./paths.js";
import { killTree } from "./proc.js";

export type Level = "red" | "yellow";

export interface Check {
  name: string;
  ok: boolean;
  /**
   * Severity. When ok is false this is how bad it is — "red" aborts the run,
   * "yellow" is surfaced and proceeds. When ok is true this carries the
   * severity the check WOULD have had, so the UI can colour a passing row by
   * its stakes.
   */
  level: Level;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: Check[];
  /** Name of the RED check that stopped the sequence, when one did. */
  stoppedAt?: string;
  ranAt: string;
}

/** Below this, a render has nowhere to write its PNGs. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;

/** How long we let `claude -p` sit before calling it hung. */
export const CLAUDE_TIMEOUT_MS = 30_000;

// ── Pure classifiers ────────────────────────────────────────────────────────

export function classifyAdminToken(present: boolean): Check {
  return present
    ? { name: "admin token", ok: true, level: "red", detail: "MACHINE_ROOM_TOKEN is set" }
    : {
        name: "admin token",
        ok: false,
        level: "red",
        detail: "MACHINE_ROOM_TOKEN is not set — the server should not have started",
      };
}

export interface KeyStatus {
  requiredLoaded: boolean;
  tavily: boolean;
  mdblist: boolean;
}

/**
 * Required keys are validated by shared/config.ts at import, which process.exits
 * on failure — so if this server is running, they are present. That makes the
 * required half a belt-check. The OPTIONAL half is the one that matters: both
 * degrade SILENTLY into a successful-but-diminished run, so each absence is a
 * YELLOW that names the degradation rather than a line nobody reads.
 */
export function classifyKeys(s: KeyStatus): Check[] {
  const out: Check[] = [
    {
      name: "required keys",
      ok: s.requiredLoaded,
      level: "red",
      detail: s.requiredLoaded
        ? "all 8 required keys loaded (config parsed at startup)"
        : "config failed to load — required keys missing",
    },
  ];
  out.push({
    name: "TAVILY_API_KEY",
    ok: s.tavily,
    level: "yellow",
    detail: s.tavily
      ? "present — the AI-search net will run"
      : "ABSENT — runAiNet returns empty, so the drop reconciles on TMDb only and press-confirmed OTT finds are lost",
  });
  out.push({
    name: "MDBLIST_API_KEY",
    ok: s.mdblist,
    level: "yellow",
    detail: s.mdblist
      ? "present — richer multi-source ratings"
      : "ABSENT — ratings silently fall back to OMDb alone; the TBSI score blends fewer sources",
  });
  return out;
}

/**
 * A dirty tree is legal for a MANUAL run — the operator is present and owns the
 * call, which is exactly what assertPublishableTree encodes. So this is YELLOW,
 * never RED: it surfaces the provenance line the manifest will record, so the
 * operator sees what they are about to publish from.
 */
export function classifyTree(provenance: string, dirty: boolean | null): Check {
  if (dirty === null) {
    return {
      name: "working tree",
      ok: false,
      level: "yellow",
      detail: `git state unreadable — ${provenance}. A scheduled run would refuse; a manual run proceeds unproven.`,
    };
  }
  if (dirty) {
    return {
      name: "working tree",
      ok: false,
      level: "yellow",
      detail: `${provenance} — jobs execute the WORKING TREE, so uncommitted changes are what will publish`,
    };
  }
  return { name: "working tree", ok: true, level: "yellow", detail: provenance };
}

export function classifyDisk(freeBytes: number | null, minBytes = MIN_FREE_BYTES): Check {
  if (freeBytes === null) {
    return {
      name: "disk space",
      ok: false,
      level: "yellow",
      detail: "could not measure free space on the output/ volume",
    };
  }
  const mb = Math.round(freeBytes / 1024 / 1024);
  const minMb = Math.round(minBytes / 1024 / 1024);
  return freeBytes >= minBytes
    ? { name: "disk space", ok: true, level: "red", detail: `${mb} MB free on the output/ volume` }
    : {
        name: "disk space",
        ok: false,
        level: "red",
        detail: `only ${mb} MB free (need ${minMb} MB) — a render would fail mid-run, after spend`,
      };
}

export function classifyLock(state: { held: boolean; holder: LockHolder | null; alive: boolean }): Check {
  if (!state.held) return { name: "publish lock", ok: true, level: "red", detail: "free" };
  const h = state.holder;
  if (!state.alive) {
    return {
      name: "publish lock",
      ok: true,
      level: "red",
      detail: `a STALE lock from dead pid ${h?.pid ?? "?"} will be taken over`,
    };
  }
  return {
    name: "publish lock",
    ok: false,
    level: "red",
    detail: `HELD by live pid ${h?.pid} running ${h?.jobName || "(unnamed)"} since ${h?.startedAt || "?"}`,
  };
}

export type ClaudeProbe =
  | { kind: "ok"; ms: number }
  | { kind: "absent"; message: string }
  | { kind: "hung"; ms: number }
  | { kind: "nonzero"; code: number | null; stderr: string };

/**
 * The four outcomes are reported SEPARATELY because they need different
 * actions from the operator, and today's code cannot tell them apart at all —
 * claude.ts has no timeout, so the hung case simply never returns.
 */
export function classifyClaude(p: ClaudeProbe): Check {
  switch (p.kind) {
    case "ok":
      return { name: "claude CLI", ok: true, level: "red", detail: `answered in ${p.ms} ms` };
    case "absent":
      return {
        name: "claude CLI",
        ok: false,
        level: "red",
        detail: `binary not found or could not be spawned — ${redactSecrets(p.message)}`,
      };
    case "hung":
      return {
        name: "claude CLI",
        ok: false,
        level: "red",
        detail:
          `no reply in ${Math.round(p.ms / 1000)}s and the probe was killed. This is the ` +
          `workspace-trust class: the CLI is waiting on an interactive dialog that a ` +
          `headless -p run can never answer. Open claude in this folder once and approve it.`,
      };
    case "nonzero":
      return {
        name: "claude CLI",
        ok: false,
        level: "red",
        detail: `exited ${p.code ?? "?"} — ${redactSecrets(p.stderr).slice(0, 400)}`,
      };
  }
}

export function classifyChromium(r: { ok: boolean; message?: string }): Check {
  return r.ok
    ? { name: "Chromium", ok: true, level: "red", detail: "launched and closed cleanly" }
    : {
        name: "Chromium",
        ok: false,
        level: "red",
        detail: `puppeteer could not launch — ${redactSecrets(r.message ?? "unknown")}`,
      };
}

// ── Live probes ─────────────────────────────────────────────────────────────

export function probeDisk(dir: string = OUTPUT_DIR): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    try {
      const s = statfsSync(REPO_ROOT);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }
}

/**
 * Spawn the SAME shape claude.ts uses — `claude -p` through the shell, from the
 * repo root — with the hard timeout claude.ts lacks. A trivial prompt, so the
 * spend is one negligible Max-plan call.
 */
export function probeClaude(timeoutMs = CLAUDE_TIMEOUT_MS): Promise<ClaudeProbe> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (p: ClaudeProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(p);
    };

    const child = spawn("claude", ["-p", "--model", "claude-opus-4-8"], {
      cwd: REPO_ROOT,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));

    const timer = setTimeout(() => {
      // killTree, not child.kill: shell:true means the handle is the cmd.exe
      // shim, and signalling it would orphan a `claude` that is still sitting
      // on the trust dialog — the very thing we are timing out on. See proc.ts.
      killTree(child.pid);
      done({ kind: "hung", ms: Date.now() - started });
    }, timeoutMs);

    child.on("error", (e) => done({ kind: "absent", message: e.message }));
    child.on("close", (code) => {
      if (code === 0) done({ kind: "ok", ms: Date.now() - started });
      else done({ kind: "nonzero", code, stderr: stderr || stdout });
    });

    try {
      child.stdin.write("Reply with the single word: ok");
      child.stdin.end();
    } catch {
      /* the error handler above covers it */
    }
  });
}

export async function probeChromium(): Promise<{ ok: boolean; message?: string }> {
  try {
    const puppeteer = (await import("puppeteer")).default;
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    await browser.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export interface PreflightDeps {
  adminTokenPresent: boolean;
  keys: KeyStatus;
  tree: { provenance: string; dirty: boolean | null };
  lock: { held: boolean; holder: LockHolder | null; alive: boolean };
  diskFreeBytes: number | null;
  claude: () => Promise<ClaudeProbe>;
  chromium: () => Promise<{ ok: boolean; message?: string }>;
  now?: () => Date;
}

/**
 * Run the sequence, stopping at the first RED. Cheap checks first, so an abort
 * costs nothing. Returns every check evaluated so far — the UI shows partial
 * progress rather than a bare failure.
 */
export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const checks: Check[] = [];
  const ranAt = (deps.now?.() ?? new Date()).toISOString();
  const stop = (): PreflightReport | null => {
    const red = checks.find((c) => !c.ok && c.level === "red");
    return red ? { ok: false, checks, stoppedAt: red.name, ranAt } : null;
  };

  checks.push(classifyAdminToken(deps.adminTokenPresent));
  let s = stop();
  if (s) return s;

  checks.push(...classifyKeys(deps.keys));
  s = stop();
  if (s) return s;

  checks.push(classifyTree(deps.tree.provenance, deps.tree.dirty));
  s = stop();
  if (s) return s;

  checks.push(classifyDisk(deps.diskFreeBytes));
  s = stop();
  if (s) return s;

  checks.push(classifyLock(deps.lock));
  s = stop();
  if (s) return s;

  // Only now do we spend anything.
  checks.push(classifyClaude(await deps.claude()));
  s = stop();
  if (s) return s;

  checks.push(classifyChromium(await deps.chromium()));
  s = stop();
  if (s) return s;

  return { ok: true, checks, ranAt };
}

/** Assemble the live deps and run. */
export async function runLivePreflight(opts: {
  adminTokenPresent: boolean;
  requiredLoaded: boolean;
  provenance: string;
  dirty: boolean | null;
}): Promise<PreflightReport> {
  return runPreflight({
    adminTokenPresent: opts.adminTokenPresent,
    keys: {
      requiredLoaded: opts.requiredLoaded,
      tavily: !!process.env.TAVILY_API_KEY,
      mdblist: !!process.env.MDBLIST_API_KEY,
    },
    tree: { provenance: opts.provenance, dirty: opts.dirty },
    lock: inspectLock(PUBLISH_LOCK),
    diskFreeBytes: probeDisk(),
    claude: () => probeClaude(),
    chromium: () => probeChromium(),
  });
}
