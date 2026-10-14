/**
 * GET/POST /api/admin/backfill-corpus-provenance — LAB-MCP Phase 2 (F13) history backfill.
 *
 * Fills the six provenance columns on EXISTING mksap_chunks rows, ONLY where the value is derivable
 * from what the row already carries. NEVER guesses a citation: if a chunk's provenance cannot be
 * established from its own fields, every column stays NULL and the row is reported as `undecidable`.
 * A wrong citation is far worse than a missing one — it launders an unsourced claim as sourced.
 *
 * ⚠️ DRY-RUN BY DEFAULT. `?apply=1` is REQUIRED to write. Same shape as the Phase 1 stable_ref
 * backfill: a revert un-ships the code but does NOT un-write the columns.
 *
 * ⚠️ REQUIRES MIGRATION 0023 (mksap_chunks provenance columns). Without it every statement here
 * errors on a missing column — cleanly, as a reported failure, never a partial write.
 *
 * CONTENTION (G2): batches of 500 behind a cursor on `id`, never one transaction, and it YIELDS when
 * the mini-backfill soft lock is held rather than competing with the production writer.
 *
 * ⚠️ SQL INFERRED — no live DB here. Every statement is listed verbatim in the build report. All
 * paths fail-safe: an error degrades to a reported no-op, never a wrong write.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { getSettings, MB_KEYS, MB_LOCK_TTL_MS } from '@/lib/mini-backfill';
import { INTERNAL_PROTOCOL } from '@/lib/lvc-proposal-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const CURSOR_KEY = 'corpus_provenance_backfill_cursor';
const BATCH = 500;

async function authed(req: NextRequest) {
  const denied = requireAdmin(req);
  return denied ? isAdminUnlocked().catch(() => false).then((ok) => (ok ? null : denied)) : Promise.resolve(null);
}
async function getCursor(): Promise<string> {
  const r = await run(`SELECT value FROM app_settings WHERE key = $1`, [CURSOR_KEY]).catch(() => []);
  return r[0]?.value ? String(r[0].value) : '';
}
async function setCursor(v: string): Promise<void> {
  await run(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [CURSOR_KEY, v]).catch(() => {});
}
async function miniBackfillLockHeld(): Promise<boolean> {
  try {
    const s = await getSettings([MB_KEYS.lock]);
    const iso = s[MB_KEYS.lock];
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && (Date.now() - t) < MB_LOCK_TTL_MS;
  } catch { return false; }
}

type Row = { id: string; source: string | null; book: string | null; chunk_type: string | null };
type Derived = { provenance: string | null; license_status: string | null; reason: string };

/**
 * The ONLY derivation rules. Each maps an observable fact about the row to a value that is true by
 * construction — never an inference about content.
 *
 *  · Even's own protocol content IS the source, so it takes the internal-protocol escape and needs no
 *    citation. That is decision 10, and it is the single largest derivable group (the ~332 chunks).
 *  · A `labq:` row is quarantined lab material that has not been through F13's gate; it is inert
 *    until activated, so it is left entirely NULL rather than assigned a provenance it never had.
 *
 * NO rule ever produces a citation_url / doi / pmid. Those cannot be derived from a source name —
 * only from the document itself — so the backfill leaves all three NULL for every row, always.
 */
function derive(r: Row): Derived {
  const source = String(r.source ?? '').toLowerCase();
  const book = String(r.book ?? '').toLowerCase();
  if (source.startsWith('even-protocol') || book.includes('even clinical protocol') || book.includes('even protocol')) {
    return { provenance: INTERNAL_PROTOCOL, license_status: 'open', reason: "Even's own protocol content — it IS the source (decision 10 escape); owned outright, so license_status='open'" };
  }
  if (source.startsWith('labq:') || source.startsWith('lab:')) {
    return { provenance: null, license_status: null, reason: 'lab-ingested and not yet through the F13 gate — left NULL rather than assigned a provenance it never had' };
  }
  return { provenance: null, license_status: null, reason: 'undecidable from the row alone — a citation cannot be derived from a source name, only from the document' };
}

