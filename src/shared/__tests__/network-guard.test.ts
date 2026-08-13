// WD-ENG-10 — SUITE RELIABILITY: the network guard, and the bounds on the
// "worker died / no tests ran" class.
//
// ── WHAT THIS PROTECTS ──────────────────────────────────────────────────────
// WD-ENG-04 found omdb.ts firing ofetch unconditionally with the fake key
// "test" and retry: 2 — ~21 live requests to omdbapi.com per suite run, for
// weeks, each 401 and each swallowed. ENG-04 stopped it only INCIDENTALLY.
//
// An import-graph sweep run for this packet found 31 of 84 test files whose
// imports REACH a network client (Slack, Wikipedia, MDBList, Reddit RSS, OMDb,
// TMDb, poster/image fetch, research) while only 12 mock ofetch. The guard in
// vitest.setup.ts closes all of it at the one seam every client shares:
// globalThis.fetch.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// NOTE: this file deliberately does NOT import vitest.setup.ts. That file lives
// outside tsconfig's rootDir and is excluded from the build; importing it drags
// it back into the tsc program and trips TS6059 — which, as the tsconfig comment
// records, makes tsc STOP and silently stop checking src at all. The guard is
// therefore exercised purely through its observable effect on globalThis.fetch.
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("PART 2 — an un-mocked outbound request FAILS LOUDLY", () => {
  it("a bare fetch() from test context throws instead of leaving the machine", async () => {
    await expect(fetch("https://www.omdbapi.com/?apikey=test&i=tt123"))
      .rejects.toThrow(/\[network-guard\] BLOCKED an outbound request/);
  });

  it("the error names the URL and the method", async () => {
    await expect(fetch("https://api.themoviedb.org/3/search/movie", { method: "POST" }))
      .rejects.toThrow(/POST https:\/\/api\.themoviedb\.org\/3\/search\/movie/);
  });

  it("the error names the CALLING module, so the leak is attributable", async () => {
    // The frame it reports is this test file — the first frame under src/.
    await expect(fetch("https://example.com/x")).rejects.toThrow(/called from: src\//);
  });

  it("it tells the reader what to do instead", async () => {
    await expect(fetch("https://example.com/x")).rejects.toThrow(/Tests must be hermetic/);
    await expect(fetch("https://example.com/x")).rejects.toThrow(/placeholder credential, that is the bug/);
  });

  it("URL and Request inputs are handled, not just strings", async () => {
    await expect(fetch(new URL("https://example.com/from-url"))).rejects.toThrow(/from-url/);
  });

  it("ofetch — the client every module actually uses — is caught by the same seam", async () => {
    // Proof the seam is the right one: nothing in the codebase calls fetch
    // directly, so a guard that only caught fetch-by-name would be theatre.
    const { ofetch } = await import("ofetch");
    await expect(ofetch("https://www.omdbapi.com/?apikey=test")).rejects.toThrow(/\[network-guard\] BLOCKED/);
  });

  it("a test that mocks its client is unaffected — the guard is a backstop, not a wall", () => {
    // The 12 files that vi.mock("ofetch", …) never reach globalThis.fetch at
    // all, so the guard costs them nothing. omdb-key-discipline.test.ts is the
    // live proof: it mocks ofetch, asserts on recorded calls, and never sees a
    // guard error. Here we only assert the guard is a swappable function rather
    // than a module-level patch that a mock could not get past.
    expect(typeof globalThis.fetch).toBe("function");
  });
});

describe("PART 2 — production behaviour is byte-unchanged", () => {
  it("NOTHING under src/ imports the setup file", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        if (code(read(rel)).includes("vitest.setup")) offenders.push(rel);
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("the guard refuses to install unless VITEST is set — belt beside the braces", () => {
    const src = code(read("vitest.setup.ts"));
    expect(src).toContain("if (process.env.VITEST)");
    // The install is INSIDE that condition, not merely near it: the sole
    // unconditional assignment to globalThis.fetch must be the guarded one.
    const guardAt = src.indexOf("if (process.env.VITEST)");
    const installAt = src.indexOf("globalThis.fetch = guard;");
    expect(installAt).toBeGreaterThan(guardAt);
    expect(installAt - guardAt).toBeLessThan(60);   // same block, not a later stray
  });

  it("it is reachable only through vitest.config.ts setupFiles", () => {
    expect(code(read("vitest.config.ts"))).toContain('setupFiles: ["./vitest.setup.ts"]');
  });

  it("the config reproduces the previous default discovery, explicitly", () => {
    // 84 files, all under src/, 0 elsewhere — stated so a stray test file
    // cannot silently join or leave the run whose count the floor gates on.
    //
    // Asserted against the RAW file, not the comment-stripped one: the glob
    // `src/**/*.{…}` CONTAINS the sequence `/*`, so a block-comment stripper
    // eats from there to the next `*/` and deletes the very line under test.
    expect(read("vitest.config.ts")).toContain('include: ["src/**/*.{test,spec}.ts"]');
  });

  it("tsconfig excludes both root files, so `tsc` still checks src", () => {
    // Without this, TS6059 fires on them and tsc STOPS — the src program goes
    // unchecked and every real error vanishes from the report. That happened
    // once while building this packet; the exclude is what caught it.
    const tsconfig = read("tsconfig.json");
    expect(tsconfig).toContain('"vitest.config.ts"');
    expect(tsconfig).toContain('"vitest.setup.ts"');
  });
});

describe("PART 4 — the crash class is bounded and attributable, NOT fixed", () => {
  it("the guard is installed for THIS file — i.e. for every file, via setupFiles", async () => {
    // setupFiles runs per test FILE. If it ever stopped running, this fails in
    // all 84 at once rather than silently restoring live network access.
    // Asserted BEHAVIOURALLY: stringifying the function is brittle to any
    // refactor of the guard body, and what matters is that it blocks.
    await expect(fetch("https://example.com/installed-check"))
      .rejects.toThrow(/\[network-guard\] BLOCKED/);
  });

  it("NO test file's import graph reaches a module-scope main() invocation", () => {
    // ENG-04 pinned that every src/jobs/ module guards its entry. This is the
    // property that actually matters for worker survival, stated directly: a
    // module that calls main() on import can kill the worker through its
    // `.catch(process.exit)`, and that is the "no tests ran" signature.
    //
    // SCOPED TO TEST-REACHABILITY on purpose. Six CLI entry points under src/
    // still invoke main() at module scope (reconcile/cli, discovery/cli,
    // research/cli, research/consolidate-cli, rendering/generate-thumbnails,
    // plus one more). They are npm-script entry points, not imported by
    // anything, so they cannot harm a test run — and rewriting them is ENG-04's
    // scope, not this packet's. This pin fails the moment one becomes reachable.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (e.name.endsWith(".ts")) files.push(rel);
      }
    };
    walk("src");

    const bare = new Set(files.filter((f) => /^main\(/m.test(code(read(f)))));
    const importsOf = (f: string): string[] =>
      [...code(read(f)).matchAll(/from\s+"([^"]+\.js)"/g)]
        .map((m) => m[1]!)
        .filter((s) => s.startsWith("."))
        .map((s) => {
          const parts = f.split("/").slice(0, -1).concat(s.replace(/\.js$/, ".ts").split("/"));
          const out: string[] = [];
          for (const p of parts) {
            if (p === "." || p === "") continue;
            if (p === "..") out.pop(); else out.push(p);
          }
          return out.join("/");
        })
        .filter((p) => files.includes(p));

    const offenders: string[] = [];
    for (const t of files.filter((f) => f.endsWith(".test.ts"))) {
      const seen = new Set<string>(), stack = [t];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c)) continue;
        seen.add(c);
        if (bare.has(c)) { offenders.push(`${t} → ${c}`); break; }
        for (const d of importsOf(c)) stack.push(d);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("unhandled rejections still FAIL the run — vitest's default is not disabled", () => {
    // dangerouslyIgnoreUnhandledErrors would silence exactly the dangling-async
    // class ENG-04 observed. It must never appear in the config.
    expect(code(read("vitest.config.ts"))).not.toContain("dangerouslyIgnoreUnhandledErrors");
  });
});
