// scripts/machine-room/news-desk.check.ts
// MR-M2 NEWS DESK, AT THE SERVER BOUNDARY.
//
// WHAT IS EXERCISED FOR REAL, AND WHAT IS DELIBERATELY NOT.
//
// Real: a spawned server on a free port, hit over HTTP, with a PLANTED
// candidates artifact. Auth, validation, the 400/404/409 refusals, and the fact
// that the SERVER (not the client) writes news-picks.json are all proven that
// way, because they are properties of the routes rather than of a function.
//
// Not real, on purpose: the happy path never spawns a child. A successful
// /api/news/picks would start news-generate, which is `npx tsx news-edition.ts
// --from-picks` - live feeds are not involved (it resumes from the artifact) but
// a batched verify call and a caption call ARE, and a permanent suite must never
// spend. So the happy path is driven with the PUBLISH LOCK deliberately held by
// this test process: the route validates and writes the picks file, then
// startRun refuses with 409 "locked" before spawning anything. That is not a
// bypass - the write happens BEFORE the spawn in the handler, so the assertion
// lands on exactly the code under test.
//
// The real artifact directory is a FIXED LITERAL, so this file backs up whatever
// is there, plants its fixture, and restores in afterAll. An operator's real
// candidates file survives a test run.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { REPO_ROOT } from "./paths.js";
import { killTree } from "./proc.js";
import { PUBLISH_LOCK, acquireLock, breakLock, inspectLock } from "./lock.js";
import { JOBS, buildArgv } from "./jobs.js";
import { MAX_PICKS, toCandidatesView, validateAndWritePicks } from "./news-desk.js";
import {
  MACHINE_ROOM_DIR,
  candidatesPath,
  packagePath,
  picksPath,
  readPicks,
  type NewsCandidates,
  type NewsPackageArtifact,
} from "../../src/content/news/news-picks.js";
import { join } from "node:path";

const ENTRY = join("scripts", "machine-room", "server.ts");
const TOKEN = "machine-room-news-desk-check-token";

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

// -- FIXTURE ARTIFACTS ------------------------------------------------------

function candidateRow(id: string, over: Record<string, unknown> = {}) {
  const base = {
    id,
    headline: `Story ${id} locks its OTT release date`,
    language: "Tamil",
    items: [
      {
        title: `Story ${id} locks its OTT release date`,
        url: `https://news.google.com/rss/articles/${id.toUpperCase()}`,
        source: "The Hindu",
        publishedISO: "2026-08-22T04:00:00.000Z",
        language: "Tamil",
      },
    ],
    outlets: ["The Hindu"],
    outletCount: 1,
    bestTier: "A" as const,
    hasTierC: false,
    storyClass: "ott-date",
    classWeight: 4,
    suppressed: false,
    tierPoints: 3,
    crossOutletPoints: 0,
    judgedTitle: null,
    judgedPoints: 0,
    score: 7,
    eligible: true,
    holdReason: "",
    ...over,
  };
  return {
    id: base.id,
    headline: base.headline,
    score: base.score,
    storyClass: base.storyClass,
    bestTier: base.bestTier,
    outletCount: base.outletCount,
    outlets: base.outlets,
    judgedTitle: base.judgedTitle,
    eligible: base.eligible,
    holdReason: base.holdReason,
    cluster: base,
  };
}

function fixtureCandidates(generatedAt: string): NewsCandidates {
  return {
    generatedAt,
    istDate: "2026-08-22",
    windowHours: 26,
    hiddenSeenCount: 3,
    gatheredCount: 12,
    clusters: [
      candidateRow("c1", { score: 9 }),
      candidateRow("c2", { score: 6 }),
      candidateRow("c3", {
        score: 1,
        eligible: false,
        holdReason: "Tier-C anchor without a Tier-A source",
        bestTier: "C",
        hasTierC: true,
      }),
      candidateRow("c4", { score: 5 }),
      candidateRow("c5", { score: 4 }),
      candidateRow("c6", { score: 3 }),
    ],
  } as NewsCandidates;
}

