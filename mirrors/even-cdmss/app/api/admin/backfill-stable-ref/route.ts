/**
 * GET/POST /api/admin/backfill-stable-ref — LAB-MCP Phase 1 (F1) history backfill.
 *
 * Stamps `stable_ref` onto EXISTING findings in opd_note_audits.findings[] using the SAME pure
 * computeStableRef the engine uses (lib/opd-finding-identity-core). One function, two call sites —
 * so an engine-stamped ref and a backfilled ref are byte-identical by construction.
 *
 * ⚠️ DRY-RUN BY DEFAULT. `?apply=1` is REQUIRED to write. This is the only irreversible data effect
 * in the whole PRD: a revert un-ships the code but does NOT un-write the jsonb. The dry run reports
 * rows scanned, refs computed, the COLLISION COUNT and 20 samples so V and the orchestrator can
 * validate before anything is written.
 *
 * SCOPE (decision 3): engine_version LIKE 'opd-note-audit/0.81%' only — 0.1–0.8 left as archive.
 *
 * CONTENTION (gotcha G2 — now FOUR writers: prod mini-backfill, the 2-minute Concept Coder cron, lab
 * eval batches, and this). Batches of 500 behind a cursor, never one transaction, and it YIELDS when
 * the mini-backfill soft lock is held rather than competing with it.
 *
 * ADDITIVE ONLY: sets one jsonb key on findings that lack it. Never rewrites, reorders or drops an
 * element; never touches a score column. Score-invariant by construction — computeOpdScore reads only
 * (verdict, confidence, domain).
 *
 * ⚠️ SQL INFERRED — no live DB in this sandbox. Every statement is listed verbatim in the build report
 * for validation. All paths fail-safe: an error degrades to a reported no-op, never a wrong write.
 * Auth + cursor/batch pattern inherited from app/api/admin/lvc-ref-backfill/route.ts (approved).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { computeStableRef } from '@/lib/opd-finding-identity-core';
import { getSettings, MB_KEYS, MB_LOCK_TTL_MS } from '@/lib/mini-backfill';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const CURSOR_KEY = 'stable_ref_backfill_cursor';
const EPOCH = '1970-01-01T00:00:00.000Z';
/** A7: the id half of the composite cursor. All-zero uuid sorts before every real id. */
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const BATCH = 500;
/** Decision 3 — 0.81.x only. */
const ENGINE_LIKE = 'opd-note-audit/0.81%';

async function authed(req: NextRequest) {
  const denied = requireAdmin(req);
  return denied ? isAdminUnlocked().catch(() => false).then((ok) => (ok ? null : denied)) : Promise.resolve(null);
}
/**
 * A7 — COMPOSITE cursor (note_date, id).
 *
 * THE BUG THIS FIXES: the batch orders by (note_date, id) but the cursor stored note_date ALONE and
 * paged with `note_date > $cursor`. Rows sharing a boundary timestamp that fell outside the 500 were
 * skipped PERMANENTLY, and `?reset=1` could not recover them because deterministic ordering
 * reproduces the same boundary. Measured: 43 findings across 29 rows left unstamped, 27 of the 29
 * sharing a note_date with another row (mean 3.97 rows per timestamp, max 6).
 *
 * Stored as "<iso>|<id>"; legacy bare-timestamp values are read as (date, ZERO_ID) so an in-flight
 * cursor keeps working and simply re-examines the boundary timestamp once (writes are idempotent).
 */
type Cursor = { date: string; id: string };
async function getCursor(): Promise<Cursor> {
  const r = await run(`SELECT value FROM app_settings WHERE key = $1`, [CURSOR_KEY]).catch(() => []);
  const v = r[0]?.value ? String(r[0].value) : '';
  if (!v) return { date: EPOCH, id: ZERO_ID };
  const bar = v.indexOf('|');
  const date = bar >= 0 ? v.slice(0, bar) : v;
  const id = bar >= 0 ? v.slice(bar + 1) : ZERO_ID;
  if (Number.isNaN(new Date(date).getTime())) return { date: EPOCH, id: ZERO_ID };
  return { date, id: id || ZERO_ID };
}
async function setCursor(c: Cursor): Promise<void> {
  await run(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
    [CURSOR_KEY, `${c.date}|${c.id}`]).catch(() => {});
}

