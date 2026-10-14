export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { fetchOpdNoteByUid, fetchOpdNotesByUids } from '@/lib/metabase';
import { rowToOpdCase, opdCaseText } from '@/lib/opd-ingest-core';
import { enrichOpdMeds } from '@/lib/formulary';
import { buildLongitudinalInput } from '@/lib/opd-longitudinal-core';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { replayLongitudinal } from '@/lib/opd-longitudinal';

// Stage 3 replay (PRD §6, D3 forward-only + paced): recompute + store ONLY the `longitudinal` column for
// already-audited notes — the base audit is NEVER re-run or touched. Two modes:
//   ?uid=<note uid>        → one note (the audited prescription uid).
//   ?doctor_uid=<uid>      → a bounded batch (≤50) of that doctor's most-recent audited notes, run
//                            SEQUENTIALLY with ~1s pacing (db13 contention rule).
// Auth: Vercel Cron / Bearer CRON_SECRET / ?secret= / a logged-in admin session.
//
// SQL honesty: note content is re-fetched via the EXISTING db13 helpers (fetchOpdNoteByUid /
// fetchOpdNotesByUids) — NO new db13 query. The only own-DB read here is the doctor→note-uid lookup
// against opd_note_audits (own table). Member/lab reads stay inside getMemberSnapshotAsOf (frozen SQL).
async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP = process.env.APP_SOURCE || 'standalone';
const AUTO_LIMIT = 30;   // notes per tick — paced ~1s each, comfortably inside maxDuration=300

// Part D (0.81.8) — the idempotent, data-derived cron sweep. Picks the ONE most-blocked active-30-day doctor
// and replays their longitudinal-NULL notes (reusing the frozen 1s-paced replayLongitudinal); `{done:true}`
// when nothing is left. No cursor table (the NULL column IS the queue), no browser/thread loop. Fail-safe:
// ANY error degrades to `{done:true}` — a cron tick never 500s and never re-sweeps blindly.
//
// ⚠️ SQL INFERRED (no live DB here). Selection SQL is verbatim from the PRD; the remaining-count wrapper
// mirrors it. Both fail-safe.
async function autoSweep() {
  try {
    const today = new Date().toISOString().slice(0, 10);   // IST-agnostic anchor; the SQL localises to Asia/Kolkata
    const sel = (await sql(
      `SELECT doctor_uid, count(*) FILTER (WHERE longitudinal IS NULL) AS unblocked
       FROM opd_note_audits
       WHERE app_source = $1 AND engine_version = $2
         AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= ($3::date - 30)
         AND doctor_uid IS NOT NULL
       GROUP BY doctor_uid HAVING count(*) FILTER (WHERE longitudinal IS NULL) > 0
       ORDER BY unblocked DESC LIMIT 1`,
      [APP, OPD_ENGINE_VERSION, today],
    )) as Array<{ doctor_uid: string; unblocked: number }>;
    if (!sel.length) return NextResponse.json({ ok: true, mode: 'auto', done: true });

    const doctorUid = String(sel[0].doctor_uid);
    const nullRows = (await sql(
      `SELECT uid FROM opd_note_audits
       WHERE app_source = $1 AND engine_version = $2 AND longitudinal IS NULL AND doctor_uid = $3 AND uid IS NOT NULL
         AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= ($4::date - 30)
       ORDER BY note_date DESC LIMIT $5`,
      [APP, OPD_ENGINE_VERSION, doctorUid, today, AUTO_LIMIT],
    )) as Array<{ uid: string }>;
    const uids = nullRows.map((r) => r.uid).filter(Boolean);
    const noteRows = await fetchOpdNotesByUids(uids);
    const byUid = new Map(noteRows.map((r) => [String((r as Record<string, unknown>).uid || ''), r]));

    let processed = 0;
    for (const u of uids) {
      const row = byUid.get(u);
      if (!row) continue;                                  // dropped from db13 → skip (stays NULL, retried next tick)
      try {
        const input = inputFor(row);
        if (input) { await replayLongitudinal(input); processed++; }
      } catch { /* one bad note never stalls the sweep */ }
      await sleep(1000);                                   // db13 contention rule — pace the batch
    }

    const rem = (await sql(
      `SELECT count(*)::int AS n FROM (
         SELECT doctor_uid FROM opd_note_audits
         WHERE app_source = $1 AND engine_version = $2
           AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= ($3::date - 30) AND doctor_uid IS NOT NULL
         GROUP BY doctor_uid HAVING count(*) FILTER (WHERE longitudinal IS NULL) > 0
       ) t`,
      [APP, OPD_ENGINE_VERSION, today],
    ).catch(() => [{ n: 0 }])) as Array<{ n: number }>;
    const remaining_doctors = Number(rem[0]?.n || 0);
    return NextResponse.json({ ok: true, mode: 'auto', doctor_uid: doctorUid, processed, remaining_doctors, done: remaining_doctors === 0 });
  } catch (e) {
    // Fail-safe: never 500 a cron tick; report done so the scheduler simply waits for the next window.
    return NextResponse.json({ ok: true, mode: 'auto', done: true, error: String((e as Error).message) });
  }
}

