import type { AuditDto, AuditLevel, AuditPage } from "../shared/contract.ts";
import { redact } from "./config.ts";
import { query } from "./db.ts";
import { events } from "./events.ts";

const KEEP_ROWS = 2000;
const PRUNE_EVERY = 100;

const insert = query("INSERT INTO audit_log (at, level, kind, message) VALUES (?, ?, ?, ?)");
const prune = query("DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log) - ?");
const page = query<AuditDto>(
  `SELECT id, at, level, kind, message FROM audit_log
   WHERE (? IS NULL OR id < ?) AND (? IS NULL OR level = ?)
   ORDER BY id DESC LIMIT ?`,
);

let writesSincePrune = 0;
prune.run(KEEP_ROWS);

/** Never throws: a full disk or a locked database must not break the action being logged. */
export function audit(level: AuditLevel, kind: string, message: string) {
  try {
    insert.run(Date.now(), level, kind, redact(message).slice(0, 500));
    if (++writesSincePrune >= PRUNE_EVERY) {
      writesSincePrune = 0;
      prune.run(KEEP_ROWS);
    }
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
