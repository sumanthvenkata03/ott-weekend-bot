// src/research/cli.ts
// Ad-hoc runner: `tsx src/research/cli.ts "Manjummel Boys" 2024`. The first
// positional arg is the title; an optional trailing 4-digit arg is the year.
// `import "dotenv/config"` (first line) loads .env so keyed sources (youtube)
// see their env vars in standalone runs — without importing the eager config.
import "dotenv/config";
import { research } from "./index.js";

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
    console.error('Usage: tsx src/research/cli.ts "<film title>" [year]');
    process.exit(1);
  }

  const result = await research({ title, ...(year !== undefined ? { year } : {}) });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
