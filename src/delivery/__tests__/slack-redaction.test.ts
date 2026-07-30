// CLASS D — the Slack OUTBOUND boundary.
//
// Every job's catch is `notifyJobFailure(pillar, err.message)`. For any client
// that carries its key in a query string (TMDb, OMDb, MDBList) that message is
// ofetch's `[GET] "<url including the key>": 401`. Before M0 an expired key
// therefore posted the key ITSELF into the Slack channel — a leak to a wider
// audience than the log ever had, and one no log-sink filter could reach.
//
// Asserts on the BUILT payload. No webhook, no network: buildJobFailureBlocks is
// exported precisely so this is provable, and ofetch is mocked for the
// notifyDraftReady path.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("ofetch", () => ({ ofetch: vi.fn(async () => ({})) }));
vi.mock("../../shared/config.js", () => ({
  config: { SLACK_WEBHOOK_URL: "https://hooks.slack.example/inbound" },
}));

import { ofetch } from "ofetch";
import { buildJobFailureBlocks, notifyDraftReady } from "../slack.js";
import { registerSecrets, __resetSecretRegistry } from "../../shared/redact.js";

const TMDB = "tmdb-live-key-9f8e7d6c5b4a3210";
const R2_SECRET = "r2-secret-access-key-aaaabbbbcccc";

beforeEach(() => {
  __resetSecretRegistry();
  vi.mocked(ofetch).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  __resetSecretRegistry();
  vi.restoreAllMocks();
});

describe("buildJobFailureBlocks — no registered secret survives into the payload", () => {
  it("scrubs a TMDb 401 ofetch message and names the key", () => {
    registerSecrets({ TMDB_API_KEY: TMDB });
    const { blocks, text } = buildJobFailureBlocks(
      "Wed Drop",
      `[GET] "https://api.themoviedb.org/3/discover/movie?api_key=${TMDB}&page=1": 401 Unauthorized`
    );
    const payload = JSON.stringify({ blocks, text });
    expect(payload).not.toContain(TMDB);
    expect(payload).toContain("<REDACTED:TMDB_API_KEY>");
    // The diagnosable part of the message is preserved — redaction only.
    expect(payload).toContain("401 Unauthorized");
    expect(text).toBe("🚨 Wed Drop failed");
  });

  it("scrubs an unregistered patterned key via the backstop alone", () => {
    const { blocks } = buildJobFailureBlocks("Sat Verdict", '[GET] "https://x.test/y?apikey=UNREGISTERED_XYZ": 404');
    const payload = JSON.stringify(blocks);
    expect(payload).not.toContain("UNREGISTERED_XYZ");
    expect(payload).toContain("apikey=***");
  });

  it("still clamps the emitted message to 1500 chars", () => {
    const { blocks } = buildJobFailureBlocks("Mon Movement", "x".repeat(4000));
    const section = blocks[1] as { text: { text: string } };
    // 1500 chars plus the two ``` fences.
    expect(section.text.text.length).toBe(1500 + 6);
  });

  it("keeps the payload byte-identical when there is nothing to redact", () => {
    registerSecrets({ TMDB_API_KEY: TMDB });
    const { blocks } = buildJobFailureBlocks("Thu Compare", "Only 1 releases — need at least 2 for a compare.");
    const section = blocks[1] as { text: { text: string } };
    expect(section.text.text).toBe("```Only 1 releases — need at least 2 for a compare.```");
  });
});

describe("notifyDraftReady — the error-derived fields are scrubbed at the boundary", () => {
  it("scrubs subtitle, validation.issuesBlock and deckZip in the posted body", async () => {
    registerSecrets({ TMDB_API_KEY: TMDB, R2_SECRET_ACCESS_KEY: R2_SECRET });

    await notifyDraftReady({
      pillar: "Wed Drop",
      emoji: "🎬",
      title: "In Theaters",
      subtitle: `caption mentioning ${TMDB}`,
      notionUrl: "https://notion.example/page1",
      validation: {
        metaValue: `2 FAILED · meta ${TMDB}`,
        issuesBlock: `:red_circle: *Film* (ott) - contract:band-released; upstream said ${TMDB}`,
      },
      deckZip: `📦 deck zip failed: PutObject denied for ${R2_SECRET}`,
    });

    expect(vi.mocked(ofetch)).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(vi.mocked(ofetch).mock.calls[0]?.[1]);
    expect(body).not.toContain(TMDB);
    expect(body).not.toContain(R2_SECRET);
    expect(body).toContain("<REDACTED:TMDB_API_KEY>");
    expect(body).toContain("<REDACTED:R2_SECRET_ACCESS_KEY>");
    // Structure and content otherwise intact.
    expect(body).toContain("contract:band-released");
    expect(body).toContain("deck zip failed");
    expect(body).toContain("https://notion.example/page1");
  });
});
