// NEWS DESK · A (Phase 2) — the class → segment map.
import { describe, it, expect } from "vitest";
import {
  CLASS_TO_SEGMENT,
  REGISTER_PROMOTION_MIN_ITEMS,
  SEGMENTS,
  isRenderable,
  segmentFor,
} from "../segments.js";

describe("segmentFor — the deterministic map", () => {
  it("routes date/availability classes to RADAR", () => {
    expect(segmentFor("ott-date", 1).segment.key).toBe("RADAR");
    expect(segmentFor("release-date", 1).segment.key).toBe("RADAR");
    expect(segmentFor("confirmation", 1).segment.key).toBe("RADAR");
  });

  it("routes chatter classes to BUZZ", () => {
    expect(segmentFor("boxoffice", 1).segment.key).toBe("BUZZ");
    expect(segmentFor("trailer", 1).segment.key).toBe("BUZZ");
    expect(segmentFor("casting", 1).segment.key).toBe("BUZZ");
  });

  it("a SINGLE awards item is BUZZ, not a register", () => {
    expect(segmentFor("awards", 1).segment.key).toBe("BUZZ");
    expect(segmentFor("awards", REGISTER_PROMOTION_MIN_ITEMS - 1).segment.key).toBe("BUZZ");
  });

  it("a MULTI-ITEM awards cluster promotes to REGISTER", () => {
    const d = segmentFor("awards", REGISTER_PROMOTION_MIN_ITEMS);
    expect(d.segment.key).toBe("REGISTER");
    expect(d.reason).toContain("→ REGISTER");
  });

  it("routes obituary → IN MEMORIAM and rumor → RUMOR CHECK", () => {
    expect(segmentFor("obituary", 1).segment.key).toBe("IN_MEMORIAM");
    expect(segmentFor("rumor", 1).segment.key).toBe("RUMOR_CHECK");
  });

  it("falls back to BUZZ for an unmapped class", () => {
    expect(segmentFor("something-new", 1).segment.key).toBe("BUZZ");
    expect(segmentFor("general", 1).segment.key).toBe("BUZZ");
  });

  it("gives a printable reason for every decision", () => {
    expect(segmentFor("ott-date", 1).reason).toBe("class=ott-date → TBSI RADAR");
    expect(segmentFor("obituary", 1).reason).toContain("SUGGEST-ONLY");
  });

  it("covers every class the scorer can emit", () => {
    for (const c of ["ott-date", "release-date", "boxoffice", "awards", "trailer", "casting", "obituary", "rumor", "general"]) {
      expect(CLASS_TO_SEGMENT[c], `unmapped class: ${c}`).toBeDefined();
    }
  });
});

describe("isRenderable — the suggest-only gate", () => {
  it("normal segments always render", () => {
    expect(isRenderable(SEGMENTS.RADAR)).toBe(true);
    expect(isRenderable(SEGMENTS.BUZZ)).toBe(true);
    expect(isRenderable(SEGMENTS.REGISTER)).toBe(true);
  });

  it("IN MEMORIAM is gated behind OWNER_GO=1", () => {
    expect(isRenderable(SEGMENTS.IN_MEMORIAM, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isRenderable(SEGMENTS.IN_MEMORIAM, { OWNER_GO: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isRenderable(SEGMENTS.IN_MEMORIAM, { OWNER_GO: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("RUMOR CHECK never renders in v1, even with OWNER_GO", () => {
    expect(isRenderable(SEGMENTS.RUMOR_CHECK, { OWNER_GO: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("every segment carries a badge and a sign-off", () => {
    for (const s of Object.values(SEGMENTS)) {
      expect(s.badge.length).toBeGreaterThan(0);
      expect(s.signoff.length).toBeGreaterThan(0);
    }
  });
});