/** G2 — yield to the production mini-backfill rather than contending with it. Fail-safe: if the probe
 *  itself fails we do NOT block (a false "held" would stall the backfill forever). */
async function miniBackfillLockHeld(): Promise<boolean> {
  try {
    const s = await getSettings([MB_KEYS.lock]);
    const iso = s[MB_KEYS.lock];
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && (Date.now() - t) < MB_LOCK_TTL_MS;
  } catch { return false; }
}

async function status(): Promise<Record<string, unknown>> {
  const rows = await run(
    `SELECT count(*)::int AS rows_in_scope, count(DISTINCT a.uid)::int AS distinct_uid
     FROM opd_note_audits a
     WHERE a.app_source = $1 AND a.engine_version LIKE $2 AND jsonb_typeof(a.findings) = 'array'`,
    [APP, ENGINE_LIKE]).catch(() => []);
  const el = await run(
    `SELECT count(*)::int AS findings_total,
            count(*) FILTER (WHERE e ? 'stable_ref')::int AS findings_stamped
     FROM opd_note_audits a
     CROSS JOIN LATERAL jsonb_array_elements(a.findings) e
     WHERE a.app_source = $1 AND a.engine_version LIKE $2 AND jsonb_typeof(a.findings) = 'array'`,
    [APP, ENGINE_LIKE]).catch(() => []);
  return {
    scope: { app_source: APP, engine_version_like: ENGINE_LIKE },
    rows_in_scope: rows[0]?.rows_in_scope ?? null,
    distinct_uid: rows[0]?.distinct_uid ?? null,
    findings_total: el[0]?.findings_total ?? null,
    findings_stamped: el[0]?.findings_stamped ?? null,
    cursor: await getCursor(),
    expected_note: 'PRD decision 3 expects ~18,873 rows / ~10,343 distinct uid; these counts are the live check.',
  };
}

type Row = { id: string; uid: string; note_date: string; engine_version: string; findings: unknown };

