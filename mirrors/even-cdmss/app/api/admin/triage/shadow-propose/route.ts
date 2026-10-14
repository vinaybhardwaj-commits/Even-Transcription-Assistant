/**
 * POST /api/admin/triage/shadow-propose — append-only bot proposals (admin-gated).
 *
 * Writes triage_shadow_proposals only. Does not stamp the CM decision table, does not mint
 * a governance thread, does not call the decide store. Idempotent on (queue_item_ref, run_id).
 *
 * Auth: cat_admin session OR ADMIN_TOKEN Bearer / ?token=.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import {
  assertShadowOnlyWrite,
  validateShadowProposal,
  type ShadowProposalInput,
} from '@/lib/triage/shadow-schema';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

const SHADOW_PROPOSAL_INSERT_SQL = `INSERT INTO triage_shadow_proposals
      (app_source, queue_item_ref, proposed_verb, reason, confidence, policy_version, run_id, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (queue_item_ref, run_id) DO NOTHING
     RETURNING id::text AS id`;

async function ensureTriageShadowProposalsTable(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS triage_shadow_proposals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    app_source      text NOT NULL DEFAULT 'standalone',
    queue_item_ref  text NOT NULL,
    proposed_verb   text NOT NULL,
    reason          text,
    confidence      double precision,
    policy_version  text NOT NULL,
    run_id          text NOT NULL,
    actor           text
  )`, []);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS triage_shadow_proposals_identity_uq
    ON triage_shadow_proposals (queue_item_ref, run_id)`, []);
}

async function adminOk(req: NextRequest): Promise<NextResponse | null> {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  return null;
}

export async function POST(req: NextRequest) {
  const denied = await adminOk(req);
  if (denied) return denied;

  const gate = assertShadowOnlyWrite('propose');
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: 403 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'body must be a JSON object' }, { status: 400 });
  }

  const stamp = assertShadowOnlyWrite('stamp');
  if (stamp.ok) {
    return NextResponse.json({ ok: false, error: 'SHADOW_ONLY: stamp path must stay closed' }, { status: 403 });
  }

  const rawList = Array.isArray(body.proposals) ? body.proposals : [body];
  const defaults = {
    policy_version: typeof body.policy_version === 'string' ? body.policy_version : undefined,
    run_id: typeof body.run_id === 'string' ? body.run_id : undefined,
    actor: typeof body.actor === 'string' ? body.actor : null,
  };

  const normalized = [];
  for (const raw of rawList) {
    const v = validateShadowProposal((raw && typeof raw === 'object' ? raw : {}) as ShadowProposalInput, defaults);
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
    normalized.push(v.value);
  }
  if (normalized.length === 0) {
    return NextResponse.json({ ok: false, error: 'proposals required' }, { status: 400 });
  }

  try { await ensureTriageShadowProposalsTable(); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }

  const inserted: string[] = [];
  const replayed: string[] = [];
  try {
    for (const p of normalized) {
      const rows = await run(SHADOW_PROPOSAL_INSERT_SQL, [
        APP, p.queue_item_ref, p.verb, p.reason, p.confidence, p.policy_version, p.run_id, p.actor,
      ]);
      const id = rows[0]?.id == null ? null : String(rows[0].id);
      if (id) inserted.push(p.queue_item_ref);
      else replayed.push(p.queue_item_ref);
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    shadow_only: true,
    inserted: inserted.length,
    replayed: replayed.length,
    queue_item_refs: { inserted, replayed },
  });
}
