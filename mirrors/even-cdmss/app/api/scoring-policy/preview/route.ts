export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/scoring-policy/preview   { note_type, weights }
 *   → what this candidate vector would do to the last 90 days (PRD §5.3 impact preview).
 *
 * Read-only. Computes nothing that is written anywhere; the cohort is fetched once and the
 * arithmetic is pure (lib/scoring-policy/preview.ts).
 *
 * ═══ IPD vs OPD ═══
 * IPD has full per-field history from day one: `ipd_discharge_audits.report` is the whole
 * de-identified AuditReport, and `report.completeness.items` carries the 21 statuses.
 * OPD does NOT (decision §1.5) — `opd_note_audits` stores `missing_fields` (display LABELS) and
 * `completeness_pct`, but no per-field status array, so its 25,130-note history cannot be
 * re-weighted. For opd_rx this endpoint returns `emptyState: true` with the accumulated count,
 * which is exactly what PRD §5.3's OPD empty state renders.
 *
 * Fail-safe: any query failure returns an empty cohort with `degraded: true` and HTTP 200. The
 * screen then shows "preview unavailable" beside working tier controls, rather than an error page.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getActivePolicy, ipdPreviewCohort, opdAccumulatedCount, PREVIEW_WINDOW_DAYS, authedAdminRequest, resolveNoteType } from '@/lib/scoring-policy/store';
import { validateVector, weightedKeysFor, labelFor } from '@/lib/scoring-policy/weights';
import { DISCHARGE_SUMMARY_COND_KEYS, OPD_RX_COND_KEYS } from '@/lib/scoring-policy/completeness';
import { previewImpact, missingPrevalence, systemicDefectWarnings } from '@/lib/scoring-policy/preview';

export async function POST(req: NextRequest) {
  if (!(await authedAdminRequest(req))) return NextResponse.json({ error: 'admin required' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }

  const noteType = resolveNoteType(typeof body.note_type === 'string' ? body.note_type : null);
  const keys = weightedKeysFor(noteType);
  const v = validateVector(body.weights, keys);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const active = await getActivePolicy(noteType);
  const condKeys = noteType === 'opd_rx' ? OPD_RX_COND_KEYS : DISCHARGE_SUMMARY_COND_KEYS;

  // ── OPD: no stored per-field history ⇒ the documented empty state, not a fake preview ──────────
  if (noteType === 'opd_rx') {
    const accumulated = await opdAccumulatedCount();
    return NextResponse.json({
      noteType, emptyState: true, accumulated, windowDays: PREVIEW_WINDOW_DAYS,
      message: 'OPD audits began recording per-field detail with this release. Impact preview will appear once enough audits have accumulated. Weights you publish here apply to new audits from the moment they go live.',
    });
  }

  try {
    const rows = await ipdPreviewCohort();
    const impact = previewImpact(rows, active.vector, v.vector, { condKeys });
    const prevalence = missingPrevalence(rows);
    const warnings = systemicDefectWarnings(v.vector, prevalence, (k) => labelFor(noteType, k));
    return NextResponse.json({
      noteType, emptyState: rows.length === 0, windowDays: PREVIEW_WINDOW_DAYS,
      n: rows.length, ...impact, prevalence, warnings, degraded: false,
    });
  } catch {
    // PRD §8.1 — degrade, never 500. Tier controls stay usable; the preview says so.
    return NextResponse.json({
      noteType, emptyState: true, degraded: true, n: 0, windowDays: PREVIEW_WINDOW_DAYS,
      message: 'Impact preview is temporarily unavailable. Tier changes can still be made and published; scores are unaffected.',
    });
  }
}
