// src/delivery/notion.ts
import { Client } from "@notionhq/client";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";
import type { Release } from "../shared/types.js";

const notion = new Client({ auth: config.NOTION_TOKEN });

export interface SundaySpotlightDraft {
  pillar: "Sun Spotlight";
  weekendDates: string;
  film: Release;                 // the single picked film
  caption: string;
  hashtags: string;
  reelScript: {
    hook: string;                // 0–3 sec
    whyItWorks: string;          // 3–15 sec, 3 specific reasons
    watchNote: string;           // 15–22 sec, subtitle/dub call-out
    cta: string;                 // 22–30 sec
    onScreenText: string[];      // 4 frames of text overlays
    visualDirection: string;     // shot list / B-roll notes
  };
  caseAgainstSkepticism: string; // reply template for "I don't watch X-language films"
}

export interface VerdictSlide {
  filmTitle: string;
  language: string;
  platform: string[];
  verdict: "🔥 Must Watch" | "👀 Worth a Try" | "⏭️ Skip";
  oneLineVerdict: string;
  watchIf: string;
  skipIf: string;
  whereItWins: string;
  whereItLoses: string;
  watchSetup: string;
}

export interface SaturdayVerdictDraft {
  pillar: "Sat Verdict";
  weekendDates: string;
  caption: string;
  hashtags: string;
  verdicts: VerdictSlide[];     // one per featured film
  hotTake: string;              // pinnable bold opinion for engagement
  releases: Release[];           // for Notion's relations / Platform / Language tags
}

export interface WednesdayDropDraft {
  pillar: "Wed Drop";
  weekendDates: string;         // e.g. "May 15 — May 17, 2026"
  caption: string;
  hashtags: string;
  releases: Release[];           // films included in this drop
  carouselSlides: string;        // markdown summary of 10-slide structure
}

export interface MovementDraft {
  pillar: "Mon Movement";
  weekLabel: string;             // "Week of May 4 — May 10, 2026"
  caption: string;
  hashtags: string;
  
  newArrivals: Release[];        // landed in last 7 days
  hiddenGems: Release[];         // older but worth surfacing
  
  carouselSlides: string;        // markdown summary of slide structure
  weekHeadline: string;          // 1-line takeaway, the post's spine
}

export async function writeMovementToNotion(draft: MovementDraft): Promise<string> {
  log.info("Writing Monday Movement draft to Notion...");
  
  const allReleases = [...draft.newArrivals, ...draft.hiddenGems];
  const allPlatforms = Array.from(new Set(allReleases.flatMap(r => r.platform)));
  const allLanguages = Array.from(new Set(allReleases.map(r => r.language)));
  
  const title = `Mon Movement — ${draft.weekLabel}`;
  
  const response = await notion.pages.create({
    parent: { database_id: config.NOTION_RELEASES_DB_ID },
    properties: {
      Name: { title: [{ text: { content: title } }] },
      Status: { status: { name: "Draft" } },
      Pillar: { select: { name: draft.pillar } },
      Platform: { multi_select: allPlatforms.map(p => ({ name: p })) },
      Language: { multi_select: allLanguages.map(l => ({ name: l })) },
      Verdict: { select: { name: "Pending" } },
      Caption: { rich_text: [{ text: { content: truncate(draft.caption) } }] },
      Hashtags: { rich_text: [{ text: { content: truncate(draft.hashtags, 500) } }] },
    },
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Week Headline" } }] },
      },
      {
        object: "block",
        type: "quote",
        quote: { rich_text: [{ text: { content: truncate(draft.weekHeadline, 500) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Caption" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: truncate(draft.caption) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Carousel Structure" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: truncate(draft.carouselSlides) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: `New OTT Arrivals (${draft.newArrivals.length})` } }] },
      },
      ...(draft.newArrivals.length === 0
        ? [{
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: { rich_text: [{ text: { content: "— none with confirmed digital releases this week" } }] },
          }]
        : draft.newArrivals.map(r => ({
            object: "block" as const,
            type: "bulleted_list_item" as const,
            bulleted_list_item: {
              rich_text: [{
                text: {
                  content: truncate(
                    `${r.title} (${r.language}) — ${r.releaseDate}` +
                    (r.platform.length ? ` — ${r.platform.join(", ")}` : "") +
                    (r.imdbRating ? ` — IMDb ${r.imdbRating}` : ""),
                    1900
                  ),
                },
              }],
            },
          }))),
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: `Hidden Gems Worth Surfacing (${draft.hiddenGems.length})` } }] },
      },
      ...draft.hiddenGems.map(r => ({
        object: "block" as const,
        type: "bulleted_list_item" as const,
        bulleted_list_item: {
          rich_text: [{
            text: {
              content: truncate(
                `${r.title} (${r.language})` +
                (r.platform.length ? ` — ${r.platform.join(", ")}` : "") +
                (r.imdbRating ? ` — IMDb ${r.imdbRating}` : ""),
                1900
              ),
            },
          }],
        },
      })),
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Hashtags" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: truncate(draft.hashtags, 1900) } }] },
      },
    ],
  });
  
  const url = (response as { url?: string }).url ?? "(no URL returned)";
  log.success(`Movement draft written to Notion: ${url}`);
  return url;
}

