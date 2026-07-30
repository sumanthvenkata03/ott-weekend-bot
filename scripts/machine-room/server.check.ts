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
import { join } from "node:path";
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
    expect((body.jobs as unknown[]).length).toBe(8);
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

  it("logging out revokes the session", async () => {
    const login = await fetch(BASE + "/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    const c = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";
    await fetch(BASE + "/logout", { method: "POST", headers: { cookie: c } });
    const after = await fetch(BASE + "/api/status", { headers: { cookie: c } });
    expect(after.status).toBe(401);
  });
});