function fixturePackage(generatedAt: string): NewsPackageArtifact {
  return {
    generatedAt,
    istDate: "2026-08-22",
    format: "register-single",
    why: "REGISTER-SINGLE - 2 renderable stories",
    caption: "Two dates, one Friday.",
    captionHashtags: ["#TamilCinema"],
    commentHashtags: ["#OTT"],
    pinnedComment: "Sources: The Hindu",
    badgeCheckBoard: [{ name: "Balan", candidateHandle: null }],
    heldFor: [],
    overrides: [{ id: "c3", headline: "Story c3 locks its OTT release date", holdReason: "Tier-C anchor without a Tier-A source" }],
    stories: [
      {
        id: "c1",
        headline: "Story c1 locks its OTT release date",
        badge: "TBSI RADAR",
        segmentReason: "class=ott-date",
        sourceUrl: "https://www.thehindu.com/c1",
        score: 9,
        storyClass: "ott-date",
        operatorOverride: null,
        itemUrls: ["https://news.google.com/rss/articles/C1"],
      },
      {
        id: "c3",
        headline: "Story c3 locks its OTT release date",
        badge: "TBSI RADAR",
        segmentReason: "class=ott-date",
        sourceUrl: "https://www.thehindu.com/c3",
        score: 1,
        storyClass: "ott-date",
        operatorOverride: "Tier-C anchor without a Tier-A source",
        itemUrls: ["https://news.google.com/rss/articles/C3"],
      },
    ],
    dropped: [{ headline: "Story c2 locks its OTT release date", reason: "no primary outlet page found" }],
    cardFiles: ["tbsi-news-2026-08-22-mr-check.png"],
    packageText: "PACKAGE TEXT FIXTURE\n!! OPERATOR OVERRIDE !!",
  } as NewsPackageArtifact;
}

// -- BACKUP / RESTORE OF THE REAL FIXED PATHS -------------------------------

const REAL = [candidatesPath(), picksPath(), packagePath()];
const backup = new Map<string, string | null>();

