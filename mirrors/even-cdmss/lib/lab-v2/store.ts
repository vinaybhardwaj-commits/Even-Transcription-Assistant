/**
 * lib/lab-v2/store.ts — every durable operation the platform performs
 * (LAB-MCP-V2-PRD-v1.0 §4.1, §5, §6.3).
 *
 * The SQL lives here and nowhere else. Tool handlers compose these functions; the worker
 * composes these functions; nothing above this file writes a statement of its own. That
 * is what lets the lease and budget invariants be stated once and tested once.
 *
 * TWO INVARIANTS CARRY THE WHOLE DESIGN.
 *
 *  1. THE LEASE TOKEN. Every claim increments `items.lease_token`. Every subsequent write
 *     for that attempt asserts the token it was given. A worker that was killed, came
 *     back, and tried to finish an item that has since been reaped and re-claimed will
 *     assert a stale token, match zero rows, and write nothing. Without this, the reaper
 *     and a zombie worker race to write the same row and the zombie sometimes wins.
 *
 *  2. THE BUDGET INEQUALITY. `spent + reserved + unknown + delta <= cap`, evaluated
 *     inside the same UPDATE that adds the reservation. Not read-then-write — the check
 *     and the increment are one statement, so two concurrent calls cannot both observe
 *     room for the last reservation. Zero rows updated IS the refusal.
 */
import { randomUUID } from 'crypto';
import type { Db } from './db';
import {
  LabError, hash, LEASE_MS, MAX_ATTEMPTS, REQUEUE_DELAY_MS, WORKER_ID,
  type Classification, type ObjectKind, type ItemState, type RunState,
} from './contracts';

const S = (ms: number) => ms / 1000;

// ── objects ──────────────────────────────────────────────────────────────────────────
export interface StoredObject {
  id: string; owner: string; kind: ObjectKind; body: Record<string, unknown>;
  hash: string; classification: Classification; created_at: string; idempotency_key: string | null;
}

/**
 * Store an immutable body. Two conflicts are possible and they mean different things:
 * the same (owner, kind, idempotency_key) is a RETRY and returns the prior row; the same
 * (kind, hash) is the SAME BODY reached by a different route and returns that row. Both
 * report `deduplicated`, because a caller that submitted twice deserves to know it got
 * one object rather than two.
 */
export async function putObject(
  db: Db, owner: string, kind: ObjectKind, body: unknown,
  classification: Classification, idempotencyKey: string | null,
): Promise<{ object: StoredObject; deduplicated: boolean }> {
  const h = hash(body);
  const existing = await db.query<StoredObject>(
    `SELECT * FROM lab_v2.objects WHERE kind = $1 AND (hash = $2 OR (owner = $3 AND idempotency_key IS NOT DISTINCT FROM $4 AND $4 IS NOT NULL)) LIMIT 1`,
    [kind, h, owner, idempotencyKey],
  );
  if (existing.length) return { object: existing[0], deduplicated: true };
  const rows = await db.query<StoredObject>(
    `INSERT INTO lab_v2.objects (owner, kind, body, hash, classification, idempotency_key)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     ON CONFLICT (kind, hash) DO UPDATE SET hash = EXCLUDED.hash
     RETURNING *`,
    [owner, kind, JSON.stringify(body), h, classification, idempotencyKey],
  );
  return { object: rows[0], deduplicated: false };
}

