// WD-ENG-10C — shared/cache.ts opens the DB on FIRST USE, not on import.
//
// ── THE DEFECT THIS PINS SHUT ───────────────────────────────────────────────
// cache.ts used to run `new Database("data/cache.sqlite")`, a WAL pragma, a
// CREATE TABLE and a CREATE INDEX at MODULE LOAD. 39 modules import it, so under
// the default parallel pool a batch of vitest workers opened and wrote to one
// sqlite file simultaneously. That intermittently returned SQLITE_IOERR while a
// test file was being COLLECTED; the victim contributed 0 of its cases and the
// suite total dropped (1290 / 1249 / 1228 against 1306), with a different victim
// file each time. Deferring the open removes the contention for the overwhelming
// majority of importers, which never touch the cache at all.
//
// ── WHY better-sqlite3 IS MOCKED HERE ───────────────────────────────────────
// The whole claim is about WHEN a handle is opened and WHICH writes are issued.
// A fake driver is the only way to observe "zero opens" — a real one would have
// to be interrogated through the filesystem, which cannot distinguish "not
// opened" from "opened and idle". The fake also keeps this file off the shared
// sqlite file it is about, which would be a poor joke.
//
// Every test re-imports the module through vi.resetModules(), so each one starts
// from a genuinely un-initialized module instance rather than inheriting
// whatever an earlier case in this file did.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Everything the fake driver saw, in order. Reset before each case. */
const opened: string[] = [];
const statements: string[] = [];
const writes: string[] = [];

class FakeStatement {
  constructor(private readonly sql: string) {}
  get() {
    // cacheStats() reads `.c` off a COUNT row; everything else treats an absent
    // row as a miss. Shape the answer to the query so the fake stays honest
    // rather than special-casing the caller.
    return /COUNT\(\*\) as c/.test(this.sql) ? { c: 0 } : undefined;
  }
  run() {
    return { changes: 0 };
  }
  all() {
    return [];
  }
  toString() {
    return this.sql;
  }
}

class FakeDatabase {
  readonly name: string;
  constructor(path: string) {
    this.name = path;
    opened.push(path);
  }
  pragma(source: string) {
    writes.push(`pragma:${source}`);
    return [];
  }
  exec(sql: string) {
    writes.push(`exec:${sql.replace(/\s+/g, " ").trim()}`);
    return this;
  }
  prepare(sql: string) {
    statements.push(sql.replace(/\s+/g, " ").trim());
    return new FakeStatement(sql);
  }
  transaction(fn: (...args: unknown[]) => unknown) {
    return fn;
  }
}

vi.mock("better-sqlite3", () => ({ default: FakeDatabase }));

// mkdirSync is the other import-time side effect (it created data/ on load).
const mkdirCalls: string[] = [];
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    mkdirSync: (path: string, opts?: unknown) => {
      mkdirCalls.push(String(path));
      return real.mkdirSync(path, opts as never);
    },
  };
});

type CacheModule = typeof import("../cache.js");

const freshImport = async (): Promise<CacheModule> => {
  vi.resetModules();
  opened.length = 0;
  statements.length = 0;
  writes.length = 0;
  mkdirCalls.length = 0;
  return import("../cache.js");
};

beforeEach(() => {
  opened.length = 0;
  statements.length = 0;
  writes.length = 0;
  mkdirCalls.length = 0;
});

describe("importing shared/cache.js is inert", () => {
  it("opens NO database handle and issues NO write", async () => {
    const cache = await freshImport();

    // The module is fully evaluated at this point — its exports are readable.
    expect(typeof cache.cached).toBe("function");

    expect(opened).toEqual([]);
    expect(writes).toEqual([]);
    expect(statements).toEqual([]);
    expect(mkdirCalls).toEqual([]);
    expect(cache.isInitializedForTests()).toBe(false);
  });

  it("reading the `db` export without touching it stays inert", async () => {
    const cache = await freshImport();
    // Holding the binding, spreading the namespace (always-gate-default.test.ts
    // does exactly this via vi.mock's `orig()`) — none of it is a property
    // access on the proxy, so none of it opens anything.
    const held = cache.db;
    const spread = { ...cache };
    expect(held).toBeDefined();
    expect(spread.db).toBe(held);
    expect(opened).toEqual([]);
    expect(cache.isInitializedForTests()).toBe(false);
  });
});