function saveReal(): void {
  mkdirSync(MACHINE_ROOM_DIR, { recursive: true });
  for (const p of REAL) backup.set(p, existsSync(p) ? readFileSync(p, "utf8") : null);
}
function restoreReal(): void {
  for (const [p, content] of backup) {
    if (content === null) rmSync(p, { force: true });
    else writeFileSync(p, content, "utf8");
  }
}
function plant(file: string, value: unknown): void {
  mkdirSync(MACHINE_ROOM_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const FRESH = () => new Date(Date.now() - 30 * 60 * 1000).toISOString();
const STALE = () => new Date(Date.now() - 20 * 3600 * 1000).toISOString();

// ===========================================================================

describe("MR-M2 registry — literal flags only, for the three News Desk specs", () => {
  it("each spec's argv is the entry plus ONE literal flag", () => {
    expect(buildArgv(JOBS["news-discover"])).toEqual(["tsx", "src/jobs/news-edition.ts", "--discover"]);
    expect(buildArgv(JOBS["news-generate"])).toEqual(["tsx", "src/jobs/news-edition.ts", "--from-picks"]);
    expect(buildArgv(JOBS["news-mark-posted"])).toEqual(["tsx", "src/jobs/news-edition.ts", "--mark-posted"]);
  });

  it("none of them demands a typed LIVE confirmation, because none sends anything", () => {
    for (const id of ["news-discover", "news-generate", "news-mark-posted"] as const) {
      expect(JOBS[id].requiresLiveConfirm).toBe(false);
      expect(JOBS[id].willSend).toBe("nothing outward");
    }
  });
});

/**
 * SOURCE SCAN. The pin the whole design rests on: no operator string can reach
 * a spawned argv. buildArgv is the ONLY producer of spawn arguments, and it
 * reads nothing but the frozen registry.
 */
describe("SOURCE PIN — no operator string reaches spawn argv", () => {
  const read = (f: string) => readFileSync(join(REPO_ROOT, "scripts", "machine-room", f), "utf8");

  it("buildArgv is untouched: entry + frozen flags, nothing else", () => {
    const jobs = read("jobs.ts");
    const body = jobs.slice(jobs.indexOf("export function buildArgv"), jobs.indexOf("/** Full command"));
    expect(body.replace(/\s+/g, " ")).toContain('return ["tsx", spec.entry, ...spec.flags];');
    // No template interpolation and no concatenation anywhere in it.
    expect(body).not.toContain("${");
    expect(body).not.toContain("+");
  });

  it("startRun's spawn arguments come only from buildCommand(spec)", () => {
    const runner = read("runner.ts");
    expect(runner.replace(/\s+/g, " ")).toContain("const { command, args, display } = buildCommand(spec);");
    expect(runner.replace(/\s+/g, " ")).toContain("const child = spawn(command, args, {");
    // The ONE spawn in the runner, and its args variable is the only source.
    expect((runner.match(/\bspawn\(/g) ?? [])).toHaveLength(1);
  });

  it("the News Desk routes pass a LITERAL job id to startRun and add no args", () => {
    const server = read("server.ts");
    const desk = server.slice(server.indexOf("// ── NEWS DESK (MR-M2)"), server.indexOf("// ── ARTIFACTS:"));
    expect(desk).toContain('job: "news-generate"');
    expect(desk).toContain('job: "news-mark-posted"');
    // No spec override, no flag construction, nothing derived from the request.
    expect(desk).not.toContain("specOverride");
    expect(desk).not.toContain("flags");
    expect(desk).not.toContain("buildArgv");
    expect(desk).not.toContain("spawn");
  });

  it("the server's picks route hands the request nothing but `ids`", () => {
    const server = readFileSync(join(REPO_ROOT, "scripts", "machine-room", "server.ts"), "utf8");
    const route = server.slice(
      server.indexOf('if (path === "/api/news/picks"'),
      server.indexOf('if (path === "/api/news/package"')
    );
    expect(route).toContain("validateAndWritePicks(body.ids, Date.now())");
    // candidatesGeneratedAt is NEVER read off the request.
    expect(route).not.toContain("candidatesGeneratedAt");
  });

  it("the machine room still binds 127.0.0.1 with no env override", () => {
    const server = read("server.ts");
    expect(server).toContain('const HOST = "127.0.0.1";');
    // Exactly one listen, and it binds HOST. (0.0.0.0 DOES appear in this file
    // as prose - the header explains that movie-lookup flips to it and this
    // server deliberately does not - so the pin has to be on the CALL.)
    expect(server.match(/\.listen\(/g) ?? []).toHaveLength(1);
    expect(server).toContain("server.listen(PORT, HOST,");
    expect(server).not.toContain("HOST =" + " process.env");
  });

  it("render.yaml still runs exactly one file, and it is not the machine room", () => {
    const yaml = readFileSync(join(REPO_ROOT, "render.yaml"), "utf8");
    expect(yaml).not.toContain("machine-room");
    expect(yaml).not.toContain("news-edition");
  });
});

describe("validateAndWritePicks — the pure contract the route delegates to", () => {
  beforeAll(saveReal);
  afterAll(restoreReal);

  it("the server's cap matches the desk's verification cap", () => {
    expect(MAX_PICKS).toBe(5);
  });

  it("404s with no artifact, and writes nothing", () => {
    rmSync(candidatesPath(), { force: true });
    rmSync(picksPath(), { force: true });
    const r = validateAndWritePicks(["c1"], Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.error).toContain("Get the latest news");
    }
    expect(existsSync(picksPath())).toBe(false);
  });

  it("409s on a stale artifact, and writes nothing", () => {
    plant(candidatesPath(), fixtureCandidates(STALE()));
    rmSync(picksPath(), { force: true });
    const r = validateAndWritePicks(["c1"], Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain("re-discover");
    }
    expect(existsSync(picksPath())).toBe(false);
  });

  it("400s on a bogus id and NEVER leaves a partial file", () => {
    plant(candidatesPath(), fixtureCandidates(FRESH()));
    rmSync(picksPath(), { force: true });
    const r = validateAndWritePicks(["c1", "nope"], Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("nope");
    }
    expect(existsSync(picksPath())).toBe(false);
  });

  it("400s over the cap, before writing", () => {
    plant(candidatesPath(), fixtureCandidates(FRESH()));
    rmSync(picksPath(), { force: true });
    const r = validateAndWritePicks(["c1", "c2", "c3", "c4", "c5", "c6"], Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(existsSync(picksPath())).toBe(false);
  });

  it("writes the file itself, with the ARTIFACT's generatedAt and artifact order", () => {
    const gen = FRESH();
    plant(candidatesPath(), fixtureCandidates(gen));
    rmSync(picksPath(), { force: true });
    const r = validateAndWritePicks(["c4", "c1"], Date.now());
    expect(r.ok).toBe(true);

    const back = readPicks();
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.candidatesGeneratedAt).toBe(gen);
    expect(back.value.pickedIds).toEqual(["c1", "c4"]);
  });

  it("toCandidatesView drops the resume payload and reports staleness", () => {
    const view = toCandidatesView(fixtureCandidates(STALE()), Date.now());
    expect(view.stale).toBe(true);
    expect(view.maxPicks).toBe(MAX_PICKS);
    expect(view.hiddenSeenCount).toBe(3);
    expect(view.clusters[0]).not.toHaveProperty("cluster");
    expect(view.clusters[0]!.itemCount).toBe(1);
    expect(view.clusters.find((c) => c.id === "c3")!.holdReason).toContain("Tier-C");
  });
});

// ===========================================================================
// HTTP
// ===========================================================================

describe("the News Desk routes over HTTP", () => {
  let proc: ChildProcess | null = null;
  let BASE = "";
  let cookie = "";
  let lockTaken = false;

  beforeAll(async () => {
    saveReal();
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    const started = await startServer({
      MACHINE_ROOM_TOKEN: TOKEN,
      MACHINE_ROOM_PORT: String(port),
      MACHINE_ROOM_ALLOW_FAKE: "0",
    });
    proc = started.child;
    expect(started.out).toContain(`http://127.0.0.1:${port}`);
    const login = await fetch(`${BASE}/login`, { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";
    expect(cookie).toContain("mr_session=");
  });

  afterAll(() => {
    killTree(proc?.pid);
    if (lockTaken) breakLock(PUBLISH_LOCK);
    restoreReal();
  });

  describe("every News Desk route 401s without a session", () => {
    for (const [method, path] of [
      ["GET", "/api/news/candidates"],
      ["POST", "/api/news/picks"],
      ["GET", "/api/news/package"],
      ["GET", "/api/news/card?f=x.png"],
      ["POST", "/api/news/mark-posted"],
    ] as const) {
      it(`${method} ${path} -> 401`, async () => {
        const r = await fetch(BASE + path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(r.status).toBe(401);
        expect(r.headers.get("content-type")).toContain("application/json");
      });
    }
  });

  describe("GET /api/news/candidates", () => {
    it("404s when there is no artifact", async () => {
      rmSync(candidatesPath(), { force: true });
      const r = await fetch(`${BASE}/api/news/candidates`, { headers: { cookie } });
      expect(r.status).toBe(404);
      expect(((await r.json()) as { error: string }).error).toContain("Get the latest news");
    });

    it("serves the picker view - rows, no resume payload, cap and hidden count", async () => {
      plant(candidatesPath(), fixtureCandidates(FRESH()));
      const r = await fetch(`${BASE}/api/news/candidates`, { headers: { cookie } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as ReturnType<typeof toCandidatesView>;
      expect(body.istDate).toBe("2026-08-22");
      expect(body.windowHours).toBe(26);
      expect(body.hiddenSeenCount).toBe(3);
      expect(body.gatheredCount).toBe(12);
      expect(body.maxPicks).toBe(MAX_PICKS);
      expect(body.stale).toBe(false);
      expect(body.clusters).toHaveLength(6);
      for (const row of body.clusters) {
        for (const k of ["id", "headline", "score", "storyClass", "bestTier", "outletCount", "eligible", "holdReason"]) {
          expect(row).toHaveProperty(k);
        }
        expect(row).not.toHaveProperty("cluster");
      }
      const held = body.clusters.find((c) => c.id === "c3")!;
      expect(held.eligible).toBe(false);
      expect(held.holdReason).toContain("Tier-C");
    });

    it("still SERVES a stale artifact, flagged - the panel greys it, the POST refuses it", async () => {
      plant(candidatesPath(), fixtureCandidates(STALE()));
      const r = await fetch(`${BASE}/api/news/candidates`, { headers: { cookie } });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { stale: boolean }).stale).toBe(true);
    });
  });

  describe("POST /api/news/picks refuses before it writes", () => {
    it("400s a BOGUS id, names it, and leaves no picks file", async () => {
      plant(candidatesPath(), fixtureCandidates(FRESH()));
      rmSync(picksPath(), { force: true });
      const r = await fetch(`${BASE}/api/news/picks`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ids: ["c1", "definitely-not-a-story"] }),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain("definitely-not-a-story");
      expect(existsSync(picksPath())).toBe(false);
    });

    it("400s a non-array, an empty pick and non-string ids", async () => {
      plant(candidatesPath(), fixtureCandidates(FRESH()));
      for (const ids of [undefined, "c1", [], [1], {}]) {
        const r = await fetch(`${BASE}/api/news/picks`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        expect(r.status, JSON.stringify(ids)).toBe(400);
      }
    });

    it("409s a STALE artifact and says re-discover", async () => {
      plant(candidatesPath(), fixtureCandidates(STALE()));
      rmSync(picksPath(), { force: true });
      const r = await fetch(`${BASE}/api/news/picks`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ids: ["c1"] }),
      });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toContain("re-discover");
      expect(existsSync(picksPath())).toBe(false);
    });

    it("404s when there is no candidates artifact at all", async () => {
      rmSync(candidatesPath(), { force: true });
      const r = await fetch(`${BASE}/api/news/picks`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ids: ["c1"] }),
      });
      expect(r.status).toBe(404);
    });
  });

  /**
   * THE SERVER WRITES THE FILE - proven over real HTTP, with no child spawned.
   *
   * The publish lock is taken by THIS process first, so startRun refuses with
   * 409 "locked" AFTER the handler has validated and written the picks file.
   * Nothing is verified, nothing is captioned, nothing renders.
   */
  describe("the SERVER writes news-picks.json, not the client", () => {
    let generatedAt = "";

    beforeAll(() => {
      generatedAt = FRESH();
      plant(candidatesPath(), fixtureCandidates(generatedAt));
      rmSync(picksPath(), { force: true });
      const got = acquireLock(PUBLISH_LOCK, { jobName: "news-desk.check (deliberate)", argv: ["check"] });
      expect(got.ok).toBe(true);
      lockTaken = true;
    });

    afterAll(() => {
      breakLock(PUBLISH_LOCK);
      lockTaken = false;
    });

    it("a valid pick is written by the server, then the run is refused by the lock", async () => {
      const r = await fetch(`${BASE}/api/news/picks`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          ids: ["c4", "c1"],
          // Junk the client has no business supplying. The server must ignore
          // every one of these rather than copy any of them to disk.
          candidatesGeneratedAt: "1999-01-01T00:00:00.000Z",
          pickedIds: ["c6"],
          job: "monday",
          flags: ["--approve"],
        }),
      });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { code: string }).code).toBe("locked");

      const back = readPicks();
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      // The SERVER's generatedAt, not the client's.
      expect(back.value.candidatesGeneratedAt).toBe(generatedAt);
      // The SERVER's order and the SERVER's ids, not the client's pickedIds.
      expect(back.value.pickedIds).toEqual(["c1", "c4"]);
      // And nothing else made it into the file.
      const raw = JSON.parse(readFileSync(picksPath(), "utf8")) as Record<string, unknown>;
      expect(Object.keys(raw).sort()).toEqual(["candidatesGeneratedAt", "pickedIds"]);
    });

    it("a HELD story is tickable - picking it is accepted, not refused", async () => {
      const r = await fetch(`${BASE}/api/news/picks`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ids: ["c1", "c3"] }),
      });
      // 409 = validated and written, then stopped by the lock this test holds.
      expect(r.status).toBe(409);
      const back = readPicks();
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.value.pickedIds).toEqual(["c1", "c3"]);
    });

    it("the lock is genuinely held by this test, so nothing was ever spawned", () => {
      const state = inspectLock(PUBLISH_LOCK);
      expect(state.held).toBe(true);
      expect(state.holder?.pid).toBe(process.pid);
    });
  });

  describe("GET /api/news/package", () => {
    it("404s with no package artifact", async () => {
      rmSync(packagePath(), { force: true });
      const r = await fetch(`${BASE}/api/news/package`, { headers: { cookie } });
      expect(r.status).toBe(404);
    });

    it("serves the kit, the override list and card URLs through the artifact plumbing", async () => {
      plant(packagePath(), fixturePackage(FRESH()));
      const r = await fetch(`${BASE}/api/news/package`, { headers: { cookie } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as NewsPackageArtifact & {
        cards: { name: string; url: string }[];
        stale: boolean;
      };
      expect(body.format).toBe("register-single");
      expect(body.caption).toBe("Two dates, one Friday.");
      expect(body.packageText).toContain("OPERATOR OVERRIDE");
      expect(body.overrides).toHaveLength(1);
      expect(body.stories).toHaveLength(2);
      expect(body.dropped).toHaveLength(1);
      expect(body.stale).toBe(false);
      expect(body.cards).toEqual([
        { name: "tbsi-news-2026-08-22-mr-check.png", url: "/api/news/card?f=tbsi-news-2026-08-22-mr-check.png" },
      ]);
    });

    it("flags a package older than 48h as stale", async () => {
      plant(packagePath(), fixturePackage(new Date(Date.now() - 60 * 3600 * 1000).toISOString()));
      const r = await fetch(`${BASE}/api/news/package`, { headers: { cookie } });
      expect(((await r.json()) as { stale: boolean }).stale).toBe(true);
    });
  });

  describe("GET /api/news/card — the same exact-match allowlist as run artifacts", () => {
    beforeAll(() => {
      plant(packagePath(), fixturePackage(FRESH()));
      mkdirSync(join(REPO_ROOT, "output", "posts"), { recursive: true });
      writeFileSync(join(REPO_ROOT, "output", "posts", "tbsi-news-2026-08-22-mr-check.png"), "fixture-png", "utf8");
    });
    afterAll(() => {
      rmSync(join(REPO_ROOT, "output", "posts", "tbsi-news-2026-08-22-mr-check.png"), { force: true });
    });

    it("serves a card the PACKAGE listed", async () => {
      const r = await fetch(`${BASE}/api/news/card?f=tbsi-news-2026-08-22-mr-check.png`, { headers: { cookie } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(await r.text()).toBe("fixture-png");
    });

    it("REFUSES traversal, foreign files and non-PNGs", async () => {
      const cases: [string, number][] = [
        ["../.env", 400],
        ["..%2F.env", 400],
        ["sub/dir.png", 400],
        ["tbsi-news-2026-01-01-other.png", 404],
        ["anything.json", 415],
        ["", 400],
      ];
      for (const [f, status] of cases) {
        const r = await fetch(`${BASE}/api/news/card?f=${encodeURIComponent(f)}`, { headers: { cookie } });
        expect(r.status, `f=${JSON.stringify(f)}`).toBe(status);
      }
    });
  });

  describe("POST /api/news/mark-posted", () => {
    it("404s when there is no package to mark", async () => {
      rmSync(packagePath(), { force: true });
      const r = await fetch(`${BASE}/api/news/mark-posted`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(404);
    });
  });
});