export async function getObject(db: Db, id: string): Promise<StoredObject | null> {
  const rows = await db.query<StoredObject>(`SELECT * FROM lab_v2.objects WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// ── budgets ──────────────────────────────────────────────────────────────────────────
export interface Budget {
  id: string; owner: string; name: string;
  cap_microusd: string; reserved_microusd: string; spent_microusd: string; unknown_microusd: string;
}

export async function ensureBudget(db: Db, owner: string, name: string, capMicrousd: number): Promise<Budget> {
  const rows = await db.query<Budget>(
    `INSERT INTO lab_v2.budgets (owner, name, cap_microusd) VALUES ($1, $2, $3)
     ON CONFLICT (owner, name) DO UPDATE SET cap_microusd = GREATEST(lab_v2.budgets.cap_microusd, EXCLUDED.cap_microusd)
     RETURNING *`,
    [owner, name, capMicrousd],
  );
  return rows[0];
}

export async function getBudget(db: Db, id: string): Promise<Budget | null> {
  const rows = await db.query<Budget>(`SELECT * FROM lab_v2.budgets WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Atomic reservation (§6.3). The inequality is IN the WHERE clause: either the row moves
 * and there was room, or no row moves and there was not. Zero rows is BUDGET_EXHAUSTED —
 * the caller records the call as `refused` and fails the item with error.category
 * 'budget'. There is no read-check-write window for a second call to slip through.
 */
export async function reserve(db: Db, budgetId: string, maxMicrousd: number): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.budgets SET reserved_microusd = reserved_microusd + $2
     WHERE id = $1 AND spent_microusd + reserved_microusd + unknown_microusd + $2 <= cap_microusd
     RETURNING id`,
    [budgetId, maxMicrousd],
  );
  return rows.length > 0;
}

/** Settle: the reservation comes off `reserved` and the measured cost goes onto `spent`. */
export async function settleReservation(db: Db, budgetId: string, reservedMicrousd: number, actualMicrousd: number): Promise<void> {
  await db.query(
    `UPDATE lab_v2.budgets SET reserved_microusd = GREATEST(0, reserved_microusd - $2), spent_microusd = spent_microusd + $3 WHERE id = $1`,
    [budgetId, reservedMicrousd, actualMicrousd],
  );
}

/**
 * A transport error with no usage. The money may or may not have been spent and we cannot
 * tell, so it moves reserved → unknown and STAYS against the cap until reconciled. This
 * is the one place a budget could silently forget, and it deliberately does not.
 */
export async function moveReservationToUnknown(db: Db, budgetId: string, reservedMicrousd: number): Promise<void> {
  await db.query(
    `UPDATE lab_v2.budgets SET reserved_microusd = GREATEST(0, reserved_microusd - $2), unknown_microusd = unknown_microusd + $2 WHERE id = $1`,
    [budgetId, reservedMicrousd],
  );
}

// ── calls ────────────────────────────────────────────────────────────────────────────
export async function openCall(
  db: Db, itemId: string, leaseToken: number, stage: string, budgetId: string,
  requested: unknown, reservedMicrousd: number, pricingVersion: string, state: 'reserved' | 'refused',
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO lab_v2.calls (item_id, lease_token, stage, budget_id, requested, request_hash, reserved_microusd, state, pricing_version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING id`,
    [itemId, leaseToken, stage, budgetId, JSON.stringify(requested), hash(requested), reservedMicrousd, state, pricingVersion],
  );
  return rows[0].id;
}

export async function settleCall(db: Db, callId: string, served: unknown, actualMicrousd: number | null): Promise<void> {
  await db.query(
    `UPDATE lab_v2.calls SET state = 'settled', served = $2::jsonb, actual_microusd = $3, settled_at = now() WHERE id = $1`,
    [callId, JSON.stringify(served ?? null), actualMicrousd],
  );
}

export async function markCallUnknown(db: Db, callId: string): Promise<void> {
  await db.query(`UPDATE lab_v2.calls SET state = 'unknown', settled_at = now() WHERE id = $1`, [callId]);
}

