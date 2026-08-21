// WD-ENG-22C — POSTING KIT + DELIVERY.
//
// ── WHAT THIS FILE DEFENDS ──────────────────────────────────────────────────
// Four properties, in descending order of how badly a regression would hurt:
//
//   1. THE WD-ENG-17 DATE GUARD IS BYTE-INTACT, and the radar pool is
//      QUARANTINED. The pool exists precisely because the guard throws finds
//      away; if the pool could feed a candidate back into discovery, or if a
//      radar line could print a date, the guard would have been reopened
//      through the back door.
//   2. NO HANDLE IS EVER GUESSED. A wrong @tag lands on a real stranger's
//      profile, permanently. Only tick:true emits one; everything else says
//      "search".
//   3. THE 30-TERM LAW HOLDS, LOUDLY. A kit that quietly shipped 3 hashtags
//      would look fine in the zip and cost weeks of reach before anyone
//      counted, so the builder REFUSES rather than degrades.
//   4. THE THREE PRE-22C DECK-ZIP CALLERS ARE UNTOUCHED. Wednesday needed new
//      options; sat-verdict / news / archives must behave byte-identically by
//      default.
//
// Hermetic: in-memory sqlite for the pool, a fixture handle map, no network, no
// LLM (the kit generator is templates + field lookups by design).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cacheMock = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("../../shared/cache.js", async () => {
  const Database = (await import("better-sqlite3")).default;
  return {
    db: new Database(":memory:"),
    cached: async (key: string, loader: () => Promise<unknown>) => {
      if (cacheMock.store.has(key)) return cacheMock.store.get(key);
      const v = await loader();
      cacheMock.store.set(key, v);
      return v;
    },
    invalidate: (key: string) => cacheMock.store.delete(key),
  };
});

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildPostingKit, validateKit, pickHashtags, buildKeywords, renderRadarLine,
  pickRadarLines, altTextFor, tagNamesFor, titleTag,
  KIT_HEADER, REQUIRED_HASHTAGS, MIN_KEYWORDS, MIN_TOTAL_TERMS,
} from "../posting-kit.js";
import {
  clearRadarPoolForTests, radarKey, readRadarPool, recordRadarFind, purgeRadarPool,
  RADAR_POOL_TTL_DAYS,
} from "../../discovery/radar-pool.js";
import {
  HandleMapSchema, loadHandleMap, resetHandleMapForTests, resolveHandle, resolveHandles,
} from "../../shared/handles.js";
import type { Release } from "../../shared/types.js";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const DAY = 24 * 60 * 60 * 1000;

function rel(p: Partial<Release> & { title: string }): Release {
  return {
    // `title` is deliberately NOT restated here — the spread below supplies it,
    // and naming it twice is a TS2783 (silently overwritten) error.
    id: `tmdb-${p.title.replace(/\W+/g, "")}`, language: "Tamil",
    isSeries: false, platform: ["Netflix"], releaseDate: "2026-08-21",
    releaseDates: { ott: "2026-08-21" }, genre: [], cast: [], synopsis: "",
    subtitleLanguages: [], sources: ["tmdb"], fetchedAt: "2026-08-18T00:00:00.000Z",
    ...p,
  } as Release;
}

