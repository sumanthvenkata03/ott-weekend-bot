// src/jobs/wednesday-drop.ts
import { getCandidates } from "../discovery/candidates.js";
import type { Release, Platform } from "../shared/types.js";
import { generateWednesdayDrop, MAX_WED_DROP_FILMS, parseLangOverrides, applyLangOverrides } from "../content/weekend/wednesday-drop.js";
import { writeWednesdayDropToNotion } from "../delivery/notion.js";
import { purgeExpired } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { notifyDraftReady, notifyJobFailure } from "../delivery/slack.js";
import { buildHashtags } from "../shared/hashtags.js";
import { renderWedDrop } from "../rendering/render-wed-drop.js";
import { closeBrowser } from "../rendering/renderer.js";
import { uploadPngsToR2 } from "../delivery/r2-upload.js";
import { getIssueNumberForToday } from "../shared/issue-number.js";
import { editorialDateUTC, editorialTodayStamp, utcStamp, warnIfNotPostingDay } from "../shared/editorial-clock.js";
import { EDITION_META, type WedDropEdition } from "../shared/wed-drop-edition.js";
import { excludedKeysFor, recordFeatured, filmKey, type PillarKey } from "../shared/featured-ledger.js";
import { buildManifest, manifestToLog, manifestToSlack, saveManifest, assertOrFlag } from "../shared/post-validator.js";
import { editionWindow, RECONCILE_LANGUAGES } from "../reconcile/run.js";
import { verifyCandidates } from "../reconcile/verify.js";
import { annotateWithAiReview, enforceVerification } from "../reconcile/ai-review.js";
import { decideGate, writeReview, enforcementAuditLines, WED_DROP_LABELS } from "../reconcile/gate.js";
import { capPoolForSelector } from "../reconcile/select.js";
import type { ReconcileResult } from "../reconcile/types.js";

/**
 * Manual one-off exclusion hook. WED_DROP_EXCLUDE is a comma-separated list of
 * TMDb ids and/or exact titles to pull from a renderable pool — for a film the
 * operator has verified shouldn't run (e.g. no real release this week). Applied
 * POST-GATE inside produceEdition (like the dedup), so it never feeds the gate
 * fingerprint: the --approve token stays valid and only the rendered set shrinks.
 */
