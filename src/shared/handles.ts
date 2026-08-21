// src/shared/handles.ts
// WD-ENG-22C — THE INSTAGRAM HANDLE MAP. The single source of @handles.
//
// ── WHY A FILE, AND WHY ONLY THIS FILE ──────────────────────────────────────
// Tagging the wrong account on a published post is a public, permanent mistake
// that lands on a real stranger's profile. There is no automated source that
// can be trusted for it: an actor's name plus a search is a guess, and a guess
// that renders as "@someone" reads exactly like a fact.
//
// So handles come from ONE reviewed file (data/handles.json), and a name that
// is not in it does not get a handle — it gets "<name> - search", which tells
// the operator to look it up by hand. There is deliberately no fallback, no
// derivation, no "probably it's @<name-without-spaces>". A missing handle costs
// fifteen seconds; a wrong one costs a correction on a live post.
//
// `tick` is the human's signature: it means someone opened the profile and
// confirmed it is the right account, on `lastChecked`. tick:false is a row that
// exists but has NOT been confirmed, and it renders exactly like an absent one.
// This is the whole safety property — see resolveHandle.
//
// The file is git-visible via a .gitignore negation (data/* is otherwise
// excluded), so a fresh checkout has the map rather than silently degrading.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { log } from "./logger.js";

const HANDLES_PATH = "data/handles.json";

/**
 * A handle is stored WITHOUT the "@" and must look like a real IG username:
 * letters, digits, dot, underscore, 1-30 chars. Rejecting "@foo" at the schema
 * keeps the "@" a rendering concern with exactly one owner (formatTag below),
 * so a kit can never emit "@@foo".
 */
const HandleEntrySchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9._]{1,30}$/, "IG username: letters, digits, dot, underscore"),
  tick: z.boolean(),
  lastChecked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date yyyy-MM-dd"),
});

export const HandleMapSchema = z.object({
  _README: z.string().optional(),
  handles: z.record(z.string(), HandleEntrySchema),
});

export type HandleEntry = z.infer<typeof HandleEntrySchema>;
export type HandleMap = Record<string, HandleEntry>;

/** One resolved photo-tag row: either a confirmed handle, or an instruction to look. */
export interface ResolvedTag {
  /** The canonical name as the card prints it. */
  name: string;
  /** The confirmed IG username WITHOUT "@", or null when unconfirmed/unknown. */
  handle: string | null;
  /** Rendered form: "@handle" or "<name> - search". */
  display: string;
}

let cached: HandleMap | null = null;

/**
 * Load + validate the map. FAILS SOFT to an empty map: a missing or malformed
 * handles.json degrades every tag to "- search", which is the same outcome as
 * an unknown name and is always safe. It must never take down a delivery.
 */
export function loadHandleMap(path: string = HANDLES_PATH, force = false): HandleMap {
  if (cached && !force) return cached;
  try {
    const parsed = HandleMapSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!parsed.success) {
      log.warn(`  handle map: ${path} failed validation — every tag degrades to "search"`, parsed.error.issues[0]?.message);
      cached = {};
      return cached;
    }
    cached = parsed.data.handles;
    return cached;
  } catch (err) {
    log.warn(`  handle map: ${path} unreadable — every tag degrades to "search"`, err instanceof Error ? err.message : err);
    cached = {};
    return cached;
  }
}

/** TEST SEAM — drop the memo so a test can point the loader at a fixture. */
export function resetHandleMapForTests(): void {
  cached = null;
}

/**
 * THE RESOLUTION RULE, in one place.
 *
 * A handle is emitted if and only if the name is present AND tick is true.
 * Everything else — absent name, tick:false, empty map — renders as
 * "<name> - search". Note the tick:false case is NOT a special error path: an
 * unconfirmed row is treated as no row at all, so the safe outcome is the
 * default rather than something a future branch could fall out of.
 */
export function resolveHandle(name: string, map: HandleMap = loadHandleMap()): ResolvedTag {
  const entry = map[name];
  if (entry && entry.tick) {
    return { name, handle: entry.handle, display: `@${entry.handle}` };
  }
  return { name, handle: null, display: `${name} - search` };
}

/** Resolve many names, preserving order and dropping exact duplicates. */
export function resolveHandles(names: readonly string[], map: HandleMap = loadHandleMap()): ResolvedTag[] {
  const seen = new Set<string>();
  const out: ResolvedTag[] = [];
  for (const n of names) {
    const name = n.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(resolveHandle(name, map));
  }
  return out;
}
