// SINK-LEVEL SECRET REDACTION (M0).
//
// The regression this locks down is concrete: a live run printed the MDBList
// apikey= URL three times, because ofetch's FetchError message carries the full
// resolved request URL and every caller logs err.message. These tests assert the
// SINKS are clean — the console path and the TBSI_LOG_FILE tee — not that any
// individual client was patched.
//
// Writes to a scratch dir under the OS temp root; never touches the repo.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  redactSecrets,
  redactSecretValues,
  registerSecrets,
  registeredSecretNames,
  __resetSecretRegistry,
} from "../redact.js";
import { log, __resetLogTee } from "../logger.js";

// Distinctive so a false pass is impossible — none of these can occur by chance.
const TMDB = "tmdb-live-key-9f8e7d6c5b4a3210";
const MDBLIST = "mdb-live-key-0123456789abcdef";
const WEBHOOK = "https://hooks.slack.com/services/T0AAAAAAA/B0BBBBBBB/ZzYyXxWwVvUuTtSs";

let dir: string;
const prevLogFile = process.env.TBSI_LOG_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbsi-redact-"));
  __resetSecretRegistry();
  __resetLogTee();
  delete process.env.TBSI_LOG_FILE;
});

afterEach(() => {
  if (prevLogFile === undefined) delete process.env.TBSI_LOG_FILE;
  else process.env.TBSI_LOG_FILE = prevLogFile;
  __resetSecretRegistry();
  __resetLogTee();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Everything console.log/console.error received during `body()`, joined. */
function captureConsole(body: () => void): string {
  const seen: string[] = [];
  const grab = (...args: unknown[]) => { seen.push(args.map((a) => String(a)).join(" ")); };
  vi.spyOn(console, "log").mockImplementation(grab);
  vi.spyOn(console, "error").mockImplementation(grab);
  body();
  return seen.join("\n");
}

/** The single .log file in `dir`, or "" when there isn't exactly one. */
function teeBody(): string {
  const files = readdirSync(dir).filter((x) => x.endsWith(".log"));
  return files.length === 1 ? readFileSync(join(dir, files[0]!), "utf8") : "";
}

// ── STEP 1 · the VALUE scrubber (the primary defence) ─────────────────────────

describe("value scrubbing — a registered secret is replaced by a NAMED marker", () => {
  it("scrubs the value out of the MESSAGE and names the variable", () => {
    registerSecrets({ TMDB_API_KEY: TMDB });
    const out = redactSecrets(`fetching with api_key=${TMDB} now`);
    expect(out).not.toContain(TMDB);
    expect(out).toContain("<REDACTED:TMDB_API_KEY>");
  });

  it("scrubs the value out of BOTH sinks of a real log call — message AND data", () => {
    registerSecrets({ TMDB_API_KEY: TMDB });
    process.env.TBSI_LOG_FILE = dir;
    __resetLogTee();

    const consoleOut = captureConsole(() => {
      log.error(`TMDb pass failed for ${TMDB}`, `secondary mention of ${TMDB}`);
    });

    expect(consoleOut).not.toContain(TMDB);
    expect(consoleOut).toContain("<REDACTED:TMDB_API_KEY>");
    const file = teeBody();
    expect(file).not.toContain(TMDB);
    expect(file).toContain("<REDACTED:TMDB_API_KEY>");
    // The marker appears for the message AND for the data payload — 2 per sink.
    expect(file.split("<REDACTED:TMDB_API_KEY>").length - 1).toBe(2);
  });

  it("an Error passed as `data` cannot smuggle its message past the filter", () => {
    // This is the case the raw-object console argument used to leak: Node's
    // inspector printed the stack, whose first line is the ofetch message.
    registerSecrets({ MDBLIST_API_KEY: MDBLIST });
    const err = new Error(`[GET] "https://api.mdblist.com/imdb/movie/tt1?apikey=${MDBLIST}": 401`);
    const consoleOut = captureConsole(() => { log.error("MDBList fetch failed", err); });
    expect(consoleOut).not.toContain(MDBLIST);
    expect(consoleOut).toContain("<REDACTED:MDBLIST_API_KEY>");
  });

  it("skips values shorter than 8 chars — never redacts a word like 'true'", () => {
    registerSecrets({ SOME_FLAG: "true", SHORT: "abc" });
    expect(registeredSecretNames()).toEqual([]);
    expect(redactSecrets("the flag is true and abc")).toBe("the flag is true and abc");
  });

  it("skips undefined / non-string values (an unset optional key)", () => {
    registerSecrets({ MDBLIST_API_KEY: undefined, TAVILY_API_KEY: TMDB });
    expect(registeredSecretNames()).toEqual(["TAVILY_API_KEY"]);
  });

  it("LONGEST VALUE FIRST — an overlapping secret can never be half-redacted", () => {
    const short = "abcdef123456";
    const long = `${short}-with-a-longer-tail`;
    // Registered short-first on purpose: ordering must come from length, not
    // insertion order, or the longer value leaks its tail.
    registerSecrets({ SHORT_SECRET: short, LONG_SECRET: long });
    const out = redactSecrets(`value=${long}`);
    expect(out).toContain("<REDACTED:LONG_SECRET>");
    expect(out).not.toContain("-with-a-longer-tail");
    expect(out).not.toContain(short);
  });
});

// ── STEP 2 · the PATTERN backstop (unregistered secrets) ─────────────────────

describe("pattern backstop — catches a key nobody registered", () => {
  it("scrubs api_key= in a URL with an EMPTY registry (Step 2 alone)", () => {
    expect(registeredSecretNames()).toEqual([]);
    const out = redactSecrets('[GET] "https://api.themoviedb.org/3/discover/movie?api_key=XYZUNREGISTERED&page=1": 401');
    expect(out).not.toContain("XYZUNREGISTERED");
    expect(out).toContain("api_key=***");
    // The rest of the URL survives, so the line is still diagnosable.
    expect(out).toContain("api.themoviedb.org/3/discover/movie");
    expect(out).toContain("page=1");
  });

  it("scrubs a bare Authorization header ALL THE WAY — not just the 'Bearer' word", () => {
    const out = redactSecrets("headers: Authorization: Bearer tvly-unregistered-secret");
    expect(out).not.toContain("tvly-unregistered-secret");
    expect(out).toContain("Authorization: ***");
  });

  it("does NOT downgrade a value the NAMED scrubber already handled", () => {
    registerSecrets({ MDBLIST_API_KEY: MDBLIST });
    const out = redactSecrets(`?apikey=${MDBLIST}`);
    expect(out).toContain("<REDACTED:MDBLIST_API_KEY>");
    expect(out).not.toContain("apikey=***");
  });

  it("is idempotent — scrubbing twice changes nothing", () => {
    registerSecrets({ TMDB_API_KEY: TMDB });
    const once = redactSecrets(`api_key=${TMDB} & api_key=OTHER & Authorization: Bearer zzz`);
    expect(redactSecrets(once)).toBe(once);
  });
});

// ── CLASS A · the exact leak that provoked this work ─────────────────────────

describe("CLASS A reproduction — the ofetch query-string message", () => {
  const line = '[GET] "https://api.mdblist.com/imdb/movie/tt15398776?apikey=SECRET123": 404';

  it("comes out clean when the key IS registered (named marker)", () => {
    registerSecrets({ MDBLIST_API_KEY: "SECRET123" });
    const out = redactSecrets(line);
    expect(out).not.toContain("SECRET123");
    expect(out).toContain("<REDACTED:MDBLIST_API_KEY>");
    expect(out).toContain("api.mdblist.com/imdb/movie/tt15398776");
  });

  it("comes out clean even when the key is NOT registered (pattern only)", () => {
    const out = redactSecrets(line);
    expect(out).not.toContain("SECRET123");
    expect(out).toContain("apikey=***");
  });
});

// ── CLASS B · the Slack webhook URL is itself the credential ─────────────────

describe("CLASS B — a hooks.slack.com webhook URL is unrecognisable", () => {
  it("registered → the whole URL becomes a named marker", () => {
    registerSecrets({ SLACK_WEBHOOK_URL: WEBHOOK });
    const out = redactSecrets(`[POST] "${WEBHOOK}": 400 Bad Request`);
    expect(out).not.toContain(WEBHOOK);
    expect(out).not.toContain("T0AAAAAAA");
    expect(out).not.toContain("ZzYyXxWwVvUuTtSs");
    expect(out).toContain("<REDACTED:SLACK_WEBHOOK_URL>");
  });

  it("unregistered → the pattern still destroys the authorising path", () => {
    const out = redactSecrets(`[POST] "${WEBHOOK}": 400 Bad Request`);
    expect(out).not.toContain("T0AAAAAAA");
    expect(out).not.toContain("B0BBBBBBB");
    expect(out).not.toContain("ZzYyXxWwVvUuTtSs");
    expect(out).toContain("hooks.slack.com/<REDACTED>");
  });
});

// ── VALUE-ONLY variant (structurally-sensitive fields) ──────────────────────

describe("redactSecretValues — for a field that must stay a valid URL", () => {
  it("still removes a registered secret", () => {
    registerSecrets({ TMDB_API_KEY: TMDB });
    expect(redactSecretValues(`https://x.test/a?k=${TMDB}`)).toContain("<REDACTED:TMDB_API_KEY>");
  });

  it("leaves a benign third-party tracking parameter intact (no pattern backstop)", () => {
    const url = "https://press.example.com/article?utm_token=abc123def456";
    expect(redactSecretValues(url)).toBe(url);
    // Contrast: the full scrub WOULD rewrite it — which is exactly why a Notion
    // link.url uses the value-only variant.
    expect(redactSecrets(url)).toContain("token=***");
  });
});

// ── STEP 3 · TEE PARITY ─────────────────────────────────────────────────────

describe("tee parity — the persisted file is scrubbed identically to the console", () => {
  beforeEach(() => {
    registerSecrets({ TMDB_API_KEY: TMDB, MDBLIST_API_KEY: MDBLIST });
    process.env.TBSI_LOG_FILE = dir;
    __resetLogTee();
  });

  it("every level writes a scrubbed line to the tee", () => {
    captureConsole(() => {
      log.info(`info ${TMDB}`);
      log.success(`success ${TMDB}`);
      log.warn(`warn ${MDBLIST}`);
      log.error(`error ${MDBLIST}`);
    });
    const file = teeBody();
    expect(file).not.toContain(TMDB);
    expect(file).not.toContain(MDBLIST);
    expect(file.split("<REDACTED:TMDB_API_KEY>").length - 1).toBe(2);
    expect(file.split("<REDACTED:MDBLIST_API_KEY>").length - 1).toBe(2);
    // Levels and content are otherwise untouched — redaction only.
    for (const lvl of ["INFO", "OK", "WARN", "ERR"]) expect(file).toContain(lvl);
    for (const w of ["info", "success", "warn", "error"]) expect(file).toContain(w);
  });

  it("console and tee agree, for the message AND the data argument", () => {
    const consoleOut = captureConsole(() => {
      log.warn(`msg holds ${TMDB}`, `data holds ${MDBLIST}`);
    });
    const file = teeBody();
    for (const sink of [consoleOut, file]) {
      expect(sink).not.toContain(TMDB);
      expect(sink).not.toContain(MDBLIST);
      expect(sink).toContain("<REDACTED:TMDB_API_KEY>");
      expect(sink).toContain("<REDACTED:MDBLIST_API_KEY>");
    }
  });

  it("an unregistered patterned key is scrubbed in the tee too", () => {
    captureConsole(() => { log.warn('[GET] "https://api.example/x?apikey=NOPENOPENOPE": 500'); });
    const file = teeBody();
    expect(file).not.toContain("NOPENOPENOPE");
    expect(file).toContain("apikey=***");
  });
});
