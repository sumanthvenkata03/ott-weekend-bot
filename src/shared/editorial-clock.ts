// src/shared/editorial-clock.ts
// THE EDITORIAL CLOCK — the single source of truth for turning a real-world
// instant ("now") into the IST *calendar date* every pillar is authored, stamped,
// numbered, and windowed against.
//
// WHY: the bot runs on GitHub Actions cron (UTC) and on dev machines in assorted
// zones. India Standard Time is a FIXED UTC+5:30 — it has never observed DST, so
// no tz library is needed (and none is used; date-fns-tz is deliberately absent).
// The old code derived "today" with date-fns `format()` / `startOfWeek()` (LOCAL
// time) or `.toISOString()` (UTC). Both drift from IST near midnight: a UTC/EDT
// runner in the IST-midnight window would stamp/number the WRONG editorial day.
//
// ── THE TRAP (do not remove this comment) ─────────────────────────────────────
// The anchor Date returned by editorialDateUTC() is pinned to 00:00:00Z of the
// IST calendar date. It must NEVER pass through *local* rendering of any kind:
//   - NOT date-fns format()  (renders in the machine's local zone)
//   - NOT .getDate()/.getMonth()/.getFullYear()/.getDay()  (local getters)
// Any of those re-introduces the exact bug this module exists to kill. EVERY
// string here is built from UTC fields (getUTC*/toISOString) INSIDE this module,
// and call sites consume the returned STRINGS/PARTS — they never re-format the
// anchor Date locally. Derived calendar dates (window edges) are produced by UTC
// arithmetic (setUTCDate) on the anchor and stamped with utcStamp().

import { log } from "./logger.js";

/** IST is a fixed UTC+5:30 — no DST has ever existed, so this offset is constant. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const MONTH_ABBR = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Full month names — the editorial label form (editorialMonthLabel). */
const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
] as const;