/**
 * Truncate text to Notion's 2000-char limit per rich_text block.
 * Notion rejects rich_text over 2000 chars per single property.
 */
function truncate(s: string, max = 1900): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export async function writeSundaySpotlightToNotion(
  draft: SundaySpotlightDraft
): Promise<string> {
  log.info("Writing Sunday Spotlight draft to Notion...");
  
  const title = `Sun Spotlight — ${draft.film.title} (${draft.film.language})`;
  const hypeScore = draft.film.imdbRating !== undefined
    ? Math.round(draft.film.imdbRating * 10)
    : null;
  
  const response = await notion.pages.create({
    parent: { database_id: config.NOTION_RELEASES_DB_ID },
    properties: {
      Name: { title: [{ text: { content: title } }] },
      Status: { status: { name: "Draft" } },
      Pillar: { select: { name: draft.pillar } },
      Platform: { multi_select: draft.film.platform.map(p => ({ name: p })) },
      Language: { multi_select: [{ name: draft.film.language }] },
      Verdict: { select: { name: "🔥 Must Watch" } },   // Spotlight = endorsement by definition
      ...(hypeScore !== null && { "Hype Score": { number: hypeScore } }),
      Caption: { rich_text: [{ text: { content: truncate(draft.caption) } }] },
      Hashtags: { rich_text: [{ text: { content: truncate(draft.hashtags, 500) } }] },
    },
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "The Film" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{
            text: {
              content: truncate(
                `${draft.film.title} (${draft.film.language}) — ${draft.film.releaseDate}\n` +
                `Director: ${draft.film.director ?? "—"}\n` +
                `Cast: ${draft.film.cast.slice(0, 4).join(", ") || "—"}\n` +
                `Platform: ${draft.film.platform.length ? draft.film.platform.join(", ") : "TBA"}\n` +
                (draft.film.imdbRating ? `IMDb: ${draft.film.imdbRating} (${draft.film.imdbVotes ?? 0} votes)\n` : "") +
                `\n${draft.film.synopsis}`
              ),
            },
          }],
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Caption" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: truncate(draft.caption) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Reel Script (30 sec)" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { text: { content: "Hook (0–3 sec): " }, annotations: { bold: true } },
            { text: { content: truncate(draft.reelScript.hook, 500) } },
          ],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { text: { content: "Why It Works (3–15 sec): " }, annotations: { bold: true } },
            { text: { content: truncate(draft.reelScript.whyItWorks, 1500) } },
          ],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { text: { content: "Watch Note (15–22 sec): " }, annotations: { bold: true } },
            { text: { content: truncate(draft.reelScript.watchNote, 800) } },
          ],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { text: { content: "CTA (22–30 sec): " }, annotations: { bold: true } },
            { text: { content: truncate(draft.reelScript.cta, 500) } },
          ],
        },
      },
      {
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ text: { content: "On-Screen Text Frames" } }] },
      },
      ...draft.reelScript.onScreenText.map((t, i) => ({
        object: "block" as const,
        type: "bulleted_list_item" as const,
        bulleted_list_item: {
          rich_text: [{ text: { content: `Frame ${i + 1}: ${truncate(t, 200)}` } }],
        },
      })),
      {
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ text: { content: "Visual Direction" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: truncate(draft.reelScript.visualDirection, 1500) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Hashtags" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: truncate(draft.hashtags, 1900) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: `Reply template — when someone says "I don't watch ${draft.film.language} films"` } }] },
      },
      {
        object: "block",
        type: "quote",
        quote: { rich_text: [{ text: { content: truncate(draft.caseAgainstSkepticism, 1900) } }] },
      },
    ],
  });
  
  const url = (response as { url?: string }).url ?? "(no URL returned)";
  log.success(`Spotlight draft written to Notion: ${url}`);
  return url;
}

