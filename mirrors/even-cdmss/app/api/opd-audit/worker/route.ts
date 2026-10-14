export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 300 → 800 (V, 30 Jul 2026). Pro's GA ceiling; 300 was the platform DEFAULT, not a cap.
// Per-note latency moved from a 36–115s spread to 124–545s when the Phase-2 determinism pin
// began sending a fixed 4096-token thinking budget on the production Gemini path
// (opd-note-audit.ts:970). At conc=5 that put whole notes past the 300s box: on 30 Jul the
// worker orphaned ~2 traces in 'running' for every 1 it completed (283 vs 146), all of them
// still unresolved 5h later — the invocation dies and the in-flight notes are simply lost.
// 800s recovers the wasted two-thirds WITHOUT raising concurrency (which would aggravate the open
// gemini-2.5-pro 403s).
//
// ⚠️ CORRECTION (Unit D, 3 Aug 2026). This note used to claim 800s "clears the observed p75 (425s)
// and max (538s)". Neither figure was ever re-measured. MEASURED on v_trace_summary,
// `opd_note_audit` successes: 2 Aug n=869 p50 51,713 · p75 89,650 · p95 382,195 · max 450,874;
// 1 Aug n=857 p50 65,578 · p95 393,147 · max 623,385; 31 Jul n=1,702 p50 69,521 · p95 309,419 ·
// max 908,045; 30 Jul n=939 p50 68,147 · p95 338,404 · max 763,927. p50 is 52–93 s, not 267 s, and
// 31 JULY'S MAX OF 908,045 ms OUTRAN THIS 800,000 ms BOX. That is unexplained and is recorded as
// owed rather than fixed here. The same stale 267/425 pair appeared in lib/opd-note-audit.ts and
// lib/openrouter-retry.ts and is corrected in both.
export const maxDuration = 800;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { countOpdNotesForDay, fetchOpdNotesForDay, fetchOpdNoteByUid, istYesterday } from '@/lib/metabase';
import { saveOpdAudit, auditedUidsForDayAnyVersion, auditedCountForDayAnyVersion, earliestAuditedDay, deleteOpdAuditsForUid } from '@/lib/opd-audit-store';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { startTrace, finishTrace } from '@/lib/trace';
import { getSettings, setSetting } from '@/lib/mini-backfill';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { MINI_MODEL } from '@/lib/llm';
import { providerSwitchEnabled, resolveWorkerProvider, canServe, type LabProvider } from '@/lib/lab-provider-core';
import { telemetryContextFor, type TelemetryRequestContext } from '@/lib/retrieval-telemetry-core';
import {
  declareNoteRuns, readRetrievalTelemetry, TelemetryDeclarationError,
  type LifecycleHandle, type ManifestDefectsByRole,
} from '@/lib/retrieval-telemetry-store';
import { startInvocation } from '@/lib/retrieval-invocation-store';
import { settleOwned, outcomeForOwnedSave } from '@/lib/retrieval-settlement';

// Fix A (intake eligibility): house-account doctor_uids excluded from the audit corpus. Lives in
// app_settings audit_intake_doctor_exclusions (JSON uid array); fail-safe → this seeded constant (so an
// exclusion-list read failure NEVER silently ADMITS an excluded note). A name-rule fallback in
// lib/metabase catches future house accounts even when absent from this list.
const INTAKE_KEY = 'audit_intake_doctor_exclusions';
const SEED_INTAKE_EXCLUSIONS = ['jE0Io6Y1Nh3E7OkbxcLY', '0bNLwwdtvCy8xw5w11VY', 'iyoFsE8BSNtp3wDfwyQP', 'Wa0ItOcg2VAOerUbwGa3', '6lBF0FPc03eNhrxgrCV6', 'DzuoUgxvw3NXZgo3P7T2', 'v1OyiGME6gQpWt0nQOWm'];
async function intakeExclusions(): Promise<string[]> {
  try {
    const s = await getSettings([INTAKE_KEY]);
    const raw = s[INTAKE_KEY];
    if (raw) { const j = JSON.parse(raw); if (Array.isArray(j)) { const l = j.map((x) => String(x).trim()).filter(Boolean); if (l.length) return l; } }
  } catch { /* fall through to the seeded constant — never admit an excluded note on a read failure */ }
  return SEED_INTAKE_EXCLUSIONS;
}

