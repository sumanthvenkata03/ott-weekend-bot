// src/delivery/deliver-deck-zip.ts
// Build the Instagram-ready deck: resize the rendered cover + body cards to EXACTLY
// 1080x1350, bundle them with the generated caption into sat-verdict-<date>.zip, and
// upload it to R2 under deliverables/ (public, short-lived cache). The zip is a
// convenience deliverable — callers must treat any failure as non-fatal (the deck
// PNGs are the real product). Also runnable standalone against an existing render dir:
//   npx tsx src/delivery/deliver-deck-zip.ts <dir> <date> [captionFile]

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import AdmZip from "adm-zip";
import { ofetch } from "ofetch";
import { uploadBufferToR2 } from "./r2-upload.js";
import { config } from "../shared/config.js";
import { log } from "../shared/logger.js";
import { editorialTodayStamp } from "../shared/editorial-clock.js";

// IG portrait, the size the deck ships at. Sources are exact multiples (cover 2x,
// cards 3x) so a fill-resize neither crops nor distorts — it only downscales.
const IG_WIDTH = 1080;
const IG_HEIGHT = 1350;

// FORMAT: quality-92, 4:4:4 (no chroma subsampling — protects the seal ring + cast
// hairline edges), progressive JPEG. PNG fallback is a one-line flip if text edges
// degrade (see the verify crop judgment).
const IG_FORMAT: "jpeg" | "png" = "jpeg";
const IG_EXT = IG_FORMAT === "jpeg" ? "jpg" : "png";

const CAPTION_HEADER = "DRAFT — review before posting; hand-built captions supersede this";
const CAPTION_PLACEHOLDER =
  "[no caption file found — the live job writes the generated caption here at deliver time]";

export interface DeckZipResult {
  /** Public R2 URL of the uploaded zip. */
  url: string;
  key: string;
  /** Carousel slides = cover + N body cards. */
  slideCount: number;
  /** Zip size in bytes. */
  sizeBytes: number;
  /** How the caption text was sourced: "arg" | "dir-file" | "placeholder". */
  captionSource: string;
}

export interface DeckZipOptions {
  /** Directory holding <slug>-<date>-cover.png + -card-NN.png. */
  outputDir: string;
  /** ISO date the deck is stamped with, e.g. "2026-07-11". */
  date: string;
  /** Explicit caption file (standalone --captionFile). Else the dir's caption file. */
  captionFile?: string;
  /** R2 key prefix. Default "deliverables"; verify uses "deliverables/_test". */
  keyPrefix?: string;
  /** Filename/key slug. Default "sat-verdict" (backward-compatible); Archives
   *  passes "tbsi-archives" so the same builder finds its PNGs + names its zip. */
  slug?: string;
}

/** Resize one rendered image to exactly 1080x1350 (lanczos) in the ship format. */
async function toIgImage(srcPath: string): Promise<Buffer> {
  const pipeline = sharp(srcPath).resize(IG_WIDTH, IG_HEIGHT, {
    kernel: sharp.kernel.lanczos3,
    fit: "fill",   // sources already 4:5 → fill = exact size, no crop, no distortion
  });
  return IG_FORMAT === "jpeg"
    ? pipeline.jpeg({ quality: 92, chromaSubsampling: "4:4:4", progressive: true }).toBuffer()
    : pipeline.png({ compressionLevel: 9 }).toBuffer();
}

/** Resolve the caption text + its source: explicit file → dir's caption file → placeholder. */
async function resolveCaption(opts: DeckZipOptions): Promise<{ text: string; source: string }> {
  const tryRead = async (p: string): Promise<string | null> => {
    try { return await readFile(p, "utf-8"); } catch { return null; }
  };
  if (opts.captionFile) {
    const t = await tryRead(opts.captionFile);
    if (t != null) return { text: t.trim(), source: "arg" };
    log.warn(`Caption file not readable: ${opts.captionFile} — falling back`);
  }
  const slug = opts.slug ?? "sat-verdict";
  const dirCaption = join(opts.outputDir, `${slug}-${opts.date}-caption.txt`);
  const t = await tryRead(dirCaption);
  if (t != null) return { text: t.trim(), source: "dir-file" };
  return { text: CAPTION_PLACEHOLDER, source: "placeholder" };
}

/**
 * Build sat-verdict-<date>.zip (ig/cover + ig/card-NN + caption-draft.txt) from a
 * rendered output dir and upload it to R2. Throws on a missing deck or upload
 * failure — the caller (job) wraps this so a failure degrades the Slack line
 * instead of aborting delivery.
 */
