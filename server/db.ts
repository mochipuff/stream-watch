import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MAX_INTERVAL_MS, MIN_INTERVAL_MS, ROLE_ID_RE } from "../shared/contract.ts";

export const DB_FILE = resolve(process.env.DB_PATH || "data/app.db");
mkdirSync(dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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

// SQLite has no ADD COLUMN IF NOT EXISTS, so older databases are patched by checking the table first.
function addColumnIfMissing(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((col) => col.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
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

export const isAutoEnabled = () => getSetting("auto") !== "0";

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
