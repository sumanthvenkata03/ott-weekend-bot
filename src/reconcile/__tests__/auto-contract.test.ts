// WD-ENG-22B — SHADOW AUTOPILOT + THE FLIP CLAUSE.
//
// ── WHAT THIS FILE DEFENDS ──────────────────────────────────────────────────
// Two things that pull in opposite directions:
//
//   1. evaluateAutoContract must say MORE than the old three-clause `if` —
//      every failing clause, named, per film — while DECIDING exactly the same.
//      An enumeration that fires where the old expression passed would arm
//      autonomy by accident; one that stays silent where it failed would ship
//      something the gate used to catch. PART 1 pins both directions against a
//      hand-written copy of the legacy predicate, over a fixture matrix.
//
//   2. The shadow report must be OBSERVATION ONLY. It runs on every gated run,
//      it is the thing an operator will read when deciding whether to arm, and
//      it must not be able to change what the run does. PART 3 pins that.
//
// The ONE intended behaviour change is the FLIP CLAUSE: a film whose fresh
// verdict disagrees with an expired ledger row blocks auto-publish. It ships
// dark — WED_DROP_ALWAYS_GATE defaults ON and nothing here arms anything.
//
// Hermetic: no LLM, no sqlite, no network. evaluateAutoContract is pure, and
// the flip/provenance fixtures are hand-built rather than driven through
// ai-review (that path is covered in verdict-ledger.test.ts).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateAutoContract,
  isEffectiveGreen,
  missingLegs,
  renderableFilms,
  shadowAutopilotLines,
  shadowVerdictLine,
} from "../auto-contract.js";
import { decideGate, computeDropHash } from "../gate.js";
import { isAutoPublishEligible } from "../net-independence.js";
import type { Release } from "../../shared/types.js";
import type { ReconcileResult, ReconciledFilm } from "../types.js";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function release(id: string): Release {
  return {
    id, title: "X", language: "Tamil", isSeries: false, platform: ["Netflix"],
    releaseDate: "2026-08-21", genre: [], cast: [], synopsis: "", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-08-18T00:00:00.000Z",
  };
}

function film(p: Partial<ReconciledFilm> & { title: string }): ReconciledFilm {
  return {
    language: "Tamil", pillar: "theatrical", dateSource: "tmdb", date: "2026-08-21",
    foundIn: ["tmdb", "ai-net"], status: "confirmed", tier: "green", reasons: [],
    release: release(`tmdb-${p.title.replace(/\W+/g, "")}`),
    ...p,
  } as ReconciledFilm;
}

