/**
 * GET /api/ot-audit/worker — land final OT notes into ot_note_audits (lander-first).
 *
 * Mirrors the OPD/IPD day-sweep shape: ?day=YYYY-MM-DD or lookback ending yesterday IST.
 * Deterministic v0 rubric (no LLM). Seeds ot_surgeon_map from the Surfer Y CSV JSON.
 * Does not mint Findings. Does not set TRIAGE_BOT_WRITE_CLASSES.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { countOtNotesForDay, fetchOtNotesForDay } from '@/lib/triage/ot-db13';
import { auditOtNote, OT_ENGINE_VERSION } from '@/lib/triage/ot-audit-core';
import {
  auditedOtUidsAnyVersion,
  backfillOtNabhScores,
  ensureOtAuditTables,
  saveOtAudit,
  seedOtSurgeonMapFromFile,
  loadOtSurgeonMap,
} from '@/lib/triage/ot-audit-store';
import { OT_NABH_ENGINE_VERSION } from '@/lib/triage/ot-nabh';
import { resolveOtSurgeon } from '@/lib/triage/ot-surgeon-map';

async function authed(req: NextRequest): Promise<boolean> {
  const isCron = req.headers.get('x-vercel-cron') !== null;
  const auth = req.headers.get('authorization') || '';
  const bearerOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secret = req.nextUrl.searchParams.get('secret');
  const secretOk = !!process.env.CRON_SECRET && !!secret && secret === process.env.CRON_SECRET;
  if (isCron || bearerOk || secretOk) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function istYesterday(): string {
  return new Date(Date.now() + 5.5 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
}

async function processDay(day: string, max: number, map: Map<string, string>) {
  const total = await countOtNotesForDay(day);
  const already = await auditedOtUidsAnyVersion();
  const notes = await fetchOtNotesForDay(day, already, max);
  if (!notes.length) {
    return { day, total, processed: 0, inserted: 0, exists: 0, mapped: 0, unmapped: 0, multi: 0, done: true, results: [] as unknown[] };
  }

  const results: Record<string, unknown>[] = [];
  let inserted = 0;
  let exists = 0;
  let mapped = 0;
  let unmapped = 0;
  let multi = 0;

  for (const note of notes) {
    const hop = resolveOtSurgeon(note.surgeon, map);
    if (hop.map_status === 'mapped') mapped += 1;
    else if (hop.map_status === 'multi_surgeon_hold') multi += 1;
    else unmapped += 1;

    const findings = auditOtNote({
      note: note.note,
      surgery_name: note.surgery_name,
      surgeon: note.surgeon,
    });
    const saved = await saveOtAudit({
      source: note,
      doctor_uid: hop.doctor_uid,
      map_status: hop.map_status,
      findings,
      engine_version: OT_ENGINE_VERSION,
      model: 'ot-rule/0.1',
    });
    if (saved.status === 'inserted') inserted += 1;
    else exists += 1;
    results.push({
      uid: note.uid,
      status: saved.status,
      id: saved.id ?? null,
      map_status: hop.map_status,
      doctor_uid: hop.doctor_uid,
      n_findings: findings.length,
      nabh_score_pct: saved.nabh_score_pct ?? null,
      nabh_engine_version: OT_NABH_ENGINE_VERSION,
    });
  }

  const still = await fetchOtNotesForDay(day, await auditedOtUidsAnyVersion(), 1);
  return {
    day, total, processed: results.length, inserted, exists, mapped, unmapped, multi,
    done: still.length === 0, results,
  };
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  await ensureOtAuditTables();
  const seed = await seedOtSurgeonMapFromFile();
  const map = await loadOtSurgeonMap();

  const p = req.nextUrl.searchParams;
  const max = Math.max(1, Math.min(50, Number(p.get('max')) || 10));
  const lookback = Math.max(1, Math.min(14, Number(p.get('lookback')) || 3));
  const dayParam = (p.get('day') || '').trim();

  const nabh = await backfillOtNabhScores(200);

  if (/^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
    const batch = await processDay(dayParam, max, map);
    return NextResponse.json({
      ok: true,
      engine: OT_ENGINE_VERSION,
      nabh_engine: OT_NABH_ENGINE_VERSION,
      note_class: 'ot',
      seed,
      map_size: map.size,
      mode: 'day',
      nabh_backfill: nabh,
      ...batch,
      write_mint: 'blocked — ot absent from TRIAGE_BOT_WRITE_CLASSES',
    });
  }

  const end = istYesterday();
  const days: string[] = [];
  for (let i = lookback - 1; i >= 0; i--) days.push(addDays(end, -i));

  const batches = [];
  for (const day of days) {
    const batch = await processDay(day, max, map);
    batches.push(batch);
    if (!batch.done && batch.processed > 0) break;
  }

  return NextResponse.json({
    ok: true,
    engine: OT_ENGINE_VERSION,
    nabh_engine: OT_NABH_ENGINE_VERSION,
    note_class: 'ot',
    seed,
    map_size: map.size,
    mode: 'sweep',
    lookback,
    window: { from: days[0], to: end },
    nabh_backfill: nabh,
    batches,
    write_mint: 'blocked — ot absent from TRIAGE_BOT_WRITE_CLASSES',
  });
}
