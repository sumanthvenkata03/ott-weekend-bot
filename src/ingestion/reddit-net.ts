// src/ingestion/reddit-net.ts
// PART A — the Reddit discovery net, in SHADOW MODE (HARD LAW L2: findings are
// REPORTED only — they touch NO tier, NO card, NO ledger, NO reconcile). The
// shadow report IS the experiment's scoreboard: a console table + one Slack
// context block. Promotion to a real corroboration net is a future, separate
// ruling. ZERO cost: one Reddit RSS search per candidate film, no LLM.

import type { Platform, Release } from "../shared/types.js";
import { SUBREDDIT_MAP, fetchSubredditSearch, type RedditPost } from "./reddit-rss.js";
import { postToWebhook } from "../delivery/slack.js";
import { log } from "../shared/logger.js";

export type LeadVerdict = "NEW" | "KNOWN";

export interface RedditLead {
  film: string;
  sub: string;
  postTitle: string;
  link: string;
  publishedISO: string;
  platformHints: Platform[];
  verdict: LeadVerdict;
}

/** OTT-intent terms OR'd onto the title search — biases results toward
 *  "where is it streaming" threads rather than release-week news. */
const OTT_INTENT_TERMS = ["OTT", "streaming", "JioHotstar", "ZEE5", "Netflix", "Prime", "Aha", "SonyLIV"];

/** Canonical Platform ← the strings that name it in a Reddit title/snippet.
 *  Matched case-insensitively on word boundaries. "Other" is not matchable. */
const PLATFORM_PATTERNS: ReadonlyArray<{ canonical: Platform; re: RegExp }> = [
  { canonical: "Netflix", re: /\bnetflix\b/i },
  { canonical: "Prime Video", re: /\b(?:prime video|amazon prime|prime)\b/i },
  { canonical: "JioHotstar", re: /\b(?:jio ?hotstar|hotstar)\b/i },
  { canonical: "Aha", re: /\baha\b/i },
  { canonical: "SonyLIV", re: /\bsony ?liv\b/i },
  { canonical: "ZEE5", re: /\bzee ?5\b/i },
  { canonical: "Sun NXT", re: /\bsun ?nxt\b/i },
  { canonical: "ManoramaMAX", re: /\bmanorama ?max\b/i },
  { canonical: "Hoichoi", re: /\bhoichoi\b/i },
  { canonical: "Lionsgate Play", re: /\blionsgate ?play\b/i },
  { canonical: "Apple TV+", re: /\bapple tv\+?\b/i },
  { canonical: "MUBI", re: /\bmubi\b/i },
  { canonical: "Chaupal", re: /\bchaupal\b/i },
];

/** Build the per-film search query: exact title phrase + OTT-intent OR-group. */
export function buildNetQuery(title: string): string {
  return `"${title}" (${OTT_INTENT_TERMS.join(" OR ")})`;
}

/** Platform names named in a Reddit post's title+snippet, de-duplicated,
 *  matched against the existing Platform enum. */
export function detectPlatformHints(text: string): Platform[] {
  const hits: Platform[] = [];
  for (const { canonical, re } of PLATFORM_PATTERNS) {
    if (re.test(text) && !hits.includes(canonical)) hits.push(canonical);
  }
  return hits;
}

/**
 * Self-score a lead: KNOWN if EVERY hinted platform is already on the film's
 * release.platform (nothing new); NEW if a hint names a platform TMDb doesn't
 * have yet (the corroboration signal we're shadow-testing). No hints ⇒ KNOWN
 * (a mention with no platform claim carries no new distribution info).
 */
export function scoreVerdict(hints: Platform[], filmPlatforms: readonly string[]): LeadVerdict {
  const known = new Set(filmPlatforms);
  return hints.every((h) => known.has(h)) ? "KNOWN" : "NEW";
}

/** Turn one film + its best matching post into a RedditLead. */
function toLead(film: Release, sub: string, post: RedditPost): RedditLead {
  const hints = detectPlatformHints(`${post.title} ${post.snippet}`);
  return {
    film: film.title,
    sub,
    postTitle: post.title,
    link: post.link,
    publishedISO: post.publishedISO,
    platformHints: hints,
    verdict: scoreVerdict(hints, film.platform),
  };
}

/**
 * SHADOW REPORT — the scoreboard. Console table + one Slack context block,
 * leads grouped NEW first. No-throw: reporting must never break a run.
 */
async function reportShadow(leads: RedditLead[]): Promise<void> {
  const ordered = [...leads].sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "NEW" ? -1 : 1));
  const newCount = leads.filter((l) => l.verdict === "NEW").length;
  const heading = `🔎 Reddit net (shadow): ${leads.length} leads · ${newCount} NEW`;

  log.info(heading);
  if (ordered.length > 0) {
    // eslint-disable-next-line no-console
    console.table(
      ordered.map((l) => ({
        verdict: l.verdict,
        film: l.film,
        sub: `r/${l.sub}`,
        hints: l.platformHints.join(", ") || "—",
        post: l.postTitle.slice(0, 60),
      }))
    );
  }

  const lines = ordered
    .slice(0, 10)
    .map((l) => `${l.verdict === "NEW" ? "🟢 NEW" : "· known"} · ${l.film} → r/${l.sub}${l.platformHints.length ? ` [${l.platformHints.join(", ")}]` : ""} — <${l.link}|thread>`);
  const text = `${heading}${lines.length ? "\n" + lines.join("\n") : ""}`;
  try {
    await postToWebhook([{ type: "context", elements: [{ type: "mrkdwn", text }] }], heading);
  } catch (err) {
    log.warn(`reddit-net: shadow Slack post failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Run the shadow net over the Wednesday candidate films: ONE search per film
 * against its language's sub (skipped for languages with no verified sub).
 * Returns the leads AND publishes the shadow report. Affects nothing else.
 */
export async function runRedditNet(films: Release[]): Promise<RedditLead[]> {
  const leads: RedditLead[] = [];
  for (const film of films) {
    const sub = SUBREDDIT_MAP[film.language];
    if (!sub) continue; // no owner-verified sub for this language → skip (never guess)
    const posts = await fetchSubredditSearch(sub, buildNetQuery(film.title));
    if (posts.length === 0) continue;
    leads.push(toLead(film, sub, posts[0]!)); // newest matching thread = the lead
  }
  await reportShadow(leads);
  return leads;
}
