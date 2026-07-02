// src/rendering/poster-crop.ts
// Dark-crop safeguard for the Wed Drop poster wall.
//
// Some posters are near-black in their top band (mockup lesson: Tavvai), so the
// default "center 18%" crop lands on a black slab. This samples the mean
// luminance of that crop window and, when it's too dark, shifts the crop to the
// poster's middle ("center 50%") where the face/art usually is.
//
// Render-time only (free — TMDb CDN fetch, no billed API). Fails SOFT to a
// static safe crop so a slow/404 poster never breaks a render.

import sharp from "sharp";
import { ofetch } from "ofetch";

/** Default crop: top-biased so the poster's title treatment shows. */
const DEFAULT_POSITION = "center 18%";
/** When the top band is near-black, drop to the middle where the art lives. */
const DARK_SHIFT_POSITION = "center 50%";
/** Static safe crop when we can't sample (fetch/decode failure). */
const FALLBACK_POSITION = "center 25%";

/** Fraction of poster height sampled from the top for the darkness test. */
const TOP_BAND_FRACTION = 0.30;
/** Mean perceived luminance (0..255) below which the top band reads "dark". Tunable. */
const DARK_LUMINANCE_THRESHOLD = 70;

/**
 * Resolve the CSS object-position for one poster's cover crop.
 * No URL → the caller renders a typographic fallback cell, so the value is
 * unused; we still return the default. Any failure → FALLBACK_POSITION.
 */
export async function computeCropPosition(posterUrl?: string): Promise<string> {
  if (!posterUrl) return DEFAULT_POSITION;
  try {
    // Let ofetch infer the response type from responseType (an explicit <T>
    // generic pins R back to "json" and rejects "arrayBuffer").
    const bytes = await ofetch(posterUrl, { responseType: "arrayBuffer" });
    const buf = Buffer.from(bytes as ArrayBuffer);
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return FALLBACK_POSITION;
    const bandHeight = Math.max(1, Math.round(meta.height * TOP_BAND_FRACTION));
    const stats = await sharp(buf)
      .extract({ left: 0, top: 0, width: meta.width, height: bandHeight })
      .stats();
    const [r, g, b] = stats.channels;
    if (!r) return FALLBACK_POSITION;
    // Perceived luminance (Rec.709). Grayscale posters expose one channel.
    const lum = g && b ? 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean : r.mean;
    return lum < DARK_LUMINANCE_THRESHOLD ? DARK_SHIFT_POSITION : DEFAULT_POSITION;
  } catch {
    return FALLBACK_POSITION;
  }
}
