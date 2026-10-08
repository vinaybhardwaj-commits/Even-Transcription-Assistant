// SQLite store (node:sqlite, no npm deps). WAL mode, busy_timeout so the
// ~13 concurrent eta-bus processes can share one file safely.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './constants.mjs';

let dbSingleton = null;
let dbSingletonPath = null;
let dbSingletonWalKey = null;

// (dev,ino) of the -wal file, or null if it doesn't exist right now (e.g.
// right after a full checkpoint). SQLite documents that renaming, deleting,
// or replacing the -wal/-shm files out from under an open connection is
// unsafe: that connection's fd/mmap keeps pointing at the old file and
// silently stops seeing commits made through the new one.
function walIdentityKey(dbPath) {
  try {
    const st = fs.statSync(`${dbPath}-wal`);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

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
  migrateRecipientCasing(db);
  return db;
}

// ETA-Refuter's finding (23 Sep 2026): receipts.recipient and
// nudges.recipient were plain TEXT with no normalisation, so "eta-refuter"
// and "ETA-Refuter" were two separate mailboxes — a message addressed with
// the wrong casing was accepted, stored, counted unread, and never
// nudged, with the sender seeing a successful send. Confirmed live: ids 5
// and 6 in production, one per casing, only the second ever nudged.
// One-time fold of any pre-existing mixed-case rows into lower(recipient),
// run on every openDb() so it's idempotent and self-healing if it ever
// happens again before the write-side fix below fully takes effect
// everywhere. `OR IGNORE` handles the rare case where both casings already
// have a row for the exact same message_id (only possible if one bus_post
// call named the same recipient twice under different casing) — the
// surviving lowercase row is kept as-is rather than merging read/acked
// state, since that collision is vanishingly rare and never observed.
function migrateRecipientCasing(db) {
  db.exec(`UPDATE OR IGNORE receipts SET recipient = lower(recipient) WHERE recipient != lower(recipient);`);
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS _nudges_folded AS
      SELECT lower(recipient) AS recipient, MAX(ts) AS ts FROM nudges GROUP BY lower(recipient);
  `);
  db.exec(`DELETE FROM nudges;`);
  db.exec(`INSERT INTO nudges (recipient, ts) SELECT recipient, ts FROM _nudges_folded;`);
  db.exec(`DROP TABLE _nudges_folded;`);
}

// Process-wide singleton for the real bus DB path; tests pass their own
// temp path directly to the query functions below instead of using this.
//
// Root cause of the "bus_inbox returns [] while unread rows exist" bug (23
// Sep 2026, confirmed live via lsof on the Mini: every long-lived
// eta-bus-mcp process shares one inode for bus.db, but one process's open
// bus.db-wal/bus.db-shm fds pointed at a DIFFERENT inode than every other
// process and than the current directory entry — a stale, orphaned WAL/SHM
// pair from before some external file replacement (checkpoint, backup,
// manual cleanup) while that connection was still open). SQLite's own docs
// call this exact pattern unsafe. Rather than rely on it never happening
// again, self-heal: check the -wal file's (dev,ino) on every call, and
// transparently reopen if it no longer matches what we opened.
// `customPath` defaults to the real bus DB and only exists so tests can
// drive this exact staleness-detection path against a scratch file instead
// of reimplementing it.
export function getDb(customPath = DB_PATH) {
  const currentWalKey = walIdentityKey(customPath);
  const stale =
    dbSingleton &&
    dbSingletonPath === customPath &&
    dbSingletonWalKey !== null &&
    currentWalKey !== null &&
    currentWalKey !== dbSingletonWalKey;
  if (!dbSingleton || dbSingletonPath !== customPath || stale) {
    // Deliberately NOT closing the stale connection here (verified live, 23 Sep 2026): its fd
    // still points at the orphaned -wal file, and DatabaseSync.close() runs a final checkpoint
    // using that fd, replaying the connection's own STALE page images into the shared bus.db
    // main file -- which can silently clobber newer commits other connections already
    // checkpointed there through the current -wal/-shm. Dropping the reference and leaving the
    // stale connection unclosed (its fd is released when the process exits or it's GC'd without
    // an explicit close) is the safe choice; the alternative is data loss.
    dbSingleton = openDb(customPath);
    dbSingletonPath = customPath;
    dbSingletonWalKey = walIdentityKey(customPath);
  }
  return dbSingleton;
}

// ---------- transactions (fix round ruling 9) ----------
//
// BEGIN IMMEDIATE takes SQLite's write lock up front (rather than on the
// first write statement), so two processes racing to claim the same
// recipient's inbox — or to post the same message — are fully
// serialized by SQLite itself, not just by in-process logic. Whichever
// process's BEGIN IMMEDIATE wins holds the lock until COMMIT/ROLLBACK;
// the other blocks (up to busy_timeout) and then sees the first
// transaction's committed effects before it runs its own SELECT.

// Root cause of the "bus_inbox stuck returning stale/empty results" bug (23 Sep 2026, confirmed
// live on both a box pane (lx) and a Mini pane (herdr-kit) — ruling out anything ssh-tunnel- or
// machine-specific): the comment above only reasoned about CROSS-PROCESS races (two separate
// node processes, each its own `db` connection, correctly serialized by SQLite's own file lock
// on BEGIN IMMEDIATE). It missed the WITHIN-process case. Every exported MCP tool handler
// (tools.mjs) is async and does a real await BEFORE reaching withTransaction (identity
// resolution alone spawns a `herdr agent list` subprocess) — so if two tool calls land on the
// SAME server process close together (Claude Code can and does issue parallel tool calls in one
// turn), Node's event loop can interleave them: caller A's `BEGIN IMMEDIATE` succeeds, then
// caller B's ALSO runs (same connection, so SQLite's file lock does not apply — nothing stops
// it) before A's COMMIT. node:sqlite has no nested-transaction support, so B's BEGIN either
// errors or silently corrupts the connection's transaction accounting; a caller left holding a
// transaction that never truly commits keeps reading the snapshot from whenever that happened,
// for the rest of that process's life -- exactly the "always returns id=4" symptom seen live.
//
// Fixed by serializing every call through this one process's own transaction queue: a second
// call's BEGIN IMMEDIATE now provably never starts before the first one's COMMIT/ROLLBACK has
// already happened, so the two-processes-racing scenario the file lock still handles is
// untouched, and the same-process race this queue closes can no longer occur at all.
let _txnQueue = Promise.resolve();

export function withTransaction(db, fn) {
  const run = () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore — original err is what matters
      }
      throw err;
    }
  };
  const result = _txnQueue.then(run, run); // run next regardless of whether the previous call threw
  _txnQueue = result.then(
    () => undefined,
    () => undefined, // never let a rejection here stop the queue for the NEXT caller
  );
  return result;
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

// Recipient identity is case-insensitive everywhere it's a lookup key
// (receipts, nudges) — see migrateRecipientCasing above. Never applied to
// recipients_json or the sender field, which stay as-typed for display.
function normalizeRecipient(recipient) {
  return String(recipient ?? '').toLowerCase();
}

export function insertReceipt(db, messageId, recipient) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO receipts (message_id, recipient, read_ts, acked_ts)
    VALUES (?, ?, NULL, NULL)
  `);
  stmt.run(messageId, normalizeRecipient(recipient));
}