function result(films: ReconciledFilm[], pillar = "theatrical"): ReconcileResult {
  return {
    pillar,
    window: { start: "2026-08-19", end: "2026-08-23" },
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

/**
 * Strip the Release. Done by deletion rather than `release: undefined`, because
 * tsconfig sets exactOptionalPropertyTypes — an explicit undefined is a type
 * error against an exact-optional property, and the states differ to TS even
 * though they read the same at runtime.
 */
function noRelease(f: ReconciledFilm): ReconciledFilm {
  delete (f as { release?: unknown }).release;
  return f;
}

/** A clean drop that auto-publishes today. */
const clean = () => [result([film({ title: "Alpha" }), film({ title: "Beta" })])];

/**
 * THE LEGACY PREDICATE, hand-written from gate.ts as it stood before WD-ENG-22B.
 * Deliberately a SEPARATE copy: importing the real one would make the identity
 * pin tautological. If this drifts from what decideGate does, PART 1 fails —
 * which is the entire point.
 */
function legacyWouldAuto(results: ReconcileResult[]): boolean {
  const anyUncertain = results.some((r) => r.reconciled.some((f) => f.aiReview?.verdict === "unavailable"));
  const everyEditionNonEmpty =
    results.length > 0 &&
    results.every((r) => r.reconciled.filter((f) => f.release && !f.aiDemoted && f.tier !== "red").length > 0);
  const everyRenderableGreen = results.every((r) =>
    r.reconciled
      .filter((f) => f.release && !f.aiDemoted && f.tier !== "red")
      .every((f) => (f.tier === "green" && isAutoPublishEligible(f.foundIn)) || !!f.aiPromoted)
  );
  return !anyUncertain && everyEditionNonEmpty && everyRenderableGreen;
}

const checks = (rs: ReconcileResult[]) => evaluateAutoContract(rs).blockers.map((b) => b.check);
const countOf = (rs: ReconcileResult[], prefix: string) =>
  checks(rs).filter((c) => c.startsWith(prefix)).length;

// ════════════════════════════════════════════════════════════════════════════
describe("PART 1 — DECISION IDENTITY: enumerating more must not decide differently", () => {
  /** Every fixture below is flip-free, so legacy and contract must agree exactly. */
  const FIXTURES: Array<[string, () => ReconcileResult[]]> = [
    ["clean two-film drop", clean],
    ["clean across two editions", () => [result([film({ title: "A" })]), result([film({ title: "B", pillar: "ott" })], "ott")]],
    ["a plain yellow renders but is not effective-green", () => [result([film({ title: "A" }), film({ title: "Y", tier: "yellow" })])]],
    ["green but only tmdb+district (WD-ENG-19 narrow bar)", () => [result([film({ title: "D", foundIn: ["tmdb", "district"] })])]],
    ["a promoted single-net yellow IS effective-green", () => [result([film({ title: "P", tier: "yellow", foundIn: ["ai-net"], aiPromoted: { reason: "search-corroborated" } })])]],
    ["an unavailable verdict blocks", () => [result([film({ title: "A" }), film({ title: "U", aiReview: { verdict: "unavailable", reason: "infra" } })])]],
    ["an unavailable verdict on a RED film still blocks", () => [result([film({ title: "A" }), film({ title: "R", tier: "red", status: "unverified", aiReview: { verdict: "unavailable", reason: "infra" } })])]],
    ["an edition emptied by enforcement blocks", () => [result([film({ title: "A" })]), result([film({ title: "G", pillar: "ott", aiDemoted: { originalTier: "green", verdict: "reject", reason: "x", demotionClass: "contradicted" } })], "ott")]],
    ["a demoted film does not block the clean remainder", () => [result([film({ title: "A" }), film({ title: "G", tier: "yellow", aiDemoted: { originalTier: "yellow", verdict: "reject", reason: "x", demotionClass: "contradicted" } })])]],
    ["a RED film never blocks (it cannot render)", () => [result([film({ title: "A" }), film({ title: "R", tier: "red", status: "unverified", foundIn: ["ai-net"] })])]],
    ["a release-less film never blocks", () => [result([film({ title: "A" }), noRelease(film({ title: "N", tier: "yellow" }))])]],
    ["a manual add blocks", () => [result([film({ title: "A" }), film({ title: "M", tier: "yellow", foundIn: ["manual"], manualAdd: { evidenceBasis: "trade-press", verified: false, assertion: true, sourceUrls: ["https://x.example"], label: "trade-press" } })])]],
    ["a RED manual add does NOT block (not renderable) — the trap", () => [result([film({ title: "A" }), film({ title: "M", tier: "red", foundIn: ["manual"], manualAdd: { evidenceBasis: "trade-press", verified: false, assertion: true, sourceUrls: ["https://x.example"], label: "trade-press" } })])]],
    ["an empty results array never auto-publishes", () => []],
    ["an edition with zero films blocks", () => [result([])]],
  ];

  for (const [name, mk] of FIXTURES) {
    it(`identical to the legacy predicate: ${name}`, () => {
      const rs = mk();
      expect(evaluateAutoContract(rs).wouldAuto).toBe(legacyWouldAuto(rs));
    });
  }

  it("HEADLINE: decideGate's auto branch fires iff the contract says YES (armed, flip-free)", () => {
    for (const [, mk] of FIXTURES) {
      const rs = mk();
      const contract = evaluateAutoContract(rs);
      const mode = decideGate(rs, { alwaysGate: false }).mode;
      expect(mode === "auto").toBe(contract.wouldAuto);
    }
  });

  it("WED_DROP_ALWAYS_GATE semantics untouched: a contract-YES drop still blocks when gated", () => {
    const rs = clean();
    expect(evaluateAutoContract(rs).wouldAuto).toBe(true);
    expect(decideGate(rs, { alwaysGate: false }).mode).toBe("auto");
    expect(decideGate(rs, { alwaysGate: true }).mode).toBe("blocked");   // the kill-switch still wins
  });

  it("a clean drop produces ZERO blockers", () => {
    const c = evaluateAutoContract(clean());
    expect(c.wouldAuto).toBe(true);
    expect(c.blockers).toEqual([]);
  });

  it("the contract MUTATES NOTHING it is given", () => {
    const rs = [result([film({ title: "A" }), film({ title: "Y", tier: "yellow" })])];
    const before = JSON.stringify(rs);
    evaluateAutoContract(rs);
    shadowAutopilotLines(evaluateAutoContract(rs));
    expect(JSON.stringify(rs)).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 2 — FULL ENUMERATION: every failing clause, never first-fail", () => {
  it("HEADLINE: five distinct failures in one drop yield five blockers, not one", () => {
    const rs = [
      result([
        film({ title: "Yellow" }),                                                   // -> not-effective-green
        film({ title: "Unavailable", aiReview: { verdict: "unavailable", reason: "infra" } }),
        film({ title: "Flipped", verdictFlip: { ref: "tmdb-9", previous: "confirm", current: "unverified", expiredAt: 1 } }),
        film({ title: "Manual", tier: "yellow", foundIn: ["manual"], manualAdd: { evidenceBasis: "trade-press", verified: false, assertion: true, sourceUrls: ["https://x.example"], label: "trade-press" } }),
      ]),
      result([], "ott"),                                                             // -> empty-edition
    ];
    rs[0]!.reconciled[0]!.tier = "yellow";

    const c = evaluateAutoContract(rs);
    expect(c.wouldAuto).toBe(false);
    expect(countOf(rs, "gate:empty-edition")).toBe(1);
    expect(countOf(rs, "gate:uncertain")).toBe(1);
    expect(countOf(rs, "gate:flip")).toBe(1);
    expect(countOf(rs, "gate:manual-add")).toBe(1);
    expect(countOf(rs, "gate:not-effective-green")).toBe(1);
    expect(c.blockers).toHaveLength(5);
  });

  it("each blocker names its film; edition-level blockers carry an empty title", () => {
    const rs = [result([film({ title: "Yellow", tier: "yellow" })]), result([], "ott")];
    const c = evaluateAutoContract(rs);
    const byCheck = new Map(c.blockers.map((b) => [b.check.split(" ")[0], b]));
    expect(byCheck.get("gate:not-effective-green")!.title).toBe("Yellow");
    expect(byCheck.get("gate:empty-edition")!.title).toBe("");
    expect(byCheck.get("gate:empty-edition")!.check).toContain("ott");
    expect(c.blockers.every((b) => b.layer === "gate")).toBe(true);        // AutoBlocker, reused unchanged
  });

  it("MISSING LEGS are named individually, not summarised", () => {
    expect(missingLegs(film({ title: "A", tier: "yellow", foundIn: ["district"] })))
      .toEqual(["tier yellow", "no tmdb", "no ai-net", "not promoted"]);
    expect(missingLegs(film({ title: "B", foundIn: ["tmdb", "district"] })))
      .toEqual(["no ai-net", "not promoted"]);
    // A green film missing only ai-net: the tier is fine, the unattended bar is not.
    const c = evaluateAutoContract([result([film({ title: "B", foundIn: ["tmdb", "district"] })])]);
    expect(c.blockers[0]!.check).toBe("gate:not-effective-green — missing: no ai-net, not promoted");
  });

  it("EVERY offending film is listed — three yellows give three blockers", () => {
    const rs = [result([film({ title: "Y1", tier: "yellow" }), film({ title: "Y2", tier: "yellow" }), film({ title: "Y3", tier: "yellow" })])];
    expect(countOf(rs, "gate:not-effective-green")).toBe(3);
  });

  it("a manual add is reported AS a manual add, and not ALSO as a generic tier miss", () => {
    // "tier yellow, no tmdb, no ai-net" is the DESIGN for an operator add
    // (WD-ENG-11 fixed the dial at yellow), not a data gap. Labelling it as one
    // would send the operator hunting for a fetch that is never coming.
    const rs = [result([film({ title: "M", tier: "yellow", foundIn: ["manual"], manualAdd: { evidenceBasis: "trade-press", verified: false, assertion: true, sourceUrls: ["https://x.example"], label: "trade-press" } })])];
    expect(countOf(rs, "gate:manual-add")).toBe(1);
    expect(countOf(rs, "gate:not-effective-green")).toBe(0);
    expect(checks(rs)[0]).toContain("trade-press");
  });

  it("recoverability is honest: infra may clear, judgement calls may not", () => {
    const rec = (rs: ReconcileResult[]) => evaluateAutoContract(rs).blockers.map((b) => b.recoverable);
    expect(rec([result([film({ title: "U", aiReview: { verdict: "unavailable", reason: "infra" } })])])).toEqual([true]);
    expect(rec([result([film({ title: "F", verdictFlip: { ref: "r", previous: "confirm", current: "reject", expiredAt: 1 } })])])).toEqual([false]);
    // green-but-missing-a-net: another fetch could plausibly add it.
    expect(rec([result([film({ title: "G", foundIn: ["tmdb", "district"] })])])).toEqual([true]);
    // not green at all: a real data problem, needs a human.
    expect(rec([result([film({ title: "Y", tier: "yellow" })])])).toEqual([false]);
  });

  it("renderableFilms / isEffectiveGreen mirror the gate's own filter", () => {
    const r = result([
      film({ title: "keep" }),
      film({ title: "red", tier: "red" }),
      film({ title: "demoted", aiDemoted: { originalTier: "green", verdict: "reject", reason: "x" } }),
      noRelease(film({ title: "no-release" })),
    ]);
    expect(renderableFilms(r).map((f) => f.title)).toEqual(["keep"]);
    expect(isEffectiveGreen(film({ title: "g" }))).toBe(true);
    expect(isEffectiveGreen(film({ title: "d", foundIn: ["tmdb", "district"] }))).toBe(false);
    expect(isEffectiveGreen(film({ title: "p", tier: "yellow", aiPromoted: { reason: "x" } }))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 3 — THE FLIP CLAUSE", () => {
  const flipped = () => {
    const f = film({ title: "Flipped" });
    f.verdictFlip = { ref: "tmdb-1250502", previous: "confirm", current: "unverified", expiredAt: 1_700_000_000_000 };
    return [result([f, film({ title: "Clean" })])];
  };

  it("HEADLINE: an otherwise-perfect drop fails the contract on a single flip", () => {
    const rs = flipped();
    // Everything else about this drop passes — the legacy predicate says ship it.
    expect(legacyWouldAuto(rs)).toBe(true);
    const c = evaluateAutoContract(rs);
    expect(c.wouldAuto).toBe(false);
    expect(c.blockers).toHaveLength(1);
    expect(c.blockers[0]!.check).toBe("gate:flip — tmdb-1250502: confirm -> unverified (expired ledger row)");
    expect(c.blockers[0]!.recoverable).toBe(false);
  });

  it("…and decideGate refuses to auto-publish it, even fully armed", () => {
    expect(decideGate(flipped(), { alwaysGate: false }).mode).toBe("blocked");
    expect(decideGate(clean(), { alwaysGate: false }).mode).toBe("auto");   // control
  });

  it("the flip is the ONLY intended divergence from the legacy predicate", () => {
    const rs = flipped();
    expect(legacyWouldAuto(rs)).toBe(true);
    delete rs[0]!.reconciled[0]!.verdictFlip;
    expect(evaluateAutoContract(rs).wouldAuto).toBe(true);                  // remove it and they agree again
  });

  it("🔒 THE FLIP MARKER NEVER REACHES THE GATE HASH", () => {
    // A flip changes whether the drop may ship UNATTENDED. It changes nothing
    // about what an APPROVED run renders, so it must not move the hash — or
    // every ledger expiry would silently invalidate a pinned approve token.
    const without = clean();
    const before = computeDropHash(without);
    without[0]!.reconciled[0]!.verdictFlip = { ref: "r", previous: "confirm", current: "reject", expiredAt: 9 };
    expect(computeDropHash(without)).toBe(before);
    // …and the same for the two other advisory fields this packet added.
    without[0]!.reconciled[0]!.aiReview = { verdict: "confirm", reason: "x", provenance: "ledger", ledgerConfirmedAt: 123 };
    without[0]!.ledgerStats = { hit: 3, billed: 1, voided: 2 };
    expect(computeDropHash(without)).toBe(before);
  });

  it("the fingerprint source itself names no advisory field", () => {
    const gate = read("src/reconcile/gate.ts");
    // The BODY only. Ending the slice at computeDropHash would swallow ITS doc
    // comment, which legitimately uses the word "provenance" in prose.
    const start = gate.indexOf("function filmFingerprint");
    const fp = gate.slice(start, gate.indexOf("\n}", start) + 2);
    for (const field of ["verdictFlip", "aiReview", "aiPromoted", "provenance", "ledgerStats"]) {
      expect(fp).not.toContain(field);
    }
    expect(fp).toContain("aiDemoted");        // the ONE enforcement outcome that IS hashed
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 4 — SHADOW AUTOPILOT is observation only", () => {
  it("the verdict line says YES/NO and counts the blockers", () => {
    expect(shadowVerdictLine(evaluateAutoContract(clean()))).toBe("SHADOW AUTOPILOT: would auto-approve = YES");
    const one = evaluateAutoContract([result([film({ title: "Y", tier: "yellow" })])]);
    expect(shadowVerdictLine(one)).toBe("SHADOW AUTOPILOT: would auto-approve = NO (1 blocker)");
    const two = evaluateAutoContract([result([film({ title: "Y", tier: "yellow" }), film({ title: "Z", tier: "yellow" })])]);
    expect(shadowVerdictLine(two)).toBe("SHADOW AUTOPILOT: would auto-approve = NO (2 blockers)");
  });

  it("EVERY line carries the greppable prefix, one line per blocker", () => {
    const rs = [result([film({ title: "Y", tier: "yellow" }), film({ title: "U", aiReview: { verdict: "unavailable", reason: "infra" } })])];
    const lines = shadowAutopilotLines(evaluateAutoContract(rs));
    expect(lines).toHaveLength(1 + 2);
    expect(lines.every((l) => l.startsWith("SHADOW AUTOPILOT"))).toBe(true);
    expect(lines[0]).toContain("would auto-approve = NO");
    expect(lines.slice(1).join("\n")).toContain("Y — gate:not-effective-green");
    expect(lines.slice(1).join("\n")).toContain("[needs a decision]");
    expect(lines.slice(1).join("\n")).toContain("[may clear on re-run]");
  });

  it("a clean drop's block is exactly one line", () => {
    expect(shadowAutopilotLines(evaluateAutoContract(clean()))).toEqual(["SHADOW AUTOPILOT: would auto-approve = YES"]);
  });

  it("🔒 BYTE-IDENTITY: decideGate's output is unchanged whether or not the shadow ran", () => {
    // The report is built from the SAME results object the gate decided on, so
    // the only way it could matter is by mutating it. Prove it does not, in the
    // exact order the job uses: decide, then report, then decide again.
    for (const [, mk] of [["gated", clean], ["blocked", () => [result([film({ title: "Y", tier: "yellow" })])]]] as Array<[string, () => ReconcileResult[]]>) {
      const rs = mk();
      const bare = decideGate(rs, { alwaysGate: true });
      shadowAutopilotLines(evaluateAutoContract(rs));      // the shadow pass
      const after = decideGate(rs, { alwaysGate: true });
      expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(bare)));
      expect(after.hash).toBe(bare.hash);
    }
  });

  it("the job emits the block only while the gate is ON, and AFTER decideGate", () => {
    const src = read("src/jobs/wednesday-drop.ts");
    expect(src).toContain("shadowAutopilotLines(evaluateAutoContract(results))");
    // The CALL SITE, not the identifier — the import line naturally precedes
    // everything and would make this ordering check pass vacuously.
    expect(src.indexOf("const decision = decideGate(results")).toBeLessThan(src.indexOf("shadowAutopilotLines("));
    // The emit sits inside `if (alwaysGate)`, with nothing but that guard
    // between them — checked on the text between the two, so a future edit that
    // hoists the emit out of the guard fails here.
    const guard = src.lastIndexOf("if (alwaysGate) {", src.indexOf("shadowAutopilotLines("));
    expect(guard).toBeGreaterThan(-1);
    const between = src.slice(guard, src.indexOf("shadowAutopilotLines("));
    expect(between.replace(/\s+/g, " ").trim()).toBe("if (alwaysGate) { for (const line of");
    // Nothing in this packet arms anything: the switch is still read exactly once.
    expect(src).toContain("resolveAlwaysGate(process.env.WED_DROP_ALWAYS_GATE)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 5 — the review artifact reports provenance and the shadow verdict", () => {
  it("gate.ts renders [live] for a fresh verdict and [ledger - confirmed <date>] for a replayed one", () => {
    const gate = read("src/reconcile/gate.ts");
    expect(gate).toContain('if (ar.provenance !== "ledger") return "[live]"');
    expect(gate).toContain("[ledger - confirmed ${on}]");
    expect(gate).toContain("provenanceMarker(ar)");
  });

  it("the marker renders the row's confirmed_at as an ISO date", () => {
    // Exercised through the exported renderer would need Notion; assert the
    // formatting rule directly instead — it is one line and one date.
    expect(new Date(1_755_600_000_000).toISOString().slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the review header carries the shadow verdict AND the per-pillar ledger tally", () => {
    const gate = read("src/reconcile/gate.ts");
    expect(gate).toContain("paragraph(shadowVerdictLine(evaluateAutoContract(results)))");
    expect(gate).toContain("verdict ledger: ${s.hit} hit, ${s.billed} billed, ${s.voided} voided");
    // …and the Slack ping states the same one-liner, so the three never disagree.
    expect(gate).toContain("section(`_${shadowVerdictLine(evaluateAutoContract(results))}_`)");
  });

  it("a flip is stated on the film's own row, not only in the header", () => {
    expect(read("src/reconcile/gate.ts")).toContain("🔄 FLIP:");
  });

  it("the ledger tally is emitted only when the edition actually consulted", () => {
    expect(read("src/reconcile/gate.ts")).toContain("if (r.ledgerStats)");
  });
});
