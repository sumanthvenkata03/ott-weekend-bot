// scripts/machine-room/stream.check.ts
// THE SECOND SCRUB. M0 filters the logger's sinks, which covers every log.*
// call — but recon found real output that never touches the logger:
// news-edition.ts's BLOCK STRUCTURE dump and all of wed-drop-review-dump.ts are
// bare console.log. A UI streaming raw child stdout would re-leak on exactly
// those lines, so the server scrubs again on its side of the pipe.
//
// This is the file the mutation test disables.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRedactingLineSplitter, sseFrame, stripAnsi } from "./stream.js";
import { __resetSecretRegistry, registerSecrets } from "../../src/shared/redact.js";

const PLANTED = "planted-fake-secret-0123456789";

function collect(chunks: (string | Buffer)[], andFlush = true): string[] {
  const out: string[] = [];
  const s = createRedactingLineSplitter((l) => out.push(l));
  for (const c of chunks) s.push(c);
  if (andFlush) s.flush();
  return out;
}

beforeEach(() => __resetSecretRegistry());
afterEach(() => __resetSecretRegistry());

describe("line splitting", () => {
  it("emits complete lines and holds the partial one until flush", () => {
    const out: string[] = [];
    const s = createRedactingLineSplitter((l) => out.push(l));
    s.push("alpha\nbeta\ngam");
    expect(out).toEqual(["alpha", "beta"]);
    s.flush();
    expect(out).toEqual(["alpha", "beta", "gam"]);
  });

  it("reassembles a line split across chunk boundaries", () => {
    expect(collect(["hel", "lo wor", "ld\n"])).toEqual(["hello world"]);
  });

  it("strips the CR from Windows CRLF output", () => {
    expect(collect(["one\r\ntwo\r\n"])).toEqual(["one", "two"]);
  });

  it("accepts Buffers as well as strings", () => {
    expect(collect([Buffer.from("from a buffer\n", "utf8")])).toEqual(["from a buffer"]);
  });

  it("emits nothing extra on an empty flush", () => {
    expect(collect(["done\n"])).toEqual(["done"]);
  });
});

describe("REDACTION on the way to the stream", () => {
  it("a REGISTERED secret never reaches the stream — named marker instead", () => {
    registerSecrets({ MACHINE_ROOM_FAKE_SECRET: PLANTED });
    const lines = collect([`  bare console: [GET] "https://api.example.test/x?apikey=${PLANTED}": 401\n`]);
    expect(lines[0]).not.toContain(PLANTED);
    expect(lines[0]).toContain("<REDACTED:MACHINE_ROOM_FAKE_SECRET>");
  });

  it("an UNREGISTERED key is still caught by the pattern backstop", () => {
    const lines = collect(['[GET] "https://api.test/x?api_key=NEVER_REGISTERED_XYZ": 500\n']);
    expect(lines[0]).not.toContain("NEVER_REGISTERED_XYZ");
    expect(lines[0]).toContain("api_key=***");
  });

  it("scrubs a bearer header off stderr", () => {
    const lines = collect([`  Authorization: Bearer ${PLANTED}\n`]);
    expect(lines[0]).not.toContain(PLANTED);
    expect(lines[0]).toContain("Authorization: ***");
  });

  it("scrubs the trailing partial line too — flush is not an escape hatch", () => {
    registerSecrets({ MACHINE_ROOM_FAKE_SECRET: PLANTED });
    const lines = collect([`no newline apikey=${PLANTED}`]);
    expect(lines[0]).not.toContain(PLANTED);
  });

  it("a secret SPLIT ACROSS CHUNKS is still caught, because we buffer to a newline", () => {
    // This is the case a naive per-chunk scrub gets wrong: neither half matches.
    registerSecrets({ MACHINE_ROOM_FAKE_SECRET: PLANTED });
    const half = Math.floor(PLANTED.length / 2);
    const lines = collect([`apikey=${PLANTED.slice(0, half)}`, `${PLANTED.slice(half)}\n`]);
    expect(lines[0]).not.toContain(PLANTED);
    expect(lines[0]).toContain("<REDACTED:MACHINE_ROOM_FAKE_SECRET>");
  });

  it("leaves an ordinary line byte-identical", () => {
    expect(collect(["  Feeding 12 ott candidates to the LLM\n"])).toEqual([
      "  Feeding 12 ott candidates to the LLM",
    ]);
  });
});

describe("ANSI stripping — the log pane must not render escape codes", () => {
  it("strips the logger's colour codes from a streamed line", () => {
    // The repo's logger colours unconditionally, even into a pipe. Without this
    // the pane showed literal `[90m14:21:15[0m` on every line.
    const raw = "\x1b[90m14:21:15\x1b[0m \x1b[36mℹ\x1b[0m   Feeding 12 candidates\n";
    expect(collect([raw])).toEqual(["14:21:15 ℹ   Feeding 12 candidates"]);
  });

  it("strips before redacting, so an escape spliced INTO a secret cannot hide it", () => {
    registerSecrets({ MACHINE_ROOM_FAKE_SECRET: PLANTED });
    const half = Math.floor(PLANTED.length / 2);
    const raw = `apikey=${PLANTED.slice(0, half)}\x1b[0m${PLANTED.slice(half)}\n`;
    const out = collect([raw]);
    expect(out[0]).not.toContain(PLANTED.slice(0, half) + PLANTED.slice(half));
    expect(out[0]).toContain("<REDACTED:MACHINE_ROOM_FAKE_SECRET>");
  });

  it("leaves a line with no escapes untouched", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("sseFrame", () => {
  it("is a well-formed event frame terminated by a blank line", () => {
    expect(sseFrame("line", { n: 1, text: "hi" })).toBe('event: line\ndata: {"n":1,"text":"hi"}\n\n');
  });
  it("JSON-escapes a newline so one payload can never forge a second frame", () => {
    const f = sseFrame("line", { n: 1, text: "a\nb" });
    expect(f.split("\n\n")).toHaveLength(2);
    expect(f).toContain("\\n");
  });
});
