// src/shared/verify-post.ts
// Zero-cost re-audit of a saved landing manifest. No network, no LLM.
// Usage: npx tsx src/shared/verify-post.ts output/manifests/mon-movement-2026-06-22.json
import { loadManifest, manifestToLog } from "./post-validator.js";
import { log } from "./logger.js";

const path = process.argv[2];
if (!path) { log.error("Usage: tsx src/shared/verify-post.ts <manifest.json>"); process.exit(1); }
const m = loadManifest(path);
log.info(manifestToLog(m));
log.info(`\n${m.ok ? "OK" : "FAILED"} - ${m.failCount} fail / ${m.warnCount} warn / ${m.passCount} pass`);
process.exit(m.ok ? 0 : 1);
