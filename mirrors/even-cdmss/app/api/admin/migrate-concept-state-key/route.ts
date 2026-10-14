import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isPaused } from '@/lib/even-concept';

export const runtime = 'nodejs';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Applies migrations/0021_concept_state_key.sql. Idempotent. Auth: ADMIN_TOKEN (Bearer/?token=) OR a
 * logged-in admin session cookie — same convention as migrate-lvc-concepts.
 *
 * REFUSES TO RUN UNLESS THE WORKER IS PAUSED. This swaps a primary key on a table the 2-minute cron
 * writes to; doing that under a live writer is the one irreversible way this goes wrong. Override with
 * ?force=1 only if you know the cron is stopped by other means.
 */
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  const force = req.nextUrl.searchParams.get('force') === '1';
  const paused = await isPaused().catch(() => false);
  if (!paused && !force) {
    return NextResponse.json({
      ok: false,
      error: 'refusing to run: the Concept Coder worker is not paused. Set even_concept_paused=1 first (POST /api/care/concept/status {"paused":true}), confirm a tick logs `paused`, then retry. ?force=1 overrides.',
    }, { status: 409 });
  }

  const steps: Record<string, string> = { worker_paused: String(paused) };
  try {
    await run(`ALTER TABLE even_concept_state ADD COLUMN IF NOT EXISTS engine_version TEXT`, []);
    await run(`ALTER TABLE even_concept_state ADD COLUMN IF NOT EXISTS in_family BOOLEAN`, []);
    steps.columns = 'ok';

    // Explicit sentinel, never NULL — a NULL would be distinct in the unique index below and would
    // silently permit the duplicate (uid, …) rows this migration exists to prevent.
    const back = await run(`UPDATE even_concept_state SET engine_version='epoch1-unkeyed' WHERE engine_version IS NULL`, []);
    steps.sentinel_backfill = `ok (${(back as unknown as { length: number }).length ?? 0} scanned)`;

    await run(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='even_concept_state' AND column_name='engine_version' AND is_nullable='YES') THEN
        ALTER TABLE even_concept_state ALTER COLUMN engine_version SET NOT NULL;
      END IF;
    END $$`, []);
    steps.not_null = 'ok';

    await run(`DO $$
      DECLARE pk_name TEXT;
      BEGIN
        SELECT c.conname INTO pk_name FROM pg_constraint c
        WHERE c.conrelid='even_concept_state'::regclass AND c.contype='p'
          AND (SELECT count(*) FROM unnest(c.conkey)) = 1;
        IF pk_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE even_concept_state DROP CONSTRAINT %I', pk_name);
        END IF;
      END $$`, []);
    steps.drop_uid_pk = 'ok';

    await run(`CREATE UNIQUE INDEX IF NOT EXISTS even_concept_state_uid_engine_uidx ON even_concept_state (uid, engine_version)`, []);
    await run(`CREATE INDEX IF NOT EXISTS even_concept_state_in_family_idx ON even_concept_state (in_family)`, []);
    steps.composite_key = 'ok';

    await run(`ALTER TABLE lvc_concepts ADD COLUMN IF NOT EXISTS live_volume INT NOT NULL DEFAULT 0`, []);
    await run(`CREATE INDEX IF NOT EXISTS lvc_concepts_live_lane_idx ON lvc_concepts (review_lane, live_volume DESC)`, []);
    steps.live_volume = 'ok';

    const shape = await run(
      `SELECT (SELECT count(*)::int FROM even_concept_state) AS state_rows,
              (SELECT count(*)::int FROM even_concept_state WHERE engine_version='epoch1-unkeyed') AS sentinel_rows,
              (SELECT count(*)::int FROM lvc_concepts WHERE live_volume > 0) AS live_volume_nonzero`, []);
    return NextResponse.json({ ok: true, steps, shape: shape[0] ?? null });
  } catch (e) {
    return NextResponse.json({ ok: false, steps, error: String((e as Error).message) }, { status: 500 });
  }
}
