/**
 * POST /api/admin/triage/stamp — apply one bot/human disposition to the shared OPD Action queue.
 *
 * Valid/bug/route delegate to insertDecision, the same store used by /care/triage. Consequently a
 * route mints through the existing opd_gov_signal path. Hold and drop_informational call
 * insertQueueDisposition: a type row the Action queue reader treats as triaged, with validity
 * non_clinical and no opd_gov_signal. They do not write valid_signal or audit_bug.
 *
 * A clinical stamp (valid/bug/route) must carry run_id and/or a request id (body client_request_id
 * or the Idempotency-Key header, the same pair doctor-response honors). The same
 * (queue_item_ref, run_id) or the same request id replays the original decision and signal and
 * does not call insertDecision again.
 *
 * Safe default: every stamp is refused unless TRIAGE_BOT_WRITE=1.
 * Auth: cat_admin session OR ADMIN_TOKEN Bearer / ?token=, matching queue and shadow-propose.
 *
 * Membership is the Action queue the caller is working from, not a second population.
 * Optional day, days, doctor_uid, status, and quieted — the same fields as
 * GET/POST /api/admin/triage/queue — may arrive on the JSON body and/or the query
 * string. Body wins when both set a field. They are passed to parseActionQueueQuery
 * and readActionQueue. Omitting day and days keeps today's window: the queue reader's
 * default single latest audit day. Omitting status keeps all, this door's historical
 * membership check (the queue door itself defaults to untriaged).
 *
 * Production DDL for the idempotency columns and unique indexes is migrations/0058. The
 * CREATE / ALTER / INDEX statements below are belt-and-suspenders for a process that has
 * not applied that migration yet.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import { insertDecision, insertQueueDisposition } from '@/lib/opd-triage-store';
import { parseActionQueueQuery, flattenActionQueueItems, readActionQueue } from '@/lib/triage/queue-read';
import {
  clinicalStampRequiresIdentity,
  parseQueueItemRef,
  resolveStampRequestId,
  triageWriteEnabled,
  validateTriageStamp,
  type NormalizedTriageStamp,
  type TriageStampInput,
} from '@/lib/triage/stamp-schema';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

const TERMINAL_OUTCOMES = new Set(['applied', 'held', 'dropped_informational', 'decision_recorded_signal_failed']);

/** Fields parseActionQueueQuery already understands on the admin queue door. */
const QUEUE_WINDOW_KEYS = ['day', 'days', 'doctor_uid', 'status', 'quieted'] as const;

/**
 * Stamp membership window. Status defaults to all so an omitted filter still sees every
 * card in the day window; an explicit status (body or query) is honored.
 */
function stampQueueInput(req: NextRequest, body: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { status: 'all' };
  for (const key of QUEUE_WINDOW_KEYS) {
    const fromQuery = req.nextUrl.searchParams.get(key);
    if (fromQuery != null && fromQuery !== '') merged[key] = fromQuery;
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] != null && body[key] !== '') {
      merged[key] = body[key];
    }
  }
  return merged;
}

const STAMP_COLS = `id::text AS id, queue_item_ref, verb, reason, actor, policy_version, run_id,
  outcome, decision_id::text AS decision_id, signal_reference, client_request_id, result, error`;

interface StampRecord {
  id: string;
  queue_item_ref: string;
  verb: string;
  reason: string;
  actor: string;
  policy_version: string;
  run_id: string | null;
  outcome: string;
  decision_id: string | null;
  signal_reference: string | null;
  client_request_id: string | null;
  result: unknown;
  error: string | null;
}

interface StampPayload {
  decision: Record<string, unknown> | null;
  signal: { reference: string; signal_id?: string; status?: string } | null;
  signal_error: string | null;
}

