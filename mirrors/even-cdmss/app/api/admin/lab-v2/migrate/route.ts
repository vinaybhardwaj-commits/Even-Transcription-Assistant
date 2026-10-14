export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /api/admin/lab-v2/migrate — apply migrations/lab-v2/*.sql to LAB_V2_DATABASE_URL
 * (LAB-MCP-V2-PRD-v1.0 §4, §14.1, §14.4 step 3).
 *
 * Guarded by the admin cookie session, exactly as the other /api/admin/* migrate routes
 * are (`isAdminUnlocked`, falling back to `requireAdmin`'s bearer/token form). V opens it
 * in the browser once after setting the env vars.
 *
 * Idempotent and checksummed. Applying twice is a no-op; a file whose contents changed
 * after it was applied is an ERROR, never a silent re-apply — the database and the
 * repository disagree at that point and only a human can say which is right.
 *
 * It reads the .sql files from disk at request time rather than importing them, so the
 * checksum recorded is the checksum of what actually ran.
 */
import { readFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { labV2Configured, postgres } from '@/lib/lab-v2/db';
import { applyMigrations, type MigrationFile } from '@/lib/lab-v2/store';

const DIR = join(process.cwd(), 'migrations', 'lab-v2');

function loadMigrations(): MigrationFile[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(DIR, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  if (!labV2Configured()) {
    return NextResponse.json({ ok: false, error: 'LAB_V2_DATABASE_URL is not set (or equals DATABASE_URL)' }, { status: 503 });
  }
  try {
    const db = await postgres();
    const { applied, skipped } = await applyMigrations(db, loadMigrations());
    return NextResponse.json({ ok: true, applied, skipped });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