// ── events ───────────────────────────────────────────────────────────────────────────
export async function recordEvent(db: Db, actor: string, aggregate: string, kind: string, body: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO lab_v2.events (actor, aggregate, kind, body) VALUES ($1, $2, $3, $4::jsonb)`,
    [actor, aggregate, kind, JSON.stringify(body)],
  );
}

// ── workers ──────────────────────────────────────────────────────────────────────────
export interface Worker { id: string; paused: boolean; revision: number; heartbeat_at: string | null; active_item: string | null }

export async function getWorker(db: Db, id: string = WORKER_ID): Promise<Worker> {
  const rows = await db.query<Worker>(`SELECT * FROM lab_v2.workers WHERE id = $1`, [id]);
  if (rows.length) return rows[0];
  const created = await db.query<Worker>(`INSERT INTO lab_v2.workers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING *`, [id]);
  return created[0] ?? { id, paused: false, revision: 0, heartbeat_at: null, active_item: null };
}

export async function setWorkerPaused(db: Db, paused: boolean, id: string = WORKER_ID): Promise<Worker> {
  await getWorker(db, id);
  const rows = await db.query<Worker>(
    `UPDATE lab_v2.workers SET paused = $2, revision = revision + 1 WHERE id = $1 RETURNING *`, [id, paused],
  );
  return rows[0];
}

// ── runs and items ───────────────────────────────────────────────────────────────────
export interface Item {
  id: string; run_id: string; case_key: string; arm_hash: string; repetition: number;
  payload: Record<string, unknown>; state: ItemState; next_at: string;
  lease_owner: string | null; lease_token: number; lease_expires_at: string | null;
  attempts: number; error: Record<string, unknown> | null; result: Record<string, unknown> | null;
  execution_status: string | null; assessment_status: string | null; attribution_status: string | null;
}
export interface Run {
  id: string; owner: string; experiment_id: string | null; operation: string; request_hash: string;
  idempotency_key: string; budget_id: string; state: RunState;
  cancel_requested_at: string | null; created_at: string; deadline_at: string;
}

export interface NewItem { case_key: string; arm_hash: string; repetition: number; payload: unknown }

/**
 * §5.2 — the run and all its items in ONE transaction, then return before any model
 * work. The unique index on (owner, operation, idempotency_key) is the deduplication
 * mechanism; we probe first for the common case and rely on the constraint for the race.
 */
export async function submitRun(
  db: Db, owner: string, operation: string, experimentId: string | null, budgetId: string,
  idempotencyKey: string, requestHash: string, deadlineMs: number, items: NewItem[],
): Promise<{ run: Run; itemCount: number; deduplicated: boolean }> {
  const prior = await db.query<Run>(
    `SELECT * FROM lab_v2.runs WHERE owner = $1 AND operation = $2 AND idempotency_key = $3`,
    [owner, operation, idempotencyKey],
  );
  if (prior.length) {
    const n = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.items WHERE run_id = $1`, [prior[0].id]);
    return { run: prior[0], itemCount: Number(n[0].c), deduplicated: true };
  }
  return db.transaction(async (tx) => {
    const runRows = await tx.query<Run>(
      `INSERT INTO lab_v2.runs (owner, experiment_id, operation, request_hash, idempotency_key, budget_id, state, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', now() + make_interval(secs => $7))
       ON CONFLICT (owner, operation, idempotency_key) DO NOTHING
       RETURNING *`,
      [owner, experimentId, operation, requestHash, idempotencyKey, budgetId, S(deadlineMs)],
    );
    if (!runRows.length) {
      const raced = await tx.query<Run>(
        `SELECT * FROM lab_v2.runs WHERE owner = $1 AND operation = $2 AND idempotency_key = $3`,
        [owner, operation, idempotencyKey],
      );
      const n = await tx.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.items WHERE run_id = $1`, [raced[0].id]);
      return { run: raced[0], itemCount: Number(n[0].c), deduplicated: true };
    }
    const run = runRows[0];
    for (const it of items) {
      await tx.query(
        `INSERT INTO lab_v2.items (run_id, case_key, arm_hash, repetition, payload, state)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'queued')
         ON CONFLICT (run_id, case_key, arm_hash, repetition) DO NOTHING`,
        [run.id, it.case_key, it.arm_hash, it.repetition, JSON.stringify(it.payload)],
      );
    }
    return { run, itemCount: items.length, deduplicated: false };
  });
}

export async function getRun(db: Db, id: string): Promise<Run | null> {
  const rows = await db.query<Run>(`SELECT * FROM lab_v2.runs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function itemsOf(db: Db, runId: string, limit = 1000, offset = 0): Promise<Item[]> {
  return db.query<Item>(
    `SELECT * FROM lab_v2.items WHERE run_id = $1 ORDER BY case_key, arm_hash, repetition LIMIT $2 OFFSET $3`,
    [runId, limit, offset],
  );
}

export async function countItemsByState(db: Db, runId: string): Promise<Record<string, number>> {
  const rows = await db.query<{ state: string; c: string }>(
    `SELECT state, count(*)::text AS c FROM lab_v2.items WHERE run_id = $1 GROUP BY state`, [runId],
  );
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.c)]));
}

/**
 * §5.1 — run state derived from its items, in the PRD's precedence order. Expiry is
 * checked FIRST and it is a real transition, not a label: items still queued past the
 * deadline move to `expired` so the reaper stops considering them.
 */
