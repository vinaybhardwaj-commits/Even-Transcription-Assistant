/**
 * POST /api/opd-audit/feedback — capture an auditor / care-manager's reaction to an OPD audit,
 * shown back on the case screen. Anonymous by default (author optional). Each call is one row
 * (append-only); current state = latest row per (audit_id, finding_ref). Auth: ADMIN_TOKEN
 * (Bearer/?token=) OR a logged-in admin session cookie (the case view is admin-gated, so the
 * in-page form posts with the cookie — no token handling).
 *
 * Body validation + normalisation lives in the pure lib/opd-feedback-core.ts. Three scopes
 * (PRD §4.1): 'audit' (legacy whole-audit reaction + general comment), 'finding' (per-finding
 * triage — true_positive|nitpick|false|contested, keyed to a finding_ref), 'missed' (a
 * finding that should have fired). This is the clinician-gold label signal the model project harvests.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { parseFeedbackBody } from '@/lib/opd-feedback-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP = process.env.APP_SOURCE || 'standalone';

const AUDIT_ID_RE = /^[0-9a-f-]{36}$/i;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: unknown = {};
  try { body = await req.json(); } catch { /* ignore */ }

  // CDMSS-EVEN-LVC-ADJUDICATION §6 — point-of-care CONTEST of an Even-adjudicated assertion. Validated
  // in-route (NOT via parseFeedbackBody) so the pure lib/opd-feedback-core SCOPES contract stays locked;
  // one append-only row tagged {assertion_id, assertion_version, scope='assertion_contest'} rolls up
  // per assertion (lib/even-lvc.loadBoard → rollupContests). assertion_id/assertion_version columns are
  // added by /api/admin/migrate-even-lvc BEFORE this deploy (the column-add gotcha).
  {
    const b = (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};
    if (b.scope === 'assertion_contest') {
      const auditId = String(b.auditId ?? '').trim();
      if (!AUDIT_ID_RE.test(auditId)) return NextResponse.json({ error: 'bad auditId' }, { status: 400 });
      const assertionId = String(b.assertion_id ?? '').trim().slice(0, 120);
      if (!assertionId) return NextResponse.json({ error: 'assertion_id required for scope=assertion_contest' }, { status: 400 });
      const av = Math.floor(Number(b.assertion_version));
      const assertionVersion = Number.isFinite(av) && av > 0 ? av : null;
      const uid = b.uid == null ? null : String(b.uid).trim().slice(0, 64) || null;
      const comment = b.comment == null ? null : String(b.comment).trim().slice(0, 4000) || null;
      const author = b.author == null ? null : String(b.author).trim().slice(0, 120) || null;
      const verdict = 'contested';
      try {
        const rows = (await sql`
          INSERT INTO opd_audit_feedback (app_source, audit_id, scope, uid, verdict, comment, author, assertion_id, assertion_version)
          VALUES (${APP}, ${auditId}, 'assertion_contest', ${uid}, ${verdict}, ${comment}, ${author}, ${assertionId}, ${assertionVersion})
          RETURNING id, created_at`) as Array<{ id: string; created_at: string }>;
        return NextResponse.json({ ok: true, id: rows[0]?.id, created_at: rows[0]?.created_at });
      } catch (e) {
        return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
      }
    }
  }

  const parsed = parseFeedbackBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { auditId, scope, uid, verdict, comment, author, finding_ref, signal_type, category, study } = parsed.value;

  try {
    const rows = (await sql`
      INSERT INTO opd_audit_feedback (app_source, audit_id, scope, uid, verdict, comment, author, finding_ref, signal_type, category, study)
      VALUES (${APP}, ${auditId}, ${scope}, ${uid}, ${verdict}, ${comment}, ${author}, ${finding_ref}, ${signal_type}, ${category}, ${study})
      RETURNING id, created_at`) as Array<{ id: string; created_at: string }>;
    return NextResponse.json({ ok: true, id: rows[0]?.id, created_at: rows[0]?.created_at });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
