/**
 * GET /api/opd-triage/queue — the care-manager worklist (governance spec v2.0 §3.2).
 *
 * Thin delegate into lib/triage/queue-read.ts — the same Action-queue population the admin
 * shadow door reads. Informational drop lives in buildQueue, not here.
 *
 * Query: ?day=YYYY-MM-DD (default = latest audited IST day) · ?days=N (window back, default 1,
 *        max 7) · ?doctor_uid= (one doctor) · ?status=untriaged|all (default untriaged).
 * Auth: care-manager session cookie OR admin.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { parseActionQueueQuery, readActionQueue } from '@/lib/triage/queue-read';

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

export async function GET(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const result = await readActionQueue(parseActionQueueQuery(req.nextUrl.searchParams));
  return NextResponse.json(result);
}
