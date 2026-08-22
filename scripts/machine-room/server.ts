// scripts/machine-room/server.ts
// THE MACHINE ROOM — a local admin surface for running jobs safely.
//
//   npm run machine-room      →  http://127.0.0.1:5179
//
// WHAT THIS IS: buttons and safety. Take the publish lock, prove the
// preconditions before spending, spawn the job, stream its output scrubbed,
// then account for what actually happened by reading the artifacts.
//
// WHAT THIS IS NOT (deliberately, in M1): there is no approve-hash field and no
// WED_DROP_* dial. Recon established those dials apply POST-gate and are
// hash-neutral by design, so offering them beside an Approve button would let a
// valid token publish a set the operator never reviewed. That is a product
// problem to solve on purpose, not a control to ship early.
//
// ── THREE DELIBERATE INVERSIONS OF movie-lookup ─────────────────────────────
//   1. BINDS 127.0.0.1, HARDCODED. movie-lookup flips to 0.0.0.0 when PORT is
//      set, because it is meant to be deployed. This one must never be
//      reachable off-box, so there is no host flip to get wrong.
//   2. AUTH FAILS CLOSED. movie-lookup runs open when unconfigured. Here a
//      missing MACHINE_ROOM_TOKEN is a startup refusal.
//   3. NOT DEPLOYED. render.yaml runs exactly one file and this is not it.
//
// ZERO NEW DEPENDENCIES: node:http, as movie-lookup already proves is enough.
// Nothing here reaches package.json, so nothing reaches the public Render build.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Importing config does two necessary things: it fails fast when a required key
// is missing, and — the reason it must be FIRST — it populates the M0 redaction
// registry in THIS process, so the server-side scrub of child output has the
// real values to match against.
import { config } from "../../src/shared/config.js";
import { readRunContext, provenanceLine } from "../../src/shared/run-context.js";
import { registerSecrets } from "../../src/shared/redact.js";
import { editorialTodayStamp } from "../../src/shared/editorial-clock.js";

import {
  SESSION_COOKIE,
  SessionStore,
  clearedCookie,
  parseCookies,
  readAdminToken,
  sessionCookie,
  tokenMatches,
} from "./auth.js";
import { JOBS, isJobId, type JobSpec } from "./jobs.js";
import { PUBLISH_LOCK, breakLock, holderAgeMs, inspectLock } from "./lock.js";
import { HERE, MR_RUN_LOGS } from "./paths.js";
import { buildArtifactZip, pickArtifact, readArtifact, zipFilename } from "./artifacts.js";
import { toCandidatesView, validateAndWritePicks } from "./news-desk.js";
import {
  PACKAGE_MAX_AGE_HOURS,
  REGENERATE_REMEDY,
  checkFreshness,
  readCandidates,
  readPackage,
} from "../../src/content/news/news-picks.js";
import { probeDisk, runLivePreflight, runPreflight, type PreflightReport } from "./preflight.js";
import { activeRunId, getRun, isOwnLiveHolder, killAll, recentRuns, startRun, subscribe, type StartOutcome } from "./runner.js";
import { sseFrame } from "./stream.js";
import { buildSummary } from "./summary.js";

// ── Startup gate: FAIL CLOSED ───────────────────────────────────────────────
const admin = readAdminToken();
if (!admin.ok) {
  console.error("\n⛔ machine room refused to start.\n");
  console.error(admin.message);
  process.exit(1);
}
const ADMIN_TOKEN = admin.token;

const PORT = Number.parseInt(process.env.MACHINE_ROOM_PORT ?? "5179", 10);
/** HARDCODED. There is no environment variable that can widen this. */
const HOST = "127.0.0.1";

const sessions = new SessionStore();

/**
 * A synthetic job used ONLY to exercise the full spawn → stream → exit path
 * without running a real job. Off unless MACHINE_ROOM_ALLOW_FAKE=1, so it can
 * never appear on an operator's grid by accident.
 */
const FAKE_SPEC: JobSpec = {
  // Attributed to ARCHIVES on purpose: archives is the job whose dry run
  // produced the self-contradicting verdict M1.2 repairs, so the fake child
  // stands in for exactly that case (pngs expected, no manifest ever).
  id: "archives",
  label: "FAKE child (verification only)",
  entry: "scripts/machine-room/_fake-job.ts",
  flags: [],
  mode: "no-deliver",
  requiresLiveConfirm: false,
  willSend: "nothing — this is a test child",
  willNotSend: "everything",
  spend: "nothing",
};
const ALLOW_FAKE = process.env.MACHINE_ROOM_ALLOW_FAKE === "1";

