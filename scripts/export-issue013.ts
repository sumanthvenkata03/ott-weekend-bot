// scripts/export-issue013.ts
// One-off, OFFLINE export of the 7 issue-013 (weekend Jul 1-3 2026) raw research
// blobs from the SQLite cache into (a) the durable archive and (b) committed
// fixtures for the DIVISIVE calibration test. No network, read-only DB open.
//
//   npx tsx scripts/export-issue013.ts

import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RESEARCH_CACHE_VERSION, type RawResearch } from "../src/content/weekend/verdict-research.js";
import { archiveRawResearch } from "../src/content/weekend/research-archive.js";
import { log } from "../src/shared/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "src", "content", "weekend", "__fixtures__", "issue-013");

// id (cache-key tail) -> committed fixture slug. tt* are imdbId-keyed; Nevermind
// is title|date-keyed (no imdbId at research time).
const FILMS: { id: string; slug: string; label: string }[] = [
  { id: "tt37895011", slug: "rao-bahadur", label: "Rao Bahadur" },
  { id: "tt28363783", slug: "alpha", label: "Alpha" },
  { id: "tt32065777", slug: "nagabandham", label: "Nagabandham - The Secret Treasure" },
  { id: "tt37458495", slug: "gatta-kusthi-2", label: "Gatta Kusthi 2" },
  { id: "tt28089784", slug: "satluj", label: 'Satluj / "Punjab \'95"' },
  { id: "tt37544992", slug: "baby-do-die-do", label: "Baby Do Die Do" },
  { id: "Nevermind|2026-07-03", slug: "nevermind", label: "Nevermind" },
];

const dbPath = existsSync("data/cache-issue013-snapshot.sqlite")
  ? "data/cache-issue013-snapshot.sqlite"
  : "data/cache.sqlite";
log.info(`Source DB: ${dbPath} (read-only)`);

const db = new Database(dbPath, { readonly: true });
const get = db.prepare("SELECT value FROM http_cache WHERE key = ?");

mkdirSync(FIXTURE_DIR, { recursive: true });

const rows: { label: string; critics: number; explicit: (number | null)[]; sentiment: number[] }[] = [];
let missing = 0;

for (const { id, slug, label } of FILMS) {
  const key = `verdict-research:${RESEARCH_CACHE_VERSION}:${id}`;
  const row = get.get(key) as { value: string } | undefined;
  if (!row) {
    log.warn(`MISSING in cache: ${key}`);
    missing++;
    continue;
  }
  const raw = JSON.parse(row.value) as RawResearch;

  // (a) durable archive copy (write-if-absent, no-throw)
  archiveRawResearch(key, raw);

  // (b) committed fixture — the raw blob, pretty-printed
  writeFileSync(join(FIXTURE_DIR, `${slug}.json`), JSON.stringify(raw, null, 2), "utf8");

  const cr = raw.criticRatings ?? [];
  rows.push({
    label,
    critics: cr.length,
    explicit: cr.map(c => c.explicitScore),
    sentiment: cr.map(c => c.sentimentScore),
  });
}

console.log("\n=== issue-013 export ===");
console.log("key -> critic count -> explicit scores -> sentiment scores");
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(34)} n=${r.critics}  explicit=[${r.explicit.join(", ")}]  sentiment=[${r.sentiment.join(", ")}]`
  );
}
console.log(`\nWrote ${rows.length} fixture(s) to ${FIXTURE_DIR}`);
if (missing > 0) console.log(`WARNING: ${missing} film(s) missing from the cache DB.`);
