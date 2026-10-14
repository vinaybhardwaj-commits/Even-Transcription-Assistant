import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auditAccessAllowed } from '@/lib/pharmacist-cookie';
import { auditInteractions, mergeRank, type DrugClass } from '@/lib/ddi';
import { referenceInteractions } from '@/lib/ddi-reference';
import { logDdiQuery } from '@/lib/ddi-log';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Deterministic DDI for the audit surface: EHRC class rules + curated rules +
// RxLabelGuard. Each drug is resolved to its formulary class so pharmacodynamic
// duplications (e.g. two anticoagulants) are caught even when no named pair or
// FDA label covers them. Auto-feeds parameter #12. Fast synchronous JSON.
export async function POST(req: NextRequest) {
  if (!(await auditAccessAllowed())) {
    return NextResponse.json({ error: 'pharmacist auth required' }, { status: 401 });
  }
  let body: { drugs?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const drugs = (body.drugs || []).map((s) => (s || '').trim()).filter(Boolean);
  if (drugs.length < 2) return NextResponse.json({ pairs: [] });
  if (drugs.length > 25) return NextResponse.json({ error: 'too many drugs (max 25)' }, { status: 400 });

  try {
    // Resolve each drug name to its EHRC formulary class (for class-based rules).
    let items: DrugClass[];
    try {
      const rows = (await sql`
        SELECT generic_canon, major_grouping, minor_grouping
        FROM formulary
        WHERE lower(generic_canon) = ANY(${drugs.map((d) => d.toLowerCase())}::text[])
      `) as Array<{ generic_canon: string; major_grouping: string | null; minor_grouping: string | null }>;
      items = drugs.map((n) => {
        const r = rows.find((x) => (x.generic_canon || '').toLowerCase() === n.toLowerCase());
        return { name: n, major: r?.major_grouping || '', minor: r?.minor_grouping || '' };
      });
    } catch {
      // If the lookup fails, still run curated + RxLabelGuard with empty classes.
      items = drugs.map((n) => ({ name: n, major: '', minor: '' }));
    }

    // Engine = class/tag + curated + RxLabelGuard; reference = DDInter (severity-gated).
    const [enginePairs, refPairs] = await Promise.all([
      auditInteractions(items),
      referenceInteractions(drugs),
    ]);
    const pairs = mergeRank([...enginePairs, ...refPairs]);
    await logDdiQuery(drugs, pairs); // telemetry for tuning (best-effort, no PHI)
    return NextResponse.json({ pairs });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 500 });
  }
}