const DOW_NAMES = [
	"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * The anchor: a Date pinned to 00:00:00Z of the IST *calendar date* containing
 * `now`. Implemented by shifting the instant into IST (+5:30) and reading its UTC
 * fields, then rebuilding a pure-midnight-UTC Date from them. The result is safe
 * to do UTC arithmetic on (setUTCDate) and to stamp with utcStamp(); it is NEVER
 * safe to feed to a local formatter/getter (see THE TRAP above).
 */
export function editorialDateUTC(now: Date = new Date()): Date {
	const shifted = new Date(now.getTime() + IST_OFFSET_MS);
	return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/**
 * "yyyy-MM-dd" of any anchor-midnight-UTC Date, built from UTC fields (NOT
 * toISOString-parsing-agnostic — this reads the fields directly so a non-midnight
 * Date still stamps by its UTC calendar date). Used for BOTH "today" (via
 * editorialTodayStamp) and derived window edges produced by UTC arithmetic.
 */
export function utcStamp(d: Date): string {
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** "yyyy-MM-dd" of the IST calendar date containing `now`. */
export function editorialTodayStamp(now: Date = new Date()): string {
	return utcStamp(editorialDateUTC(now));
}

/**
 * Structured parts of the IST calendar date. `dowUTCstyle` is 0=Sun … 6=Sat
 * (getUTCDay of the anchor), matching the convention used by issue-number.ts and
 * consumed by warnIfNotPostingDay.
 */
export function editorialDateParts(now: Date = new Date()): {
	y: number; m: number; d: number; dowUTCstyle: number;
} {
	const d = editorialDateUTC(now);
	return {
		y: d.getUTCFullYear(),
		m: d.getUTCMonth() + 1,
		d: d.getUTCDate(),
		dowUTCstyle: d.getUTCDay(),
	};
}

/** "dd·MM·yy" of the IST calendar date (masthead issue date). Manual UTC table. */
export function editorialDisplayDate(now: Date = new Date()): string {
	const { y, m, d } = editorialDateParts(now);
	return `${pad2(d)}·${pad2(m)}·${pad2(y % 100)}`;
}

/**
 * "MMM D · YYYY" UPPERCASED, no zero-padded day (e.g. "JUL 15 · 2026"), of the IST
 * calendar date (Sat Verdict cover). Month name comes from the manual UTC table —
 * NEVER a formatter on the anchor.
 */
export function editorialCoverDate(now: Date = new Date()): string {
	const { y, m, d } = editorialDateParts(now);
	return `${MONTH_ABBR[m - 1]} ${d} · ${y}`.toUpperCase();
}

// ── THE ONE PIXEL DATE FORMAT ────────────────────────────────────────────────
//
// Every date a follower SEES renders as "MMM D · YYYY" uppercased — the shape
// editorialCoverDate() already produced for the Sat Verdict cover. Before this,
// pixels carried five different formats (dd·mm, dd·mm·yy, MMM D · YYYY, a
// free-form range, and the raw yyyy-MM-dd machine stamp). Machine formats stay
// in the machine room: console, Slack, R2 paths, zip names, ledger.
//
// These two take an ALREADY-IST "yyyy-MM-dd" STAMP rather than an instant,
// because the pixel callers hold stamps (editorialTodayStamp output, window
// edges) — not a `now`. Shifting such a stamp through editorialDateUTC again
// would apply IST twice and slide the date. They therefore read the stamp's
// fields directly, which keeps THE TRAP satisfied: no local getter, no
// formatter, no Date parsing of any kind.

/** Split a "yyyy-MM-dd" stamp into numeric parts. Null on anything malformed. */
function stampParts(stamp: string): { y: number; m: number; d: number } | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(stamp ?? "").trim());
	if (!match) return null;
	const y = Number(match[1]);
	const m = Number(match[2]);
	const d = Number(match[3]);
	if (m < 1 || m > 12 || d < 1 || d > 31) return null;
	return { y, m, d };
}

/**
 * "MMM D · YYYY" UPPERCASED from an IST "yyyy-MM-dd" stamp — e.g. "2026-07-15"
 * → "JUL 15 · 2026". Returns "" for a malformed stamp so a bad value renders as
 * nothing rather than as the word "Invalid Date" on a published card.
 */
export function editorialCoverDateOf(stamp: string): string {
	const p = stampParts(stamp);
	if (!p) return "";
	return `${MONTH_ABBR[p.m - 1]} ${p.d} · ${p.y}`.toUpperCase();
}

/**
 * Range form from two IST stamps — "JUN 17 — JUN 21 · 2026". The year is
 * factored out and printed ONCE when both ends share it; across a year boundary
 * both ends carry their own ("DEC 30 · 2026 — JAN 2 · 2027") because dropping
 * either year there would be ambiguous. Falls back to whichever end is valid if
 * the other is malformed, and to "" if neither is.
 */
export function editorialCoverRange(startStamp: string, endStamp: string): string {
	const a = stampParts(startStamp);
	const b = stampParts(endStamp);
	if (!a || !b) return editorialCoverDateOf(startStamp) || editorialCoverDateOf(endStamp);
	if (a.y !== b.y) {
		return `${editorialCoverDateOf(startStamp)} — ${editorialCoverDateOf(endStamp)}`;
	}
	const left = `${MONTH_ABBR[a.m - 1]} ${a.d}`.toUpperCase();
	const right = `${MONTH_ABBR[b.m - 1]} ${b.d}`.toUpperCase();
	return `${left} — ${right} · ${a.y}`;
}

/**
 * "MMMM yyyy" from an IST "yyyy-MM-dd" stamp — e.g. "2026-07-22" → "July 2026".
 * Mixed case, NOT uppercased: this is an editorial label ("Catch-Up · July
 * 2026"), not the pixel date stamp.
 *
 * Exists so no caller has to reach for date-fns `format(parseISO(stamp), …)`,
 * which is a local-time round-trip. That particular round-trip is lossless for a
 * DATE-ONLY string (parseISO builds local midnight, format reads local fields —
 * they cancel), so replacing it fixes no live drift. What it fixes is the
 * PATTERN: the same two calls applied to the anchor Date, or to a stamp that
 * ever gains a time component, DO drift, and THE TRAP exists precisely so no one
 * has to re-derive which of those cases is safe. Reads the stamp's fields
 * directly and constructs no Date at all.
 */
export function editorialMonthLabel(stamp: string): string {
	const p = stampParts(stamp);
	if (!p) return "";
	return `${MONTH_NAMES[p.m - 1]} ${p.y}`;
}

/**
 * Warn-only guard: if the IST calendar day-of-week ≠ the pillar's posting day,
 * log a ⚠ line and CONTINUE. It NEVER blocks or throws — tuning runs and
 * deliberate off-day re-runs stay legal; stamps/numbers always follow IST.
 * expectedDow uses the 0=Sun … 6=Sat convention.
 */
export function warnIfNotPostingDay(expectedDow: number, pillarLabel: string, now: Date = new Date()): void {
	const { dowUTCstyle } = editorialDateParts(now);
	if (dowUTCstyle !== expectedDow) {
		// R4 copy. The leading ⚠ from the spec is omitted here because log.warn
		// already prepends one — the rendered line reads "⚠ EDITORIAL CLOCK: …".
		log.warn(
			`EDITORIAL CLOCK: today is ${DOW_NAMES[dowUTCstyle]} in IST — ` +
			`${pillarLabel} posts ${DOW_NAMES[expectedDow]}. ` +
			`Stamps follow IST; proceed only if intentional.`
		);
	}
}
