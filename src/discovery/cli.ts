// src/discovery/cli.ts
// Usage: tsx src/discovery/cli.ts <from> <to> [lang,lang,...]
//   from/to = ISO yyyy-mm-dd (inclusive). Languages default to all 8.
// Prints the union film list plus a stats summary that spells out the
// miss-detection (films only one net found).
import "dotenv/config";

import { discover, SUPPORTED_LANGUAGES } from "./index.js";
import type { DiscoveredFilm } from "./types.js";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  console.error("Usage: tsx src/discovery/cli.ts <from> <to> [lang,lang,...]");
  console.error(`  dates: ISO yyyy-mm-dd · languages: ${SUPPORTED_LANGUAGES.join(", ")} (default: all)`);
  process.exit(1);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// Accept either an ISO 639-1 code (te, ta, …) or a full name (Telugu, …).
const CODE_TO_LANGUAGE: Record<string, string> = {
  te: "Telugu", ta: "Tamil", ml: "Malayalam", kn: "Kannada",
  hi: "Hindi", bn: "Bengali", mr: "Marathi", pa: "Punjabi",
};
const NAME_BY_LOWER = new Map(SUPPORTED_LANGUAGES.map((n) => [n.toLowerCase(), n]));

/** Resolve language tokens (codes or names) to canonical names; warn on unknown. */
function resolveLanguages(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    const name = CODE_TO_LANGUAGE[lower] ?? NAME_BY_LOWER.get(lower);
    if (!name) {
      console.error(`⚠ unknown language "${t}" — skipping`);
      continue;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function tag(f: DiscoveredFilm): string {
  if (f.foundIn.length > 1) return "both";
  return f.foundIn[0] ?? "?";
}

// theatrical → thea, digital → digi, both → both, (wikipedia-only) → blank.
function relTag(f: DiscoveredFilm): string {
  if (!f.releaseType) return "";
  return f.releaseType === "theatrical" ? "thea" : f.releaseType === "digital" ? "digi" : "both";
}

function line(f: DiscoveredFilm): string {
  const date = f.releaseDate ?? "????-??-??";
  const approx = f.approximateDate ? "~" : " ";
  const year = f.year ?? "????";
  return `  ${approx}${date}  ${String(year)}  [${tag(f).padEnd(9)}]  ${relTag(f).padEnd(4)}  ${f.title}`;
}

async function main(): Promise<void> {
  const [from, to, langArg] = process.argv.slice(2);
  if (!from || !to) fail("missing <from> and/or <to>");
  if (!ISO_RE.test(from) || !ISO_RE.test(to)) fail("dates must be ISO yyyy-mm-dd");
  if (from > to) fail("<from> must be <= <to>");

  const languages = langArg
    ? resolveLanguages(langArg.split(",").map((s) => s.trim()).filter(Boolean))
    : SUPPORTED_LANGUAGES;
  if (langArg && languages.length === 0) fail("no valid languages supplied");

  const result = await discover({ from, to, languages });
  const { films, stats } = result;

  console.log(`\n=== Films ${from} → ${to} · ${result.query.languages.join(", ")} ===`);
  if (films.length === 0) {
    console.log("  (none)");
  } else {
    for (const f of films) console.log(line(f));
  }

  const wikiOnly = films.filter((f) => f.foundIn.length === 1 && f.foundIn[0] === "wikipedia");
  const tmdbOnly = films.filter((f) => f.foundIn.length === 1 && f.foundIn[0] === "tmdb");

  console.log(`\n=== Stats ===`);
  console.log(`  per-net candidates : tmdb ${stats.perNet.tmdb} · wikipedia ${stats.perNet.wikipedia}`);
  console.log(`  union (deduped)    : ${stats.unionCount}`);
  console.log(`  in BOTH nets       : ${stats.inBoth}`);
  console.log(`  only in TMDb       : ${stats.onlyInTmdb}`);
  console.log(`  only in Wikipedia  : ${stats.onlyInWikipedia}`);

  console.log(`\n--- MISS DETECTION: films Wikipedia found that TMDb did NOT (${wikiOnly.length}) ---`);
  if (wikiOnly.length === 0) console.log("  (none)");
  else for (const f of wikiOnly) console.log(line(f));

  console.log(`\n--- films only TMDb found (${tmdbOnly.length}) ---`);
  if (tmdbOnly.length === 0) console.log("  (none)");
  else for (const f of tmdbOnly) console.log(line(f));

  console.log("");
}

main().catch((err) => {
  console.error("✗ discovery failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
