// scripts/machine-room/proc.ts
// KILLING A shell:true CHILD ON WINDOWS.
//
// Found the hard way while building M1: the first run of the check suite left a
// server listening on its port after the test had "killed" it, and the process
// tree explained why —
//
//   vitest worker 25104
//     └─ cmd.exe shim 19728        ← what spawn() hands you as `child`
//          └─ node/tsx 48720       ← what is ACTUALLY doing the work
//
// `spawn(cmd, args, { shell: true })` returns a handle to the SHELL, not to the
// program. child.kill() therefore signals cmd.exe, which exits and orphans its
// grandchild — the job keeps running, keeps spending, and keeps holding its
// port and its file handles. Node has no portable tree-kill, and adding a
// dependency is forbidden here (and would land in the public Render build), so
// this shells out to taskkill, which ships with Windows.
//
// This is not a test-only concern. It is exactly what the server's SIGTERM
// handler needs: Ctrl+C on the machine room must actually stop the job it
// spawned, not merely detach from it.

import { spawn } from "node:child_process";

/**
 * Kill a process AND its descendants.
 *
 *   win32 → taskkill /PID <pid> /T /F   (/T = tree, /F = force)
 *   posix → process.kill(-pid) is unavailable without detached:true, so fall
 *           back to signalling the pid directly; on posix the shell usually
 *           exec's into the child anyway, so the handle is the program.
 *
 * Never throws: the process may already be gone, which is the desired end state.
 */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      const t = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      t.on("error", () => {
        /* taskkill missing — nothing further we can do */
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}
