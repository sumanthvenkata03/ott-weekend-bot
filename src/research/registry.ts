// src/research/registry.ts
// Central list of research sources. Keyed sources (youtube now; reddit, brave
// later) are added by pushing them into SOURCES — availableSources() then
// filters by each source's isAvailable() (key presence), so an unkeyed
// environment simply runs the no-key sources.
import type { ResearchSource } from "./types.js";
import { wikipedia } from "./sources/wikipedia.js";
import { googleNews } from "./sources/googleNews.js";
import { youtube } from "./sources/youtube.js";

const SOURCES: ResearchSource[] = [wikipedia, googleNews, youtube];

export function allSources(): ResearchSource[] {
  return SOURCES;
}

export function availableSources(): ResearchSource[] {
  return SOURCES.filter((s) => s.isAvailable());
}
