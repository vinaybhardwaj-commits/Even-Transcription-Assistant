export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { auditOpdNote } from '@/lib/opd-note-audit';
import { updateOpdAudit } from '@/lib/opd-audit-store';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { fetchOpdNotesByUids } from '@/lib/metabase';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import type { OpdFinding, OpdSuggestion } from '@/lib/opd-note-audit-core';
import type { Source } from '@/lib/citations-core';
import type { Pdqi9Attr } from '@/lib/opd-note-score-core';

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
const DOSING = 'Complete medication dosing';

/** Reconstruct the computeOpdScore pdqi9 OBJECT ({attr:value}) from the STORED rows-array form. */
function pdqi9ObjFromStored(v: unknown): Partial<Record<Pdqi9Attr, number>> | null {
  const rows = asArr(v);
  if (!rows.length) return null;
  const o: Partial<Record<Pdqi9Attr, number>> = {};
  for (const r of rows) {
    const rr = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const attr = String(rr.attr || '') as Pdqi9Attr;
    const val = Number(rr.value);
    if (attr && Number.isFinite(val)) o[attr] = val;
  }
  return Object.keys(o).length ? o : null;
}

/**
 * OPD dosing-completeness deterministic BACKFILL (admin). DARK behind nothing (admin/token/cron auth).
 *   GET /api/admin/opd-dosing-backfill[?limit=800][&apply=1]
 *     Recomputes the deterministic half of each stored audit (completeness + prescribing findings)
 *     under the current code — KEEPING the stored LLM findings + PDQI-9 (no retrieval, no LLM) — and
 *     reports how the "incomplete medication dosing" picture changes. ?apply=1 writes the refreshed
 *     rows in place. Read-only unless ?apply=1.
 */
export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const apply = p.get('apply') === '1';
  const limit = Math.max(1, Math.min(3000, Number(p.get('limit') || 800)));
  // Phase 3a / A-8 — the SOURCE engine version to re-score IN PLACE. Absent ⇒ OPD_ENGINE_VERSION,
  // so existing behaviour is byte-identical. FAIL-SAFE by construction: the value is only ever a
  // bound parameter, so an unknown version selects ZERO rows and returns an empty report — never a
  // throw, and never a write to some other version's rows.
  const sourceEngine = (p.get('engine') || '').trim() || OPD_ENGINE_VERSION;

  let rows: Record<string, unknown>[];
  try {
    rows = await run(
      `SELECT uid, findings, pdqi9, suggestions, sources, missing_fields, completeness_pct
       FROM opd_note_audits WHERE engine_version = $1 ORDER BY note_date DESC LIMIT ${limit}`,
      [sourceEngine],
    );
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }

  const byUid = new Map<string, Record<string, unknown>>();
  for (const r of rows) { const u = String(r.uid || ''); if (u) byUid.set(u, r); }
  const uids = Array.from(byUid.keys());

  // Bulk-fetch the source notes (chunked) so we recompute from the same content the audit saw.
  const notes = new Map<string, Record<string, unknown>>();
  for (const grp of chunk(uids, 40)) {
    try {
      const fetched = await fetchOpdNotesByUids(grp);
      for (const n of fetched) { const u = String(n.uid || ''); if (u) notes.set(u, n); }
    } catch { /* skip a bad chunk; those rows are counted as not-fetched */ }
  }

  let considered = 0, notFetched = 0, changed = 0, applied = 0;
  let oldDosingFlagged = 0, newDosingFlagged = 0;
  const sample: { uid: string; old_pct: number | null; new_pct: number; dosing: string }[] = [];

  for (const uid of uids) {
    const stored = byUid.get(uid)!;
    const note = notes.get(uid);
    if (!note) { notFetched++; continue; }
    considered++;

    const llmFindings = (asArr(stored.findings) as OpdFinding[]).filter((f) => f && f.source === 'llm');
    const reuse = {
      llmFindings,
      pdqi9: pdqi9ObjFromStored(stored.pdqi9),
      suggestions: asArr(stored.suggestions) as OpdSuggestion[],
      sources: asArr(stored.sources) as Source[],
    };

    let audit;
    // engineVersion threads the SOURCE version through to updateOpdAudit's WHERE clause (A-8).
    try { audit = await auditOpdNote(note, { trace: false, reuse, engineVersion: sourceEngine }); }
    catch { notFetched++; considered--; continue; }

    const oldFlag = (asArr(stored.missing_fields) as string[]).includes(DOSING);
    const newFlag = audit.completeness.missing.includes(DOSING);
    if (oldFlag) oldDosingFlagged++;
    if (newFlag) newDosingFlagged++;

    const oldPct = stored.completeness_pct == null ? null : Number(stored.completeness_pct);
    const newPct = Math.round(audit.completeness.coverage * 100);
    const rowChanged = oldFlag !== newFlag || oldPct !== newPct;
    if (rowChanged) {
      changed++;
      if (sample.length < 20) sample.push({ uid, old_pct: oldPct, new_pct: newPct, dosing: `${oldFlag ? 'flagged' : 'ok'} → ${newFlag ? 'flagged' : 'ok'}` });
    }

    if (apply) { try { if ((await updateOpdAudit(audit)) === 'updated') applied++; } catch { /* continue */ } }
  }

  const pct = (n: number) => (considered ? Math.round((n / considered) * 1000) / 10 : 0);
  return NextResponse.json({
    ok: true,
    engine_version: sourceEngine,
    stored_rows: rows.length,
    considered,
    not_fetched: notFetched,
    dosing_flagged: {
      old: { count: oldDosingFlagged, pct: pct(oldDosingFlagged) },
      new: { count: newDosingFlagged, pct: pct(newDosingFlagged) },
    },
    rows_changed: changed,
    applied,
    dry_run: !apply,
    sample_changed: sample,
  });
}
