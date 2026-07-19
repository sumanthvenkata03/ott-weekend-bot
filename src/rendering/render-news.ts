// src/rendering/render-news.ts
// Orchestrator: a composed news edition → PNG card(s) in the published design
// system. Three formats, one entry point.
//
//   jn-skin          1 poster-led card (news-radar-card)
//   register         cover + N quadrant slides (news-register-cover/-card)
//   register-single  1 quadrant card, one story per quadrant
//
// Canvas: 1080×1350 CSS at deviceScaleFactor 2 ⇒ 2160×2700 assets (spec §1).
// Authoring in CSS px with the builders' @2x constants halved is what keeps the
// HTML pixel-close to the PIL originals — see the templates' inline citations.
//
// Poster reality (ruling R1): a quadrant with no resolved poster renders the
// spec's maroon typographic ground. That is a designed fallback (§2.2), not an
// error path, so nothing here throws when art is missing.

import { promises as fs } from "node:fs";
import { renderToPNG } from "./renderer.js";
import { computeCropPosition } from "./poster-crop.js";
import { log } from "../shared/logger.js";
import type { ComposedEdition, SelectedStory } from "../content/news/news-compose.js";
import { CARD_LINE_MAX, clampWords, stripHeadlineTail, type CardCopy } from "../content/news/news-caption.js";

/** cluster id → editorial card copy, from the package step. */
export type CardCopyMap = Record<string, CardCopy>;

/** File slug — matches the deck-zip slug so delivery finds these PNGs. */
export const NEWS_SLUG = "tbsi-news";

export const CARD_W = 1080;
export const CARD_H = 1350;

/** Quadrants per register card (§2.2 2×2). */
const QUADS_PER_SLIDE = 4;

/** Optional brand PNG; the templates fall back to the CSS pill (ruling R2). */
const PILL_PNG_PATH = "src/assets/brand/handle_pill_2x.png";

export interface NewsRenderResult {
  coverPath?: string;
  cardPaths: string[];
  /** Per-card render notes — poster vs typographic, for the report/verify pass. */
  notes: string[];
}

/**
 * Resolve the pill asset once per run; undefined ⇒ templates use the CSS pill.
 *
 * Inlined as a data: URI, NOT a file:// URL. The renderer loads templates via
 * page.setContent(), which gives the page an about:blank origin — Chromium
 * blocks file:// subresources from such a page, so a file:// pill renders as a
 * broken-image icon. That is exactly what the first live package shipped.
 */
async function pillDataUri(): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(PILL_PNG_PATH);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Uppercase mono fact lines for a quadrant, from the story's verified fields. */
function factsFor(s: SelectedStory): string[] {
  // SEGMENT · CLASS only. Outlets used to print here AND again in `credit`,
  // so the first outlet appeared twice on one quadrant (the double-TOI card).
  // Outlets are a credit, and a credit belongs on the credit line — once.
  return [`${s.segment.badge} · ${s.resolved.story.cluster.storyClass.toUpperCase()}`];
}

/** The credit line — the ONLY place outlets print. Deduped, capped at two. */
function creditFor(s: SelectedStory): string {
  const seen = new Set<string>();
  const outlets: string[] = [];
  for (const o of s.resolved.story.cluster.outlets) {
    const k = o.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    outlets.push(o.trim());
    if (outlets.length === 2) break;
  }
  return outlets.join(" · ").toUpperCase();
}

/**
 * DETERMINISTIC card-line fallback. If the caption LLM call failed or returned
 * no entry for this story, the card must still be readable — a blank quadrant
 * is worse than a plainly-set one. The raw headline is tail-stripped and
 * word-clamped by the same rules the editorial copy obeys, so even the fallback
 * can never carry "| Etimes" or a mid-word clip.
 *
 * EXEMPT FROM THE NAME SWEEP, by ruling and by construction: this is the
 * outlet's OWN published headline, quoted, not text a model generated. There is
 * no fabrication surface to guard — a name here is a name a real outlet printed.
 * The sweep exists to catch invention, and nothing here is invented.
 */
export function fallbackCardLine(headline: string): string {
  return clampWords(stripHeadlineTail(headline), CARD_LINE_MAX);
}

