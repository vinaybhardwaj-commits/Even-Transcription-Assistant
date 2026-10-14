export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchOpdNotesByUids } from '@/lib/metabase';
import { rowToOpdCase } from '@/lib/opd-ingest-core';
import { opdCompleteness } from '@/lib/opd-note-audit-core';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

function authed(req: NextRequest): boolean {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  return isCron || bearerOk || secretOk;
}

// No-LLM backfill of `missing_fields` (+ refreshed completeness) for already-audited rows.
// Recomputes the deterministic NABH-OPD completeness from the live note in db13 — cheap,
// so it can do a big batch per invocation. Resumable: targets rows where missing_fields IS NULL.
// ?max (default 150, ≤400) · ?day=YYYY-MM-DD (optional filter).
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const max = Math.max(1, Math.min(400, Number(p.get('max') || 150)));
  const day = p.get('day');
  const dayOk = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;

  try {
    const dayClause = dayOk ? ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date` : '';
    const params: unknown[] = dayOk ? [APP, dayOk, max] : [APP, max];
    const limIdx = dayOk ? '$3' : '$2';
    const pending = (await run(
      `SELECT id, uid FROM opd_note_audits
       WHERE app_source = $1 AND missing_fields IS NULL AND uid IS NOT NULL${dayClause}
       ORDER BY note_date DESC LIMIT ${limIdx}`, params,
    )) as Array<{ id: string; uid: string }>;

    if (pending.length === 0) {
      const left = (await run(`SELECT count(*)::int n FROM opd_note_audits WHERE app_source = $1 AND missing_fields IS NULL`, [APP])) as Array<{ n: number }>;
      return NextResponse.json({ ok: true, processed: 0, remaining: Number(left[0]?.n ?? 0), done: true });
    }

    const notes = await fetchOpdNotesByUids(pending.map((r) => r.uid));
    const byUid = new Map<string, Record<string, unknown>>();
    for (const nrow of notes) byUid.set(String(nrow.uid), nrow);

    let updated = 0, missingNote = 0;
    for (const row of pending) {
      const nrow = byUid.get(row.uid);
      if (!nrow) { missingNote++; continue; }
      const { case: c } = rowToOpdCase(nrow);
      const comp = opdCompleteness(c);
      await run(
        `UPDATE opd_note_audits SET missing_fields = $1::jsonb, completeness_pct = $2, n_missing_mandatory = $3 WHERE id = $4`,
        [JSON.stringify(comp.missing), Math.round(comp.coverage * 100), comp.missing.length, row.id],
      );
      updated++;
    }

    const left = (await run(`SELECT count(*)::int n FROM opd_note_audits WHERE app_source = $1 AND missing_fields IS NULL`, [APP])) as Array<{ n: number }>;
    const remaining = Number(left[0]?.n ?? 0);
    return NextResponse.json({ ok: true, processed: pending.length, updated, missingNote, remaining, done: remaining === 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
