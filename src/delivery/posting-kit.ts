// src/delivery/posting-kit.ts
// WD-ENG-22C — THE POSTING KIT. Everything a human needs to publish the deck,
// assembled DETERMINISTICALLY from data already on hand.
//
// ── NO LLM. AT ALL. ─────────────────────────────────────────────────────────
// Every string below is a template plus a field lookup. That is a hard design
// constraint, not an economy: the kit is generated on the delivery path, after
// the render audit has passed, and a model call there would put a
// non-deterministic, billable, failure-prone step between a verified deck and
// its delivery. It would also make the kit unreproducible — regenerate it and
// get different copy for the same post.
//
// The consequence to accept: the prose is templated, not written. The caption
// body still comes from the drafting model upstream (draft.caption); everything
// the kit ADDS — radar lines, keywords, alt text, checklists — is mechanical.
//
// ── THE 30-TERM LAW ─────────────────────────────────────────────────────────
// Instagram indexes hashtags in the caption and keywords in the first comment.
// The standing rule is EXACTLY 5 hashtags in the caption (4 film titles + the
// pillar tag) and AT LEAST 25 plain keyword terms in the first comment, for a
// floor of 30 discoverable terms per post. validateKit enforces all three
// bounds and the kit REFUSES to build if any is missed — a silently short kit
// would be published and nobody would notice for weeks.
//
// ── WHAT THE KIT MAY NEVER SAY ──────────────────────────────────────────────
// Radar lines carry PLATFORMS ONLY, never dates. They come from the quarantined
// radar pool, which holds finds the WD-ENG-17 date guard deliberately threw
// away for having no usable date. Printing a date beside one would launder an
// undated rumour into a claim, which is the exact failure that guard exists to
// prevent. renderRadarLine has no access to a date field to print.

import { sortByProminence } from "../shared/prominence.js";
import { resolveHandles, type HandleMap, type ResolvedTag } from "../shared/handles.js";
import { readRadarPool, type RadarPoolRow } from "../discovery/radar-pool.js";
import type { Release } from "../shared/types.js";

/** Mirrors deliver-deck-zip's CAPTION_HEADER doctrine: nothing ships unreviewed. */
export const KIT_HEADER = "DRAFT / UNREVIEWED — review before posting; hand-built captions supersede this";

/**
 * U+2116 NUMERO SIGN, built from its code point so this source file stays
 * ASCII-only. (Written as fromCharCode rather than a "№" literal because
 * the two are identical at runtime and this form survives every editor and
 * encoding hop between here and the file on disk.)
 */
const NUMERO = String.fromCharCode(0x2116);

export const REQUIRED_HASHTAGS = 5;
export const MIN_KEYWORDS = 25;
export const MIN_TOTAL_TERMS = 30;

/** Pillar tag per edition — the 5th hashtag, always present. */
const PILLAR_TAG: Record<string, string> = {
  ott: "#NowStreaming",
  theatrical: "#InTheaters",
};

export interface KitInput {
  /** "ott" | "theatrical" — drives the pillar tag, location line and keywords. */
  edition: string;
  /** Human label, e.g. "Now Streaming". */
  editionLabel: string;
  /**
   * The ISSUE ANCHOR STRING, VERBATIM — "046", not 46.
   *
   * Deliberately `string` and not `number | string`. getIssueNumber produces it
   * with `String(count).padStart(3, "0")` and every hop from there to here
   * carries it as a string, so the padding is intact by the time the kit sees
   * it. A union that ALSO accepted a number would make "just pass 46" type-check
   * and silently print Issue 46 on a deck the rest of the pipeline calls 046 —
   * so the union is closed rather than defended against.
   */
  issueNumber: string;
  /** Editorial window, for the header. */
  windowStart: string;
  windowEnd: string;
  /** The drafting model's caption body. Used verbatim. */
  caption: string;
  /** The films on the cards, in CAROUSEL ORDER (card N = releases[N-1]). */
  releases: Release[];
  /** Injectable for tests; defaults to the live pool + live map. */
  radar?: RadarPoolRow[];
  handleMap?: HandleMap;
  now?: number;
}

// ── HASHTAGS ────────────────────────────────────────────────────────────────

/** Title -> "#PascalCase", diacritics stripped, punctuation dropped. */
export function titleTag(title: string): string {
  const t = title
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .split(/\s+/)
    .map((tok) => tok.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean)
    .map((tok) => tok.charAt(0).toUpperCase() + tok.slice(1))
    .join("");
  return t ? `#${t}` : "";
}

