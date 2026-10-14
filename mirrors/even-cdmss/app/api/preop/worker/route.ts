// The Pre-op Risk Agent worker (PRD CDMSS-PREOP-RISK-AGENT-v1.1-LOCKED §6; Build Plan B2).
// Mirrors /api/readmission/worker: same auth guard, same sweep-is-the-retry posture.
//
// B5/B6 (27 Aug 2026): the worker CAN make model calls, and with PREOP_EXTRACT_MODE unset
// the only one it makes is the narrative.
// Every tick is deterministic SQL plus the pure cores and costs ₹0. The rails attach
// above that floor, never inside it: with both on, the scores are byte-identical and the
// only difference is coverage (an extraction may fill an input the record left UNKNOWN)
// and prose (a narrative written FROM the computed factor table).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── THE CRON ↔ maxDuration COVENANT (PRD §6, Build Plan; the readmit rule, kept) ──
// The cron interval MUST clear this box, and any change to one moves the other IN THE
// SAME COMMIT.
//
//   cron          "30 0-16 * * *" UTC  = hourly, 06:00–22:00 IST → interval 3,600,000 ms
//   box                                                            300,000 ms
//   margin                                                       3,300,000 ms   PASS
//
// What has to fit inside the box. These are MEASURED on live db13 + production Neon on
// 26 Aug 2026, not estimated — four real ticks against the 19-episode upcoming window:
//   episode query (surgery_cases ⋈ individuals)                       1,376 ms
//   3 parallel source queries — the slowest sets the term:
//     OPD ICD (individuals-prescriptions, the big table)              9,902 ms
//     creatinine 302 ms · PAC 293 ms                                  (hidden by the ICD leg)
//   19 × (pure compute + at most 3 Neon statements)
//   MEASURED WHOLE TICKS                                     3,359 · 5,065 · 5,265 · 5,667 ms
//   ONE OBSERVED SLOW TICK (Metabase contention, same code)          55,383 ms
//   box                                                             300,000 ms
//   margin against the slow tick                                    ~244,000 ms   PASS
//
// ── AND THE SAME COVENANT FOR THE MODEL LEGS (B5 + B6, 27 Aug 2026) ──
// The rails are bounded BEFORE they start, not trimmed after they overrun. Three bounds,
// all in lib/preop/run.ts, and any change to one of them moves this block in the same
// commit:
//   PREOP_LLM_BUDGET_MS             180,000 ms  a leg is begun only if its own ceiling
//                                               still fits inside what is left of this
//   PREOP_EXTRACT_MAX_PER_TICK            8     × PREOP_EXTRACT_BUDGET_MS   60,000 ms
//   PREOP_NARRATIVE_MAX_PER_TICK          3     × PREOP_NARRATIVE_BUDGET_MS 80,000 ms
// The caps alone would allow 8×60 + 3×80 = 720,000 ms, which is why the BUDGET rather
// than the caps is the binding constraint: the box check refuses the leg that would not
// fit, so the worst case is 180,000 ms of model time plus the slow deterministic tick —
// 235,383 ms against a 300,000 ms box. PASS, with the caps as the pacing rule and the
// budget as the wall.
//
// And the model term, like the SQL one, shrinks as the board settles: an extraction runs
// only when the SOURCE TEXT changed and a narrative only when the SNAPSHOT FINGERPRINT
// moved, so a board that has stopped moving makes zero calls on both rails. Measured, not
// assumed — every tick reports `rails.extraction.called` and `rails.narrative.called`.
//
// The same is true of the writes: an 'unchanged' episode makes ONE Neon read and zero
// writes. The scaling term is the per-episode round trip and the episode query
// caps at 500 rows, so the worst case is ~26× today's 19 — still inside the box against
// the measured per-episode cost, and the 55 s outlier says the real risk is Metabase
// latency rather than episode count. If the upcoming window ever approaches the 500-row
// cap, redo this arithmetic in the same commit that raises it.
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import {
  runPreopSweep, preopExtractMode, preopNarrativeEnabled, preopRailsFromEnv,
  PREOP_HORIZON_DAYS, type PreopRails,
} from '@/lib/preop/run';
import { parseExtractMode } from '@/lib/preop-suggest-core';
import { boardCounts, PREOP_ENGINE_VERSION } from '@/lib/preop/store';

