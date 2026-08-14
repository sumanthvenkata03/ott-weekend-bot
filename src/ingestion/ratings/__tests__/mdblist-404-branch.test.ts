// WD-ENG-13 ITEM 2 — A 404 IS AN EXPECTED MISS. EVERYTHING ELSE IS A FAULT.
//
// getMdblistRatings used to print one identical warn for every failure, so
// "MDBList does not carry this film" — which is normal, and common for a slate
// of new Indian releases — was indistinguishable from a credential failure, a
// rate limit, or an outage. One captured Monday run logged five of these in a
// single pass, all of them 404s, all of them fine. That is the WD-ENG-05
// cry-wolf shape: the line an operator learns to skim past, which is exactly the
// line that will be carrying the real outage the day it happens.
//
// Only 404 is demoted. The split is asserted in both directions here, because a
// demotion that also swallowed a 500 would be strictly worse than the warn it
// replaced.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../shared/config.js", () => ({
  config: { MDBLIST_API_KEY: "test-mdblist-key" },
}));
vi.mock("../../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
}));
vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
// mdblist.ts wraps its fetch in pThrottle({ limit: 4, interval: 1000 }) at module
// scope. Left real, the 12 cases below serialise into ~6s of pure waiting — more
// than the entire rest of the suite costs. The throttle is not what this file
// tests, so it is a passthrough here.
vi.mock("p-throttle", () => ({ default: () => <T>(fn: T) => fn }));

import { ofetch } from "ofetch";
import { log } from "../../../shared/logger.js";
import { getMdblistRatings } from "../mdblist.js";

const mockFetch = vi.mocked(ofetch);

/** An ofetch-shaped HTTP error. `status` is where ofetch v1 puts it. */
function httpError(status: number, statusText = ""): Error & { status: number } {
  const e = new Error(
    `[GET] "https://api.mdblist.com/imdb/movie/tt1": ${status} ${statusText}`
  ) as Error & { status: number };
  e.status = status;
  return e;
}

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  info = vi.spyOn(log, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a 404 is reported as an expected miss, at info", () => {
  it("THE CASE — 404 logs info, not warn, and still returns null", async () => {
    mockFetch.mockRejectedValue(httpError(404, "Not Found"));

    const result = await getMdblistRatings("tt27190700");

    expect(result).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toContain("tt27190700");
    expect(info.mock.calls[0]![0]).toMatch(/no entry|expected miss/i);
  });

  it("the info line says plainly that this is NOT an outage", async () => {
    mockFetch.mockRejectedValue(httpError(404, "Not Found"));
    await getMdblistRatings("tt1");
    expect(info.mock.calls[0]![0]).toContain("not an outage");
  });

  it("a 404 carried on `statusCode` or `response.status` is recognised too", async () => {
    // ofetch has moved the status between these properties across versions;
    // missing it would silently re-warn on every expected miss.
    for (const shape of [
      Object.assign(new Error("boom"), { statusCode: 404 }),
      Object.assign(new Error("boom"), { response: { status: 404 } }),
    ]) {
      vi.clearAllMocks();
      mockFetch.mockRejectedValue(shape);
      await getMdblistRatings("tt2");
      expect(warn, JSON.stringify(Object.keys(shape))).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledTimes(1);
    }
  });
});

describe("everything that is NOT a 404 stays a warn", () => {
  it.each([
    [401, "credential rejected"],
    [403, "forbidden"],
    [429, "rate limited"],
    [500, "server error"],
    [503, "service unavailable"],
  ])("HTTP %i keeps the warn", async (status) => {
    mockFetch.mockRejectedValue(httpError(status));

    const result = await getMdblistRatings("tt3");

    expect(result).toBeNull();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("MDBList fetch failed");
    // The status is now NAMED in the line — the old wording never said which.
    expect(warn.mock.calls[0]![0]).toContain(`(HTTP ${status})`);
  });

  it("a NETWORK-level failure (no status at all) stays a warn", async () => {
    // DNS failure / connection refused / timeout: nothing to read a status off.
    mockFetch.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.mdblist.com"));

    expect(await getMdblistRatings("tt4")).toBeNull();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    // No status → no "(HTTP …)" fragment, rather than "(HTTP undefined)".
    expect(warn.mock.calls[0]![0]).not.toContain("HTTP");
  });

  it("a SCHEMA break stays a warn — the silent-break case must stay loud", async () => {
    // A 200 whose body no longer matches the schema throws a ZodError inside the
    // same try. It has no status, and it is precisely the kind of quiet rot the
    // warn exists for, so it must not be swept into the 404 branch.
    mockFetch.mockResolvedValue({ ratings: "not-an-array" } as never);

    expect(await getMdblistRatings("tt5")).toBeNull();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the healthy paths are untouched by the branch", () => {
  it("a good response still returns mapped ratings and logs nothing", async () => {
    mockFetch.mockResolvedValue({
      ratings: [{ source: "imdb", value: 7.4 }, { source: "tomatoes", value: 82 }],
    } as never);

    const result = await getMdblistRatings("tt6");

    expect(result).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("an empty ratings array returns null WITHOUT logging — not a failure", async () => {
    mockFetch.mockResolvedValue({ ratings: [] } as never);

    expect(await getMdblistRatings("tt7")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