// Fix round ruling 9: bus_post's message insert and its per-recipient
// receipt inserts happen in one transaction — a message is never visible
// to any recipient's inbox with only some of its receipts created.
export function insertMessageWithReceipts(db, msg, recipients) {
  return withTransaction(db, () => {
    const id = insertMessage(db, msg);
    for (const r of recipients) insertReceipt(db, id, r);
    return id;
  });
}

export function getUnreadCount(db, recipient) {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM receipts WHERE recipient = ? AND read_ts IS NULL')
    .get(normalizeRecipient(recipient));
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
    .get(normalizeRecipient(recipient));
}

export function listInbox(db, recipient, { unreadOnly = true, limit = 20 } = {}) {
  recipient = normalizeRecipient(recipient);
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

// Fix round ruling 9: claim-then-return in one transaction. `selectFn`
// receives the newest-first candidate rows and returns the subset (any
// order) to actually claim; ONLY that subset is marked read, and it is
// returned oldest-first (matching the previous listInbox() convention).
// Because this runs inside a single BEGIN IMMEDIATE transaction, two
// processes sharing the same recipient identity can never both claim the
// same message: the second process's SELECT only runs after the first's
// UPDATE has committed, so it sees those messages as already read.
export function claimInbox(db, recipient, { unreadOnly = true, limit = 20 } = {}, selectFn) {
  recipient = normalizeRecipient(recipient);
  return withTransaction(db, () => {
    const sql = unreadOnly
      ? `SELECT m.id AS id, m.ts AS ts, m.sender AS sender, m.subject AS subject, m.body AS body, m.thread_id AS thread_id
         FROM receipts r JOIN messages m ON m.id = r.message_id
         WHERE r.recipient = ? AND r.read_ts IS NULL
         ORDER BY m.ts DESC LIMIT ?`
      : `SELECT m.id AS id, m.ts AS ts, m.sender AS sender, m.subject AS subject, m.body AS body, m.thread_id AS thread_id
         FROM receipts r JOIN messages m ON m.id = r.message_id
         WHERE r.recipient = ?
         ORDER BY m.ts DESC LIMIT ?`;
    const candidatesNewestFirst = db.prepare(sql).all(recipient, limit);
    const chosenNewestFirst = selectFn(candidatesNewestFirst);
    const now = Date.now();
    const ids = chosenNewestFirst.map((r) => r.id);
    markRead(db, recipient, ids, now);
    return chosenNewestFirst.slice().reverse(); // oldest-first for display
  });
}

export function markRead(db, recipient, messageIds, now) {
  if (messageIds.length === 0) return;
  recipient = normalizeRecipient(recipient);
  const stmt = db.prepare(
    `UPDATE receipts SET read_ts = ? WHERE recipient = ? AND message_id = ? AND read_ts IS NULL`
  );
  for (const id of messageIds) stmt.run(now, recipient, id);
}

export function ackMessages(db, recipient, ids, now) {
  recipient = normalizeRecipient(recipient);
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
  const row = db.prepare('SELECT ts FROM nudges WHERE recipient = ?').get(normalizeRecipient(recipient));
  return row ? Number(row.ts) : 0;
}

export function recordNudge(db, recipient, ts) {
  db.prepare(
    `INSERT INTO nudges (recipient, ts) VALUES (?, ?)
     ON CONFLICT(recipient) DO UPDATE SET ts = excluded.ts`
  ).run(normalizeRecipient(recipient), ts);
}

export function unreadCountsByRecipient(db) {
  const rows = db
    .prepare('SELECT recipient, COUNT(*) AS c FROM receipts WHERE read_ts IS NULL GROUP BY recipient')
    .all();
  const map = {};
  for (const r of rows) map[r.recipient] = Number(r.c);
  return map;
}
