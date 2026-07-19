// src/content/news/news-caption.ts
// NEWS DESK · F (Phase 2) — the SWEPT caption + the post package.
//
// The UNSWEPT label is GONE. Its prerequisite — the shared name sweep — now
// exists (src/shared/copy-guard.ts), and this module runs it: a drafted caption
// is swept against its own stories' text (ruling R5), and an unbacked name
// forces ONE retry naming the offenders, exactly like Wed Drop's guard. A
// caption that fails twice is HELD, never shipped.
//
// The package is everything the owner needs to post by hand: caption, hashtag
// split (6 in caption / rest in first comment, per the standing 30-law), the
// badge-check mention board (§3 law 7 — NO TICK, NO TAG: names and candidate
// handles, never auto-tagged), and pinned-comment text.

import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import { sweepCaption } from "./news-sweep.js";
import type { ComposedEdition, SelectedStory } from "./news-compose.js";
import type { VerifiedStory } from "./news-verify.js";

/** Hashtags shown in the caption; the rest go to the first comment. */
export const CAPTION_HASHTAGS = 6;
/** Instagram's hard cap across caption + comments. */
export const MAX_HASHTAGS = 30;

// ── SOURCE ATTRIBUTION ──────────────────────────────────────────────────────
//
// The pinned comment credits the page we ACTUALLY CITE, so the outlet name must
// be derived from the sourceUrl's own domain — never from the cluster's outlet
// list. Those are different objects: the cluster records who ran the story in
// the feed, while sourceUrl is whatever page verification retrieved to confirm
// it. Pairing outlets[0] with sourceUrl printed "Business Standard —
// https://outlookindia.com/…", crediting an outlet that had nothing to do with
// that page. A wrong credit is a factual error on a page whose brand is accuracy.
//
// Display names reuse the Tier-A registry's own naming (TIER_A_SOURCES.names)
// so one editorial vocabulary governs both tiering and attribution. The two
// registry arrays are NOT 1:1 (a domain can have several name spellings), so
// the mapping is explicit rather than zipped.

/** domain → printed outlet name. Unknown domains print bare (see outletForUrl). */
export const DOMAIN_OUTLET: Readonly<Record<string, string>> = {
  // Tier-A registry domains
  "123telugu.com": "123telugu",
  "filmcompanion.in": "Film Companion",
  "thehindu.com": "The Hindu",
  "timesofindia.indiatimes.com": "The Times of India",
  "indianexpress.com": "The Indian Express",
  "cinemaexpress.com": "Cinema Express",
  "newindianexpress.com": "The New Indian Express",
  "ottplay.com": "OTTplay",
  "hindustantimes.com": "Hindustan Times",
  "gulte.com": "Gulte",
  "greatandhra.com": "GreatAndhra",
  "sify.com": "Sify",
  "onlykollywood.com": "Only Kollywood",
  "behindwoods.com": "Behindwoods",
  "baradwajrangan.com": "Baradwaj Rangan",
  // Outlets verification has actually cited in live runs
  "outlookindia.com": "Outlook India",
  "pinkvilla.com": "Pinkvilla",
  "republicworld.com": "Republic World",
  "dtnext.in": "DT Next",
  "koimoi.com": "Koimoi",
  "sacnilk.com": "Sacnilk",
  "business-standard.com": "Business Standard",
  "businesstoday.in": "Business Today",
  "indiatoday.in": "India Today",
  "news18.com": "News18",
  "moneycontrol.com": "Moneycontrol",
  "filmibeat.com": "Filmibeat",
  "bollywoodhungama.com": "Bollywood Hungama",
  "deccanchronicle.com": "Deccan Chronicle",
  "economictimes.indiatimes.com": "The Economic Times",
  "ndtv.com": "NDTV",
  "zee5.com": "ZEE5",
};

/**
 * Printed outlet name for a cited URL. Falls back to the bare registrable
 * domain — an unknown outlet is printed honestly rather than guessed at or
 * silently attributed to someone else. Returns "" for an unusable URL.
 */
export function outletForUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
  if (DOMAIN_OUTLET[host]) return DOMAIN_OUTLET[host]!;
  // Suffix match so a regional subdomain still credits its parent masthead.
  for (const [d, name] of Object.entries(DOMAIN_OUTLET)) {
    if (host.endsWith(`.${d}`)) return name;
  }
  return host;
}

/**
 * "Outlet — url" lines for the pinned comment, deduped. Two stories confirmed
 * off the SAME page produce one line, not two.
 */
