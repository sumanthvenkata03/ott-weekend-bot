// CHECKPOINT 2 — confirmAutoPublish, per-edition emptiness, and the R8 pings.
// Pure: no I/O, no clock, no env.
import { describe, it, expect } from "vitest";
import {
  applyAutoConfirmation,
  buildGreenPing,
  buildRedPing,
  checksInRow,
  confirmAutoPublish,
  editionOutcome,
} from "../autonomy.js";
import type { ManifestRow, PostManifest } from "../../shared/post-validator.js";

const row = (p: Partial<ManifestRow> & { title: string; status: ManifestRow["status"] }): ManifestRow => ({
  id: `tmdb-${p.title.length}`, bucket: "theatrical", qualifyingDate: "2026-07-24",
  dateField: "theatrical", window: "2026-07-22 -> 2026-07-26", reason: "", ...p,
});

const manifest = (rows: ManifestRow[]): PostManifest => ({
  pillar: "Wed Drop · In Theaters", issue: "026", builtAt: "2026-07-22T00:00:00.000Z", rows,
  passCount: rows.filter((r) => r.status === "pass").length,
  warnCount: rows.filter((r) => r.status === "warn").length,
  failCount: rows.filter((r) => r.status === "fail").length,
  ok: rows.every((r) => r.status !== "fail"),
});

describe("confirmAutoPublish — a clean contract confirms", () => {
  it("all-pass ⇒ auto stays true", () => {
    const c = confirmAutoPublish(manifest([row({ title: "A", status: "pass" }), row({ title: "B", status: "pass" })]));
    expect(c.auto).toBe(true);
    expect(c.blockers).toEqual([]);
    expect(c.reason).toContain("contract clean");
  });

  it("WARNS NEVER BLOCK — that is the whole point of the warn/fail split", () => {
    // The India Story (no poster, R5) and a discover-fallback date (R2) are both
    // warns. Neither may withhold a correct deck.
    const c = confirmAutoPublish(manifest([
      row({ title: "The India Story", status: "warn", reason: "contract:poster — no poster art" }),
      row({ title: "Chennai Love Story", status: "warn", reason: "contract:date-provenance — date: discover-fallback" }),
    ]));
    expect(c.auto).toBe(true);
    expect(c.reason).toContain("2 warn, non-blocking");
  });
});

describe("confirmAutoPublish — a failing contract blocks, and names why", () => {
  const failing = manifest([
    row({ title: "Ottam Thullal", status: "fail", reason: "contract:band-available-in — no audioLanguages.original" }),
    row({ title: "Jana Nayagan", status: "fail", reason: "contract:pre-release-seal — 2026-07-23 is after the edition date" }),
    row({ title: "Clean Film", status: "pass" }),
  ]);

  it("auto is withdrawn", () => {
    expect(confirmAutoPublish(failing).auto).toBe(false);
  });

  it("every blocker carries film, layer and the verbatim check", () => {
    const b = confirmAutoPublish(failing).blockers;
    expect(b).toHaveLength(2);
    expect(b[0]!.title).toBe("Ottam Thullal");
    expect(b[0]!.layer).toBe("contract");
    expect(b[0]!.check).toContain("contract:band-available-in");
  });

  it("recoverability is judged per check, not blanket", () => {
    const b = confirmAutoPublish(failing).blockers;
    // A missing TMDb field may fill in on a later fetch…
    expect(b.find((x) => x.title === "Ottam Thullal")!.recoverable).toBe(true);
    // …a pre-release date will not, until the film actually releases.
    expect(b.find((x) => x.title === "Jana Nayagan")!.recoverable).toBe(false);
  });

  it("a multi-check row yields one blocker per failing check", () => {
    const multi = manifest([row({
      title: "Broken", status: "fail",
      reason: "contract:band-released — no dates; contract:band-available-in — no languages",
    })]);
    expect(confirmAutoPublish(multi).blockers).toHaveLength(2);
  });
});

describe("checksInRow — splits a reason into its named checks", () => {
  it("returns [] for a clean row", () => {
    expect(checksInRow(row({ title: "A", status: "pass" }))).toEqual([]);
  });
  it("splits on the manifest's own separator", () => {
    expect(checksInRow(row({ title: "A", status: "fail", reason: "one; two; three" }))).toEqual(["one", "two", "three"]);
  });
});

