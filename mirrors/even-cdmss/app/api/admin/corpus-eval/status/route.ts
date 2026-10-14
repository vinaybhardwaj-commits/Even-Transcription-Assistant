// app/api/admin/corpus-eval/status/route.ts — Brainstem PR 0: read-only progress surface.
//
// Returns .corpus-eval/status.json (the run heartbeat written every verdict by run-baseline /
// coverage-deficit) so "running / how far / done?" is checkable in a browser even when the device
// bridge is down. Admin-gated, read-only — no run control, no DB, no model. The status file is a
// LOCAL measurement artifact (gitignored); in an environment without it, this reports "no active run".
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAdminUnlocked } from '@/lib/admin-cookie';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  if (!(await isAdminUnlocked().catch(() => false))) {
    return NextResponse.json({ error: 'locked' }, { status: 403 });
  }
  try {
    const raw = readFileSync(join(process.cwd(), '.corpus-eval', 'status.json'), 'utf8');
    return new NextResponse(raw, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ done: null, note: 'no corpus-eval run status found (.corpus-eval/status.json absent — no run has started in this environment)' }, { status: 200, headers: { 'cache-control': 'no-store' } });
  }
}
