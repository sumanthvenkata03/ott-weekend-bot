// WED_DROP_ALWAYS_GATE — the autonomy kill-switch default (ships dark).
//
// wednesday-drop.ts pulls config.ts transitively, which process.exit()s on a
// missing key, so config is mocked to keep this import-safe with keys blanked —
// the same guard ott-candidates.test.ts uses. Only the pure resolver is exercised.
import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../shared/config.js", () => ({
  config: { NOTION_TOKEN: "test", TMDB_API_KEY: "test", OMDB_API_KEY: "test", MDBLIST_API_KEY: "" },
}));

// wednesday-drop.ts calls main() BARE at module scope (the landmine this file's
// header describes), so the import below runs a real job — and since WD-ENG-01
// Part 4 that job starts a run log. Point the tee at the OS temp dir BEFORE the
// import so a test suite never writes run logs into the developer's output/runs/.
// This exercises startRunLog's documented operator-override branch.
process.env.TBSI_LOG_FILE = join(tmpdir(), `tbsi-test-${process.pid}.log`);

const { resolveAlwaysGate } = await import("../wednesday-drop.js");

describe("resolveAlwaysGate — gate is ON unless explicitly disarmed", () => {
  it("DEFAULT (unset) ⇒ gate ON — autonomy ships dark", () => {
    expect(resolveAlwaysGate(undefined)).toBe(true);
  });

  it('explicit "false" ⇒ gate OFF (operator disarmed)', () => {
    expect(resolveAlwaysGate("false")).toBe(false);
  });

  it('explicit "0" ⇒ gate OFF', () => {
    expect(resolveAlwaysGate("0")).toBe(false);
  });

  it('explicit "true" ⇒ gate ON', () => {
    expect(resolveAlwaysGate("true")).toBe(true);
  });

  it('explicit "1" ⇒ gate ON', () => {
    expect(resolveAlwaysGate("1")).toBe(true);
  });

  it("empty string and whitespace ⇒ gate ON (unset-equivalent)", () => {
    expect(resolveAlwaysGate("")).toBe(true);
    expect(resolveAlwaysGate("   ")).toBe(true);
  });

  it("disarm is case- and whitespace-insensitive", () => {
    expect(resolveAlwaysGate("FALSE")).toBe(false);
    expect(resolveAlwaysGate(" 0 ")).toBe(false);
  });

  it("any other value keeps the gate ON — only false/0 disarm", () => {
    for (const v of ["yes", "no", "off", "on", "2", "gate"]) {
      expect(resolveAlwaysGate(v)).toBe(true);
    }
  });
});
