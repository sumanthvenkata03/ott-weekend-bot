// src/shared/post-validator.test.ts
// Pure-logic self-test for the landing verifier. No I/O, no network, no LLM.
// Run: npx tsx src/shared/post-validator.test.ts
import { log } from "./logger.js";
import { inWindow, qualifyingDate, buildManifest, type FilmInBucket } from "./post-validator.js";
import type { Release } from "./types.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) { pass++; log.info(`  OK ${label}`); } else { fail++; log.error(`  X FAIL: ${label}`); }
}

function film(p: Partial<Release>): Release {
  return { id: "x", title: "X", language: "Telugu", isSeries: false, platform: [], releaseDate: "2026-06-01", genre: [], cast: [], synopsis: "", subtitleLanguages: [], sources: [], fetchedAt: "", ...p } as Release;
}

check("inWindow inside", inWindow("2026-06-18", "2026-06-15", "2026-06-22"));
check("inWindow before", !inWindow("2026-05-08", "2026-06-15", "2026-06-22"));
check("qualifyingDate ott", qualifyingDate(film({ releaseDates: { ott: "2026-06-19" } }), "ott").date === "2026-06-19");
check("qualifyingDate release fallback", qualifyingDate(film({ releaseDate: "2026-04-10" }), "release").date === "2026-04-10");

const windows = {
  arrival: { start: "2026-06-15", end: "2026-06-22", dateField: "ott" as const, label: "arr" },
  gem: { start: "2026-03-24", end: "2026-06-22", dateField: "release" as const, label: "gem" },
  spotlight: { start: "2026-06-26", end: "2026-06-28", dateField: "release" as const, softWindow: true, label: "spot" },
};

const films: FilmInBucket[] = [
  { film: film({ id: "a", title: "GoodArrival", platform: ["Netflix"], releaseDates: { ott: "2026-06-19" } }), bucket: "arrival" },
  { film: film({ id: "b", title: "OutOfWindowArrival", platform: ["Netflix"], releaseDates: { ott: "2026-05-08" } }), bucket: "arrival" },
  { film: film({ id: "c", title: "NoOttArrival", platform: ["Netflix"] }), bucket: "arrival" },
  { film: film({ id: "d", title: "GoodGem", releaseDate: "2026-04-10" }), bucket: "gem" },
  { film: film({ id: "e", title: "OldGem", releaseDate: "2026-01-01" }), bucket: "gem" },
  { film: film({ id: "f", title: "GemSpotlight", releaseDate: "2026-01-01" }), bucket: "spotlight" },
  { film: film({ id: "g", title: "NoPlatformArrival", platform: [], releaseDates: { ott: "2026-06-18" } }), bucket: "arrival" },
];

const m = buildManifest("Test", "005", films, windows);
const byTitle = (t: string) => m.rows.find(r => r.title === t)!;

check("good arrival passes", byTitle("GoodArrival").status === "pass");
check("out-of-window arrival fails", byTitle("OutOfWindowArrival").status === "fail");
check("arrival missing OTT fails", byTitle("NoOttArrival").status === "fail");
check("good gem passes", byTitle("GoodGem").status === "pass");
check("old gem fails (hard window)", byTitle("OldGem").status === "fail");
check("old spotlight only warns (soft window)", byTitle("GemSpotlight").status === "warn");
check("no-platform arrival warns", byTitle("NoPlatformArrival").status === "warn");
check("manifest ok is false when any fail", m.ok === false);

log.info(`\npost-validator: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
