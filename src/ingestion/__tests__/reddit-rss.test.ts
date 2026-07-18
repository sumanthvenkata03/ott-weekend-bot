// Atom parsing on a saved Reddit fixture · punctuation-heavy search-URL encoding
// (RD) · degrade cases (429 throw / HTML error body → [] + one ⚠) (RD, L4).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
import { ofetch } from "ofetch";
import { log } from "../../shared/logger.js";
import { parseAtomFeed, buildSearchUrl, buildNewUrl, fetchSubredditSearch } from "../reddit-rss.js";

// A realistic r/<sub>/search.rss body: two entries, HTML-escaped <content>,
// a punctuation-heavy title, and one entry missing <updated> (published only).
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Where can I stream Oh..! Sukumari?</title>
    <link href="https://www.reddit.com/r/tollywood/comments/abc123/where/" />
    <id>t3_abc123</id>
    <author><name>/u/cinephile</name></author>
    <updated>2026-07-15T10:00:00+00:00</updated>
    <published>2026-07-15T10:00:00+00:00</published>
    <content type="html">&lt;p&gt;Is it on &lt;a href="x"&gt;Netflix&lt;/a&gt; or Aha?&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Weekend recommendations?</title>
    <link href="https://www.reddit.com/r/tollywood/comments/def456/weekend/" />
    <id>t3_def456</id>
    <author><name>/u/movienerd</name></author>
    <published>2026-07-16T09:00:00+00:00</published>
    <content type="html">&lt;p&gt;Looking for something good&lt;/p&gt;</content>
  </entry>
</feed>`;

describe("parseAtomFeed", () => {
  it("extracts each entry's fields and strips content HTML to a snippet", () => {
    const posts = parseAtomFeed(FIXTURE, "tollywood");
    expect(posts).toHaveLength(2);
    const [a, b] = posts;
    expect(a).toMatchObject({
      id: "t3_abc123",
      title: "Where can I stream Oh..! Sukumari?",
      link: "https://www.reddit.com/r/tollywood/comments/abc123/where/",
      author: "/u/cinephile",
      sub: "tollywood",
      publishedISO: "2026-07-15T10:00:00+00:00",
    });
    expect(a!.snippet).toBe("Is it on Netflix or Aha?"); // HTML stripped, entities decoded
    expect(b!.publishedISO).toBe("2026-07-16T09:00:00+00:00"); // published-only entry
  });

  it("handles a single-entry feed (fxp returns an object, not an array)", () => {
    const single = FIXTURE.replace(/<entry>[\s\S]*?<\/entry>\s*(?=<entry>)/, "");
    const posts = parseAtomFeed(single, "kollywood");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.sub).toBe("kollywood");
  });

  it("returns [] for a non-Atom / HTML error body", () => {
    expect(parseAtomFeed("<html><body>Too Many Requests</body></html>", "tollywood")).toEqual([]);
  });
});

describe("buildSearchUrl (RD — clean encoding of punctuation-heavy titles)", () => {
  it("percent-encodes dots/bang/quotes/spaces and round-trips the query", () => {
    const q = `"Oh..! Sukumari" (OTT OR streaming)`;
    const url = buildSearchUrl("tollywood", q);
    const parsed = new URL(url); // must not throw
    expect(parsed.searchParams.get("q")).toBe(q); // decodes back exactly
    expect(parsed.searchParams.get("restrict_sr")).toBe("1");
    expect(parsed.searchParams.get("sort")).toBe("new");
    expect(url).not.toMatch(/\s/); // no raw whitespace in the URL
    expect(url).not.toContain('"'); // no raw quotes
    expect(url).toContain("%22"); // quote WAS encoded
  });

  it("buildNewUrl targets the /new/.rss feed", () => {
    expect(buildNewUrl("MalayalamMovies")).toBe("https://www.reddit.com/r/MalayalamMovies/new/.rss");
  });
});

describe("fetch degrade (RD / L4)", () => {
  beforeEach(() => vi.mocked(ofetch).mockReset());

  it("a 429 (throw) degrades to [] with exactly one ⚠ log line", async () => {
    vi.mocked(ofetch).mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const posts = await fetchSubredditSearch("tollywood", "x");
    expect(posts).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("an HTML error body (200) parses to [] with no throw", async () => {
    vi.mocked(ofetch).mockResolvedValueOnce("<html><body>error</body></html>");
    const posts = await fetchSubredditSearch("tollywood", "x");
    expect(posts).toEqual([]);
  });
});
