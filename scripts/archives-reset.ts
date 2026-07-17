// scripts/archives-reset.ts
// Owner-only reset for the Evergreens (TBSI Archives) PERMANENT no-repeat
// notebook. Backs up the cache DB, prints the current archives_featured rows,
// then clears THAT ONE TABLE.
//
// SAFETY: the only mutating statement in this file is a single hardcoded literal
// `DELETE FROM archives_featured`. There is no dynamic SQL anywhere — the table
// name is never interpolated — so the script is structurally incapable of
// touching any other table.
//
//   npm run archives:reset            → backup + list + DELETE + receipt
//   npm run archives:reset -- --list  → list only (no backup, no delete)

import { db } from "../src/shared/cache.js";

/** yyyyMMdd-HHmmss (local) for the backup filename. */
function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function formatVolume(vol: number): string {
  return String(vol).padStart(3, "0");
}

// ── Statements — every table name is a HARDCODED LITERAL (no dynamic SQL) ──
const existsStmt = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archives_featured'"
);
const listStmt = db.prepare(
  "SELECT vol, kind, title FROM archives_featured ORDER BY vol, title"
);
const countStmt = db.prepare("SELECT COUNT(*) AS c FROM archives_featured");
const deleteStmt = db.prepare("DELETE FROM archives_featured"); // THE ONLY mutating statement

interface Row {
  vol: number;
  kind: string;
  title: string | null;
}

function printRows(rows: Row[]): void {
  console.log(`Current archives_featured rows (${rows.length}):`);
  for (const r of rows) {
    console.log(`  VOL. ${formatVolume(r.vol)} · ${r.kind} · ${r.title ?? "—"}`);
  }
}

async function main(): Promise<void> {
  const listOnly = process.argv.includes("--list");

  // Friendly no-op if the notebook table was never created.
  if (!existsStmt.get()) {
    console.log("ℹ archives_featured does not exist yet — nothing to reset (no-op).");
    return;
  }

  // (1) Backup — skipped for --list. Consistent snapshot (WAL included).
  let bak = "";
  if (!listOnly) {
    bak = `${db.name}.bak-${timestamp()}`;
    await db.backup(bak);
    console.log(`Backup written: ${bak}`);
  }

  // (2) Print current rows (always).
  const rows = listStmt.all() as Row[];
  printRows(rows);

  if (listOnly) {
    console.log("(--list: view only — no backup, no delete)");
    return;
  }

  // (3) THE ONLY mutating statement — clears archives_featured and nothing else.
  const res = deleteStmt.run();

  // (4) Re-select, assert empty, print receipt.
  const remaining = (countStmt.get() as { c: number }).c;
  if (remaining !== 0) {
    throw new Error(`reset failed — ${remaining} row(s) still present after DELETE`);
  }
  console.log(`✔ Evergreens notebook cleared (${res.changes} rows). Backup: ${bak}`);
}

// Hardened main-module guard: truthiness on argv[1] first, so an empty argv can't
// make `endsWith("")` fire the script when it's merely imported.
const invokedPath = process.argv[1];
const isMainModule =
  !!invokedPath && import.meta.url.endsWith(invokedPath.replace(/\\/g, "/"));

if (isMainModule) {
  await main();
}
