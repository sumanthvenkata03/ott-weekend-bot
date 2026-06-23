// src/research/consolidate-cli.ts
// Opt-in runner for the LLM consolidation layer:
//   tsx src/research/consolidate-cli.ts "<title>" [year]
// `import "dotenv/config"` (first line) loads .env so the youtube source sees
// its key; consolidation runs on the Max-plan `claude` CLI (no API key). This
// is SEPARATE from `npm run research` — that path stays model-free.
import "dotenv/config";
import { consolidateFilm } from "./consolidate.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // A trailing 4-digit arg (when there's also a title) is the release year.
  let year: number | undefined;
  const last = args[args.length - 1];
  if (args.length >= 2 && last && /^\d{4}$/.test(last)) {
    year = Number(last);
    args.pop();
  }

  const title = args.join(" ").trim();
  if (!title) {
    console.error('Usage: tsx src/research/consolidate-cli.ts "<film title>" [year]');
    process.exit(1);
  }

  const result = await consolidateFilm(title, year);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