async function adminOk(req: NextRequest): Promise<NextResponse | null> {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  return null;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toStamp(row: Record<string, unknown>): StampRecord {
  return {
    id: String(row.id),
    queue_item_ref: String(row.queue_item_ref),
    verb: String(row.verb),
    reason: row.reason == null ? '' : String(row.reason),
    actor: row.actor == null ? '' : String(row.actor),
    policy_version: row.policy_version == null ? '' : String(row.policy_version),
    run_id: row.run_id == null ? null : String(row.run_id),
    outcome: String(row.outcome),
    decision_id: row.decision_id == null ? null : String(row.decision_id),
    signal_reference: row.signal_reference == null ? null : String(row.signal_reference),
    client_request_id: row.client_request_id == null ? null : String(row.client_request_id),
    result: row.result ?? null,
    error: row.error == null ? null : String(row.error),
  };
}

function sameDisposition(prior: StampRecord, stamp: NormalizedTriageStamp): boolean {
  return prior.queue_item_ref === stamp.queue_item_ref
    && prior.verb === stamp.verb
    && prior.reason === stamp.reason
    && prior.actor === stamp.actor
    && prior.policy_version === stamp.policy_version;
}

function payloadOf(row: StampRecord): StampPayload {
  const stored = parseJson(row.result);
  if (stored) {
    const decision = stored.decision && typeof stored.decision === 'object'
      ? stored.decision as Record<string, unknown>
      : null;
    const signal = stored.signal && typeof stored.signal === 'object'
      ? stored.signal as StampPayload['signal']
      : null;
    return {
      decision,
      signal,
      signal_error: stored.signal_error == null ? null : String(stored.signal_error),
    };
  }
  return {
    decision: row.decision_id ? { id: row.decision_id } : null,
    signal: row.signal_reference ? { reference: row.signal_reference } : null,
    signal_error: row.error,
  };
}

function stampResponse(row: StampRecord, payload: StampPayload, replayed: boolean) {
  return NextResponse.json({
    ok: true,
    replayed,
    stamp_id: row.id,
    queue_item_ref: row.queue_item_ref,
    verb: row.verb,
    outcome: row.outcome,
    client_request_id: row.client_request_id,
    decision: payload.decision,
    signal: payload.signal,
    ...(payload.signal_error ? { signal_error: payload.signal_error } : {}),
  });
}

async function ensureStampEventsTable(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS triage_stamp_events (
    id               uuid PRIMARY KEY,
    created_at       timestamptz NOT NULL DEFAULT now(),
    app_source       text NOT NULL DEFAULT 'standalone',
    queue_item_ref   text NOT NULL,
    verb             text NOT NULL,
    reason           text NOT NULL,
    actor            text NOT NULL,
    policy_version   text NOT NULL,
    run_id           text,
    run_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    decision_id      uuid,
    signal_reference text,
    outcome          text NOT NULL,
    error            text,
    client_request_id text,
    result           jsonb
  )`, []);
  await run(`ALTER TABLE triage_stamp_events ADD COLUMN IF NOT EXISTS client_request_id text`, []);
  await run(`ALTER TABLE triage_stamp_events ADD COLUMN IF NOT EXISTS result jsonb`, []);
  await run(`CREATE INDEX IF NOT EXISTS triage_stamp_events_queue_idx
    ON triage_stamp_events (queue_item_ref, created_at DESC)`, []);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS triage_stamp_events_run_uq
    ON triage_stamp_events (queue_item_ref, run_id)
    WHERE run_id IS NOT NULL`, []);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS triage_stamp_events_idem_uq
    ON triage_stamp_events (client_request_id)
    WHERE client_request_id IS NOT NULL`, []);
}

async function findByRequestId(clientRequestId: string): Promise<StampRecord | null> {
  const rows = await run(
    `SELECT ${STAMP_COLS} FROM triage_stamp_events WHERE client_request_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [clientRequestId],
  );
  return rows[0] ? toStamp(rows[0]) : null;
}

async function findByRun(queueItemRef: string, runId: string): Promise<StampRecord | null> {
  const rows = await run(
    `SELECT ${STAMP_COLS} FROM triage_stamp_events WHERE queue_item_ref = $1 AND run_id = $2 ORDER BY created_at ASC LIMIT 1`,
    [queueItemRef, runId],
  );
  return rows[0] ? toStamp(rows[0]) : null;
}

async function findPrior(queueItemRef: string, runId: string | null, clientRequestId: string | null): Promise<StampRecord | null> {
  const byKey = clientRequestId ? await findByRequestId(clientRequestId) : null;
  const byRun = runId ? await findByRun(queueItemRef, runId) : null;
  if (byKey && byRun && byKey.id !== byRun.id) {
    throw new Error('idempotency key and run_id refer to different stamps');
  }
  return byKey || byRun;
}

