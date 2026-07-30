// src/shared/redact.ts
// SINK-LEVEL SECRET REDACTION — the one place a secret is scrubbed out of a
// string, for every log line and every outbound Slack/Notion payload.
//
// WHY SINKS AND NOT SOURCES. The leak that provoked this printed the MDBList
// apikey= URL three times in one run. The mechanism is generic: ofetch throws a
// FetchError whose .message is `[GET] "<full resolved URL>": <status>`, and any
// client that carries its key in a QUERY PARAMETER re-emits that key the moment
// a caller logs err.message. There are 15+ such call sites (TMDb ×11, OMDb,
// MDBList, plus the Slack webhook URL, which is itself a bearer secret). Fixing
// them one at a time does not hold: the pattern regrows with the next client.
// So the filter lives at the sink, where every string must pass regardless of
// which source produced it.
//
// TWO LAYERS, IN THIS ORDER — and the order is the design:
//
//   1. VALUES are the DEFENCE. Every secret the process actually holds is
//      REGISTERED by name, and each registered value is replaced with
//      <REDACTED:NAME>. This is exact, has zero false positives, and — because
//      the marker names the variable — it tells the operator WHICH key leaked,
//      which is the single most useful fact in the line.
//
//   2. PATTERNS are the BACKSTOP. They catch a secret nobody registered: a key
//      added to a new client and not wired into registerSecrets, a third-party
//      bearer token echoed inside an error. Patterns cannot name the key, so
//      they emit a generic ***. They are deliberately second: a pattern that
//      ran first would collapse `apikey=SECRET` to `apikey=***` and rob layer 1
//      of the chance to say MDBLIST_API_KEY. Every pattern therefore carries a
//      (?!<REDACTED:) guard so it never re-scrubs — and never un-names — a
//      value layer 1 already handled.
//
// REGISTRATION, NOT IMPORT. This module imports NOTHING. In particular the
// logger must never import config (config → logger is the direction that
// exists), so config.ts pushes its parsed values in via registerSecrets the
// moment its safeParse succeeds. That keeps the dependency one-directional and
// leaves this module trivially unit-testable with no environment at all.

/**
 * Below this length a "secret" is not a secret, it is a word. Registering a
 * 4-char value would rewrite every innocent occurrence of "true" or a short
 * bucket name across every log line in the run.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * value → NAME. Keyed by VALUE (not by name) for two reasons: two variables
 * holding the SAME value collapse to one replacement instead of fighting, and a
 * ROTATED key stays covered — re-registering TMDB_API_KEY with a new value adds
 * the new value without forgetting the old one, so a line captured before the
 * rotation is still scrubbed.
 */
const registry = new Map<string, string>();

/** Memoised longest-value-first view. Invalidated by every registration. */
let ordered: { value: string; name: string }[] | null = null;

/**
 * Register secret values by name. Called by config.ts immediately after its
 * schema parse succeeds. Safe to call repeatedly and in any order.
 *
 * SKIPPED: undefined/non-string values (an unset optional key), and any value
 * shorter than MIN_SECRET_LENGTH. First name registered for a given value wins,
 * so the emitted marker is deterministic run to run.
 */
export function registerSecrets(pairs: Record<string, string | undefined>): void {
  for (const [name, raw] of Object.entries(pairs)) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length < MIN_SECRET_LENGTH) continue;
    if (registry.has(value)) continue;
    registry.set(value, name);
  }
  ordered = null;
}

/** Test seam — forget every registered value between cases. */
export function __resetSecretRegistry(): void {
  registry.clear();
  ordered = null;
}

/** The names currently registered, sorted. For diagnostics; never the values. */
export function registeredSecretNames(): string[] {
  return [...new Set(registry.values())].sort();
}

/**
 * LONGEST VALUE FIRST. If two registered secrets overlap — one value a prefix
 * or substring of another, which happens with a webhook URL and its path — then
 * replacing the shorter one first would leave the longer one half-redacted, and
 * a half-redacted secret is a leaked secret. Descending length makes the
 * containing value win.
 */
function byLongestValueFirst(): { value: string; name: string }[] {
  if (ordered === null) {
    ordered = [...registry.entries()]
      .map(([value, name]) => ({ value, name }))
      .sort((a, b) => b.value.length - a.value.length);
  }
  return ordered;
}

/**
 * The BACKSTOP patterns (layer 2). Shape lifted from the one piece of redaction
 * that already existed in this repo — research/sources/youtube.ts — and widened.
 *
 * Each carries (?!<REDACTED:) / (?!\*\*\*) so applying redactSecrets twice is a
 * no-op, and so a value layer 1 already NAMED is never downgraded to ***.
 *
 * Two deliberate refinements over a bare \S+ tail:
 *   - the header rule runs to end-of-line, not to the first space, because the
 *     real shape is `Authorization: Bearer <key>` — \S+ would match only
 *     "Bearer" and leave the key sitting in the log.
 *   - the character classes exclude quotes so a redacted URL inside a quoted
 *     error message keeps its closing quote and the line stays readable.
 */
const PATTERNS: { re: RegExp; to: string }[] = [
  // key-in-query-string — the Class A shape (TMDb api_key, OMDb/MDBList apikey).
  { re: /(api_key|apikey|apiKey|key|token)=(?!<REDACTED:)[^&"'\s]+/gi, to: "$1=***" },
  // The Slack incoming-webhook URL is a bearer credential: the path IS the auth.
  { re: /hooks\.slack\.com\/services\/[^\s"']+/gi, to: "hooks.slack.com/<REDACTED>" },
  // Header echoed into an error or a debug dump, bare or JSON-quoted.
  { re: /(Authorization|X-Api-Key)"?\s*:\s*"?(?!\*\*\*)[^\r\n"']+/gi, to: "$1: ***" },
];

/**
 * VALUES ONLY (layer 1). Use this for a field that must remain STRUCTURALLY
 * VALID after scrubbing — a Notion `link.url`, an image block's src. A
 * registered secret in such a field is still removed, but a benign third-party
 * URL carrying an unrelated `?token=` tracking parameter is left intact, so a
 * review page's source links keep working and Notion never rejects the block.
 */
export function redactSecretValues(s: string): string {
  if (s.length === 0) return s;
  let out = s;
  for (const { value, name } of byLongestValueFirst()) {
    // split/join is a LITERAL global replace — no regex escaping to get wrong on
    // a value containing ., +, ?, / or $, all of which appear in real keys.
    if (out.includes(value)) out = out.split(value).join(`<REDACTED:${name}>`);
  }
  return out;
}

/**
 * FULL SCRUB — values then patterns. This is the default for prose: every log
 * message, every log data payload, and every free-text string leaving the
 * process for Slack or Notion.
 */
export function redactSecrets(s: string): string {
  if (s.length === 0) return s;
  let out = redactSecretValues(s);
  for (const { re, to } of PATTERNS) out = out.replace(re, to);
  return out;
}
