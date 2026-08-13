// src/shared/poster-override.ts
// Manual poster dial (WED_DROP_POSTER operator lever).
//
// TOKEN GRAMMAR — deliberately identical to WED_DROP_PLATFORM / WED_DROP_LANG:
//   ';'-separated `Title=Path` pairs, title-keyed lowercased-and-trimmed, split
//   on the FIRST '=' only. Splitting on the first '=' is what makes a Windows
//   path work: `Madhuramee Jeevitham=C:\Users\me\poster.jpg` has a colon and
//   backslashes in the VALUE, and neither is a delimiter here.
//
// WHY A DATA URI, NOT A FILE URL — the card template renders the poster as
// `<img src="{{ release.posterUrl }}">`, and renderer.ts loads the page with
// page.setContent(html) and NO base URL. A relative path therefore has nothing
// to resolve against, and a file:// URL depends on the browser's local-file
// access. Inlining the bytes is the only form that is correct by construction,
// and it matches how platform logos are already embedded.
//
// Setting a poster also clears the manifest's `contract:poster` warn for free:
// that check is `if (!film.posterUrl)`, so a film with an override is no longer
// posterless and no longer ships the typographic fallback.
//
// A MISSING OR UNREADABLE FILE IS LOUD. The operator typed this path on purpose;
// silently rendering the fallback would hide the typo until someone looked at a
// published card. Throwing is the point.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve, extname } from "node:path";
import type { Release } from "./types.js";

/** Image types the card's <img> can carry as an inline data URI. */
const POSTER_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function parsePosterOverrides(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const title = pair.slice(0, eq).trim().toLowerCase();
    const path = pair.slice(eq + 1).trim();
    if (title && path) map.set(title, path);
  }
  return map;
}

/**
 * Read a local image and return it as a data URI the renderer can inline.
 * A relative path resolves against the repo root (process.cwd()), so both
 * `src/assets/manual-posters/x.jpg` and `C:\Users\…\x.jpg` work.
 *
 * Throws — never returns a sentinel — on a missing file, an unreadable file, or
 * an extension we cannot inline.
 */
export function loadPosterDataUri(path: string, filmTitle: string): string {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const ext = extname(abs).toLowerCase();
  const mime = POSTER_MIME[ext];
  if (!mime) {
    throw new Error(
      `WED_DROP_POSTER: unsupported image type "${ext || "(none)"}" for "${filmTitle}" at ${abs} — ` +
      `expected one of ${Object.keys(POSTER_MIME).join(", ")}`
    );
  }
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`WED_DROP_POSTER: cannot read poster for "${filmTitle}" at ${abs} — ${reason}`);
  }
  if (buf.length === 0) {
    throw new Error(`WED_DROP_POSTER: poster file for "${filmTitle}" at ${abs} is empty`);
  }
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Apply WED_DROP_POSTER overrides to a pool, returning a new pool + the count set. */
export function applyPosterOverrides(
  pool: Release[],
  overrides: Map<string, string>
): { pool: Release[]; applied: number } {
  if (overrides.size === 0) return { pool, applied: 0 };
  let applied = 0;
  const out = pool.map((r) => {
    const path = overrides.get(r.title.trim().toLowerCase());
    if (!path) return r;
    applied += 1;
    return { ...r, posterUrl: loadPosterDataUri(path, r.title) };
  });
  return { pool: out, applied };
}
