// THE LOG TEE — opt-in, and provably inert when unset.
// Writes to a scratch dir under the OS temp root; never touches the repo.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log, __resetLogTee } from "../logger.js";

let dir: string;
const prev = process.env.TBSI_LOG_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbsi-tee-"));
  __resetLogTee();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (prev === undefined) delete process.env.TBSI_LOG_FILE;
  else process.env.TBSI_LOG_FILE = prev;
  __resetLogTee();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const fileIn = (d: string) => {
  const f = readdirSync(d).filter((x) => x.endsWith(".log"));
  return f.length === 1 ? readFileSync(join(d, f[0]!), "utf8") : "";
};

describe("TBSI_LOG_FILE UNSET — zero behaviour change", () => {
  it("writes no file and touches no directory", () => {
    delete process.env.TBSI_LOG_FILE;
    __resetLogTee();
    log.info("nothing should be persisted");
    log.warn("nor this");
    log.error("nor this");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("still logs to the console exactly as before", () => {
    delete process.env.TBSI_LOG_FILE;
    __resetLogTee();
    log.info("hello");
    expect(console.log).toHaveBeenCalled();
  });
});

describe("TBSI_LOG_FILE as a DIRECTORY — dated file", () => {
  beforeEach(() => { process.env.TBSI_LOG_FILE = dir; __resetLogTee(); });

  it("creates one dated tbsi-YYYY-MM-DD.log", () => {
    log.info("first line");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^tbsi-\d{4}-\d{2}-\d{2}\.log$/);
  });

  it("captures EVERY level — info, success, warn, error", () => {
    log.info("an info");
    log.success("a success");
    log.warn("a warning");
    log.error("an error");
    const body = fileIn(dir);
    for (const s of ["an info", "a success", "a warning", "an error"]) expect(body).toContain(s);
    for (const lvl of ["INFO", "OK", "WARN", "ERR"]) expect(body).toContain(lvl);
  });

  it("appends rather than truncating", () => {
    log.info("line one");
    log.info("line two");
    const body = fileIn(dir);
    expect(body).toContain("line one");
    expect(body).toContain("line two");
  });

  it("STRIPS ANSI so the file stays greppable", () => {
    log.info("[36mcoloured[0m message");
    const body = fileIn(dir);
    expect(body).toContain("coloured message");
    expect(body).not.toContain("[");
  });

  it("records a full ISO timestamp, not the console's short clock", () => {
    log.info("stamped");
    expect(fileIn(dir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /m);
  });

  it("serialises the optional data argument", () => {
    log.info("with data", { films: 12, ok: false });
    const body = fileIn(dir);
    expect(body).toContain("films");
    expect(body).toContain("12");
  });

  it("survives a circular data argument without throwing", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => log.info("circular", circular)).not.toThrow();
    expect(fileIn(dir)).toContain("circular");
  });
});

describe("TBSI_LOG_FILE as an explicit .log path", () => {
  it("uses that exact file", () => {
    const target = join(dir, "nested", "my-run.log");
    process.env.TBSI_LOG_FILE = target;
    __resetLogTee();
    log.info("explicit path");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("explicit path");
  });
});

describe("a broken sink NEVER takes down a run", () => {
  it("an unwritable target does not throw, and the run continues", () => {
    // A path whose parent is a FILE, so mkdir/append cannot succeed.
    const target = join(dir, "afile.log");
    process.env.TBSI_LOG_FILE = target;
    __resetLogTee();
    log.info("creates the file");
    process.env.TBSI_LOG_FILE = join(target, "under-a-file.log");
    __resetLogTee();
    expect(() => log.info("this cannot be written")).not.toThrow();
    expect(() => log.info("and neither can this")).not.toThrow();
  });
});