describe("the first real use initializes — once, and identically", () => {
  it("cached() opens the db and runs the pragma then the DDL, in that order", async () => {
    const cache = await freshImport();

    await cache.cached("k", async () => ({ v: 1 }), { ttlSeconds: 60 });

    expect(opened).toEqual(["data/cache.sqlite"]);
    expect(mkdirCalls).toEqual(["data"]);
    expect(writes[0]).toBe("pragma:journal_mode = WAL");
    expect(writes[1]).toContain("CREATE TABLE IF NOT EXISTS http_cache");
    expect(writes[1]).toContain("CREATE INDEX IF NOT EXISTS idx_http_cache_expires");
    expect(writes).toHaveLength(2);
    expect(cache.isInitializedForTests()).toBe(true);
  });

  it("prepares exactly the known statement set, in order", async () => {
    // WD-ENG-10C pinned "the same THREE statements the eager version did".
    // WD-ENG-22B added a fourth on purpose — `invalidate(key)`, the single-key
    // delete ai-review's partial-blob recovery needs. The pin is re-aimed at
    // the new fact rather than loosened: it still asserts the EXACT set and the
    // EXACT order, so an unannounced fifth statement (or a reordering the six
    // table-owning modules would notice) still fails here.
    const cache = await freshImport();
    await cache.cached("k", async () => 1, { ttlSeconds: 60 });

    expect(statements).toEqual([
      "SELECT value, expires_at FROM http_cache WHERE key = ?",
      "INSERT OR REPLACE INTO http_cache (key, value, expires_at) VALUES (?, ?, ?)",
      "DELETE FROM http_cache WHERE expires_at < ?",
      "DELETE FROM http_cache WHERE key = ?",
    ]);
  });

  it("a second call re-uses the connection — no second open, no repeated DDL", async () => {
    const cache = await freshImport();

    await cache.cached("a", async () => 1, { ttlSeconds: 60 });
    await cache.cached("b", async () => 2, { ttlSeconds: 60 });
    await cache.cached("c", async () => 3, { ttlSeconds: 60 });

    expect(opened).toHaveLength(1);
    expect(writes).toHaveLength(2);
    expect(statements).toHaveLength(4);
  });

  it("CONCURRENT first callers do not double-init", async () => {
    const cache = await freshImport();

    // Five callers started before any of them has finished. init() is
    // synchronous, so the first one through completes the whole open/DDL/prepare
    // sequence before any other can observe a half-built state — this is the
    // property that makes the plain `if (handles)` guard sufficient.
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((k) =>
        cache.cached(k, async () => k, { ttlSeconds: 60 })
      )
    );

    expect(opened).toEqual(["data/cache.sqlite"]);
    expect(writes).toHaveLength(2);
    expect(statements).toHaveLength(4);
  });

  it("purgeExpired() and cacheStats() also init on demand, not on import", async () => {
    const cache = await freshImport();
    expect(opened).toEqual([]);

    cache.purgeExpired();
    expect(opened).toHaveLength(1);

    cache.cacheStats();
    expect(opened).toHaveLength(1);
  });
});

describe("the `db` export still behaves like the real connection", () => {
  it("a property touch initializes, and methods reach the real driver", async () => {
    const cache = await freshImport();
    expect(cache.isInitializedForTests()).toBe(false);

    const stmt = cache.db.prepare("SELECT 1");

    expect(cache.isInitializedForTests()).toBe(true);
    expect(opened).toEqual(["data/cache.sqlite"]);
    // The DDL ran BEFORE the caller's own prepare — the ordering the six
    // table-owning modules (archives-ledger, news-seen, radar-seen, …) depend on,
    // since they prepare against http_cache-era schema on this same connection.
    expect(writes).toHaveLength(2);
    expect(statements).toEqual([
      "SELECT value, expires_at FROM http_cache WHERE key = ?",
      "INSERT OR REPLACE INTO http_cache (key, value, expires_at) VALUES (?, ?, ?)",
      "DELETE FROM http_cache WHERE expires_at < ?",
      "DELETE FROM http_cache WHERE key = ?",   // WD-ENG-22B — invalidate(key)
      "SELECT 1",
    ]);
    expect(stmt).toBeDefined();
  });

  it("non-function properties forward too (db.name, used by archives-reset)", async () => {
    const cache = await freshImport();
    expect(cache.db.name).toBe("data/cache.sqlite");
  });

  it("methods are bound to the real connection, not to the proxy", async () => {
    // better-sqlite3 is a native binding and rejects a proxy as its `this`.
    // Detaching a method must still work.
    const cache = await freshImport();
    const { exec } = cache.db;
    exec("CREATE TABLE IF NOT EXISTS detached (x)");
    expect(writes.at(-1)).toBe("exec:CREATE TABLE IF NOT EXISTS detached (x)");
  });
});