/** cardLine for a story: editorial copy when we have it, deterministic when not. */
function lineFor(s: SelectedStory, copy: CardCopyMap): string {
  return copy[s.resolved.story.cluster.id]?.cardLine
    ?? fallbackCardLine(s.resolved.story.cluster.headline);
}

/** The quadrant payload for one story. */
async function quadFor(s: SelectedStory, copy: CardCopyMap): Promise<Record<string, unknown>> {
  const film = s.resolved.film;
  const poster = film?.posterUrl;
  // A resolved film has a real title; otherwise the EDITORIAL cardLine carries
  // the quadrant. The raw cluster headline never reaches a template unstripped.
  const c = copy[s.resolved.story.cluster.id];
  const quad: Record<string, unknown> = {
    film: film?.title ?? lineFor(s, copy),
    dek: c?.cardDek ?? "",
    facts: factsFor(s),
    credit: creditFor(s),
  };
  if (poster) {
    quad.posterUrl = poster;
    // House crop convention v1 (ruling R4): the existing luminance-aware crop.
    // Face-anchoring is the ruled v2 direction (WASM Haar) and is NOT in here.
    quad.cropPosition = await computeCropPosition(poster);
  }
  return quad;
}

/** Pad a slide's quadrants to exactly 4 so the 2×2 never leaves a hole. */
function padQuads(
  quads: Record<string, unknown>[],
  overflow: SelectedStory[],
  copy: CardCopyMap = {}
): Record<string, unknown>[] {
  const out = [...quads];
  if (out.length < QUADS_PER_SLIDE && overflow.length > 0) {
    out.push({
      alsoHonoured: [
        {
          label: "ALSO TODAY",
          lines: overflow.slice(0, 6).map((s) => s.resolved.film?.title ?? lineFor(s, copy)),
        },
      ],
    });
  }
  // Any remaining hole becomes a typographic tile — never background (§4.3).
  while (out.length < QUADS_PER_SLIDE) out.push({ film: "THE BIG SCREEN INDEX", facts: [] });
  return out.slice(0, QUADS_PER_SLIDE);
}

/**
 * Render a composed edition. Returns written paths + per-card notes.
 * `format: "none"` renders nothing and returns empty — a quiet day has no art.
 */
