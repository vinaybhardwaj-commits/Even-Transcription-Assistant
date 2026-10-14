export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/mini-backfill-settings — the admin module's control surface.
 * Body: any subset of { enabled: '1'|'0', window: 'night'|'always', cursor: 'YYYY-MM-DD',
 * floor: 'YYYY-MM-DD', tag: string, n: '1'..'4' }. Admin session or ?token=ADMIN_TOKEN.
 * Setting a NEW tag = a fresh re-audit generation over whatever range the cursor covers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { setSetting, readState, MB_KEYS } from '@/lib/mini-backfill';

export async function POST(req: NextRequest) {
  if (!(await isAdminUnlocked())) {
    const denied = requireAdmin(req);
    if (denied) return denied;
  }
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const updates: [string, string][] = [];
  if (body.enabled === '1' || body.enabled === '0') updates.push([MB_KEYS.enabled, String(body.enabled)]);
  if (body.window === 'night' || body.window === 'always') updates.push([MB_KEYS.window, String(body.window)]);
  if (day(body.cursor)) updates.push([MB_KEYS.cursor, day(body.cursor)!]);
  if (day(body.floor)) updates.push([MB_KEYS.floor, day(body.floor)!]);
  if (typeof body.tag === 'string' && body.tag.trim()) updates.push([MB_KEYS.tag, body.tag.trim().replace(/[^a-z0-9-]/gi, '').slice(0, 24)]);
  if (typeof body.n === 'string' && /^[1-4]$/.test(body.n)) updates.push([MB_KEYS.n, body.n]);
  // The `prod` switch was DELETED 2 Aug 2026 (GRADER-PROVENANCE PRD D1). A body carrying it is
  // ignored rather than rejected: the setting no longer exists and the mini always writes '-<tag>'.
  if (updates.length === 0) return NextResponse.json({ ok: false, error: 'no valid settings in body' }, { status: 400 });

  for (const [k, v] of updates) await setSetting(k, v);
  return NextResponse.json({ ok: true, updated: updates.map(([k]) => k), state: await readState() });
}