export async function deriveRunState(db: Db, runId: string): Promise<RunState> {
  const run = await getRun(db, runId);
  if (!run) throw new LabError('NOT_FOUND', `run ${runId} not found`);
  const expiredNow = await db.query<{ id: string }>(
    `UPDATE lab_v2.items SET state = 'expired'
     WHERE run_id = $1 AND state = 'queued' AND now() > (SELECT deadline_at FROM lab_v2.runs WHERE id = $1)
     RETURNING id`, [runId],
  );
  const counts = await countItemsByState(db, runId);
  const n = (k: string) => counts[k] ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let state: RunState;
  if (expiredNow.length && n('running') === 0 && n('succeeded') === 0) state = 'expired';
  else if (run.cancel_requested_at && n('running') === 0) state = 'cancelled';
  else if (total > 0 && n('succeeded') === total) state = 'succeeded';
  else if (total > 0 && n('failed') + n('expired') === total) state = 'failed';
  else if (n('succeeded') > 0 && (n('failed') > 0 || n('expired') > 0) && n('running') === 0 && n('queued') === 0) state = 'partial';
  else if (n('running') > 0) state = 'running';
  else if (n('queued') > 0) state = 'queued';
  else if (n('cancelled') > 0) state = 'cancelled';
  else state = 'queued';
  await db.query(`UPDATE lab_v2.runs SET state = $2 WHERE id = $1`, [runId, state]);
  return state;
}

// ── the queue: claim, heartbeat, finish, reap (§5.3) ─────────────────────────────────

/**
 * §5.3.3 — claim exactly one queued item. `FOR UPDATE SKIP LOCKED` inside the subquery is
 * what makes two concurrent ticks pick DIFFERENT rows instead of blocking on each other
 * or both winning. `lease_token + 1` stamps this attempt's identity.
 */
export async function claim(db: Db, worker: string = WORKER_ID): Promise<Item | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<Item>(
      `UPDATE lab_v2.items SET state = 'running', lease_owner = $1, lease_token = lease_token + 1,
              lease_expires_at = now() + make_interval(secs => $2), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM lab_v2.items
         WHERE state = 'queued' AND next_at <= now()
         ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [worker, S(LEASE_MS)],
    );
    if (!rows.length) return null;
    const item = rows[0];
    await tx.query(
      `INSERT INTO lab_v2.attempts (item_id, lease_token, worker) VALUES ($1, $2, $3)`,
      [item.id, item.lease_token, worker],
    );
    await tx.query(`UPDATE lab_v2.workers SET active_item = $2, heartbeat_at = now() WHERE id = $1`, [worker, item.id]);
    return item;
  });
}

/** Extend the lease, asserting the token. False means the lease was lost — abort. */
export async function heartbeat(db: Db, itemId: string, leaseToken: number, worker: string = WORKER_ID): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.items SET lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1 AND lease_token = $2 AND state = 'running' RETURNING id`,
    [itemId, leaseToken, S(LEASE_MS)],
  );
  if (rows.length) await db.query(`UPDATE lab_v2.workers SET heartbeat_at = now() WHERE id = $1`, [worker]);
  return rows.length > 0;
}