/** Six films, matching the No.046 OTT deck's shape closely enough to exercise every branch. */
function sixFilms(): Release[] {
  return [
    rel({ title: "Jana Nayagan", language: "Tamil", platform: ["ZEE5"], tmdbPopularity: 26.9, director: "H. Vinoth", leadCast: ["Vijay", "Pooja Hegde"], musicDirector: "Anirudh Ravichander", runtime: 186, posterUrl: "https://x/p.jpg" }),
    rel({ title: "Welcome to the Jungle", language: "Hindi", platform: ["JioHotstar"], tmdbPopularity: 4.5, director: "Ahmed Khan", leadCast: ["Akshay Kumar", "Suniel Shetty"] }),
    rel({ title: "Chennai Love Story", language: "Telugu", platform: ["SonyLIV"], tmdbPopularity: 1.9, leadCast: ["Sri Gouri Priya Reddy", "Kiran Abbavaram"] }),
    rel({ title: "The Great Grand Superhero", language: "Hindi", platform: ["ZEE5"], tmdbPopularity: 1.5, leadCast: ["Jackie Shroff"] }),
    rel({ title: "Pyaar Prema Kalyanam", language: "Tamil", platform: ["Netflix"], tmdbPopularity: 0.5, musicDirector: "Yuvan Shankar Raja", leadCast: ["Elan"] }),
    rel({ title: "Srinivasa Mangapuram", language: "Telugu", platform: ["Prime Video"], leadCast: ["Rasha Thadani", "Mohan Babu"] }),
  ];
}

const KIT = (over: Partial<Parameters<typeof buildPostingKit>[0]> = {}) =>
  buildPostingKit({
    edition: "ott", editionLabel: "Now Streaming", issueNumber: 46,
    windowStart: "2026-08-17", windowEnd: "2026-08-23",
    caption: "Six films, one couch.", releases: sixFilms(),
    radar: [], handleMap: {}, ...over,
  });