// FORWARD CUTOFF (V, 2 Jul): the Gemini worker only audits notes dated ON/AFTER this day — i.e.
// genuinely NEW notes going forward. Everything before it (all history + un-audited old notes) is
// left to the free mini backfill. Stored in app_settings; set via ?set_forward_from=YYYY-MM-DD.
const FWD_KEY = 'opd_gemini_forward_from';
async function forwardCutoff(): Promise<string | null> {
  const s = await getSettings([FWD_KEY]).catch(() => ({} as Record<string, string>));
  const v = s[FWD_KEY] || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// Execution guard (spends LLM compute): Vercel Cron (un-spoofable x-vercel-cron), a manual
// trigger carrying Bearer CRON_SECRET / ?secret=CRON_SECRET, OR a logged-in admin session
// (so the dashboard's one-click "Re-audit" button works without handling any secret).
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

/** Unchanged, except that the callback is now given its item's INDEX as well. The predeclared run
 *  ids are index-aligned to the note set, and `indexOf` would pair two identical rows with one id. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

/** T-5 — the model column records what actually SERVED, not a hardcoded literal. The old
 *  hardcoded Pro string kept reporting Pro while every call silently fell back to
 *  qwen2.5:14b on the Mac mini (26–30 Jul, 367 rows) — which is precisely what hid the
 *  SERVICE_DISABLED incident for four days. tracedChat's llm_response event carries the
 *  POST-fallback model (`actualModel`), so the audit's own trace is the source of truth.
 *  Null when unknown (no trace / LLM leg dead) — an honest gap, never a guess. */
/** Unit B (§5, 2 Aug 2026) — the SERVED provider beside the served model.
 *
 *  `model` alone cannot answer "who graded this": `google/gemini-2.5-pro` is Gemini via the
 *  OpenRouter bridge and `gemini-2.5-pro` is Gemini via Vertex, and after 30 July we could not tell
 *  which — a large part of why a three-day outage stayed hidden.
 *
 *  ONE QUERY, ONE ROW, BOTH FIELDS, deliberately. Reading them separately could pair a model from
 *  one event with a provider from another and attribute the call to a route it never took, which is
 *  a worse lie than the ambiguity being fixed. `provider` on the llm_response payload is set AFTER
 *  fallback (lib/trace.ts:337/401 reassign it to 'ollama' when the local model serves), so it is
 *  the served route, never the intended one. */
async function servedCallFor(traceId: string | undefined): Promise<{ model: string | null; provider: string | null }> {
  const none = { model: null, provider: null };
  if (!traceId) return none;
  try {
    const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<{ model?: string; provider?: string }[]>)(
      `SELECT payload->>'model' AS model, payload->>'provider' AS provider FROM trace_events
        WHERE trace_id = $1 AND kind IN ('llm_response', 'llm_stream_usage')
          AND stage = 'opd_audit_analyze'
        ORDER BY seq DESC LIMIT 1`,
      [traceId],
    ));
    const r = rows?.[0];
    return {
      model: typeof r?.model === 'string' && r.model ? r.model : null,
      provider: typeof r?.provider === 'string' && r.provider ? r.provider : null,
    };
  } catch { return none; }
}

// Audit one batch of NEVER-YET-AUDITED notes for a single IST day. The Gemini worker only touches
// genuinely NEW notes (no audit at ANY engine version) — re-auditing already-audited notes to a
// newer engine is the free mini backfill's job (V, 2 Jul: Gemini forward-only, mini for old + re-audits).
/**
 * DEC-2, behind PROVIDER_SWITCH_ENABLED (Unit D, 3 Aug 2026). A failed provider call must FAIL THAT
 * NOTE and write no row, so the next sweep picks it up again — it must not be laundered into a row
 * graded by the local mini and labelled as if the cloud model had answered.
 *
 * The check is made HERE rather than by removing lib/trace.ts's fallback, because tracedChat serves
 * far more than the audit workers (/ask, /ddx, patient summary) and removing the fallback globally
 * would change all of them. The worker asks the trace what actually served and refuses to persist a
 * mismatch; that is route-scoped and reversible by unsetting one variable.
 *
 * Flag OFF ⇒ always false ⇒ byte-identical to today, mini rows and all.
 */
function degradedAgainstIntent(served: { provider: string | null }, intended: LabProvider): boolean {
  if (!providerSwitchEnabled()) return false;
  if (intended === 'ollama') return false;              // a mini run is allowed to be served by the mini
  return served.provider === 'ollama';                  // null ⇒ unknown, not proof of a fallback
}

