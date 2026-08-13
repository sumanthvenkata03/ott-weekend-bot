// vitest.setup.ts — WD-ENG-10 PART 2: NETWORK OFF IN TESTS, BY DEFAULT.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// WD-ENG-04 found src/ingestion/releases/omdb.ts firing ofetch unconditionally
// with the mocked fake key "test" and `retry: 2` — roughly 21 live requests to
// omdbapi.com on every suite run, for weeks, silently swallowed by a catch.
// ENG-04 stopped it INCIDENTALLY (the entry guards mean discovery no longer
// starts during tests); nothing prevented it from resuming.
//
// It is not a narrow risk. An import-graph sweep over the suite found
// 31 of 84 test files whose imports REACH a network client — Slack, Wikipedia,
// MDBList, Reddit RSS, OMDb, TMDb, poster/image fetches, the research client —
// while only 12 files mock ofetch. Any of those 31 is one un-mocked call away
// from a third-party request, and a silent one, because most of these clients
// fail soft by design.
//
// ── THE SEAM ────────────────────────────────────────────────────────────────
// ofetch is built on globalThis.fetch, so replacing that ONE function catches
// every client at once — present and future — without touching a single
// production module or asking 31 test files to remember a mock. A test that
// legitimately wants network behaviour still mocks ofetch (or fetch) itself,
// exactly as the 12 do today; mocked calls never reach this.
//
// ── PRODUCTION IS UNTOUCHED ─────────────────────────────────────────────────
// This file is referenced ONLY by vitest.config.ts `setupFiles`. Nothing under
// src/ imports it (pinned by test). It additionally refuses to install unless
// process.env.VITEST is set, so even an accidental import outside a test run is
// inert. Two independent conditions, because "the guard leaked into production"
// is a worse outcome than "a test hit the network".

const REAL_FETCH = globalThis.fetch;

/** First frame under src/ or scripts/ — who actually made the call. */
function callerModule(stack: string | undefined): string {
  if (!stack) return "unknown module";
  for (const line of stack.split("\n").slice(1)) {
    const m = line.match(/\(?((?:file:\/\/\/)?[A-Za-z]?:?[^()\s]*(?:src|scripts)[\/\\][^()\s]*?):(\d+):\d+\)?/);
    if (!m) continue;
    const file = m[1]!.replace(/^file:\/\/\//, "").replace(/\\/g, "/");
    if (file.includes("/vitest.setup.ts") || file.includes("/node_modules/")) continue;
    return `${file.replace(/^.*?\/(src|scripts)\//, "$1/")}:${m[2]}`;
  }
  return "unknown module";
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) return String((input as { url: unknown }).url);
  return String(input);
}

/** ONE message builder — the install path and the test re-install path must not
 *  drift, or a test asserting the wording passes on one and fails on the other. */
function blockedError(input: unknown, init?: { method?: string }): Error {
  return new Error(
    `[network-guard] BLOCKED an outbound request during tests.\n` +
      `    ${(init?.method ?? "GET").toUpperCase()} ${urlOf(input)}\n` +
      `    called from: ${callerModule(new Error().stack)}\n` +
      `    Tests must be hermetic. Mock the client (vi.mock("ofetch", …)) or inject a fake dep.\n` +
      `    If this fired from production code with a placeholder credential, that is the bug — fix the client, not the test.`
  );
}

const guard = (async (input: unknown, init?: { method?: string }) => {
  throw blockedError(input, init);
}) as typeof fetch;

if (process.env.VITEST) {
  globalThis.fetch = guard;
}

// NO test-only exports here, deliberately. The guard is exercised by
// src/shared/__tests__/network-guard.test.ts purely through its effect on
// globalThis.fetch, because a test that IMPORTS this module pulls it into the
// tsc program — it sits outside tsconfig's rootDir — which trips TS6059 and, as
// the tsconfig comment records, makes tsc stop checking src altogether. That
// happened once while building this packet.
//
// REAL_FETCH is retained only so the original is not lost to a later refactor
// that wants an escape hatch; nothing reads it today.
void REAL_FETCH;