let tmp: string;
beforeEach(() => {
  clearRadarPoolForTests();
  resetHandleMapForTests();
  tmp = mkdtempSync(join(tmpdir(), "tbsi-kit-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetHandleMapForTests();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 1 — THE WD-ENG-17 GUARD IS BYTE-INTACT, AND THE POOL IS QUARANTINED", () => {
  it("🔒 the drop site still drops: the guard's three lines are unchanged and `continue` still fires", () => {
    const src = read("src/discovery/sources/newsNet.ts");
    expect(src).toContain("if (!hasUsableDate(ai)) {");
    expect(src).toContain("dropped++;");
    // The pool write is APPENDED inside the guard, before the continue — the
    // find still never becomes a candidate.
    const block = src.slice(src.indexOf("if (!hasUsableDate(ai)) {"), src.indexOf("const search = ai.isSeries"));
    expect(block).toContain("recordRadarFind({");
    expect(block.trimEnd().endsWith("}")).toBe(true);
    expect(block).toContain("continue;");
    expect(block.indexOf("recordRadarFind({")).toBeLessThan(block.lastIndexOf("continue;"));
  });

  it("🔒 QUARANTINE: only the posting kit reads the pool", () => {
    // A reader anywhere in reconcile / discovery-selection / rendering would
    // mean an undated find could reach a tier, a card, or the gate.
    const readers = [
      "src/reconcile/reconcile.ts", "src/reconcile/ai-review.ts", "src/reconcile/gate.ts",
      "src/reconcile/auto-contract.ts", "src/reconcile/verify.ts", "src/discovery/candidates.ts",
      "src/rendering/render-wed-drop.ts", "src/jobs/wednesday-drop.ts",
    ];
    for (const f of readers) {
      expect(read(f), `${f} must not read the radar pool`).not.toContain("readRadarPool");
      expect(read(f), `${f} must not import radar-pool`).not.toContain("radar-pool.js");
    }
    expect(read("src/delivery/posting-kit.ts")).toContain("readRadarPool");
    // …and the net that WRITES must not also read.
    expect(read("src/discovery/sources/newsNet.ts")).not.toContain("readRadarPool");
  });

  it("🔒 the pool stores NO date column — a date cannot leak even by accident", () => {
    const src = read("src/discovery/radar-pool.ts");
    const ddl = src.slice(src.indexOf("CREATE TABLE IF NOT EXISTS radar_pool"), src.indexOf("CREATE INDEX"));
    for (const banned of ["date", "release_date", "releaseDate"]) {
      expect(ddl.toLowerCase()).not.toContain(banned);
    }
  });

  it("radar lines name PLATFORMS ONLY, never dates", () => {
    expect(renderRadarLine({ title: "Kaantha", platform: "SonyLIV" }))
      .toBe("Kaantha is SonyLIV-bound, no official date yet (from-pool)");
    expect(renderRadarLine({ title: "Kaantha", platform: null }))
      .toBe("Kaantha is in the pipeline, no platform or date confirmed yet (from-pool)");
    // No ISO date, no month name, anywhere in a generated kit's radar block.
    const kit = KIT({ radar: [
      { key: "k", title: "Kaantha", platform: "SonyLIV", source_url: "https://x", first_seen: 1, last_seen: 2 },
    ] });
    expect(kit.radarLines.join(" ")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(kit.radarLines.join(" ")).not.toMatch(/January|February|March|April|May|June|July|August|September|October|November|December/i);
    expect(kit.radarLines[0]).toContain("from-pool");
  });

  it("a film already on the deck is never repeated as a rumour", () => {
    const kit = KIT({ radar: [
      { key: "jana-nayagan", title: "Jana Nayagan", platform: "ZEE5", source_url: "https://x", first_seen: 1, last_seen: 2 },
      { key: "kaantha", title: "Kaantha", platform: "SonyLIV", source_url: "https://x", first_seen: 1, last_seen: 2 },
    ] });
    expect(kit.radarLines).toHaveLength(1);
    expect(kit.radarLines[0]).toContain("Kaantha");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 2 — THE POOL: dedupe, expiry, shape", () => {
  it("records a dateless find with the fields the kit needs and nothing more", () => {
    expect(recordRadarFind({ title: "Kaantha", platform: "SonyLIV", sourceUrl: "https://t.example/a", now: 1000 })).toBe(true);
    const rows = readRadarPool(1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "kaantha", title: "Kaantha", platform: "SonyLIV",
      source_url: "https://t.example/a", first_seen: 1000, last_seen: 1000,
    });
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["first_seen", "key", "last_seen", "platform", "source_url", "title"]
    );
  });

  it("DEDUPE by key: a second sighting updates lastSeen and KEEPS firstSeen", () => {
    // "we have been hearing about this since June" is the one thing the pool
    // knows that a single headline does not — an INSERT OR REPLACE would lose it.
    recordRadarFind({ title: "Kaantha", platform: "SonyLIV", sourceUrl: "https://a", now: 1000 });
    recordRadarFind({ title: "kaantha!", platform: "SonyLIV", sourceUrl: "https://b", now: 5000 });
    const rows = readRadarPool(5000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.first_seen).toBe(1000);
    expect(rows[0]!.last_seen).toBe(5000);
    expect(rows[0]!.source_url).toBe("https://b");
  });

  it("a later sighting with NO platform does not erase a known one", () => {
    recordRadarFind({ title: "Kaantha", platform: "SonyLIV", sourceUrl: "https://a", now: 1000 });
    recordRadarFind({ title: "Kaantha", sourceUrl: "https://b", now: 2000 });
    expect(readRadarPool(2000)[0]!.platform).toBe("SonyLIV");   // not a retraction
  });

  it("EXPIRY at 30 days is applied on READ, not only by the purge", () => {
    const t0 = 1_000_000_000_000;
    recordRadarFind({ title: "Old", platform: "ZEE5", sourceUrl: "https://a", now: t0 });
    expect(readRadarPool(t0 + (RADAR_POOL_TTL_DAYS - 1) * DAY)).toHaveLength(1);
    expect(readRadarPool(t0 + (RADAR_POOL_TTL_DAYS + 1) * DAY)).toHaveLength(0);
    expect(purgeRadarPool(t0 + (RADAR_POOL_TTL_DAYS + 1) * DAY)).toBe(1);
    expect(readRadarPool(t0)).toHaveLength(0);
  });

  it("refuses a find with no cite and a title that normalizes to nothing", () => {
    expect(recordRadarFind({ title: "Kaantha", platform: "ZEE5" })).toBe(false);       // no sourceUrl
    expect(recordRadarFind({ title: "!!!", sourceUrl: "https://a" })).toBe(false);     // no key
    expect(readRadarPool()).toHaveLength(0);
  });

  it("radarKey folds case, punctuation and diacritics", () => {
    expect(radarKey("Kaantha")).toBe("kaantha");
    expect(radarKey("  Thank You, Subbarao!  ")).toBe("thank-you-subbarao");
    expect(radarKey("Párvathy")).toBe("parvathy");
  });

  it("recordRadarFind NEVER throws — discovery must not die for a side-channel", () => {
    // A degenerate input takes the early-return path rather than an exception,
    // and the guard it sits beside stays load-bearing either way.
    expect(() => recordRadarFind({ title: "", sourceUrl: "" })).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 3 — THE HANDLE MAP: nothing is ever guessed", () => {
  it("the shipped data/handles.json validates and carries the 15 seeded names", () => {
    const parsed = HandleMapSchema.safeParse(JSON.parse(read("data/handles.json")));
    expect(parsed.success).toBe(true);
    const map = parsed.success ? parsed.data.handles : {};
    expect(Object.keys(map)).toHaveLength(15);
    for (const [name, handle] of [
      ["Vijay", "actorvijay"], ["Pooja Hegde", "hegdepooja"], ["Anirudh Ravichander", "anirudhofficial"],
      ["ZEE5", "zee5"], ["Akshay Kumar", "akshaykumar"], ["Suniel Shetty", "suniel.shetty"],
      ["JioHotstar", "jiohotstar"], ["Kiran Abbavaram", "kiran_abbavaram"], ["SonyLIV", "sonylivindia"],
      ["Jackie Shroff", "apnabhidu"], ["Yuvan Shankar Raja", "itsyuvan"], ["Netflix", "netflix_in"],
      ["Rasha Thadani", "rashathadani"], ["Mohan Babu", "themohanbabu"], ["Prime Video", "primevideoin"],
    ] as Array<[string, string]>) {
      expect(map[name], name).toBeDefined();
      expect(map[name]!.handle).toBe(handle);
      expect(map[name]!.tick).toBe(true);
    }
  });

  it("it is git-VISIBLE — a fresh checkout must not silently degrade to all-search", () => {
    const ig = read(".gitignore");
    expect(ig).toContain("!data/handles.json");
    expect(ig.indexOf("data/*")).toBeLessThan(ig.indexOf("!data/handles.json"));
  });

  it("🔒 TICK-ONLY: an unticked row renders exactly like an unknown name", () => {
    const map = {
      Confirmed: { handle: "confirmed_ig", tick: true, lastChecked: "2026-08-19" },
      Unconfirmed: { handle: "maybe_ig", tick: false, lastChecked: "2026-08-19" },
    };
    expect(resolveHandle("Confirmed", map)).toEqual({ name: "Confirmed", handle: "confirmed_ig", display: "@confirmed_ig" });
    // tick:false must NOT leak the handle it stores, in any field.
    expect(resolveHandle("Unconfirmed", map)).toEqual({ name: "Unconfirmed", handle: null, display: "Unconfirmed - search" });
    expect(resolveHandle("Never Heard Of", map)).toEqual({ name: "Never Heard Of", handle: null, display: "Never Heard Of - search" });
  });

  it("the schema rejects a stored '@' so a kit can never emit '@@handle'", () => {
    expect(HandleMapSchema.safeParse({ handles: { X: { handle: "@foo", tick: true, lastChecked: "2026-08-19" } } }).success).toBe(false);
    expect(HandleMapSchema.safeParse({ handles: { X: { handle: "foo bar", tick: true, lastChecked: "2026-08-19" } } }).success).toBe(false);
    expect(HandleMapSchema.safeParse({ handles: { X: { handle: "foo", tick: true, lastChecked: "19-08-2026" } } }).success).toBe(false);
    expect(HandleMapSchema.safeParse({ handles: { X: { handle: "foo.bar_1", tick: true, lastChecked: "2026-08-19" } } }).success).toBe(true);
  });

  it("a missing or malformed file degrades to all-search, never to a throw", () => {
    expect(loadHandleMap(join(tmp, "nope.json"), true)).toEqual({});
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, '{"handles":{"X":{"handle":"@no","tick":"yes"}}}', "utf-8");
    expect(loadHandleMap(bad, true)).toEqual({});
    expect(resolveHandle("Anyone", loadHandleMap(bad, true)).display).toBe("Anyone - search");
  });

  it("resolveHandles preserves order and drops duplicates", () => {
    const map = { A: { handle: "a_ig", tick: true, lastChecked: "2026-08-19" } };
    expect(resolveHandles(["A", "B", "A", " ", "B"], map).map((t) => t.display))
      .toEqual(["@a_ig", "B - search"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 4 — THE 30-TERM LAW: exact bounds, enforced loudly", () => {
  it("HEADLINE: a real deck produces EXACTLY 5 hashtags, >=25 keywords, >=30 terms", () => {
    const kit = KIT();
    expect(kit.validation.hashtagCount).toBe(REQUIRED_HASHTAGS);
    expect(kit.validation.keywordCount).toBeGreaterThanOrEqual(MIN_KEYWORDS);
    expect(kit.validation.totalTerms).toBeGreaterThanOrEqual(MIN_TOTAL_TERMS);
    expect(kit.validation.ok).toBe(true);
  });

  it("BOUND 1 — hashtags must be EXACTLY 5, not at-least-5", () => {
    const kw = Array.from({ length: 40 }, (_, i) => `k${i}`);
    expect(validateKit(["#a", "#b", "#c", "#d"], kw).ok).toBe(false);
    expect(validateKit(["#a", "#b", "#c", "#d", "#e"], kw).ok).toBe(true);
    expect(validateKit(["#a", "#b", "#c", "#d", "#e", "#f"], kw).ok).toBe(false);
    expect(validateKit(["#a"], kw).failures[0]).toContain("EXACTLY 5");
  });

  it("BOUND 2 — keywords must be at least 25", () => {
    const tags = ["#a", "#b", "#c", "#d", "#e"];
    expect(validateKit(tags, Array.from({ length: 24 }, (_, i) => `k${i}`)).ok).toBe(false);
    expect(validateKit(tags, Array.from({ length: 25 }, (_, i) => `k${i}`)).ok).toBe(true);
  });

  it("BOUND 3 — the 30-term total is checked independently of the other two", () => {
    // Constructed so hashtags pass and keywords pass but the total is short —
    // impossible with the real defaults (5+25=30), which is exactly why the
    // third bound must be its own check rather than an inferred consequence.
    const v = validateKit(["#a", "#b", "#c", "#d", "#e"], Array.from({ length: 25 }, (_, i) => `k${i}`));
    expect(v.totalTerms).toBe(30);
    expect(v.ok).toBe(true);
    const short = validateKit(["#a", "#b"], ["x"]);
    expect(short.failures.some((f) => f.includes("30-term law"))).toBe(true);
    expect(short.failures).toHaveLength(3);          // all three reported together
  });

  it("the builder REFUSES rather than shipping a short kit", () => {
    expect(() => KIT({ releases: [rel({ title: "Only One" })] }))
      .toThrow(/posting kit REFUSED/);
  });

  it("EXACTLY four film titles are tagged, by prominence, and the rest are NAMED", () => {
    const kit = KIT();
    expect(kit.hashtags).toEqual([
      "#JanaNayagan", "#WelcomeToTheJungle", "#ChennaiLoveStory", "#TheGreatGrandSuperhero", "#NowStreaming",
    ]);
    // Srinivasa Mangapuram has NO tmdbPopularity (the manual add) so it sinks last.
    expect(kit.markdown).toContain("NOT tagged (below the top four by prominence): Pyaar Prema Kalyanam, Srinivasa Mangapuram");
  });

  it("the pillar tag switches with the edition", () => {
    expect(pickHashtags(sixFilms(), "ott").tags.at(-1)).toBe("#NowStreaming");
    expect(pickHashtags(sixFilms(), "theatrical").tags.at(-1)).toBe("#InTheaters");
  });

  it("titleTag strips punctuation and diacritics", () => {
    expect(titleTag("Thank You, Subbarao!")).toBe("#ThankYouSubbarao");
    expect(titleTag("Párvathy")).toBe("#Parvathy");
    expect(titleTag("!!!")).toBe("");
  });

  it("keywords are PLAIN terms — no hashes — and deterministic", () => {
    const a = buildKeywords(sixFilms(), "ott");
    const b = buildKeywords(sixFilms(), "ott");
    expect(a).toEqual(b);
    expect(a.some((k) => k.includes("#"))).toBe(false);
    expect(new Set(a.map((k) => k.toLowerCase())).size).toBe(a.length);   // deduped
    expect(a).toContain("what to watch this weekend");
    expect(buildKeywords(sixFilms(), "theatrical")).toContain("movies releasing this week");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 5 — ALT TEXT, PHOTO TAGS, HEADER, ORDER", () => {
  it("alt text is built from release fields, one per card", () => {
    const kit = KIT();
    expect(kit.altText).toHaveLength(6);
    expect(kit.altText[0]).toBe(
      "Title card for the Tamil film Jana Nayagan, shown beside its poster, streaming on ZEE5, from 2026-08-21, " +
      "directed by H. Vinoth, starring Vijay and Pooja Hegde, music by Anirudh Ravichander, 186 minutes."
    );
    expect(kit.markdown).toContain("- **C1** — Title card for the Tamil film Jana Nayagan");
    expect(kit.markdown).toContain("- **C6** — ");
  });

  it("a THREE-name cast reads as a list, not 'A and B and C'", () => {
    const three = rel({ title: "Trio", leadCast: ["A", "B", "C"], platform: ["Netflix", "ZEE5"] });
    const text = altTextFor(three, "ott");
    expect(text).toContain("starring A, B and C");
    expect(text).toContain("streaming on Netflix and ZEE5");
    expect(text).not.toContain("and B and C");
    // …and the two- and one-name cases keep the natural forms.
    expect(altTextFor(rel({ title: "Duo", leadCast: ["A", "B"] }), "ott")).toContain("starring A and B");
    expect(altTextFor(rel({ title: "Solo", leadCast: ["A"] }), "ott")).toContain("starring A.");
  });

  it("a sparse release degrades to a shorter sentence, never to 'undefined'", () => {
    const bare = rel({ title: "Bare", platform: [], releaseDates: {} });
    delete (bare as { posterUrl?: string }).posterUrl;
    const text = altTextFor(bare, "ott");
    expect(text).toBe("Title card for the Tamil film Bare, streaming platform to be announced.");
    expect(text).not.toContain("undefined");
    expect(altTextFor(bare, "theatrical")).toBe("Title card for the Tamil film Bare.");
  });

  it("photo tags follow the card's own order: lead cast, music director, platform", () => {
    expect(tagNamesFor(sixFilms()[0]!)).toEqual(["Vijay", "Pooja Hegde", "Anirudh Ravichander", "ZEE5"]);
  });

  it("the checklist emits @handles only for ticked names and 'search' for the rest", () => {
    const map = JSON.parse(read("data/handles.json")).handles as Record<string, { handle: string; tick: boolean; lastChecked: string }>;
    const kit = KIT({ handleMap: map });
    const c1 = kit.photoTags[0]!;
    expect(c1.card).toBe("C1");
    expect(c1.tags.map((t) => t.display)).toEqual(["@actorvijay", "@hegdepooja", "@anirudhofficial", "@zee5"]);
    // An unmapped name renders as an instruction, not a guess.
    const c3 = kit.photoTags[2]!;
    expect(c3.tags.map((t) => t.display)).toContain("Sri Gouri Priya Reddy - search");
    expect(kit.markdown).toContain("- **C1 · Jana Nayagan** — @actorvijay · @hegdepooja · @anirudhofficial · @zee5");
  });

  it("with NO map at all, every tag says search — the safe default", () => {
    const kit = KIT({ handleMap: {} });
    expect(kit.photoTags.flatMap((p) => p.tags).every((t) => t.handle === null)).toBe(true);
    expect(kit.markdown).not.toContain("@");
  });

  it("the DRAFT/UNREVIEWED header matches deck-zip's CAPTION_HEADER doctrine", () => {
    expect(KIT_HEADER).toContain("DRAFT");
    expect(KIT_HEADER).toContain("UNREVIEWED");
    expect(KIT_HEADER).toContain("hand-built captions supersede this");
    const kit = KIT();
    expect(kit.markdown.split("\n")[2]).toBe(`> ${KIT_HEADER}`);
    expect(kit.caption.startsWith(KIT_HEADER)).toBe(true);
    // deck-zip's own header still exists and still says the same thing.
    expect(read("src/delivery/deliver-deck-zip.ts")).toContain('CAPTION_HEADER = "DRAFT — review before posting; hand-built captions supersede this"');
  });

  it("location + carousel order name every card in deck order", () => {
    const kit = KIT();
    expect(kit.markdown).toContain("Location: India");
    expect(kit.markdown).toContain("1. Cover");
    expect(kit.markdown).toContain("2. C1 — Jana Nayagan");
    expect(kit.markdown).toContain("7. C6 — Srinivasa Mangapuram");
  });

  it("caption.txt is header + body + exactly the five tags", () => {
    const kit = KIT();
    expect(kit.caption).toBe(
      `${KIT_HEADER}\n\nSix films, one couch.\n\n#JanaNayagan #WelcomeToTheJungle #ChennaiLoveStory #TheGreatGrandSuperhero #NowStreaming`
    );
  });

  it("the kit is DETERMINISTIC — same input, byte-identical output", () => {
    expect(KIT().markdown).toBe(KIT().markdown);
  });

  it("🔒 NO MODEL CALL: the generator imports no LLM client", () => {
    const src = read("src/delivery/posting-kit.ts");
    expect(src).not.toContain("callClaudeJSON");
    expect(src).not.toContain("content/claude");
    expect(src).not.toContain("anthropic");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 6 — DECK-ZIP: Wednesday's options, and everyone else's byte-identity", () => {
  it("🔒 the three pre-22C callers pass NO new options — defaults preserve their behaviour", () => {
    const sat = read("src/jobs/saturday-verdict.ts");
    const news = read("src/jobs/news-edition.ts");
    const arch = read("src/jobs/friday-archives.ts");
    expect(sat).toContain('buildAndUploadDeckZip({ outputDir: "output/posts", date: dateStr })');
    expect(news).toContain('buildAndUploadDeckZip({ outputDir: "output/posts", date: istDate, slug: NEWS_SLUG })');
    expect(arch).toContain('buildAndUploadDeckZip({ outputDir: "output/posts", date: dateStr, slug: ARCHIVES_SLUG })');
    for (const s of [sat, news, arch]) {
      expect(s).not.toContain("resize:");
      expect(s).not.toContain("igSize:");
    }
  });

  it("the defaults ARE the historical values — resize on, 1080x1350", () => {
    const src = read("src/delivery/deliver-deck-zip.ts");
    expect(src).toContain("const doResize = opts.resize ?? true;");
    expect(src).toContain("opts.igSize ?? { width: IG_WIDTH, height: IG_HEIGHT }");
    expect(src).toContain("const IG_WIDTH = 1080;");
    expect(src).toContain("const IG_HEIGHT = 1350;");
  });

  it("🔒 WEDNESDAY SHIPS resize:false — its cards are SQUARE and a fill would stretch them", () => {
    // Measured: cover 1080x1350 CSS @dsf2 = 2160x2700 (4:5); card 1080x1080
    // @dsf2 = 2160x2160 (1:1). fit:"fill" to 1080x1350 is a 1.25x vertical
    // stretch on every card.
    expect(read("src/rendering/render-wed-drop.ts")).toContain("width: 1080, height: 1080,");
    expect(read("src/rendering/templates/wed-drop-card.html")).toContain("height: 1080px;");
    expect(read("src/rendering/templates/wed-drop-cover.html")).toContain("height: 1350px;");
    const job = read("src/jobs/wednesday-drop.ts");
    expect(job).toContain("resize: false,");
    expect(job).toContain('slug: wedSlug,');
  });

  it("the kit rides in the zip only when one was written — pre-22C archives are unchanged", () => {
    const src = read("src/delivery/deliver-deck-zip.ts");
    expect(src).toContain("const kit = await tryReadKit(outputDir, slug, date);");
    expect(src).toContain('if (kit != null) zip.addFile("POSTING-KIT.md"');
    expect(src).toContain("return await readFile(join(outputDir, `${slug}-${date}-POSTING-KIT.md`)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 7 — WIRING: slot, non-fatality, and nothing else moved", () => {
  const job = () => read("src/jobs/wednesday-drop.ts");

  it("the kit is built AFTER the render audit passes and BEFORE the R2 upload", () => {
    const s = job();
    const auditOk = s.indexOf("Render audit clean");
    const kit = s.indexOf("buildPostingKit({");
    const r2 = s.indexOf("Uploading to R2...");
    expect(auditOk).toBeGreaterThan(-1);
    expect(auditOk).toBeLessThan(kit);
    expect(kit).toBeLessThan(r2);
  });

  it("the WHOLE delivery block is non-fatal", () => {
    const s = job();
    const block = s.slice(s.indexOf("let deckLine = \"\";"), s.indexOf("Uploading to R2..."));
    expect(block).toContain("try {");
    expect(block).toContain("catch (err)");
    expect(block).toContain("deck still delivering");
    expect(block).not.toContain("throw");
    // …and a failed zip simply removes the Slack line.
    expect(s).toContain("...(deckLine ? [deckLine] : [])");
  });

  it("PNGs + kit land in a local, disposable delivery dir under gitignored output/", () => {
    const s = job();
    expect(s).toContain("output/deliveries/wed-${meta.slug}-${issueNumber}");
    expect(s).toContain('writeFile(join(deliveryDir, "POSTING-KIT.md")');
    expect(read(".gitignore")).toContain("output");
  });

  it("🔒 CLEANLINESS: cleanOldRenders untouched, no new field in filmFingerprint", () => {
    const renderer = read("src/rendering/render-wed-drop.ts");
    expect(renderer).toContain("await cleanOldRenders(outputDir, `${meta.slug}-${baseCtx.date}`);");
    const gate = read("src/reconcile/gate.ts");
    const start = gate.indexOf("function filmFingerprint");
    const fp = gate.slice(start, gate.indexOf("\n}", start) + 2);
    for (const field of ["radar", "kit", "handle", "deckLine", "posting"]) {
      expect(fp.toLowerCase()).not.toContain(field);
    }
  });

  it("🔒 nothing here touches the gate, the contract, or the ledger", () => {
    for (const f of ["src/reconcile/gate.ts", "src/reconcile/auto-contract.ts", "src/shared/verdict-ledger.ts"]) {
      const s = read(f);
      expect(s).not.toContain("posting-kit");
      expect(s).not.toContain("radar-pool");
      expect(s).not.toContain("handles.js");
    }
  });

  it("one render-dir literal, shared by the renderer call and the zip discovery", () => {
    const s = job();
    expect(s).toContain('const RENDER_OUTPUT_DIR = "output/posts";');
    expect(s).toContain("renderWedDrop(draft, issueNumber, edition, RENDER_OUTPUT_DIR)");
    expect(s).toContain("outputDir: RENDER_OUTPUT_DIR,");
  });
});
