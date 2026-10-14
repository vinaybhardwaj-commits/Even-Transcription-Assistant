/**
 * GET / POST /api/admin/triage/queue — Action queue for the Triage Bot (admin-gated).
 *
 * Same population as /care/triage (lib/triage/queue-read → buildQueue). POST is a query
 * (JSON body with the same fields as the GET querystring) so a machine credential need not
 * put filters on the URL.
 *
 * Auth: cat_admin session OR ADMIN_TOKEN Bearer / ?token= — house admin door, not the care cookie.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { flattenActionQueueItems, parseActionQueueQuery, readActionQueue } from '@/lib/triage/queue-read';

async function adminOk(req: NextRequest): Promise<NextResponse | null> {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  return null;
}

async function serve(req: NextRequest, query: ReturnType<typeof parseActionQueueQuery>) {
  const denied = await adminOk(req);
  if (denied) return denied;
  const result = await readActionQueue(query);
  return NextResponse.json({
    ...result,
    items: flattenActionQueueItems(result.doctors, result.unmapped),
  });
}

export async function GET(req: NextRequest) {
  return serve(req, parseActionQueueQuery(req.nextUrl.searchParams));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  return serve(req, parseActionQueueQuery(body && typeof body === 'object' ? body : {}));
}
