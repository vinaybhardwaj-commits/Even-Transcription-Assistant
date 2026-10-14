import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import FORMULARY from '@/data/formulary-2026.json';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface Row {
  item_code: string; brand: string; generic: string; generic_canon: string; form: string;
  major: string; minor: string; manufacturer: string; schedule_dc: string; schedule_ip: string;
  dept1: string; dept2: string; high_risk: boolean; lasa: string; ved: string;
  audit_category: string; restricted: boolean;
}

// Bulk-loads the EHRC Pharmacy Formulary 2026 into `formulary`.
// Idempotent: no-op if already populated unless ?reset=1 is passed.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const reset = req.nextUrl.searchParams.get('reset') === '1';
  try {
    const rows = FORMULARY as unknown as Row[];
    const existing = (await sql`SELECT COUNT(*)::int AS n FROM formulary`) as { n: number }[];
    if (existing[0].n > 0 && !reset) {
      return NextResponse.json({ ok: true, skipped: true, existing: existing[0].n, hint: 'pass ?reset=1 to reseed' });
    }
    if (reset) await sql`TRUNCATE formulary RESTART IDENTITY CASCADE`;

    const B = 400;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += B) {
      const c = rows.slice(i, i + B);
      await sql`
        INSERT INTO formulary
          (item_code, brand, generic, generic_canon, dosage_form, major_grouping, minor_grouping,
           manufacturer, schedule_dc, schedule_ip, dept_primary, dept_secondary, high_risk, lasa, ved,
           audit_category, restricted)
        SELECT * FROM UNNEST(
          ${c.map((r) => r.item_code)}::text[], ${c.map((r) => r.brand)}::text[],
          ${c.map((r) => r.generic)}::text[], ${c.map((r) => r.generic_canon)}::text[],
          ${c.map((r) => r.form)}::text[], ${c.map((r) => r.major)}::text[],
          ${c.map((r) => r.minor)}::text[], ${c.map((r) => r.manufacturer)}::text[],
          ${c.map((r) => r.schedule_dc)}::text[], ${c.map((r) => r.schedule_ip)}::text[],
          ${c.map((r) => r.dept1)}::text[], ${c.map((r) => r.dept2)}::text[],
          ${c.map((r) => !!r.high_risk)}::boolean[], ${c.map((r) => r.lasa)}::text[],
          ${c.map((r) => r.ved)}::text[], ${c.map((r) => r.audit_category)}::text[],
          ${c.map((r) => !!r.restricted)}::boolean[]
        )`;
      inserted += c.length;
    }
    return NextResponse.json({ ok: true, inserted });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