export interface HashtagPick {
  tags: string[];
  /** Films whose titles did NOT make the four — named in the kit so the omission is visible. */
  unpicked: string[];
}

/**
 * EXACTLY 5: the four most prominent film titles plus the pillar tag.
 *
 * Prominence order (tmdbPopularity DESC, votes DESC, title ASC) is the same
 * ranking the deck already uses, so the tags match the films a reader sees
 * first. When more than four films ship, the unpicked ones are REPORTED rather
 * than silently dropped — a title missing from the tags is a real reach
 * decision, and the operator should be able to override it by hand.
 *
 * Fewer than four films is not padded with filler: a 2-film drop gets 3 tags
 * and validateKit fails, which is correct. The kit is not allowed to invent
 * reach it does not have; the operator adds tags deliberately.
 */
export function pickHashtags(releases: readonly Release[], edition: string): HashtagPick {
  const ranked = sortByProminence([...releases]);
  const picked = ranked.slice(0, 4);
  const tags = picked.map((r) => titleTag(r.title)).filter(Boolean);
  const pillar = PILLAR_TAG[edition] ?? "#TheDrop";
  return {
    tags: [...tags, pillar],
    unpicked: ranked.slice(4).map((r) => r.title),
  };
}

// ── KEYWORDS (first comment, plain terms — NOT hashtags) ────────────────────

/**
 * 25+ plain search terms derived mechanically from the deck: titles, platforms,
 * languages, and the pillar's own phrase patterns. Plain words, no "#" — these
 * ride in the first comment where Instagram indexes text, and a comment stuffed
 * with hashtags reads as spam while the same words as prose do not.
 *
 * Deterministic and order-stable: same deck in, same list out.
 */
export function buildKeywords(releases: readonly Release[], edition: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  };

  const isOtt = edition === "ott";
  const verb = isOtt ? "streaming" : "in theaters";

  for (const r of releases) {
    push(r.title);
    push(`${r.title} ${isOtt ? "OTT release" : "theatre release"}`);
    for (const p of r.platform) {
      push(p);
      push(`${r.title} on ${p}`);
      push(`new on ${p}`);
    }
    push(`${r.language} movies`);
    push(`new ${r.language} ${isOtt ? "OTT" : "movies"}`);
    for (const d of r.audioLanguages?.dubbed ?? []) push(`${d} dubbed`);
  }

  // Pillar patterns — the phrases people actually type.
  for (const p of isOtt
    ? ["what to watch this weekend", "new OTT releases this week", "new on OTT India",
       "weekend streaming guide", "Indian movies streaming now", "OTT release date",
       "where to watch", "new movies online"]
    : ["movies releasing this week", "new movie releases", "weekend movie releases",
       "theatre releases this Friday", "Indian cinema this week", "new films in cinemas",
       "which movie to watch", "box office this weekend"]) push(p);

  push("TBSI");
  push("The Big Screen Index");
  push(`Indian ${verb}`);

  return out;
}

// ── RADAR LINES (first comment) ─────────────────────────────────────────────

/**
 * ONE radar line. Platform or nothing — there is deliberately NO date parameter
 * in scope, so this function is structurally incapable of printing one. The
 * pool row it reads has no date column either (radar-pool.ts): the guarantee is
 * enforced twice, at the store and at the renderer.
 */
export function renderRadarLine(row: Pick<RadarPoolRow, "title" | "platform">): string {
  return row.platform
    ? `${row.title} is ${row.platform}-bound, no official date yet (from-pool)`
    : `${row.title} is in the pipeline, no platform or date confirmed yet (from-pool)`;
}

/**
 * Radar lines for films NOT already on the deck. A film on a card has a date
 * and a slot; repeating it as a rumour in the comment would contradict the post
 * it is attached to.
 */
export function pickRadarLines(pool: readonly RadarPoolRow[], releases: readonly Release[], max = 5): string[] {
  const onDeck = new Set(releases.map((r) => r.title.trim().toLowerCase()));
  return pool
    .filter((row) => !onDeck.has(row.title.trim().toLowerCase()))
    .slice(0, max)
    .map(renderRadarLine);
}

// ── ALT TEXT ────────────────────────────────────────────────────────────────

