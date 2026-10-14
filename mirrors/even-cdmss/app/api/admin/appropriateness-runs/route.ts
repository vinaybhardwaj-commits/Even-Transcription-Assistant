import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { listRuns, type RunMode } from '@/lib/appropriateness-runs';

export const runtime = 'nodejs';

// GET /api/admin/appropriateness-runs?mode=&limit= — list research runs (admin-gated).
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const modeRaw = req.nextUrl.searchParams.get('mode') || '';
  const mode = (['check', 'pathway', 'audit'] as RunMode[]).includes(modeRaw as RunMode) ? (modeRaw as RunMode) : undefined;
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '200', 10);
  const runs = await listRuns({ mode, limit });
  return NextResponse.json({ ok: true, runs });
}
