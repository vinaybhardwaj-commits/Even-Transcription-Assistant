import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// EpisodeState (#4) SL5 — V's reconstruction-fidelity rating for one phase (or a per-fact drill) of
// one assembled EpisodeState. A DEDICATED store (episode_recon_ratings), never ipd_audit_feedback
// and never ipd_gold_adjudication — builder-fidelity is its own bench. Append-only; latest row per
// (document_id, version, phase, fact_ref) wins on read. Body:
// { documentId, ipUid?, version, phase, factRef?, verdict, note? }.
//
// verdict vocabulary: faithful = the phase captures the documented course · missed_material_fact =
// the summary states something the builder dropped · mis_phased = a captured fact is in the wrong
// phase · over_included = a fact that shouldn't be here.
const VERDICTS = new Set(['faithful', 'missed_material_fact', 'mis_phased', 'over_included']);
const PHASES = new Set(['pre', 'intra', 'post']);

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const documentId = typeof body.documentId === 'string' ? body.documentId.trim().slice(0, 200) : '';
  const ipUid = typeof body.ipUid === 'string' ? body.ipUid.trim().slice(0, 40) : null;
  const version = typeof body.version === 'string' ? body.version.trim().slice(0, 40) : '';
  const phase = typeof body.phase === 'string' ? body.phase.trim() : '';
  const factRef = typeof body.factRef === 'string' ? body.factRef.trim().slice(0, 300) : null;
  const verdict = typeof body.verdict === 'string' ? body.verdict.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : null;
  if (!documentId) return NextResponse.json({ ok: false, error: 'documentId required' }, { status: 400 });
  if (!version.startsWith('episode-state/')) return NextResponse.json({ ok: false, error: 'bad version' }, { status: 400 });
  if (!PHASES.has(phase)) return NextResponse.json({ ok: false, error: 'phase must be pre | intra | post' }, { status: 400 });
  if (!VERDICTS.has(verdict)) return NextResponse.json({ ok: false, error: 'verdict must be faithful | missed_material_fact | mis_phased | over_included' }, { status: 400 });

  try {
    await sql(
      `INSERT INTO episode_recon_ratings (document_id, ip_uid, version, phase, fact_ref, verdict, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [documentId, ipUid || null, version, phase, factRef || null, verdict, note || null],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
