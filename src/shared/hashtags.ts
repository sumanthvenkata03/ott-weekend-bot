// src/shared/hashtags.ts
// Deterministic Instagram hashtag builder. NO LLM — factual tags come straight
// from structured Release metadata + curated industry/platform umbrella tags,
// merged with the LLM's thematic tags, deduped, and capped at Instagram's 30.

import type { Release, Language, Platform } from "./types.js";

/**
 * Normalize a person/title name into a clean PascalCase hashtag.
 *   "A. R. Rahman"     -> "#ARRahman"
 *   "S. S. Rajamouli"  -> "#SSRajamouli"
 *   "Párvathy"         -> "#Parvathy"   (diacritics stripped)
 *   "Vijay Sethupathi" -> "#VijaySethupathi"
 * Returns null for empty/degenerate input (nothing alphanumeric survives).
 */
export function toHashtag(name: string | null | undefined): string | null {
  if (!name) return null;
  const tokens = name
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "") // strip diacritic marks (accents) exposed by NFD
    .split(/\s+/)
    .map(tok => tok.replace(/[^A-Za-z0-9]/g, ""))  // drop dots, punctuation, symbols
    .filter(tok => tok.length > 0)
    .map(tok => tok.charAt(0).toUpperCase() + tok.slice(1)); // capitalize first char
  const joined = tokens.join("");
  if (!joined || !/[A-Za-z0-9]/.test(joined)) return null;
  return `#${joined}`;
}

/**
 * High-reach industry umbrella tags by language — the discovery layer.
 * Exhaustive over the Language enum (tsc enforces). NOTE: #Tollywood is
 * reserved for Telugu only; Bengali deliberately uses #BengaliCinema/#BengaliMovies
 * to avoid the well-known #Tollywood collision.
 */
export const INDUSTRY_TAGS: Record<Language, string[]> = {
  "Telugu":    ["#Tollywood", "#TeluguCinema", "#TeluguMovies"],
  "Tamil":     ["#Kollywood", "#TamilCinema", "#TamilMovies"],
  "Malayalam": ["#Mollywood", "#MalayalamCinema", "#MalayalamMovies"],
  "Kannada":   ["#Sandalwood", "#KannadaCinema", "#KannadaMovies"],
  "Hindi":     ["#Bollywood", "#HindiCinema", "#BollywoodMovies"],
  "Marathi":   ["#MarathiCinema", "#MarathiMovies"],
  "Bengali":   ["#BengaliCinema", "#BengaliMovies"], // NOT #Tollywood (collides with Telugu)
  "Punjabi":   ["#Pollywood", "#PunjabiCinema", "#PunjabiMovies"],
  "Other":     ["#IndianCinema", "#IndianMovies"],
};

/**
 * Real-use platform tags incl. India variants/aliases. Exhaustive over the
 * Platform enum (tsc enforces). "Other" → no platform tag.
 */
export const PLATFORM_TAGS: Record<Platform, string[]> = {
  "Netflix":        ["#Netflix", "#NetflixIndia"],
  "Prime Video":    ["#PrimeVideo", "#AmazonPrime"],
  "JioHotstar":     ["#JioHotstar", "#Hotstar"],
  "Aha":            ["#ahaVideo"],
  "SonyLIV":        ["#SonyLIV"],
  "ZEE5":           ["#ZEE5"],
  "Sun NXT":        ["#SunNXT"],
  "ManoramaMAX":    ["#ManoramaMAX"],
  "Hoichoi":        ["#Hoichoi"],
  "Lionsgate Play": ["#LionsgatePlay"],
  "Apple TV+":      ["#AppleTV", "#AppleTVPlus"],
  "MUBI":           ["#MUBI"],
  "Chaupal":        ["#Chaupal"],
  "Planet Marathi": ["#PlanetMarathi"],
  "Other":          [],
};

const EVERGREEN_TAGS = ["#NowStreaming", "#OTTReleases", "#MovieReview", "#WhatToWatch", "#IndianCinema"];

// Own-property check so "toString" etc. from the prototype never count as a language.
function isLanguage(s: string): s is Language {
  return Object.prototype.hasOwnProperty.call(INDUSTRY_TAGS, s);
}

// All language names attached to a film: its primary language + audioLanguages
// original + dubbed, keeping only those that map to a known industry umbrella.
function filmLanguages(f: Release): Language[] {
  const names = new Set<string>();
  names.add(f.language);
  if (f.audioLanguages?.original) names.add(f.audioLanguages.original);
  for (const d of f.audioLanguages?.dubbed ?? []) names.add(d);
  return [...names].filter(isLanguage);
}

/**
 * Build the final hashtag string from structured metadata across ALL films,
 * merging the LLM's thematic tags, deduping case-insensitively, and capping at
 * `max` (Instagram's 30) in a popularity-style priority order:
 *   1 brand  2 titles  3 lead cast (top 2)  4 industry umbrellas (orig+dubbed)
 *   5 platforms  6 music directors  7 directors  8 LLM thematic tags
 *   9 fill: remaining cast, then an evergreen reach set.
 */
export function buildHashtags(films: Release[], existingLlmTags = "", max = 30): string {
  const result: string[] = [];
  const seen = new Set<string>(); // lowercased keys

  const add = (tag: string | null | undefined): void => {
    if (result.length >= max || !tag) return;
    const t = tag.startsWith("#") ? tag : `#${tag}`;
    const key = t.toLowerCase();
    if (key === "#" || seen.has(key)) return;
    seen.add(key);
    result.push(t);
  };
  const addAll = (tags: Array<string | null | undefined>): void => {
    for (const t of tags) add(t);
  };

  // 1. Brand
  add("#TheBigScreenIndex");
  add("#TBSI");

  // 2. Titles
  for (const f of films) add(toHashtag(f.title));

  // 3. Lead cast (top 2) — actors/actresses, highest reach
  for (const f of films) for (const name of (f.leadCast ?? []).slice(0, 2)) add(toHashtag(name));

  // 4. Industry umbrella tags from each film's languages (original + dubbed) — main reach driver
  for (const f of films) for (const lang of filmLanguages(f)) addAll(INDUSTRY_TAGS[lang]);

  // 5. Platform tags
  for (const f of films) for (const p of f.platform) addAll(PLATFORM_TAGS[p]);

  // 6. Music directors
  for (const f of films) add(toHashtag(f.musicDirector));

  // 7. Directors
  for (const f of films) add(toHashtag(f.director));

  // 8. LLM thematic/genre tags (split whitespace, keep #-prefixed tokens)
  for (const tok of existingLlmTags.split(/\s+/)) {
    if (tok.startsWith("#") && tok.length > 1) add(tok);
  }

  // 9. Fill remaining budget: rest of cast, then an evergreen reach set
  for (const f of films) for (const name of (f.cast ?? [])) add(toHashtag(name));
  addAll(EVERGREEN_TAGS);

  return result.join(" ");
}
