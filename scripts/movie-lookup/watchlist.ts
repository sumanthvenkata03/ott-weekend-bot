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
  posterUrl?: string; // film poster / person profile image (whitelisted host only)
  addedAt: string; // ISO timestamp
}

export interface AddInput {
  type: WatchType;
  tmdbId: number;
  title: string;
  note?: string;
  posterUrl?: string;
}

// Every operation is scoped to a `deviceId` — the watchlist is per-device (a phone,
// a laptop) rather than one global shared list. The server derives the id from the
// `X-TBSI-Device` header, falling back to the sentinel "legacy" when it's missing or
// malformed (which is also where all pre-device rows live).
export interface WatchlistBackend {
  readonly kind: "postgres" | "memory";
  init(): Promise<void>;
  list(deviceId: string): Promise<WatchlistItem[]>;
  add(input: AddInput, deviceId: string): Promise<WatchlistItem>;
  remove(type: WatchType, tmdbId: number, deviceId: string): Promise<void>;
}

export function isWatchType(t: unknown): t is WatchType {
  return t === "film" || t === "person";
}

// ── In-memory fallback ────────────────────────────────────────────────────────
export class MemoryWatchlist implements WatchlistBackend {
  readonly kind = "memory" as const;
  // Keyed by `${device}|${type}|${id}` so two devices keep isolated lists in the one
  // Map. Device ids are validated to `[A-Za-z0-9-]` upstream, so "|" never collides.
  private items = new Map<string, WatchlistItem>();
  private key(device: string, type: WatchType, tmdbId: number): string {
    return `${device}|${type}|${tmdbId}`;
  }
  async init(): Promise<void> {}
  async list(deviceId: string): Promise<WatchlistItem[]> {
    const prefix = `${deviceId}|`;
    // newest first, this device only
    return [...this.items.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v)
      .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  }
  async add(input: AddInput, deviceId: string): Promise<WatchlistItem> {
    const k = this.key(deviceId, input.type, input.tmdbId);
    const existing = this.items.get(k);
    const item: WatchlistItem = {
      type: input.type,
      tmdbId: input.tmdbId,
      title: input.title,
      ...(input.note ? { note: input.note } : {}),
      ...(input.posterUrl ? { posterUrl: input.posterUrl } : {}),
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
    };
    this.items.set(k, item);
    return item;
  }
  async remove(type: WatchType, tmdbId: number, deviceId: string): Promise<void> {
    this.items.delete(this.key(deviceId, type, tmdbId));
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
  poster_url: string | null;
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
    ...(row.poster_url ? { posterUrl: row.poster_url } : {}),
    addedAt: added,
  };
}

export class PostgresWatchlist implements WatchlistBackend {
  readonly kind = "postgres" as const;
  constructor(private readonly db: Queryable) {}

  async init(): Promise<void> {
    // Fresh install: device-scoped from the start. There is deliberately NO table-level
    // UNIQUE(type,tmdb_id) — uniqueness is per-device, enforced by the index below.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS watchlist (
        id BIGSERIAL PRIMARY KEY,
        device_id TEXT NOT NULL DEFAULT 'legacy',
        type TEXT NOT NULL CHECK (type IN ('film','person')),
        tmdb_id BIGINT NOT NULL,
        title TEXT NOT NULL,
        note TEXT,
        poster_url TEXT,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Defensive migration for a PRE-EXISTING (pre-device) table: add the columns, drop the
    // old global UNIQUE(type,tmdb_id) constraint, and add the per-device unique index.
    // Every step is idempotent (IF EXISTS / IF NOT EXISTS) so re-running init() is safe.
    await this.db.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'legacy'`);
    await this.db.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS poster_url TEXT`);
    await this.db.query(`ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_type_tmdb_id_key`);
    await this.db.query(`CREATE UNIQUE INDEX IF NOT EXISTS watchlist_device_type_tmdb_idx ON watchlist(device_id, type, tmdb_id)`);
  }

  async list(deviceId: string): Promise<WatchlistItem[]> {
    const { rows } = await this.db.query(
      `SELECT type, tmdb_id, title, note, poster_url, added_at FROM watchlist WHERE device_id = $1 ORDER BY added_at DESC`,
      [deviceId]
    );
    return rows.map(rowToItem);
  }

  async add(input: AddInput, deviceId: string): Promise<WatchlistItem> {
    const { rows } = await this.db.query(
      `INSERT INTO watchlist (device_id, type, tmdb_id, title, note, poster_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (device_id, type, tmdb_id) DO UPDATE SET title = EXCLUDED.title, note = EXCLUDED.note, poster_url = EXCLUDED.poster_url
       RETURNING type, tmdb_id, title, note, poster_url, added_at`,
      [deviceId, input.type, input.tmdbId, input.title, input.note ?? null, input.posterUrl ?? null]
    );
    return rowToItem(rows[0]!);
  }

  async remove(type: WatchType, tmdbId: number, deviceId: string): Promise<void> {
    await this.db.query(`DELETE FROM watchlist WHERE device_id = $1 AND type = $2 AND tmdb_id = $3`, [deviceId, type, tmdbId]);
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
