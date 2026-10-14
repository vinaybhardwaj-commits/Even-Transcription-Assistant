export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { fetchDoctorSpecialities } from '@/lib/metabase';

// Sync the doctor_uid → speciality directory from db13 (via the existing Metabase client) so the
// stewardship view has a real department dimension (the source consult_type is blank). Creates the
// table if missing — one-click, cookie-auth. Read-only against db13; writes only doctor_directory
// in Neon (staff data, not PHI). Auth: Vercel Cron header, OR Bearer/?secret=CRON_SECRET, OR admin.
const APP = process.env.APP_SOURCE || 'standalone';
const sql2 = sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>;

async function authed(req: NextRequest): Promise<boolean> {
  if (req.headers.get('x-vercel-cron') !== null) return true;
  const auth = req.headers.get('authorization') || '';
  const secret = new URL(req.url).searchParams.get('secret');
  if (process.env.CRON_SECRET && (auth === `Bearer ${process.env.CRON_SECRET}` || secret === process.env.CRON_SECRET)) return true;
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS doctor_directory (
      doctor_uid TEXT PRIMARY KEY,
      doctor_name TEXT,
      speciality TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    const rows = await sql2(`SELECT DISTINCT doctor_uid FROM opd_note_audits WHERE app_source = $1 AND doctor_uid IS NOT NULL`, [APP]);
    const uids = rows.map((r) => String(r.doctor_uid)).filter(Boolean);
    const map = await fetchDoctorSpecialities(uids);
    let upserted = 0;
    for (const [uid, v] of Object.entries(map)) {
      await sql`
        INSERT INTO doctor_directory (doctor_uid, doctor_name, speciality, updated_at)
        VALUES (${uid}, ${v.name}, ${v.speciality}, NOW())
        ON CONFLICT (doctor_uid) DO UPDATE SET
          doctor_name = EXCLUDED.doctor_name, speciality = EXCLUDED.speciality, updated_at = NOW()`;
      upserted++;
    }
    return NextResponse.json({ ok: true, audit_doctors: uids.length, resolved: Object.keys(map).length, upserted });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