async function claimStamp(
  stamp: NormalizedTriageStamp,
  clientRequestId: string | null,
  metadata: Record<string, unknown>,
): Promise<{ claimed: boolean; row: StampRecord }> {
  const prior = await findPrior(stamp.queue_item_ref, stamp.run_id, clientRequestId);
  if (prior) return { claimed: false, row: prior };
  const id = randomUUID();
  const inserted = await run(
    `INSERT INTO triage_stamp_events
      (id, app_source, queue_item_ref, verb, reason, actor, policy_version, run_id, run_metadata, outcome, client_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'accepted',$10)
     ON CONFLICT DO NOTHING
     RETURNING id::text AS id`,
    [
      id, APP, stamp.queue_item_ref, stamp.verb, stamp.reason, stamp.actor,
      stamp.policy_version, stamp.run_id, JSON.stringify(metadata), clientRequestId,
    ],
  );
  if (inserted[0]?.id) {
    return {
      claimed: true,
      row: {
        id: String(inserted[0].id),
        queue_item_ref: stamp.queue_item_ref,
        verb: stamp.verb,
        reason: stamp.reason,
        actor: stamp.actor,
        policy_version: stamp.policy_version,
        run_id: stamp.run_id,
        outcome: 'accepted',
        decision_id: null,
        signal_reference: null,
        client_request_id: clientRequestId,
        result: null,
        error: null,
      },
    };
  }
  const raced = await findPrior(stamp.queue_item_ref, stamp.run_id, clientRequestId);
  if (!raced) throw new Error('stamp claim could not be resolved');
  return { claimed: false, row: raced };
}

async function saveOutcome(
  id: string,
  outcome: string,
  decisionId: string | null,
  signalReference: string | null,
  error: string | null,
  payload: StampPayload,
): Promise<void> {
  await run(
    `UPDATE triage_stamp_events
     SET outcome=$2, decision_id=$3::uuid, signal_reference=$4, error=$5, result=$6::jsonb
     WHERE id=$1::uuid`,
    [id, outcome, decisionId, signalReference, error, JSON.stringify(payload)],
  );
}