/** Rebuild the de-identified longitudinal input for a db13 note row (no base LLM — projection only). */
function inputFor(row: Record<string, unknown>) {
  const { case: oc, keys } = rowToOpdCase(row);
  enrichOpdMeds(oc.medications);   // brand→generic parity with the production audit
  return buildLongitudinalInput(oc, keys, OPD_ENGINE_VERSION, opdCaseText(oc, { specialty: null }));
}

// Vercel Cron issues a GET — this is the Part-D auto-sweep entry point (flag-gated + authed, then drains).
export async function GET(req: NextRequest) {
  if (process.env.OPD_LONGITUDINAL_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return autoSweep();
}

export async function POST(req: NextRequest) {
  if (process.env.OPD_LONGITUDINAL_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const p = req.nextUrl.searchParams;
  if (p.get('auto') === '1') return autoSweep();           // Part D — manual trigger of the same sweep
  const uid = (p.get('uid') || '').trim();
  const doctorUid = (p.get('doctor_uid') || '').trim();

  try {
    // Single-note mode.
    if (uid) {
      if (!isUid(uid)) return NextResponse.json({ error: 'bad uid' }, { status: 400 });
      const row = await fetchOpdNoteByUid(uid);
      if (!row) return NextResponse.json({ ok: false, error: 'note not found in db13' }, { status: 404 });
      const input = inputFor(row);
      if (!input) return NextResponse.json({ ok: false, error: 'note missing uid/date — cannot anchor as-of' }, { status: 422 });
      const r = await replayLongitudinal(input);
      return NextResponse.json({ ok: true, mode: 'uid', result: r });
    }

    // Doctor batch mode (bounded ≤50, sequential, paced).
    if (doctorUid) {
      if (!isUid(doctorUid)) return NextResponse.json({ error: 'bad doctor_uid' }, { status: 400 });
      const limit = Math.max(1, Math.min(50, Number(p.get('limit') || 50)));
      const auditRows = (await sql(
        `SELECT uid FROM opd_note_audits WHERE doctor_uid = $1 AND engine_version = $2 AND uid IS NOT NULL
         ORDER BY note_date DESC LIMIT $3`,
        [doctorUid, OPD_ENGINE_VERSION, limit],
      )) as Array<{ uid: string }>;
      const uids = auditRows.map((r) => r.uid).filter(Boolean);
      const noteRows = await fetchOpdNotesByUids(uids);
      const byUid = new Map(noteRows.map((r) => [String((r as Record<string, unknown>).uid || ''), r]));

      const results: unknown[] = [];
      for (const u of uids) {
        const row = byUid.get(u);
        if (!row) { results.push({ uid: u, error: 'note not found in db13' }); continue; }
        try {
          const input = inputFor(row);
          if (!input) { results.push({ uid: u, error: 'missing uid/date' }); continue; }
          results.push(await replayLongitudinal(input));
        } catch (e) {
          results.push({ uid: u, error: String((e as Error).message) });
        }
        await sleep(1000);   // db13 contention rule — pace the batch
      }
      return NextResponse.json({ ok: true, mode: 'doctor', doctor_uid: doctorUid, count: uids.length, results });
    }

    return NextResponse.json({ error: 'pass ?uid=<note uid> or ?doctor_uid=<doctor uid>' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