function parseExcludeList(raw: string | undefined): { ids: Set<number>; titles: Set<string> } {
  const ids = new Set<number>();
  const titles = new Set<string>();
  for (const tok of (raw ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    const n = Number(tok);
    if (Number.isInteger(n) && String(n) === tok) ids.add(n);
    else titles.add(tok.toLowerCase());
  }
  return { ids, titles };
}

function isManuallyExcluded(r: Release, ex: { ids: Set<number>; titles: Set<string> }): boolean {
  if (r.tmdbId !== undefined && ex.ids.has(r.tmdbId)) return true;
  return ex.titles.has(r.title.trim().toLowerCase());
}

/**
 * Manual platform override hook. WED_DROP_PLATFORM is a ';'-separated list of
 * `Title=Platform` pairs, applied POST-GATE to a renderable pool for films whose
 * streaming partner JustWatch/TMDb didn't resolve but the operator has verified
 * from official sources. Applied BEFORE the LLM + render, so the copy, the
 * "NOW ON <platform>" card line, and the landing verifier all agree. Post-gate →
 * never touches the gate fingerprint (the --approve token stays valid).
 */
function parsePlatformOverrides(raw: string | undefined): Map<string, Platform> {
  const map = new Map<string, Platform>();
  for (const pair of (raw ?? "").split(";").map(s => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const title = pair.slice(0, eq).trim().toLowerCase();
    const platform = pair.slice(eq + 1).trim();
    if (title && platform) map.set(title, platform as Platform);
  }
  return map;
}

function applyPlatformOverrides(pool: Release[], overrides: Map<string, Platform>): { pool: Release[]; applied: number } {
  if (overrides.size === 0) return { pool, applied: 0 };
  let applied = 0;
  const out = pool.map(r => {
    const p = overrides.get(r.title.trim().toLowerCase());
    if (!p) return r;
    applied += 1;
    return { ...r, platform: [p] };
  });
  return { pool: out, applied };
}

/**
 * Produce ONE Wed Drop edition end-to-end from its own (un-merged) pool:
 * generate → (skip if 0 picks) → render → R2 → Notion → Slack. The two
 * editions ("theatrical" = In Theaters, "ott" = Now Streaming) are published
 * independently from the SAME issue number; the pools never merge.
 */
async function produceEdition(
  edition: WedDropEdition,
  pool: Release[],
  issueNumber: string,
  windowStart: string,
  windowEnd: string,
  auditLines: string[] = []
): Promise<void> {
  const meta = EDITION_META[edition];
  log.info(`\n— ${meta.notionTitle} — ${pool.length} candidate(s) in pool —`);

  // Cross-pillar dedup: drop any film this edition's lane featured recently.
  // OTT shares Mon Movement's lane (the real collision); Theatrical is its own.
  const pillarKey: PillarKey = edition === "ott" ? "wed-ott" : "wed-theatrical";
  const excluded = excludedKeysFor(pillarKey, { excludeIssue: issueNumber });
  const deduped = pool.filter(r => !excluded.has(filmKey(r)));
  const droppedDupes = pool.length - deduped.length;
  if (droppedDupes > 0) log.info(`  Dedup: dropped ${droppedDupes} already-featured film(s) from the ${edition} pool`);

  // Manual one-off exclusion (WED_DROP_EXCLUDE) — post-gate, hash-neutral. Pulls
  // operator-verified drops (e.g. a film with no real release this week).
  const manualExcluded = parseExcludeList(process.env.WED_DROP_EXCLUDE);
  const renderablePool = deduped.filter(r => !isManuallyExcluded(r, manualExcluded));
  const droppedManual = deduped.length - renderablePool.length;
  if (droppedManual > 0) log.info(`  Manual exclude (WED_DROP_EXCLUDE): removed ${droppedManual} film(s) from the ${edition} pool`);

  if (renderablePool.length === 0) {
    log.info(`  ${meta.notionTitle}: every candidate was featured recently or manually excluded — edition skipped.`);
    return;
  }

  // Manual platform override (WED_DROP_PLATFORM) — set operator-verified streaming
  // partners for films JustWatch/TMDb couldn't resolve. Applied here so the LLM
  // prompt, the card's "NOW ON <platform>" line, and the landing verifier agree.
  const platformOverrides = parsePlatformOverrides(process.env.WED_DROP_PLATFORM);
  const { pool: finalPool, applied: platformsSet } = applyPlatformOverrides(renderablePool, platformOverrides);
  if (platformsSet > 0) log.info(`  Platform override (WED_DROP_PLATFORM): set platform on ${platformsSet} film(s) in the ${edition} pool`);

  // Manual audio-language override (WED_DROP_LANG) — operator dial mirroring
  // WED_DROP_PLATFORM. Post-gate, applied before the LLM + render so the card's
  // language row reflects the operator-verified track — killing wrong-film bleed
  // (e.g. a mismatched OMDb "Russian" hit). Hash-neutral; audited to Slack below.
  const { pool: langPool, applied: langsSet } = applyLangOverrides(finalPool, parseLangOverrides(process.env.WED_DROP_LANG));
  const langAuditLines: string[] = [];
  if (langsSet > 0) {
    const line = `LANG override by operator: set audio language on ${langsSet} film(s) in the ${edition} pool`;
    log.warn(`  ${line}`);
    langAuditLines.push(line);
  }

  // Per-edition candidate cap (capPoolForSelector): the popularity slice applies
  // ONLY to the TMDb-pool portion — AI-net finds are CAP-EXEMPT so they always
  // reach the LLM selector instead of being amputated by the popularity sort
  // (they carry no tmdbPopularity and would otherwise sink below the cut). The
  // LLM remains the editorial filter (picks up to MAX or skips); this only
  // guarantees AI finds reach its INPUT, not that they get published.
  const featured = capPoolForSelector(langPool);
  log.info(`  Feeding ${featured.length} ${edition} candidates to the LLM (picks up to ${MAX_WED_DROP_FILMS} or skips)`);

  // Generate the edition's draft via Claude. `nameFlags` carries any copy
  // name-discipline violations (a hallucinated/out-of-data person named in copy)
  // that survived one retry — the offending film was dropped, and the flag is
  // surfaced to Slack below (never silently stripped).
  const draft = await generateWednesdayDrop(featured, edition, windowStart, windowEnd);

  if (draft.slides.length === 0) {
    log.info(`  ${meta.notionTitle}: edition skipped — no films worth publishing this week.`);
    return;
  }

  log.info(`  Caption (${draft.caption.length} chars): ${draft.caption.slice(0, 100)}...`);
  log.info(`  LLM picked: ${draft.releases.map(r => `${r.title} (${r.language})`).join(", ")}`);

  // Render PNGs (edition-scoped filenames: wed-drop-{slug}-{date}-…).
  const dateStr = editorialTodayStamp();

  // Landing verifier: every carded film must show the right kind of date inside
  // this edition's window — OTT date for "Now Streaming", theatrical date for
  // "In Theaters". Flags drift loudly; HARD_FAIL_ON_INVALID (off) would abort.
  const vbucket = edition === "ott" ? ("ott" as const) : ("theatrical" as const);
  const manifest = buildManifest(`Wed Drop · ${meta.slackLabel}`, issueNumber,
    draft.releases.map(f => ({ film: f, bucket: vbucket })),
    { [vbucket]: { start: windowStart, end: windowEnd, dateField: vbucket === "ott" ? "ott" : "theatrical", label: meta.notionTitle } });
  log.info("\n" + manifestToLog(manifest));
  saveManifest(manifest, `output/manifests/wed-drop-${meta.slug}-${dateStr}.json`);
  assertOrFlag(manifest);

  log.info(`  Rendering PNGs (Issue ${issueNumber})...`);
  const renderResult = await renderWedDrop(draft, issueNumber, edition, "output/posts");

  // Strict guard — one card per picked film. The 0-films (skip) case already
  // returned above, so at render time we expect 1..MAX.
  if (renderResult.cardPaths.length < 1 || renderResult.cardPaths.length > MAX_WED_DROP_FILMS) {
    throw new Error(
      `Wed Drop [${edition}] produced ${renderResult.cardPaths.length} cards; expected 1–${MAX_WED_DROP_FILMS}. ` +
      `Check the prompt or rerun.`
    );
  }

  // Upload to R2 under an edition-specific folder: wed-drop/{date}/{slug}/…
  log.info("  Uploading to R2...");
  const uploads = await uploadPngsToR2([
    { localPath: renderResult.coverPath, r2Key: `wed-drop/${dateStr}/${meta.slug}/cover.png` },
    ...renderResult.cardPaths.map((p, i) => ({
      localPath: p,
      r2Key: `wed-drop/${dateStr}/${meta.slug}/card-${String(i + 1).padStart(2, "0")}.png`,
    })),
  ]);
  const cover = uploads[0]!;
  const cardUploads = uploads.slice(1);

  // Build imageUrls keyed card1..cardN dynamically
  const imageUrls: { cover: string; [k: string]: string } = { cover: cover.publicUrl };
  cardUploads.forEach((upload, i) => {
    imageUrls[`card${i + 1}`] = upload.publicUrl;
  });

  // Build richer factual hashtags from metadata + industry/platform umbrella
  // tags, merging the LLM's thematic tags. Used for BOTH Notion and Slack.
  const enrichedHashtags = buildHashtags(draft.releases, draft.hashtags);
  draft.hashtags = enrichedHashtags;

  // Write to Notion (edition-titled page). If this throws, the R2 uploads above
  // are already written (immutable, 1-year cache) — log the orphaned keys for
  // traceability, then re-throw so the job's catch still fires the Slack alert.
  log.info("  Writing Notion draft...");
  let url: string;
  try {
    url = await writeWednesdayDropToNotion(draft, imageUrls, meta.notionTitle);
  } catch (err) {
    log.warn(
      `Notion write failed after R2 upload — ${uploads.length} orphaned R2 object(s) ` +
      `(immutable, 1-year cache): ${uploads.map(u => u.key).join(", ")}`
    );
    throw err;
  }

  // Slack notification (edition-labeled) with cover preview + card previews.
  // On the AUTO-publish path the enforcement audit (promoted / dropped /
  // suppressed) has no review ping to ride, so fold it — plus any copy
  // name-discipline flags — into the existing landing-verifier issues block,
  // where the operator already looks. (Blocked runs carry the audit in the
  // review Slack ping instead.)
  const validation = manifestToSlack(manifest);
  const extraIssues = [...auditLines, ...langAuditLines, ...draft.nameFlags];
  if (extraIssues.length > 0) {
    validation.issuesBlock = [validation.issuesBlock, ...extraIssues].filter(Boolean).join("\n");
  }
  log.info("  Sending Slack notification...");
  await notifyDraftReady({
    pillar: `Wed Drop · ${meta.slackLabel}`,
    emoji: "🎬",
    title: `${meta.slackLabel} · ${windowStart} → ${windowEnd}`,
    subtitle: draft.caption.slice(0, 200) + (draft.caption.length > 200 ? "…" : ""),
    notionUrl: url,
    metadata: {
      "Issue": String(issueNumber),
      "Films": String(draft.releases.length),
      "Languages": Array.from(new Set(draft.releases.map(r => r.language))).join(", "),
    },
    coverImageUrl: cover.publicUrl,
    bodyCardImageUrls: cardUploads.map(u => u.publicUrl),
    hashtags: enrichedHashtags,
    validation,
  });

  // Log the films actually placed on this edition's published cards so a
  // colliding pillar (Mon Movement shares the OTT lane) can't re-feature them.
  recordFeatured(draft.releases, pillarKey, issueNumber);

  log.success(`✅ ${meta.notionTitle} delivered — Notion page: ${url}`);
  log.success(`   Cover: ${cover.publicUrl}`);
}

/** Parse `--approve <hash>` / `--approve=<hash>` from argv (gate resume token). */
function parseApproveArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--approve");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find(a => a.startsWith("--approve="));
  if (eq) return eq.slice("--approve=".length);
  return undefined;
}

/** One-line reconciliation summary for the job log. */
function reconcileSummary(r: ReconcileResult): string {
  const added = r.reconciled
    .filter(f => f.status === "confirmed" && f.foundIn.length === 1 && f.foundIn[0] === "ai-net")
    .map(f => f.title);
  return (
    `  Reconcile [${r.pillar}]: ${r.counts.total} films — ` +
    `${r.counts.green}🟢 / ${r.counts.yellow}🟡 / ${r.counts.red}🔴 · ` +
    `added by AI net: ${r.counts.addedByAiNet}${added.length ? ` (${added.join(", ")})` : ""} · ` +
    `rejected: ${r.rejected.length}`
  );
}

async function main() {
  log.info("🎬 Wednesday Drop job — starting");

  purgeExpired();

  // Gate resume token (binds approval to the exact reviewed list).
  const approveHash = parseApproveArg(process.argv.slice(2));

  warnIfNotPostingDay(3, "Wed Drop"); // 3 = Wednesday (IST)

  // Two deliberately different windows, both anchored on the CURRENT IST calendar
  // week (Mon..Sun). Derived by UTC arithmetic on the editorial anchor (00:00Z of
  // the IST date) and stamped with utcStamp — NEVER date-fns startOfWeek/format,
  // which run in local time and would drift the window off IST near midnight:
  //  - THEATRICAL = this weekend's cinema openings → Wed→Sun. Users check
  //    midweek for the weekend's theatrical releases, so the window opens on
  //    Wednesday. Mon/Tue theatrical is intentionally Mon Movement's domain and
  //    is left out here.
  //  - OTT = this week's digital drops → Mon→Sun. Streaming stays watchable all
  //    weekend, so this week's earlier OTT arrivals still belong in the post.
  const anchor = editorialDateUTC();
  const dow = anchor.getUTCDay();                     // 0=Sun … 6=Sat (IST)
  const weekStartMon = new Date(anchor);
  weekStartMon.setUTCDate(anchor.getUTCDate() - ((dow + 6) % 7)); // back to Monday
  const wednesday = new Date(weekStartMon);
  wednesday.setUTCDate(weekStartMon.getUTCDate() + 2);
  const sunday = new Date(weekStartMon);
  sunday.setUTCDate(weekStartMon.getUTCDate() + 6);

  const startDate = utcStamp(wednesday);
  const endDate = utcStamp(sunday);
  const ottStartDate = utcStamp(weekStartMon);

  log.info(`Theatrical window: ${startDate} → ${endDate}  |  OTT window: ${ottStartDate} → ${endDate}`);

  // 1. FIND the two pools SEPARATELY via the shared discovery surface (Step 5a) —
  //    NOT merged. Each becomes its own independent edition (theatrical = In
  //    Theaters, ott = Now Streaming). getCandidates(intent:"ott") now also runs
  //    the AI-search OTT net (Step 3), so press-confirmed OTT releases TMDb's
  //    release_type=4 misses (the Blast case) finally surface in a real drop.
  //    Languages default to the full 8 (find-8); verify-corroborate is also 8.
  const [theatrical, ott] = await Promise.all([
    getCandidates({ from: startDate, to: endDate, intent: "theatrical" }),       // THEATRICAL — Wed→Sun
    getCandidates({ from: ottStartDate, to: endDate, intent: "ott" }),           // OTT — Mon→Sun (+ AI-search recall)
  ]);
  log.info(`Candidates: ${theatrical.length} theatrical (In Theaters) + ${ott.length} OTT (Now Streaming)`);

  // 2. Both editions share ONE issue number (it's a pure function of today's
  //    date — see issue-number.ts — so calling the producer twice can't
  //    double-increment it).
  const issueNumber = getIssueNumberForToday();

  // 3. RECONCILE — augment each TMDb pool with the AI-search net, resolve every
  //    lead to a TMDb id, and emit one provenance-tagged, tiered list per
  //    edition. AUGMENT-ONLY: every TMDb candidate survives; the AI net can only
  //    ADD films and annotate tier. Exactly ONE LLM extraction per edition.
  log.info("\n🔎 Reconciliation — cross-checking TMDb pools against the AI-search net...");
  // Shared verification surface (Step 4) — identical to the prior reconcileEdition:
  // same pillar values ("theatrical"/"ott"), same editionWindow, same languages,
  // same default cap (40) and live deps. AI-review stays OFF here (Wednesday runs
  // it explicitly on the blocked run below), so the gate hash is unchanged.
  const results: ReconcileResult[] = [
    await verifyCandidates(theatrical, { pillar: "theatrical", window: editionWindow("theatrical", startDate, endDate), languages: RECONCILE_LANGUAGES }),
    await verifyCandidates(ott, { pillar: "ott", window: editionWindow("ott", ottStartDate, endDate), languages: RECONCILE_LANGUAGES }),
  ];
  for (const r of results) log.info(reconcileSummary(r));

  // 4. AI-REVIEW (advisory verdict + actionable auto-demote) — runs BEFORE the
  //    gate now, on BOTH the review run AND the --approve re-run, so a SOURCED 🛑
  //    reject auto-removes its film from the renderable pool and the gate hash
  //    reflects the removal (the approved review == what renders). It changes no
  //    tier and only ever TIGHTENS. The batched web-search call is CACHED per
  //    edition (≤2/drop): the review run misses, the approve re-run hits (no LLM
  //    call) → identical verdicts → identical demotion → identical hash. Fails
  //    soft to "unavailable", which demotes nothing.
  await annotateWithAiReview(results);

  // 4b. ENFORCE (Phase 2) — act on the annotated verdicts, post-annotate/pre-gate.
  //     PROMOTE a search-corroborated single-net 🟡 to effective-🟢; DEMOTE any
  //     contradicted/unconfirmed film (or a denylist-only "confirm") out of the
  //     renderable pool; SUPPRESS a conflicting platform. WED_DROP_REQUIRE_PLATFORM
  //     (default true) additionally drops an OTT film left with no platform.
  //     Deterministic (no LLM, no clock) → a review-run and its --approve re-run
  //     enforce identically. Reads process.env directly (mirrors the other
  //     WED_DROP_* dials; config.ts untouched).
  const requireOttPlatform = !["false", "0"].includes((process.env.WED_DROP_REQUIRE_PLATFORM ?? "true").trim().toLowerCase());
  enforceVerification(results, { requireOttPlatform });

  // 5. GATE — AUTO-PUBLISH when the drop is fully verification-clean (see
  //    decideGate); otherwise block behind human approval, hashing over the
  //    (possibly demoted) set. The first blocked run writes the "Wed Drop —
  //    REVIEW" artifact and STOPS; a re-run with `--approve <hash>` renders only
  //    if the reviewed list still hashes the same. WED_DROP_ALWAYS_GATE=true is
  //    the kill-switch that forces the old always-block behavior. 🔴 and
  //    enforcement-removed films never render.
  const alwaysGate = ["true", "1"].includes((process.env.WED_DROP_ALWAYS_GATE ?? "").trim().toLowerCase());
  const decision = decideGate(results, {
    ...(approveHash ? { approveHash } : {}),
    alwaysGate,
  });
  log.info(`\n🚦 Gate: ${decision.mode} — ${decision.reason}`);

  if (!decision.proceed) {
    // writeReview delivers Notion + Slack independently and fails soft; it
    // returns the Notion URL ("" if that write failed). The review now SHOWS the
    // auto-removed films in their own section. Key the stop message to delivery so
    // the operator never sees "approve" guidance for a review that doesn't exist.
    const reviewUrl = await writeReview(results, decision.hash, WED_DROP_LABELS);
    if (reviewUrl) {
      log.warn(
        `\n⛔ Wed Drop GATED (hash ${decision.hash}). NOTHING rendered or published.\n` +
        `   Review: ${reviewUrl}\n` +
        `   Approve with:  npm run job:wednesday -- --approve ${decision.hash}`
      );
    } else {
      log.error(
        `\n⛔ Wed Drop GATED (hash ${decision.hash}) — ⚠ REVIEW NOT AVAILABLE (delivery failed).\n` +
        `   Do NOT approve blind; fix review delivery and re-run.`
      );
    }
    return;
  }

  // 6. Approved (or auto-published) — render only the approved (renderable) pools.
  log.success(`✅ Gate cleared (${decision.mode}, hash ${decision.hash}) — rendering approved editions.`);

  // WED_DROP_FORCE — the operator's disagree-lever against a flaky verdict. A
  // comma-separated list of TMDb ids / exact titles that re-admits ONLY
  // enforcement-DEMOTED films (they carry aiDemoted + a release) back into the
  // renderable pool. Never touches reconcile-🔴 or rejected-bucket leads (those
  // have no aiDemoted/release). Post-gate + hash-neutral (mirrors WED_DROP_EXCLUDE):
  // the --approve token stays valid; the operator owns the override, logged loudly
  // and carried into the Slack audit as "FORCED by operator". For a resolved
  // platform conflict, pair it with WED_DROP_PLATFORM (Decision 2).
  const forced = parseExcludeList(process.env.WED_DROP_FORCE);
  const forceLines: string[] = [];
  const readmitForced = (pillar: string, pool: Release[]): Release[] => {
    if (forced.ids.size === 0 && forced.titles.size === 0) return pool;
    const r = results.find((x) => x.pillar === pillar);
    if (!r) return pool;
    const have = new Set(pool.map((p) => p.id));
    const add: Release[] = [];
    for (const f of r.reconciled) {
      if (!f.aiDemoted || !f.release) continue; // ONLY enforcement-demoted films are forceable
      const match = (f.tmdbId !== undefined && forced.ids.has(f.tmdbId)) || forced.titles.has(f.title.trim().toLowerCase());
      if (!match || have.has(f.release.id)) continue;
      add.push(f.release);
      have.add(f.release.id);
      const line = `FORCED by operator: re-admitted "${f.title}" (was auto-removed: ${f.aiDemoted.demotionClass ?? f.aiDemoted.verdict})`;
      log.warn(`  WED_DROP_FORCE — ${line}`);
      forceLines.push(line);
    }
    return add.length ? [...pool, ...add] : pool;
  };
  const thePool = readmitForced("theatrical", decision.renderable.theatrical ?? []);
  const ottPool = readmitForced("ott", decision.renderable.ott ?? []);

  // Enforcement audit for the Slack notification. On AUTO runs there is no review
  // ping, so the promoted/dropped/suppressed audit rides the draft notification
  // (produceEdition folds it into the landing-issues block). Approved re-runs
  // already saw it in the review ping at block time, so only FORCE lines (a
  // render-time override) are surfaced there.
  const auditLines = [...(decision.mode === "auto" ? enforcementAuditLines(results) : []), ...forceLines];

  // Optional edition scope: WED_DROP_ONLY=ott|theatrical runs just that edition
  // (leaving the other's live assets/copy untouched) — e.g. re-publishing one
  // edition after a manual exclude without re-billing/re-posting the other.
  const onlyEdition = process.env.WED_DROP_ONLY?.trim().toLowerCase();
  const runThe = !onlyEdition || onlyEdition === "theatrical";
  const runOtt = !onlyEdition || onlyEdition === "ott";
  if (onlyEdition) log.info(`WED_DROP_ONLY=${onlyEdition} — running only the ${onlyEdition} edition this pass.`);

  if (!runThe) {
    log.info("In Theaters: skipped (WED_DROP_ONLY).");
  } else if (thePool.length > 0) {
    await produceEdition("theatrical", thePool, issueNumber, startDate, endDate, auditLines);
  } else {
    log.info("In Theaters: no approved/renderable films this week — edition skipped.");
  }

  if (!runOtt) {
    log.info("Now Streaming: skipped (WED_DROP_ONLY).");
  } else if (ottPool.length > 0) {
    await produceEdition("ott", ottPool, issueNumber, ottStartDate, endDate, auditLines);
  } else {
    log.info("Now Streaming: no approved/renderable films this week — edition skipped.");
  }

  log.success(`\n✅ Wed Drop run complete (Issue №${issueNumber}).`);
}

main()
  .catch(async (err) => {
    log.error("Wednesday Drop job failed", err);
    await notifyJobFailure("Wed Drop", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await closeBrowser();
  });