export async function renderNews(
  edition: ComposedEdition,
  istDate: string,
  cardCopy: CardCopyMap = {},
  outputDir = "output/posts"
): Promise<NewsRenderResult> {
  if (edition.format === "none") return { cardPaths: [], notes: ["no edition — nothing rendered"] };

  await fs.mkdir(outputDir, { recursive: true });
  const pill = await pillDataUri();
  const notes: string[] = [];
  const cardPaths: string[] = [];
  let coverPath: string | undefined;

  // ── jn-skin: one poster-led card ──────────────────────────────────────────
  if (edition.format === "jn-skin") {
    const s = edition.cover!;
    const c = s.resolved.story.cluster;
    const film = s.resolved.film!;
    // Single-card formats produce ONE file and no zip (see renderNews docs).
    const path = `${outputDir}/${NEWS_SLUG}-${istDate}-card-01.png`;
    await renderToPNG({
      templateName: "news-radar-card",
      width: CARD_W,
      height: CARD_H,
      outputPath: path,
      data: {
        posterUrl: film.posterUrl,
        cropPosition: await computeCropPosition(film.posterUrl),
        darken: 0.66,
        pillPng: pill,
        eyebrow: `${s.segment.badge} · ${c.storyClass.toUpperCase()}`,
        title: film.title,
        numeral: numeralFor(s),
        facts: creditFor(s),
        // The DEK is the statement — an editorial clause, not the feed headline.
        statement: cardCopy[c.id]?.cardDek ?? lineFor(s, cardCopy),
        footer: `${creditFor(s)} · ${istDate}`,
      },
    });
    cardPaths.push(path);
    notes.push(`jn-skin: poster (${film.confidence}, TMDb ${film.tmdbId})`);
    log.info(`  Rendered jn-skin → ${path}`);
    return { cardPaths, notes };
  }

  // ── register-single: ONE 2×2 card ─────────────────────────────────────────
  if (edition.format === "register-single") {
    const quads = await Promise.all(edition.cards.map((s) => quadFor(s, cardCopy)));
    const path = `${outputDir}/${NEWS_SLUG}-${istDate}-card-01.png`;
    await renderToPNG({
      templateName: "news-register-card",
      width: CARD_W,
      height: CARD_H,
      outputPath: path,
      data: { quads: padQuads(quads, [], cardCopy), pillPng: pill },
    });
    cardPaths.push(path);
    const withArt = quads.filter((q) => q.posterUrl).length;
    notes.push(`register-single: ${withArt} poster / ${quads.length - withArt} typographic quadrants`);
    log.info(`  Rendered register-single → ${path}`);
    return { cardPaths, notes };
  }

  // ── register: cover + quadrant slides ─────────────────────────────────────
  const all = edition.cards;
  const tiles = all.slice(0, 4).map((s) => ({
    ...(s.resolved.film?.posterUrl ? { posterUrl: s.resolved.film.posterUrl } : {}),
    // Only a RESOLVED film name goes on a tile. An unresolved story has no short
    // name — printing its headline duplicated the cover title AND overflowed the
    // tile. The maroon ground alone carries an artless tile.
    ...(s.resolved.film?.title ? { film: s.resolved.film.title.slice(0, 26) } : {}),
  }));
  // An all-typographic mosaic is ALREADY dark maroon; the poster-grade darken
  // crushed it to pure black in the first live package. Scale the darken to how
  // much real art is actually on the cover.
  const artTiles = tiles.filter((t) => t.posterUrl).length;
  const lead = edition.cover!;
  coverPath = `${outputDir}/${NEWS_SLUG}-${istDate}-cover.png`;
  await renderToPNG({
    templateName: "news-register-cover",
    width: CARD_W,
    height: CARD_H,
    outputPath: coverPath,
    data: {
      tiles,
      mosaicCols: tiles.length <= 2 ? 1 : 2,
      coverDarken: artTiles === 0 ? 0.18 : artTiles < tiles.length ? 0.52 : 0.70,
      pillPng: pill,
      eyebrow: `${lead.segment.badge} · ${istDate}`,
      numeral: String(all.length),
      title: lineFor(lead, cardCopy),
      factLine: all
        .flatMap((s) => s.resolved.story.cluster.outlets.slice(0, 1))
        .slice(0, 4)
        .join(" · ")
        .toUpperCase(),
      swipeLine: "SWIPE FOR THE FULL LIST →",
    },
  });
  notes.push(`register cover: ${tiles.filter((t) => t.posterUrl).length}/${tiles.length} mosaic tiles have art`);
  log.info(`  Rendered register cover → ${coverPath}`);

  for (let i = 0; i < all.length; i += QUADS_PER_SLIDE) {
    const slice = all.slice(i, i + QUADS_PER_SLIDE);
    const quads = await Promise.all(slice.map((s) => quadFor(s, cardCopy)));
    const n = String(i / QUADS_PER_SLIDE + 1).padStart(2, "0");
    const path = `${outputDir}/${NEWS_SLUG}-${istDate}-card-${n}.png`;
    await renderToPNG({
      templateName: "news-register-card",
      width: CARD_W,
      height: CARD_H,
      outputPath: path,
      data: { quads: padQuads(quads, all.slice(i + QUADS_PER_SLIDE), cardCopy), pillPng: pill },
    });
    cardPaths.push(path);
    const withArt = quads.filter((q) => q.posterUrl).length;
    notes.push(`register slide ${n}: ${withArt} poster / ${quads.length - withArt} typographic`);
    log.info(`  Rendered register slide ${n} → ${path}`);
  }

  return { coverPath, cardPaths, notes };
}

/**
 * The hero numeral for a JN-skin card — the ONE big gold element (§2.1).
 * Only a VERIFIED figure may become it: a date from an ott-date story, or the
 * cluster's outlet count. Never an invented number.
 */
function numeralFor(s: SelectedStory): string {
  const c = s.resolved.story.cluster;
  const m = c.headline.match(/\b(?:on|from)\s+(\w+\s+\d{1,2})\b/i);
  if (m?.[1]) return m[1].toUpperCase();
  const day = c.headline.match(/\b(\d{1,2})\s+(?:July|August|September|October|November|December|January|February|March|April|May|June)\b/i);
  if (day?.[1]) return day[1];
  return String(c.outletCount);
}
