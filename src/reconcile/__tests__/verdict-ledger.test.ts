// WD-ENG-22A — THE VERDICT LEDGER. Persistence for AI-review confirms.
//
// ── THE CLASS UNDER TEST ────────────────────────────────────────────────────
// The AI-review cache is keyed by the projected film set and lives 24 hours —
// the right lifetime for the --approve determinism spine, the wrong one for a
// FACT. A film that trade press confirmed last Wednesday is re-searched from
// scratch this Wednesday, and the second search is a fresh roll of the dice:
// the same film has come back "confirm" one week and "unverified" the next
// purely because the query surfaced different pages. Enforcement REMOVES an
// unverified film, so that flip drops a real release off a real deck.
//
// The ledger stores the confirm — a dated, sourced observation — and replays it
// while it is still fresh AND still uncontradicted.
//
// ── THE TWO ASYMMETRIES THAT MAKE IT SAFE ───────────────────────────────────
// 1. ONLY CONFIRMS ARE WRITTEN. A negative is a fact about the search, not
//    about the film; persisting one would build the mirror-image failure (a
//    film permanently condemned by one bad week). A film with no row bills
//    exactly as today, so the ledger can only ever SAVE a call — never cause a
//    removal that would not otherwise have happened.
// 2. A CONFIRM IS REVOCABLE THREE WAYS — TTL, consult-time voiding, and
//    post-enforcement voiding. Every pin below exercises one of them.
//
// Hermetic: LLM transport mocked, verdict cache mocked, sqlite in memory. No
// network, no Anthropic call, no write to data/cache.sqlite.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../content/claude.js", () => ({ callClaudeJSON: vi.fn() }));
const cacheMock = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
// In-memory sqlite for BOTH tables the ledger reaches through (the reddit-radar
// precedent). `cached` stays a stateful mock so a ledger HIT is provably the
// only thing that can save the billed call: the verdict cache is cleared
// between cases, so if the loader is not invoked, the ledger is why.
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
  };
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callClaudeJSON } from "../../content/claude.js";
import {
  annotateWithAiReview,
  buildReviewPrompt,
  enforceVerification,
  reviewRef,
  voidDemotedLedgerRows,
  AI_REVIEW_CACHE_VERSION,
} from "../ai-review.js";
import {
  classifyLedgerConsult,
  clearVerdictLedgerForTests,
  dateWithinLedgerWindow,
  parseTtlDays,
  qualifiesForLedger,
  readVerdictRow,
  recordConfirm,
  verdictTtlDays,
  DEFAULT_VERDICT_TTL_DAYS,
  VOIDING_DEMOTION_CLASSES,
  type VerdictRow,
} from "../../shared/verdict-ledger.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { ReconcileResult, ReconciledFilm } from "../types.js";

const mockCall = vi.mocked(callClaudeJSON);
const ENFORCE = { requireOttPlatform: true };
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = { start: "2026-08-19", end: "2026-08-23" };
const WINDOW_LABEL = `${WINDOW.start} → ${WINDOW.end}`;
const ALLOW_URL = "https://www.pinkvilla.com/confirmed";

function release(id: string, platform: string[] = ["Netflix"]): Release {
  return {
    id, title: "X", language: "Tamil", isSeries: false, platform: platform as Release["platform"],
    releaseDate: "2026-08-21", genre: [], cast: [], synopsis: "", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-08-18T00:00:00.000Z",
  };
}

/** A reviewable film. `release.id` IS the ledger ref (reviewRef). */
function film(p: Partial<ReconciledFilm> & { title: string }): ReconciledFilm {
  return {
    language: "Tamil", pillar: "theatrical", dateSource: "tmdb", date: "2026-08-21",
    foundIn: ["tmdb", "ai-net"], status: "confirmed", tier: "green", reasons: [],
    release: release(`tmdb-${p.tmdbId ?? 0}`),
    ...p,
  } as ReconciledFilm;
}

function result(films: ReconciledFilm[], pillar = "theatrical"): ReconcileResult {
  return {
    pillar,
    window: { ...WINDOW },
    reconciled: films,
    rejected: [],
    counts: {
      total: films.length,
      green: films.filter((f) => f.tier === "green").length,
      yellow: films.filter((f) => f.tier === "yellow").length,
      red: films.filter((f) => f.tier === "red").length,
      addedByAiNet: 0, flagged: 0,
    },
  };
}

/** Seed one row directly, as a prior week's run would have left it. */
function seed(p: {
  ref: string;
  tmdbId?: number | undefined;
  sourceUrl?: string;
  sourceDomainTrust?: "allow" | "deny" | "unknown";
  windowEnd?: string;
  pillar?: string;
  ageDays?: number;
}): void {
  const ok = recordConfirm({
    ref: p.ref,
    tmdbId: p.tmdbId,
    review: {
      verdict: "confirm",
      trust: "confirmed",
      sourceUrl: p.sourceUrl ?? ALLOW_URL,
      sourceDomainTrust: p.sourceDomainTrust ?? "allow",
    },
    windowEnd: p.windowEnd ?? WINDOW.end,
    pillar: p.pillar ?? "theatrical",
    now: Date.now() - (p.ageDays ?? 0) * DAY,
  });
  expect(ok).toBe(true);
}