/**
 * Push a Wednesday Drop draft as a row in the Releases DB.
 * Returns the page URL so you can open it directly.
 */
export async function writeWednesdayDropToNotion(
  draft: WednesdayDropDraft
): Promise<string> {
  log.info("Writing Wednesday Drop draft to Notion...");
  
  // Collect distinct platforms + languages across all featured releases
  const allPlatforms = Array.from(
    new Set(draft.releases.flatMap(r => r.platform))
  );
  const allLanguages = Array.from(
    new Set(draft.releases.map(r => r.language))
  );
  
  const title = `Wed Drop — ${draft.weekendDates}`;
  
  // Average hype across releases (Week 2 will populate this properly; for now use IMDb)
  const ratings = draft.releases
    .map(r => r.imdbRating)
    .filter((n): n is number => n !== undefined);
  const avgRating = ratings.length > 0
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : null;
  const hypeScore = avgRating !== null ? Math.round(avgRating * 10) : null;
  
  const response = await notion.pages.create({
    parent: { database_id: config.NOTION_RELEASES_DB_ID },
    properties: {
      Name: {
        title: [{ text: { content: title } }],
      },
      Status: {
        status: { name: "Draft" },
      },
      Pillar: {
        select: { name: draft.pillar },
      },
      Platform: {
        multi_select: allPlatforms.map(p => ({ name: p })),
      },
      Language: {
        multi_select: allLanguages.map(l => ({ name: l })),
      },
      Verdict: {
        select: { name: "Pending" },
      },
      ...(hypeScore !== null && {
        "Hype Score": { number: hypeScore },
      }),
      Caption: {
        rich_text: [{ text: { content: truncate(draft.caption) } }],
      },
      Hashtags: {
        rich_text: [{ text: { content: truncate(draft.hashtags, 500) } }],
      },
    },
    // Long-form content goes in the page body, not properties
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Caption" } }],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: truncate(draft.caption) } }],
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Hashtags" } }],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: truncate(draft.hashtags, 1900) } }],
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Carousel structure (10 slides)" } }],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: truncate(draft.carouselSlides) } }],
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: `Featured releases (${draft.releases.length})` } }],
        },
      },
      ...draft.releases.map(r => ({
        object: "block" as const,
        type: "bulleted_list_item" as const,
        bulleted_list_item: {
          rich_text: [{
            text: {
              content: truncate(
                `${r.title} (${r.language}) — ${r.releaseDate}` +
                (r.platform.length ? ` — ${r.platform.join(", ")}` : "") +
                (r.imdbRating ? ` — IMDb ${r.imdbRating}` : ""),
                1900
              ),
            },
          }],
        },
      })),
    ],
  });
  
  const url = (response as { url?: string }).url ?? "(no URL returned)";
  log.success(`Draft written to Notion: ${url}`);
  return url;
}

/**
 * Push a Saturday Verdict draft as a row in the Releases DB.
 * Different page body shape than Wed Drop — opinionated verdicts per film.
 */
