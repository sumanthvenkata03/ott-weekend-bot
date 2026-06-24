// input-validation.test.ts — pins how discovery behaves on degenerate/invalid
// inputs. discover() now validates its date range up front (strict yyyy-mm-dd
// format + a real calendar date + from<=to) and THROWS on violations, so a
// direct API caller gets a clear signal. parsePage is an internal helper that
// trusts its caller (discover() is the validation boundary), so its raw
// reversed/malformed behavior is intentionally NOT pinned here.
import { describe, it, expect, vi } from "vitest";

vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
vi.mock("../../shared/cache.js", () => ({ cached: (_k: string, loader: () => unknown) => loader() }));
vi.mock("../../ingestion/releases/tmdb.js", () => ({ tmdbFetchCached: vi.fn() }));

import { ofetch } from "ofetch";
import { tmdbFetchCached } from "../../ingestion/releases/tmdb.js";
import { parsePage } from "../sources/wikipediaList.js";
import { discover } from "../index.js";
import { readSyntheticHtml } from "./helpers/load.js";
import { wikiOfetch, tmdbRouter } from "./helpers/mocks.js";

describe("discover() — date-range validation (🔒 throws)", () => {
  it("🔒 throws when from > to — no silent reversed-window", async () => {
    await expect(
      discover({ from: "2026-02-01", to: "2026-01-01", languages: ["Telugu"] })
    ).rejects.toThrow(/"from" \(2026-02-01\) must be on or before "to" \(2026-01-01\)/);
  });

  it("🔒 throws on a malformed `from` date", async () => {
    await expect(
      discover({ from: "banana", to: "2026-12-31", languages: ["Telugu"] })
    ).rejects.toThrow(/invalid date "banana" \(expected yyyy-mm-dd\)/);
  });

  it("🔒 throws on a malformed `to` date", async () => {
    await expect(
      discover({ from: "2026-01-01", to: "nope", languages: ["Telugu"] })
    ).rejects.toThrow(/invalid date "nope" \(expected yyyy-mm-dd\)/);
  });

  it("⚠ well-formatted but impossible date (2026-02-30) -> discover throws (parseISO rejects it as invalid, does NOT roll to Mar 2)", async () => {
    // REPORTED in Phase 4: date-fns parseISO returns an Invalid Date for an
    // impossible calendar date (isValid === false) rather than rolling it over.
    // So the strict-format check passes but the calendar check fails, and
    // discover() throws. Pinned here so this can't drift silently.
    await expect(
      discover({ from: "2026-02-30", to: "2026-03-01", languages: ["Telugu"] })
    ).rejects.toThrow(/invalid date "2026-02-30" \(expected yyyy-mm-dd\)/);
  });

  it("🔒 single-day range (from == to) is allowed — resolves, does NOT throw", async () => {
    vi.mocked(ofetch).mockImplementation(wikiOfetch({}) as never);
    vi.mocked(tmdbFetchCached).mockImplementation(tmdbRouter({}) as never);
    const result = await discover({ from: "2026-06-04", to: "2026-06-04", languages: ["Telugu"] });
    expect(result.films).toEqual([]);
    expect(result.query).toMatchObject({ from: "2026-06-04", to: "2026-06-04" });
  });
});

describe("calendar-invalid release dates degrade to approximate (parsePage, pure)", () => {
  it("Feb 29 in a non-leap year and April 31 fall back to month-only approximate (not dropped, not a bogus ISO)", () => {
    // Note: this is the PARSER's handling of bad dates *inside a page* (the query
    // window here is valid), distinct from discover()'s query-range validation.
    const { films } = parsePage(readSyntheticHtml("invalid-dates.html"), "Tamil", 2027, "p", "2027-01-01", "2027-12-31");
    const feb = films.find((f) => f.title === "FebTwentyNine");
    const apr = films.find((f) => f.title === "AprilThirtyOne");
    expect(feb).toMatchObject({ releaseDate: "2027-02-01", approximateDate: true });
    expect(apr).toMatchObject({ releaseDate: "2027-04-01", approximateDate: true });
  });
});

describe("discover() degenerate inputs (both nets mocked)", () => {
  it("empty language list resolves to all 8 supported languages — defined, non-crashing", async () => {
    vi.mocked(ofetch).mockImplementation(wikiOfetch({}) as never);
    vi.mocked(tmdbFetchCached).mockImplementation(tmdbRouter({}) as never);
    const result = await discover({ from: "2026-01-01", to: "2026-01-31", languages: [] });
    expect(result.query.languages).toHaveLength(8);
    expect(result.films).toEqual([]);
  });
});