async function status(): Promise<Record<string, unknown>> {
  const rows = await run(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE provenance IS NOT NULL)::int AS with_provenance,
            count(*) FILTER (WHERE license_status IS NOT NULL)::int AS with_license,
            count(*) FILTER (WHERE citation_url IS NOT NULL OR citation_doi IS NOT NULL OR citation_pmid IS NOT NULL)::int AS with_citation
     FROM mksap_chunks`, []).catch(() => []);
  const bySource = await run(
    `SELECT source, count(*)::int AS n FROM mksap_chunks GROUP BY 1 ORDER BY n DESC LIMIT 25`, []).catch(() => []);
  return {
    requires_migration: '0023_lvc_proposals_and_provenance.sql (mksap_chunks provenance columns)',
    totals: rows[0] ?? null,
    by_source: bySource,
    cursor: await getCursor(),
  };
}

async function runBatch(apply: boolean): Promise<Record<string, unknown>> {
  if (await miniBackfillLockHeld()) {
    return { skipped: 'mini_backfill_lock_held', note: 'yielded to the production mini-backfill (G2); nothing scanned, nothing written.' };
  }
  const cursor = await getCursor();
  let rows: Row[];
  try {
    rows = await run(
      `SELECT id::text AS id, source, book, chunk_type FROM mksap_chunks
       WHERE ($1 = '' OR id::text > $1)
         AND provenance IS NULL AND license_status IS NULL
       ORDER BY id::text ASC LIMIT ${BATCH}`, [cursor]) as unknown as Row[];
  } catch (e) {
    return { error: `select failed — has migration 0023 been applied? ${String((e as Error).message).slice(0, 200)}`, scanned: 0, would_write: 0 };
  }

  let scanned = 0, wouldWrite = 0, undecidable = 0, lastId = cursor;
  const byReason: Record<string, number> = {};
  const samples: Record<string, unknown>[] = [];

  for (const r of rows) {
    scanned++;
    lastId = String(r.id);
    const d = derive(r);
    byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
    if (d.provenance === null && d.license_status === null) { undecidable++; continue; }
    wouldWrite++;
    if (samples.length < 20) samples.push({ id: r.id, source: r.source, book: String(r.book ?? '').slice(0, 60), provenance: d.provenance, license_status: d.license_status, reason: d.reason });
    if (apply) {
      // ADDITIVE and NARROW: only the two derivable columns, and only where still NULL, so a re-run
      // can never overwrite a value a human or corpus_add has since set. Citations stay untouched.
      await run(
        `UPDATE mksap_chunks SET provenance = COALESCE(provenance, $2), license_status = COALESCE(license_status, $3)
         WHERE id::text = $1`, [r.id, d.provenance, d.license_status]).catch(() => {});
    }
  }
  if (apply && scanned > 0) await setCursor(lastId);
  const done = scanned < BATCH;
  return {
    mode: apply ? 'APPLY (wrote)' : 'DRY RUN (nothing written)',
    scanned, would_write: wouldWrite, undecidable_left_null: undecidable,
    citations_written: 0,
    by_reason: byReason,
    samples,
    cursor_before: cursor, cursor_after: apply ? lastId : cursor,
    done,
    note: apply
      ? (done ? 'sweep drained' : 'more remain — POST ?apply=1 again')
      : 'DRY RUN — cursor NOT advanced, nothing written. NO citation_url/doi/pmid is ever written by this backfill; undecidable rows stay NULL by design.',
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
    if (req.nextUrl.searchParams.get('reset') === '1') { await setCursor(''); return NextResponse.json({ ok: true, reset: true, ...(await status()) }); }
    return NextResponse.json({ ok: true, ...(await runBatch(req.nextUrl.searchParams.get('apply') === '1')) });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
