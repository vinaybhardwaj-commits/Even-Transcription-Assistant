/**
 * Tier 1 self-healing: manage audit suppressions (PRD §7). Auth: care-manager cookie OR admin.
 *   GET  → list all suppressions
 *   POST { op:'preview', ... }  → dual-label collateral check only (no write)
 *   POST { op:'create', force?, ... } → create, BLOCKED (409) if it would remove a validated signal
 *   POST { op:'toggle', id, active } → activate / deactivate
 *
 * The create path enforces the dual-label invariant: a suppression that would suppress ANY finding a
 * care manager marked valid_signal is refused unless force=true (an explicit human override).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { previewCollateral, ruleViolatesSeverityFloor, type Suppression } from '@/lib/audit-suppression-core';
import {
  listSuppressions, createSuppression, setSuppressionActive, loadValidLabelInstances,
  approveDemoteRule, retireDemoteRule, currentQuietingGen, quietedVolume30d,
} from '@/lib/audit-suppression-store';

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

function toProposed(b: Record<string, unknown>): Suppression {
  return {
    signal_type: String(b.signal_type || ''),
    discriminator: b.discriminator == null || b.discriminator === '' ? null : String(b.discriminator),
    match_kind: b.match_kind === 'subject_contains' ? 'subject_contains' : 'type_only',
    scope: b.scope === 'doctor' ? 'doctor' : 'all',
    doctor_uid: b.doctor_uid == null || b.doctor_uid === '' ? null : String(b.doctor_uid),
    action: b.action === 'drop' ? 'drop' : 'downgrade',
    active: true,
  };
}

export async function GET() {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  // is_admin drives WHICH CONTROLS RENDER on the Quieting tab (activate/retire); the approve/retire
  // ops below enforce admin server-side regardless of what the client shows.
  const [suppressions, gen, isAdmin, volume] = await Promise.all([
    listSuppressions(false), currentQuietingGen(), isAdminUnlocked().catch(() => false), quietedVolume30d(),
  ]);
  return NextResponse.json({ ok: true, suppressions, current_gen: gen, is_admin: isAdmin, quieted_volume_30d: volume });
}

export async function POST(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const op = String(b.op || 'preview');

  // ── Quieting ops (PRD CDMSS-QUIETING-DEMOTE-SYSTEM Q5) ───────────────────────
  if (op === 'propose-demote') {
    // Care session proposes; lands as status='proposed', active=false — scores nothing until an
    // administrator activates. Named proposer + reason are mandatory (enforced in the store too).
    const rule = {
      signal_type: String(b.signal_type || ''), action: 'demote',
      match_kind: b.match_kind === 'lvc_category' ? 'lvc_category' : 'subject_contains',
      discriminator: b.discriminator == null || b.discriminator === '' ? null : String(b.discriminator),
      scope: 'all' as const, doctor_uid: null,
      reason: b.reason == null ? null : String(b.reason),
      created_by: b.created_by == null ? null : String(b.created_by),
      source_triage_ref: b.source_triage_ref == null ? null : String(b.source_triage_ref),
    };
    if (ruleViolatesSeverityFloor({ action: 'demote', signal_type: rule.signal_type })) {
      return NextResponse.json({ ok: false, error: `severity floor: '${rule.signal_type}' is a deterministic safety signal type and cannot be quieted` }, { status: 409 });
    }
    try {
      const row = await createSuppression(rule);
      return NextResponse.json({ ok: true, suppression: row });
    } catch (e) {
      const msg = String((e as Error).message);
      return NextResponse.json({ ok: false, error: msg }, { status: /required|severity floor/.test(msg) ? 400 : 500 });
    }
  }
  if (op === 'approve-demote' || op === 'retire-demote') {
    // ADMIN SURFACE ONLY (Q5): activation/retirement is an administrator-role action.
    if (!(await isAdminUnlocked().catch(() => false))) {
      return NextResponse.json({ ok: false, error: 'admin surface required for activation/retirement' }, { status: 403 });
    }
    const id = String(b.id || '');
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
    try {
      const res = op === 'approve-demote' ? await approveDemoteRule(id) : await retireDemoteRule(id);
      if (!res) return NextResponse.json({ ok: false, error: 'demote rule not found' }, { status: 404 });
      return NextResponse.json({ ok: true, suppression: res.rule, current_gen: res.gen });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
    }
  }

  if (op === 'toggle') {
    const id = String(b.id || '');
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
    const row = await setSuppressionActive(id, b.active !== false);
    return row ? NextResponse.json({ ok: true, suppression: row }) : NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  const proposed = toProposed(b);
  if (!proposed.signal_type) return NextResponse.json({ ok: false, error: 'signal_type required' }, { status: 400 });

  // dual-label safety check against the validated-label set for this signal_type
  const validSet = await loadValidLabelInstances(proposed.signal_type).catch(() => []);
  const preview = previewCollateral(proposed, validSet);

  if (op === 'preview') return NextResponse.json({ ok: true, preview, valid_label_set_size: validSet.length });

  if (op === 'create') {
    if (!preview.safe && b.force !== true) {
      return NextResponse.json({ ok: false, error: 'dual-label violation: this suppression would remove a validated signal', preview }, { status: 409 });
    }
    try {
      const row = await createSuppression({
        signal_type: proposed.signal_type, discriminator: proposed.discriminator, match_kind: proposed.match_kind,
        scope: proposed.scope, doctor_uid: proposed.doctor_uid, action: proposed.action,
        source_triage_ref: b.source_triage_ref == null ? null : String(b.source_triage_ref),
        reason: b.reason == null ? null : String(b.reason), created_by: b.created_by == null ? null : String(b.created_by),
      });
      return NextResponse.json({ ok: true, suppression: row, preview, forced: !preview.safe });
    } catch (e) {
      const msg = String((e as Error).message);
      return NextResponse.json({ ok: false, error: msg }, { status: /required/.test(msg) ? 400 : 500 });
    }
  }

  return NextResponse.json({ ok: false, error: `unknown op ${op}` }, { status: 400 });
}
