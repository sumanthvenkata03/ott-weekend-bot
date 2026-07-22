// src/shared/country-gate.ts
// THE COUNTRY GATE — one pure predicate, three seams, zero duplicated unions.
//
// WHY THIS EXISTS (the Mastul case): TMDb 1458250 "Beyond The Mast" (মাস্তুল) is a
// Bangladeshi/German/Dutch film with original_language "bn". It was admitted on a
// BENGALI-LANGUAGE ticket and reached a published deck. Language is not
// nationality. Every language-shaped filter we own — discover's
// with_original_language, INDIAN_LANG_CODES, the news desk's per-language feeds —
// answers "what does it sound like", never "where is it from". This module is the
// only thing that answers the second question.
//
// EXCLUSION, NOT EQUALITY. The test is "does the country set EXCLUDE India", not
// "does it equal India". That distinction is the whole design, because the real
// catalogue is full of legitimate co-productions:
//   • Punjabi cinema routinely co-produces with Pakistan  → ["IN","PK"]
//   • Tamil/Eelam stories co-produce with Sri Lanka       → ["IN","LK"]
//   • Diaspora-funded Indian films carry US/GB/AE/CA partners
// Each of those is Indian cinema and MUST pass. An equality test would reject all
// of them. IN appearing ANYWHERE in the set is sufficient to pass.
//
// FAIL-OPEN ON ABSENCE. When TMDb carries no country data at all, the film PASSES
// with a ⚠. A TMDb metadata gap must never eat a real Indian film — a false
// reject is invisible (the film silently never appears), a false admit is caught
// by the editor. Wrong-and-visible beats wrong-and-silent. This mirrors the
// news-score india-scope gate's documented fail-open stance.
//
// BOTH FIELDS, UNIONED. TMDb populates these inconsistently: measured across the
// repo's own cached /movie/{id} records, some carry origin_country only and some
// carry production_countries only. Reading either field alone silently mishandles
// those. The union is computed HERE and nowhere else — no seam re-implements it.
//
// PURE. No I/O, no logging, no network. Each seam fetches its own record and logs
// the verdict via countryGateLine() so the three seams emit identical text.

/** ISO 3166-1 alpha-2 for India — the only code that grants passage. */
export const INDIA_ISO = "IN";

/**
 * The country-bearing subset of a TMDb /movie/{id} response. Deliberately shaped
 * as the RAW TMDb field names so a seam can hand over the parsed detail object
 * directly, with no per-seam remapping step to get wrong.
 */
export interface CountryFields {
  // `| undefined` is explicit because the repo runs exactOptionalPropertyTypes:
  // callers build these with conditional spreads. `| null` because TMDb has been
  // seen to send null rather than omit.
  origin_country?: string[] | null | undefined;
  production_countries?: { iso_3166_1: string; name?: string | undefined }[] | null | undefined;
}

export interface CountryVerdict {
  /** False ONLY when country data is present and India is absent from it. */
  ok: boolean;
  /** Did TMDb carry any country data at all? False ⇒ this is the ⚠ path. */
  present: boolean;
  /** The de-duplicated, sorted union of both fields. */
  countries: string[];
  /** Printable — why it passed or failed. Carries "⚠" on the absent path. */
  reason: string;
}

/** Uppercased, trimmed, de-duplicated, sorted union of BOTH country fields. */
function countryUnion(record: CountryFields): string[] {
  const out = new Set<string>();
  for (const c of record.origin_country ?? []) {
    const v = String(c).trim().toUpperCase();
    if (v) out.add(v);
  }
  for (const c of record.production_countries ?? []) {
    const v = String(c?.iso_3166_1 ?? "").trim().toUpperCase();
    if (v) out.add(v);
  }
  return Array.from(out).sort();
}

/**
 * Decide whether a TMDb record is an Indian film. PURE.
 *
 *   country data present ∧ excludes IN  ⇒ REJECT
 *   country data present ∧ includes IN  ⇒ pass (co-production safe)
 *   country data absent                 ⇒ pass with ⚠ (TMDb gap, fail open)
 */
export function isIndianFilm(record: CountryFields): CountryVerdict {
  const countries = countryUnion(record);

  if (countries.length === 0) {
    return {
      ok: true,
      present: false,
      countries,
      reason: "⚠ no country data on the TMDb record — passed (fail-open; TMDb gaps must not eat a real Indian film)",
    };
  }
  if (countries.includes(INDIA_ISO)) {
    return {
      ok: true,
      present: true,
      countries,
      reason: `IN present in [${countries.join(",")}]`,
    };
  }
  return {
    ok: false,
    present: true,
    countries,
    reason: `REJECTED non-Indian country [${countries.join(",")}] — no IN`,
  };
}

/**
 * The ONE log line shape, shared by all three seams. PURE (returns a string; the
 * seam does the logging). Silent rejects — and silent ⚠s — are forbidden, so
 * every seam calls this for BOTH outcomes, never only for rejects.
 */
export function countryGateLine(
  seam: string,
  title: string,
  tmdbId: number | undefined,
  verdict: CountryVerdict
): string {
  const id = tmdbId === undefined ? "—" : String(tmdbId);
  const set = verdict.countries.length > 0 ? `[${verdict.countries.join(",")}]` : "[]";
  return `  [country-gate/${seam}] ${verdict.ok ? "pass" : "REJECT"} "${title}" tmdb ${id} ${set} — ${verdict.reason}`;
}
