// Request-thread keyword matcher · judged-film mention · dedupe (second call
// pings nothing) · ping shape (published copy + &src=reddit link) (PART B).
import { describe, it, expect, vi } from "vitest";

// Mock the shared db with an in-memory sqlite so radar_seen dedupe is isolated
// (no writes to data/cache.sqlite).
vi.mock("../../shared/cache.js", async () => {
  const Database = (await import("better-sqlite3")).default;
  return { db: new Database(":memory:") };
});

import { matchesRequestKeyword, findJudgedMention, withinDays, buildThreadPing, type JudgedFilm, type RadarHit } from "../reddit-radar.js";
import { alreadySeen, markSeen } from "../../ingestion/radar-seen.js";

describe("matchesRequestKeyword", () => {
  it("matches keywords case-insensitively (incl. transliterated)", () => {
    expect(matchesRequestKeyword("What to WATCH this weekend?")).toBeTruthy();
    expect(matchesRequestKeyword("Enna padam parkalam?")).toBe("enna padam");
    expect(matchesRequestKeyword("Kya dekhu aaj raat")).toBe("kya dekhu");
  });
  it("returns null for a non-request title", () => {
    expect(matchesRequestKeyword("Review: this movie was great")).toBeNull();
  });
});

describe("findJudgedMention", () => {
  const films: JudgedFilm[] = [
    { title: "Kammatipaadam", imdbId: "tt5311350", star: 4, verdict: "Worth a Try", source: "verdict" },
    { title: "96", star: null, verdict: null, source: "evergreens", vol: 1 },
  ];
  it("finds a judged film named in the thread title", () => {
    expect(findJudgedMention("Is Kammatipaadam worth watching?", films)?.title).toBe("Kammatipaadam");
  });
  it("returns null when no judged film is named", () => {
    expect(findJudgedMention("Best films of 2016?", films)).toBeNull();
  });
});

describe("withinDays", () => {
  const now = Date.parse("2026-07-17T00:00:00Z");
  it("true within the window, false outside / for the future / for junk", () => {
    expect(withinDays("2026-07-12T00:00:00Z", 7, now)).toBe(true);
    expect(withinDays("2026-07-01T00:00:00Z", 7, now)).toBe(false);
    expect(withinDays("2026-07-20T00:00:00Z", 7, now)).toBe(false); // future
    expect(withinDays("not-a-date", 7, now)).toBe(false);
  });
});

describe("radar_seen dedupe — a thread pings ONCE ever", () => {
  it("second lookup reports already-seen; markSeen is idempotent", () => {
    expect(alreadySeen("t3_once")).toBe(false);
    markSeen("t3_once");
    expect(alreadySeen("t3_once")).toBe(true);
    markSeen("t3_once"); // INSERT OR IGNORE — no throw, still seen
    expect(alreadySeen("t3_once")).toBe(true);
    expect(alreadySeen("t3_other")).toBe(false);
  });
});

describe("buildThreadPing (L3 — published copy only + GoatCounter src tag)", () => {
  const post = { id: "t3_x", title: "Is Kammatipaadam on SonyLIV?", link: "https://reddit.com/x", author: "/u/a", sub: "MalayalamMovies", publishedISO: "2026-07-16T00:00:00Z", snippet: "" };

  it("judged-verdict ping carries title · ★ · verdict · movie.html?...&src=reddit", () => {
    const hit: RadarHit = { post, reason: "judged mention: Kammatipaadam", judged: { title: "Kammatipaadam", imdbId: "tt5311350", star: 4, verdict: "Worth a Try", source: "verdict" } };
    const { text } = buildThreadPing(hit);
    expect(text).toContain("Reddit radar");
    const flat = JSON.stringify(buildThreadPing(hit).blocks);
    expect(flat).toContain("★4");
    expect(flat).toContain("Worth a Try");
    expect(flat).toContain("movie.html?id=tt5311350&src=reddit"); // src NEVER omitted
  });

  it("evergreens ping shows VOL; --test prefixes 🧪 TEST", () => {
    const hit: RadarHit = { post, reason: "judged mention: 96", judged: { title: "96", star: null, verdict: null, source: "evergreens", vol: 2 } };
    const flat = JSON.stringify(buildThreadPing(hit, true).blocks);
    expect(flat).toContain("VOL. 002");
    expect(flat).toContain("🧪 TEST");
  });
});
