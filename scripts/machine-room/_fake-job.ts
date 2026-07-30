// scripts/machine-room/_fake-job.ts
// A SYNTHETIC child, used only to exercise the machine room's spawn → stream →
// exit path without running a real job:* script. It costs nothing and touches
// nothing.
//
// It deliberately does three things a real job does:
//   1. prints numbered lines, slowly, so streaming is observable rather than a
//      single flush at exit;
//   2. prints a PLANTED FAKE SECRET both through log.* AND through a bare
//      console.log — the bare path is the one M0's logger-level scrub cannot
//      reach, so it proves the server-side SSE scrub is doing real work;
//   3. exits NONZERO, so the failure path is exercised.
//
// The planted value is registered by the server via MACHINE_ROOM_FAKE_SECRET,
// which the verification harness sets on both processes.

import { log } from "../../src/shared/logger.js";

const SECRET = process.env.MACHINE_ROOM_FAKE_SECRET ?? "planted-fake-secret-0123456789";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  log.info("fake job starting");
  for (let i = 1; i <= 4; i++) {
    log.info(`  step ${i}/4 — working`);
    await sleep(250);
  }

  // (a) through the logger — M0's sink scrub should already handle this.
  log.warn(`  logger path: contacting upstream with apikey=${SECRET}`);

  // (b) a BARE console.log — bypasses the logger entirely, exactly like
  //     news-edition.ts's BLOCK STRUCTURE dump and wed-drop-review-dump.ts.
  //     Only the server-side scrub can catch this one.
  console.log(`  bare console path: [GET] "https://api.example.test/x?apikey=${SECRET}": 401`);

  // (c) stderr, for good measure.
  console.error(`  stderr path: Authorization: Bearer ${SECRET}`);

  await sleep(200);
  log.error("fake job failing on purpose");
  process.exit(3);
}

void main();
