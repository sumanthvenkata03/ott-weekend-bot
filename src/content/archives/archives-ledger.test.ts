// Pure-helper tests for the Archives permanent ledger. The db-backed API is
// exercised end-to-end by the job; here we pin the PURE derivations only.
import { describe, it, expect } from "vitest";
import { keysOf, nextVolumeFrom, formatVolume } from "./archives-ledger.js";

describe("archives-ledger pure helpers", () => {
  it("nextVolumeFrom seeds 001 on an empty ledger", () => {
    expect(nextVolumeFrom(null)).toBe(1);
    expect(nextVolumeFrom(undefined)).toBe(1);
    expect(nextVolumeFrom(0)).toBe(1);
  });

  it("nextVolumeFrom increments the current max", () => {
    expect(nextVolumeFrom(1)).toBe(2);
    expect(nextVolumeFrom(41)).toBe(42);
  });

  it("formatVolume zero-pads to NNN", () => {
    expect(formatVolume(1)).toBe("001");
    expect(formatVolume(42)).toBe("042");
    expect(formatVolume(137)).toBe("137");
  });

  it("keysOf dedupes the permanent exclusion set", () => {
    const set = keysOf([{ film_key: "a" }, { film_key: "b" }, { film_key: "a" }]);
    expect(set.size).toBe(2);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });
});
