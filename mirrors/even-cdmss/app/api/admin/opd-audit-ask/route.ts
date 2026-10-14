/**
 * /api/admin/opd-audit-ask — the persisted conversation on an OPD note audit case
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / §3, O4 / O6 / O7 / O8).
 *
 * The OPD case page had no Ask box at all. This is the first one, and it is the R9 readmission
 * pattern EXTRACTED rather than imported (O3): the shared shell lives in lib/case-ask-core.ts and
 * lib/case-ask/, and no file on this path imports anything under lib/readmission*.
 *
 *   GET  ?audit_id=…    the persisted thread, so a reload resumes the argument (acceptance #1).
 *   POST { audit_id, question }
 *        · The SERVER is the thread's truth: the thread is read from Neon by
 *          (case_type, case_key, engine_version) and any `history` in the body is IGNORED.
 *        · O7 — over the day's ceiling of 40 agent turns on this thread, the refusal is STORED as a
 *          withheld turn and no model call is made. Never a 500 (acceptance #3).
 *        · The auditor's turn is stored BEFORE the model call — a fault must not cost his words.
 *        · An uncited claim about the case is WITHHELD by code (acceptance #5).
 *
 * O4 — its own admin-gated endpoint, not a shared multi-tenant route. Auth is the
 * app/api/admin/ipd-audit-feedback pattern: ADMIN_TOKEN (Bearer / ?token=) OR an admin session.
 *
 * §3.3 — WHAT THIS ROUTE CANNOT DO. It reads `opd_note_audits` and writes `case_ask_turns`. It does
 * not write NQI, band, any domain score, `opd_audit_feedback`, or MemberState; it does not re-audit
 * or re-run anything; and there is no recompute control anywhere on this path. `uid` and
 * `doctor_uid` are deliberately NOT in the SELECT below: the material is de-identified by
 * construction because the identifying columns are never read at all.
 *
 * O6 — the thread key is the audit ROW id plus the engine version. That version is read from the row
 * rather than pinned to the OPD_ENGINE_VERSION constant, which is the same string for a current row
 * ('opd-note-audit/0.81.21') and stays honest for a row audited under an older family member: a
 * thread then belongs to the numbers it was actually about. The constant is the fallback when the
 * column is empty.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live Neon. The one query below is listed verbatim in the
 * slice report for validation against the live system.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { probeReachable } from '@/lib/lab-override';
import { normaliseQuestion } from '@/lib/case-ask-core';
import { opdAskMaterial, type OpdAuditMaterialRow } from '@/lib/case-ask/ask';
import { serveCaseAskAnswer, serveCaseAskThread, type CaseAskLoad } from '@/lib/case-ask/serve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** O8 — role-only attribution. There is no per-person reviewer identity in this app and this ship
 *  does not invent one; what is recorded is the role the request proved. */
const ACTOR = 'admin';

/** Load ONE OPD audit row and turn it into material. A miss is a 404 that never reaches the model
 *  or the store; a DB fault is a 503 rather than a thread opened against nothing. */
function loadOpdCase(auditId: string): () => Promise<CaseAskLoad> {
  return async () => {
    let rows: Record<string, unknown>[];
    try {
      rows = await run(
        `SELECT engine_version, note_quality_index, band, completeness_pct, n_missing_mandatory,
                score_documentation, score_note_quality, score_appropriateness,
                score_prescribing_safety, score_patient_centred,
                excluded_reason, findings, suggestions
           FROM opd_note_audits WHERE id = $1 AND app_source = $2 LIMIT 1`,
        [auditId, APP],
      );
    } catch {
      return { ok: false, status: 503, error: 'the case could not be read' };
    }
    const r = rows[0] as OpdAuditMaterialRow | undefined;
    if (!r) return { ok: false, status: 404, error: 'not found' };
    const engineVersion = String(r.engine_version ?? '') || OPD_ENGINE_VERSION;
    return { ok: true, engineVersion, material: opdAskMaterial(r, engineVersion) };
  };
}

async function authorised(req: NextRequest): Promise<NextResponse | null> {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  return null;
}

const isAuditId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export async function GET(req: NextRequest) {
  const denied = await authorised(req);
  if (denied) return denied;
  const id = String(req.nextUrl.searchParams.get('audit_id') ?? '').trim();
  if (!isAuditId(id)) return NextResponse.json({ ok: false, error: 'bad audit id' }, { status: 400 });
  const { status, body } = await serveCaseAskThread({ caseType: 'opd', caseKey: id, actor: ACTOR, load: loadOpdCase(id) });
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  const denied = await authorised(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const id = String(body.audit_id ?? '').trim();
  if (!isAuditId(id)) return NextResponse.json({ ok: false, error: 'bad audit id' }, { status: 400 });
  const q = normaliseQuestion(body.question);
  if (!q.ok) return NextResponse.json({ ok: false, error: q.error }, { status: 400 });
  // F11 — unserved means withhold, never a quiet fallback to some other model.
  if (!probeReachable('bedrock')) return NextResponse.json({ ok: false, error: 'the agent is not reachable in this deployment' }, { status: 503 });

  const { status, body: payload } = await serveCaseAskAnswer({
    caseType: 'opd', caseKey: id, actor: ACTOR, load: loadOpdCase(id), question: q.question,
  });
  return NextResponse.json(payload, { status });
}
