// WED_DROP_POSTER — the manual poster dial.
//
// Issue 041 shipped Madhuramee Jeevitham with `contract:poster — no poster art;
// card ships the typographic fallback`, because TMDb carried no key art for it.
// This dial lets the operator supply the official one-sheet by path, in the same
// grammar as WED_DROP_PLATFORM / WED_DROP_LANG.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePosterOverrides,
  applyPosterOverrides,
  loadPosterDataUri,
} from "../poster-override.js";
import type { Release } from "../types.js";

const film = (title: string, posterUrl?: string) =>
  ({ title, ...(posterUrl ? { posterUrl } : {}) }) as unknown as Release;

/** A real 1x1 JPEG, so the loader reads actual bytes rather than a stub. */
const JPEG_1PX = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64"
);

describe("parsePosterOverrides — grammar matches WED_DROP_PLATFORM", () => {
  it("parses ;-separated Title=Path pairs, title-keyed lowercase", () => {
    const m = parsePosterOverrides("Madhuramee Jeevitham=src/assets/manual-posters/x.jpg;Shabara=y.png");
    expect(m.get("madhuramee jeevitham")).toBe("src/assets/manual-posters/x.jpg");
    expect(m.get("shabara")).toBe("y.png");
    expect(m.size).toBe(2);
  });

  it("WINDOWS PATH: splits on the FIRST '=' so a drive colon survives", () => {
    const m = parsePosterOverrides(
      "Madhuramee Jeevitham=C:\\Users\\webne\\Downloads\\maduramee_jeevitham_poster02.jpg"
    );
    expect(m.get("madhuramee jeevitham")).toBe(
      "C:\\Users\\webne\\Downloads\\maduramee_jeevitham_poster02.jpg"
    );
  });

  it("a path containing '=' keeps its tail (only the first '=' delimits)", () => {
    const m = parsePosterOverrides("Film=C:\\art\\poster.jpg?v=2");
    expect(m.get("film")).toBe("C:\\art\\poster.jpg?v=2");
  });

  it("trims surrounding whitespace on both title and path", () => {
    const m = parsePosterOverrides("  Shabara  =  C:\\a\\b.jpg  ");
    expect(m.get("shabara")).toBe("C:\\a\\b.jpg");
  });

  it.each([undefined, "", "   ", ";", " ; ; ", "no-equals-sign", "=onlyvalue", "onlytitle="])(
    "malformed input %o yields an empty map",
    (raw) => {
      expect(parsePosterOverrides(raw as string | undefined).size).toBe(0);
    }
  );
});

describe("applyPosterOverrides — replaces the target, leaves the rest alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "tbsi-poster-"));
  const jpg = join(dir, "official.jpg");
  writeFileSync(jpg, JPEG_1PX);

  it("sets posterUrl to an inline data URI on the matched film only", () => {
    const pool = [
      film("Madhuramee Jeevitham"),
      film("Shabara", "https://image.tmdb.org/t/p/w500/existing.jpg"),
      film("Hushar Pittalu"),
    ];
    const { pool: out, applied } = applyPosterOverrides(
      pool,
      parsePosterOverrides(`Madhuramee Jeevitham=${jpg}`)
    );

    expect(applied).toBe(1);
    expect(out[0]!.posterUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(out[0]!.posterUrl!.length).toBeGreaterThan(64);
    // Untouched films keep their exact prior value — including "no poster".
    expect(out[1]!.posterUrl).toBe("https://image.tmdb.org/t/p/w500/existing.jpg");
    expect(out[2]!.posterUrl).toBeUndefined();
    // Non-target objects are passed through by reference, not rebuilt.
    expect(out[1]).toBe(pool[1]);
    expect(out[2]).toBe(pool[2]);
  });

  it("an override REPLACES an existing TMDb poster", () => {
    const pool = [film("Shabara", "https://image.tmdb.org/t/p/w500/old.jpg")];
    const { pool: out } = applyPosterOverrides(pool, parsePosterOverrides(`Shabara=${jpg}`));
    expect(out[0]!.posterUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("clears the contract:poster condition — the film is no longer posterless", () => {
    // post-validator warns on `!film.posterUrl`; this is that exact predicate.
    const { pool: out } = applyPosterOverrides(
      [film("Madhuramee Jeevitham")],
      parsePosterOverrides(`Madhuramee Jeevitham=${jpg}`)
    );
    expect(Boolean(out[0]!.posterUrl)).toBe(true);
  });

  it("title matching is case- and whitespace-insensitive", () => {
    const { applied } = applyPosterOverrides(
      [film("  madhuramee JEEVITHAM ")],
      parsePosterOverrides(`Madhuramee Jeevitham=${jpg}`)
    );
    expect(applied).toBe(1);
  });

  it("an empty override map is the identity — same array reference", () => {
    const pool = [film("A"), film("B")];
    const res = applyPosterOverrides(pool, parsePosterOverrides(undefined));
    expect(res.applied).toBe(0);
    expect(res.pool).toBe(pool);
  });

  it("an override naming a film not in the pool is inert", () => {
    const pool = [film("A")];
    const { pool: out, applied } = applyPosterOverrides(pool, parsePosterOverrides(`Nobody=${jpg}`));
    expect(applied).toBe(0);
    expect(out[0]!.posterUrl).toBeUndefined();
  });
});

describe("a bad path is LOUD — never a silent skip", () => {
  const dir = mkdtempSync(join(tmpdir(), "tbsi-poster-bad-"));

  it("a missing file throws, naming the film and the resolved path", () => {
    const missing = join(dir, "does-not-exist.jpg");
    expect(() => loadPosterDataUri(missing, "Madhuramee Jeevitham")).toThrow(/WED_DROP_POSTER/);
    expect(() => loadPosterDataUri(missing, "Madhuramee Jeevitham")).toThrow(/Madhuramee Jeevitham/);
    expect(() => loadPosterDataUri(missing, "Madhuramee Jeevitham")).toThrow(/does-not-exist\.jpg/);
  });

  it("applyPosterOverrides propagates the throw — the film is NOT silently left posterless", () => {
    const pool = [film("Madhuramee Jeevitham")];
    expect(() =>
      applyPosterOverrides(pool, parsePosterOverrides(`Madhuramee Jeevitham=${join(dir, "nope.jpg")}`))
    ).toThrow(/cannot read poster/);
  });

  it("an unsupported extension throws rather than inlining an un-renderable blob", () => {
    const bad = join(dir, "poster.tiff");
    writeFileSync(bad, JPEG_1PX);
    expect(() => loadPosterDataUri(bad, "X")).toThrow(/unsupported image type/);
  });

  it("an empty file throws", () => {
    const empty = join(dir, "empty.jpg");
    writeFileSync(empty, Buffer.alloc(0));
    expect(() => loadPosterDataUri(empty, "X")).toThrow(/is empty/);
  });

  it("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("the real Madhuramee Jeevitham asset is installed and loadable", () => {
  it("resolves from a repo-relative path and inlines as JPEG", () => {
    const uri = loadPosterDataUri(
      "src/assets/manual-posters/madhuramee-jeevitham-2026.jpg",
      "Madhuramee Jeevitham"
    );
    expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
    // 181,007 bytes → ~241k of base64. Proves real key art, not a stub.
    expect(uri.length).toBeGreaterThan(200_000);
  });
});
