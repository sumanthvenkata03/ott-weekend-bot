// src/shared/platform-logo.ts
// Platform display name → logo asset stem, plus "does that asset exist".
//
// One implementation, two consumers: the renderer (to decide whether to draw a
// chip at all) and the landing verifier (to warn that a platform has no mark).
// Before WD-042 the renderer's `platformLogoSvg` filter returned "" for a
// missing file and the template still emitted <span class="logo-stamp"></span>,
// so a card shipped an empty white box beside "NOW ON LIONSGATE PLAY" and
// nothing anywhere said why.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const PLATFORM_LOGO_DIR = "src/assets/platform-logos";

/**
 * Derive the asset stem for a platform display name. Kept byte-identical to the
 * transform the render orchestrators already used, so no existing logo changes
 * which file it resolves to:
 *   "Prime Video" → "prime-video" · "Apple TV+" → "apple-tv-plus"
 *   "Sun NXT"     → "sun-nxt"     · "JioHotstar" → "jiohotstar"
 *   "ManoramaMAX" → "manoramamax" · "Lionsgate Play" → "lionsgate-play"
 */
export function platformLogoStem(platform: string): string {
  return platform
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/\+/g, "-plus")
    .replace(/\./g, "")
    .replace(/jio-?hotstar/g, "jiohotstar");
}

/** True when an SVG asset exists for this stem. Empty stem → false. */
export function platformLogoExists(stem: string): boolean {
  if (!stem.trim()) return false;
  return existsSync(resolve(process.cwd(), PLATFORM_LOGO_DIR, `${stem}.svg`));
}

/** The stems a film's platforms need, in card order. */
export function missingPlatformLogos(platforms: readonly string[]): string[] {
  return platforms.map(platformLogoStem).filter((s) => s && !platformLogoExists(s));
}