export async function assertLease(db: Db, itemId: string, leaseToken: number): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM lab_v2.items WHERE id = $1 AND lease_token = $2 AND state = 'running'`, [itemId, leaseToken],
  );
  return rows.length > 0;
}

export interface FinishInput {
  state: ItemState;
  result: unknown | null;
  error: Record<string, unknown> | null;
  execution_status: string;
  assessment_status: string;
  attribution_status: string;
  outcome: string;
}

/**
 * §5.3.5 — the single transaction that ends an attempt. The lease token is asserted in
 * the UPDATE's WHERE clause, so a worker whose lease was reaped writes NOTHING and says
 * so by returning false. All three statuses are set here and only here, which is why
 * §9's "all three on every finished item" is structurally true rather than a convention.
 */
export async function finish(db: Db, itemId: string, leaseToken: number, input: FinishInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `UPDATE lab_v2.items
       SET state = $3, result = $4::jsonb, error = $5::jsonb,
           execution_status = $6, assessment_status = $7, attribution_status = $8,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND state = 'running'
       RETURNING id`,
      [itemId, leaseToken, input.state, JSON.stringify(input.result ?? null), JSON.stringify(input.error ?? null),
        input.execution_status, input.assessment_status, input.attribution_status],
    );
    if (!rows.length) return false;
    await tx.query(
      `UPDATE lab_v2.attempts SET ended_at = now(), outcome = $3 WHERE item_id = $1 AND lease_token = $2`,
      [itemId, leaseToken, input.outcome],
    );
    await tx.query(`UPDATE lab_v2.workers SET active_item = NULL WHERE active_item = $1`, [itemId]);
    return true;
  });
}

/**
 * §5.3.1 — reap expired leases.
 *
 * ⚠️ ATTEMPT COUNTING. `attempts` is incremented once, at claim. The PRD's §5.3.1 phrase
 * "attempts + 1" describes the count that claim already consumed, not a second increment:
 * §15.6 requires that a THIRD abandonment expires the item, and with MAX_ATTEMPTS = 3
 * that is only true if each claim-and-abandon cycle costs exactly one. Incrementing in
 * both places would expire on the second abandonment.
 */
export async function reap(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const dead = await tx.query<Item>(
      `SELECT * FROM lab_v2.items WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now() FOR UPDATE SKIP LOCKED`,
    );
    for (const item of dead) {
      await tx.query(
        `UPDATE lab_v2.attempts SET ended_at = now(), outcome = 'abandoned' WHERE item_id = $1 AND lease_token = $2 AND ended_at IS NULL`,
        [item.id, item.lease_token],
      );
      // Money reserved by that attempt is now unattributable: move it to `unknown`.
      const orphaned = await tx.query<{ id: string; budget_id: string; reserved_microusd: string }>(
        `SELECT id, budget_id, reserved_microusd FROM lab_v2.calls WHERE item_id = $1 AND lease_token = $2 AND state = 'reserved'`,
        [item.id, item.lease_token],
      );
      for (const c of orphaned) {
        await moveReservationToUnknown(tx, c.budget_id, Number(c.reserved_microusd));
        await markCallUnknown(tx, c.id);
      }
      const exhausted = item.attempts >= MAX_ATTEMPTS;
      await tx.query(
        exhausted
          ? `UPDATE lab_v2.items SET state = 'expired', lease_owner = NULL, lease_expires_at = NULL,
               execution_status = COALESCE(execution_status, 'expired'),
               assessment_status = COALESCE(assessment_status, 'not_reached'),
               attribution_status = COALESCE(attribution_status, 'unknown')
             WHERE id = $1`
          : `UPDATE lab_v2.items SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
               next_at = now() + make_interval(secs => ${S(REQUEUE_DELAY_MS)}) WHERE id = $1`,
        [item.id],
      );
      await tx.query(`UPDATE lab_v2.workers SET active_item = NULL WHERE active_item = $1`, [item.id]);
      await recordEvent(tx, 'system', item.id, 'item_reaped', { attempts: item.attempts, expired: exhausted });
    }
    return dead.length;
  });
}

/** §5.4 — queued items cancel at once; running ones are signalled at their next heartbeat. */
export async function requestCancel(db: Db, runId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query(`UPDATE lab_v2.runs SET cancel_requested_at = COALESCE(cancel_requested_at, now()) WHERE id = $1`, [runId]);
    const rows = await tx.query<{ id: string }>(
      `UPDATE lab_v2.items SET state = 'cancelled',
         execution_status = 'cancelled', assessment_status = 'not_reached',
         attribution_status = COALESCE(attribution_status, 'unknown')
       WHERE run_id = $1 AND state = 'queued' RETURNING id`,
      [runId],
    );
    return rows.length;
  });
}

export async function isCancelRequested(db: Db, runId: string): Promise<boolean> {
  const rows = await db.query<{ c: string | null }>(`SELECT cancel_requested_at AS c FROM lab_v2.runs WHERE id = $1`, [runId]);
  return !!rows[0]?.c;
}

/** §5.5 — re-queue failed/expired items as NEW attempts on the SAME item id. Never a succeeded one. */
export async function retryRun(db: Db, runId: string): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.items SET state = 'queued', next_at = now(), attempts = 0, error = NULL,
       execution_status = NULL, assessment_status = NULL, attribution_status = NULL
     WHERE run_id = $1 AND state IN ('failed', 'expired') RETURNING id`,
    [runId],
  );
  if (rows.length) await db.query(`UPDATE lab_v2.runs SET cancel_requested_at = NULL, state = 'queued' WHERE id = $1`, [runId]);
  return rows.length;
}

