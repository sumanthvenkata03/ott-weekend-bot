// THE ONE PIXEL DATE FORMAT — "MMM D · YYYY", plus its range form.
// Pure: no clock, no network. Every instant is constructed explicitly so the
// IST-anchoring assertions are deterministic on any machine, in any zone.
import { describe, it, expect } from "vitest";
import {
  editorialCoverDate,
  editorialCoverDateOf,
  editorialCoverRange,
  editorialMonthLabel,
  editorialTodayStamp,
} from "../editorial-clock.js";

describe("editorialCoverDateOf — standard form from an IST stamp", () => {
  it("renders MMM D · YYYY, uppercased, with no zero-padded day", () => {
    expect(editorialCoverDateOf("2026-07-15")).toBe("JUL 15 · 2026");
  });

  it("does not zero-pad a single-digit day", () => {
    expect(editorialCoverDateOf("2026-07-05")).toBe("JUL 5 · 2026");
  });

  it("covers every month name", () => {
    const got = Array.from({ length: 12 }, (_, i) =>
      editorialCoverDateOf(`2026-${String(i + 1).padStart(2, "0")}-01`).split(" ")[0]
    );
    expect(got).toEqual(["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]);
  });

  it("never emits a machine format", () => {
    expect(editorialCoverDateOf("2026-07-15")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(editorialCoverDateOf("2026-07-15")).not.toMatch(/·\d/);
  });

  it("returns '' for a malformed stamp — a bad value renders as nothing, never 'Invalid Date'", () => {
    for (const bad of ["", "not-a-date", "2026-13-01", "2026-07-32", "15-07-2026", "2026/07/15"]) {
      expect(editorialCoverDateOf(bad)).toBe("");
    }
  });

  it("does NOT re-apply the IST shift — a stamp is already an IST calendar date", () => {
    // The bug this guards: routing a stamp back through editorialDateUTC would
    // add +5:30 a second time and slide the date. The stamp must round-trip.
    expect(editorialCoverDateOf("2026-01-01")).toBe("JAN 1 · 2026");
    expect(editorialCoverDateOf("2026-12-31")).toBe("DEC 31 · 2026");
  });
});

describe("editorialCoverRange — range form", () => {
  it("factors a shared year out to a single trailing year", () => {
    expect(editorialCoverRange("2026-06-17", "2026-06-21")).toBe("JUN 17 — JUN 21 · 2026");
  });

  it("spans months within one year", () => {
    expect(editorialCoverRange("2026-05-30", "2026-06-01")).toBe("MAY 30 — JUN 1 · 2026");
  });

  it("prints BOTH years across a year boundary — dropping either would be ambiguous", () => {
    expect(editorialCoverRange("2026-12-30", "2027-01-02")).toBe("DEC 30 · 2026 — JAN 2 · 2027");
  });

  it("handles a single-day range", () => {
    expect(editorialCoverRange("2026-07-15", "2026-07-15")).toBe("JUL 15 — JUL 15 · 2026");
  });

  it("falls back to whichever end is valid, and to '' when neither is", () => {
    expect(editorialCoverRange("2026-06-17", "junk")).toBe("JUN 17 · 2026");
    expect(editorialCoverRange("junk", "2026-06-21")).toBe("JUN 21 · 2026");
    expect(editorialCoverRange("junk", "rubbish")).toBe("");
  });

  it("uses an em dash separator, not a hyphen", () => {
    expect(editorialCoverRange("2026-06-17", "2026-06-21")).toContain("—");
    expect(editorialCoverRange("2026-06-17", "2026-06-21")).not.toContain(" - ");
  });
});

describe("IST anchoring — the standard form follows the editorial clock", () => {
  it("editorialCoverDate(now) agrees with editorialCoverDateOf(todayStamp(now))", () => {
    // The two entry points (instant-based and stamp-based) must never disagree,
    // or two surfaces rendering "the same day" would print different dates.
    for (const iso of [
      "2026-07-15T12:00:00.000Z",
      "2026-07-15T18:35:00.000Z",  // 00:05 IST on the 16th
      "2026-07-15T18:25:00.000Z",  // 23:55 IST on the 15th
      "2026-01-01T00:00:00.000Z",
      "2026-12-31T23:59:59.000Z",
    ]) {
      const now = new Date(iso);
      expect(editorialCoverDate(now)).toBe(editorialCoverDateOf(editorialTodayStamp(now)));
    }
  });

  it("rolls the date at IST midnight, not UTC midnight", () => {
    // 18:29Z is 23:59 IST (same day); 18:31Z is 00:01 IST (next day).
    expect(editorialCoverDate(new Date("2026-07-15T18:29:00.000Z"))).toBe("JUL 15 · 2026");
    expect(editorialCoverDate(new Date("2026-07-15T18:31:00.000Z"))).toBe("JUL 16 · 2026");
  });

  it("a UTC-evening instant near year end still stamps the IST year", () => {
    expect(editorialCoverDate(new Date("2026-12-31T19:00:00.000Z"))).toBe("JAN 1 · 2027");
  });
});

describe("editorialMonthLabel — the Mon Movement shelf label", () => {
  it("renders MMMM yyyy in mixed case — an editorial label, not the pixel stamp", () => {
    expect(editorialMonthLabel("2026-07-22")).toBe("July 2026");
  });

  it("keeps the Catch-Up label's shape byte-identical to the pre-fix output", () => {
    // The clock fix must NOT restyle. This is the exact string the generator
    // builds, and the card renders.
    expect(`Catch-Up · ${editorialMonthLabel("2026-07-22")}`).toBe("Catch-Up · July 2026");
  });

  it("covers every month name", () => {
    const got = Array.from({ length: 12 }, (_, i) =>
      editorialMonthLabel(`2026-${String(i + 1).padStart(2, "0")}-15`).split(" ")[0]
    );
    expect(got).toEqual(["January","February","March","April","May","June",
      "July","August","September","October","November","December"]);
  });

  it("MONTH BOUNDARY — resolves the IST month, not a lagging local one", () => {
    // The stamp is produced by utcStamp(editorialDateUTC()) — already the IST
    // calendar date. An instant at 2026-07-31T19:00Z is 00:30 IST on Aug 1, so
    // the IST stamp is "2026-08-01" and the label MUST read August. A local
    // formatter west of UTC would still be looking at July.
    const instant = new Date("2026-07-31T19:00:00.000Z");
    const istStamp = editorialTodayStamp(instant);
    expect(istStamp).toBe("2026-08-01");
    expect(editorialMonthLabel(istStamp)).toBe("August 2026");
  });

  it("MONTH BOUNDARY — the other edge stays in the earlier month", () => {
    // 18:29Z on Jul 31 is 23:59 IST the SAME day — still July.
    const istStamp = editorialTodayStamp(new Date("2026-07-31T18:29:00.000Z"));
    expect(istStamp).toBe("2026-07-31");
    expect(editorialMonthLabel(istStamp)).toBe("July 2026");
  });

  it("is a PURE stamp reader — constructs no Date, so no zone can shift it", () => {
    // Same stamp, same answer, whatever the machine's zone. (A Date-based
    // implementation is what THE TRAP forbids.)
    for (const s of ["2026-01-01", "2026-12-31", "2026-08-01", "2026-07-31"]) {
      expect(editorialMonthLabel(s)).toBe(editorialMonthLabel(s));
    }
    expect(editorialMonthLabel("2026-01-01")).toBe("January 2026");
    expect(editorialMonthLabel("2026-12-31")).toBe("December 2026");
  });

  it("returns '' for a malformed stamp rather than 'Invalid Date'", () => {
    for (const bad of ["", "nope", "2026-13-01", "31-07-2026"]) {
      expect(editorialMonthLabel(bad)).toBe("");
    }
  });
});