describe("applyAutoConfirmation — DOWNGRADE-ONLY (R1 across the chain)", () => {
  const blocked = confirmAutoPublish(manifest([row({ title: "X", status: "fail", reason: "contract:band-released — x" })]));
  const clean = confirmAutoPublish(manifest([row({ title: "X", status: "pass" })]));

  it("auto + failing contract ⇒ blocked", () => {
    expect(applyAutoConfirmation("auto", blocked)).toBe("blocked");
  });

  it("auto + clean contract ⇒ auto", () => {
    expect(applyAutoConfirmation("auto", clean)).toBe("auto");
  });

  it("APPROVED is never downgraded — the human already looked", () => {
    expect(applyAutoConfirmation("approved", blocked)).toBe("approved");
  });

  it("blocked can NEVER be upgraded, even by a spotless contract", () => {
    expect(applyAutoConfirmation("blocked", clean)).toBe("blocked");
  });
});

describe("editionOutcome — R6, per-edition emptiness", () => {
  it("an empty edition SKIPS its post and is explicitly not a failure", () => {
    const o = editionOutcome("Now Streaming", 0);
    expect(o.kind).toBe("skip-empty");
    expect(o.note).toContain("SKIPPED");
    expect(o.note).toContain("does not gate the other edition");
  });

  it("a non-empty edition publishes", () => {
    expect(editionOutcome("In Theaters", 12).kind).toBe("publish");
  });

  it("the two editions are decided INDEPENDENTLY", () => {
    // The old everyEditionNonEmpty rule let one quiet edition gate the other's
    // perfectly good deck. These outcomes share no state.
    expect(editionOutcome("Now Streaming", 0).kind).toBe("skip-empty");
    expect(editionOutcome("In Theaters", 12).kind).toBe("publish");
  });
});

describe("R8 — the RED ping names the failure, not just the hash", () => {
  const ping = buildRedPing({
    edition: "In Theaters", hash: "7919c5fc9097", headSha: "6715a2f",
    blockers: [
      { title: "Ottam Thullal", layer: "contract", check: "contract:band-available-in — no audioLanguages", recoverable: true },
      { title: "card-11", layer: "audit", check: "audit:band-released — the band did not render", recoverable: false },
    ],
  });

  it("names each film and its failing check", () => {
    expect(ping).toContain("Ottam Thullal");
    expect(ping).toContain("contract:band-available-in");
    expect(ping).toContain("card-11");
    expect(ping).toContain("audit:band-released");
  });

  it("groups by the layer that refused", () => {
    expect(ping).toContain("Failing layer: contract");
    expect(ping).toContain("Failing layer: audit");
  });

  it("says whether each is worth a re-run or needs a decision", () => {
    expect(ping).toContain("may clear on re-run");
    expect(ping).toContain("needs a decision");
  });

  it("keeps the approve affordance and the code provenance", () => {
    expect(ping).toContain("--approve 7919c5fc9097");
    expect(ping).toContain("6715a2f");
  });

  it("states plainly that nothing shipped", () => {
    expect(ping).toContain("Nothing rendered or published");
  });
});

describe("R8 — the GREEN ping carries its own receipts", () => {
  const m = manifest([
    row({ title: "Clean Film", status: "pass" }),
    row({ title: "The India Story", status: "warn", reason: "contract:poster — no poster art" }),
  ]);
  const ping = buildGreenPing({
    edition: "In Theaters", headSha: "6715a2f", manifest: m, imageCount: 3,
    checklist: ["Download the deck zip", "Post the carousel in order", "Paste the caption"],
  });

  it("states that no human tapped anything", () => {
    expect(ping).toContain("auto-approved: all checks green");
    expect(ping).toContain("no human tap required");
  });

  it("summarises the manifest", () => {
    expect(ping).toContain("1 pass");
    expect(ping).toContain("1 warn");
    expect(ping).toContain("0 fail");
  });

  it("surfaces non-blocking warnings rather than hiding them", () => {
    expect(ping).toContain("Non-blocking warnings");
    expect(ping).toContain("The India Story");
  });

  it("carries the post-first checklist in order, and the HEAD sha", () => {
    expect(ping).toContain("1. Download the deck zip");
    expect(ping).toContain("3. Paste the caption");
    expect(ping).toContain("6715a2f");
  });
});