// ── migrations (§4, §14.4) ───────────────────────────────────────────────────────────
export interface MigrationFile { name: string; sql: string; checksum: string }

/**
 * Apply by name order, record by name and checksum. A checksum that differs from the one
 * recorded for an already-applied name is an ERROR, never a re-apply: the file changed
 * after it ran, so the database and the repository disagree and only a human can say
 * which is right.
 */
export async function applyMigrations(db: Db, files: MigrationFile[]): Promise<{ applied: string[]; skipped: string[] }> {
  await db.exec(`CREATE SCHEMA IF NOT EXISTS lab_v2`);
  await db.exec(`CREATE TABLE IF NOT EXISTS lab_v2.migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied: string[] = []; const skipped: string[] = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const prior = await db.query<{ checksum: string }>(`SELECT checksum FROM lab_v2.migrations WHERE name = $1`, [f.name]);
    if (prior.length) {
      if (prior[0].checksum !== f.checksum) {
        throw new LabError('STORE_UNAVAILABLE', `migration ${f.name} was applied with checksum ${prior[0].checksum} but the file now hashes to ${f.checksum}`);
      }
      skipped.push(f.name);
      continue;
    }
    await db.exec(f.sql);
    await db.query(`INSERT INTO lab_v2.migrations (name, checksum) VALUES ($1, $2)`, [f.name, f.checksum]);
    applied.push(f.name);
  }
  return { applied, skipped };
}

export async function appliedMigrations(db: Db): Promise<string[]> {
  const rows = await db.query<{ name: string }>(`SELECT name FROM lab_v2.migrations ORDER BY name`);
  return rows.map((r) => r.name);
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Slice C, §11 — the release ledger: targets, reviews, receipts (0002_releases.sql)
// ─────────────────────────────────────────────────────────────────────────────────────

export interface TargetRow {
  name: string; revision: string | number;
  artifact_id: string | null; predecessor_id: string | null; release_id: string | null;
  updated_at: string;
}

export interface ReviewRow {
  id: string; release_id: string; reviewer: string; artifact_hash: string;
  decision: string; rationale: string; created_at: string; expires_at: string;
  idempotency_key: string | null;
}

export interface ReceiptRow {
  id: string; release_id: string; target: string; revision: string | number;
  kind: string; body: unknown; created_at: string;
}

/**
 * ⚠️ `revision` IS bigint AND THE DRIVER RETURNS IT AS A STRING (decision 72, again). Every read
 * of it goes through this, so a compare-and-swap can never compare a string with a number and
 * conclude the revision moved when it did not.
 */
export const asRevision = (v: unknown): number => {
  const n = v == null || v === '' ? NaN : Number(v);
  if (!Number.isSafeInteger(n)) throw new LabError('STORE_UNAVAILABLE', `targets.revision is not an integer: ${JSON.stringify(v)}`);
  return n;
};

export async function getTarget(db: Db, name: string): Promise<{ name: string; revision: number; artifact_id: string | null; predecessor_id: string | null; release_id: string | null } | null> {
  const rows = await db.query<TargetRow>(`SELECT * FROM lab_v2.targets WHERE name = $1`, [name]);
  const r = rows[0];
  return r ? { name: r.name, revision: asRevision(r.revision), artifact_id: r.artifact_id, predecessor_id: r.predecessor_id, release_id: r.release_id } : null;
}

export async function listTargets(db: Db): Promise<{ name: string; revision: number; artifact_id: string | null; predecessor_id: string | null; release_id: string | null }[]> {
  const rows = await db.query<TargetRow>(`SELECT * FROM lab_v2.targets ORDER BY name`);
  return rows.map((r) => ({ name: r.name, revision: asRevision(r.revision), artifact_id: r.artifact_id, predecessor_id: r.predecessor_id, release_id: r.release_id }));
}

/**
 * §11 — THE COMPARE-AND-SWAP. Zero rows updated is the refusal, atomically: two releases prepared
 * against the same revision cannot both land, and the loser is told `REVISION_MISMATCH` rather
 * than silently overwriting the winner. The revision is bumped in the SAME statement that checks
 * it, so nothing can slip between the read and the write.
 */
export async function advanceTarget(
  db: Db, name: string, expectedRevision: number,
  next: { artifact_id: string | null; predecessor_id: string | null; release_id: string | null },
): Promise<number | null> {
  const rows = await db.query<{ revision: string | number }>(
    `UPDATE lab_v2.targets
        SET revision = revision + 1, artifact_id = $3, predecessor_id = $4, release_id = $5, updated_at = now()
      WHERE name = $1 AND revision = $2
      RETURNING revision`,
    [name, expectedRevision, next.artifact_id, next.predecessor_id, next.release_id],
  );
  return rows.length ? asRevision(rows[0].revision) : null;
}

export async function putReview(db: Db, r: {
  release_id: string; reviewer: string; artifact_hash: string; decision: string;
  rationale: string; expires_at: string; idempotency_key: string | null;
}): Promise<ReviewRow> {
  const existing = r.idempotency_key
    ? await db.query<ReviewRow>(`SELECT * FROM lab_v2.reviews WHERE reviewer = $1 AND idempotency_key = $2`, [r.reviewer, r.idempotency_key])
    : [];
  if (existing.length) return existing[0];
  const rows = await db.query<ReviewRow>(
    `INSERT INTO lab_v2.reviews (release_id, reviewer, artifact_hash, decision, rationale, expires_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [r.release_id, r.reviewer, r.artifact_hash, r.decision, r.rationale, r.expires_at, r.idempotency_key],
  );
  return rows[0];
}

/** Every review of one release, newest first. The caller decides which of them still binds. */
export async function reviewsOf(db: Db, releaseId: string): Promise<ReviewRow[]> {
  return db.query<ReviewRow>(
    `SELECT * FROM lab_v2.reviews WHERE release_id = $1 ORDER BY created_at DESC`, [releaseId]);
}

export async function getReceipt(db: Db, releaseId: string, kind: string): Promise<ReceiptRow | null> {
  const rows = await db.query<ReceiptRow>(
    `SELECT * FROM lab_v2.receipts WHERE release_id = $1 AND kind = $2`, [releaseId, kind]);
  return rows[0] ?? null;
}

/**
 * ⚠️ THE UNIQUE INDEX IS THE IDEMPOTENCE, NOT THIS FUNCTION. `ON CONFLICT DO NOTHING` plus a read
 * back means a concurrent second apply cannot slip between the check and the insert: whichever
 * transaction loses reads the winner's receipt and returns it, which is exactly what §11 asks for.
 */
export async function putReceipt(db: Db, r: {
  release_id: string; target: string; revision: number; kind: string; body: unknown;
}): Promise<ReceiptRow> {
  const rows = await db.query<ReceiptRow>(
    `INSERT INTO lab_v2.receipts (release_id, target, revision, kind, body)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (release_id, kind) DO NOTHING
     RETURNING *`,
    [r.release_id, r.target, r.revision, r.kind, JSON.stringify(r.body)],
  );
  if (rows.length) return rows[0];
  const existing = await getReceipt(db, r.release_id, r.kind);
  if (!existing) throw new LabError('STORE_UNAVAILABLE', `receipt for release ${r.release_id} could neither be written nor read back`);
  return existing;
}

/** The last N receipts across every target, newest first — `release_status`'s history. */
export async function recentReceipts(db: Db, limit = 5): Promise<ReceiptRow[]> {
  return db.query<ReceiptRow>(
    `SELECT * FROM lab_v2.receipts ORDER BY created_at DESC LIMIT $1`, [Math.max(1, Math.min(50, limit))]);
}

export const newId = randomUUID;

// ── steps: the exact-replay ledger (§4.1, decision 45) ───────────────────────────────
export interface StepRow { item_id: string; name: string; dependency_hash: string; artifact_id: string }

/**
 * One memoised stage output. `(item_id, name)` is the primary key, so a re-run of the same stage
 * on the same item overwrites rather than accumulating — a step is the LATEST evidence for that
 * stage, and a replay wants the reply the stored result came from.
 */
export async function writeStep(
  db: Db, itemId: string, name: string, dependencyHash: string, body: unknown, owner = 'system',
): Promise<string> {
  const { object } = await putObject(db, owner, 'artifact', body, 'deidentified', null);
  await db.query(
    `INSERT INTO lab_v2.steps (item_id, name, dependency_hash, artifact_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id, name) DO UPDATE SET dependency_hash = EXCLUDED.dependency_hash, artifact_id = EXCLUDED.artifact_id`,
    [itemId, name, dependencyHash, object.id],
  );
  return object.id;
}

/** Every stored stage for one item, by stage name. */
export async function stepsOf(db: Db, itemId: string): Promise<Map<string, StepRow>> {
  const rows = await db.query<StepRow>(
    `SELECT item_id, name, dependency_hash, artifact_id FROM lab_v2.steps WHERE item_id = $1`, [itemId]);
  return new Map(rows.map((r) => [r.name, r]));
}

// ── decision 42: budget_reconcile ────────────────────────────────────────────────────
export interface ReconcileResult {
  call_id: string; from_unknown_microusd: number; to_spent_microusd: number; budget_id: string;
}

/**
 * DECISION 42 — the ONLY way money leaves `unknown`. Nothing moves on its own: an operator names
 * the amount and the reason, and both are stored. The call must actually be in `unknown`, so a
 * settled call cannot be re-settled at a different number and a reconcile cannot be replayed.
 */
export async function reconcileCall(
  db: Db, callId: string, actualMicrousd: number, reason: string, actor: string,
): Promise<ReconcileResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: string; budget_id: string; reserved_microusd: string; state: string }>(
      `SELECT id, budget_id, reserved_microusd, state FROM lab_v2.calls WHERE id = $1 FOR UPDATE`, [callId]);
    const call = rows[0];
    if (!call) throw new LabError('NOT_FOUND', `no call ${callId}`);
    if (call.state !== 'unknown') {
      throw new LabError('INVALID_INPUT', `call ${callId} is '${call.state}', not 'unknown' — only an unknown call can be reconciled`);
    }
    const held = Number(call.reserved_microusd);
    await tx.query(
      `UPDATE lab_v2.budgets SET unknown_microusd = GREATEST(0, unknown_microusd - $2), spent_microusd = spent_microusd + $3 WHERE id = $1`,
      [call.budget_id, held, actualMicrousd]);
    await tx.query(
      `UPDATE lab_v2.calls SET state = 'settled', actual_microusd = $2, settled_at = now(),
         served = COALESCE(served, '{}'::jsonb) || jsonb_build_object('reconciled', true, 'reconcile_reason', $3::text)
       WHERE id = $1`,
      [callId, actualMicrousd, reason]);
    await recordEvent(tx, actor, callId, 'budget_reconciled', {
      call_id: callId, from_unknown_microusd: held, to_spent_microusd: actualMicrousd, reason,
    });
    return { call_id: callId, from_unknown_microusd: held, to_spent_microusd: actualMicrousd, budget_id: call.budget_id };
  });
}

