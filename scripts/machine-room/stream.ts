// scripts/machine-room/stream.ts
// CHILD OUTPUT → SSE LINES, SCRUBBED.
//
// WHY A SECOND SCRUB. M0 put redaction at the logger's sinks, which covers
// every log.* call. But recon found real output that never goes through the
// logger at all: news-edition.ts prints its BLOCK STRUCTURE dump with a bare
// console.log, wed-drop-review-dump.ts is entirely console.log/console.error,
// and any dependency can write to stdout whenever it likes. A UI that streams
// raw child stdout would re-leak on exactly those paths.
//
// So every line is passed through redactSecrets AGAIN here, in the SERVER's
// process, before it is emitted. The server imports shared/config, so its own
// registry is populated with the same values the child holds — the scrub is
// equally effective on this side of the pipe. Belt and braces: the child's
// logger already scrubbed most of it, and this catches the rest.
//
// Redaction is idempotent, so double-scrubbing costs nothing and changes
// nothing that was already clean.

import { redactSecrets } from "../../src/shared/redact.js";

/**
 * Strip SGR colour codes. The child writes to a pipe, not a TTY, but the repo's
 * logger colours unconditionally — so without this the log pane renders literal
 * `[90m14:21:15[0m` garbage on every line. The tee already strips; the stream
 * has to do it too.
 *
 * ESC is written as an explicit \x1b escape rather than an inline control byte,
 * so the pattern survives being read and rewritten by tooling that renders
 * control characters invisibly.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface LineSplitter {
  /** Feed a stdout/stderr chunk. Emits every COMPLETE line it now holds. */
  push(chunk: string | Buffer): void;
  /** Emit any trailing partial line (call on child close). */
  flush(): void;
}

/**
 * Split a byte stream into lines and hand each one, REDACTED, to `onLine`.
 *
 * Chunk boundaries do not respect lines, so a secret can be split across two
 * `data` events. Buffering until a newline is therefore not just tidiness — it
 * is what makes the scrub reliable, because redaction on a half-secret would
 * match nothing and emit the halves intact.
 *
 * Trailing \r is stripped so Windows CRLF output does not leave a stray
 * carriage return inside the JSON payload.
 */
export function createRedactingLineSplitter(onLine: (line: string) => void): LineSplitter {
  let buffer = "";

  // ANSI is stripped BEFORE redaction, so a secret cannot hide from the filter
  // by having a colour escape spliced through the middle of it — the same
  // ordering the logger's tee uses.
  const emit = (raw: string) => {
    onLine(redactSecrets(stripAnsi(raw.replace(/\r$/, ""))));
  };

  return {
    push(chunk: string | Buffer): void {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      // A pathological producer that never emits a newline would grow this
      // unboundedly; cut it loose at a generous ceiling rather than hold RAM.
      if (buffer.length > 1_000_000) {
        emit(buffer);
        buffer = "";
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        emit(buffer);
        buffer = "";
      }
    },
  };
}

/** One SSE frame. `event` defaults to "message" when omitted. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
