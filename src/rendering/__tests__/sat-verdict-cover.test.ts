// SAT VERDICT COVER — the mosaic contract.
//
// The cover moved from a top-aligned masthead over an all-N flex-row mosaic to
// the Wed Drop pattern: a TOP-4 poster mosaic with a centered overlay block.
// Three things about that port can break silently in a PNG nobody measures:
//   - the mosaic could disagree with the deck (cell n must BE card n),
//   - the cap could leak into the claim ("4 FILMS JUDGED" on an 11-film deck),
//   - a posterless film could take its cell down with it.
// These assert over buildCoverContext — the pure half of the cover context, so
// no browser and no network are involved. cropPosition is the async half and is
// deliberately out of scope here (see the determinism guard at the bottom).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCoverContext, type SatVerdictCoverCard } from "../render-sat-verdict.js";
import { editorialCoverDateOf } from "../../shared/editorial-clock.js";

const STAMP = "2026-07-25";

/** Minimal card fixture — only the fields the cover reads. `noPoster` OMITS the
 *  key rather than setting it undefined: exactOptionalPropertyTypes makes those
 *  two different things, and the renderer omits it too. */
type Over = Partial<SatVerdictCoverCard> & { noPoster?: boolean };
const mk = (over: Over & { filmTitle: string }): SatVerdictCoverCard => {
  const { noPoster, ...rest } = over;
  return {
    fallbackColor: "#A33223",
    language: "Hindi",
    verdictKind: "worth-a-try",
    ...(noPoster ? {} : { posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg" }),
    ...rest,
  };
};

/** N films, deterministically titled Film 01…Film NN. */
const deck = (n: number, over: Over = {}): SatVerdictCoverCard[] =>
  Array.from({ length: n }, (_, i) => mk({ filmTitle: `Film ${String(i + 1).padStart(2, "0")}`, ...over }));

/** The real 11-film shape this port was specified against. */
const ELEVEN: SatVerdictCoverCard[] = [
  mk({ filmTitle: "The India Story", language: "Hindi", noPoster: true }),
  mk({ filmTitle: "LURK", language: "Tamil" }),
  mk({ filmTitle: "Maharaja Hostel", language: "Telugu" }),
  mk({ filmTitle: "Max, Min and Meowzaki", language: "Malayalam" }),
  ...deck(3, { verdictKind: "worth-a-try" }),
  ...deck(4, { verdictKind: "one-time-watch" }),
];

describe("sat verdict cover — the mosaic is capped at 4", () => {
  it("an 11-film deck yields exactly 4 cells", () => {
    expect(buildCoverContext(ELEVEN, STAMP).gridItems).toHaveLength(4);
  });

  it("a short deck is NOT padded — 2 films yield 2 cells", () => {
    expect(buildCoverContext(deck(2), STAMP).gridItems).toHaveLength(2);
  });
});

describe("sat verdict cover — mosaic cell n IS card n (deck order)", () => {
  it("the 4 cells are the first 4 cards, in order", () => {
    const { gridItems } = buildCoverContext(ELEVEN, STAMP);
    expect(gridItems.map((g) => g.filmTitle)).toEqual([
      "The India Story", "LURK", "Maharaja Hostel", "Max, Min and Meowzaki",
    ]);
  });

  it("card 5 and beyond never reach the mosaic", () => {
    const titles = buildCoverContext(ELEVEN, STAMP).gridItems.map((g) => g.filmTitle);
    expect(titles).not.toContain("Film 01");
  });
});

describe("sat verdict cover — gridClass tracks the cell count", () => {
  for (const n of [1, 2, 3, 4] as const) {
    it(`${n} film(s) ⇒ count-${n}`, () => {
      expect(buildCoverContext(deck(n), STAMP).gridClass).toBe(`count-${n}`);
    });
  }

  it("more than 4 films still clamps to count-4 — never count-11", () => {
    expect(buildCoverContext(ELEVEN, STAMP).gridClass).toBe("count-4");
  });
});

describe("sat verdict cover — a posterless film degrades per-cell, never collapses the grid", () => {
  it("the posterless film keeps its cell, with the fallback's colour, title and language", () => {
    const cell = buildCoverContext(ELEVEN, STAMP).gridItems[0]!;
    expect(cell.filmTitle).toBe("The India Story");
    expect(cell.language).toBe("Hindi");
    expect(cell.fallbackColor).toBe("#A33223");
    expect(cell.posterUrl).toBeUndefined();
  });

  it("ALL FOUR posterless still yields 4 cells and count-4 — the grid never shrinks", () => {
    const bare = deck(4, { noPoster: true });
    const ctx = buildCoverContext(bare, STAMP);
    expect(ctx.gridItems).toHaveLength(4);
    expect(ctx.gridClass).toBe("count-4");
    expect(ctx.gridItems.every((g) => g.posterUrl === undefined)).toBe(true);
    expect(ctx.gridItems.every((g) => g.filmTitle.length > 0 && g.language.length > 0)).toBe(true);
  });
});

describe("sat verdict cover — the tally counts the DECK, not the mosaic", () => {
  it("omits zero-count tiers and keeps ladder order", () => {
    const { tally } = buildCoverContext(ELEVEN, STAMP);
    expect(tally.map((t) => t.key)).toEqual(["try", "onetime"]);
    expect(tally.map((t) => t.count)).toEqual([7, 4]);
    expect(tally.every((t) => t.count > 0)).toBe(true);
  });

  it("the tally sums to the full judged count, not to 4", () => {
    const { tally, filmCount } = buildCoverContext(ELEVEN, STAMP);
    expect(tally.reduce((n, t) => n + t.count, 0)).toBe(filmCount);
  });
});

describe("sat verdict cover — filmCount is the JUDGED count, never the mosaic size", () => {
  it("an 11-film deck claims 11, not 4", () => {
    const { filmCount, gridItems } = buildCoverContext(ELEVEN, STAMP);
    expect(filmCount).toBe(11);
    expect(filmCount).not.toBe(4);
    expect(filmCount).not.toBe(gridItems.length);
  });
});

describe("sat verdict cover — the pixel date", () => {
  it("renders through editorialCoverDateOf on the IST stamp", () => {
    expect(buildCoverContext(ELEVEN, STAMP).coverDate).toBe(editorialCoverDateOf(STAMP));
  });

  it("is the one standard pixel form, with no zero-padded day and no machine stamp", () => {
    const { coverDate } = buildCoverContext(ELEVEN, STAMP);
    expect(coverDate).toBe("JUL 25 · 2026");
    expect(coverDate).toMatch(/^[A-Z]{3} \d{1,2} · \d{4}$/);
    expect(coverDate).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("sat verdict cover — determinism", () => {
  it("the same deck built twice yields identical gridItems (cropPosition is the only impure field, and is not set here)", () => {
    const a = buildCoverContext(ELEVEN, STAMP);
    const b = buildCoverContext(ELEVEN, STAMP);
    expect(a.gridItems).toEqual(b.gridItems);
    expect(a.gridItems.every((g) => g.cropPosition === undefined)).toBe(true);
    expect({ ...a }).toEqual({ ...b });
  });
});

describe("sat verdict cover — the template consumes what the builder produces", () => {
  const markup = readFileSync(
    join(process.cwd(), "src", "rendering", "templates", "sat-verdict-cover.html"),
    "utf8"
  );

  it("reads gridItems/gridClass — the retired row loop is gone", () => {
    expect(markup).toContain("{{ gridClass }}");
    expect(markup).toContain("for item in gridItems");
    // The old mosaic was a nested loop over pre-split rows. Assert on the
    // construct, not the identifier: a comment may still name what was removed.
    expect(markup).not.toContain("for row in gridRows");
    expect(markup).not.toContain("for tile in row");
  });

  it("the headline can wrap — the nowrap that clipped a long title is gone", () => {
    expect(markup).not.toContain("white-space: nowrap");
  });

  // ── HEADLINE CLEARANCE GUARD ────────────────────────────────────────────────
  // The headline is hardcoded, so it cannot drift on its own — this pin exists
  // to make an INTENTIONAL edit stop and re-measure. The margin is ~half a glyph
  // at 98px Playfair; a longer word on line 2 puts the headline under the
  // chevron tab, and nothing else in the suite would catch it.
  it("pins the headline string — changing it REQUIRES re-measuring chevron clearance", () => {
    expect(
      markup,
      'HEADLINE CLEARANCE GUARD — the rendered headline must stay exactly "This Week\'s ' +
      'Theatrical Review.". That string was measured at native res (1080x1350) and clears ' +
      '.chev-tab by 25.4px: line 2 right edge = 931.9px vs chev-tab left edge = 957.3px. ' +
      "ANY change to this string requires re-measuring line 2's right edge against the " +
      "chev-tab left edge BEFORE shipping — a wider line 2 renders the headline underneath " +
      "the chevron tab. Do NOT shave the font size to fit: reserve the chevron column with a " +
      "right inset on .content instead."
    ).toContain('<div class="cover-title">This Week\'s Theatrical Review.</div>');
  });

  it("the fallback cell is layered, never display:none'd (a 404 poster must still show LANG + title)", () => {
    expect(markup).not.toContain("cell-fallback-hidden");
  });
});