async function processDay(day: string, max: number, conc: number, exclude: string[], intended: LabProvider, ctx: TelemetryRequestContext) {
  const total = await countOpdNotesForDay(day, exclude);
  // §1 exception: auditedUidsForDayAnyVersion does NOT filter excluded_reason (see the store) — excluded
  // uids stay in the "already audited" set so they're never re-admitted.
  const already = await auditedUidsForDayAnyVersion(day);
  if (already.length >= total) return { day, total, audited: already.length, processed: 0, remaining: 0, done: true, results: [] as unknown[] };
  const rows = await fetchOpdNotesForDay(day, already, max, exclude);
  // Immediately before mapLimit, over the note set this day already fetched (D10).
  const runIds = await declareNoteRuns(ctx, rows as Array<Record<string, unknown>>, OPD_ENGINE_VERSION);
  const results = await mapLimit(rows, conc, async (row, idx) => {
    const started = Date.now();
    const runId = runIds[idx];
    // The handle the OWNER settles. It starts as the row this route already declared, so a throw
    // inside auditOpdNote before it ever published one still leaves something settleable — and
    // `published` is what tells the two D9 rows apart: a throw after adoption is an audit that
    // failed, a throw before it is a retrieval that never ran.
    let handle: LifecycleHandle = {
      invocationId: ctx.invocationId,
      runs: [{ role: 'primary', runId, expectedRevision: 0 }],
      persistenceIntent: 'will_persist',
    };
    let published = false;
    /** The last map the callback delivered (v10 requirement 4), for the paths that return no audit. */
    let publishedDefects: ManifestDefectsByRole | undefined;
    try {
      const audit = await auditOpdNote(row, {
        telemetry: { ctx, route: 'opd_audit_worker', persistenceIntent: 'will_persist' },
        predeclaredTelemetry: { primary: { runId, expectedRevision: 0 } },
        // ⚠️ `if (d)` IS LOAD-BEARING. The DECLARATION publication passes no map, and letting it
        // overwrite a real one with undefined would throw away the verdict this exists to keep.
        onLifecycleHandleUpdated: (h, d) => { handle = h; published = true; if (d) publishedDefects = d; },
      });
      const served = await servedCallFor(audit.traceId);
      if (degradedAgainstIntent(served, intended)) {
        // No row. The sweep is the retry: this uid stays un-audited and the next tick re-fetches it.
        await settleOwned(handle, 'persistence_refused');
        return { uid: audit.keys.uid, error: `DEC-2: ${intended} was asked, ${served.model ?? 'the local model'} answered — note failed, no row written` };
      }
      // ⚠️ THE ROLE MAP, NOT A FLAT LIST (pass 0b). Settlement applies each run's own role's
      // verdict; passing one merged array is what made a normative defect dirty the primary row.
      // ⚠️ NO `?? {}` (v10 requirement 5). An empty map is NOT "no map": under requirement 6 a
      // PROVIDED map carrying no key for a role settles that linkable role partial, so `?? {}` would
      // have made every uninstrumented save partial and left requirement 7 unreachable. The attached
      // map first, then whatever the callback delivered, then undefined — which is a real answer.
      const defectsByRole = readRetrievalTelemetry(audit)?.manifestDefectsByRole ?? publishedDefects;
      let linked = false;
      const status = await saveOpdAudit(audit, { model: served.model, provider: served.provider, latencyMs: Date.now() - started }, {
        // The audit id exists only inside the save, so the link is made from inside it (§4.5 step 4).
        onPersisted: async ({ status: s, auditId }) => {
          linked = true;
          await settleOwned(handle, outcomeForOwnedSave(s), auditId, defectsByRole);
        },
      });
      // `exists` (a losing ON CONFLICT race) and `skipped` (no uid) never produce a row to link to.
      if (!linked) await settleOwned(handle, outcomeForOwnedSave(status), null, defectsByRole);
      return { uid: audit.keys.uid, index: audit.scorecard.headline, band: audit.scorecard.band, status };
    } catch (e) {
      await settleOwned(handle, published ? 'audit_generation_failed' : 'retrieval_not_run');
      return { uid: String((row as Record<string, unknown>).uid || ''), error: String((e as Error).message) };
    }
  });
  // 'updated' = a retry landed on a llm_leg_failed row at the write-target version (addendum F v2
  // task 2) — completed work, counted the same as a fresh insert.
  const inserted = results.filter((r) => 'status' in r && ['inserted', 'updated'].includes((r as { status?: string }).status ?? '')).length;
  const audited = already.length + inserted;
  const remaining = Math.max(0, total - audited);
  return { day, total, audited, processed: results.length, remaining, done: remaining === 0, results };
}

