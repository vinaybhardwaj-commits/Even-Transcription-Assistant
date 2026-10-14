import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { getRun } from '@/lib/appropriateness-runs';

export const runtime = 'nodejs';

// GET /api/admin/appropriateness-runs/[id] — full run record incl. output JSON (admin-gated).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req); if (denied) return denied;
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, run });
}
