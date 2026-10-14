import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { telemetryContextFor } from '@/lib/retrieval-telemetry-core';
import { readRetrievalTelemetry, type LifecycleHandle, type ManifestDefectsByRole } from '@/lib/retrieval-telemetry-store';
import { settleOwned, outcomeForOwnedSave } from '@/lib/retrieval-settlement';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { saveOpdAudit } from '@/lib/opd-audit-store';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/** D-D (2 Aug 2026) — the model column records what actually SERVED, not a hardcoded literal.
 *  Commit 689c739 fixed this on the worker; THIS route was missed and kept writing a constant
 *  GEMINI_MODEL, so a manual save recorded "Pro" even when the call fell back to qwen2.5:14b on
 *  the Mac mini — the same blindness that hid the SERVICE_DISABLED incident for four days.
 *
 *  Copied verbatim from app/api/opd-audit/worker/route.ts:79 rather than imported: that copy is a
 *  route-local, non-exported helper, and this batch's file contract permits editing only this file
 *  and lib/even-lvc.ts — so exporting it from the worker, or hoisting it into lib/, is out of scope.
 *  The duplication is deliberate and is flagged in the build report.
 *
 *  tracedChat's llm_response event carries the POST-fallback model (`actualModel`), so the audit's
 *  own trace is the source of truth. Null when unknown (no trace / LLM leg dead) — an honest gap,
 *  never a guess. Any query failure degrades to null, never a throw. */
async function servedModelFor(traceId: string | undefined): Promise<string | null> {
  if (!traceId) return null;
  try {
    const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<{ model?: string }[]>)(
      `SELECT payload->>'model' AS model FROM trace_events
        WHERE trace_id = $1 AND kind IN ('llm_response', 'llm_stream_usage')
          AND stage = 'opd_audit_analyze'
        ORDER BY seq DESC LIMIT 1`,
      [traceId],
    ));
    const m = rows?.[0]?.model;
    return typeof m === 'string' && m ? m : null;
  } catch { return null; }
}

