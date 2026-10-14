export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { updateOpdAudit, displayedBandColumnExists } from '@/lib/opd-audit-store';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';
import { hysteresisBand } from '@/lib/opd-note-score-core';
import { fetchOpdNotesByUids } from '@/lib/metabase';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { getSettings, setSetting } from '@/lib/mini-backfill';
import {
  rescoreCandidateSql, clampRescoreLimit, RESCORE_WATERMARK_UPSERT_SQL, buildWatermarkParams,
  pdqi9ObjFromStoredRows, directionGained, underuseCount, reduceRescoreReport, emptyRescoreReport,
  resolveEngineFilter, RESCORE_LOCK_KEY, rescoreLockHeld,
} from '@/lib/opd-rescore-direction-core';
import type { RescoreOutcome } from '@/lib/opd-rescore-direction-core';
import type { OpdFinding, OpdSuggestion } from '@/lib/opd-note-audit-core';
import type { Source } from '@/lib/citations-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function authed(req: NextRequest): Promise<boolean> {
  const token = req.nextUrl.searchParams.get('token');
  if (!!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) return true;
  const secret = req.nextUrl.searchParams.get('secret');
  if (!!process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const chunk = <T,>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
// Same source-of-notes scoping as the concept tick (lib/even-concept.ts) — the two halves of the
// loop must look at the same population.
const APP = process.env.APP_SOURCE || 'standalone';

/**
 * The `direction` dead-path RE-SCORE (PRD 29 Jul 2026). ADMIN, no cron, no ?auto= — cadence is
 * V's decision, later.
 *   GET /api/admin/opd-rescore-direction[?limit=800][&apply=1]
 *     For every note the concept coder has touched more recently than the last re-score that
 *     observed it, re-run the audit on the REUSE path (stored LLM findings — which carry
 *     concept_id — + stored PDQI-9; no retrieval, no LLM). finalize() then stamps `direction`,
 *     findingPenalty zeroes underuse findings, and the score/band rewrite lands via
 *     updateOpdAudit (hysteresis applied there — D-4, not our code). Read-only unless ?apply=1.
 *
 * THE RACE GUARD (D-3): the watermark records the coded_at READ AT SELECTION — never now(),
 * never a re-read. A concept tick landing mid-flight re-selects the note next pass; a clobbered
 * direction self-heals. No locks.
 *
 * FAIL SAFE: any candidate-query error (including opd_rescore_state not yet migrated) degrades to
 * an empty report — never a 500, never a partial write.
 */
export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const apply = p.get('apply') === '1';
  const limit = clampRescoreLimit(p.get('limit'));
  // A-1 (D-8): optional single-version stratum (?engine=opd-note-audit/0.81.17, exact match only).
  // Whitelisted against the family — an unknown value resolves to [], selects zero rows, reports empty.
  const engines = resolveEngineFilter(p.get('engine'), OPD_ENGINE_VERSIONS_CURRENT);

  // A-4 defect 3 — ONE soft advisory lock for the whole pass (lab_batch pattern, TTL included).
  // Overlapping invocations both select the same candidates and the later watermark write
  // overwrites index_before with post-update values, voiding the audit trail. Held ⇒ HTTP 200
  // with the empty report and skipped:'locked' — never a 500, never a queue. A settings failure
  // degrades to UNLOCKED: the lock is advisory, and the D-3 self-heal bounds what an overlap can
  // cost (scores stay correct; only the watermark's before-record is at risk).
  let lockAcquired = false;
  try {
    const st = await getSettings([RESCORE_LOCK_KEY]);
    if (rescoreLockHeld(st[RESCORE_LOCK_KEY] || null)) {
      return NextResponse.json({ ok: true, dry_run: !apply, skipped: 'locked', ...emptyRescoreReport() });
    }
    await setSetting(RESCORE_LOCK_KEY, new Date().toISOString());
    lockAcquired = true;
  } catch { /* advisory — proceed unlocked */ }
  try {

  // Migration-0029 tolerance, same as the store: without displayed_band, band_* fall back to raw band.
  let withBand = false;
  try { withBand = await displayedBandColumnExists(); } catch { withBand = false; }

  let rows: Record<string, unknown>[];
  try {
    rows = await run(rescoreCandidateSql(withBand), [APP, engines, limit]);
  } catch (e) {
    return NextResponse.json({
      ok: true, dry_run: !apply, ...emptyRescoreReport(),
      candidate_query_error: String((e as Error).message).slice(0, 300),
    });
  }

  // One candidate row per (uid, engine_version) — the audit table's own grain.
  const candidates = rows.filter((r) => String(r.uid || ''));
  const uids = Array.from(new Set(candidates.map((r) => String(r.uid))));

  // Bulk-fetch the source notes (chunked) so we recompute from the same content the audit saw.
  const notes = new Map<string, Record<string, unknown>>();
  for (const grp of chunk(uids, 40)) {
    try {
      const fetched = await fetchOpdNotesByUids(grp);
      for (const n of fetched) { const u = String(n.uid || ''); if (u) notes.set(u, n); }
    } catch { /* skip a bad chunk; those rows are counted as not_fetched */ }
  }

  const outcomes: RescoreOutcome[] = [];
  let watermarkFailed = 0;
  for (const stored of candidates) {
    const uid = String(stored.uid);
    const engineVersion = String(stored.engine_version || '');
    const note = notes.get(uid);
    if (!note || !engineVersion) {
      outcomes.push({ uid, fetched: false, directionGained: 0, indexBefore: null, indexAfter: null, bandBefore: null, bandAfter: null, nUnderuse: 0, applied: false });
      continue;
    }

    const storedFindings = asArr(stored.findings);
    const reuse = {
      llmFindings: (storedFindings as OpdFinding[]).filter((f) => f && f.source === 'llm'),
      pdqi9: pdqi9ObjFromStoredRows(stored.pdqi9),
      suggestions: asArr(stored.suggestions) as OpdSuggestion[],
      sources: asArr(stored.sources) as Source[],
    };

    let audit;
    // engineVersion = the row's OWN version, so updateOpdAudit keys its WHERE on the source
    // version and updates IN PLACE. engine_version never enters a SET list.
    try { audit = await auditOpdNote(note, { trace: false, reuse, engineVersion }); }
    catch {
      outcomes.push({ uid, fetched: false, directionGained: 0, indexBefore: null, indexAfter: null, bandBefore: null, bandAfter: null, nUnderuse: 0, applied: false });
      continue;
    }

    const indexBefore = stored.note_quality_index == null ? null : Number(stored.note_quality_index);
    const indexAfter = audit.scorecard.headline;
    const storedDisplayed = withBand && stored.displayed_band != null ? String(stored.displayed_band) : null;
    const storedBand = stored.band == null ? null : String(stored.band);
    // band_* record what a clinician actually SEES (PRD §2.5): displayed_band with its raw-band
    // fallback where 0029 has run; the raw band otherwise. band_after mirrors the store's SQL
    // hysteresis rule via the pure twin — same HYSTERESIS_G, same thresholds, prior NULL ⇒ fresh
    // raw band. The actual band write is updateOpdAudit's alone (D-4).
    const bandBefore = withBand ? (storedDisplayed ?? storedBand) : storedBand;
    const bandAfter = withBand ? hysteresisBand(indexAfter, storedDisplayed) : audit.scorecard.band;

    let applied = false;
    let applyOutcome: 'updated' | 'skipped' | 'error' | undefined;
    let applyError: string | undefined;
    if (apply) {
      try {
        // A-2 — 'skipped' is no longer collapsed into silence: the outcome is reported so a
        // skip and a discarded throw are distinguishable from outside. Behaviour unchanged.
        const res = await updateOpdAudit(audit);
        applyOutcome = res;
        if (res === 'updated') {
          applied = true;
          // D-3 — the watermark carries the coded_at READ IN THE CANDIDATE SELECT (stored.coded_at),
          // NOT now() and NOT a re-read. Every processed note is watermarked, including zero-change
          // ones, so it is not rescanned until the coder touches it again.
          try {
            await run(RESCORE_WATERMARK_UPSERT_SQL, buildWatermarkParams({
              uid, engineVersion, observedCodedAt: stored.coded_at,
              indexBefore, indexAfter, bandBefore, bandAfter,
            }));
          } catch { watermarkFailed++; }
        }
      } catch (e) {
        // Still continues — an unapplied candidate is simply re-selected next pass. A-2 adds the
        // message (driver text only, never note content, never console-logged) to the report.
        applyOutcome = 'error';
        applyError = String((e as Error)?.message ?? e).slice(0, 300);
      }
    }

    outcomes.push({
      uid, fetched: true,
      directionGained: directionGained(storedFindings, audit.findings),
      indexBefore, indexAfter, bandBefore, bandAfter,
      nUnderuse: underuseCount(audit.findings),
      applied, applyOutcome, applyError,
      auditUid: audit.keys?.uid ?? null,
    });
  }

  // A-2 — the apply diagnostics ride the report but are EMITTED only when non-zero / non-null,
  // matching the watermark_failed style.
  const { apply_skipped, apply_error, first_apply_error, missing_audit_uid, ...report } = reduceRescoreReport(outcomes);
  return NextResponse.json({
    ok: true,
    dry_run: !apply,
    // A-1: the FILTERED list, not the family — the report must describe what actually ran.
    engine_versions: engines.length,
    displayed_band_column: withBand,
    stored_rows: rows.length,
    ...report,
    ...(apply_skipped ? { apply_skipped } : {}),
    ...(apply_error ? { apply_error } : {}),
    ...(first_apply_error != null ? { first_apply_error } : {}),
    ...(missing_audit_uid ? { missing_audit_uid } : {}),
    ...(watermarkFailed ? { watermark_failed: watermarkFailed } : {}),
  });

  } finally {
    // Released on EVERY exit, including the fail-safe early returns; a crashed run that never
    // reaches here self-heals via RESCORE_LOCK_TTL_MS.
    if (lockAcquired) await setSetting(RESCORE_LOCK_KEY, '').catch(() => {});
  }
}
