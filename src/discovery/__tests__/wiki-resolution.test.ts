// WD-ENG-07 — TMDb resolution for wiki-only finds, and the language index.
//
// ── FINDING 1a ──────────────────────────────────────────────────────────────
// discover() unions its two nets by normalizedTitle|language|year. A Wikipedia
// film therefore gains a tmdbId ONLY if TMDb's discover sweep independently
// surfaced the same title in the same window. No TMDb SEARCH is ever attempted
// for a wiki-only find. Agadha is the proof: List of Telugu films of 2026, 14
// August, TMDb id 1747034 — found by a plain searchTitleTmdb("Agadha") on the
// first try, by a query the pipeline never made.
//
// ── THE STOP CONDITION, HONOURED ────────────────────────────────────────────
// Panchali Panchabhartruka and Pallaburusu return ZERO results from live TMDb on
// every query shape and every transliteration variant. They cannot be carded by
// resolution work, and this packet does not propose admitting TMDb-less films —
// that is an evidence-floor call reserved for the operator. Their pinned
// behaviour here is: still declined, and NAMED in the decline trace.
//
// All TMDb access below is an injected fake. No network.
import { describe, it, expect, vi } from "vitest";
import {
  titleVariants,
  resolveWikiFilm,
  resolveWikiOnlyFilms,
  MAX_ATTEMPTS,
  type WikiResolveDeps,
} from "../sources/resolveWikiFilm.js";
import { normalizeTitle } from "../normalize.js";
import type { DiscoveredFilm } from "../types.js";
import type { TmdbTitleSearch } from "../../ingestion/releases/tmdb.js";

/** A wiki-only find, exactly as discover() emits one. */
function wikiFilm(title: string, p: Partial<DiscoveredFilm> = {}): DiscoveredFilm {
  return {
    title,
    normalizedTitle: normalizeTitle(title),
    year: 2026,
    language: "Telugu",
    releaseDate: "2026-08-14",
    foundIn: ["wikipedia"],
    perSource: { wikipedia: { title, releaseDate: "2026-08-14", language: "Telugu", page: "List of Telugu films of 2026" } },
    ...p,
  };
}

/** A fake TMDb whose search hits only for the listed query strings. */
function fakeSearch(hits: Record<string, { id: number; title: string; year?: number }[]>) {
  const calls: string[] = [];
  const deps: WikiResolveDeps = {
    searchTitle: async (title): Promise<TmdbTitleSearch> => {
      calls.push(title);
      const found = hits[title] ?? [];
      return { movie: found.map((h) => ({ id: h.id, title: h.title, year: h.year ?? 2026 })), tv: [] };
    },
  };
  return { deps, calls };
}