/**
 * Count-agnostic, resumable, GAP-PROOF OPD note-quality worker.
 *
 * Two modes:
 *  • ?day=YYYY-MM-DD  → audit just that day (manual backfill / spot-fill).
 *  • default (cron)   → SWEEP a lookback window ending yesterday IST, working the OLDEST
 *    un-audited day first. So a missed night (weekend, deploy gap) is caught up automatically
 *    on the next run, oldest-first, until the whole window is complete. The window is floored
 *    at the earliest-ever audited day, so it never reaches back before the system launched,
 *    and it's idempotent (uid+engine_version), so caught-up days are cheap no-ops — no re-charge.
 *
 *  ?max (default 8, ≤30) · ?conc (default 8, ≤8) · ?lookback (default OPD_AUDIT_LOOKBACK or 4, ≤14).
 */
export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  // ── THE BATCH MUST FIT THE BOX (Unit D, 3 Aug 2026) ────────────────────────────────────────
  // WORST CASE PER NOTE, from PROVIDER_BUDGETS (lib/lab-provider-core.ts) × the leg count:
  //
  //   audit × OPD_AUDIT_LEGS   380,000 × 1 × 2   =  760,000 ms
  //   box                                           800,000 ms
  //   margin                                         40,000 ms   (5.0%)
  //   waves  ceil(max 8 / conc 8) = 1
  //
  // ⚠️ THE LEG TERM IS THE PART THAT WAS MISSING. The OPD audit does NOT make one LLM call: it
  // makes up to two, the normal call plus one bounded S0 retry (opd-note-audit.ts, OPD_AUDIT_LEGS).
  // Sizing this route against a single leg understates it by 2×, which is how the first cut of this
  // unit "proved" a batch fitted a box it was over.
  //
  // 15 → 8 and 5 → 8 so the batch is ONE wave. Four waves of a 760,000 ms note cannot fit an
  // 800,000 ms box under any budget; one wave can, and raising conc to match max costs nothing
  // because the notes are independent. ?max= and ?conc= keep their overrides and caps, so a manual
  // backfill can still ask for more and accept the risk deliberately.
  // ⚠️ These four numbers are coupled: max, conc, maxDuration and the leg count. Changing any one
  // without redoing this arithmetic is how a route ends up in a box it cannot fit.
  const max = Math.max(1, Math.min(30, Number(p.get('max') || 8)));
  const conc = Math.max(1, Math.min(8, Number(p.get('conc') || 8)));

  // ONE invocation per request, established here and threaded down (§4.1, D11). Never module state:
  // two overlapping cron ticks in one warm process would otherwise attribute their work to
  // whichever wrote the module variable last.
  const ctx = telemetryContextFor('opd_audit_worker', req.headers);

  // ?provider= (Unit D, behind PROVIDER_SWITCH_ENABLED). Flag off ⇒ the parameter is INERT and this
  // route is byte-identical to today: it is not read, so a stray ?provider= cannot change a run.
  // Flag on ⇒ resolved loudly through the provider catalogue, and a provider that cannot serve the
  // 'audit' class is REFUSED rather than quietly given the module default.
  let intended: LabProvider = 'openrouter';
  if (providerSwitchEnabled()) {
    const r = resolveWorkerProvider(p.get('provider'), MINI_MODEL);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
    if (r.provider) {
      if (!canServe(r.provider, 'audit')) {
        return NextResponse.json({ ok: false, error: `provider '${r.provider}' has no 'audit' budget — it cannot serve this class. Refusing rather than substituting a default.` }, { status: 400 });
      }
      intended = r.provider;
    }
  }
  const dayParam = p.get('day');

  // Admin: set / clear the forward cutoff (?set_forward_from=YYYY-MM-DD, or =off).
  const setFwd = p.get('set_forward_from');
  if (setFwd != null) {
    const val = /^\d{4}-\d{2}-\d{2}$/.test(setFwd) ? setFwd : '';
    await setSetting(FWD_KEY, val);
    return NextResponse.json({ ok: true, forward_from: val || null });
  }

  // Re-audit hook (Fix B / decision 2): re-run the full Gemini audit at 0.81.7 for a CSV of uids (≤25),
  // one current row per uid (DELETE-then-INSERT). Admin/CRON gate is the same `authed` above.
  const reauditCsv = p.get('reaudit_uids');
  if (reauditCsv != null) {
    const uids = reauditCsv.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25);
    // ── RESHAPED FOR D10, AND THE OUTPUT IS PRESERVED EXACTLY ─────────────────────────────────────
    // The uid list is unvalidated input and each note used to be fetched INSIDE mapLimit, so there
    // was no point at which the set of notes that really exist was known — and predeclaring per uid
    // before the fetch would insert a `started` row for every uid that does not, each becoming a
    // permanent `aborted` row that never had a retrieval to abort. So: fetch every uid first,
    // declare for the resolved ones only, and put the unresolved ones back into `results` as the
    // same `{ uid, error: 'note not found in db13' }` rows they have always been.
    //
    // mapLimit preserves input order and the 25-uid slice is upstream of the fetch, so `count` and
    // the ordering of `results` are byte-identical to before.
    let resolved: Array<{ uid: string; row: Record<string, unknown>; runId: string }>;
    try {
      const fetched = await mapLimit(uids, conc, async (uid) => ({ uid, row: await fetchOpdNoteByUid(uid).catch(() => null) }));
      const present = fetched.filter((f): f is { uid: string; row: Record<string, unknown> } => !!f.row);
      await startInvocation(ctx);
      const runIds = await declareNoteRuns(ctx, present.map((f) => f.row), OPD_ENGINE_VERSION);
      resolved = present.map((f, i) => ({ ...f, runId: runIds[i] }));
    } catch (e) {
      if (e instanceof TelemetryDeclarationError) {
        return NextResponse.json({ ok: false, mode: 'reaudit', error: e.message }, { status: 503 });
      }
      throw e;
    }

    const audited = await mapLimit(resolved, conc, async ({ uid, row, runId }) => {
      let handle: LifecycleHandle = {
        invocationId: ctx.invocationId,
        runs: [{ role: 'primary', runId, expectedRevision: 0 }],
        persistenceIntent: 'will_persist',
      };
      let published = false;
      /** The last map the callback delivered (v10 requirement 4), for the paths that return no audit. */
      let publishedDefects: ManifestDefectsByRole | undefined;
      try {
        const audit = await auditOpdNote(row, {   // 0.81.7 — consult_types-aware framing
          telemetry: { ctx, route: 'opd_audit_worker', persistenceIntent: 'will_persist' },
          predeclaredTelemetry: { primary: { runId, expectedRevision: 0 } },
          // ⚠️ `if (d)` IS LOAD-BEARING. The DECLARATION publication passes no map, and letting it
          // overwrite a real one with undefined would throw away the verdict this exists to keep.
          onLifecycleHandleUpdated: (h, d) => { handle = h; published = true; if (d) publishedDefects = d; },
        });
        const deleted = await deleteOpdAuditsForUid(uid); // drop ALL prior rows → single current row
        const served = await servedCallFor(audit.traceId);
        // ⚠️ THE ROLE MAP, NOT A FLAT LIST (pass 0b). Settlement applies each run's own role's
        // verdict; passing one merged array is what made a normative defect dirty the primary row.
        // ⚠️ NO `?? {}` (v10 requirement 5). An empty map is NOT "no map": under requirement 6 a
        // PROVIDED map carrying no key for a role settles that linkable role partial, so `?? {}` would
        // have made every uninstrumented save partial and left requirement 7 unreachable. The attached
        // map first, then whatever the callback delivered, then undefined — which is a real answer.
        const defectsByRole = readRetrievalTelemetry(audit)?.manifestDefectsByRole ?? publishedDefects;
        let linked = false;
        const status = await saveOpdAudit(audit, { model: served.model, provider: served.provider }, {
          onPersisted: async ({ status: s, auditId }) => {
            linked = true;
            await settleOwned(handle, outcomeForOwnedSave(s), auditId, defectsByRole);
          },
        });
        if (!linked) await settleOwned(handle, outcomeForOwnedSave(status), null, defectsByRole);
        return { uid, deleted, status, band: audit.scorecard.band, index: audit.scorecard.headline };
      } catch (e) {
        // The existing per-uid catch stays exactly as it is: every throw is still a 200 row.
        await settleOwned(handle, published ? 'audit_generation_failed' : 'retrieval_not_run');
        return { uid, error: String((e as Error).message) };
      }
    });
    // The unresolved uids go back in their original positions, carrying the exact row they carried
    // before this was reshaped. Nothing downstream can tell the difference.
    const byUid = new Map(audited.map((r) => [r.uid, r as unknown]));
    const results = uids.map((uid) => byUid.get(uid) ?? { uid, error: 'note not found in db13' });
    return NextResponse.json({ ok: true, mode: 'reaudit', engine: OPD_ENGINE_VERSION, count: uids.length, results });
  }

  try {
    await startInvocation(ctx);   // fail-open, even on the worker (D11)
    const cutoff = await forwardCutoff();
    const exclude = await intakeExclusions();

    // Manual single-day mode.
    if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      if (cutoff && dayParam < cutoff) {
        return NextResponse.json({ ok: true, mode: 'day', day: dayParam, skipped: `before Gemini forward cutoff ${cutoff} — history is the mini backfill's job`, processed: 0 });
      }
      const r = await processDay(dayParam, max, conc, exclude, intended, ctx);
      return NextResponse.json({ ok: true, mode: 'day', ...r });
    }

    // Sweep mode: oldest incomplete day in the lookback window. Floor = the forward cutoff if set
    // (Gemini forward-only), else the earliest-audited day (legacy gap-fill).
    const lookback = Math.max(1, Math.min(14, Number(p.get('lookback') || process.env.OPD_AUDIT_LOOKBACK || 4)));
    const yesterday = istYesterday();
    const baseFloor = (await earliestAuditedDay()) || yesterday;
    const floor = cutoff && cutoff > baseFloor ? cutoff : baseFloor;
    const days: string[] = [];
    for (let i = lookback - 1; i >= 0; i--) { const d = addDays(yesterday, -i); if (d >= floor) days.push(d); }
    const window = { from: days[0] ?? yesterday, to: yesterday };

    // ── SWEEP-1 (D3/D4, 7 Aug 2026): a zero-progress day must not black out the days behind it ──
    // The loop used to return after the FIRST incomplete day, whatever came of it. On the night of
    // 6→7 Aug a duplicate db13 row made 5 Aug read 469 against 468 audited uids, so every tick
    // re-opened 5 Aug, fetched nothing, and returned 200 — 120 cron invocations, zero traces, zero
    // rows, and 6 August's 374 eligible notes never reached at all. A day that makes NO progress is
    // now recorded and SKIPPED for this tick; the sweep moves on. Oldest-first still holds for
    // every day that does progress, so this only ever relaxes a day that is already stuck.
    const stalled: Array<{ day: string; total: number; audited: number; remaining: number }> = [];
    for (const d of days) {
      const total = await countOpdNotesForDay(d, exclude);
      if (total === 0) continue;
      const auditedCount = await auditedCountForDayAnyVersion(d);
      if (auditedCount >= total) continue;
      const r = await processDay(d, max, conc, exclude, intended, ctx);
      // A recount inside processDay caught the day up (a concurrent tick finished it): complete,
      // not stalled — nothing is wrong and nothing needs a trace.
      if (r.done) continue;
      if (r.processed === 0) {
        // The count and the fetch disagree: the day says work remains, the fetch offers none.
        // Numbers come from processDay's own read rather than the loop's, because those are the
        // freshest and they are internally consistent (audited + remaining = total).
        const mark = { day: d, total: r.total, audited: r.audited, remaining: r.remaining };
        // ONE trace per stalled day per tick. Finished as 'error' deliberately: a silent 200 is
        // exactly what hid this for a night, so the stall has to leave a mark that reads as wrong.
        // Tracing never throws (lib/trace swallows its own errors), so this cannot break the sweep.
        const traceId = await startTrace('opd_sweep_stall', mark);
        await finishTrace(traceId, 'error', `sweep made no progress on ${d}: count says ${r.total}, ${r.audited} audited, the fetch returned no rows`);
        stalled.push(mark);
        continue;
      }
      return NextResponse.json({ ok: true, mode: 'sweep', window, ...r, stalled_days: stalled });
    }
    return NextResponse.json({ ok: true, mode: 'sweep', window, caughtUp: stalled.length === 0, done: stalled.length === 0, processed: 0, stalled_days: stalled });
  } catch (e) {
    // ⚠️ 503, NOT 500, AND THE BODY SAYS WHAT SURVIVED. A declaration failure is a refusal to start
    // work, not a failure of work that started — and on a sweep it can arrive after earlier days
    // were audited and persisted, so "no notes were processed" is true of THAT DAY and of nothing
    // wider. Saying otherwise would send an operator looking for rows that are there.
    if (e instanceof TelemetryDeclarationError) {
      return NextResponse.json({
        ok: false,
        error: e.message,
        note: 'Any EARLIER day in this sweep was audited and persisted before this point; "no notes processed" is true per day, not per request.',
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
