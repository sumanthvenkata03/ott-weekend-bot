// src/shared/platform.ts
// Pure press-name → Platform enum normalizer. Shared by the discovery candidate
// surface (candidates.ts) and the pure reconcile core (reconcile.ts) so BOTH
// press-ingest paths map a free-text platform name the SAME way. Kept
// dependency-free (type-only import) so the network-free reconcile core can
// import it without pulling in discovery/ingestion code.

import type { Platform } from "./types.js";

// Press platform name (free text from the AI net) → our Platform enum. An
// unknown name is omitted (platform stays []) — never coerced to a wrong value.
export const PLATFORM_NAMES: Record<string, Platform> = {
  "netflix": "Netflix",
  "prime video": "Prime Video", "amazon prime video": "Prime Video", "amazon video": "Prime Video",
  "jiohotstar": "JioHotstar", "jio hotstar": "JioHotstar", "hotstar": "JioHotstar",
  "disney+ hotstar": "JioHotstar", "disney plus hotstar": "JioHotstar",
  "aha": "Aha",
  "sonyliv": "SonyLIV", "sony liv": "SonyLIV",
  "zee5": "ZEE5",
  "sun nxt": "Sun NXT",
};

/**
 * Map a SINGLE press platform name to the Platform enum; undefined if unknown.
 * Deliberately strict: a comma-joined string or an unmapped display variant
 * returns undefined (caller leaves platform []) rather than coercing a wrong or
 * malformed value into release.platform — which the renderer would turn into a
 * missing logo / brass fallback.
 */
export function toPlatform(s: string | undefined): Platform | undefined {
  return s ? PLATFORM_NAMES[s.trim().toLowerCase()] : undefined;
}

/**
 * The Platform union as a RUNTIME list, in declaration order.
 *
 * PLATFORM_NAMES above is an ALIAS map for press free-text ("amazon prime
 * video" → "Prime Video") and covers only the platforms the AI net was seen
 * spelling loosely — it is missing ManoramaMAX, Lionsgate Play, Hoichoi, Apple
 * TV+, MUBI, Chaupal, Planet Marathi and Other. It is therefore the wrong tool
 * for asking "is this string already a canonical Platform?", which is what the
 * confirmation seam needs: `toPlatform("ManoramaMAX")` is undefined even though
 * ManoramaMAX is a full member of the union.
 *
 * Kept in sync with the union in BOTH directions at compile time — `satisfies`
 * rejects a value that is not a Platform, and the Exclude check below fails to
 * compile if the union gains a member that is not listed here. Neither can drift.
 */
export const PLATFORMS = [
  "Netflix", "Prime Video", "JioHotstar", "Aha", "SonyLIV",
  "ZEE5", "Sun NXT", "ManoramaMAX", "Hoichoi", "Lionsgate Play",
  "Apple TV+", "MUBI", "Chaupal", "Planet Marathi", "Other",
] as const satisfies readonly Platform[];

// Compile-time exhaustiveness guard. If a new Platform is added to the union
// without being added to PLATFORMS, `Exclude<…>` stops being `never` and this
// line fails to compile. Deliberately a type-level assertion with no runtime cost.
type UnlistedPlatform = Exclude<Platform, (typeof PLATFORMS)[number]>;
const _platformsAreExhaustive: UnlistedPlatform extends never ? true : never = true;
void _platformsAreExhaustive;

const PLATFORM_SET: ReadonlySet<string> = new Set<string>(PLATFORMS);

/**
 * EXACT-SPELLING membership: is this string already a canonical Platform?
 *
 * Case- and alias-SENSITIVE on purpose. The seam that uses this writes straight
 * into release.platform, which drives the card's logo chip and the landing
 * verifier; a near-miss coerced to a neighbour would ship the wrong brand mark.
 * A string that does not match exactly is reported to the caller so it can warn,
 * which is strictly better than a silent guess.
 */
export function asExactPlatform(s: string | undefined): Platform | undefined {
  const t = s?.trim();
  return t && PLATFORM_SET.has(t) ? (t as Platform) : undefined;
}