describe("titleVariants — conservative by design", () => {
  it("keeps the faithful spelling first and caps the attempt count", () => {
    const v = titleVariants("Panchali Panchabhartruka");
    expect(v[0]).toBe("Panchali Panchabhartruka");
    expect(v.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it("strips diacritics, normalizes punctuation, and folds transliteration doubles", () => {
    expect(titleVariants("Pushpā")).toContain("Pushpa");
    expect(titleVariants("Don't Say")).toContain("Don t Say");
    // "th" → "t" and doubled vowels collapsed.
    expect(titleVariants("Panchabharthruka").some((v) => v === "Pancabartruka" || v === "Panchabartruka")).toBe(true);
  });

  it("never emits duplicates or blanks", () => {
    const v = titleVariants("Agadha");
    expect(new Set(v.map((x) => x.toLowerCase())).size).toBe(v.length);
    expect(v.every((x) => x.trim().length > 0)).toBe(true);
  });

  it("collapses whitespace rather than treating it as a variant axis", () => {
    expect(titleVariants("  Agadha   Two  ")[0]).toBe("Agadha Two");
  });
});

describe("AGADHA — the class this packet exists for", () => {
  it("resolves on the FAITHFUL title, first attempt, no variants needed", async () => {
    const { deps, calls } = fakeSearch({ Agadha: [{ id: 1747034, title: "Agadha", year: 2026 }] });
    const r = await resolveWikiFilm(wikiFilm("Agadha"), deps);
    expect(r.tmdbId).toBe(1747034);
    expect(r.via).toBe("Agadha");
    expect(calls).toEqual(["Agadha"]);          // short-circuits; no wasted queries
  });

  it("gains tmdbId + releaseType 'theatrical' and becomes TMDb-backed", async () => {
    const films = [wikiFilm("Agadha")];
    const { deps } = fakeSearch({ Agadha: [{ id: 1747034, title: "Agadha", year: 2026 }] });

    const { resolved, unresolved } = await resolveWikiOnlyFilms(films, deps);

    expect(resolved.map((r) => r.tmdbId)).toEqual([1747034]);
    expect(unresolved).toEqual([]);
    expect(films[0]!.tmdbId).toBe(1747034);
    // "List of <Language> films" has an "Opening" date column — a cinema date.
    expect(films[0]!.releaseType).toBe("theatrical");
    expect(films[0]!.perSource.tmdb?.tmdbId).toBe(1747034);
  });
});

describe("RESOLUTION PATHS", () => {
  it("hits via a VARIANT when the faithful spelling misses", async () => {
    const { deps, calls } = fakeSearch({ Pushpa: [{ id: 42, title: "Pushpa", year: 2026 }] });
    const r = await resolveWikiFilm(wikiFilm("Pushpā"), deps);
    expect(r.tmdbId).toBe(42);
    expect(r.via).toBe("Pushpa");
    expect(calls[0]).toBe("Pushpā");            // faithful spelling tried FIRST
    expect(calls).toContain("Pushpa");
  });

  it("uses the YEAR hint from the list to reject a same-title film from another decade", async () => {
    const { deps } = fakeSearch({ Flag: [{ id: 662712, title: "Flag", year: 2021 }] });
    const r = await resolveWikiFilm(wikiFilm("Flag"), deps);
    expect(r.tmdbId).toBeUndefined();           // 2021 is >1yr from 2026
  });

  it("prefers the EXACT normalized title over a loose namesake", async () => {
    const { deps } = fakeSearch({
      Agadha: [
        { id: 999, title: "Agadha Returns", year: 2026 },
        { id: 1747034, title: "Agadha", year: 2026 },
      ],
    });
    const r = await resolveWikiFilm(wikiFilm("Agadha"), deps);
    expect(r.tmdbId).toBe(1747034);
  });

  it("a search that throws is a miss, never a crash", async () => {
    const deps: WikiResolveDeps = { searchTitle: async () => { throw new Error("TMDb down"); } };
    const r = await resolveWikiFilm(wikiFilm("Agadha"), deps);
    expect(r.tmdbId).toBeUndefined();
    expect(r.tried.length).toBeGreaterThan(0);   // it really did try, and survived
  });
});

describe("THE STOP CONDITION — genuinely TMDb-less films stay declined", () => {
  const NOTHING = fakeSearch({});   // every query returns zero results

  it.each(["Panchali Panchabhartruka", "Pallaburusu"])(
    "%s: no record on ANY variant → not resolved, not TMDb-backed",
    async (title) => {
      const films = [wikiFilm(title)];
      const { resolved, unresolved } = await resolveWikiOnlyFilms(films, NOTHING.deps);

      expect(resolved).toEqual([]);
      expect(unresolved.map((u) => u.title)).toEqual([title]);
      // Untouched — still id-less, still releaseType-less, so matchesIntent
      // still declines it. The TMDb-backed pool rule is not bent for it.
      expect(films[0]!.tmdbId).toBeUndefined();
      expect(films[0]!.releaseType).toBeUndefined();
    }
  );

  it("every attempted spelling is recorded so a miss is diagnosable without a re-run", async () => {
    const films = [wikiFilm("Panchali Panchabhartruka")];
    const { unresolved } = await resolveWikiOnlyFilms(films, NOTHING.deps);
    expect(unresolved[0]!.tried.length).toBeGreaterThan(0);
    expect(unresolved[0]!.tried[0]).toBe("Panchali Panchabhartruka");
  });

  it("the decline is NAMED in the log — the ENG-05 trace, kept", async () => {
    const info = vi.spyOn((await import("../../shared/logger.js")).log, "info").mockImplementation(() => {});
    await resolveWikiOnlyFilms([wikiFilm("Pallaburusu")], NOTHING.deps);
    const lines = info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("Pallaburusu");
    expect(lines).toContain("NO TMDb record");
    expect(lines).toContain("Stays declined");
    info.mockRestore();
  });
});

describe("SCOPE — resolution touches only wiki-only finds", () => {
  it("a film that already has a tmdbId is never re-searched", async () => {
    const { deps, calls } = fakeSearch({ Agadha: [{ id: 1, title: "Agadha" }] });
    const films = [wikiFilm("Agadha", { tmdbId: 555, releaseType: "theatrical", foundIn: ["tmdb", "wikipedia"] })];
    const { resolved } = await resolveWikiOnlyFilms(films, deps);
    expect(resolved).toEqual([]);
    expect(calls).toEqual([]);
    expect(films[0]!.tmdbId).toBe(555);
  });

  it("a NON-wiki find (ai-ott) is not a target", async () => {
    const { deps, calls } = fakeSearch({ Blast: [{ id: 2, title: "Blast" }] });
    const films = [wikiFilm("Blast", { foundIn: ["ai-ott"], perSource: {} })];
    await resolveWikiOnlyFilms(films, deps);
    expect(calls).toEqual([]);
  });

  it("no wiki-only films ⇒ no searches at all (cost floor is zero)", async () => {
    const { deps, calls } = fakeSearch({});
    const films = [wikiFilm("X", { tmdbId: 1, releaseType: "both" })];
    await resolveWikiOnlyFilms(films, deps);
    expect(calls).toEqual([]);
  });
});