export async function POST(req: NextRequest) {
  const denied = await adminOk(req);
  if (denied) return denied;

  if (!triageWriteEnabled()) {
    return NextResponse.json({
      ok: false,
      error: 'SHADOW_ONLY: triage stamp writes are disabled (TRIAGE_BOT_WRITE must equal 1)',
    }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as (TriageStampInput & { client_request_id?: unknown }) | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'body must be a JSON object' }, { status: 400 });
  }
  const parsed = validateTriageStamp(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const stamp = parsed.value;
  const clientRequestId = resolveStampRequestId(body.client_request_id, req.headers.get('idempotency-key'));
  if (clinicalStampRequiresIdentity(stamp.verb) && !stamp.run_id && !clientRequestId) {
    return NextResponse.json({
      ok: false,
      error: 'run_id or Idempotency-Key required so a retry cannot mint a second decision',
    }, { status: 400 });
  }
  const identity = parseQueueItemRef(stamp.queue_item_ref)!;

  const queue = await readActionQueue(
    parseActionQueueQuery(stampQueueInput(req, body as Record<string, unknown>)),
  ).catch(() => null);
  const item = queue && flattenActionQueueItems(queue.doctors)
    .find((candidate) => candidate.queue_item_ref === stamp.queue_item_ref);
  if (!queue || !item) {
    return NextResponse.json({ ok: false, error: 'queue item is not present in the current Action queue' }, { status: 404 });
  }

  const requestMetadata = {
    ...stamp.run_metadata,
    request_id: req.headers.get('x-request-id'),
    idempotency_key: clientRequestId,
    queue_window: queue.window,
  };

  let claim: { claimed: boolean; row: StampRecord };
  try {
    await ensureStampEventsTable();
    claim = await claimStamp(stamp, clientRequestId, requestMetadata);
  } catch (e) {
    const message = String((e as Error).message);
    const conflict = /different stamps/.test(message);
    return NextResponse.json({ ok: false, error: message }, { status: conflict ? 409 : 500 });
  }

  if (!claim.claimed) {
    if (!sameDisposition(claim.row, stamp)) {
      return NextResponse.json({
        ok: false,
        error: 'idempotency key or run_id already used for a different stamp',
      }, { status: 409 });
    }
    if (TERMINAL_OUTCOMES.has(claim.row.outcome)) return stampResponse(claim.row, payloadOf(claim.row), true);
    if (claim.row.outcome !== 'failed') {
      return NextResponse.json({ ok: false, stamp_id: claim.row.id, error: 'stamp already in progress' }, { status: 409 });
    }
    // One retry wins the failed row. A second concurrent retry must not call insertDecision.
    const resumed = await run(
      `UPDATE triage_stamp_events SET outcome='accepted', error=NULL WHERE id=$1::uuid AND outcome='failed' RETURNING id::text AS id`,
      [claim.row.id],
    );
    if (!resumed[0]) {
      return NextResponse.json({ ok: false, stamp_id: claim.row.id, error: 'stamp already in progress' }, { status: 409 });
    }
  }

  const stampId = claim.row.id;
  const recorded: StampRecord = { ...claim.row, outcome: 'accepted' };

  // buildQueue hides a card from status=untriaged once any type decision exists. Record that
  // decision without a clinical label and without minting a governance signal.
  if (stamp.verb === 'hold' || stamp.verb === 'drop_informational') {
    try {
      const applied = await insertQueueDisposition({
        doctor_uid: identity.doctor_uid,
        signal_type: identity.signal_type,
        window_from: queue.window.from,
        window_to: queue.window.to,
        disposition: stamp.verb,
        reason: stamp.reason,
        cm_user: stamp.actor,
      });
      const outcome = stamp.verb === 'hold' ? 'held' : 'dropped_informational';
      const payload: StampPayload = {
        decision: { id: applied.id, ...applied.decision },
        signal: null,
        signal_error: null,
      };
      try {
        await saveOutcome(stampId, outcome, applied.id, null, null, payload);
      } catch (e) {
        // The disposition row already exists. Do not mark the stamp failed — a retry would
        // insert another row. Leave outcome='accepted' so a concurrent retry is a 409.
        return NextResponse.json({
          ok: false,
          stamp_id: stampId,
          error: `disposition recorded but stamp audit update failed: ${(e as Error).message}`,
          decision: payload.decision,
          signal: null,
        }, { status: 500 });
      }
      return stampResponse({ ...recorded, outcome, decision_id: applied.id }, payload, false);
    } catch (e) {
      const error = String((e as Error).message);
      await run(`UPDATE triage_stamp_events SET outcome='failed', error=$2 WHERE id=$1::uuid`, [stampId, error]).catch(() => undefined);
      const validation = /required|must be|instance scope/.test(error);
      return NextResponse.json({ ok: false, stamp_id: stampId, error }, { status: validation ? 400 : 500 });
    }
  }

  const decision = stamp.verb === 'bug'
    ? {
        scope: 'type', ...identity, window_from: queue.window.from, window_to: queue.window.to,
        validity: 'audit_bug', bug_type: 'process_bug', routed: false,
        reason: stamp.reason, cm_user: stamp.actor,
      }
    : {
        scope: 'type', ...identity, window_from: queue.window.from, window_to: queue.window.to,
        validity: 'valid_signal', importance: item.importance_hint,
        routed: stamp.verb === 'route',
        ...(stamp.verb === 'route' ? { response_required: 'explanation' } : {}),
        reason: stamp.reason, cm_user: stamp.actor,
      };

  try {
    const applied = await insertDecision(decision);
    const outcome = applied.signal_error ? 'decision_recorded_signal_failed' : 'applied';
    const payload: StampPayload = {
      decision: { id: applied.id, ...applied.decision },
      signal: applied.signal ?? null,
      signal_error: applied.signal_error ?? null,
    };
    try {
      await saveOutcome(stampId, outcome, applied.id, applied.signal?.reference ?? null, applied.signal_error ?? null, payload);
    } catch (e) {
      // The decision row already exists. Do not mark the stamp failed — a retry would call
      // insertDecision again. Leave outcome='accepted' so a concurrent retry is a 409.
      return NextResponse.json({
        ok: false,
        stamp_id: stampId,
        error: `decision recorded but stamp audit update failed: ${(e as Error).message}`,
        decision: payload.decision,
        signal: payload.signal,
      }, { status: 500 });
    }
    return stampResponse({ ...recorded, outcome, decision_id: applied.id, signal_reference: applied.signal?.reference ?? null }, payload, false);
  } catch (e) {
    const error = String((e as Error).message);
    await run(`UPDATE triage_stamp_events SET outcome='failed', error=$2 WHERE id=$1::uuid`, [stampId, error]).catch(() => undefined);
    const validation = /required|must be|instance scope/.test(error);
    return NextResponse.json({ ok: false, stamp_id: stampId, error }, { status: validation ? 400 : 500 });
  }
}
