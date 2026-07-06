// scripts/movie-lookup/compute.ts
// Pure, framework-free helpers for COMPARE mode (cast overlap between two films,
// shared films between two people) and the person-page FILMOGRAPHY sort/filter.
// These are the tested source of truth; the client pages mirror the same small
// algorithms inline (the tool's pages are self-contained inline scripts).

// ── Compare: cast/crew overlap between two films ──────────────────────────────
export interface CreditPerson {
  id: number;
  name: string;
  character?: string;
  job?: string;
}
export interface CreditsLike {
  cast?: CreditPerson[];
  crew?: CreditPerson[];
}
export interface OverlapPerson {
  id: number;
  name: string;
  roleA: string;
  roleB: string;
}

function roleMap(c: CreditsLike): Map<number, { name: string; roles: string[] }> {
  const m = new Map<number, { name: string; roles: string[] }>();
  const push = (id: number, name: string, role: string) => {
    const e = m.get(id) ?? { name, roles: [] };
    if (!e.roles.includes(role)) e.roles.push(role);
    m.set(id, e);
  };
  for (const p of c.cast ?? []) push(p.id, p.name, p.character ? `as ${p.character}` : "Cast");
  for (const p of c.crew ?? []) push(p.id, p.name, p.job ?? "Crew");
  return m;
}

/** People (by id) who worked on BOTH films, with their role on each side. */
export function castOverlap(a: CreditsLike, b: CreditsLike): OverlapPerson[] {
  const ma = roleMap(a);
  const mb = roleMap(b);
  const out: OverlapPerson[] = [];
  for (const [id, ea] of ma) {
    const eb = mb.get(id);
    if (eb) out.push({ id, name: ea.name, roleA: ea.roles.join(", "), roleB: eb.roles.join(", ") });
  }
  return out;
}

// ── Compare: shared films between two people ──────────────────────────────────
export interface FilmoLike {
  id: number;
  title: string;
  year?: number;
  mediaType?: string;
  role?: string;
  department?: "cast" | "crew";
  popularity?: number;
}

/** Films present in BOTH filmographies (by id), newest first. */
export function sharedFilms(a: FilmoLike[], b: FilmoLike[]): FilmoLike[] {
  const bIds = new Set(b.map((f) => f.id));
  const seen = new Set<number>();
  const out: FilmoLike[] = [];
  for (const f of a) {
    if (bIds.has(f.id) && !seen.has(f.id)) {
      seen.add(f.id);
      out.push(f);
    }
  }
  return out.sort((x, y) => (y.year ?? 0) - (x.year ?? 0));
}

// ── Person page: filmography sort + filter ────────────────────────────────────
export type FilmoSort = "newest" | "oldest" | "popular";
export type FilmoFilter = "all" | "acting" | "directing" | "crew";

export function sortFilmography<T extends FilmoLike>(items: T[], sort: FilmoSort): T[] {
  const copy = items.slice();
  if (sort === "newest") copy.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  else if (sort === "oldest") copy.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
  else if (sort === "popular") copy.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  return copy;
}

export function filterFilmography<T extends FilmoLike>(items: T[], filter: FilmoFilter): T[] {
  if (filter === "all") return items.slice();
  if (filter === "acting") return items.filter((f) => f.department === "cast");
  if (filter === "crew") return items.filter((f) => f.department === "crew");
  // directing: crew rows whose role mentions "Direct" (Director / Directing / Co-Director)
  return items.filter((f) => f.department === "crew" && /direct/i.test(f.role ?? ""));
}
