// gate-shared.test.ts — Step 4 anchors:
//  1. computeDropHash over a FIXED two-edition set hashes to a PINNED value. The
//     pillar widen (WedDropEdition→string) + Wednesday refactor are value-stable,
//     so this hash MUST NOT change — it's what keeps existing --approve tokens valid.
//  2. writeReview is parameterized: WED_DROP_LABELS reproduces the EXACT Wednesday
//     strings; a custom GateLabels yields a generic "{Pillar} — REVIEW".
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ createArgs: undefined as any, appendCalls: [] as any[] }));
vi.mock("@notionhq/client", () => ({
  // Must be constructable (gate.ts does `new Client(...)` at module load) — a
  // class, not an arrow vi.fn (arrows can't be `new`ed).
  Client: class {
    pages = { create: async (a: any) => { h.createArgs = a; return { id: "page1", url: "https://notion.example/page1" }; } };
    blocks = { children: { append: async (a: any) => { h.appendCalls.push(a); } } };
  },
}));
vi.mock("ofetch", () => ({ ofetch: vi.fn(async () => ({})) }));
vi.mock("../../shared/config.js", () => ({
  config: { NOTION_TOKEN: "x", NOTION_RELEASES_DB_ID: "db", SLACK_WEBHOOK_URL: "" }, // empty → Slack skipped
}));

import { computeDropHash, writeReview, WED_DROP_LABELS, type GateLabels } from "../gate.js";
import type { ReconciledFilm, ReconcileResult } from "../types.js";

function rf(p: Partial<ReconciledFilm> & { title: string; pillar: string }): ReconciledFilm {
  return { language: "Tamil", dateSource: "tmdb", foundIn: ["tmdb"], status: "confirmed", tier: "green", reasons: [], ...p };
}
function result(pillar: string, films: ReconciledFilm[]): ReconcileResult {
  return {
    pillar,
    window: { start: "2026-06-22", end: "2026-06-28" },
    reconciled: films,
    rejected: [],
    counts: { total: films.length, green: films.filter((f) => f.tier === "green").length, yellow: films.filter((f) => f.tier === "yellow").length, red: 0, addedByAiNet: 0, flagged: 0 },
  };
}

// Fixed two-edition fixture — the regression anchor.
const FIXED: ReconcileResult[] = [
  result("theatrical", [rf({ title: "T1", pillar: "theatrical", tmdbId: 11, tier: "green", date: "2026-06-26", dateSource: "tmdb", foundIn: ["tmdb", "ai-net"], status: "confirmed" })]),
  result("ott", [rf({ title: "O1", pillar: "ott", tmdbId: 22, tier: "yellow", date: "2026-06-25", dateSource: "press", foundIn: ["ai-net"], status: "confirmed" })]),
];

describe("computeDropHash — value-stable regression anchor", () => {
  it("🔒 hashes the fixed two-edition set to the PINNED value (widen + refactor must not change it)", () => {
    expect(computeDropHash(FIXED)).toBe("92bcfb40772d");
  });
});

describe("writeReview — parameterized labels", () => {
  beforeEach(() => { h.createArgs = undefined; h.appendCalls = []; });

  it("WED_DROP_LABELS → EXACT Wednesday title / Pillar / approve / edition headings", async () => {
    await writeReview(FIXED, "abc123", WED_DROP_LABELS);
    const props = h.createArgs.properties;
    expect(props.Name.title[0].text.content).toBe("Wed Drop — REVIEW — 2026-06-22 → 2026-06-28 — abc123");
    expect(props.Pillar.select.name).toBe("Wed Drop");
    const childrenJson = JSON.stringify(h.createArgs.children);
    expect(childrenJson).toContain("npm run job:wednesday -- --approve abc123");
    expect(childrenJson).toContain("Wed Drop · In Theaters");
    expect(childrenJson).toContain("Wed Drop · Now Streaming");
  });

  it("custom GateLabels → generic '{Pillar} — REVIEW' (proves parameterization)", async () => {
    const SUN_LABELS: GateLabels = {
      reviewTitle: "Sun Spotlight — REVIEW",
      approveCommand: "npm run job:sunday -- --approve",
      notionPillar: "Sun Spotlight",
      labelFor: (p) => ({ notionTitle: `Spotlight (${p})`, slackLabel: p }),
    };
    await writeReview([result("sun-spotlight", [rf({ title: "S1", pillar: "sun-spotlight", tmdbId: 5 })])], "xyz999", SUN_LABELS);
    const props = h.createArgs.properties;
    expect(props.Name.title[0].text.content).toBe("Sun Spotlight — REVIEW — 2026-06-22 → 2026-06-28 — xyz999");
    expect(props.Pillar.select.name).toBe("Sun Spotlight");
    expect(JSON.stringify(h.createArgs.children)).toContain("npm run job:sunday -- --approve xyz999");
  });
});
