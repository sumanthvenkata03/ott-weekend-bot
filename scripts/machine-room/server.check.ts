// scripts/machine-room/server.check.ts
// THE SERVER'S AUTH BOUNDARY, exercised for real — a spawned server on a
// dedicated port, hit over HTTP. The pure pieces are covered in auth.check.ts;
// what can only be proven here is that the ROUTES actually enforce them, and in
// particular that the SSE endpoint (which cannot carry an Authorization header,
// hence the cookie) is not accidentally left open.
//
// No job is ever run by this file. It only logs in and reads status.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { editorialTodayStamp } from "../../src/shared/editorial-clock.js";
import { POSTS_DIR } from "./paths.js";
import { REPO_ROOT } from "./paths.js";
import { killTree } from "./proc.js";

/**
 * An OS-assigned free port, not a fixed one. The first version of this file
 * pinned 5187 and a previous run's orphan was still holding it, which failed
 * the suite for a reason that had nothing to do with the code under test.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(p));
    });
  });
}

let PORT = 0;
let BASE = "";
const TOKEN = "machine-room-integration-check-token";
const ENTRY = join("scripts", "machine-room", "server.ts");

let proc: ChildProcess | null = null;

function startServer(env: Record<string, string | undefined>): Promise<{ child: ChildProcess; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", ENTRY], {
      cwd: REPO_ROOT,
      shell: true,
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (c: Buffer) => {
      out += c.toString();
      if (out.includes("Stop with Ctrl+C")) resolve({ child, out });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", () => resolve({ child, out }));
    child.on("error", reject);
    setTimeout(() => resolve({ child, out }), 25_000);
  });
}

beforeAll(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const started = await startServer({
    MACHINE_ROOM_TOKEN: TOKEN,
    MACHINE_ROOM_PORT: String(PORT),
    MACHINE_ROOM_ALLOW_FAKE: "0",
  });
  proc = started.child;
  expect(started.out).toContain(`http://127.0.0.1:${PORT}`);
});

// killTree, not proc.kill(): shell:true means `proc` is the cmd.exe shim, and
// killing it orphans the real node — which is precisely how an earlier run of
// this file left a server holding its port. See proc.ts.
afterAll(() => killTree(proc?.pid));

describe("startup FAILS CLOSED without a token", () => {
  it("refuses to start and prints how to fix it", async () => {
    const other = await freePort();
    // EMPTY STRING, not `undefined`. Omitting the key does not work: server.ts
    // imports shared/config.ts, which runs `dotenv/config`, which would then
    // load MACHINE_ROOM_TOKEN straight out of .env and the server would start —
    // silently turning this into a test that proves nothing. dotenv skips a key
    // already PRESENT in process.env (verified), so an explicit "" is what
    // actually reproduces the unconfigured case.
    const { child, out } = await startServer({
      MACHINE_ROOM_TOKEN: "",
      MACHINE_ROOM_PORT: String(other),
    });
    killTree(child.pid);
    expect(out).toContain("refused to start");
    expect(out).toContain("MACHINE_ROOM_TOKEN is not set");
    expect(out).not.toContain("Stop with Ctrl+C");
  });
});

describe("every data route 401s without a session", () => {
  for (const [method, path] of [
    ["GET", "/api/status"],
    ["POST", "/api/preflight"],
    ["POST", "/api/run"],
    ["GET", "/api/runs/anything/summary"],
  ] as const) {
    it(`${method} ${path} → 401`, async () => {
      const r = await fetch(BASE + path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(r.status).toBe(401);
    });
  }

  it("GET /api/stream/:id → 401 (EventSource cannot send a header, so the cookie is the whole gate)", async () => {
    const r = await fetch(`${BASE}/api/stream/whatever`);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("application/json");
  });

  it("the page itself IS served unauthenticated — it renders the login card", async () => {
    const r = await fetch(BASE + "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Machine Room");
  });
});

describe("login", () => {
  it("rejects a wrong token with 401 and sets no cookie", async () => {
    const r = await fetch(BASE + "/login", { method: "POST", body: JSON.stringify({ token: "wrong" }) });
    expect(r.status).toBe(401);
    expect(r.headers.getSetCookie?.() ?? []).toHaveLength(0);
  });

  it("rejects a missing token", async () => {
    const r = await fetch(BASE + "/login", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("accepts the right token and issues an HttpOnly SameSite=Strict cookie", async () => {
    const r = await fetch(BASE + "/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    expect(r.status).toBe(200);
    const cookies = r.headers.getSetCookie?.() ?? [];
    expect(cookies.join(";")).toContain("mr_session=");
    expect(cookies.join(";")).toContain("HttpOnly");
    expect(cookies.join(";")).toContain("SameSite=Strict");
  });
});

/**
 * M1.1 acceptance, at the HTTP layer: a run must survive its OWN lock, and
 * Break Lock must refuse while that run is live. Uses the fake child with the
 * expensive probes stubbed (MACHINE_ROOM_SKIP_PROBES) — the lock check runs
 * BEFORE those probes, so nothing about the bug under test is bypassed.
 */
