export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { CCB_ENGINE_VERSION, pitchGate, isSpecificSurgicalIndication, PITCH_MIN_CONFIDENCE, type ClinicalFinding } from '@/lib/ccb-brief-core';
import { isAdminUnlocked } from '@/lib/admin-cookie';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// Admin / cron only — this reports on and (with ?apply=1) mutates the shared ccb_briefs table.
async function authed(req: NextRequest): Promise<boolean> {
  const token = req.nextUrl.searchParams.get('token');
  if (!!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

function toFindings(v: unknown): ClinicalFinding[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? ''),
      kind: String(o.kind ?? '') as ClinicalFinding['kind'],
      claim: String(o.claim ?? ''),
      grounding: String(o.grounding ?? '') as ClinicalFinding['grounding'],
      citation_ids: Array.isArray(o.citation_ids) ? o.citation_ids.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [],
      confidence: Number(o.confidence ?? 0) || 0,
    };
  });
}

/**
 * CCB pitch calibration backtest + backfill (admin). DARK behind CCB_ENABLED.
 *   GET /api/admin/ccb-calibration[?minConf=0.7][&limit=5000][&apply=1]
 *     Deterministic re-application of the OLD vs the calibrated pitch gate to every stored brief's
 *     findings (NO LLM). Reports the before/after pitch rate + sample of the indications that now
 *     close. ?apply=1 backfills pitch_allowed=false for briefs the calibrated gate rejects, so the
 *     /care flagged list reflects the new gate immediately. Read-only unless ?apply=1.
 */
export async function GET(req: NextRequest) {
  if (process.env.CCB_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const apply = p.get('apply') === '1';
  const minConfRaw = p.get('minConf');
  const minConf = minConfRaw != null && Number.isFinite(Number(minConfRaw)) ? Number(minConfRaw) : undefined;
  const limit = Math.max(1, Math.min(10000, Number(p.get('limit') || 5000)));

  let rows: Record<string, unknown>[];
  try {
    rows = await run(
      `SELECT presc_uid, pitch_allowed, envelope->'clinical' AS clinical
       FROM ccb_briefs WHERE engine_version = $1 ORDER BY created_at DESC LIMIT ${limit}`,
      [CCB_ENGINE_VERSION],
    );
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }

  let storedFlagged = 0, oldFlagged = 0, newFlagged = 0;
  const closePrescUids: string[] = [];
  const sample: { claim: string; reason: string; confidence: number }[] = [];
  const sampleOpen: { claim: string; confidence: number }[] = [];

  for (const r of rows) {
    const clinical = toFindings(r.clinical);
    const stored = r.pitch_allowed === true;
    if (stored) storedFlagged++;
    const oldOpen = pitchGate(clinical, { requireSpecific: false, minConfidence: 0 }).allowed;
    const newGate = pitchGate(clinical, minConf != null ? { minConfidence: minConf } : {});
    const newOpen = newGate.allowed;
    if (oldOpen) oldFlagged++;
    if (newOpen) newFlagged++;

    if (newOpen && sampleOpen.length < 40) {
      const f = clinical.find((x) => newGate.gatedOn.includes(x.id));
      if (f) sampleOpen.push({ claim: f.claim.slice(0, 220), confidence: f.confidence });
    }

    if (stored && !newOpen) {
      closePrescUids.push(String(r.presc_uid));
      if (sample.length < 25) {
        for (const f of clinical) {
          if (f.kind === 'surgical_indication' && f.grounding === 'corpus_cited' && f.citation_ids.length > 0) {
            const reason = !isSpecificSurgicalIndication(f.claim)
              ? 'generic/conditional'
              : (f.confidence < (minConf ?? PITCH_MIN_CONFIDENCE) ? 'low confidence' : 'other');
            sample.push({ claim: f.claim.slice(0, 200), reason, confidence: f.confidence });
            break;
          }
        }
      }
    }
  }

  const total = rows.length;
  const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

  let applied = 0;
  if (apply && closePrescUids.length) {
    try {
      const res = await run(
        `UPDATE ccb_briefs SET pitch_allowed = false
         WHERE engine_version = $1 AND pitch_allowed = true AND presc_uid = ANY($2) RETURNING presc_uid`,
        [CCB_ENGINE_VERSION, closePrescUids],
      );
      applied = res.length;
    } catch (e) {
      return NextResponse.json({ ok: false, error: `apply failed: ${String((e as Error).message)}` }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    engine_version: CCB_ENGINE_VERSION,
    min_confidence: minConf ?? PITCH_MIN_CONFIDENCE,
    total,
    pitch_rate: {
      stored: { flagged: storedFlagged, pct: pct(storedFlagged) },
      old_recomputed: { flagged: oldFlagged, pct: pct(oldFlagged) },
      new_calibrated: { flagged: newFlagged, pct: pct(newFlagged) },
    },
    would_close: closePrescUids.length,
    applied,
    dry_run: !apply,
    sample_closed: sample,
    sample_still_open: sampleOpen,
  });
}
