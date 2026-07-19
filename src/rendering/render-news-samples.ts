// src/rendering/render-news-samples.ts
// SAMPLE renders for the news card family — design/layout work with NO API
// calls and NO live gather (the render:* contract). Covers every format plus
// the edge cases the spec's §4.3 checks care about:
//
//   01 jn-skin              poster ground, giant numeral
//   02 jn-skin  LONG        autoshrink stress: very long title + long statement
//   03 register-single      MIXED — 2 poster + 2 typographic quadrants
//   04 register-single      ALL typographic (the no-art day)
//   05 register cover       mosaic + giant numeral + swipe line
//   06 register slide       ×3 seal + "Also honoured." overflow quadrant
//
// Run: npm run render:news

import { renderToPNG, closeBrowser } from "./renderer.js";
import { log } from "../shared/logger.js";

const OUT = "output/review/news";
const W = 1080;
const H = 1350;

// Stable public poster URLs (TMDb CDN). Sample data only — never reaches job:*.
const P1 = "https://image.tmdb.org/t/p/w500/2Nti3gYAX513wvhp8IiLL6ZDyOm.jpg";
const P2 = "https://image.tmdb.org/t/p/w500/wWba3TaojhK7NdycRhoQpsG0FaH.jpg";

const LONG_TITLE =
  "A Very Long Malayalam Psychological Thriller Title That Should Autoshrink Rather Than Overflow";

async function main(): Promise<void> {
  log.info("🗞  Rendering news card samples (no API, no gather)…");

  await renderToPNG({
    templateName: "news-radar-card",
    width: W, height: H, outputPath: `${OUT}/01-jn-skin.png`,
    data: {
      posterUrl: P1, cropPosition: "center 28%", darken: 0.66,
      eyebrow: "TBSI RADAR · OTT-DATE",
      title: "Balan The Boy",
      numeral: "JULY 31",
      facts: "REPUBLIC WORLD  ·  123TELUGU  ·  ZEE5",
      statement: "Balan The Boy locks its pan-Indian streaming date.",
      footer: "REPUBLIC WORLD · 2026-07-19",
    },
  });

  await renderToPNG({
    templateName: "news-radar-card",
    width: W, height: H, outputPath: `${OUT}/02-jn-skin-longtitle.png`,
    data: {
      posterUrl: P2, cropPosition: "center 30%", darken: 0.66,
      eyebrow: "TBSI RADAR · OTT-DATE · AUTOSHRINK STRESS",
      title: LONG_TITLE,
      numeral: "18",
      facts: "THE HINDU  ·  CINEMA EXPRESS  ·  THE NEW INDIAN EXPRESS  ·  HINDUSTAN TIMES",
      statement:
        "A deliberately overlong statement line that runs well past the natural measure of the card so the block autoshrink has something real to fight with.",
      footer: "THE HINDU · CINEMA EXPRESS · 2026-07-19",
    },
  });

  await renderToPNG({
    templateName: "news-register-card",
    width: W, height: H, outputPath: `${OUT}/03-register-single-mixed.png`,
    data: {
      quads: [
        { posterUrl: P1, cropPosition: "center 28%", film: "Balan The Boy",
          facts: ["TBSI RADAR · OTT-DATE"], credit: "REPUBLIC WORLD" },
        { film: "Maa Inti Bangaaram", facts: ["THE BUZZ · BOXOFFICE"], credit: "KOIMOI" },
        { posterUrl: P2, cropPosition: "center 30%", film: "Raayan",
          facts: ["THE BUZZ · AWARDS"], credit: "THE HINDU" },
        { film: "Committee Kurrollu", facts: ["THE BUZZ · AWARDS"], credit: "123TELUGU" },
      ],
    },
  });

  await renderToPNG({
    templateName: "news-register-card",
    width: W, height: H, outputPath: `${OUT}/04-register-single-alltypo.png`,
    data: {
      quads: [
        { film: "Feminichi Fathima", facts: ["TBSI RADAR · OTT-DATE"], credit: "THE HINDU" },
        { film: "Srikanth", facts: ["THE BUZZ · BOXOFFICE"], credit: "PINKVILLA" },
        { film: "A Title Long Enough To Need The Block Autoshrink Here",
          facts: ["THE BUZZ · CASTING"], credit: "GULTE" },
        { film: "35 – Chinna Katha Kaadu", facts: ["TBSI REGISTER · AWARDS"], credit: "SAKSHI POST" },
      ],
    },
  });

  await renderToPNG({
    templateName: "news-register-cover",
    width: W, height: H, outputPath: `${OUT}/05-register-cover.png`,
    data: {
      tiles: [
        { posterUrl: P1, film: "Balan The Boy" },
        { posterUrl: P2, film: "Raayan" },
        { film: "Committee Kurrollu" },
        { film: "Feminichi Fathima" },
      ],
      mosaicCols: 2,
      eyebrow: "TBSI REGISTER · 2026-07-19",
      numeral: "4",
      title: "72nd National Awards: the complete winners list.",
      factLine: "THE HINDU · CINEMA EXPRESS · 123TELUGU · BUSINESS STANDARD",
      swipeLine: "SWIPE FOR THE FULL LIST →",
    },
  });

  await renderToPNG({
    templateName: "news-register-card",
    width: W, height: H, outputPath: `${OUT}/06-register-seal-overflow.png`,
    data: {
      quads: [
        { posterUrl: P1, cropPosition: "center 28%", film: "Kalki 2898 AD", sealCount: 3,
          facts: ["BEST POPULAR FILM · WHOLESOME ENTERTAINMENT", "BEST PRODUCTION DESIGNER"],
          credit: "DIR. NAG ASHWIN" },
        { posterUrl: P2, cropPosition: "center 30%", film: "Amaran", sealCount: 2,
          facts: ["BEST DIRECTION · RAJKUMAR PERIASAMY", "BEST EDITING · R KALAIVANNAN"],
          credit: "SUN PICTURES" },
        { film: "Captain Miller",
          facts: ["BEST FILM · NATIONAL, SOCIAL & ENVIRONMENTAL VALUES"], credit: "DHANUSH" },
        { alsoHonoured: [
            { label: "BEST SUPPORTING ACTRESS · SHARED",
              lines: ["SACHANA NAMIDASS · MAHARAJA", "RAPSHREE VARKADY · MITHYA"] },
            { label: "SPECIAL MENTION", lines: ["DHANUSH · CAPTAIN MILLER", "MEIYAZHAGAN"] },
            { label: "BEST DEBUT DIRECTOR", lines: ["RANDEEP HOODA · SAVARKAR"] },
          ] },
      ],
    },
  });

  await closeBrowser();
  log.success(`  6 samples → ${OUT}/`);
}

const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
if (argv1.length > 0 && import.meta.url.endsWith(argv1)) {
  main().catch((err) => { log.error("news sample render failed", err); process.exit(1); });
}
