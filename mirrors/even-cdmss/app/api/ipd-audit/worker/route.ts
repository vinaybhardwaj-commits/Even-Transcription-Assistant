// ⚠️ CRON RESTORED 2 Aug 2026 at */15 1-5 IST, after being removed in 3039c42 ON A WRONG PREMISE.
//
// THE CORRECTION, MEASURED. 3039c42's note said this worker "504'd on EVERY run and produced
// nothing". The first half was true; the second was not. ipd_discharge_audits holds 19 audits on
// 2 Aug, 18 on 1 Aug, 37 on 31 Jul. The worker WORKS: it completes several documents, writes them,
// and then dies mid-batch when the invocation budget runs out. Removing the cron cost real output.
//
// THE ACTUAL DEFECT WAS BATCH SIZE AGAINST THE BOX, not the route. See the max/conc note at the
// defaults below for the arithmetic: max=8 × conc=3 is three sequential waves (~1,530 s) inside an
// 800 s box, so it could not help but die partway. max=3 is one wave (~510 s) and fits.
//
// AND THE CADENCE HAD TO CLEAR THE BOX. The old schedule was */10 — a 600 s interval into an 800 s
// maxDuration, which GUARANTEES overlapping invocations. That is how one slow run became a
// continuous request storm holding 3 concurrent Gemini calls at a time and throttling the account
// (the "429 google/gemini-2.5-flash is temporarily rate limited" in the same window). */15 is
// 900 s and clears the box with 100 s to spare. Any future change to maxDuration must move the
// cron interval with it, in the same commit — that relationship is not enforced anywhere.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 300 → 800 (OPENROUTER-TIMEOUT-ROOT-CAUSE PRD §4.2, 2 Aug 2026), matching the OPD worker.
// LLM_AUDIT_TIMEOUT_MS is 600 s and the transport retry ladder needs ~350 s on top, so a 300 s box
// could not contain one audit let alone a retry. MEASURED: this route 504'd on EVERY run — 01:30,
// 01:40, 01:50, 02:00, 02:10, 02:20, 02:31, 02:40, 02:50, 03:00, 03:10, 03:20 in a single night,
// producing nothing while holding up to 3 concurrent Gemini requests each time. The constant is
// global; maxDuration is per route, and nobody had checked this one against it.
export const maxDuration = 800;

import { NextRequest, NextResponse } from 'next/server';
import { countDischargeDocsForDay, fetchDischargeDocsForDay } from '@/lib/ipd-audit/db13';
import { auditedDocIdsAnyVersion, earliestAuditedDay, IPD_ENGINE_VERSION } from '@/lib/ipd-audit/store';
import { runIpdAudit } from '@/lib/ipd-audit/run';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { getSettings, setSetting } from '@/lib/mini-backfill';
import { MINI_MODEL } from '@/lib/llm';
import { providerSwitchEnabled, resolveWorkerProvider, canServe } from '@/lib/lab-provider-core';

/**
 * S5 — the daily IPD discharge-summary worker (Gemini, K=1). Mirrors /api/opd-audit/worker:
 * count-agnostic, resumable, GAP-PROOF.
 *
 *  • ?day=YYYY-MM-DD  → audit just that IST day (manual backfill / spot-fill).
 *  • default (cron)   → SWEEP a lookback window ending yesterday IST, oldest un-audited day
 *    first, so a missed night self-heals on the next run. Floored at the forward cutoff (else
 *    the earliest-ever audited day) so it never reaches back before launch. Idempotent on
 *    (document_id, engine_version) — caught-up days are cheap no-ops, no re-charge.
 *
 * FORWARD-ONLY (the OPD division of labour): this worker audits only GENUINELY NEW docs — never
 * audited at ANY engine version. History and re-audits belong to the free Mini backfill (S6).
 * K=1 by construction (one extract + one analyze per doc). Single-run bands carry the
 * '±1 · provisional' marker on the surface (S4 reframe) — nothing here presents them as settled.
 *
 * ?max (default 3, ≤20) · ?conc (default 3, ≤5) · ?lookback (default IPD_AUDIT_LOOKBACK or 3, ≤14)
 */

