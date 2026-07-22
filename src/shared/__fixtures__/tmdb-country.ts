// src/shared/__fixtures__/tmdb-country.ts
// CHECKED-IN country fixtures for the country gate. These are LITERALS, copied
// from real TMDb /movie/{id} responses — nothing here reads data/cache.sqlite, so
// the suites pass on a fresh clone with no key, no network and no warm cache.
//
// MASTUL and VARAVU are verbatim country subsets of genuine records. The
// co-production shapes are constructed to document the gate's raison d'être (see
// country-gate.ts): they are the films an equality test would wrongly reject.

import type { CountryFields } from "../country-gate.js";

/**
 * THE case. TMDb 1458250 "Beyond The Mast" / মাস্তুল — Bangladeshi/German/Dutch,
 * original_language "bn". Admitted once on a Bengali-language ticket and reached
 * a published deck. Must be REJECTED at all three seams.
 */
export const MASTUL_COUNTRY: CountryFields = {
  origin_country: ["BD", "DE", "NL"],
  production_countries: [
    { iso_3166_1: "BD", name: "Bangladesh" },
    { iso_3166_1: "NL", name: "Netherlands" },
    { iso_3166_1: "DE", name: "Germany" },
  ],
};
export const MASTUL_TMDB_ID = 1458250;
export const MASTUL_TITLE = "Beyond The Mast";

/** Control: TMDb 1542187 "Varavu" / വരവ് — a real Indian (Malayalam) film. */
export const VARAVU_COUNTRY: CountryFields = {
  origin_country: ["IN"],
  production_countries: [{ iso_3166_1: "IN", name: "India" }],
};
export const VARAVU_TMDB_ID = 1542187;
export const VARAVU_TITLE = "Varavu";

/**
 * TMDb metadata gap — neither field populated. Must PASS with a ⚠. Real: TMDb
 * leaves both blank on freshly-created records, which is exactly when a small
 * regional Indian film is most likely to be the one being looked up.
 */
export const ABSENT_COUNTRY: CountryFields = {};

/**
 * Shape variants seen in the wild: some records carry origin_country only,
 * others production_countries only. The gate must union BOTH, so each of these
 * has to resolve identically to the full-data Indian case.
 */
export const IN_ORIGIN_ONLY: CountryFields = { origin_country: ["IN"] };
export const IN_PRODUCTION_ONLY: CountryFields = {
  production_countries: [{ iso_3166_1: "IN", name: "India" }],
};

/**
 * THE RAISON D'ÊTRE — legitimate Indian co-productions that an "equals IN" test
 * would destroy. Punjabi cinema and Pakistan share a language, an audience and
 * frequently a production; Tamil/Eelam stories co-produce with Sri Lanka. Both
 * are Indian cinema. Both MUST pass.
 */
export const PUNJABI_INDIA_PAKISTAN: CountryFields = {
  origin_country: ["IN", "PK"],
  production_countries: [
    { iso_3166_1: "IN", name: "India" },
    { iso_3166_1: "PK", name: "Pakistan" },
  ],
};
export const TAMIL_INDIA_SRILANKA: CountryFields = {
  origin_country: ["LK", "IN"],
  production_countries: [
    { iso_3166_1: "LK", name: "Sri Lanka" },
    { iso_3166_1: "IN", name: "India" },
  ],
};
