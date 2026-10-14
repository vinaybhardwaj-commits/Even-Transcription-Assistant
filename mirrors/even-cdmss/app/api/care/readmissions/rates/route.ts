/**
 * GET /api/care/readmissions/rates — the read behind the RATES MODULE on /care/readmissions
 * (CDMSS-READMISSIONS-R7-PRD v1.0, R7-1 / R7-2 / R7-8).
 *
 * READ-ONLY, gated exactly as the list route (care cookie or admin cookie; CCB + surface flags).
 * Two reads, both fail-safe (lib/readmission/rates.ts): Neon numerators (detected Even→Even pairs at
 * the current engine version) + db13 denominators (IP discharges since the surveillance start, grouped
 * by facility × IST day × department × disposition). Either failing → { ok:false } and the page shows
 * "rates unavailable right now" — never a half-computed rate, never a 500. Served from a ≤ 15-minute
 * in-memory cache with its computed-at stamp.
 *
 * PHI: the payload is AGGREGATES ONLY — counts, rates, intervals, month labels. No patient name, UHID,
 * encounter id, doc id or dedup key leaves this route (computeRates never emits them; the encounter id
 * is read server-side only to resolve the facility by prefix).
 */
import { NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { readRates } from '@/lib/readmission/rates';
import { RATES_UNAVAILABLE_COPY } from '@/lib/readmission-rates-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1';
}
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET() {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const read = await readRates();
  if (!read.ok) return NextResponse.json({ ok: false, error: RATES_UNAVAILABLE_COPY, reason: read.reason, computedAt: read.computedAt }, { status: 200 });
  return NextResponse.json({ ok: true, rates: read.rates, computedAt: read.computedAt, cached: read.cached, engineVersion: read.engineVersion });
}