describe("the source records the change where the next reader will look", () => {
  const src = readFileSync(join(process.cwd(), "src/shared/cache.ts"), "utf8");

  it("no longer opens the database at module scope", async () => {
    // The exact line WD-ENG-10B pinned as the root-cause fact. It is now gone,
    // deliberately, and this asserts the replacement rather than the absence.
    expect(src).not.toContain("export const db = new Database(DB_PATH)");
    expect(src).toMatch(/function init\(\): CacheHandles \{\s*\n\s*if \(handles\) return handles;/);
  });

  it("keeps init synchronous — the assumption the once-guard rests on", async () => {
    const initBody = /function init\(\): CacheHandles \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
    expect(initBody).not.toBe("");
    expect(initBody).not.toMatch(/\bawait\b/);
    expect(src).not.toContain("async function init");
  });

  it("research/http.ts and research/consolidate.ts do not re-arm the eager open", () => {
    // Both prepared statements against `db` at MODULE SCOPE. Left alone, they
    // would have re-created the import-time open for every module downstream of
    // them (ottCalendar, ottSearch, news-gather) — most of the discovery suite.
    for (const rel of ["src/research/http.ts", "src/research/consolidate.ts"]) {
      const text = readFileSync(join(process.cwd(), rel), "utf8");
      expect(text).not.toMatch(/^const \w*[Ss]tmt\w* = db\.prepare/m);
      expect(text).toMatch(/db\.prepare/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("WD-ENG-22C-POLISH — invalidate() stays a narrow lever, structurally", () => {
  /** Every production .ts under src/ — tests, fixtures and cache.ts itself excluded. */
  function productionSources(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__" || e.name === "__fixtures__") continue;
        productionSources(p, acc);
      } else if (e.name.endsWith(".ts") && !e.name.includes(".test.") && !e.name.includes(".spec.") && !e.name.endsWith(".check.ts")) {
        acc.push(p.replace(/\\/g, "/"));
      }
    }
    return acc;
  }

  it("🔒 ai-review.ts is the ONLY production caller of cache.invalidate", () => {
    // cache.ts's doc comment says outright that this is "not a general
    // 'refresh' lever: a caller that merely dislikes a cached value must live
    // with it until the TTL, or the cache stops being a budget control." That
    // sentence is a promise a future edit can quietly break, so it becomes a
    // TEST. The one sanctioned use is ai-review's partial-blob recovery, where
    // the blob is PROVABLY unusable — re-reading it would silently remove films
    // that were never asked about.
    //
    // Matches the CALL `invalidate(` rather than the word: three modules use
    // "invalidate" in prose ("must retroactively invalidate every confirm",
    // "a shape change must invalidate its cache") and none of them is a caller.
    const callers = productionSources("src")
      .filter((f) => f !== "src/shared/cache.ts")
      .filter((f) => /(^|[^.\w])invalidate\(/.test(readFileSync(join(process.cwd(), f), "utf8")));
    expect(callers).toEqual(["src/reconcile/ai-review.ts"]);
  });

  it("the sanctioned call sits in the partial-blob recovery, not on the hot path", () => {
    const ai = readFileSync(join(process.cwd(), "src/reconcile/ai-review.ts"), "utf8");
    const gap = ai.indexOf("CACHE BLOB GAP");
    const call = ai.indexOf("invalidate(key);");
    expect(gap).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gap);                 // inside the gap branch
    expect(ai.match(/invalidate\(key\);/g)).toHaveLength(1);   // exactly one call, no loop
  });

  it("cache.ts still records WHY the lever is narrow", () => {
    // Read here rather than reusing the outer `src`: that binding is scoped to
    // the describe above, and this block is a sibling.
    const cacheSrc = readFileSync(join(process.cwd(), "src/shared/cache.ts"), "utf8");
    expect(cacheSrc).toContain('This is not a general "refresh" lever');
    expect(cacheSrc).toContain("stops being a budget control");
    expect(cacheSrc).toContain("The one sanctioned use is ai-review's");
  });
});