export async function writeSaturdayVerdictToNotion(
  draft: SaturdayVerdictDraft
): Promise<string> {
  log.info("Writing Saturday Verdict draft to Notion...");
  
  const allPlatforms = Array.from(new Set(draft.releases.flatMap(r => r.platform)));
  const allLanguages = Array.from(new Set(draft.releases.map(r => r.language)));
  
  const title = `Sat Verdict — ${draft.weekendDates}`;
  
  // Average IMDb as proxy hype score (replaced in Week 2)
  const ratings = draft.releases
    .map(r => r.imdbRating)
    .filter((n): n is number => n !== undefined);
  const hypeScore = ratings.length > 0
    ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10)
    : null;
  
  // Pick the strongest verdict for the row-level Verdict select
  const verdictPriority: VerdictSlide["verdict"][] = ["🔥 Must Watch", "👀 Worth a Try", "⏭️ Skip"];
  const rowVerdict = verdictPriority.find(v => draft.verdicts.some(d => d.verdict === v)) 
    ?? "🔥 Must Watch";
  
  // Build the verdict slides as Notion blocks — toggles so each film is collapsible
  const verdictBlocks = draft.verdicts.flatMap(v => [
    {
      object: "block" as const,
      type: "toggle" as const,
      toggle: {
        rich_text: [{
          text: { content: `${v.verdict}  ${v.filmTitle} (${v.language})` },
          annotations: { bold: true },
        }],
        children: [
          {
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: {
              rich_text: [
                { text: { content: "Verdict: " }, annotations: { bold: true } },
                { text: { content: truncate(v.oneLineVerdict, 500) } },
              ],
            },
          },
          {
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: {
              rich_text: [
                { text: { content: "Watch if: " }, annotations: { bold: true } },
                { text: { content: truncate(v.watchIf, 500) } },
              ],
            },
          },
          {
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: {
              rich_text: [
                { text: { content: "Skip if: " }, annotations: { bold: true } },
                { text: { content: truncate(v.skipIf, 500) } },
              ],
            },
          },
          {
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: {
              rich_text: [
                { text: { content: "Where it wins: " }, annotations: { bold: true } },
                { text: { content: truncate(v.whereItWins, 500) } },
              ],
            },
          },
          {
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: {
              rich_text: [
                { text: { content: "Where it loses: " }, annotations: { bold: true } },
                { text: { content: truncate(v.whereItLoses, 500) } },
              ],
            },
          },
          {
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: {
              rich_text: [
                { text: { content: "Watch setup: " }, annotations: { bold: true } },
                { text: { content: truncate(v.watchSetup, 300) } },
              ],
            },
          },
          {
            object: "block" as const,
            type: "paragraph" as const,
            paragraph: {
              rich_text: [
                { text: { content: `Streaming on: ${v.platform.length ? v.platform.join(", ") : "TBA"}` } },
              ],
            },
          },
        ],
      },
    },
  ]);
  
  const response = await notion.pages.create({
    parent: { database_id: config.NOTION_RELEASES_DB_ID },
    properties: {
      Name: { title: [{ text: { content: title } }] },
      Status: { status: { name: "Draft" } },
      Pillar: { select: { name: draft.pillar } },
      Platform: { multi_select: allPlatforms.map(p => ({ name: p })) },
      Language: { multi_select: allLanguages.map(l => ({ name: l })) },
      Verdict: { select: { name: rowVerdict } },
      ...(hypeScore !== null && { "Hype Score": { number: hypeScore } }),
      Caption: { rich_text: [{ text: { content: truncate(draft.caption) } }] },
      Hashtags: { rich_text: [{ text: { content: truncate(draft.hashtags, 500) } }] },
    },
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Caption" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: truncate(draft.caption) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Hot Take (pin as comment for engagement)" } }] },
      },
      {
        object: "block",
        type: "quote",
        quote: { rich_text: [{ text: { content: truncate(draft.hotTake, 500) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Hashtags" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ text: { content: truncate(draft.hashtags, 1900) } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: `Verdicts (${draft.verdicts.length})` } }] },
      },
      ...verdictBlocks,
    ],
  });
  
  const url = (response as { url?: string }).url ?? "(no URL returned)";
  log.success(`Verdict draft written to Notion: ${url}`);
  return url;
}