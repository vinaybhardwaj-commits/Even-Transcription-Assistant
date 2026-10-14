import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Consensus gold (#7), SL2. V's adjudication of a union candidate — a DEDICATED store, never
// ipd_audit_feedback (those are surface-feedback rows on live audits; these build gold 2.0 and
// must be separable). Append-only; latest row per candidate wins on read. Body:
// { candidateId, caseId, verdict, note? }.
//
// verdict vocabulary (kickoff): tp = confirmed gold-worthy · valid_extra = a real finding the 1.1
// gold missed (goes INTO 2.0) · false = wrong/unsupported · nitpick = correct-but-noise ·
// contested = guideline-correct but context/patient-demand constrained.
const VERDICTS = new Set(['tp', 'valid_extra', 'false', 'nitpick', 'contested']);

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const candidateId = typeof body.candidateId === 'string' ? body.candidateId.trim().slice(0, 200) : '';
  const caseId = typeof body.caseId === 'string' ? body.caseId.trim().slice(0, 40) : '';
  const verdict = typeof body.verdict === 'string' ? body.verdict.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : null;
  if (!candidateId) return NextResponse.json({ ok: false, error: 'candidateId required' }, { status: 400 });
  if (!/^IPD-G-\d{1,3}$/.test(caseId)) return NextResponse.json({ ok: false, error: 'bad caseId' }, { status: 400 });
  if (!VERDICTS.has(verdict)) {
    return NextResponse.json({ ok: false, error: 'verdict must be tp | valid_extra | false | nitpick | contested' }, { status: 400 });
  }

  try {
    await sql(
      `INSERT INTO ipd_gold_adjudication (candidate_id, case_id, verdict, note) VALUES ($1,$2,$3,$4)`,
      [candidateId, caseId, verdict, note || null],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
