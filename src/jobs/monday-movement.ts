// src/jobs/monday-movement.ts
import { ingestReleases } from "../ingestion/releases/index.js";
import { pickHiddenGems } from "../content/weekend/spotlight-picker.js";
import { generateMondayMovement, type DeckFacts } from "../content/weekend/monday-movement.js";
import { writeMovementToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { buildHashtags } from "../shared/hashtags.js";
import { renderMonMovement } from "../rendering/render-mon-movement.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";
import { editorialDateUTC, editorialTodayStamp, utcStamp, warnIfNotPostingDay } from "../shared/editorial-clock.js";
import { excludedKeysFor, recordFeatured, filmKey } from "../shared/featured-ledger.js";
import { buildManifest, manifestToLog, manifestToSlack, saveManifest, assertOrFlag } from "../shared/post-validator.js";
import type { Release } from "../shared/types.js";

// Strictly-unique max by a numeric key: returns a film's title ONLY if exactly
// one film holds the maximum value (a tie, or every value missing → null). The
// copywriter may mint a "highest/most" claim only for a dimension this names, so
// ties and gaps can never become false superlatives.
function uniqueMaxTitle(films: Release[], key: (r: Release) => number | undefined): string | null {
  let max = -Infinity;
  let title: string | null = null;
  let holders = 0;
  for (const f of films) {
    const v = key(f);
    if (typeof v !== "number") continue;
    if (v > max) {
      max = v;
      title = f.title;
      holders = 1;
    } else if (v === max) {
      holders++;
    }
  }
  return holders === 1 ? title : null;
}

async function main() {
  log.info("📰 Monday Movement job — starting");

  purgeExpired();

  warnIfNotPostingDay(1, "Mon Movement"); // 1 = Monday (IST)

  // Issue number is a pure function of today's date — compute once and reuse for
  // the ledger's same-issue self-exclusion AND for rendering/Slack below.
  const issueNumber = getIssueNumberForToday();

  // Anchor to the IST calendar date; the 90-day pool edge is UTC arithmetic
  // (setUTCDate) on that anchor, stamped with utcStamp — NOT date-fns
  // startOfDay/addDays/format (local time), which would drift near IST midnight.
  const anchor = editorialDateUTC();
  const endStr = utcStamp(anchor);

  // Mon Movement is the CATCH-UP pillar: no this-week arrivals anymore (Wed Drop
  // owns ALL new OTT). Monday owns the catalog — pull a wide 90-day pool and
  // surface the hidden gems worth pulling up now.
  const gemPoolStartDate = new Date(anchor);
  gemPoolStartDate.setUTCDate(anchor.getUTCDate() - 90);
  const gemPoolStart = utcStamp(gemPoolStartDate);
  log.info(`Fetching gem pool: ${gemPoolStart} → ${endStr}`);
  const gemPool = await ingestReleases(gemPoolStart, endStr);
  log.info(`Gem pool: ${gemPool.length} candidates`);

  // Cross-pillar dedup: Mon (catalog) shares the OTT lane with Wed Drop (new), so
  // drop anything that lane featured recently (excludeIssue lets a same-issue
  // re-run ignore its own prior featuring). Catch-up framing means the overlooked,
  // not the films midweek already covered.
  const excluded = excludedKeysFor("mon", { excludeIssue: issueNumber });
  const gemPoolDeduped = gemPool.filter(r => !excluded.has(filmKey(r)));
  const droppedDupes = gemPool.length - gemPoolDeduped.length;
  if (droppedDupes > 0) log.info(`Dedup: removed ${droppedDupes} already-featured film(s) from the gem pool`);

  // Feed more candidates than we'll card (no arrivals to share the slate now).
  const gems = pickHiddenGems(gemPoolDeduped, 12);

  log.info(`Top hidden gems picked:`);
  for (const g of gems) {
    console.log(
      `  ${g.title.padEnd(34)} ${g.language.padEnd(10)} ${g.platform.join(", ") || "TBA"}` +
      (g.imdbRating ? ` — IMDb ${g.imdbRating}` : "")
    );
  }

  if (gems.length === 0) {
    log.warn("No gems to feature — aborting");
    return;
  }

  // Verified deck facts — the ONLY superlatives/exclusivity claims the copywriter
  // is allowed to make. Computed over the candidate pool `gems` (a superset of
  // what the LLM will card), so a unique max here holds for any shown subset and
  // uniqueness is conservative: a tie in the superset yields no claim at all.
  const topImdbTitle = uniqueMaxTitle(gems, r => r.imdbRating);
  const topTbsiTitle = uniqueMaxTitle(gems, r => r.tbsiScore);
  const topVotesTitle = uniqueMaxTitle(gems, r => r.imdbVotes);

  const titlesByLanguage = new Map<string, string[]>();
  for (const g of gems) {
    const titles = titlesByLanguage.get(g.language) ?? [];
    titles.push(g.title);
    titlesByLanguage.set(g.language, titles);
  }
  const soleLanguageMap: Record<string, string> = {};
  for (const [lang, titles] of titlesByLanguage) {
    if (titles.length === 1) soleLanguageMap[lang] = titles[0]!;
  }

  // Build with conditional spreads so no field is ever explicitly `undefined`
  // (strict exactOptionalPropertyTypes).
  const deckFacts: DeckFacts = {
    ...(topImdbTitle ? { topImdbTitle } : {}),
    ...(topTbsiTitle ? { topTbsiTitle } : {}),
    ...(topVotesTitle ? { topVotesTitle } : {}),
    ...(Object.keys(soleLanguageMap).length > 0 ? { soleLanguageMap } : {}),
  };

  const draft = await generateMondayMovement([], gems, gemPoolStart, endStr, deckFacts);

  if (draft.slides.length === 0) {
    log.info("Mon Movement: LLM returned no worthwhile films this week — skipping pillar.");
    return;
  }

  const bodySlides = draft.slides.filter(s => s.type === "arrival" || s.type === "gem");
  log.info(`Catch-up: ${bodySlides.length} gems`);

  log.info(`Week headline: "${draft.weekHeadline}"`);
  log.info(`Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);

  // Render PNGs
  const dateStr = editorialTodayStamp();
  log.info(`Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderMonMovement(draft, issueNumber, "output/posts");

  // Strict guard — Mon Movement's design contract is 4–10 body cards (up to 10).
  if (renderResult.cardPaths.length < 4 || renderResult.cardPaths.length > 10) {
    throw new Error(
      `Mon Movement produced ${renderResult.cardPaths.length} cards; expected 4–10. ` +
      `Check the prompt or rerun.`
    );
  }

  // Upload to R2
  log.info("Uploading to R2...");
  const uploads = await uploadPngsToR2([
    { localPath: renderResult.coverPath, r2Key: `mon-movement/${dateStr}/cover.png` },
    ...renderResult.cardPaths.map((p, i) => ({
      localPath: p,
      r2Key: `mon-movement/${dateStr}/card-${String(i + 1).padStart(2, "0")}.png`,
    })),
  ]);
  const cover = uploads[0]!;
  const cardUploads = uploads.slice(1);

  // Build imageUrls keyed card1..cardN dynamically (sorted body-slide order, up to 10)
  const imageUrls: { cover: string; [k: string]: string } = { cover: cover.publicUrl };
  cardUploads.forEach((upload, i) => {
    imageUrls[`card${i + 1}`] = upload.publicUrl;
  });

  // Build richer factual hashtags from metadata + industry/platform umbrella
  // tags, merging the LLM's thematic tags. Used for BOTH Notion and Slack.
  const enrichedHashtags = buildHashtags([...draft.newArrivals, ...draft.hiddenGems], draft.hashtags);
  draft.hashtags = enrichedHashtags;

  // Write to Notion. If this throws, the R2 uploads above are already written
  // (immutable, 1-year cache) — log the orphaned keys for traceability, then
  // re-throw so the job's catch still fires the Slack failure alert.
  log.info("Writing Notion draft...");
  let url: string;
  try {
    url = await writeMovementToNotion(draft, imageUrls);
  } catch (err) {
    log.warn(
      `Notion write failed after R2 upload — ${uploads.length} orphaned R2 object(s) ` +
      `(immutable, 1-year cache): ${uploads.map(u => u.key).join(", ")}`
    );
    throw err;
  }

  // Resolve the films actually placed on the published cards (slide titles →
  // Release records; gem titles arrive prefixed "Hidden Gem: "). Used for BOTH
  // the landing manifest below and the cross-pillar ledger after Slack.
  const featuredTitles = new Set(
    draft.slides
      .filter(s => s.type === "arrival" || s.type === "gem")
      .map(s => s.title.replace(/^Hidden Gem:\s*/i, "").trim().toLowerCase())
  );
  const featured = [...draft.newArrivals, ...draft.hiddenGems]
    .filter(r => featuredTitles.has(r.title.trim().toLowerCase()));

  // Landing verifier: every carded film is a catch-up gem now, so each must show a
  // release date inside the 90-day pool window. Flags drift loudly (log + Slack);
  // HARD_FAIL_ON_INVALID (default off) would abort.
  const filmsForCheck = featured.map(f => ({ film: f, bucket: "gem" as const }));
  const manifest = buildManifest("Mon Movement", issueNumber, filmsForCheck, {
    gem: { start: gemPoolStart, end: endStr, dateField: "release", label: "Hidden Gems · 90d catch-up" },
  });
  log.info("\n" + manifestToLog(manifest));
  saveManifest(manifest, `output/manifests/mon-movement-${dateStr}.json`);
  assertOrFlag(manifest);

  // Slack with cover preview + all body-card previews (up to 10)
  log.info("Sending Slack notification...");
  await notifyDraftReady({
    pillar: "Mon Movement",
    emoji: "📰",
    title: draft.weekLabel,
    subtitle: draft.weekHeadline,
    notionUrl: url,
    metadata: {
      "Issue": String(issueNumber),
      "Films": String(bodySlides.length),
    },
    coverImageUrl: cover.publicUrl,
    bodyCardImageUrls: cardUploads.map(u => u.publicUrl),
    hashtags: enrichedHashtags,
    validation: manifestToSlack(manifest),
  });

  // Cross-pillar ledger: record the featured films AFTER notifyDraftReady so a
  // colliding pillar (Mon shares the OTT lane with Wed Drop) can't re-feature them.
  recordFeatured(featured, "mon", issueNumber);

  log.success(`\n✅ Mon Movement PREVIEW delivered — Notion page: ${url}`);
  log.success(`   Cover: ${cover.publicUrl}`);
}

main()
  .catch(async (err) => {
    log.error("Monday Movement job failed", err);
    await notifyJobFailure("Mon Movement", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
  });
