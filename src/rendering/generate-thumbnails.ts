// src/rendering/generate-thumbnails.ts
// Resize every PNG in output/posts/ to 380px wide (aspect preserved)
// so we can audit Instagram feed-thumbnail readability without device testing.

import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { log } from "../shared/logger.js";

const INPUT_DIR = "output/posts";
const OUTPUT_DIR = "output/thumbnails";
const TARGET_WIDTH = 380;

async function main(): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const entries = await fs.readdir(INPUT_DIR);
  const pngs = entries.filter(f => f.toLowerCase().endsWith(".png"));

  if (pngs.length === 0) {
    log.warn(`No PNGs found in ${INPUT_DIR}/ — run a render command first.`);
    return;
  }

  log.info(`Generating ${TARGET_WIDTH}px thumbnails for ${pngs.length} PNG(s)…`);

  for (const filename of pngs) {
    const inputPath = path.join(INPUT_DIR, filename);
    const outputPath = path.join(OUTPUT_DIR, filename);
    await sharp(inputPath).resize({ width: TARGET_WIDTH }).toFile(outputPath);
    log.info(`  ✓ ${filename}`);
  }

  log.success(`Done — ${pngs.length} thumbnail(s) written to ${OUTPUT_DIR}/`);
}

main().catch(err => {
  log.error("Thumbnail generation failed", err);
  process.exitCode = 1;
});