// ── decision 43: queue wait ──────────────────────────────────────────────────────────
export interface QueueWait { p50: number | null; p95: number | null; n: number }

/**
 * DECISION 43 — an item's creation to the FIRST `attempts.started_at`, so a requeued item is
 * counted once, by how long it waited to be picked up at all. That is the number that decides
 * whether a cron tick is fast enough or a long-lived worker is needed; counting later attempts
 * would measure retry behaviour instead and flatter the cron.
 *
 * ⚠️ THE CREATION TIME COMES FROM `runs`, AND IT IS THE SAME INSTANT. Decision 43 names
 * `items.created_at`; migration 0001 gave `lab_v2.items` no such column, and B1's file contract
 * adds no migration. It needs none: `submitRun` is the only writer of `lab_v2.items` and it
 * inserts the run and every one of its items in ONE transaction, so `runs.created_at` IS each
 * item's creation time — not an approximation of it. Flagged in the B1 report.
 */
export async function queueWait(db: Db, windowHours: number): Promise<QueueWait> {
  const rows = await db.query<{ wait_ms: string }>(
    `SELECT EXTRACT(EPOCH FROM (first_start - r.created_at)) * 1000 AS wait_ms
     FROM lab_v2.items i
     JOIN lab_v2.runs r ON r.id = i.run_id
     JOIN (SELECT item_id, min(started_at) AS first_start FROM lab_v2.attempts GROUP BY item_id) a ON a.item_id = i.id
     WHERE r.created_at > now() - make_interval(hours => $1)
     ORDER BY 1`,
    [windowHours]);
  const values = rows.map((r) => Number(r.wait_ms)).filter((v) => Number.isFinite(v) && v >= 0);
  if (!values.length) return { p50: null, p95: null, n: 0 };
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))))];
  return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), n: values.length };
}
