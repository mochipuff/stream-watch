import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { CONTENT_KINDS, MAX_INTERVAL_MS, MAX_MESSAGE_LENGTH, MIN_INTERVAL_MS, ROLE_ID_RE } from "../shared/contract.ts";
import type { ContentKind, SourceName } from "../shared/contract.ts";

export const DB_FILE = resolve(process.env.DB_PATH || "data/app.db");
mkdirSync(dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`);

// ---------- Schema adaptation ----------
// `PRAGMA user_version` records how far this file has been adapted. Every step is idempotent (IF NOT EXISTS / column check),
// so a database from any earlier release, including one that predates version tracking (user_version 0), is brought
// forward without losing data. Never edit a released step: add a new one at the end.

function hasColumn(table: string, column: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return columns.some((col) => col.name === column);
}

// SQLite has no ADD COLUMN IF NOT EXISTS, so the table is checked first.
function addColumnIfMissing(table: string, column: string, definition: string) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const MIGRATIONS: readonly { version: number; up: () => void }[] = [
  {
    // Baseline: the schema of every release before versioning existed.
    version: 1,
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          handle TEXT UNIQUE NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          checked_at INTEGER,
          upcoming_count INTEGER DEFAULT 0,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS webhooks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS channel_webhooks (
          channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
          webhook_id TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
          PRIMARY KEY (channel_id, webhook_id)
        );
        CREATE TABLE IF NOT EXISTS sent_streams (
          webhook_id TEXT NOT NULL,
          video_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          title TEXT NOT NULL,
          start_at INTEGER,
          sent_at INTEGER NOT NULL,
          channel_name TEXT,
          delivered INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (webhook_id, video_id)
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          level TEXT NOT NULL,
          kind TEXT NOT NULL,
          message TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS plain_videos (video_id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL);
      `);
      addColumnIfMissing("sent_streams", "channel_name", "TEXT");
      // `delivered` = 0 marks a claimed send that Discord has not confirmed yet. Rows from before this column existed were all confirmed.
      addColumnIfMissing("sent_streams", "delivered", "INTEGER NOT NULL DEFAULT 1");
      addColumnIfMissing("sent_streams", "status", "TEXT NOT NULL DEFAULT 'upcoming'");
      addColumnIfMissing("channels", "youtube_id", "TEXT");
      addColumnIfMissing("channels", "name", "TEXT");
      addColumnIfMissing("channels", "source", "TEXT");
      addColumnIfMissing("channels", "live_count", "INTEGER NOT NULL DEFAULT 0");
      // Custom Discord message per handle (`{user}`, `@{roleid}` placeholders) and the role ids it may mention, comma-separated.
      addColumnIfMissing("channels", "message", "TEXT");
      addColumnIfMissing("channels", "role_ids", "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE INDEX IF NOT EXISTS sent_streams_sent_at_idx ON sent_streams (sent_at DESC);
        CREATE INDEX IF NOT EXISTS channel_webhooks_webhook_idx ON channel_webhooks (webhook_id);
        CREATE INDEX IF NOT EXISTS audit_log_level_idx ON audit_log (level, id DESC);
      `);
    },
  },
  {
    // Videos added by hand: always checked with their channel, whatever RSS, scraping or the API find.
    version: 2,
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS manual_videos (
          channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
          video_id TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (channel_id, video_id)
        );
      `);
    },
  },
  {
    // One message and one on/off switch per kind (upcoming, live, vod, short) instead of a single message per channel.
    // `channels.kinds` holds them as JSON. The old single message becomes the upcoming and live message, which is
    // exactly what it was used for. `plain_videos` now also remembers what a finished video is (vod or short) so it is read once.
    version: 3,
    up() {
      addColumnIfMissing("channels", "kinds", "TEXT");
      addColumnIfMissing("plain_videos", "kind", "TEXT");
      addColumnIfMissing("plain_videos", "title", "TEXT");
      addColumnIfMissing("plain_videos", "published_at", "INTEGER");
      addColumnIfMissing("plain_videos", "channel_id", "TEXT");
      if (hasColumn("channels", "message")) {
        db.exec(`
          UPDATE channels
          SET kinds = json_object('upcoming', json_object('message', message), 'live', json_object('message', message))
          WHERE message IS NOT NULL AND kinds IS NULL;
          ALTER TABLE channels DROP COLUMN message;
        `);
      }
    },
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
const KEEP_BACKUPS = 3;

function currentVersion(): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number | bigint }).user_version);
}

