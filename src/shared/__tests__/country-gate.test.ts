// THE COUNTRY GATE — the pure predicate. No network, no cache, no key: every
// record here is a checked-in literal from src/shared/__fixtures__.
import { describe, it, expect } from "vitest";
import { isIndianFilm, countryGateLine, INDIA_ISO } from "../country-gate.js";
import {
  ABSENT_COUNTRY,
  IN_ORIGIN_ONLY,
  IN_PRODUCTION_ONLY,
  MASTUL_COUNTRY,
  MASTUL_TITLE,
  MASTUL_TMDB_ID,
  PUNJABI_INDIA_PAKISTAN,
  TAMIL_INDIA_SRILANKA,
  VARAVU_COUNTRY,
  VARAVU_TITLE,
  VARAVU_TMDB_ID,
} from "../__fixtures__/tmdb-country.js";

describe("isIndianFilm — rejects a film TMDb says is not from India", () => {
  it("THE CASE — Mastul (BD/DE/NL) is rejected", () => {
    const v = isIndianFilm(MASTUL_COUNTRY);
    expect(v.ok).toBe(false);
    expect(v.present).toBe(true);
    expect(v.countries).toEqual(["BD", "DE", "NL"]);
    expect(v.reason).toContain("REJECTED");
    expect(v.reason).toContain("BD");
  });

  it("the reject reason names the full country set, never just the first", () => {
    // The review has to be auditable: "rejected [BD]" would hide the German and
    // Dutch co-producers that make this unambiguously not an Indian film.
    const v = isIndianFilm(MASTUL_COUNTRY);
    for (const c of ["BD", "DE", "NL"]) expect(v.reason).toContain(c);
  });

  it("rejects on origin_country alone when production_countries is absent", () => {
    expect(isIndianFilm({ origin_country: ["US"] }).ok).toBe(false);
  });

  it("rejects on production_countries alone when origin_country is absent", () => {
    expect(isIndianFilm({ production_countries: [{ iso_3166_1: "GB" }] }).ok).toBe(false);
  });
});

describe("isIndianFilm — passes real Indian films", () => {
  it("Varavu (IN) passes", () => {
    const v = isIndianFilm(VARAVU_COUNTRY);
    expect(v.ok).toBe(true);
    expect(v.present).toBe(true);
    expect(v.countries).toEqual(["IN"]);
  });

  it("unions BOTH fields — origin-only and production-only agree", () => {
    // TMDb populates these inconsistently; reading one field would mishandle the
    // records that carry only the other.
    expect(isIndianFilm(IN_ORIGIN_ONLY).ok).toBe(true);
    expect(isIndianFilm(IN_PRODUCTION_ONLY).ok).toBe(true);
  });

  it("de-duplicates and sorts the union", () => {
    const v = isIndianFilm({
      origin_country: ["IN", "in"],
      production_countries: [{ iso_3166_1: "IN" }, { iso_3166_1: "LK" }],
    });
    expect(v.countries).toEqual(["IN", "LK"]);
  });
});

describe("isIndianFilm — EXCLUSION, not equality (the raison d'être)", () => {
  // These co-productions are why the gate asks "does the set exclude IN" rather
  // than "does the set equal IN". An equality test destroys all of them.
  it("Punjabi India/Pakistan co-production PASSES", () => {
    const v = isIndianFilm(PUNJABI_INDIA_PAKISTAN);
    expect(v.ok).toBe(true);
    expect(v.countries).toEqual(["IN", "PK"]);
  });

  it("Tamil India/Sri Lanka co-production PASSES", () => {
    const v = isIndianFilm(TAMIL_INDIA_SRILANKA);
    expect(v.ok).toBe(true);
    expect(v.countries).toEqual(["IN", "LK"]);
  });

  it("IN anywhere in the set is sufficient, whatever its position", () => {
    expect(isIndianFilm({ origin_country: ["US", "GB", "AE", INDIA_ISO] }).ok).toBe(true);
  });

  it("a PK-only or LK-only film is still rejected — the pass is IN, not the partner", () => {
    expect(isIndianFilm({ origin_country: ["PK"] }).ok).toBe(false);
    expect(isIndianFilm({ origin_country: ["LK"] }).ok).toBe(false);
  });
});

describe("isIndianFilm — FAILS OPEN on absent country data", () => {
  it("an empty record passes and is flagged ⚠", () => {
    const v = isIndianFilm(ABSENT_COUNTRY);
    expect(v.ok).toBe(true);
    expect(v.present).toBe(false);
    expect(v.reason).toContain("⚠");
  });

  it("explicitly-empty arrays are the same as absent", () => {
    const v = isIndianFilm({ origin_country: [], production_countries: [] });
    expect(v.ok).toBe(true);
    expect(v.present).toBe(false);
  });

  it("null fields are tolerated (TMDb sends null rather than omitting)", () => {
    const v = isIndianFilm({ origin_country: null, production_countries: null });
    expect(v.ok).toBe(true);
    expect(v.present).toBe(false);
  });

  it("blank codes do not count as country data", () => {
    const v = isIndianFilm({ origin_country: ["", "  "] });
    expect(v.present).toBe(false);
    expect(v.ok).toBe(true);
  });

  it("states WHY it failed open — a TMDb gap must not eat a real Indian film", () => {
    expect(isIndianFilm({}).reason).toContain("fail-open");
  });
});

describe("countryGateLine — every outcome is loggable, none is silent", () => {
  it("a reject line carries seam, title, tmdbId and the full country set", () => {
    const line = countryGateLine("ingest", MASTUL_TITLE, MASTUL_TMDB_ID, isIndianFilm(MASTUL_COUNTRY));
    expect(line).toContain("country-gate/ingest");
    expect(line).toContain("REJECT");
    expect(line).toContain(MASTUL_TITLE);
    expect(line).toContain(String(MASTUL_TMDB_ID));
    expect(line).toContain("[BD,DE,NL]");
  });

  it("a pass line is emitted too, with the same shape", () => {
    const line = countryGateLine("reconcile", VARAVU_TITLE, VARAVU_TMDB_ID, isIndianFilm(VARAVU_COUNTRY));
    expect(line).toContain("country-gate/reconcile");
    expect(line).toContain("pass");
    expect(line).toContain(String(VARAVU_TMDB_ID));
    expect(line).toContain("[IN]");
  });

  it("a ⚠ pass line is emitted and shows an empty set", () => {
    const line = countryGateLine("news-resolve", "Some Film", 1, isIndianFilm(ABSENT_COUNTRY));
    expect(line).toContain("pass");
    expect(line).toContain("[]");
    expect(line).toContain("⚠");
  });

  it("an unknown tmdbId still renders a line", () => {
    expect(countryGateLine("ingest", "No Id", undefined, isIndianFilm({}))).toContain("tmdb —");
  });
});