// Convenience spot-check: GET ?uid=<prescription uid> fetches that note from db13 via the
// Metabase API and audits it (admin-gated) — no need to hand-assemble a row. The daily
// worker (app/api/opd-audit/worker) audits the full day; this is for one-off inspection.
export async function GET(req: NextRequest) {
  // Unit 1b (DEC-8/9/10, 2 Aug 2026) — accept the already-unlocked admin COOKIE as well as the
  // token, copying app/api/opd-audit/export-pdf/route.ts:161-165 (admin cookie only; the care
  // cookie does NOT unlock this route, DEC-10 — it runs audits and writes rows).
  //
  // THIS WIDENS NOTHING. isAdminUnlocked compares the cat_admin cookie value against ADMIN_TOKEN
  // with timingSafeEqual — the cookie's value IS the token — and returns false when ADMIN_TOKEN is
  // unset, so it never opens the route by default. The set of people who can call this does not
  // change; only how they present the same secret does. It exists because the cookie is httpOnly,
  // so a browser that has already unlocked /admin cannot read it back to send as a Bearer header,
  // and pasting the token into a URL would put a secret in browser history and owe a rotation.
  //
  // GET is the SPOT-CHECK path (?uid=… fetches one note from db13 and audits it). POST stays
  // TOKEN-ONLY on purpose (DEC-9): it accepts a hand-assembled row, so it keeps the narrower gate.
  //
  // FAIL CLOSED: .catch(() => false) is mandatory — a cookie-read failure must deny, never allow.
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const uid = req.nextUrl.searchParams.get('uid');
  if (!uid) return NextResponse.json({ ok: false, error: 'pass ?uid=<prescription uid>' }, { status: 400 });
  // The GET arm is a fresh audit that MAY save, so its intent is not knowable from the role — it is
  // declared here from the query string (D12: `persistenceIntent` is stated up front, never inferred).
  const willSave = req.nextUrl.searchParams.get('save') === '1';
  const ctx = telemetryContextFor('opd_audit_run', req.headers);
  let handle: LifecycleHandle | null = null;
  let published = false;
  /** The last map the callback delivered (v10 requirement 4), for the paths that return no audit. */
  let publishedDefects: ManifestDefectsByRole | undefined;
  try {
    const { fetchOpdNoteByUid } = await import('@/lib/metabase');
    const row = await fetchOpdNoteByUid(uid);
    if (!row) return NextResponse.json({ ok: false, error: 'note not found for that uid' }, { status: 404 });
    const audit = await auditOpdNote(row, {
      telemetry: { ctx, route: 'opd_audit_run', persistenceIntent: willSave ? 'will_persist' : 'never_persists' },
      // ⚠️ `if (d)` IS LOAD-BEARING. The DECLARATION publication passes no map, and letting it
      // overwrite a real one with undefined would throw away the verdict this exists to keep.
      onLifecycleHandleUpdated: (h, d) => { handle = h; published = true; if (d) publishedDefects = d; },
    });
    // &save=1 persists the audit (golden-A/B tool): writes the current-engine row so a before/after
    // comparison can be read from opd_note_audits by engine_version. Admin-gated; manual use only.
    // &force=1 (only with save=1) overwrites an existing (uid, engine_version) row — finishes the
    // obstetric re-score backfill where a pre-fix zero row already occupies the slot. Fail-safe:
    // a forced-save error degrades to saved:'save_failed', never a 500.
    const save = willSave;
    const force = save && req.nextUrl.searchParams.get('force') === '1';
    // ⚠️ THE ROLE MAP, NOT A FLAT LIST (pass 0b). Settlement applies each run's own role's
    // verdict; passing one merged array is what made a normative defect dirty the primary row.
    // ⚠️ NO `?? {}` (v10 requirement 5). An empty map is NOT "no map": under requirement 6 a
    // PROVIDED map carrying no key for a role settles that linkable role partial, so `?? {}` would
    // have made every uninstrumented save partial and left requirement 7 unreachable. The attached
    // map first, then whatever the callback delivered, then undefined — which is a real answer.
    const defectsByRole = readRetrievalTelemetry(audit)?.manifestDefectsByRole ?? publishedDefects;
    let linked = false;
    const onPersisted = async ({ status, auditId }: { status: 'inserted' | 'updated'; auditId: string }) => {
      linked = true;
      await settleOwned(handle, outcomeForOwnedSave(status), auditId, defectsByRole);
    };
    const saved = save
      ? (force
          ? await saveOpdAudit(audit, { model: await servedModelFor(audit.traceId) }, { force: true, onPersisted }).catch(() => 'save_failed' as const)
          : await saveOpdAudit(audit, { model: await servedModelFor(audit.traceId) }, { onPersisted }))
      : undefined;
    // ⚠️ THE FORCE ARM IS ITS OWN OWNER (D9). Its `.catch(() => 'save_failed')` means the throw
    // never reaches the outer catch, so nothing else could ever settle it — that arm settles
    // `audit_persistence_failed` itself, and the external behaviour (a `save_failed` string, never
    // a 500) is unchanged.
    if (!linked) {
      if (saved === 'save_failed') await settleOwned(handle, 'audit_persistence_failed');
      else if (saved !== undefined) await settleOwned(handle, outcomeForOwnedSave(saved), null, defectsByRole);
      // No save was asked for: the audit was generated and deliberately not persisted.
      else await settleOwned(handle, 'no_persistence_intended');
    }
    return NextResponse.json({ ok: true, saved, engineVersion: audit.engineVersion, audit });
  } catch (e) {
    await settleOwned(handle, published ? 'audit_generation_failed' : 'retrieval_not_run');
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}

// M1 proof route: POST a single de-identified `individuals-prescriptions` row and get
// back its OPD note-quality audit. Admin-token-gated. In M2 the daily worker calls
// auditOpdNote() directly over rows pulled from db13 via the Metabase API — this route
// is for proving + spot-checking one note (feed it a row you fetched from Metabase).
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;

  let body: { row?: Record<string, unknown> };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const row = body?.row;
  if (!row || typeof row !== 'object') {
    return NextResponse.json({ ok: false, error: 'body must be { row: <prescriptions row object> }' }, { status: 400 });
  }

  // ⚠️ THIS ARM AUDITS AND NEVER SAVES, and no property of the `primary` role could have said so —
  // which is exactly why D12 makes `persistenceIntent` a declaration rather than an inference.
  const ctx = telemetryContextFor('opd_audit_run', req.headers);
  let handle: LifecycleHandle | null = null;
  let published = false;
  try {
    const audit = await auditOpdNote(row, {
      telemetry: { ctx, route: 'opd_audit_run', persistenceIntent: 'never_persists' },
      onLifecycleHandleUpdated: (h) => { handle = h; published = true; },
    });
    await settleOwned(handle, 'no_persistence_intended');
    return NextResponse.json({ ok: true, audit });
  } catch (e) {
    await settleOwned(handle, published ? 'audit_generation_failed' : 'retrieval_not_run');
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
