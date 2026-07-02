// prominence.test.ts — presentation-order helper.
// Covers: popularity DESC ordering, each tie-break in turn, missing-popularity
// sinks last, input immutability, and that a low-rated tent-pole still leads.
import { describe, it, expect } from "vitest";
import { compareByProminence, sortByProminence, type ProminenceFields } from "./prominence.js";

const f = (title: string, pop?: number, votes?: number): ProminenceFields => ({
  title,
  ...(pop !== undefined ? { tmdbPopularity: pop } : {}),
  ...(votes !== undefined ? { tmdbVoteCount: votes } : {}),
});

const titles = (arr: ProminenceFields[]) => arr.map(x => x.title);

describe("sortByProminence", () => {
  it("orders by tmdbPopularity DESC (biggest first)", () => {
    const out = sortByProminence([f("small", 12), f("huge", 900), f("mid", 300)]);
    expect(titles(out)).toEqual(["huge", "mid", "small"]);
  });

  it("tie-breaks equal popularity by tmdbVoteCount DESC", () => {
    const out = sortByProminence([f("few", 100, 50), f("many", 100, 5000)]);
    expect(titles(out)).toEqual(["many", "few"]);
  });

  it("tie-breaks equal popularity AND votes by title ASC", () => {
    const out = sortByProminence([f("Zebra", 100, 10), f("Apple", 100, 10)]);
    expect(titles(out)).toEqual(["Apple", "Zebra"]);
  });

  it("sinks films with missing popularity to the end (treated as 0)", () => {
    const out = sortByProminence([f("noPop"), f("hasPop", 1)]);
    expect(titles(out)).toEqual(["hasPop", "noPop"]);
  });

  it("among all-missing-popularity films, falls through to votes then title", () => {
    const out = sortByProminence([f("b-noVotes"), f("a-noVotes"), f("c-votes", undefined, 10)]);
    expect(titles(out)).toEqual(["c-votes", "a-noVotes", "b-noVotes"]);
  });

  it("a low-'rated' tent-pole still leads a rated niche film (order ignores ratings entirely)", () => {
    // Prominence knows nothing about tbsiScore/tier — only popularity/votes/title.
    const tentpole = f("Peddi", 950, 20);      // huge, few votes yet
    const gem = f("Quiet Gem", 40, 8000);        // tiny popularity, adored
    expect(sortByProminence([gem, tentpole]).map(x => x.title)).toEqual(["Peddi", "Quiet Gem"]);
  });

  it("does not mutate the input array", () => {
    const input = [f("small", 1), f("big", 9)];
    const snapshot = titles(input);
    sortByProminence(input);
    expect(titles(input)).toEqual(snapshot);
  });

  it("compareByProminence is a well-formed comparator (sign only)", () => {
    expect(compareByProminence(f("x", 9), f("y", 1))).toBeLessThan(0);
    expect(compareByProminence(f("x", 1), f("y", 9))).toBeGreaterThan(0);
    expect(compareByProminence(f("same", 5, 5), f("same", 5, 5))).toBe(0);
  });
});