/**
 * Behaviour per tick: ONE deterministic sweep. Detect every upcoming, non-cancelled
 * surgical episode; assemble its inputs from the booking form, the member's OPD ICD
 * codes, the Eka creatinine and the KareXpert PAC report reached through the UHID
 * bridge; recompute the snapshot; write it through the versions rail idempotently on
 * (episode_key, PREOP_ENGINE_VERSION).
 *
 * A second tick over unchanged evidence writes NOTHING — no finding row, no version
 * row — because the snapshot fingerprint is identical and the store short-circuits on
 * it. That is the B2 idempotency gate, and it is measurable by row counts rather than
 * by argument.
 *
 *   ?dry_run=1     → compute and report the tally, write nothing (the pre-migration probe)
 *   ?horizon=<n>   → look n days ahead instead of the default 60
 *   ?rails=extract,narrative
 *                  → MEASURE a rail without committing to it. Forces the named rails on
 *                    for this tick only. It IMPLIES dry_run and the implication is
 *                    enforced here, not documented: a forced rail may never write. This
 *                    exists because "flag-on over the golden set" is a gate, and the only
 *                    honest way to meet it before V flips a production flag is a tick that
 *                    runs the real provider path and stores nothing. `rails=none` forces
 *                    both OFF, for the flag-off arm of the same comparison.
 *   ?sample=1      → return the per-episode detail the B7 validation pack is built from:
 *                    each episode's tier, instrument bounds, extraction record with its
 *                    verbatim spans, and narrative. Rails-probe only — it is refused on a
 *                    tick that is allowed to write, so the heavy payload can never be
 *                    produced by the cron.
 */

// Execution guard — byte-for-byte the readmission worker's: Vercel Cron (un-spoofable
// x-vercel-cron), Bearer CRON_SECRET / ?secret=, or an admin session.
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  // The rails override and its non-negotiable consequence.
  const railsParam = (p.get('rails') || '').trim().toLowerCase();
  let railsOverride: Partial<PreopRails> | undefined;
  if (railsParam) {
    const want = railsParam.split(/[,\s]+/).filter(Boolean);
    // B8: the extraction rail is a MODE now. `rails=suggest` and `rails=score` name it
    // directly; the older `rails=extract` still means "run the model", and it resolves to
    // `suggest` — the only mode that can actually do anything while PROMOTED_CLASSES is
    // empty. `rails=none` forces everything off.
    const mode = want.includes('none') ? 'off'
      : want.includes('score') ? parseExtractMode('score')
        : (want.includes('suggest') || want.includes('extract')) ? parseExtractMode('suggest')
          : 'off';
    railsOverride = { extract: mode, narrative: !want.includes('none') && want.includes('narrative') };
  }
  // A forced rail is a MEASUREMENT, and a measurement does not write. Not a convention —
  // the OR is right here, so no query string can produce a writing tick with a rail that
  // production has not flipped.
  const dryRun = p.get('dry_run') === '1' || !!railsOverride;
  const horizonRaw = Number(p.get('horizon') || PREOP_HORIZON_DAYS);
  const horizonDays = Number.isFinite(horizonRaw) ? Math.max(1, Math.min(365, Math.round(horizonRaw))) : PREOP_HORIZON_DAYS;

  try {
    // The sample is the pack's raw material and is only ever offered on a probe.
    const collect = p.get('sample') === '1' && !!railsOverride;
    const sweep = await runPreopSweep({ horizonDays, dryRun, rails: railsOverride, collect });
    const counts = dryRun ? null : await boardCounts();
    return NextResponse.json({
      ok: true,
      engine: PREOP_ENGINE_VERSION,
      mode: railsOverride ? 'rails_probe (dry run — nothing written)' : dryRun ? 'dry_run' : 'sweep',
      // The flags are reported on every tick so their state is never a matter of belief,
      // and the OVERRIDE is reported beside them so a probe can never be mistaken for the
      // environment having changed.
      flags: {
        extraction: preopExtractMode() === 'off'
          ? 'off (PREOP_EXTRACT_MODE unset — the model never runs; the deterministic harvest still does)'
          : `${preopExtractMode()} (PREOP_EXTRACT_MODE — suggestions only; nothing scores without a human Confirm)`,
        narrative: preopNarrativeEnabled() ? 'on' : 'off (PREOP_NARRATIVE_ENABLED unset — the case page renders the rail as visibly dark)',
      },
      railsFromEnv: preopRailsFromEnv(),
      railsThisTick: sweep.rails.requested,
      sweep,
      counts,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
