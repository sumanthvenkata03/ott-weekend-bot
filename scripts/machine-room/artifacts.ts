// scripts/machine-room/artifacts.ts
// SERVING RENDERED CARDS — by exact-match allowlist, never by path resolution.
//
// THE THREAT. `GET /api/artifacts?f=<name>` takes a filename from the request.
// The obvious implementation — join(POSTS_DIR, f) plus a startsWith guard — is
// the classic traversal footgun: it is one normalisation quirk, one encoded
// separator, one symlink away from serving something else, and the repo root
// above output/ contains .env.
//
// So the request NEVER participates in building a path. The summary has already
// listed the exact filenames for that run; the request can only SELECT one of
// them by exact string equality. A name that is not in the list does not exist,
// whatever it looks like. Rejecting separators and ".." as well is redundant
// belt-and-braces — no such name could match the allowlist anyway — but it
// makes the intent legible and fails loudly rather than silently.
//
// ── WHY PNG ONLY IN M1.2 ────────────────────────────────────────────────────
// Recon residual (d): output/runs/*.json and output/manifests/*.json are written
// by raw JSON.stringify in shared/run-artifacts.ts and shared/post-validator.ts,
// bypassing the logger entirely — so they are UNSCRUBBED on disk. An error
// string that reached a manifest `reason` sits there in the clear. Serving them
// would undo M0 at the read boundary. They stay out until redaction-at-read
// exists; PNGs carry no such text.

import AdmZip from "adm-zip";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POSTS_DIR } from "./paths.js";

/** Only this extension is served in M1.2. See the header for why. */
export const ALLOWED_EXTENSION = ".png";

export type PickResult =
  | { ok: true; name: string }
  | { ok: false; status: number; reason: string };

/**
 * Choose one artifact from a run's allowlist.
 *
 * `allow` is the list the SUMMARY computed for that run — not a directory read
 * driven by the request. Matching is exact equality, so no prefix, suffix,
 * normalisation or case rule can be bent into a traversal.
 */
export function pickArtifact(allow: readonly string[], requested: unknown): PickResult {
  if (typeof requested !== "string" || requested.length === 0) {
    return { ok: false, status: 400, reason: "f is required" };
  }
  // Redundant given the allowlist, deliberately kept: a separator or dot-dot in
  // the request is never a mistake worth answering politely.
  if (/[/\\]/.test(requested) || requested.includes("..") || requested.includes("\0")) {
    return { ok: false, status: 400, reason: "f must be a bare filename" };
  }
  if (!requested.toLowerCase().endsWith(ALLOWED_EXTENSION)) {
    return { ok: false, status: 415, reason: `only ${ALLOWED_EXTENSION} artifacts are served` };
  }
  // EXACT match. Not startsWith, not includes, not a normalised compare.
  if (!allow.some((a) => a === requested)) {
    return { ok: false, status: 404, reason: "not an artifact of this run" };
  }
  return { ok: true, name: requested };
}

/** Read one allowlisted artifact's bytes. The name has already been validated. */
export function readArtifact(name: string, postsDir: string = POSTS_DIR): Buffer {
  return readFileSync(join(postsDir, name));
}

/**
 * Zip an allowlist. Built from the SAME list the gallery and the per-file
 * endpoint use, so there is exactly one definition of "this run's artifacts"
 * and no way for the zip to contain something the UI never showed.
 *
 * adm-zip is already a dependency (delivery/deliver-deck-zip.ts uses it), so
 * this adds nothing to package.json — and therefore nothing to the public
 * Render build.
 */
export function buildArtifactZip(names: readonly string[], postsDir: string = POSTS_DIR): Buffer {
  const zip = new AdmZip();
  for (const n of names) {
    try {
      zip.addFile(n, readFileSync(join(postsDir, n)));
    } catch {
      // A file that vanished between listing and zipping is skipped rather than
      // failing the whole download.
    }
  }
  return zip.toBuffer();
}

/**
 * tbsi-<job>-<date>-run.zip
 *
 * The dot is NOT in the allowed set. Both inputs are trusted here — job comes
 * from the frozen registry, date from editorialTodayStamp — so this is pure
 * defence in depth, but permitting "." let ".." through into a
 * Content-Disposition filename, and a sanitiser that preserves the one sequence
 * everybody sanitises for is not worth having.
 */
export function zipFilename(job: string, date: string): string {
  const safe = `${job}-${date}`.replace(/[^A-Za-z0-9_-]/g, "-");
  return `tbsi-${safe}-run.zip`;
}