// A consistent copy (VACUUM INTO also folds in the WAL) taken before an existing database is changed. Matches `data/*.db-*` in .gitignore.
function backupBeforeMigrating(from: number) {
  const hasData = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get();
  if (!hasData) return; // a brand-new file has nothing to protect
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const prefix = `${basename(DB_FILE)}-backup-`;
  const file = resolve(dirname(DB_FILE), `${prefix}v${from}-${stamp}`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  try {
    chmodSync(file, 0o600);
  } catch {
    // not supported on this platform
  }
  const old = readdirSync(dirname(DB_FILE)).filter((name) => name.startsWith(prefix)).sort().reverse().slice(KEEP_BACKUPS);
  for (const name of old) rmSync(resolve(dirname(DB_FILE), name), { force: true });
  console.log(`[db] backed up the existing database to ${file} before adapting it`);
}

function migrate() {
  const from = currentVersion();
  if (from > LATEST_VERSION) {
    console.error(`[db] ${DB_FILE} was written by a newer version of Stream Watch (schema ${from}, this one knows ${LATEST_VERSION}). Update the app or point DB_PATH at another file.`);
    process.exit(1);
  }
  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (pending.length === 0) return;
  backupBeforeMigrating(from);
  for (const { version, up } of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      up();
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      console.error(`[db] adapting the database to schema ${version} failed. Nothing was changed by that step; a backup was taken first.`, err);
      process.exit(1);
    }
  }
  console.log(`[db] schema ${from} -> ${LATEST_VERSION}`);
}
migrate();

// Webhook URLs and the proxy URL are secrets: keep the database private to the current user.
try {
  chmodSync(DB_FILE, 0o600);
} catch {
  // not supported on this platform
}

/** A prepared statement with typed rows. Prepare once at module load, never per request. */
export function query<Row extends object = never>(sql: string) {
  const stmt = db.prepare(sql);
  return {
    all: (...params: SQLInputValue[]) => stmt.all(...params) as unknown as Row[],
    get: (...params: SQLInputValue[]) => stmt.get(...params) as unknown as Row | undefined,
    run: (...params: SQLInputValue[]) => stmt.run(...params),
  };
}

const readSetting = query<{ value: string }>("SELECT value FROM settings WHERE key = ?");
const writeSetting = query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
const deleteSetting = query("DELETE FROM settings WHERE key = ?");

export const getSetting = (key: string): string | null => readSetting.get(key)?.value ?? null;
export const setSetting = (key: string, value: string | null) => (value === null ? deleteSetting.run(key) : writeSetting.run(key, value));

const DEFAULT_INTERVAL_MS = 30_000;

// Never returns NaN or an out-of-range value, so timers can never spin at 1ms.
export function getIntervalMs(): number {
  const candidates = [Number(getSetting("intervalMs")), Number(process.env.POLL_INTERVAL_MS)];
  const ms = candidates.find((n) => Number.isFinite(n) && n > 0) ?? DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));
}

// Stored as "id,id"; anything that is not a role id is dropped on read, so a damaged row can never inject a mention.
export const parseRoleIds = (raw: string | null): string[] => (raw ?? "").split(",").filter((id) => ROLE_ID_RE.test(id));

export interface KindSetting {
  enabled: boolean;
  message: string | null;
  /** Unix seconds when the kind was switched on. A VOD or Short published before that is never announced, so switching it on does not replay the back catalogue. */
  since: number;
}
export type KindSettings = Record<ContentKind, KindSetting>;

// Streams were always announced; VODs and Shorts are opt-in.
const ENABLED_BY_DEFAULT: Record<ContentKind, boolean> = { upcoming: true, live: true, vod: false, short: false };

/** Reads `channels.kinds`. Anything damaged or missing falls back to the defaults, so a bad row can never announce more than intended. */
export function parseKinds(raw: string | null): KindSettings {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {
    // damaged JSON: defaults
  }
  return Object.fromEntries(
    CONTENT_KINDS.map((kind) => {
      const entry = (stored[kind] ?? {}) as Record<string, unknown>;
      const message = typeof entry.message === "string" ? entry.message.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
      return [
        kind,
        {
          enabled: typeof entry.enabled === "boolean" ? entry.enabled : ENABLED_BY_DEFAULT[kind],
          message: message || null,
          since: typeof entry.since === "number" && Number.isFinite(entry.since) ? entry.since : 0,
        },
      ];
    }),
  ) as KindSettings;
}

export const isAutoEnabled = () => getSetting("auto") !== "0";

// All sources are on until the person switches one off.
export const isSourceEnabled = (name: SourceName) => getSetting(`source.${name}`) !== "0";

// Synchronous transaction: all-or-nothing multi-statement writes (no awaits inside `fn`).
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
