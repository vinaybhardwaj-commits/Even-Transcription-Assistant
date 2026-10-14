// The readmission agent worker (PRD CDMSS-READMISSION-AGENT-PRD-v0.7 §8a, decision 11).
// Mirrors /api/ipd-audit/worker: same auth guard, same box, same sweep-is-the-retry posture.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Same box as the IPD worker, and the cron interval must clear it: */15 = 900 s > 800 s.
// Any future change to maxDuration must move the cron interval with it, in the same commit.
export const maxDuration = 800;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { runDetectionSweep, runReadmissionAudit, readmitAuditModel } from '@/lib/readmission/run';
import { pendingFindings, findingCounts, READMIT_ENGINE_VERSION, AUDITABLE_LANES } from '@/lib/readmission/store';

/**
 * Behaviour per tick:
 *   1. DETECTION SWEEP (₹0, deterministic SQL + pure core) — always runs, upserts
 *      detection rows idempotently on (dedup_key, READMIT_ENGINE_VERSION). This is
 *      what V validates lane counts against (A 19 / B 30 / C 36 / D 27) BEFORE the
 *      Vertex flag ever goes on. ?detect_only=1 stops here.
 *   2. AUDIT (Vertex) — only when GEMINI_READMIT_AUDIT=1 + geminiConfigured().
 *      Flag off ⇒ audits are a safe no-op (never Ollama, never a fabricated verdict).
 *      Pending findings are audited oldest-readmit-first, idempotent: a failure
 *      leaves the row 'detected' and the next sweep retries it.
 *
 *   ?day=YYYY-MM-DD → only findings whose readmit admission is that IST day.
 *   ?lane=<lane>    → override the auditable-lane set (e.g. lane=excluded for the
 *                     Lane-C confirmation sample; PRD §4 "Sample only").
 *   ?auto=1         → the cron/manual trigger form (same semantics as default).
 *   ?max / ?conc    → batch size / concurrency, defaults 3/3 (see the arithmetic).
 *
 * ⚠️ NOTE (flagged in the build report): the IPD worker sweeps a day-lookback
 * because its corpus arrives daily and history belongs to a backfill. Here the
 * historical 112-pair backlog IS the Phase-1 deliverable and there is no separate
 * backfill, so the default sweep audits the full pending set oldest-first. ?day=
 * gives the day-scoped behaviour when wanted.
 */

// Execution guard (spends LLM compute) — byte-for-byte the IPD worker's:
// Vercel Cron (un-spoofable x-vercel-cron), Bearer CRON_SECRET / ?secret=, or admin session.
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;

  // ── THE BATCH MUST FIT THE BOX (derived from PROVIDER_BUDGETS, the IPD discipline) ──
  // WORST CASE PER FINDING (vertex audit_ipd budget = 200,000 ms × 1 try per leg):
  //
  //   lane D promoted (decision 14):  condition pass + recon A + recon B = 3 legs
  //   3 × 200,000                                   = 600,000 ms
  //   db13 reads (2 summaries + 2 lab sets)         ≈  30,000 ms
  //   per finding                                     ~630,000 ms
  //   box                                              800,000 ms
  //   waves ceil(max 3 / conc 3) = 1 → wall ≈ one worst-case finding ≈ 630,000 ms
  //   margin                                          ~170,000 ms   guard PASS
  //
  // A second wave would be ~1,260,000 ms and CANNOT fit — max stays ≤ conc by default.
  // (Plain lane A/B findings are 2 legs ≈ 430 s; OON is 1 leg ≈ 230 s. The arithmetic
  // sizes against the worst case, not the average.)
  // ⚠️ These numbers are coupled: max, conc, maxDuration, the leg count per lane, and
  // PROVIDER_BUDGETS.vertex.audit_ipd. Changing any one means redoing this arithmetic.
  const max = Math.max(1, Math.min(10, Number(p.get('max') || 3)));
  const conc = Math.max(1, Math.min(5, Number(p.get('conc') || 3)));
  const dayParam = p.get('day');
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : null;
  const laneParam = p.get('lane');
  const lane = laneParam && ([...AUDITABLE_LANES, 'excluded'] as string[]).includes(laneParam) ? laneParam : null;

  try {
    // 1. Detection sweep — deterministic, idempotent, ₹0. Runs every tick so a new
    //    readmit admission (or a new POST_IPD form) becomes a row within one cadence.
    const detection = await runDetectionSweep();

    const vertexOn = Boolean(readmitAuditModel());
    if (p.get('detect_only') === '1' || !vertexOn) {
      const counts = await findingCounts();
      return NextResponse.json({
        ok: true, mode: 'detect', engine: READMIT_ENGINE_VERSION,
        vertex: vertexOn ? 'on' : 'disabled (GEMINI_READMIT_AUDIT unset — audits no-op safely, never Ollama)',
        ...detection, counts,
      });
    }

    // 2. Audit the pending set, oldest readmit first. Idempotent on
    //    (dedup_key, READMIT_ENGINE_VERSION); failures stay 'detected' and re-sweep.
    const pending = await pendingFindings({ limit: max, lane, readmitDay: day });
    const results = pending.length ? await mapLimit(pending, conc, (r) => runReadmissionAudit(r)) : [];
    const audited = results.filter((r) => r.status === 'audited').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const notAuditable = results.filter((r) => r.status === 'not_auditable').length;
    const counts = await findingCounts();

    return NextResponse.json({
      ok: true, mode: day ? 'day' : 'sweep', day, lane, engine: READMIT_ENGINE_VERSION,
      ...detection,
      processed: results.length, audited, failed, notAuditable,
      done: pending.length < max, counts, results,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