describe("M1.1 — a run does not deadlock on its own lock", () => {
  let cookie = "";
  let proc2: ChildProcess | null = null;
  let base2 = "";

  beforeAll(async () => {
    const p = await freePort();
    base2 = `http://127.0.0.1:${p}`;
    const started = await startServer({
      MACHINE_ROOM_TOKEN: TOKEN,
      MACHINE_ROOM_PORT: String(p),
      MACHINE_ROOM_ALLOW_FAKE: "1",
      MACHINE_ROOM_SKIP_PROBES: "1",
      MACHINE_ROOM_FAKE_SECRET: "planted-fake-secret-0123456789",
    });
    proc2 = started.child;
    const login = await fetch(base2 + "/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";
  });

  afterAll(() => killTree(proc2?.pid));

  it("the run STARTS — before the fix this returned 412 stoppedAt=publish lock", async () => {
    const r = await fetch(base2 + "/api/run", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ job: "__fake" }),
    });
    const body = (await r.json()) as { runId?: string; report?: { stoppedAt?: string } };
    expect(r.status).toBe(200);
    expect(body.runId).toBeTruthy();
    expect(body.report?.stoppedAt).toBeUndefined();
  });

  it("its preflight records the lock as self-held rather than a conflict", async () => {
    const st = (await (await fetch(base2 + "/api/status", { headers: { cookie } })).json()) as {
      recent: { preflight?: { checks: { name: string; ok: boolean; detail: string }[] } }[];
    };
    const lockCheck = st.recent[0]?.preflight?.checks.find((c) => c.name === "publish lock");
    expect(lockCheck?.ok).toBe(true);
    expect(lockCheck?.detail).toContain("THIS run");
  });

  it("BREAK LOCK REFUSES while that run is this server's own live child", async () => {
    const r = await fetch(base2 + "/api/lock/break", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ confirm: "CONFIRM" }),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { code: string; error: string };
    expect(body.code).toBe("own-live-run");
    expect(body.error).toContain("still executing");
  });

  it("a second run is refused by the lock while the first is live", async () => {
    const r = await fetch(base2 + "/api/run", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ job: "__fake" }),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("locked");
  });

  it("and the lock is released once the run finishes", async () => {
    for (let i = 0; i < 60; i++) {
      const st = (await (await fetch(base2 + "/api/status", { headers: { cookie } })).json()) as {
        lock: { held: boolean };
        activeRunId: string | null;
      };
      if (!st.lock.held && st.activeRunId === null) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("lock was still held after the run finished");
  });
});

/**
 * M1.2 at the HTTP layer. Plants fixture PNGs into output/posts carrying TODAY's
 * editorial stamp so the fake child's summary picks them up as its own, then
 * exercises the gallery endpoint, the traversal defences and the zip.
 * Fixtures are removed in afterAll; no job:* is ever run.
 */
