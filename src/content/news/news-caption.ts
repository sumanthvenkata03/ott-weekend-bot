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

const CaptionSchema = z.object({
  caption: z.string(),
  /** Every person the model named — cross-checked against the sweep. */
  namesUsed: z.array(z.string()).default([]),
  /** Handles it believes exist. NEVER auto-tagged; they go to the badge board. */
  mentionCandidates: z.array(z.string()).default([]),
});

export interface NewsPackage {
  caption: string;
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

/** Base hashtags + per-story language/segment tags, deduped, capped at 30. */
export function buildHashtags(edition: ComposedEdition): string[] {
  const tags: string[] = ["#TBSI", "#TheBigScreenIndex", "#IndianCinema"];
  const seg = edition.cover?.segment ?? edition.cards[0]?.segment;
  if (seg) tags.push(`#${seg.badge.replace(/[^A-Za-z]/g, "")}`);
  for (const c of edition.cards) {
    const lang = c.resolved.story.cluster.language;
    if (lang) tags.push(`#${lang}Cinema`);
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

  let p = `Write an Instagram caption for @thebigscreenindex, an Indian cinema editorial page whose brand is ACCURACY.

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
- Under 150 words total.

Also return:
- "namesUsed": every person you named.
- "mentionCandidates": @handles you believe exist for those people (these are NEVER auto-tagged — a human verifies each).`;

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
    violations = sweepCaption(out.caption, stories);
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

  return {
    caption,
    captionHashtags: hashtags.slice(0, CAPTION_HASHTAGS),
    commentHashtags: hashtags.slice(CAPTION_HASHTAGS),
    badgeCheckBoard: board,
    pinnedComment: pinned,
    heldFor: [],
  };
}
