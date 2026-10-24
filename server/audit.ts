import { AUDIT_LEVELS } from "../shared/contract.ts";
import type { AuditDto, AuditLevel, AuditPage } from "../shared/contract.ts";
import { redact } from "./config.ts";
import { query } from "./db.ts";
import { events } from "./events.ts";

// Each level (error, warn, info) keeps its own newest rows, so a flood of info lines can never push out an error.
const KEEP_PER_LEVEL = 15;

const insert = query("INSERT INTO audit_log (at, level, kind, message) VALUES (?, ?, ?, ?)");
const prune = query(
  "DELETE FROM audit_log WHERE level = ? AND id NOT IN (SELECT id FROM audit_log WHERE level = ? ORDER BY id DESC LIMIT ?)",
);
const page = query<AuditDto>(
  `SELECT id, at, level, kind, message FROM audit_log
   WHERE (? IS NULL OR id < ?) AND (? IS NULL OR level = ?)
   ORDER BY id DESC LIMIT ?`,
);

for (const level of AUDIT_LEVELS) prune.run(level, level, KEEP_PER_LEVEL); // also trims a database from before this limit existed

/** Never throws: a full disk or a locked database must not break the action being logged. */
export function audit(level: AuditLevel, kind: string, message: string) {
  try {
    insert.run(Date.now(), level, kind, redact(message).slice(0, 500));
    prune.run(level, level, KEEP_PER_LEVEL);
    events.emit("audit");
  } catch (err) {
    console.error("[audit] write failed:", err);
  }
}

export function readAudit({ level, before, limit }: { level?: AuditLevel; before?: number; limit: number }): AuditPage {
  const rows = page.all(before ?? null, before ?? null, level ?? null, level ?? null, limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextBefore: rows.length > limit ? items[items.length - 1]!.id : null };
}
