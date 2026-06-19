// src/shared/wed-drop-edition.ts
// Wed Drop ships as TWO independent editions from one job run:
//   - "theatrical" → In Theaters (this weekend's cinema openings, Wed→Sun)
//   - "ott"        → Now Streaming (this week's digital drops, Mon→Sun)
// The two pools stay SEPARATE — no merge. This module is the single source of
// truth for the per-edition labels used across content framing, rendering
// (filenames + masthead), R2 paths, Notion titles, and Slack messages.

export type WedDropEdition = "theatrical" | "ott";

export interface WedDropEditionMeta {
  /** filename + R2 path segment: "theatrical" | "ott" */
  slug: string;
  /** masthead label baked into the cover + card templates */
  mastheadLabel: string;
  /** Notion page title prefix (full title is `${notionTitle} — ${dates}`) */
  notionTitle: string;
  /** short label for the Slack message header */
  slackLabel: string;
}

export const EDITION_META: Record<WedDropEdition, WedDropEditionMeta> = {
  theatrical: {
    slug: "theatrical",
    mastheadLabel: "IN THEATERS",
    notionTitle: "Wed Drop · In Theaters",
    slackLabel: "In Theaters",
  },
  ott: {
    slug: "ott",
    mastheadLabel: "NOW STREAMING",
    notionTitle: "Wed Drop · Now Streaming",
    slackLabel: "Now Streaming",
  },
};
