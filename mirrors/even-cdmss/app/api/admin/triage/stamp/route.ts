/**
 * POST /api/admin/triage/stamp — apply one bot/human disposition to the shared OPD Action queue.
 *
 * Valid/bug/route delegate to insertDecision, the same store used by /care/triage. Consequently a
 * route mints through the existing opd_gov_signal path. Hold and drop_informational are audit-only
 * dispositions: they deliberately do not manufacture a clinical validity label or doctor signal.
 *
 * Safe default: every stamp is refused unless TRIAGE_BOT_WRITE=1.
 * Auth: cat_admin session OR ADMIN_TOKEN Bearer / ?token=, matching queue and shadow-propose.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import { insertDecision } from '@/lib/opd-triage-store';
import { parseActionQueueQuery, flattenActionQueueItems, readActionQueue } from '@/lib/triage/queue-read';
import {
  parseQueueItemRef,
  triageWriteEnabled,
  validateTriageStamp,
  type TriageStampInput,
} from '@/lib/triage/stamp-schema';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

async function adminOk(req: NextRequest): Promise<NextResponse | null> {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  return null;
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
    error            text
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS triage_stamp_events_queue_idx
    ON triage_stamp_events (queue_item_ref, created_at DESC)`, []);
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

  const body = await req.json().catch(() => null) as TriageStampInput | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'body must be a JSON object' }, { status: 400 });
  }
  const parsed = validateTriageStamp(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const stamp = parsed.value;
  const identity = parseQueueItemRef(stamp.queue_item_ref)!;

  const queue = await readActionQueue(parseActionQueueQuery({ status: 'all' })).catch(() => null);
  const item = queue && flattenActionQueueItems(queue.doctors)
    .find((candidate) => candidate.queue_item_ref === stamp.queue_item_ref);
  if (!queue || !item) {
    return NextResponse.json({ ok: false, error: 'queue item is not present in the current Action queue' }, { status: 404 });
  }

  const stampId = randomUUID();
  const requestMetadata = {
    ...stamp.run_metadata,
    request_id: req.headers.get('x-request-id'),
    idempotency_key: req.headers.get('idempotency-key'),
    queue_window: queue.window,
  };
  try {
    await ensureStampEventsTable();
    await run(
      `INSERT INTO triage_stamp_events
        (id, app_source, queue_item_ref, verb, reason, actor, policy_version, run_id, run_metadata, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'accepted')`,
      [
        stampId, APP, stamp.queue_item_ref, stamp.verb, stamp.reason, stamp.actor,
        stamp.policy_version, stamp.run_id, JSON.stringify(requestMetadata),
      ],
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }

  // These are intentional non-clinical dispositions. Keeping them out of opd_audit_triage avoids
  // turning "wait" or an informational drop into a false valid/bug label.
  if (stamp.verb === 'hold' || stamp.verb === 'drop_informational') {
    const outcome = stamp.verb === 'hold' ? 'held' : 'dropped_informational';
    await run(`UPDATE triage_stamp_events SET outcome=$2 WHERE id=$1`, [stampId, outcome]).catch(() => undefined);
    return NextResponse.json({
      ok: true,
      stamp_id: stampId,
      queue_item_ref: stamp.queue_item_ref,
      verb: stamp.verb,
      outcome,
      decision: null,
      signal: null,
    });
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
    await run(
      `UPDATE triage_stamp_events
       SET decision_id=$2::uuid, signal_reference=$3, outcome=$4, error=$5 WHERE id=$1`,
      [stampId, applied.id, applied.signal?.reference ?? null, outcome, applied.signal_error ?? null],
    );
    return NextResponse.json({
      ok: true,
      stamp_id: stampId,
      queue_item_ref: stamp.queue_item_ref,
      verb: stamp.verb,
      outcome,
      decision: { id: applied.id, ...applied.decision },
      signal: applied.signal ?? null,
      ...(applied.signal_error ? { signal_error: applied.signal_error } : {}),
    });
  } catch (e) {
    const error = String((e as Error).message);
    await run(`UPDATE triage_stamp_events SET outcome='failed', error=$2 WHERE id=$1`, [stampId, error]).catch(() => undefined);
    const validation = /required|must be|instance scope/.test(error);
    return NextResponse.json({ ok: false, stamp_id: stampId, error }, { status: validation ? 400 : 500 });
  }
}