// Forward cutoff — audit only discharges on/after this IST day. Set via ?set_forward_from=YYYY-MM-DD.
const FWD_KEY = 'ipd_gemini_forward_from';
async function forwardCutoff(): Promise<string | null> {
  const s = await getSettings([FWD_KEY]).catch(() => ({} as Record<string, string>));
  const v = s[FWD_KEY] || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// Execution guard (spends LLM compute): Vercel Cron (un-spoofable x-vercel-cron), a manual
// trigger carrying Bearer CRON_SECRET / ?secret=CRON_SECRET, or a logged-in admin session.
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

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}
function istYesterday(): string {
  return new Date(Date.now() + 5.5 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
}

/** Audit one batch of NEVER-YET-AUDITED docs for a single IST day. `done` is decided by asking
 *  the intake for one more pending doc AFTER the batch — no arithmetic to drift out of sync.
 *  Unreadable (scan / no text layer) docs are skipped + counted, NOT retried forever: they still
 *  come back next tick, so the log surfaces them for the OCR decision (flagged, not silently
 *  looped). Envelope-less text PDFs (no kx link → no speciality/LOS) ARE audited, just counted. */
async function processDay(day: string, max: number, conc: number) {
  const total = await countDischargeDocsForDay(day);
  const already = await auditedDocIdsAnyVersion();
  const docs = await fetchDischargeDocsForDay(day, already, max);
  if (!docs.length) return { day, total, processed: 0, remaining: 0, done: true, results: [] as unknown[] };

  const results = await mapLimit(docs, conc, (d) => runIpdAudit(d));
  const inserted = results.filter((r) => r.status === 'inserted').length;
  const skipped = results.filter((r) => r.skip).length;
  const errors = results.filter((r) => r.error).length;
  const noEnvelope = results.filter((r) => r.status && !r.ip_uid).length;

  const stillPending = await fetchDischargeDocsForDay(day, await auditedDocIdsAnyVersion(), 1);
  return {
    day, total, processed: results.length, inserted, skipped, errors, noEnvelope,
    done: stillPending.length === 0, results,
  };
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  // ── THE BATCH MUST FIT THE BOX (2 Aug 2026, RE-DERIVED 3 Aug) ──────────────────────────────
  // WORST CASE PER DOCUMENT, from PROVIDER_BUDGETS (lib/lab-provider-core.ts) × the leg count:
  //
  //   doc_read                     180,000 × 1        =  180,000
  //   audit_ipd × IPD_ANALYZE_LEGS 200,000 × 1 × 3    =  600,000
  //                                                      -------
  //   per document                                        780,000 ms
  //   box                                                 800,000 ms
  //   margin                                               20,000 ms   (2.5%)
  //   waves  ceil(max 3 / conc 3) = 1                      guard PASS
  //
  // ⚠️ THE PREVIOUS ARITHMETIC HERE WAS WRONG TWICE OVER, and it is worth keeping the record.
  // It read "the analyze pass at OPENROUTER_MAX_TRIES × OPENROUTER_TIMEOUT_MS (3 × 110 s = 330 s)
  // → 510 s". The 110 s term WAS THE DEFECT — openrouterCreateWithRetry was discarding the caller's
  // ceiling, so that number described a bug rather than a budget. And it counted ONE analyze leg
  // when analyzeCase fires up to THREE (doc_audit_analyze, doc_audit_critique_llm which is on by
  // default, and doc_audit_revise — see IPD_ANALYZE_LEGS in lib/doc-audit.ts). Sizing a batch
  // against a defect times a third of the work is how a route "proves" it fits a box it is over.
  //
  // THE RETRY DID NOT DISAPPEAR. IT MOVED. A failed call fails that document and writes no row, and
  // the worker sweeps for un-audited documents on every tick — so the sweep IS the retry, and it
  // has a whole window of budget instead of the tail of one invocation. A transient 429 costs one
  // document one tick.
  //
  // The DEFAULTS change only. ?max= and ?conc= keep their overrides and their caps (≤20 / ≤5), so
  // a manual backfill can still ask for a bigger batch and accept the risk deliberately.
  // ⚠️ These four numbers are coupled: max, conc, maxDuration and the leg count. Changing any one
  // without redoing this arithmetic is how the route ended up in a box it could not fit.
  const max = Math.max(1, Math.min(20, Number(p.get('max') || 3)));
  const conc = Math.max(1, Math.min(5, Number(p.get('conc') || 3)));
  const dayParam = p.get('day');

  // ?provider= (Unit D, behind PROVIDER_SWITCH_ENABLED). Flag off ⇒ INERT and this route is
  // byte-identical to today. Flag on ⇒ resolved loudly, and a provider with no 'audit_ipd' budget
  // is REFUSED rather than quietly given a default. `ollama` legitimately serves audit_ipd (the
  // Qwen backfill's analyze leg); it is `doc_read` it cannot serve, which is checked too because
  // every IPD document begins with a multimodal read even on the mini path.
  if (providerSwitchEnabled()) {
    const rp = resolveWorkerProvider(p.get('provider'), MINI_MODEL);
    if (!rp.ok) return NextResponse.json({ ok: false, error: rp.error }, { status: 400 });
    if (rp.provider) {
      for (const cls of ['audit_ipd', 'doc_read'] as const) {
        if (!canServe(rp.provider, cls)) {
          return NextResponse.json({ ok: false, error: `provider '${rp.provider}' has no '${cls}' budget — it cannot serve this class. Refusing rather than substituting a default.` }, { status: 400 });
        }
      }
    }
  }

  // Admin: set / clear the forward cutoff (?set_forward_from=YYYY-MM-DD, or =off).
  const setFwd = p.get('set_forward_from');
  if (setFwd != null) {
    const val = /^\d{4}-\d{2}-\d{2}$/.test(setFwd) ? setFwd : '';
    await setSetting(FWD_KEY, val);
    return NextResponse.json({ ok: true, forward_from: val || null });
  }

  try {
    const cutoff = await forwardCutoff();

    if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      if (cutoff && dayParam < cutoff) {
        return NextResponse.json({ ok: true, mode: 'day', day: dayParam, engine: IPD_ENGINE_VERSION, skipped: `before the Gemini forward cutoff ${cutoff} — history is the Mini backfill's job`, processed: 0 });
      }
      const r = await processDay(dayParam, max, conc);
      return NextResponse.json({ ok: true, mode: 'day', engine: IPD_ENGINE_VERSION, ...r });
    }

    const lookback = Math.max(1, Math.min(14, Number(p.get('lookback') || process.env.IPD_AUDIT_LOOKBACK || 3)));
    const yesterday = istYesterday();
    const baseFloor = (await earliestAuditedDay()) || yesterday;
    const floor = cutoff && cutoff > baseFloor ? cutoff : baseFloor;
    const days: string[] = [];
    for (let i = lookback - 1; i >= 0; i--) { const d = addDays(yesterday, -i); if (d >= floor) days.push(d); }
    const window = { from: days[0] ?? yesterday, to: yesterday };

    const already = await auditedDocIdsAnyVersion();
    for (const d of days) {
      const total = await countDischargeDocsForDay(d);
      if (total === 0) continue;
      const pending = await fetchDischargeDocsForDay(d, already, 1);
      if (pending.length > 0) {
        const r = await processDay(d, max, conc);
        return NextResponse.json({ ok: true, mode: 'sweep', engine: IPD_ENGINE_VERSION, window, ...r });
      }
    }
    return NextResponse.json({ ok: true, mode: 'sweep', engine: IPD_ENGINE_VERSION, window, caughtUp: true, done: true, processed: 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