describe("M1.2 — artifact gallery, downloads and the zip", () => {
  let cookie = "";
  let proc3: ChildProcess | null = null;
  let base3 = "";
  let runId = "";
  let planted: string[] = [];

  beforeAll(async () => {
    const today = editorialTodayStamp();
    planted = [
      `tbsi-archives-${today}-cover.png`,
      `tbsi-archives-${today}-card-01.png`,
      `tbsi-archives-${today}-card-02.png`,
    ];
    mkdirSync(POSTS_DIR, { recursive: true });

    const p = await freePort();
    base3 = `http://127.0.0.1:${p}`;
    const started = await startServer({
      MACHINE_ROOM_TOKEN: TOKEN,
      MACHINE_ROOM_PORT: String(p),
      MACHINE_ROOM_ALLOW_FAKE: "1",
      MACHINE_ROOM_SKIP_PROBES: "1",
    });
    proc3 = started.child;
    const login = await fetch(base3 + "/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";

    // Written AFTER the server is up but BEFORE the run, so they land inside the
    // freshness window the run will compute.
    for (const n of planted) writeFileSync(join(POSTS_DIR, n), `fixture-${n}`, "utf8");

    const r = await fetch(base3 + "/api/run", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ job: "__fake" }),
    });
    runId = ((await r.json()) as { runId: string }).runId;

    for (let i = 0; i < 60; i++) {
      const st = (await (await fetch(base3 + "/api/status", { headers: { cookie } })).json()) as { activeRunId: string | null };
      if (st.activeRunId === null) break;
      await new Promise((res) => setTimeout(res, 200));
    }
  });

  afterAll(() => {
    killTree(proc3?.pid);
    for (const n of planted) { try { rmSync(join(POSTS_DIR, n)); } catch { /* already gone */ } }
  });

  it("the summary lists the planted PNGs as this run's own", async () => {
    const s = (await (await fetch(`${base3}/api/runs/${runId}/summary`, { headers: { cookie } })).json()) as {
      summary: { pngs: { name: string; fresh: boolean; sizeBytes: number }[]; freshPngCount: number };
    };
    const fresh = s.summary.pngs.filter((p) => p.fresh).map((p) => p.name);
    for (const n of planted) expect(fresh).toContain(n);
    expect(s.summary.freshPngCount).toBeGreaterThanOrEqual(planted.length);
    expect(s.summary.pngs.find((p) => p.name === planted[0])!.sizeBytes).toBeGreaterThan(0);
  });

  it("serves an allowlisted PNG as image/png", async () => {
    const r = await fetch(`${base3}/api/artifacts?run=${runId}&f=${encodeURIComponent(planted[0]!)}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(await r.text()).toBe(`fixture-${planted[0]}`);
  });

  it("REFUSES traversal, foreign files and non-PNGs", async () => {
    const cases: [string, number][] = [
      ["../.env", 400],
      ["..%2F.env", 400],
      ["sub/dir.png", 400],
      ["wed-drop-theatrical-2026-01-01-cover.png", 404],
      ["anything.json", 415],
      ["", 400],
    ];
    for (const [f, status] of cases) {
      const r = await fetch(`${base3}/api/artifacts?run=${runId}&f=${encodeURIComponent(f)}`, { headers: { cookie } });
      expect(r.status, `f=${JSON.stringify(f)}`).toBe(status);
    }
  });

  it("REFUSES a valid filename against the WRONG run id", async () => {
    const r = await fetch(`${base3}/api/artifacts?run=not-a-run&f=${encodeURIComponent(planted[0]!)}`, { headers: { cookie } });
    expect(r.status).toBe(404);
  });

  it("artifact and zip endpoints require a session", async () => {
    expect((await fetch(`${base3}/api/artifacts?run=${runId}&f=${encodeURIComponent(planted[0]!)}`)).status).toBe(401);
    expect((await fetch(`${base3}/api/artifacts/zip?run=${runId}`)).status).toBe(401);
  });

  it("the zip contains exactly this run's fresh PNGs, as an attachment", async () => {
    const r = await fetch(`${base3}/api/artifacts/zip?run=${runId}`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect(r.headers.get("content-disposition")).toContain("-run.zip");

    const entries = new AdmZip(Buffer.from(await r.arrayBuffer())).getEntries().map((e) => e.entryName);
    for (const n of planted) expect(entries).toContain(n);
    expect(entries.every((e) => e.endsWith(".png"))).toBe(true);
    expect(entries.some((e) => e.includes("/") || e.includes(".."))).toBe(false);
  });
});

describe("with a session", () => {
  let cookie = "";

  it("logs in and reads status", async () => {
    const login = await fetch(BASE + "/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";
    expect(cookie).toContain("mr_session=");

    const r = await fetch(BASE + "/api/status", { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(Array.isArray(body.jobs)).toBe(true);
    // 8 pillars + the 3 MR-M2 News Desk steps.
    expect((body.jobs as unknown[]).length).toBe(11);
    expect(body).toHaveProperty("lock");
    expect(body).toHaveProperty("provenance");
    // The fake child must NOT be exposed when the flag is off.
    expect(body.allowFake).toBe(false);
  });

  it("refuses an unknown job id", async () => {
    const r = await fetch(BASE + "/api/run", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ job: "definitely-not-a-job" }),
    });
    expect(r.status).toBe(400);
  });

  it("refuses a live job without the typed confirmation — 428, and nothing spawns", async () => {
    const r = await fetch(BASE + "/api/run", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ job: "monday" }),
    });
    expect(r.status).toBe(428);
    const body = (await r.json()) as { error: string; code: string };
    expect(body.code).toBe("confirm");
    expect(body.error).toContain("no dry-run mode");
  });

  it("refuses the fake job when MACHINE_ROOM_ALLOW_FAKE is off", async () => {
    const r = await fetch(BASE + "/api/run", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ job: "__fake" }),
    });
    expect(r.status).toBe(400);
  });

  it("break-lock demands the typed CONFIRM", async () => {
    const r = await fetch(BASE + "/api/lock/break", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ confirm: "yes" }),
    });
    expect(r.status).toBe(428);
    expect(((await r.json()) as { code: string }).code).toBe("confirm");
  });

  it("break-lock reports honestly when the lock is not held", async () => {
    const r = await fetch(BASE + "/api/lock/break", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ confirm: "CONFIRM" }),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("not held");
  });

  it("logging out revokes the session", async () => {
    const login = await fetch(BASE + "/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    const c = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";
    await fetch(BASE + "/logout", { method: "POST", headers: { cookie: c } });
    const after = await fetch(BASE + "/api/status", { headers: { cookie: c } });
    expect(after.status).toBe(401);
  });
});