export async function buildAndUploadDeckZip(opts: DeckZipOptions): Promise<DeckZipResult> {
  const { outputDir, date } = opts;
  const keyPrefix = (opts.keyPrefix ?? "deliverables").replace(/\/+$/, "");
  const slug = opts.slug ?? "sat-verdict";

  // Discover this date's deck: one cover + card-NN.png, numeric order.
  const prefix = `${slug}-${date}-`;
  const entries = await readdir(outputDir);
  const coverName = `${prefix}cover.png`;
  if (!entries.includes(coverName)) {
    throw new Error(`cover not found: ${coverName} in ${outputDir}`);
  }
  const cardNames = entries
    .filter(e => e.startsWith(`${prefix}card-`) && e.endsWith(".png"))
    .sort();   // card-01, card-02, … zero-padded → lexical == numeric
  if (cardNames.length === 0) {
    throw new Error(`no card PNGs for ${date} in ${outputDir}`);
  }

  const zip = new AdmZip();

  zip.addFile(`ig/cover.${IG_EXT}`, await toIgImage(join(outputDir, coverName)));
  for (let i = 0; i < cardNames.length; i++) {
    const buf = await toIgImage(join(outputDir, cardNames[i]!));
    zip.addFile(`ig/card-${String(i + 1).padStart(2, "0")}.${IG_EXT}`, buf);
  }

  const caption = await resolveCaption(opts);
  const captionTxt = `${CAPTION_HEADER}\n\n${caption.text}\n`;
  zip.addFile("caption-draft.txt", Buffer.from(captionTxt, "utf-8"));

  const slideCount = 1 + cardNames.length;   // cover + body cards
  const zipBuf = zip.toBuffer();
  const key = `${keyPrefix}/${slug}-${date}.zip`;

  // deliverables/ = one-shot convenience downloads → short cache, NOT 1-year immutable.
  const { publicUrl } = await uploadBufferToR2(zipBuf, key, {
    contentType: "application/zip",
    cacheControl: "public, max-age=3600",
  });

  log.info(`  Deck zip: ${slideCount} slides (cover + ${cardNames.length}), ${(zipBuf.length / 1_048_576).toFixed(2)} MB, caption:${caption.source}`);
  return { url: publicUrl, key, slideCount, sizeBytes: zipBuf.length, captionSource: caption.source };
}

/**
 * Write the caption to the deck dir so the zip (and any later standalone re-deliver)
 * can pick it up. Called by the job at deliver time before building the zip.
 */
export async function writeCaptionFile(
  outputDir: string,
  date: string,
  caption: string,
  slug = "sat-verdict"
): Promise<void> {
  await writeFile(join(outputDir, `${slug}-${date}-caption.txt`), caption, "utf-8");
}

// ── Standalone entry (guarded — importing this module must NOT run main) ──────
// The `argv1.length > 0` clause is deliberate: `endsWith("")` is vacuously true, so
// without it the guard would fire whenever process.argv[1] is empty (e.g. `tsx -e`),
// running main on a mere import. This is the landmine to avoid.
const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMainModule = argv1.length > 0 && import.meta.url.endsWith(argv1);

if (isMainModule) {
  // usage: tsx src/delivery/deliver-deck-zip.ts [dir] [date] [captionFile] [--slack]
  //   dir  defaults to output/posts · date defaults to today (yyyy-MM-dd, the job's
  //   stamp) · positional args still override · --slack posts ONLY the deck link.
  const rawArgs = process.argv.slice(2);
  const wantSlack = rawArgs.includes("--slack");
  const [dirArg, dateArg, captionFile] = rawArgs.filter(a => a !== "--slack");
  const outputDir = dirArg ?? "output/posts";
  // IST editorial stamp (not local format) so a standalone re-deliver after local
  // midnight but before IST rollover no longer hunts the previous day's deck dir.
  const date = dateArg ?? editorialTodayStamp();
  const keyPrefix = process.env.DECK_KEY_PREFIX;   // verify sets deliverables/_test
  const slug = process.env.DECK_SLUG;              // Archives re-deliver sets tbsi-archives

  buildAndUploadDeckZip({ outputDir, date, ...(captionFile ? { captionFile } : {}), ...(keyPrefix ? { keyPrefix } : {}), ...(slug ? { slug } : {}) })
    .then(async r => {
      const mb = (r.sizeBytes / 1_048_576).toFixed(1);
      log.success(`✅ Deck zip uploaded (${r.slideCount} slides, ${mb} MB, caption:${r.captionSource})`);
      log.success(`   ${r.url}`);
      // --slack: post ONLY the deckZip context line (same line + block shape the
      // job's Slack draft uses), via the shared webhook. No flag → no post.
      if (wantSlack) {
        const line = `📦 IG-ready deck (${r.slideCount} slides, ${mb} MB): ${r.url}`;
        if (!config.SLACK_WEBHOOK_URL) {
          log.info("Slack webhook not configured — skipping --slack post");
        } else {
          await ofetch(config.SLACK_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { text: line, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: line }] }] },
          });
          log.success("   Slack: deck link posted");
        }
      }
    })
    .catch(err => {
      log.error("Deck zip failed", err);
      process.exit(1);
    });
}
