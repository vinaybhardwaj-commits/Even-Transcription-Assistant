// SQLite store (node:sqlite, no npm deps). WAL mode, busy_timeout so the
// ~13 concurrent eta-bus processes can share one file safely.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './constants.mjs';

let dbSingleton = null;
let dbSingletonPath = null;

export function openDb(customPath) {
  const p = customPath || DB_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      sender TEXT NOT NULL,
      recipients_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_id TEXT,
      reply_to INTEGER,
      priority TEXT NOT NULL DEFAULT 'normal'
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      message_id INTEGER NOT NULL,
      recipient TEXT NOT NULL,
      read_ts INTEGER,
      acked_ts INTEGER,
      PRIMARY KEY (message_id, recipient)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudges (
      recipient TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_recipient ON receipts(recipient, read_ts);');
  return db;
}

// Process-wide singleton for the real bus DB path; tests pass their own
// temp path directly to the query functions below instead of using this.
export function getDb() {
  if (!dbSingleton || dbSingletonPath !== DB_PATH) {
    dbSingleton = openDb(DB_PATH);
    dbSingletonPath = DB_PATH;
  }
  return dbSingleton;
}

// ---------- queries ----------

export function insertMessage(db, { ts, sender, recipients, subject, body, threadId, replyTo, priority }) {
  const stmt = db.prepare(`
    INSERT INTO messages (ts, sender, recipients_json, subject, body, thread_id, reply_to, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    ts,
    sender,
    JSON.stringify(recipients),
    subject,
    body,
    threadId ?? null,
    replyTo ?? null,
    priority
  );
  return Number(info.lastInsertRowid);
}

export function insertReceipt(db, messageId, recipient) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO receipts (message_id, recipient, read_ts, acked_ts)
    VALUES (?, ?, NULL, NULL)
  `);
  stmt.run(messageId, recipient);
}

export function getUnreadCount(db, recipient) {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM receipts WHERE recipient = ? AND read_ts IS NULL')
    .get(recipient);
  return row ? Number(row.c) : 0;
}

export function getLatestUnread(db, recipient) {
  return db
    .prepare(
      `SELECT m.sender AS sender, m.subject AS subject
       FROM receipts r JOIN messages m ON m.id = r.message_id
       WHERE r.recipient = ? AND r.read_ts IS NULL
       ORDER BY m.ts DESC LIMIT 1`
    )
    .get(recipient);
}

export function listInbox(db, recipient, { unreadOnly = true, limit = 20 } = {}) {
  const sql = unreadOnly
    ? `SELECT m.id AS id, m.ts AS ts, m.sender AS sender, m.subject AS subject, m.body AS body, m.thread_id AS thread_id
       FROM receipts r JOIN messages m ON m.id = r.message_id
       WHERE r.recipient = ? AND r.read_ts IS NULL
       ORDER BY m.ts DESC LIMIT ?`
    : `SELECT m.id AS id, m.ts AS ts, m.sender AS sender, m.subject AS subject, m.body AS body, m.thread_id AS thread_id
       FROM receipts r JOIN messages m ON m.id = r.message_id
       WHERE r.recipient = ?
       ORDER BY m.ts DESC LIMIT ?`;
  const rows = db.prepare(sql).all(recipient, limit);
  rows.reverse(); // newest last
  return rows;
}

export function markRead(db, recipient, messageIds, now) {
  if (messageIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE receipts SET read_ts = ? WHERE recipient = ? AND message_id = ? AND read_ts IS NULL`
  );
  for (const id of messageIds) stmt.run(now, recipient, id);
}

export function ackMessages(db, recipient, ids, now) {
  const acked = [];
  const notFound = [];
  const getStmt = db.prepare('SELECT 1 AS x FROM receipts WHERE message_id = ? AND recipient = ?');
  const updStmt = db.prepare(
    `UPDATE receipts SET acked_ts = ?, read_ts = COALESCE(read_ts, ?) WHERE message_id = ? AND recipient = ?`
  );
  for (const id of ids) {
    const row = getStmt.get(id, recipient);
    if (!row) {
      notFound.push(id);
      continue;
    }
    updStmt.run(now, now, id, recipient);
    acked.push(id);
  }
  return { acked, notFound };
}

export function getThread(db, threadId) {
  return db
    .prepare(
      `SELECT id, ts, sender, recipients_json, subject, body, thread_id, reply_to, priority
       FROM messages WHERE thread_id = ? ORDER BY ts ASC`
    )
    .all(threadId);
}

export function lastNudgeTs(db, recipient) {
  const row = db.prepare('SELECT ts FROM nudges WHERE recipient = ?').get(recipient);
  return row ? Number(row.ts) : 0;
}

export function recordNudge(db, recipient, ts) {
  db.prepare(
    `INSERT INTO nudges (recipient, ts) VALUES (?, ?)
     ON CONFLICT(recipient) DO UPDATE SET ts = excluded.ts`
  ).run(recipient, ts);
}

export function unreadCountsByRecipient(db) {
  const rows = db
    .prepare('SELECT recipient, COUNT(*) AS c FROM receipts WHERE read_ts IS NULL GROUP BY recipient')
    .all();
  const map = {};
  for (const r of rows) map[r.recipient] = Number(r.c);
  return map;
}
