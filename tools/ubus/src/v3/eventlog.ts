import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { all, get, openDb, run, type DatabaseSync } from "../sqlite.js";

/** One immutable row of the v3 event table. */
export interface EventRow {
  id: number;
  ts: string;
  actor: string;
  kind: string;
  subjectId: string;
  bodyRef: string | null;
  meta: Record<string, unknown>;
}

export interface EventInput {
  ts: string;
  actor: string;
  kind: string;
  subjectId: string;
  bodyRef?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Append-only event table `(id, ts, actor, kind, subject_id, body_ref, meta_json)`.
 * Rows are only ever appended here; the sole writer is append(). Removals are
 * expressed as tombstone events (kind ending in ".tombstoned"), and every
 * materialized view is derived by folding the log in id order.
 */
export class EventLog {
  private db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDb(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        body_ref TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}'
      );`,
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS events_subject ON events(subject_id, id);");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_kind ON events(kind, id);");
    // Implicit rows a conflict handler wants to drop must trip the guards too.
    this.db.exec("PRAGMA recursive_triggers = ON;");
    // The table itself refuses row edits and removals, not only this code.
    this.db.exec(
      `CREATE TRIGGER IF NOT EXISTS events_block_alter BEFORE UPDATE ON events
       BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;`,
    );
    this.db.exec(
      `CREATE TRIGGER IF NOT EXISTS events_block_remove BEFORE DELETE ON events
       BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;`,
    );
    // No writing into the past: a supplied id may never rewind the sequence,
    // which is what INSERT OR REPLACE with an existing id tries to do. An
    // insert that leaves id to AUTOINCREMENT arrives here as -1, so the guard
    // only ever sees ids the statement itself supplied.
    this.db.exec(
      `CREATE TRIGGER IF NOT EXISTS events_block_rewind BEFORE INSERT ON events
       WHEN NEW.id IS NOT NULL AND NEW.id > 0 AND NEW.id <= (SELECT COALESCE(MAX(id), 0) FROM events)
       BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;`,
    );
    // The BEFORE guard cannot tell an explicit id -1 from AUTOINCREMENT's -1
    // placeholder, so ids <= 0 are refused once the row has its final id: an
    // omitted id is always >= 1 by then, an explicit 0/-5/-1 never is.
    this.db.exec(
      `CREATE TRIGGER IF NOT EXISTS events_block_nonpositive AFTER INSERT ON events
       WHEN NEW.id <= 0
       BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;`,
    );
  }

  /**
   * Runs fn with every append landing in one SQLite transaction: either all of
   * the rows persist or none do, so a crash mid-write cannot leave a message
   * without its per-recipient rows.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone */
      }
      throw err;
    } finally {
      this.depth -= 1;
    }
  }

  private depth = 0;

  append(e: EventInput): number {
    const res = run(
      this.db,
      "INSERT INTO events (ts, actor, kind, subject_id, body_ref, meta_json) VALUES (?, ?, ?, ?, ?, ?)",
      e.ts,
      e.actor,
      e.kind,
      e.subjectId,
      e.bodyRef ?? null,
      JSON.stringify(e.meta ?? {}),
    );
    return res.lastId;
  }

  /** Every event, oldest first. */
  all(): EventRow[] {
    return all(this.db, "SELECT * FROM events ORDER BY id ASC").map((row) => ({
      id: Number(row.id),
      ts: String(row.ts),
      actor: String(row.actor),
      kind: String(row.kind),
      subjectId: String(row.subject_id),
      bodyRef: row.body_ref === null || row.body_ref === undefined ? null : String(row.body_ref),
      meta: JSON.parse(String(row.meta_json || "{}")) as Record<string, unknown>,
    }));
  }

  count(): number {
    const row = get(this.db, "SELECT COUNT(*) AS n FROM events");
    return row ? Number(row.n) : 0;
  }

  close(): void {
    this.db.close();
  }
}
