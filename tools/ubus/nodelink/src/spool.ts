import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { NodeEvent } from "./types.js";

/** 32 lowercase hex, at least one letter, no run of 7+ digits (hub rule: an epoch must never look like a phone/UHID). */
export function mintEpoch(): string {
  for (;;) {
    const e = randomBytes(16).toString("hex");
    if (/[a-f]/.test(e) && !/\d{7}/.test(e)) return e;
  }
}

export interface SpoolStats {
  dead: number;
  depth: number;
  lastSeq: number;
  ackedSeq: number;
  oldestTs: string | null;
}

/** SQLite outbound queue. seq is allocated and persisted here so it survives restarts. */
export class Spool {
  db!: DatabaseSync;
  private ino = 0;
  /** Number of times the db file vanished under us and a fresh spool (new epoch) was minted. */
  resets = 0;

  constructor(private readonly path: string, private readonly readOnly = false) {
    this.open();
  }

  private open(): void {
    const path = this.path;
    if (!this.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: this.readOnly });
    if (this.readOnly) return;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dead (epoch TEXT NOT NULL, seq INTEGER NOT NULL, rule TEXT NOT NULL, PRIMARY KEY (epoch, seq));
      CREATE TABLE IF NOT EXISTS inbound (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    `);
    if (this.getKv("epoch") === null) this.setKv("epoch", mintEpoch());
    this.ino = this.path === ":memory:" ? 0 : statSync(path).ino;
  }

  /** If the db file was deleted or replaced while we ran, start a brand-new spool: new epoch, seq from 1 (A1). */
  private guard(): void {
    if (this.readOnly || this.path === ":memory:") return;
    let gone = !existsSync(this.path);
    if (!gone) gone = statSync(this.path).ino !== this.ino;
    if (!gone) return;
    try { this.db.close(); } catch { /* ignore */ }
    for (const ext of ["-wal", "-shm"]) {
      try { if (existsSync(this.path + ext)) unlinkSync(this.path + ext); } catch { /* ignore */ }
    }
    this.resets++;
    this.open();
  }

  private getKv(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return r ? r.v : null;
  }
  private setKv(k: string, v: string): void {
    this.db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  epoch(): string {
    this.guard();
    return this.getKv("epoch") ?? "";
  }

  /** Allocate the next seq and enqueue in one transaction. */
  enqueue(make: (seq: number, epoch: string) => NodeEvent): NodeEvent {
    this.guard();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seq = Number(this.getKv("seq") ?? "0") + 1;
      const ev = make(seq, this.getKv("epoch") ?? "");
      this.setKv("seq", String(seq));
      this.db.prepare("INSERT INTO outbox(seq, ts, body) VALUES(?,?,?)").run(seq, ev.ts, JSON.stringify(ev));
      this.db.exec("COMMIT");
      return ev;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Oldest-first unacked events. */
  pending(limit: number): NodeEvent[] {
    this.guard();
    const rows = this.db.prepare("SELECT body FROM outbox ORDER BY seq LIMIT ?").all(limit) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body) as NodeEvent);
  }

  /** Ack only applies to the epoch it was sent under; a stale ack must not eat events of a new epoch. */
  ack(ackSeq: number, epoch?: string): void {
    this.guard();
    if (epoch !== undefined && epoch !== this.getKv("epoch")) return;
    this.db.prepare("DELETE FROM outbox WHERE seq <= ?").run(ackSeq);
    if (ackSeq > Number(this.getKv("acked") ?? "0")) this.setKv("acked", String(ackSeq));
  }

  /** The hub refused this event: remember the rule id, drop it from the queue so it cannot block the ones behind it. */
  markDead(seq: number, epoch: string, rule: string): void {
    this.guard();
    if (epoch !== this.getKv("epoch")) return;
    this.db.prepare("INSERT OR IGNORE INTO dead(epoch, seq, rule) VALUES(?,?,?)").run(epoch, seq, rule);
    this.db.prepare("DELETE FROM outbox WHERE seq = ?").run(seq);
  }

  cursor(): string | null {
    return this.getKv("cursor");
  }
  setCursor(c: string): void {
    this.setKv("cursor", c);
  }

  cacheInbound(id: string, body: unknown): void {
    this.db.prepare("INSERT OR IGNORE INTO inbound(id, body) VALUES(?,?)").run(id, JSON.stringify(body));
    this.db.exec("DELETE FROM inbound WHERE rowid <= (SELECT MAX(rowid) FROM inbound) - 5000");
  }

  stats(): SpoolStats {
    this.guard();
    const n = this.db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS t FROM outbox").get() as { n: number; t: string | null };
    const d = this.db.prepare("SELECT COUNT(*) AS n FROM dead").get() as { n: number };
    return {
      dead: Number(d.n),
      depth: Number(n.n),
      lastSeq: Number(this.getKv("seq") ?? "0"),
      ackedSeq: Number(this.getKv("acked") ?? "0"),
      oldestTs: n.t,
    };
  }

  close(): void {
    this.db.close();
  }
}
