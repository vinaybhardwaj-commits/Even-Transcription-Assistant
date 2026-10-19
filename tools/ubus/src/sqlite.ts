import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export { DatabaseSync };
export type Sql = DatabaseSync;

export function openDb(path: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 3000;");
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return db;
}

export function exec(db: DatabaseSync, sql: string): void {
  db.exec(sql);
}

export function run(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): { changes: number; lastId: number } {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
}

export function get(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Record<string, unknown> | undefined {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return row;
}

export function all(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

export function stmt(db: DatabaseSync, sql: string): StatementSync {
  return db.prepare(sql);
}

export function str(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (v === null || v === undefined) return "";
  return String(v);
}

export function num(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") return Number(v);
  return 0;
}
