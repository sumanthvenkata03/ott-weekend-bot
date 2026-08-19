// WD-046-SEAL-B — MDBLIST CARRIES THE VOTE COUNT, AND WE NOW READ IT.
//
// The client's zod schema took { source, value } and stripped everything else at
// parse time — including `votes`, the IMDb ballot count MDBList mirrors on every
// rating row. The loss was invisible because nothing errored: Release.imdbVotes
// simply stayed unset for every film MDBList covered, hasRealVoteBase (the ENG-10
// seal floor) could then only be satisfied by TMDb's own count, and for new
// Indian releases that sits at 0-25 against a floor of 50. Result: cards printed
// NEW on films with tens of thousands of real ballots behind them.
//
// OMDb was already the vote source and stays FIRST. It just answers "N/A" for
// these titles — verified across the whole Aug-19 deck — so MDBList fills the
// gap and never overrides.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../shared/config.js", () => ({ config: { MDBLIST_API_KEY: "test-key" } }));
vi.mock("../../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
}));
vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
vi.mock("p-throttle", () => ({ default: () => <T,>(fn: T) => fn }));

import { ofetch } from "ofetch";
import { getMdblistRatings, parseVoteCount, mergeRatings } from "../mdblist.js";

const mockFetch = vi.mocked(ofetch);
beforeEach(() => mockFetch.mockReset());

/** The real Welcome to the Jungle payload shape (tt28540171), trimmed. */
const WELCOME_PAYLOAD = {
  title: "Welcome to the Jungle",
  ratings: [
    { source: "imdb", value: 4.6, score: 46, votes: 20824, url: 4553 },
    { source: "trakt", value: 49, score: 49, votes: 81, url: null },
    { source: "tomatoes", value: 43, score: 43, votes: 14, url: null },
    { source: "popcorn", value: 77, score: 77, votes: 58, url: null },
    { source: "tmdb", value: 51, score: 51, votes: 25, url: null },
    { source: "letterboxd", value: 2.6, score: 52, votes: 2921, url: null },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
describe("PART A — parseVoteCount tolerates what a provider might send", () => {
  it("a bare number — what the API sends today", () => {
    expect(parseVoteCount(20824)).toBe(20824);
    expect(parseVoteCount(0)).toBe(0);
  });

  it("a formatted string — separators stripped, not misread as 20", () => {
    expect(parseVoteCount("20,824")).toBe(20824);
    expect(parseVoteCount("20 824")).toBe(20824);
    expect(parseVoteCount(" 5158 ")).toBe(5158);
  });

  it("🔒 unusable input is UNDEFINED, never 0 — absence is not a claim of zero", () => {
    // 0 means "nobody voted"; undefined means "we do not know". Coercing the
    // second into the first is precisely what the seal floor exists to prevent.
    for (const bad of [null, undefined, "N/A", "", "abc", {}, [], NaN, -5, Infinity]) {
      expect(parseVoteCount(bad), String(bad)).toBeUndefined();
    }
  });

  it("a float count is truncated, not rounded up", () => {
    expect(parseVoteCount(1234.9)).toBe(1234);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART B — the client captures imdbVotes", () => {
  it("the real payload yields the IMDb rating AND its 20,824 ballots", async () => {
    mockFetch.mockResolvedValue(WELCOME_PAYLOAD);
    const out = await getMdblistRatings("tt28540171");
    expect(out).toEqual({
      imdb: 4.6, imdbVotes: 20824, rtCritic: 43, rtAudience: 77, letterboxd: 2.6,
    });
  });

  it("🔒 votes are read ONLY from the imdb row — no other source leaks in", async () => {
    // letterboxd carries 2921 votes and tmdb 25; neither is an IMDb ballot count.
    mockFetch.mockResolvedValue(WELCOME_PAYLOAD);
    const out = await getMdblistRatings("tt28540171");
    expect(out!.imdbVotes).toBe(20824);
    expect(out!.imdbVotes).not.toBe(2921);
    expect(out!.imdbVotes).not.toBe(25);
  });

  it("🔒 a null-rating row contributes NOTHING — no orphan vote count", async () => {
    // The all-null shape MDBList returns for unreleased films. A count with no
    // rating under it would back a score IMDb never gave.
    mockFetch.mockResolvedValue({
      ratings: [{ source: "imdb", value: null, score: null, votes: null, url: 5000 }],
    });
    expect(await getMdblistRatings("tt43746881")).toBeNull();
  });

  it("a rating with NO votes field still yields the rating, votes absent", async () => {
    mockFetch.mockResolvedValue({ ratings: [{ source: "imdb", value: 7.8 }] });
    const out = await getMdblistRatings("tt40769151");
    expect(out).toEqual({ imdb: 7.8 });
    expect(out).not.toHaveProperty("imdbVotes");
  });

  it("🔒 NO OTHER MDBList BEHAVIOUR CHANGED — the other four sources map as before", async () => {
    mockFetch.mockResolvedValue({
      ratings: [
        { source: "imdb", value: 8.1, votes: 900 },
        { source: "tomatoes", value: 88 },
        { source: "popcorn", value: 74 },
        { source: "metacritic", value: 70 },
        { source: "letterboxd", value: 4.1 },
        { source: "myanimelist", value: 9.9 },   // unmapped — must stay ignored
      ],
    });
    expect(await getMdblistRatings("tt1")).toEqual({
      imdb: 8.1, imdbVotes: 900, rtCritic: 88, rtAudience: 74, metacritic: 70, letterboxd: 4.1,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART C — 🔒 OMDb PRECEDENCE, MDBList FILLS ABSENT ONLY", () => {
  // The wiring lives in enrichWithRatings; the precedence expression is pinned
  // at its source so the order cannot be quietly inverted.
  const src = () => require("node:fs").readFileSync(
    require("node:path").join(process.cwd(), "src/ingestion/releases/index.ts"), "utf8"
  ) as string;

  it("the precedence chain is OMDb → MDBList → existing", () => {
    expect(src()).toContain("omdb?.imdbVotes ?? mdblist?.imdbVotes ?? r.imdbVotes");
  });

  it("🔒 the key is written CONDITIONALLY — absent stays absent", () => {
    // The old unconditional assignment inside the OMDb spread wrote the key as an
    // explicit undefined whenever OMDb had no count, which is what denied MDBList
    // its turn. It must never come back — asserted against CODE, with comment
    // lines stripped, since the header documents the old form by name.
    const code = src()
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("...(imdbVotes !== undefined ? { imdbVotes } : {})");
    expect(code).not.toMatch(/imdbVotes:\s*omdb\.imdbVotes/);
  });

  it("mergeRatings is untouched — it never handled votes and still does not", () => {
    const merged = mergeRatings(
      { imdbRating: 1, rottenTomatoes: 1, rtAudience: 1, metacritic: 1, letterboxd: 1 },
      { imdbRating: 2 },
      { imdb: 3, imdbVotes: 500 }
    );
    expect(merged.imdbRating).toBe(3);            // MDBList primary, as before
    expect(merged).not.toHaveProperty("imdbVotes"); // votes are NOT its concern
  });
});
