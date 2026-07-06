// scripts/movie-lookup/watchlist.ts
// Persistent, cross-device watchlist for the movie-lookup tool.
//
// Backed by PostgreSQL when DATABASE_URL is set (survives Render redeploys and
// syncs across devices — it's a single shared list, no users/auth by design).
// When DATABASE_URL is UNSET, it degrades gracefully to an in-memory store so
// local dev (and a fresh deploy before the DB is configured) still runs — the
// server logs a clear warning. This module NEVER touches the pipeline's
// cache.sqlite.
//
// The Postgres backend takes an injected `Queryable` (anything with a compatible
// `query()`), so the tests exercise the SQL layer with a mock and never open a
// real connection.

export type WatchType = "film" | "person";

export interface WatchlistItem {
  type: WatchType;
  tmdbId: number;
  title: string;
  note?: string;
  addedAt: string; // ISO timestamp
}

export interface AddInput {
  type: WatchType;
  tmdbId: number;
  title: string;
  note?: string;
}

export interface WatchlistBackend {
  readonly kind: "postgres" | "memory";
  init(): Promise<void>;
  list(): Promise<WatchlistItem[]>;
  add(input: AddInput): Promise<WatchlistItem>;
  remove(type: WatchType, tmdbId: number): Promise<void>;
}

export function isWatchType(t: unknown): t is WatchType {
  return t === "film" || t === "person";
}

// ── In-memory fallback ────────────────────────────────────────────────────────
export class MemoryWatchlist implements WatchlistBackend {
  readonly kind = "memory" as const;
  private items = new Map<string, WatchlistItem>();
  private key(type: WatchType, tmdbId: number): string {
    return `${type}:${tmdbId}`;
  }
  async init(): Promise<void> {}
  async list(): Promise<WatchlistItem[]> {
    // newest first
    return [...this.items.values()].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  }
  async add(input: AddInput): Promise<WatchlistItem> {
    const k = this.key(input.type, input.tmdbId);
    const existing = this.items.get(k);
    const item: WatchlistItem = {
      type: input.type,
      tmdbId: input.tmdbId,
      title: input.title,
      ...(input.note ? { note: input.note } : {}),
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
    };
    this.items.set(k, item);
    return item;
  }
  async remove(type: WatchType, tmdbId: number): Promise<void> {
    this.items.delete(this.key(type, tmdbId));
  }
}

// ── PostgreSQL backend ────────────────────────────────────────────────────────
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface Row {
  type: WatchType;
  tmdb_id: string | number;
  title: string;
  note: string | null;
  added_at: string | Date;
}

function rowToItem(r: Record<string, unknown>): WatchlistItem {
  const row = r as unknown as Row;
  const added = row.added_at instanceof Date ? row.added_at.toISOString() : String(row.added_at);
  return {
    type: row.type,
    tmdbId: Number(row.tmdb_id),
    title: row.title,
    ...(row.note ? { note: row.note } : {}),
    addedAt: added,
  };
}

export class PostgresWatchlist implements WatchlistBackend {
  readonly kind = "postgres" as const;
  constructor(private readonly db: Queryable) {}

  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS watchlist (
        id BIGSERIAL PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('film','person')),
        tmdb_id BIGINT NOT NULL,
        title TEXT NOT NULL,
        note TEXT,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (type, tmdb_id)
      )
    `);
  }

  async list(): Promise<WatchlistItem[]> {
    const { rows } = await this.db.query(
      `SELECT type, tmdb_id, title, note, added_at FROM watchlist ORDER BY added_at DESC`
    );
    return rows.map(rowToItem);
  }

  async add(input: AddInput): Promise<WatchlistItem> {
    const { rows } = await this.db.query(
      `INSERT INTO watchlist (type, tmdb_id, title, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (type, tmdb_id) DO UPDATE SET title = EXCLUDED.title, note = EXCLUDED.note
       RETURNING type, tmdb_id, title, note, added_at`,
      [input.type, input.tmdbId, input.title, input.note ?? null]
    );
    return rowToItem(rows[0]!);
  }

  async remove(type: WatchType, tmdbId: number): Promise<void> {
    await this.db.query(`DELETE FROM watchlist WHERE type = $1 AND tmdb_id = $2`, [type, tmdbId]);
  }
}

/**
 * Choose a backend from the environment. Returns a Postgres-backed store when
 * DATABASE_URL is present, otherwise an in-memory fallback. The `makePg` factory
 * is injectable so tests can supply a mock Queryable without importing `pg`.
 */
export function createWatchlistBackend(
  env: NodeJS.ProcessEnv,
  makePg?: (url: string) => Queryable
): WatchlistBackend {
  const url = env.DATABASE_URL;
  if (url && makePg) return new PostgresWatchlist(makePg(url));
  return new MemoryWatchlist();
}
