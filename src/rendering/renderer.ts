// src/rendering/renderer.ts
// Puppeteer-based template renderer.
// Loads HTML templates via Nunjucks, fills with data, screenshots as PNG.

import puppeteer, { Browser, Page } from "puppeteer";
import nunjucks from "nunjucks";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

// Long-form date filter for the Phase 5.6 "RELEASED" section.
// "2026-06-03" → "3 June 2026" (no leading zero on day, full month name).
env.addFilter("longDate", (input: unknown) => {
  if (!input || typeof input !== "string") return "";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
});

// Short-form date filter for the Mon Movement prototype info bar.
// "2024-02-15" → "15 Feb 2024" (3-letter month, no leading zero on day).
// Used with `| upper` to match the brass/ink mono treatment in .info-bar cells.
env.addFilter("shortDate", (input: unknown) => {
  if (!input || typeof input !== "string") return "";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
});

// Smart truncate: cuts at word boundaries, never mid-word
env.addFilter("truncate", (s: unknown, max = 80) => {
  const str = String(s ?? "").trim();
  if (str.length <= max) return str;
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

// Inline a platform logo SVG by filename stem (e.g. "netflix" → contents of netflix.svg).
// Returns "" when the stem is empty or the file is missing.
env.addFilter("platformLogoSvg", (stem: unknown) => {
  const slug = String(stem ?? "").trim();
  if (!slug) return "";
  try {
    const path = resolve(process.cwd(), "src/assets/platform-logos", `${slug}.svg`);
    const svg = readFileSync(path, "utf-8");
    return svg.replace(/<\?xml.*?\?>/, "").trim();
  } catch {
    return "";
  }
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
  templateName: string;
  data: Record<string, unknown>;
  width: number;
  height: number;
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

  // 3. Load HTML
  await page.setContent(html, {
    waitUntil: ["load", "networkidle0"],
    timeout: 30_000,
  });

  // 4. Explicitly wait for every <img> tag to load OR fail.
  //    This is more reliable than networkidle0 alone for CDN images
  //    (TMDb CDN can be slower than 500ms idle threshold).
  //
  //    First inject a __name shim: tsx/esbuild wraps arrow functions in
  //    __name(fn, "name") calls for Function.prototype.name preservation,
  //    and those calls travel into the page when Puppeteer serializes the
  //    function below. Without this shim, the evaluate throws ReferenceError.
  //    Passed as a string so esbuild can't transform it and re-create the bug.
  await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
  await page.evaluate(async () => {
    const imgs = Array.from(document.images);
    await Promise.all(
      imgs.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise<void>(resolve => {
          const done = () => resolve();
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
          // Safety net: don't wait more than 8s for any single image
          setTimeout(done, 8_000);
        });
      })
    );
  });

  // 5. Extra settle for fonts
  await new Promise(resolve => setTimeout(resolve, 250));

  // 6. Ensure output directory exists, then screenshot
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