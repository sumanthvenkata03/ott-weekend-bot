// Platform-hint matcher + NEW/KNOWN self-scoring + query builder (PART A).
import { describe, it, expect } from "vitest";
import { buildNetQuery, detectPlatformHints, scoreVerdict } from "../reddit-net.js";

describe("detectPlatformHints", () => {
  it("matches canonical Platform names (+ common aliases) case-insensitively", () => {
    expect(detectPlatformHints("Now streaming on NETFLIX and Aha")).toEqual(["Netflix", "Aha"]);
    expect(detectPlatformHints("finally on hotstar")).toEqual(["JioHotstar"]); // alias → canonical
    expect(detectPlatformHints("watch on amazon prime")).toEqual(["Prime Video"]);
  });

  it("returns [] when no platform is named, and de-duplicates repeats", () => {
    expect(detectPlatformHints("great thriller, no platform here")).toEqual([]);
    expect(detectPlatformHints("Netflix... yes Netflix")).toEqual(["Netflix"]);
  });
});

describe("scoreVerdict (self-scoring)", () => {
  it("KNOWN when every hint is already on the film's platforms", () => {
    expect(scoreVerdict(["Netflix"], ["Netflix"])).toBe("KNOWN");
    expect(scoreVerdict(["Netflix"], ["Netflix", "ZEE5"])).toBe("KNOWN");
  });

  it("NEW when a hint names a platform the film doesn't have yet", () => {
    expect(scoreVerdict(["ZEE5"], ["Netflix"])).toBe("NEW");
    expect(scoreVerdict(["Netflix", "ZEE5"], ["Netflix"])).toBe("NEW"); // one unknown ⇒ NEW
  });

  it("no hints ⇒ KNOWN (a mention with no platform claim carries no new info)", () => {
    expect(scoreVerdict([], ["Netflix"])).toBe("KNOWN");
    expect(scoreVerdict([], [])).toBe("KNOWN");
  });
});

describe("buildNetQuery", () => {
  it("quotes the exact title and ORs the OTT-intent terms", () => {
    const q = buildNetQuery("Kammatipaadam");
    expect(q).toContain(`"Kammatipaadam"`);
    expect(q).toContain("OTT OR streaming");
    expect(q).toContain("JioHotstar");
  });
});