// Verification-only: register the planted value so the SSE transcript shows a
// NAMED marker rather than the generic pattern ***. Gated with the fake job, so
// nothing test-shaped exists in a normal run.
if (ALLOW_FAKE && process.env.MACHINE_ROOM_FAKE_SECRET) {
  registerSecrets({ MACHINE_ROOM_FAKE_SECRET: process.env.MACHINE_ROOM_FAKE_SECRET });
}

// ── Small helpers ───────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function authed(req: IncomingMessage): boolean {
  return sessions.isValid(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

let preflightCache: { report: PreflightReport; at: string } | null = null;

/**
 * `selfHolderPid` is supplied by the RUN path only. Without it the run path's
 * own lock — taken moments earlier, by design, so two clicks cannot both pass —
 * reads as a foreign holder and REDs the run it is checking for. The standalone
 * Preflight button passes nothing and keeps its free/held reporting.
 */
/**
 * Verification-only, and gated behind ALLOW_FAKE so it cannot be reached in a
 * normal run: stub the two EXPENSIVE probes while leaving the rest of preflight
 * — ordering, keys, tree, disk and crucially the LOCK check — completely real.
 *
 * This is a narrow exception to "never let the harness bypass the code under
 * test", and it is drawn deliberately: the M1.1 bug lives in the lock check,
 * which runs BEFORE both probes, so stubbing them removes no coverage of it.
 * Without this the permanent suite would spend a Max-plan claude call and launch
 * Chromium on every single run. The end-to-end acceptance transcript runs with
 * this OFF, so the real path is still proven once, properly.
 */
const SKIP_PROBES = ALLOW_FAKE && process.env.MACHINE_ROOM_SKIP_PROBES === "1";

function livePreflight(selfHolderPid?: number): Promise<PreflightReport> {
  const ctx = readRunContext();
  if (SKIP_PROBES) {
    return runPreflight({
      adminTokenPresent: ADMIN_TOKEN.length > 0,
      keys: { requiredLoaded: !!config.TMDB_API_KEY, tavily: !!process.env.TAVILY_API_KEY, mdblist: !!process.env.MDBLIST_API_KEY },
      tree: { provenance: provenanceLine(ctx), dirty: ctx.dirty },
      lock: inspectLock(PUBLISH_LOCK),
      ...(selfHolderPid !== undefined ? { selfHolderPid } : {}),
      diskFreeBytes: probeDisk(),
      claude: async () => ({ kind: "ok", ms: 0 }),
      chromium: async () => ({ ok: true }),
    });
  }
  return runLivePreflight({
    adminTokenPresent: ADMIN_TOKEN.length > 0,
    // config imported successfully above, or the process would have exited.
    requiredLoaded: !!config.TMDB_API_KEY,
    provenance: provenanceLine(ctx),
    dirty: ctx.dirty,
    ...(selfHolderPid !== undefined ? { selfHolderPid } : {}),
  });
}

/**
 * The /api/run refusal mapping, for the MR-M2 News Desk routes.
 *
 * Written out rather than factored out of /api/run: that handler is the one
 * every existing acceptance test drives, and leaving it byte-identical is worth
 * six duplicated lines. The status codes here are the same three — 409 locked,
 * 428 needs a typed confirmation, 412 preflight RED — so an operator sees one
 * behaviour whichever button they pressed.
 */
function replyToStart(res: ServerResponse, outcome: Extract<StartOutcome, { ok: false }>): void {
  if (outcome.code === "locked") {
    return sendJson(res, 409, { error: outcome.reason, holder: outcome.holder, code: "locked" });
  }
  if (outcome.code === "confirm") {
    return sendJson(res, 428, { error: outcome.reason, code: "confirm" });
  }
  preflightCache = { report: outcome.report, at: new Date().toISOString() };
  return sendJson(res, 412, { error: "preflight failed", code: "preflight", report: outcome.report });
}

/** Append a break-lock audit line next to the run logs. Never throws. */
function auditBreakLock(line: string): void {
  try {
    mkdirSync(MR_RUN_LOGS, { recursive: true });
    appendFileSync(join(MR_RUN_LOGS, "lock-audit.log"), `${line}\n`, "utf8");
  } catch {
    /* an unwritable audit must not block the operator's escape hatch */
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // The shell. Unauthenticated by necessity — it renders the login card.
    if (path === "/" && method === "GET") {
      const html = await readFile(join(HERE, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return void res.end(html);
    }

    if (path === "/login" && method === "POST") {
      const body = await readJsonBody(req);
      const supplied = typeof body.token === "string" ? body.token : undefined;
      if (!tokenMatches(supplied, ADMIN_TOKEN)) {
        // No detail: a wrong token learns nothing about the right one.
        return sendJson(res, 401, { error: "invalid token" });
      }
      const id = sessions.create();
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(id) });
    }

    if (path === "/logout" && method === "POST") {
      sessions.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedCookie() });
    }

    // ── Everything below requires a session ──
    if (!authed(req)) return sendJson(res, 401, { error: "not authenticated" });

    if (path === "/api/status" && method === "GET") {
      const lock = inspectLock(PUBLISH_LOCK);
      const ctx = readRunContext();
      const ageMs = holderAgeMs(lock.holder);
      return sendJson(res, 200, {
        jobs: Object.values(JOBS).map((j) => ({
          id: j.id,
          label: j.label,
          mode: j.mode,
          flags: j.flags,
          requiresLiveConfirm: j.requiresLiveConfirm,
          willSend: j.willSend,
          willNotSend: j.willNotSend,
          spend: j.spend,
        })),
        lock: {
          ...lock,
          ageMs,
          ownLiveHolder: lock.holder ? isOwnLiveHolder(lock.holder.pid) : false,
        },
        provenance: provenanceLine(ctx),
        activeRunId: activeRunId(),
        preflight: preflightCache,
        recent: recentRuns(8),
        today: editorialTodayStamp(),
        allowFake: ALLOW_FAKE,
      });
    }

    if (path === "/api/preflight" && method === "POST") {
      const report = await livePreflight();
      preflightCache = { report, at: new Date().toISOString() };
      return sendJson(res, 200, report);
    }

    if (path === "/api/run" && method === "POST") {
      const body = await readJsonBody(req);
      const job = body.job;
      const liveConfirm = typeof body.liveConfirm === "string" ? body.liveConfirm : undefined;

      const useFake = ALLOW_FAKE && job === "__fake";
      if (!useFake && !isJobId(job)) return sendJson(res, 400, { error: "unknown job" });

      const outcome = await startRun({
        job: useFake ? "archives" : (job as never),
        ...(liveConfirm !== undefined ? { liveConfirm } : {}),
        ...(useFake ? { specOverride: FAKE_SPEC } : {}),
        // The fake child runs the REAL preflight. In M1 it was given a stubbed
        // one "to avoid spending", and that is precisely why the self-deadlock
        // shipped: the acceptance test skipped the code path that was broken.
        // A harness that bypasses the thing under test proves nothing.
        preflight: (selfHolderPid: number) => livePreflight(selfHolderPid),
      });

      if (outcome.ok) return sendJson(res, 200, { ok: true, runId: outcome.runId });
      if (outcome.code === "locked")
        return sendJson(res, 409, { error: outcome.reason, holder: outcome.holder, code: "locked" });
      if (outcome.code === "confirm") return sendJson(res, 428, { error: outcome.reason, code: "confirm" });
      preflightCache = { report: outcome.report, at: new Date().toISOString() };
      return sendJson(res, 412, { error: "preflight failed", code: "preflight", report: outcome.report });
    }

    // ── NEWS DESK (MR-M2): discover → pick → generate → mark posted ────────
    //
    // Four routes, all behind the same session gate as everything else above,
    // and all starting their runs through the SAME startRun + livePreflight +
    // publish-lock path /api/run uses. The only thing new is WHERE the run's
    // input comes from: a file this server writes, never an argument.

    if (path === "/api/news/candidates" && method === "GET") {
      const read = readCandidates();
      // A STALE artifact is still SHOWN — the panel greys the picks and says
      // why, which is more use than an empty page. Only "no artifact at all"
      // is a 404. The POST is where staleness becomes a refusal.
      if (!read.ok) return sendJson(res, 404, { error: `${read.reason} — run "Get the latest news" first` });
      return sendJson(res, 200, toCandidatesView(read.value, Date.now()));
    }

    if (path === "/api/news/picks" && method === "POST") {
      const body = await readJsonBody(req);
      // The server decides. `ids` is the ONLY thing taken from the request, and
      // it is checked by exact equality against this server's own artifact.
      const written = validateAndWritePicks(body.ids, Date.now());
      if (!written.ok) return sendJson(res, written.status, { error: written.error });

      const outcome = await startRun({
        job: "news-generate",
        preflight: (selfHolderPid: number) => livePreflight(selfHolderPid),
      });
      if (outcome.ok) {
        return sendJson(res, 200, {
          ok: true,
          runId: outcome.runId,
          picked: written.picks.pickedIds,
        });
      }
      return replyToStart(res, outcome);
    }

    if (path === "/api/news/package" && method === "GET") {
      const read = readPackage();
      if (!read.ok) return sendJson(res, 404, { error: read.reason });
      const pkg = read.value;
      const fresh = checkFreshness(pkg.generatedAt, Date.now(), PACKAGE_MAX_AGE_HOURS, "package", REGENERATE_REMEDY);
      return sendJson(res, 200, {
        ...pkg,
        ageHours: fresh.ageHours,
        stale: !fresh.fresh,
        // Card PNGs are served through the SAME exact-match allowlist plumbing
        // as run artifacts — the request never contributes to a path.
        cards: pkg.cardFiles.map((name) => ({ name, url: `/api/news/card?f=${encodeURIComponent(name)}` })),
      });
    }

    // The package's own cardFiles ARE the allowlist. pickArtifact + readArtifact
    // are the identical pair /api/artifacts uses; only the allowlist's source
    // differs (a package artifact rather than a run summary).
    if (path === "/api/news/card" && method === "GET") {
      const read = readPackage();
      if (!read.ok) return sendJson(res, 404, { error: read.reason });
      const picked = pickArtifact(read.value.cardFiles, url.searchParams.get("f"));
      if (!picked.ok) return sendJson(res, picked.status, { error: picked.reason });
      try {
        const bytes = readArtifact(picked.name);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.length),
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="${picked.name}"`,
        });
        return void res.end(bytes);
      } catch {
        return sendJson(res, 410, { error: "artifact no longer on disk" });
      }
    }

    if (path === "/api/news/mark-posted" && method === "POST") {
      const read = readPackage();
      if (!read.ok) return sendJson(res, 404, { error: read.reason });
      const outcome = await startRun({
        job: "news-mark-posted",
        preflight: (selfHolderPid: number) => livePreflight(selfHolderPid),
      });
      if (outcome.ok) {
        return sendJson(res, 200, { ok: true, runId: outcome.runId, stories: read.value.stories.length });
      }
      return replyToStart(res, outcome);
    }

    // ── ARTIFACTS: this run's rendered cards ───────────────────────────────
    // The allowlist is whatever the run's OWN summary listed. The request can
    // only select from it by exact equality — it never contributes to a path.
    if (path === "/api/artifacts" && method === "GET") {
      const rec = getRun(url.searchParams.get("run") ?? "");
      if (!rec?.summary) return sendJson(res, 404, { error: "no such run" });
      const picked = pickArtifact(rec.summary.pngs.map((p) => p.name), url.searchParams.get("f"));
      if (!picked.ok) return sendJson(res, picked.status, { error: picked.reason });
      try {
        const bytes = readArtifact(picked.name);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.length),
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="${picked.name}"`,
        });
        return void res.end(bytes);
      } catch {
        return sendJson(res, 410, { error: "artifact no longer on disk" });
      }
    }

    if (path === "/api/artifacts/zip" && method === "GET") {
      const rec = getRun(url.searchParams.get("run") ?? "");
      if (!rec?.summary) return sendJson(res, 404, { error: "no such run" });
      // FRESH only: "download all" means this run's output, not the day's.
      const names = rec.summary.pngs.filter((p) => p.fresh).map((p) => p.name);
      if (names.length === 0) return sendJson(res, 409, { error: "this run rendered no cards" });
      const buf = buildArtifactZip(names);
      const filename = zipFilename(rec.job, rec.summary.date);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      return void res.end(buf);
    }

    if (path === "/api/lock/break" && method === "POST") {
      const body = await readJsonBody(req);
      if (body.confirm !== "CONFIRM") {
        return sendJson(res, 428, { error: 'type CONFIRM to break the publish lock', code: "confirm" });
      }
      const state = inspectLock(PUBLISH_LOCK);
      if (!state.held || !state.holder) return sendJson(res, 409, { error: "the lock is not held" });

      // THE ONE CASE BREAKING IS NEVER RIGHT: the holder is a run THIS server is
      // still running. Forcing it would let a second job start alongside a live
      // one — the exact collision the lock exists to prevent.
      if (isOwnLiveHolder(state.holder.pid)) {
        return sendJson(res, 409, {
          error:
            `refusing to break — pid ${state.holder.pid} is a run THIS machine room is still executing ` +
            `(${state.holder.jobName}). Let it finish, or stop the server.`,
          code: "own-live-run",
          holder: state.holder,
        });
      }

      const result = breakLock(PUBLISH_LOCK);
      const age = holderAgeMs(state.holder);
      auditBreakLock(
        `${new Date().toISOString()} BREAK-LOCK by operator session · was pid ${state.holder.pid} ` +
        `job="${state.holder.jobName}" startedAt=${state.holder.startedAt} ` +
        `ageMs=${age ?? "unknown"} alive=${state.alive} · ${result.reason}`
      );
      console.warn(`[machine-room] BREAK-LOCK — ${result.reason} (job "${state.holder.jobName}")`);
      return sendJson(res, 200, { ok: result.broken, was: result.was, reason: result.reason });
    }

    const stream = path.match(/^\/api\/stream\/([A-Za-z0-9._-]+)$/);
    if (stream && method === "GET") {
      const runId = stream[1]!;
      const rec = getRun(runId);
      if (!rec) return sendJson(res, 404, { error: "no such run" });

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Replay the backlog so a client that attaches late sees the whole run.
      for (const l of rec.lines) res.write(sseFrame("line", l));
      if (rec.status !== "running") {
        res.write(sseFrame("exit", { exitCode: rec.exitCode ?? null, endedAt: rec.endedAt, summary: rec.summary }));
      }

      const unsubscribe = subscribe(runId, (frame) => res.write(frame));
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }

    const summary = path.match(/^\/api\/runs\/([A-Za-z0-9._-]+)\/summary$/);
    if (summary && method === "GET") {
      const rec = getRun(summary[1]!);
      if (!rec) return sendJson(res, 404, { error: "no such run" });
      return sendJson(res, 200, {
        runId: rec.runId,
        label: rec.label,
        mode: rec.mode,
        display: rec.display,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        exitCode: rec.exitCode,
        status: rec.status,
        logFile: rec.logFile,
        summary: rec.summary ?? buildSummary(editorialTodayStamp()),
      });
    }

    sendJson(res, 404, { error: `no route ${path}` });
  } catch (e) {
    // Same discipline as the M0.5 movie-lookup fix: never echo a raw message.
    console.error("[machine-room]", e instanceof Error ? (e.stack ?? e.message) : String(e));
    sendJson(res, 500, { error: "internal error — see the machine-room console" });
  }
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n⛔ port ${PORT} is already in use on ${HOST}.`);
    console.error("   Likely another machine-room instance in a second terminal.");
    console.error("   (5178 is the movie-lookup tool; this server uses 5179 to stay clear of it.)");
    console.error(`   Free it, or start with:  MACHINE_ROOM_PORT=5180 npm run machine-room\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const lock = inspectLock(PUBLISH_LOCK);
  console.log(`\n🛠  TBSI Machine Room`);
  console.log(`   ▶ http://${HOST}:${PORT}`);
  console.log(`   Auth: REQUIRED (fails closed) · bound to ${HOST} only`);
  console.log(`   Publish lock: ${lock.held ? `HELD by pid ${lock.holder?.pid} (${lock.alive ? "live" : "STALE"})` : "free"}`);
  if (ALLOW_FAKE) console.log(`   ⚠ MACHINE_ROOM_ALLOW_FAKE=1 — the synthetic "__fake" job is exposed`);
  console.log(`   Stop with Ctrl+C\n`);
});

function shutdown(sig: NodeJS.Signals): void {
  console.log(`\n${sig} — stopping. Killing any live child and releasing the publish lock…`);
  const n = killAll();
  console.log(`   ${n} child process(es) signalled.`);
  server.close(() => process.exit(0));
  // Do not wait forever on lingering keep-alive SSE sockets.
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
