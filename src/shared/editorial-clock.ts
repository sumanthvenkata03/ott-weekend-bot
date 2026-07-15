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
