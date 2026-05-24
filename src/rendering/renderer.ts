// src/rendering/renderer.ts
// Puppeteer-based template renderer.
// Loads HTML templates via Nunjucks, fills with data, screenshots as PNG.

import puppeteer, { Browser, Page } from "puppeteer";
import nunjucks from "nunjucks";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../shared/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Nunjucks environment loads templates from /templates relative to this file
const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(join(__dirname, "templates")),
  { autoescape: true, throwOnUndefined: false }
);

// Custom filters used by templates
env.addFilter("upper", (s: unknown) => String(s ?? "").toUpperCase());

env.addFilter("date", (input: string, fmt: string) => {
  if (!input) return "";
  const d = new Date(input);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  switch (fmt) {
    case "dd-mm-yy":  return `${dd}·${mm}·${yy}`;
    case "dd-mm":     return `${dd}·${mm}`;
    case "weekday-dd-mm": {
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      return `${days[d.getUTCDay()]}·${dd}·${mm}`;
    }
    default: return input;
  }
});

// Smart truncate: cuts at word boundaries, never mid-word
env.addFilter("truncate", (s: unknown, max = 80) => {
  const str = String(s ?? "").trim();
  if (str.length <= max) return str;
  // Find the last space within the limit so we don't break mid-word
  const cutoff = str.slice(0, max - 1);
  const lastSpace = cutoff.lastIndexOf(" ");
  const safeCut = lastSpace > max * 0.6 ? cutoff.slice(0, lastSpace) : cutoff;
  return safeCut + "…";
});

// Pluralize: pluralize('film', 1) → 'film' · pluralize('film', 8) → 'films'
env.addFilter("pluralize", (singular: unknown, count: unknown, plural?: string) => {
  const n = Number(count);
  if (n === 1) return String(singular);
  return plural ?? `${singular}s`;
});

// Singleton browser — launched once per process, reused across renders
let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.connected) {
    log.info("Launching Chromium for rendering…");
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--font-render-hinting=none",
      ],
    });
  }
  return sharedBrowser;
}

/** Call once at the end of a job to release Chromium. */
export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}

export interface RenderOptions {
  /** Template filename without extension (e.g. "sat-verdict-cover") */
  templateName: string;
  /** Data passed to the Nunjucks template */
  data: Record<string, unknown>;
  /** Output dimensions */
  width: number;
  height: number;
  /** Absolute or project-relative path where the PNG is written */
  outputPath: string;
}

/**
 * Render an HTML template to a PNG file.
 * Returns the absolute path of the written file.
 */
export async function renderToPNG(options: RenderOptions): Promise<string> {
  const { templateName, data, width, height, outputPath } = options;

  // 1. Render template HTML
  const html = env.render(`${templateName}.html`, data);

  // 2. Set up browser + page
  const browser = await getBrowser();
  const page: Page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });

  // 3. Load HTML, wait for fonts + images
  await page.setContent(html, {
    waitUntil: ["load", "networkidle0"],
    timeout: 30_000,
  });

  // 4. Wait an extra tick for any web fonts (Playfair / Inter) to settle
  await new Promise(resolve => setTimeout(resolve, 250));

  // 5. Ensure output directory exists, then screenshot
  await mkdir(dirname(outputPath), { recursive: true });
  await page.screenshot({
    path: outputPath,
    type: "png",
    clip: { x: 0, y: 0, width, height },
  });

  await page.close();
  log.info(`  ✓ Rendered ${templateName} → ${outputPath}`);
  return outputPath;
}