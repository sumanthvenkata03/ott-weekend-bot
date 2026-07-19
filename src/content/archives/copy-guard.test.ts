// Live-guard proof for the Archives name sweep. Two required cases (ruling R2b):
// an unbacked/invented name AND a misspelled real credit (the "Govindh" class).
import { describe, it, expect } from "vitest";
import { buildArchivesNameAllowlist, sweepNames } from "./copy-guard.js";
import type { Release } from "../../shared/types.js";

function mkRelease(p: Partial<Release>): Release {
  return {
    id: "x", title: "Film", language: "Malayalam", isSeries: false, platform: ["Netflix"],
    releaseDate: "2016-01-01", genre: ["Drama"], cast: [], synopsis: "", subtitleLanguages: [],
    sources: [], fetchedAt: "", ...p,
  };
}

describe("archives copy-guard — name sweep (shared module, archives vocabulary)", () => {
  const film = mkRelease({
    title: "Kammatipaadam",
    cast: ["Dulquer Salmaan", "Vinayakan"],
    leadCast: ["Dulquer Salmaan", "Vinayakan"],
    director: "Rajeev Ravi",
  });
  const allow = buildArchivesNameAllowlist([film]);

  it("passes a why-line naming a film-data-backed lead", () => {
    expect(sweepNames("Dulquer Salmaan carries every frame of it.", allow)).toEqual([]);
  });

  it("flags an invented name not in the film data", () => {
    const hits = sweepNames("A career-best turn from Prakash Raj you never saw.", allow);
    expect(hits).toContain("Prakash Raj");
  });

  it("flags a MISSPELLED real credit (Govindh for Govind — strict subset backing)", () => {
    const g = mkRelease({
      title: "Ordinary",
      cast: ["Govind Padmasoorya"],
      leadCast: ["Govind Padmasoorya"],
    });
    const a = buildArchivesNameAllowlist([g]);
    // {govindh, padmasoorya} ⊄ {govind, padmasoorya} — the extra 'h' breaks backing.
    expect(sweepNames("Govindh Padmasoorya anchors it.", a)).toContain("Govindh Padmasoorya");
    // The correctly-spelled credit is still clean.
    expect(sweepNames("Govind Padmasoorya anchors it.", a)).toEqual([]);
  });
});
