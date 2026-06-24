// Builders for the mock implementations. The actual vi.mock() declarations live
// at the top of each test file (they must be hoisted); these just produce the
// implementation functions those mocks delegate to. NOTHING here touches the
// network or the SQLite cache.
import type { TmdbDiscoverResponse, WikiParseResponse } from "./load.js";

// ── Wikipedia: replaces `ofetch` ─────────────────────────────────────────────
// wikipediaList calls ofetch(API, { query: { page, ... } }). Route by page name;
// an unknown page defaults to a "missing" error (a language with no list page),
// which fetchListHtml maps to "" -> coverage status "missing".
interface OfetchOpts {
  query: { page: string; [k: string]: string };
}
export function wikiOfetch(byPage: Record<string, WikiParseResponse>) {
  return async (_url: string, opts: OfetchOpts): Promise<WikiParseResponse> => {
    return (
      byPage[opts.query.page] ?? {
        error: { code: "missingtitle", info: "The page you specified doesn't exist." },
      }
    );
  };
}

// ── TMDb: replaces `tmdbFetchCached` ─────────────────────────────────────────
// Key a discover call by (language code, pass, page). The digital pass is the
// one carrying with_release_type=4.
export type TmdbPass = "theatrical" | "digital";
export function tmdbKey(params: Record<string, string>): string {
  const pass: TmdbPass = params.with_release_type === "4" ? "digital" : "theatrical";
  return `${params.with_original_language}|${pass}|${params.page}`;
}

/** Route discover calls to fixtures by tmdbKey; unmatched pages -> empty page. */
export function tmdbRouter(routes: Record<string, TmdbDiscoverResponse>) {
  return async (_path: string, params: Record<string, string>): Promise<unknown> => {
    const hit = routes[tmdbKey(params)];
    if (hit) return hit;
    const page = Number.parseInt(params.page ?? "1", 10);
    return { page, results: [], total_pages: 1, total_results: 0 } satisfies TmdbDiscoverResponse;
  };
}
