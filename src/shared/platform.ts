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
