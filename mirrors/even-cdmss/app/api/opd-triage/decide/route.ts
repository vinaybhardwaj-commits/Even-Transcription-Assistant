/**
 * POST /api/opd-triage/decide — submit one care-manager triage decision (spec v2.0 §3.2).
 *
 * Type-batch (scope='type', the common case) or instance override (scope='instance'). Appends an
 * immutable row to opd_audit_triage; latest row wins. Validation + normalization is the pure core
 * (validateDecision). Minting the governance signal on route (opd_gov_signal) is Build 3 — this
 * endpoint only records the decision.
 * Auth: care-manager session cookie OR admin.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { insertDecision } from '@/lib/opd-triage-store';
import { buildTriageEvent, type DecisionInput } from '@/lib/opd-triage-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

/** Feature C (Review-Mode §5) — append-only CM instrumentation events. Ensured at call time
 *  (CREATE TABLE IF NOT EXISTS), best-effort, never affecting the decision. Workflow telemetry,
 *  NOT clinical labels — kept out of opd_audit_feedback / opd_audit_triage on purpose. */
async function writeTriageEvent(ev: {
  triage_id: string | null; audit_id: string | null; uid: string | null; actor: string | null;
  from_status: string | null; to_status: string; reason: string; note: string | null;
}): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS opd_triage_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_source  text NOT NULL DEFAULT 'standalone',
    triage_id   uuid,
    audit_id    uuid,
    uid         text,
    actor       text,
    from_status text,
    to_status   text NOT NULL,
    reason      text,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS opd_triage_events_created_idx ON opd_triage_events (created_at DESC)`, []);
  await run(
    `INSERT INTO opd_triage_events (app_source, triage_id, audit_id, uid, actor, from_status, to_status, reason, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [APP, ev.triage_id, ev.audit_id, ev.uid, ev.actor, ev.from_status, ev.to_status, ev.reason, ev.note],
  );
}

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function POST(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: DecisionInput & { event?: { chip?: string; note?: string; from_status?: string; uid?: string } };
  try { body = (await req.json()) as typeof body; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  try {
    const { id, decision, signal, signal_error } = await insertDecision(body);
    // Feature C: write the instrumentation event best-effort. Only when the client sends `event`
    // (backward-compatible with older callers). A chip that fails validation is surfaced but never
    // fails the recorded decision.
    let event_error: string | undefined;
    if (body.event) {
      const built = buildTriageEvent({
        validity: decision.validity, routed: decision.routed,
        chip: body.event.chip, note: body.event.note, actor: decision.cm_user,
        from_status: body.event.from_status ?? 'open', triage_id: id,
        audit_id: decision.audit_id, uid: body.event.uid,
      });
      if (built.ok) { try { await writeTriageEvent(built.value); } catch (e) { event_error = String((e as Error).message); } }
      else event_error = built.error;
    }
    return NextResponse.json({ ok: true, id, decision, signal: signal ?? null, ...(signal_error ? { signal_error } : {}), ...(event_error ? { event_error } : {}) });
  } catch (e) {
    const msg = String((e as Error).message);
    // Validation errors from the core → 400; anything else (DB) → 500.
    const isValidation = /required|must be|instance scope/.test(msg);
    return NextResponse.json({ ok: false, error: msg }, { status: isValidation ? 400 : 500 });
  }
}