const savedTtl = process.env.VERDICT_TTL_DAYS;

beforeEach(() => {
  mockCall.mockReset();
  cacheMock.store.clear();
  clearVerdictLedgerForTests();
  delete process.env.VERDICT_TTL_DAYS;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedTtl === undefined) delete process.env.VERDICT_TTL_DAYS;
  else process.env.VERDICT_TTL_DAYS = savedTtl;
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 1 — WRITE PATH: confirms only, and only sourced ones", () => {
  it("HEADLINE: of six verdicts, ONLY the sourced non-denylisted confirm is persisted", async () => {
    const films = [
      film({ tmdbId: 1, title: "Confirmed Allow" }),
      film({ tmdbId: 2, title: "Confirmed Unknown-domain" }),
      film({ tmdbId: 3, title: "Confirmed But Sourceless" }),
      film({ tmdbId: 4, title: "Confirmed But Piracy-sourced" }),
      film({ tmdbId: 5, title: "Doubted" }),
      film({ tmdbId: 6, title: "Rejected" }),
    ];
    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-1", verdict: "confirm", reason: "ok", sourceUrl: ALLOW_URL },
        { ref: "tmdb-2", verdict: "confirm", reason: "ok", sourceUrl: "https://some-outlet.example/x" },
        { ref: "tmdb-3", verdict: "confirm", reason: "ok" },
        { ref: "tmdb-4", verdict: "confirm", reason: "ok", sourceUrl: "https://mlsbd.tv/x" },
        { ref: "tmdb-5", verdict: "doubt", reason: "contested", sourceUrl: ALLOW_URL },
        { ref: "tmdb-6", verdict: "reject", reason: "postponed", sourceUrl: ALLOW_URL },
      ],
    });

    await annotateWithAiReview([result(films)]);

    expect(readVerdictRow("tmdb-1")).toBeDefined();          // confirm + allow
    expect(readVerdictRow("tmdb-2")).toBeDefined();          // confirm + unknown domain is still a confirm
    expect(readVerdictRow("tmdb-3")).toBeUndefined();        // no cite ⇒ never persisted
    expect(readVerdictRow("tmdb-4")).toBeUndefined();        // denylisted ⇒ trust unconfirmed anyway
    expect(readVerdictRow("tmdb-5")).toBeUndefined();        // doubt is a fact about the SEARCH
    expect(readVerdictRow("tmdb-6")).toBeUndefined();        // reject likewise — never persisted
  });

  it("the persisted row carries the full observation: verdict, trust, cite, window, pillar, TTL", async () => {
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-7", verdict: "confirm", reason: "ok", sourceUrl: ALLOW_URL }] });
    const before = Date.now();
    await annotateWithAiReview([result([film({ tmdbId: 7, title: "Khalifa" })])]);

    const row = readVerdictRow("tmdb-7")!;
    expect(row.verdict).toBe("confirm");
    expect(row.trust).toBe("confirmed");
    expect(row.source_url).toBe(ALLOW_URL);
    expect(row.source_domain_trust).toBe("allow");
    expect(row.tmdb_id).toBe(7);
    expect(row.window_end).toBe(WINDOW.end);
    expect(row.pillar).toBe("theatrical");
    expect(row.confirmed_at).toBeGreaterThanOrEqual(before);
    expect(row.expires_at - row.confirmed_at).toBe(DEFAULT_VERDICT_TTL_DAYS * DAY);
  });

  it("a TMDb-LESS manual add persists with tmdb_id NULL, keyed by its manual- ref", async () => {
    // WD-ENG-21 made a manual add assessable; it must therefore be ledgerable.
    // `ref` is what carries it — there is no id to key on.
    const manual = film({
      title: "Judaa", tier: "yellow", foundIn: ["manual"],
      manualAdd: { evidenceBasis: "trade-press", verified: false, assertion: true, sourceUrls: ["https://x.example"], label: "trade-press" },
      release: release("manual-judaa", []),
    });
    delete (manual as { tmdbId?: number }).tmdbId;
    expect(reviewRef(manual)).toBe("manual-judaa");

    mockCall.mockResolvedValue({ reviews: [{ ref: "manual-judaa", tmdbId: null, verdict: "confirm", reason: "trade press", sourceUrl: ALLOW_URL }] });
    await annotateWithAiReview([result([manual])]);

    const row = readVerdictRow("manual-judaa")!;
    expect(row).toBeDefined();
    expect(row.tmdb_id).toBeNull();
    expect(row.verdict).toBe("confirm");
  });

  it("recordConfirm REFUSES a non-qualifying verdict at the storage boundary, not only at the call site", () => {
    // The guard is duplicated deliberately: a future caller that forgets to
    // check must still be unable to persist a negative.
    for (const bad of [
      { verdict: "doubt" as const, trust: "unconfirmed" as const, sourceUrl: ALLOW_URL, sourceDomainTrust: "allow" as const },
      { verdict: "reject" as const, trust: "contradicted" as const, sourceUrl: ALLOW_URL, sourceDomainTrust: "allow" as const },
      { verdict: "confirm" as const, trust: "confirmed" as const, sourceDomainTrust: "allow" as const },        // no cite
      { verdict: "confirm" as const, trust: "unconfirmed" as const, sourceUrl: ALLOW_URL, sourceDomainTrust: "deny" as const },
      { verdict: "unavailable" as const, sourceUrl: ALLOW_URL },
    ]) {
      expect(qualifiesForLedger(bad)).toBe(false);
      expect(recordConfirm({ ref: "tmdb-99", tmdbId: 99, review: bad, windowEnd: WINDOW.end, pillar: "theatrical" })).toBe(false);
    }
    expect(readVerdictRow("tmdb-99")).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 2 — READ PATH: a hit skips the billed call entirely", () => {
  it("HEADLINE: a fresh row answers the film and the LLM loader is NEVER invoked", async () => {
    seed({ ref: "tmdb-10", tmdbId: 10 });
    mockCall.mockResolvedValue({ reviews: [] });

    const f = film({ tmdbId: 10, title: "Khalifa" });
    await annotateWithAiReview([result([f])]);

    // The verdict cache was cleared in beforeEach, so nothing but the ledger
    // could have prevented this call.
    expect(mockCall).not.toHaveBeenCalled();
    expect(f.aiReview?.verdict).toBe("confirm");
    expect(f.aiReview?.trust).toBe("confirmed");
    expect(f.aiReview?.sourceUrl).toBe(ALLOW_URL);
    expect(f.aiReview?.sourceDomainTrust).toBe("allow");
  });

  it("a ledger-sourced verdict is marked provenance:'ledger'; a billed one is not", async () => {
    seed({ ref: "tmdb-11", tmdbId: 11 });
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-12", verdict: "confirm", reason: "fresh", sourceUrl: ALLOW_URL }] });

    const hit = film({ tmdbId: 11, title: "From Ledger" });
    const billed = film({ tmdbId: 12, title: "From Search" });
    await annotateWithAiReview([result([hit, billed])]);

    expect(hit.aiReview?.provenance).toBe("ledger");
    expect(billed.aiReview?.provenance).toBeUndefined();
  });

  it("a MISS bills: the film with no row is the one in the prompt, and the covered one is absent", async () => {
    seed({ ref: "tmdb-13", tmdbId: 13 });
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-14", verdict: "confirm", reason: "ok", sourceUrl: ALLOW_URL }] });

    const covered = film({ tmdbId: 13, title: "Covered" });
    const uncovered = film({ tmdbId: 14, title: "Uncovered" });
    await annotateWithAiReview([result([covered, uncovered])]);

    expect(mockCall).toHaveBeenCalledTimes(1);
    const prompt = mockCall.mock.calls[0]![0] as string;
    expect(prompt).toContain("Uncovered");
    expect(prompt).not.toContain("Covered");                 // partitioned OUT before the prompt is built
    expect(covered.aiReview?.provenance).toBe("ledger");
    expect(uncovered.aiReview?.provenance).toBeUndefined();
  });

  it("EVERY film covered ⇒ ZERO calls for that edition (the whole point)", async () => {
    seed({ ref: "tmdb-15", tmdbId: 15 });
    seed({ ref: "tmdb-16", tmdbId: 16 });
    mockCall.mockResolvedValue({ reviews: [] });
    await annotateWithAiReview([result([film({ tmdbId: 15, title: "A" }), film({ tmdbId: 16, title: "B" })])]);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("🔒 THE --APPROVE SPINE: the re-run costs ZERO extra calls even though the ledger changed under it", async () => {
    // THE TRAP THIS PINS. The review run writes a row for every film it
    // confirmed, so its --approve re-run partitions DIFFERENTLY — those films
    // are now ledger-covered. Keying the verdict cache on the BILLED SUBSET
    // (the obvious choice, since the blob is that subset's output) therefore
    // MISSES on the re-run: a second billed call inside a ≤2/drop budget, whose
    // re-rolled verdicts can move the demotion set and the gate hash, which is
    // an --approve that no longer matches what the human read.
    //
    // The key stays over the FULL reviewable set, so the re-run HITS: covered
    // films come from their rows, the rest from the cached blob.
    const mk = () => [result([film({ tmdbId: 18, title: "Confirmed" }), film({ tmdbId: 19, title: "Doubted", tier: "yellow" })])];
    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-18", verdict: "confirm", reason: "ok", sourceUrl: ALLOW_URL },
        { ref: "tmdb-19", verdict: "doubt", reason: "contested", sourceUrl: ALLOW_URL },
      ],
    });

    const reviewRun = mk();
    await annotateWithAiReview(reviewRun);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(readVerdictRow("tmdb-18")).toBeDefined();          // the ledger MOVED between the runs
    expect(readVerdictRow("tmdb-19")).toBeUndefined();

    const approveRun = mk();
    await annotateWithAiReview(approveRun);
    expect(mockCall).toHaveBeenCalledTimes(1);                // STILL one
    // …and film-for-film the same verdicts, from two different sources.
    expect(approveRun[0]!.reconciled[0]!.aiReview?.trust).toBe("confirmed");
    expect(approveRun[0]!.reconciled[0]!.aiReview?.provenance).toBe("ledger");
    expect(approveRun[0]!.reconciled[1]!.aiReview?.trust).toBe("unconfirmed");
    expect(approveRun[0]!.reconciled[1]!.aiReview?.provenance).toBeUndefined();
  });

  it("THE PAYOFF: past the 24h verdict cache, a confirmed film can no longer FLIP — it is not re-searched", async () => {
    // The operationally painful form of the flip class: an --approve run more
    // than 24h after the review run finds the verdict cache expired, re-bills
    // the whole edition, and a film that came back "confirm" on Wednesday comes
    // back "unverified" on Friday — enforcement removes it, the hash moves, and
    // the pinned approve hash is dead. With a row in the ledger the confirmed
    // film is never re-asked, so it cannot flip.
    seed({ ref: "tmdb-20b", tmdbId: 20 });
    cacheMock.store.clear();                                   // the 24h verdict cache has expired
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-21b", verdict: "doubt", reason: "contested", sourceUrl: ALLOW_URL }] });

    const stable = film({ tmdbId: 20, title: "Stable", release: release("tmdb-20b") });
    const other = film({ tmdbId: 21, title: "Other", tier: "yellow", release: release("tmdb-21b") });
    const results = [result([stable, other])];
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);

    expect(stable.aiReview?.verdict).toBe("confirm");
    expect(stable.aiDemoted).toBeUndefined();                  // survives, whatever a fresh search would have said
    expect(other.aiDemoted?.demotionClass).toBe("unconfirmed");
  });

  it("a ledger hit reaches enforcement identically to a billed confirm — no demotion, tier intact", async () => {
    seed({ ref: "tmdb-17", tmdbId: 17 });
    mockCall.mockResolvedValue({ reviews: [] });
    const f = film({ tmdbId: 17, title: "Survivor" });
    const results = [result([f])];
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);
    expect(f.aiDemoted).toBeUndefined();
    expect(f.tier).toBe("green");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 3 — CONSULT-TIME VOIDING: every contradiction class deletes the row and bills", () => {
  /** Run one edition with a seeded row and a film carrying `extra`. */
  async function consult(extra: Partial<ReconciledFilm>, pillar = "theatrical"): Promise<ReconciledFilm> {
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-20", verdict: "unverified", reason: "couldn't confirm via search" }] });
    const f = film({ tmdbId: 20, title: "Contested", ...extra });
    await annotateWithAiReview([result([f], pillar)]);
    return f;
  }

  it("conflictDetail ⇒ voided + billed", async () => {
    seed({ ref: "tmdb-20", tmdbId: 20 });
    const f = await consult({ conflictDetail: "press says Aug 28, TMDb says Aug 21" });
    expect(readVerdictRow("tmdb-20")).toBeUndefined();
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(f.aiReview?.provenance).toBeUndefined();
  });

  it("platformSuppressed ⇒ voided + billed", async () => {
    seed({ ref: "tmdb-20", tmdbId: 20 });
    await consult({ platformSuppressed: { was: "ZEE5", pressPlatform: "SonyLIV" } });
    expect(readVerdictRow("tmdb-20")).toBeUndefined();
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("a source that has SINCE been denylisted ⇒ voided + billed (the denylist is retroactive)", async () => {
    // Written when mlsbd was not yet on the list, so the stored trust says
    // "unknown". classifyDomainTrust is re-run at consult time, which is what
    // makes adding a domain protect the films reviewed BEFORE the edit too.
    seed({ ref: "tmdb-20", tmdbId: 20, sourceUrl: "https://mlsbd.tv/contested", sourceDomainTrust: "unknown" });
    await consult({});
    expect(readVerdictRow("tmdb-20")).toBeUndefined();
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("the film's date has moved PAST the confirmed window end ⇒ voided + billed", async () => {
    // The row says "corroborated for the window ending 2026-08-23". A film now
    // dated 2026-09-04 is a different claim; the confirm does not speak to it.
    seed({ ref: "tmdb-20", tmdbId: 20, windowEnd: "2026-08-23" });
    await consult({ date: "2026-09-04" });
    expect(readVerdictRow("tmdb-20")).toBeUndefined();
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("a date still INSIDE the confirmed window is NOT a contradiction ⇒ hit, row survives", async () => {
    seed({ ref: "tmdb-20", tmdbId: 20, windowEnd: "2026-08-23" });
    const f = await consult({ date: "2026-08-21" });
    expect(readVerdictRow("tmdb-20")).toBeDefined();
    expect(mockCall).not.toHaveBeenCalled();
    expect(f.aiReview?.provenance).toBe("ledger");
  });

  it("a row from the OTHER pillar never answers this one ⇒ voided + billed", async () => {
    // A theatrical confirm does not corroborate an OTT arrival: different
    // claim, different date. `ref` is the table's PK, so the guard is here.
    seed({ ref: "tmdb-20", tmdbId: 20, pillar: "ott" });
    await consult({});
    expect(readVerdictRow("tmdb-20")).toBeUndefined();
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("SEAM-#3 GUARD: an OTT film with no platform yet BILLS, so the platform fact-fill still happens", async () => {
    // Answering from the ledger would skip seam #3 (the ledger stores no
    // platform), handing enforcement a platform-less OTT film — a no-platform
    // demotion CAUSED by the optimisation. The ledger must only ever save a
    // call, so this film pays for one.
    seed({ ref: "tmdb-21", tmdbId: 21, pillar: "ott" });
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-21", verdict: "confirm", reason: "SonyLIV per press", sourceUrl: ALLOW_URL, platform: "SonyLIV" }] });

    const f = film({ tmdbId: 21, title: "Streaming", pillar: "ott", release: release("tmdb-21", []) });
    const results = [result([f], "ott")];
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(f.release!.platform).toEqual(["SonyLIV"]);        // the fill happened
    expect(f.aiDemoted).toBeUndefined();                     // …so no no-platform demotion
  });

  it("AMBIGUOUS REF: two reviewable films sharing a bare ref are neither consulted NOR written", async () => {
    // reviewRefs() disambiguates a batch with a POSITIONAL `#2` suffix, which
    // cannot be a persistent identity — the same film would key differently
    // depending on its neighbours. So the ledger abstains entirely rather than
    // risk handing one film's confirm to another (the harm WD-ENG-21's `ref`
    // exists to prevent).
    seed({ ref: "tmdb-22", tmdbId: 22 });
    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-22", verdict: "confirm", reason: "ok", sourceUrl: ALLOW_URL },
        { ref: "tmdb-22#2", verdict: "confirm", reason: "ok", sourceUrl: ALLOW_URL },
      ],
    });
    const a = film({ tmdbId: 22, title: "Judaa (TMDb)" });
    const b = film({ tmdbId: 22, title: "Judaa (other)" });
    await annotateWithAiReview([result([a, b])]);

    expect(mockCall).toHaveBeenCalledTimes(1);               // consulted for NEITHER
    expect(a.aiReview?.provenance).toBeUndefined();
    expect(b.aiReview?.provenance).toBeUndefined();
    // The pre-existing row is left alone (abstention is not voiding), and the
    // run adds nothing: a confirm keyed on an ambiguous ref is never written.
    const row = readVerdictRow("tmdb-22")!;
    expect(row.source_url).toBe(ALLOW_URL);
    expect(row.window_end).toBe(WINDOW.end);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 4 — TTL: no confirm outlives its shelf life", () => {
  it("a row past its TTL does NOT answer the film — it bills", async () => {
    seed({ ref: "tmdb-30", tmdbId: 30, ageDays: DEFAULT_VERDICT_TTL_DAYS + 6 });
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-30", verdict: "confirm", reason: "re-confirmed", sourceUrl: ALLOW_URL }] });
    const f = film({ tmdbId: 30, title: "Aged Out" });
    await annotateWithAiReview([result([f])]);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(f.aiReview?.provenance).toBeUndefined();
  });

  it("a row one day INSIDE its TTL still answers — the boundary is not off by a week", async () => {
    seed({ ref: "tmdb-31", tmdbId: 31, ageDays: DEFAULT_VERDICT_TTL_DAYS - 1 });
    mockCall.mockResolvedValue({ reviews: [] });
    const f = film({ tmdbId: 31, title: "Still Fresh" });
    await annotateWithAiReview([result([f])]);
    expect(mockCall).not.toHaveBeenCalled();
    expect(f.aiReview?.provenance).toBe("ledger");
  });

  it("an EXPIRED row is re-billed and then REPLACED by the fresh confirm (upsert, not duplicate)", async () => {
    seed({ ref: "tmdb-32", tmdbId: 32, ageDays: 30, sourceUrl: "https://old.example/x", sourceDomainTrust: "unknown" });
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-32", verdict: "confirm", reason: "re-confirmed", sourceUrl: ALLOW_URL }] });
    await annotateWithAiReview([result([film({ tmdbId: 32, title: "Renewed" })])]);
    const row = readVerdictRow("tmdb-32")!;
    expect(row.source_url).toBe(ALLOW_URL);
    expect(row.expires_at).toBeGreaterThan(Date.now());
  });

  it("VERDICT_TTL_DAYS parse: a positive integer wins; everything else falls back to 14", () => {
    expect(parseTtlDays("7")).toBe(7);
    expect(parseTtlDays(" 21 ")).toBe(21);
    expect(parseTtlDays(undefined)).toBe(DEFAULT_VERDICT_TTL_DAYS);
    expect(parseTtlDays("")).toBe(DEFAULT_VERDICT_TTL_DAYS);
    expect(parseTtlDays("0")).toBe(DEFAULT_VERDICT_TTL_DAYS);
    expect(parseTtlDays("-3")).toBe(DEFAULT_VERDICT_TTL_DAYS);
    expect(parseTtlDays("7.5")).toBe(DEFAULT_VERDICT_TTL_DAYS);
    // The one that matters: Number("1e3") is 1000. A malformed dial must never
    // LENGTHEN the life of a stored fact — it degrades to the safe default.
    expect(parseTtlDays("1e3")).toBe(DEFAULT_VERDICT_TTL_DAYS);
    expect(parseTtlDays("many")).toBe(DEFAULT_VERDICT_TTL_DAYS);
  });

  it("the dial is read at CALL time and actually reaches the stored expires_at", () => {
    expect(verdictTtlDays()).toBe(DEFAULT_VERDICT_TTL_DAYS);
    process.env.VERDICT_TTL_DAYS = "3";
    expect(verdictTtlDays()).toBe(3);
    recordConfirm({
      ref: "tmdb-33", tmdbId: 33,
      review: { verdict: "confirm", trust: "confirmed", sourceUrl: ALLOW_URL, sourceDomainTrust: "allow" },
      windowEnd: WINDOW.end, pillar: "theatrical",
    });
    const row = readVerdictRow("tmdb-33")!;
    expect(row.expires_at - row.confirmed_at).toBe(3 * DAY);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 5 — POST-ENFORCEMENT VOIDING: a demoted film loses its row", () => {
  const CLASSES = ["contradicted", "unconfirmed", "platform-conflict", "no-platform"] as const;

  it("every demotion class voids — enumerated from the exported list so a new class cannot be forgotten", () => {
    expect([...VOIDING_DEMOTION_CLASSES].sort()).toEqual([...CLASSES].sort());
  });

  it("HEADLINE: each of the four classes deletes that film's row", () => {
    const films = CLASSES.map((cls, i) => {
      seed({ ref: `tmdb-4${i}`, tmdbId: 40 + i });
      const f = film({ tmdbId: 40 + i, title: `Demoted ${cls}` });
      f.aiDemoted = { originalTier: "green", verdict: "reject", reason: cls, demotionClass: cls };
      return f;
    });
    for (const [i] of CLASSES.entries()) expect(readVerdictRow(`tmdb-4${i}`)).toBeDefined();

    expect(voidDemotedLedgerRows([result(films)])).toBe(4);
    for (const [i] of CLASSES.entries()) expect(readVerdictRow(`tmdb-4${i}`)).toBeUndefined();
  });

  it("a film that survives enforcement KEEPS its row", () => {
    seed({ ref: "tmdb-50", tmdbId: 50 });
    seed({ ref: "tmdb-51", tmdbId: 51 });
    const kept = film({ tmdbId: 50, title: "Kept" });
    const dropped = film({ tmdbId: 51, title: "Dropped" });
    dropped.aiDemoted = { originalTier: "green", verdict: "reject", reason: "x", demotionClass: "contradicted" };

    expect(voidDemotedLedgerRows([result([kept, dropped])])).toBe(1);
    expect(readVerdictRow("tmdb-50")).toBeDefined();
    expect(readVerdictRow("tmdb-51")).toBeUndefined();
  });

  it("END-TO-END: a film confirmed THIS run but demoted for no-platform leaves NO row behind", async () => {
    // The exact No.046 shape (Dial 1975): a sourced OTT confirm whose platform
    // no net could name. The write path stores it, enforcement removes the
    // film, and the voiding pass takes the row back out — so next week it
    // cannot be resurrected by its own stale confirm.
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-52", verdict: "confirm", reason: "ok", sourceUrl: ALLOW_URL, platform: null }] });
    const f = film({ tmdbId: 52, title: "Dial 1975", pillar: "ott", tier: "yellow", release: release("tmdb-52", []) });
    const results = [result([f], "ott")];

    await annotateWithAiReview(results);
    expect(readVerdictRow("tmdb-52")).toBeDefined();          // written by the review
    enforceVerification(results, ENFORCE);
    expect(f.aiDemoted?.demotionClass).toBe("no-platform");
    voidDemotedLedgerRows(results);
    expect(readVerdictRow("tmdb-52")).toBeUndefined();        // and taken back out
  });

  it("is wired into the job AFTER enforceVerification — the order is what makes it read aiDemoted", () => {
    const src = readFileSync(join(process.cwd(), "src/jobs/wednesday-drop.ts"), "utf8");
    expect(src).toContain("voidDemotedLedgerRows(results)");
    expect(src.indexOf("enforceVerification(results,")).toBeLessThan(src.indexOf("voidDemotedLedgerRows(results)"));
    // And it stayed OUT of enforceVerification, whose purity is the --approve
    // determinism spine (no clock, no env, no I/O).
    const ai = readFileSync(join(process.cwd(), "src/reconcile/ai-review.ts"), "utf8");
    const enforceBody = ai.slice(ai.indexOf("export function enforceVerification"));
    expect(enforceBody).not.toContain("voidVerdictRow");
    expect(enforceBody).not.toContain("recordConfirm");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 6 — FLIP VISIBILITY (groundwork for ENG-22B; no behaviour change)", () => {
  it("a billed verdict that DIFFERS from an expired row logs one line naming ref, old and new", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    seed({ ref: "tmdb-60", tmdbId: 60, ageDays: 40 });
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-60", verdict: "unverified", reason: "couldn't confirm via search" }] });

    await annotateWithAiReview([result([film({ tmdbId: 60, title: "Flipped" })])]);

    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("verdict changed vs expired ledger row: tmdb-60 confirm -> unverified");
  });

  it("a billed verdict that MATCHES the expired row logs nothing", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    seed({ ref: "tmdb-61", tmdbId: 61, ageDays: 40 });
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-61", verdict: "confirm", reason: "still on", sourceUrl: ALLOW_URL }] });

    await annotateWithAiReview([result([film({ tmdbId: 61, title: "Steady" })])]);

    expect(info.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("verdict changed"))).toBe(false);
  });

  it("the flip is REPORTED, never ACTED ON — the fresh verdict wins, exactly as without a ledger", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    seed({ ref: "tmdb-62", tmdbId: 62, ageDays: 40 });
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-62", verdict: "unverified", reason: "couldn't confirm via search" }] });
    const f = film({ tmdbId: 62, title: "Flipped" });
    const results = [result([f])];
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);
    expect(f.aiReview?.verdict).toBe("unverified");
    expect(f.aiDemoted?.demotionClass).toBe("unconfirmed");   // the stale confirm rescues nothing
  });

  it("one summary line per pillar reports hit / billed / voided", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    seed({ ref: "tmdb-63", tmdbId: 63 });                       // hit
    seed({ ref: "tmdb-64", tmdbId: 64 });                       // voided (conflict)
    mockCall.mockResolvedValue({ reviews: [{ ref: "tmdb-65", verdict: "unverified", reason: "x" }] });
    await annotateWithAiReview([result([
      film({ tmdbId: 63, title: "Hit" }),
      film({ tmdbId: 64, title: "Voided", conflictDetail: "dates disagree" }),
      film({ tmdbId: 65, title: "Billed" }),
    ])]);
    expect(info.mock.calls.map((c) => String(c[0])))
      .toContain("verdict ledger [theatrical]: 1 hit, 2 billed, 1 voided");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 7 — THE EMPTY-LEDGER INVARIANT: run one behaves exactly as today", () => {
  it("HEADLINE: the prompt is BYTE-IDENTICAL to buildReviewPrompt over the whole reviewable set", async () => {
    const films = [
      film({ tmdbId: 70, title: "A" }),
      film({ tmdbId: 71, title: "B", tier: "yellow" }),
      film({ tmdbId: 72, title: "C" }),
    ];
    const r = result(films);
    const expected = buildReviewPrompt(r.pillar, WINDOW_LABEL, films);
    mockCall.mockResolvedValue({ reviews: [] });

    await annotateWithAiReview([r]);

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall.mock.calls[0]![0]).toBe(expected);
  });

  it("every film is still assessed, and a 🔴 is still skipped — one call for the edition", async () => {
    const films = [
      film({ tmdbId: 73, title: "Green" }),
      film({ tmdbId: 74, title: "Yellow", tier: "yellow" }),
      film({ tmdbId: 75, title: "Red", tier: "red", status: "unverified", foundIn: ["ai-net"] }),
    ];
    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-73", verdict: "confirm", reason: "ok", sourceUrl: ALLOW_URL },
        { ref: "tmdb-74", verdict: "doubt", reason: "contested", sourceUrl: ALLOW_URL },
      ],
    });
    await annotateWithAiReview([result(films)]);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(films[0]!.aiReview?.trust).toBe("confirmed");
    expect(films[1]!.aiReview?.trust).toBe("unconfirmed");
    expect(films[2]!.aiReview).toBeUndefined();
  });

  it("fail-soft is unchanged on an empty ledger: a broken call marks every billed film unavailable", async () => {
    const films = [film({ tmdbId: 76, title: "X" }), film({ tmdbId: 77, title: "Y" })];
    mockCall.mockResolvedValue(undefined as unknown as { reviews: never[] });
    await annotateWithAiReview([result(films)]);
    expect(films.every((f) => f.aiReview?.verdict === "unavailable")).toBe(true);
  });

  it("but a LEDGER-ANSWERED film keeps its verdict when the billed call fails — no call, no failure", async () => {
    // markUnavailable now covers the BILLED subset only. Blanking a
    // ledger-answered film would invent an infra failure it never suffered and
    // push a verified film back at the human.
    seed({ ref: "tmdb-78", tmdbId: 78 });
    mockCall.mockResolvedValue(undefined as unknown as { reviews: never[] });
    const covered = film({ tmdbId: 78, title: "Covered" });
    const billed = film({ tmdbId: 79, title: "Billed" });
    await annotateWithAiReview([result([covered, billed])]);
    expect(covered.aiReview?.verdict).toBe("confirm");
    expect(covered.aiReview?.provenance).toBe("ledger");
    expect(billed.aiReview?.verdict).toBe("unavailable");
  });

  it("the review cache version is v5 — a v4 blob always covered every film; a v5 blob need not", () => {
    // Same key, different meaning: v4 was the model's output over the whole
    // reviewable set, v5 may be the output over the billed subset only. The
    // bump is what stops a v4 blob being read under v5 rules.
    expect(AI_REVIEW_CACHE_VERSION).toBe("v5");
  });

  it("the KEY is built from the full reviewable set, the PROMPT from the billed subset", () => {
    const src = readFileSync(join(process.cwd(), "src/reconcile/ai-review.ts"), "utf8");
    expect(src).toContain("reviewCacheKey(r, films)");
    expect(src).not.toContain("reviewCacheKey(r, toReview)");
    expect(src).toContain("buildReviewPrompt(r.pillar, windowLabel, toReview)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 8 — the pure decision helpers", () => {
  function row(p: Partial<VerdictRow> = {}): VerdictRow {
    return {
      ref: "tmdb-1", tmdb_id: 1, verdict: "confirm", trust: "confirmed",
      source_url: ALLOW_URL, source_domain_trust: "allow",
      confirmed_at: 1_000, expires_at: 10_000, window_end: "2026-08-23", pillar: "theatrical",
      ...p,
    };
  }
  const ctx = (p: Partial<Parameters<typeof classifyLedgerConsult>[1]> = {}) => ({
    pillar: "theatrical", filmDate: "2026-08-21", hasConflictDetail: false,
    platformSuppressed: false, sourceDeniedNow: false, now: 5_000, ...p,
  });

  it("no row ⇒ miss", () => {
    expect(classifyLedgerConsult(undefined, ctx()).kind).toBe("miss");
  });
  it("fresh + clean ⇒ hit", () => {
    expect(classifyLedgerConsult(row(), ctx()).kind).toBe("hit");
  });
  it("a STORED deny voids even if the domain would classify clean today", () => {
    // The mirror of the retroactive check: a domain REMOVED from the denylist
    // does not silently rehabilitate the rows written while it was on it.
    expect(classifyLedgerConsult(row({ source_domain_trust: "deny" }), ctx()).kind).toBe("void");
  });
  it("voiding beats expiry — a contradicted row is deleted, not left to age out", () => {
    // Order matters: if expiry won, a contradicted row would linger and feed
    // the flip-visibility log as though it had merely gone stale.
    const c = classifyLedgerConsult(row({ expires_at: 1 }), ctx({ hasConflictDetail: true }));
    expect(c.kind).toBe("void");
  });
  it("expiry is exclusive at the boundary: expires_at == now is EXPIRED", () => {
    expect(classifyLedgerConsult(row({ expires_at: 5_000 }), ctx()).kind).toBe("expired");
    expect(classifyLedgerConsult(row({ expires_at: 5_001 }), ctx()).kind).toBe("hit");
  });

  it("dateWithinLedgerWindow: no date is covered; a later date is not; junk on either side bills", () => {
    expect(dateWithinLedgerWindow(undefined, "2026-08-23")).toBe(true);
    expect(dateWithinLedgerWindow("2026-08-23", "2026-08-23")).toBe(true);   // the window's own end day
    expect(dateWithinLedgerWindow("2026-08-24", "2026-08-23")).toBe(false);
    expect(dateWithinLedgerWindow("2026-08-01", "2026-08-23")).toBe(true);   // earlier is not a re-dating
    expect(dateWithinLedgerWindow("soon", "2026-08-23")).toBe(false);        // unjudgeable ⇒ bill
    expect(dateWithinLedgerWindow("2026-08-21", "TBA")).toBe(false);
  });
});
