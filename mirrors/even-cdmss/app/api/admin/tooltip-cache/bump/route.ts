import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';

// Bump the app-wide tooltip_cache_version sentinel (PRD §3.14).
// Client compares this against its local copy on app boot; on mismatch, clears
// all `tooltip:*` localStorage keys. Cheap mechanism for "expire all tooltips
// from a previous prompt revision."
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;

  try {
    const rows = (await sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('tooltip_cache_version', '1', NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = (COALESCE(app_settings.value::int, 0) + 1)::text,
            updated_at = NOW()
      RETURNING value
    `) as Array<{ value: string }>;

    return NextResponse.json({
      ok: true,
      tooltip_cache_version: rows[0]?.value,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