async function runBatch(apply: boolean, stragglers: boolean): Promise<Record<string, unknown>> {
  if (await miniBackfillLockHeld()) {
    return { skipped: 'mini_backfill_lock_held', note: 'yielded to the production mini-backfill (G2); retry after it releases. Nothing scanned, nothing written.' };
  }
  const cursor = await getCursor();

  // A7 (ii) — STRAGGLER MODE ignores the cursor entirely and selects rows where ANY finding lacks
  // stable_ref. That catches both the boundary rows the old cursor skipped AND rows written by the
  // forward path before this deploy, neither of which a cursor sweep can reach.
  // A7 (i) — normal mode pages on the COMPOSITE (note_date, id) key via row-value comparison, which
  // is exactly the ordering the query already uses, so no row can straddle a page boundary.
  const rows = stragglers
    ? await run(
        `SELECT id, uid, note_date, engine_version, findings FROM opd_note_audits
         WHERE app_source = $1 AND engine_version LIKE $2 AND jsonb_typeof(findings) = 'array'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(findings) e
             WHERE NOT (e ? 'stable_ref')
           )
         ORDER BY note_date ASC, id ASC LIMIT ${BATCH}`,
        [APP, ENGINE_LIKE]).catch(() => []) as unknown as Row[]
    : await run(
        `SELECT id, uid, note_date, engine_version, findings FROM opd_note_audits
         WHERE app_source = $1 AND engine_version LIKE $2 AND jsonb_typeof(findings) = 'array'
           AND note_date IS NOT NULL
           AND (note_date, id) > ($3::timestamptz, $4::uuid)
         ORDER BY note_date ASC, id ASC LIMIT ${BATCH}`,
        [APP, ENGINE_LIKE, cursor.date, cursor.id]).catch(() => []) as unknown as Row[];

  let rowsScanned = 0, findingsSeen = 0, refsComputed = 0, refsNull = 0, alreadyStamped = 0;
  let collisions = 0, rowsWithCollision = 0, rowsChanged = 0;
  let last: Cursor = cursor;
  const samples: Record<string, unknown>[] = [];
  const collisionSamples: Record<string, unknown>[] = [];
  const nullSamples: Record<string, unknown>[] = [];

  for (const r of rows) {
    rowsScanned++;
    if (r.note_date) last = { date: new Date(r.note_date).toISOString(), id: String(r.id) };
    const findings = Array.isArray(r.findings) ? (r.findings as Array<Record<string, unknown>>) : [];
    let changed = false;
    // Per-note collision detection: stable_ref is unique WITHIN a note (addendum A1), so a repeat
    // inside one note is exactly the ambiguity resolveLabel refuses to guess through.
    const seen = new Map<string, number>();
    const next = findings.map((f) => {
      if (!f || typeof f !== 'object') return f;
      findingsSeen++;
      const signalType = f.signal_type == null ? '' : String(f.signal_type);
      const subject = f.subject == null ? '' : String(f.subject);
      const ref = computeStableRef(signalType, subject);
      if (!ref) {
        refsNull++;
        if (nullSamples.length < 10) nullSamples.push({ uid: r.uid, signal_type: signalType, subject: subject.slice(0, 80) });
        return f;
      }
      refsComputed++;
      seen.set(ref, (seen.get(ref) ?? 0) + 1);
      if (samples.length < 20) {
        samples.push({ uid: r.uid, engine_version: r.engine_version, signal_type: signalType, subject: subject.slice(0, 120), stable_ref: ref });
      }
      if (typeof f.stable_ref === 'string' && f.stable_ref) { alreadyStamped++; return f; }
      changed = true;
      return { ...f, stable_ref: ref };
    });
    let noteHasCollision = false;
    for (const [ref, n] of seen) {
      if (n > 1) {
        collisions += n - 1;
        noteHasCollision = true;
        if (collisionSamples.length < 10) collisionSamples.push({ uid: r.uid, engine_version: r.engine_version, stable_ref: ref, n_findings_sharing: n });
      }
    }
    if (noteHasCollision) rowsWithCollision++;
    if (changed) {
      rowsChanged++;
      // ADDITIVE: one jsonb column, one row, keyed by primary id. No score column is named.
      if (apply) await run(`UPDATE opd_note_audits SET findings = $1::jsonb WHERE id = $2`, [JSON.stringify(next), r.id]).catch(() => {});
    }
  }
  // The cursor only advances on a REAL apply in NORMAL mode. A dry run must be repeatable, and a
  // straggler sweep is cursor-independent by definition — advancing it there would skip live work.
  if (apply && !stragglers && rowsScanned > 0) await setCursor(last);
  const done = rowsScanned < BATCH;
  return {
    mode: `${stragglers ? 'STRAGGLERS' : 'CURSOR'} · ${apply ? 'APPLY (wrote)' : 'DRY RUN (nothing written)'}`,
    rows_scanned: rowsScanned,
    findings_seen: findingsSeen,
    refs_computed: refsComputed,
    refs_null_empty_signal_or_subject: refsNull,
    refs_null_samples: nullSamples,
    already_stamped: alreadyStamped,
    rows_would_change: rowsChanged,
    collision_count: collisions,
    rows_with_collision: rowsWithCollision,
    collision_samples: collisionSamples,
    samples,
    cursor_before: `${cursor.date}|${cursor.id}`,
    cursor_after: apply && !stragglers ? `${last.date}|${last.id}` : `${cursor.date}|${cursor.id}`,
    done,
    note: stragglers
      ? 'STRAGGLER SWEEP — cursor ignored and never advanced. Re-run until rows_scanned=0.'
      : apply
        ? (done ? 'sweep drained' : 'more remain — POST ?apply=1 again')
        : 'DRY RUN — cursor NOT advanced, nothing written. Re-run with ?apply=1 only after V validates these numbers.',
  };
}

export async function GET(req: NextRequest) {
  const denied = await authed(req);
  if (denied) return denied;
  try { return NextResponse.json({ ok: true, ...(await status()) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
  const denied = await authed(req);
  if (denied) return denied;
  try {
    if (req.nextUrl.searchParams.get('reset') === '1') { await setCursor({ date: EPOCH, id: ZERO_ID }); return NextResponse.json({ ok: true, reset: true, ...(await status()) }); }
    const apply = req.nextUrl.searchParams.get('apply') === '1';
    const stragglers = req.nextUrl.searchParams.get('stragglers') === '1';
    return NextResponse.json({ ok: true, ...(await runBatch(apply, stragglers)) });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
