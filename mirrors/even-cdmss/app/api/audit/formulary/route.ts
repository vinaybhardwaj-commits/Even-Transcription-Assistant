import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { auditAccessAllowed } from '@/lib/pharmacist-cookie';

export const runtime = 'nodejs';

// Returns formulary options for the audit picker: deduped to canonical generic,
// grouped by audit_category, with reserve/high-alert/schedule/VED/LASA flags.
export async function GET() {
  if (!(await auditAccessAllowed())) {
    return NextResponse.json({ error: 'pharmacist auth required' }, { status: 401 });
  }
  try {
    const rows = (await sql`
      SELECT audit_category AS bucket, generic_canon AS n,
             (array_agg(dosage_form ORDER BY dosage_form))[1] AS d,
             bool_or(restricted) AS restricted, bool_or(high_risk) AS high_risk,
             max(lasa) AS lasa, max(ved) AS ved, max(schedule_dc) AS sch
      FROM formulary
      WHERE generic_canon <> ''
      GROUP BY audit_category, generic_canon
      ORDER BY n`) as Array<{
        bucket: string; n: string; d: string | null; restricted: boolean;
        high_risk: boolean; lasa: string | null; ved: string | null; sch: string | null;
      }>;

    const opt = (r: typeof rows[number]) => ({
      n: r.n, d: r.d || '', restricted: !!r.restricted, highRisk: !!r.high_risk,
      lasa: r.lasa || '', ved: r.ved || '', sch: r.sch || '', bucket: r.bucket,
    });
    const DATA: Record<string, ReturnType<typeof opt>[]> = {};
    const ALL: ReturnType<typeof opt>[] = [];
    for (const r of rows) {
      const o = opt(r);
      ALL.push(o);
      if (r.bucket && r.bucket !== 'other') (DATA[r.bucket] ||= []).push(o);
    }
    // reserve agents first within each antibiotic list, else alphabetical
    for (const k of Object.keys(DATA)) {
      DATA[k].sort((a, b) => (Number(b.restricted) - Number(a.restricted)) || a.n.localeCompare(b.n));
    }
    ALL.sort((a, b) => a.n.localeCompare(b.n));
    return NextResponse.json({ DATA, ALL });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