export function buildSourceLines(stories: { sourceUrl: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stories) {
    if (!s.sourceUrl) continue;
    const outlet = outletForUrl(s.sourceUrl);
    if (!outlet) continue;
    const line = `${outlet} — ${s.sourceUrl}`;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

// ── EDITORIAL CARD COPY ─────────────────────────────────────────────────────
//
// A raw feed headline is written for search, not for a card: it carries outlet
// tails ("| Etimes"), SEO stuffing, and a length no card can hold. The same LLM
// call that writes the caption now also writes a cardLine and cardDek per story,
// and BOTH are swept against the story corpus like the caption is. The raw
// cluster headline never reaches a template.

/** Outlet tails and SEO fragments a feed headline drags along. Backstop only —
 *  the model is asked not to produce them; this catches it when it does. */
const HEADLINE_TAIL_RE =
  /\s*[|–—-]\s*(etimes|e-times|times of india|toi|hindustan times|ht city|pinkvilla|filmibeat|koimoi|news18|india today|ndtv|firstpost|indian express|the hindu|deccan herald|zoom|bollywood hungama|sacnilk|moneycontrol|business standard|dt next|republic world|outlook india|123telugu|gulte|tupaki|watch video|watch|photos?|pics?|exclusive|read more|full list|details inside)\s*$/i;

/**
 * WORD-BOUNDARY ELLIPSIS LAW. Truncate to `max` characters without ever cutting
 * mid-word: back up to the last space and mark the cut. A card that reads
 * "Chandu C" is worse than one that reads "Chandu…" — the first looks like a
 * bug, the second like an edit. Shared by the copy layer and the templates'
 * autoshrink fallback so both cut the same way.
 */
export function clampWords(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  // If there is no space in range the "word" is longer than the budget; a hard
  // cut is the only option left, and it still gets the ellipsis.
  const base = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,;:–—-]+$/, "")}…`;
}

/** Strip repeated tails ("… | Etimes | Times of India") and tidy punctuation. */
export function stripHeadlineTail(s: string): string {
  let out = s.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(HEADLINE_TAIL_RE, "").trim();
    if (next === out) break;
    out = next;
  }
  return out.replace(/[\s|,;:–—-]+$/, "").trim();
}

const CardCopySchema = z.object({
  id: z.string(),
  cardLine: z.string(),
  cardDek: z.string(),
});

const CaptionSchema = z.object({
  caption: z.string(),
  /** Per-story editorial card copy, keyed by the cluster id. */
  cards: z.array(CardCopySchema).default([]),
  /** Every person the model named — cross-checked against the sweep. */
  namesUsed: z.array(z.string()).default([]),
  /** Handles it believes exist. NEVER auto-tagged; they go to the badge board. */
  mentionCandidates: z.array(z.string()).default([]),
});

export interface CardCopy {
  cardLine: string;
  cardDek: string;
}

export const CARD_LINE_MAX = 90;
export const CARD_DEK_MAX = 120;

export interface NewsPackage {
  caption: string;
  /** Editorial card copy per cluster id — what templates render, never the raw headline. */
  cardCopy: Record<string, CardCopy>;
  captionHashtags: string[];
  commentHashtags: string[];
  /** §3 law 7 — for MANUAL verification. No tick, no tag. */
  badgeCheckBoard: { name: string; candidateHandle: string | null }[];
  pinnedComment: string;
  /** Non-empty ⇒ the caption was HELD; the strings are the unbacked names. */
  heldFor: string[];
}

/** Unicode-bold a headline's letters/digits (IG has no rich text). */
export function unicodeBold(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 65 && c <= 90) out += String.fromCodePoint(0x1d5d4 + (c - 65));
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(0x1d5ee + (c - 97));
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(0x1d7ec + (c - 48));
    else out += ch;
  }
  return out;
}

/** The seven editorial languages, for content-derived language tags. */
const TAG_LANGUAGES = ["Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Bengali", "Marathi"] as const;

/**
 * Languages the PACKAGE is actually about, read from the story TEXT.
 *
 * `cluster.language` is the language of the GATHER QUERY that found the story,
 * not the language of the film it is about — the 72nd NFA story was caught by
 * the Hindi query while being about Telugu and Malayalam films, and the package
 * went out tagged #HindiCinema. Tags now derive from language names appearing in
 * the headline and the editorial card copy. Falls back to the query language
 * only when the text names none, which is better than tagging nothing.
 */
export function packageLanguages(
  edition: ComposedEdition,
  cardCopy: Record<string, CardCopy> = {}
): string[] {
  const found = new Set<string>();
  for (const c of edition.cards) {
    const cl = c.resolved.story.cluster;
    const copy = cardCopy[cl.id];
    const text = `${cl.headline} ${copy?.cardLine ?? ""} ${copy?.cardDek ?? ""}`.toLowerCase();
    for (const lang of TAG_LANGUAGES) {
      if (text.includes(lang.toLowerCase())) found.add(lang);
    }
  }
  if (found.size > 0) return [...found];
  // Nothing named in the copy — fall back to the query languages.
  const fallback = new Set<string>();
  for (const c of edition.cards) {
    const l = c.resolved.story.cluster.language;
    if (l && (TAG_LANGUAGES as readonly string[]).includes(l)) fallback.add(l);
  }
  return [...fallback];
}

/** Base hashtags + per-story language/segment tags, deduped, capped at 30. */
export function buildHashtags(
  edition: ComposedEdition,
  cardCopy: Record<string, CardCopy> = {}
): string[] {
  const tags: string[] = ["#TBSI", "#TheBigScreenIndex", "#IndianCinema"];
  const seg = edition.cover?.segment ?? edition.cards[0]?.segment;
  if (seg) tags.push(`#${seg.badge.replace(/[^A-Za-z]/g, "")}`);
  for (const lang of packageLanguages(edition, cardCopy)) tags.push(`#${lang}Cinema`);
  for (const c of edition.cards) {
    const film = c.resolved.film?.title;
    if (film) tags.push("#" + film.replace(/[^A-Za-z0-9]/g, ""));
  }
  tags.push("#OTT", "#OTTRelease", "#MovieNews", "#FilmNews", "#NowStreaming", "#SouthCinema");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.toLowerCase();
    if (t.length <= 1 || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

function storyLines(stories: SelectedStory[]): string {
  return stories
    .map((s, i) => {
      const c = s.resolved.story.cluster;
      return (
        `${i + 1}. ${c.headline}\n` +
        `   outlets: ${c.outlets.join(", ")}\n` +
        `   verified: ${s.resolved.story.basis}\n` +
        `   source: ${s.resolved.story.sourceUrl}`
      );
    })
    .join("\n");
}

function buildPrompt(edition: ComposedEdition, istDate: string, retryFor?: string[]): string {
  const stories = edition.cover ? [edition.cover, ...edition.cards.filter((c) => c !== edition.cover)] : edition.cards;
  const seg = stories[0]!.segment;

  const idList = stories.map((s) => s.resolved.story.cluster.id).join(", ");

  let p = `Write an Instagram caption AND per-story card copy for @thebigscreenindex, an Indian cinema editorial page whose brand is ACCURACY.

DATE: ${istDate}
SEGMENT: ${seg.badge}
FORMAT: ${edition.format}

CONFIRMED STORIES — these are the ONLY facts you may use:
${storyLines(stories)}

STRUCTURE:
1. A headline line (I will apply unicode-bold — write it in plain text).
2. One short paragraph per story, in order.
3. A CTA question to the reader.
4. A share line.
5. This exact sign-off on its own last line: ${seg.signoff}

HARD RULES — these are editorial law, not style:
- NAME THE SOURCE for every fact: "confirmed by X", "per Y". A fact with no named source may not appear.
- ESTIMATES LAW: every trade/box-office figure is an estimate. Write "an estimated ₹X crore" — never a bare figure stated as settled fact.
- NO superlatives. Never "biggest", "huge", "stunning", "must-see", "shocking", "historic".
- NO fact that is not in the list above. Do not add context you remember.
- NAMES: prefer a person's FULL name. If a source printed only a short form, keep the source's form — do not expand it from memory, and do not invent a surname.
- Do not speculate about what a story means or what comes next.
- AWARDS ATTRIBUTION: a person-category award belongs to the PERSON, for the film — "Rajkumar Periasamy won Best Director for 'Amaran'", never "Amaran won Best Director". Film-category awards (Best Tamil Film, Best Feature Film) belong to the film. Getting this backwards misstates who was honoured.
- Under 150 words total.

CARD COPY — one entry per story id (${idList}), in "cards":
- "cardLine": the story as an editor would set it on a card. SENTENCE CASE — capitalise only the first word and genuine proper nouns (film titles, people, places, platforms). Do NOT Title Case It Like This. ≤${CARD_LINE_MAX} characters. NO outlet name, NO "| Etimes"-style tail, no SEO stuffing, no clickbait. It must read as a finished line, not a truncated one.
- Name the film's LANGUAGE or industry in the cardLine or cardDek when the sources state it ("the Malayalam thriller", "the Telugu drama") — the package's hashtags are derived from it, and a Telugu package must never go out tagged for another industry.
- "cardDek": one supporting clause, ≤${CARD_DEK_MAX} characters, adding a verified detail the cardLine omits. No source name (the card credits the outlet separately).
- Both obey every rule above — same facts, same names, same awards attribution, no superlatives.

Also return:
- "namesUsed": every person you named, in the caption OR in any card copy.
- "mentionCandidates": @handles you believe exist for those people (these are NEVER auto-tagged — a human verifies each).

Return JSON in EXACTLY this shape — "caption" is ONE string containing the whole caption with newlines, and "cards" is an ARRAY:
{"caption":"line one\\nline two\\n…","cards":[{"id":"c1","cardLine":"…","cardDek":"…"}],"namesUsed":["…"],"mentionCandidates":["@…"]}`;

  if (retryFor?.length) {
    p +=
      `\n\nNAME-DISCIPLINE VIOLATION — your previous caption named ` +
      `${retryFor.map((n) => `"${n}"`).join(", ")}, which does NOT appear anywhere in the story ` +
      `headlines, verification notes, or outlet names above. Regenerate the ENTIRE caption and ` +
      `name only people the sources themselves printed.`;
  }
  return p;
}

/**
 * Draft + sweep the caption, then assemble the package. ONE retry on a sweep
 * violation; a second failure HOLDS the caption (heldFor non-empty) rather than
 * shipping an unbacked name.
 */
export async function buildPackage(
  edition: ComposedEdition,
  istDate: string
): Promise<NewsPackage> {
  const hashtags = buildHashtags(edition);
  const empty: NewsPackage = {
    caption: "",
    cardCopy: {},
    captionHashtags: hashtags.slice(0, CAPTION_HASHTAGS),
    commentHashtags: hashtags.slice(CAPTION_HASHTAGS),
    badgeCheckBoard: [],
    pinnedComment: "",
    heldFor: [],
  };

  if (edition.format === "none") {
    return { ...empty, caption: "(no caption — no edition today)" };
  }

  const stories: VerifiedStory[] = [
    ...(edition.cover ? [edition.cover.resolved.story] : []),
    ...edition.cards.map((c) => c.resolved.story),
  ];

  let out: z.infer<typeof CaptionSchema> | null = null;
  let violations: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      out = await callClaudeJSON(
        buildPrompt(edition, istDate, attempt === 1 ? violations : undefined),
        CaptionSchema,
        "opus"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`  Caption draft failed — ${msg}`);
      return { ...empty, caption: `(caption unavailable — ${msg})` };
    }
    // ── EVERYTHING GENERATED IS SWEPT (ruling A) ─────────────────────────────
    // Caption, cardLine and cardDek are all sentence case, so a run of
    // capitalised words really is a name and the sweep works as designed.
    //
    // This is why cardLine is sentence case rather than Title Case: under Title
    // Case every 2–3 word phrase is name-shaped, and the first live run held a
    // valid caption over "A Box-Office Fall" and "Malayalam Action Film" —
    // neither a person. A guard that cries wolf gets switched off, so the copy
    // style bent to keep the guard real. A fabricated name on a CARD is the
    // worst kind: it is set in type on the image.
    const cardText = out.cards.map((c) => `${c.cardLine}\n${c.cardDek}`).join("\n");
    violations = sweepCaption(`${out.caption}\n${cardText}`, stories);
    if (violations.length === 0) break;
    log.warn(`  Caption name sweep flagged: ${violations.join(", ")}${attempt === 0 ? " — retrying once" : " — HELD"}`);
  }

  if (!out) return empty;
  if (violations.length > 0) {
    return { ...empty, caption: "(caption HELD — unbacked names)", heldFor: violations };
  }

  // Bold the first line — the headline.
  const lines = out.caption.trim().split("\n");
  const caption = [unicodeBold(lines[0] ?? ""), ...lines.slice(1)].join("\n");

  // Card copy, tail-stripped and hard-capped. The cap is a truncation of LAST
  // resort — the prompt asks for a finished line — so it cuts on a word
  // boundary and marks the cut, never mid-word.
  const cardCopy: Record<string, CardCopy> = {};
  for (const c of out.cards) {
    cardCopy[c.id] = {
      cardLine: clampWords(stripHeadlineTail(c.cardLine), CARD_LINE_MAX),
      cardDek: clampWords(stripHeadlineTail(c.cardDek), CARD_DEK_MAX),
    };
  }

  const board = out.namesUsed.map((name) => {
    const cand = out!.mentionCandidates.find((h) =>
      h.toLowerCase().replace(/[^a-z]/g, "").includes(name.toLowerCase().split(" ")[0] ?? "~")
    );
    return { name, candidateHandle: cand ?? null };
  });

  const sourceLines = buildSourceLines(stories);
  const pinned =
    `Sources:\n${sourceLines.join("\n")}` +
    `\n\nFigures are estimates where stated. Corrections go here.`;

  // Recomputed now that the editorial copy exists: language tags read the card
  // copy, which names the film's real language more reliably than the headline.
  const finalTags = buildHashtags(edition, cardCopy);

  return {
    caption,
    cardCopy,
    captionHashtags: finalTags.slice(0, CAPTION_HASHTAGS),
    commentHashtags: finalTags.slice(CAPTION_HASHTAGS),
    badgeCheckBoard: board,
    pinnedComment: pinned,
    heldFor: [],
  };
}