/** "A" · "A and B" · "A, B and C" — a list a screen reader can actually parse. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Split a comma-joined credit string into individual names. */
export function splitNames(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "2026-08-21" -> "21 August 2026". Section-508-friendly: a screen reader
 * announces an ISO date as a run of digits and hyphens ("two thousand twenty
 * six dash zero eight dash twenty one"), which is unusable read aloud. Day,
 * full month name, year is the form that survives being spoken.
 *
 * NO toLocaleDateString: that depends on the runtime's ICU build and the
 * ambient locale, so the same deck could render two different strings on two
 * machines. The month table here is the whole point — alt text must be as
 * reproducible as everything else in this module.
 *
 * The day is Number()-ed to drop a leading zero ("05" -> "5"); this is the ONE
 * place in the kit where a numeric coercion is correct, and it is applied to a
 * calendar day, never to the issue number (see buildPostingKit).
 *
 * Returns null for anything that is not a plain ISO date, so a malformed value
 * drops its clause rather than printing garbage into an accessibility field.
 */
export function humanDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * Per-card alt text, built from release fields. Describes what the card SHOWS
 * (a title card for a film, with its poster, platform and credits), because
 * that is what a screen-reader user needs — not a re-run of the caption.
 *
 * Every clause is conditional on its field, so a sparse release degrades to a
 * shorter sentence rather than printing "undefined" or an empty "directed by".
 */
export function altTextFor(r: Release, edition: string): string {
  const parts: string[] = [];
  parts.push(`Title card for the ${r.language} film ${r.title}`);
  if (r.posterUrl) parts.push("shown beside its poster");
  const where = r.platform.length > 0 ? andList(r.platform) : null;
  if (edition === "ott" && where) parts.push(`streaming on ${where}`);
  else if (edition === "ott") parts.push("streaming platform to be announced");
  const date = humanDate(edition === "ott" ? r.releaseDates?.ott : r.releaseDates?.theatrical);
  if (date) parts.push(`from ${date}`);
  // Director is ONE string that may name several people ("Lucky Bezawada, Ravi
  // Namburii"). Split it before listing, or the comma reads as a clause break
  // in a sentence already comma-joined — a screen reader gets "directed by
  // Lucky Bezawada, Ravi Namburii, starring ..." with no way to tell where the
  // directors end.
  const directors = r.director ? splitNames(r.director) : [];
  if (directors.length > 0) parts.push(`directed by ${andList(directors)}`);
  const cast = r.leadCast && r.leadCast.length > 0 ? r.leadCast : r.cast.slice(0, 2);
  if (cast.length > 0) parts.push(`starring ${andList(cast)}`);
  if (r.musicDirector) parts.push(`music by ${r.musicDirector}`);
  if (r.runtime) parts.push(`${r.runtime} minutes`);
  return `${parts.join(", ")}.`;
}

// ── PHOTO TAGS ──────────────────────────────────────────────────────────────

/**
 * The names worth tagging on one card, in the order they appear on it:
 * lead cast (what the card actually prints), then the music director, then the
 * platform. Resolution to @handle-or-search happens in the handle map.
 */
export function tagNamesFor(r: Release): string[] {
  const cast = r.leadCast && r.leadCast.length > 0 ? r.leadCast : r.cast.slice(0, 3);
  return [...cast, ...(r.musicDirector ? [r.musicDirector] : []), ...r.platform];
}

// ── VALIDATION ──────────────────────────────────────────────────────────────

export interface KitValidation {
  ok: boolean;
  hashtagCount: number;
  keywordCount: number;
  totalTerms: number;
  failures: string[];
}

/**
 * THE THREE BOUNDS. Checked independently and reported together, so a kit that
 * misses two tells you both at once instead of one per rebuild.
 */
export function validateKit(hashtags: readonly string[], keywords: readonly string[]): KitValidation {
  const hashtagCount = hashtags.length;
  const keywordCount = keywords.length;
  const totalTerms = hashtagCount + keywordCount;
  const failures: string[] = [];
  if (hashtagCount !== REQUIRED_HASHTAGS) {
    failures.push(`hashtags must be EXACTLY ${REQUIRED_HASHTAGS} (4 film titles + pillar tag), got ${hashtagCount}`);
  }
  if (keywordCount < MIN_KEYWORDS) {
    failures.push(`keywords must be at least ${MIN_KEYWORDS}, got ${keywordCount}`);
  }
  if (totalTerms < MIN_TOTAL_TERMS) {
    failures.push(`total discoverable terms must be at least ${MIN_TOTAL_TERMS} (the standing 30-term law), got ${totalTerms}`);
  }
  return { ok: failures.length === 0, hashtagCount, keywordCount, totalTerms, failures };
}

// ── ASSEMBLY ────────────────────────────────────────────────────────────────

export interface PostingKit {
  /** The full POSTING-KIT.md body. */
  markdown: string;
  /** The caption alone (header + body + the 5 hashtags) — what goes in caption.txt. */
  caption: string;
  validation: KitValidation;
  hashtags: string[];
  keywords: string[];
  radarLines: string[];
  altText: string[];
  photoTags: Array<{ card: string; title: string; tags: ResolvedTag[] }>;
}

/**
 * Build the kit. THROWS when validation fails — loudly, by design. A kit that
 * quietly shipped 3 hashtags and 12 keywords would look fine in the zip and
 * cost weeks of reach before anyone counted. The caller treats the throw as a
 * non-fatal delivery-step failure (deck-zip doctrine): the deck still ships.
 */
export function buildPostingKit(input: KitInput): PostingKit {
  const { edition, editionLabel, issueNumber, windowStart, windowEnd, caption, releases } = input;
  const pool = input.radar ?? readRadarPool(input.now);

  const { tags: hashtags, unpicked } = pickHashtags(releases, edition);
  const keywords = buildKeywords(releases, edition);
  const validation = validateKit(hashtags, keywords);
  if (!validation.ok) {
    throw new Error(`posting kit REFUSED — ${validation.failures.join("; ")}`);
  }

  const radarLines = pickRadarLines(pool, releases);
  const altText = releases.map((r) => altTextFor(r, edition));
  const photoTags = releases.map((r, i) => ({
    card: `C${i + 1}`,
    title: r.title,
    tags: resolveHandles(tagNamesFor(r), input.handleMap),
  }));

  const captionText = `${KIT_HEADER}\n\n${caption.trim()}\n\n${hashtags.join(" ")}`;

  const L: string[] = [];
  // NUMERO SIGN + the anchor string with NO space between them, so the issue
  // reads as ONE token and matches how every other surface prints it (run log,
  // Slack, issue anchor). `issueNumber` is interpolated straight in — never
  // Number()-ed, never re-padded — so "046" stays "046".
  L.push(`# POSTING KIT — Wed Drop · ${editionLabel} · ${NUMERO}${issueNumber}`);
  L.push("");
  L.push(`> ${KIT_HEADER}`);
  L.push("");
  L.push(`Window ${windowStart} to ${windowEnd} · ${releases.length} film(s) · cover + ${releases.length} card(s)`);
  L.push("");

  L.push("## 1. CAPTION");
  L.push("");
  L.push("```");
  L.push(caption.trim());
  L.push("");
  L.push(hashtags.join(" "));
  L.push("```");
  L.push("");
  L.push(`Hashtags: ${hashtags.length} (4 film titles by prominence + pillar tag).`);
  if (unpicked.length > 0) {
    L.push(`NOT tagged (below the top four by prominence): ${unpicked.join(", ")}. Add by hand if you disagree.`);
  }
  L.push("");

  L.push("## 2. FIRST COMMENT");
  L.push("");
  L.push("```");
  if (radarLines.length > 0) {
    L.push("On the radar:");
    for (const line of radarLines) L.push(`- ${line}`);
    L.push("");
  }
  L.push(keywords.join(" · "));
  L.push("```");
  L.push("");
  L.push(`Keywords: ${keywords.length} plain terms (no hashes). Total discoverable terms: ${validation.totalTerms}.`);
  if (radarLines.length === 0) {
    L.push("Radar: nothing in the pool this week (or every pooled find is already on the deck).");
  } else {
    L.push("Radar lines name PLATFORMS ONLY and never dates — they come from finds the date guard rejected.");
  }
  L.push("");

  L.push("## 3. PHOTO-TAG CHECKLIST");
  L.push("");
  L.push("Tag only what is ticked. A name marked `search` has NOT been confirmed — look it up before tagging, and add it to data/handles.json with tick:true once you have.");
  L.push("");
  for (const row of photoTags) {
    L.push(`- **${row.card} · ${row.title}** — ${row.tags.map((t) => t.display).join(" · ")}`);
  }
  L.push("");

  L.push("## 4. ALT TEXT");
  L.push("");
  for (const [i, text] of altText.entries()) {
    L.push(`- **C${i + 1}** — ${text}`);
  }
  L.push("");

  L.push("## 5. LOCATION + ORDER");
  L.push("");
  L.push("Location: India");
  L.push("");
  L.push("Carousel order:");
  L.push("1. Cover");
  for (const [i, r] of releases.entries()) L.push(`${i + 2}. C${i + 1} — ${r.title}`);
  L.push("");

  return {
    markdown: L.join("\n") + "\n",
    caption: captionText,
    validation,
    hashtags,
    keywords,
    radarLines,
    altText,
    photoTags,
  };
}
