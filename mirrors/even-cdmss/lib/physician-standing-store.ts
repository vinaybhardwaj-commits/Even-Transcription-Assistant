/**
 * lib/physician-standing-store.ts — persistence for the MS standing overlay
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, S4; spec §6.3; table `physician_standing`,
 * created by POST /api/admin/migrate-physician-standing; reference DDL in
 * migrations/0050_physician_standing.sql).
 *
 * FAIL-SAFE THROUGHOUT, the same discipline as lib/case-ask/store.ts and for the same reason: a
 * standing that fails to persist must not cost the auditor the answer he is waiting for, and before
 * migration 0050 has run every call here soft-fails and the room behaves exactly as it did in S1.
 *
 * ⚠️ THE WRITE SURFACE IS FENCED IN CODE, not only by review. This file names exactly one table and
 * touches nothing else. There is no UPDATE and no DELETE anywhere in it: the overlay is
 * APPEND-ONLY, and "the MS changed his mind on Tuesday" is a second row, not an edited first one. A
 * standing is a statement a named person made on a date; rewriting one would destroy the only thing
 * it is evidence of.
 *
 * NO SCORE, NO BAND, NO VERDICT, NO PILL. `opd_note_audits`, `ipd_discharge_audits` and both
 * feedback tables are not named in this file's CODE — the only place those names appear is this
 * sentence — and a test asserts it by reading this source with the comments stripped.
 *
 * ⚠️ INFERRED SQL throughout: this sandbox has no live Neon.
 */
import { sql } from './db';
import { isPhysicianStanding, type PhysicianStanding, type PhysicianStandingRow } from './physician-standing-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Append ONE standing. Returns the row id, or null on any fault. Never throws. */
export async function appendStanding(row: PhysicianStandingRow): Promise<{ id: string } | null> {
  if (!row || !row.caseType || !row.caseKey || !row.engineVersion || !isPhysicianStanding(row.standing)) return null;
  try {
    const rows = (await run(
      `INSERT INTO physician_standing
         (case_type, case_key, engine_version, standing, quote, actor, turn_id, model, window_days, authority, stated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id`,
      [
        row.caseType, row.caseKey, row.engineVersion, row.standing, row.quote,
        row.actor, row.turnId, row.model, row.windowDays, row.authority,
      ],
    )) as Array<{ id: string }>;
    const r = rows[0];
    return r?.id ? { id: String(r.id) } : null;
  } catch {
    return null;
  }
}

export interface CurrentStanding {
  caseType: string;
  caseKey: string;
  standing: PhysicianStanding;
  quote: string;
  actor: string | null;
  at: string | null;
}

/**
 * The CURRENT standing per case — the latest row wins, and the earlier ones stay as history.
 *
 * ⚠️ NOT FILTERED BY ENGINE VERSION, deliberately, and this is the one place that decision is
 * visible. A3 gives these two case types a thread key whose engine half is a FAMILY string, so a
 * patch bump does not open a new thread; a standing keyed to the same thread must survive the same
 * bump, or the board would silently drop every MS judgement the day an engine version moved. The
 * version is still STORED on every row, so a reader can always ask which numbers a standing was
 * said about.
 */
export async function currentStandings(caseType?: string): Promise<Record<string, CurrentStanding>> {
  try {
    const rows = (await run(
      `SELECT DISTINCT ON (case_type, case_key)
              case_type, case_key, standing, quote, actor,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM physician_standing
        WHERE ($1::text IS NULL OR case_type = $1)
        ORDER BY case_type, case_key, created_at DESC`,
      [caseType ?? null],
    )) as Array<Record<string, unknown>>;
    const out: Record<string, CurrentStanding> = {};
    for (const r of rows) {
      const standing = String(r.standing ?? '');
      if (!isPhysicianStanding(standing)) continue;   // an unrecognised value is not shown as one
      out[String(r.case_key)] = {
        caseType: String(r.case_type ?? ''),
        caseKey: String(r.case_key ?? ''),
        standing,
        quote: String(r.quote ?? ''),
        actor: s(r.actor),
        at: s(r.created_at),
      };
    }
    return out;
  } catch {
    // Before migration 0050 this is simply "no standings", which renders as a board with no chips.
    return {};
  }
}

/** The full history for ONE case, newest first — the drill behind a chip. Fail-safe → []. */
export async function standingHistory(caseType: string, caseKey: string, limit = 20): Promise<CurrentStanding[]> {
  if (!caseType || !caseKey) return [];
  try {
    const rows = (await run(
      `SELECT case_type, case_key, standing, quote, actor,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM physician_standing
        WHERE case_type = $1 AND case_key = $2
        ORDER BY created_at DESC
        LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
      [caseType, caseKey],
    )) as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const standing = String(r.standing ?? '');
      return isPhysicianStanding(standing)
        ? [{
          caseType: String(r.case_type ?? ''), caseKey: String(r.case_key ?? ''),
          standing, quote: String(r.quote ?? ''), actor: s(r.actor), at: s(r.created_at),
        }]
        : [];
    });
  } catch {
    return [];
  }
}

/** Every INFERRED string this file runs, for the slice report. */
export const STANDING_INFERRED_SQL: Readonly<Record<string, string>> = Object.freeze({
  standing_insert:
    `INSERT INTO physician_standing
       (case_type, case_key, engine_version, standing, quote, actor, turn_id, model, window_days, authority, stated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
     RETURNING id`,
  standing_current:
    `SELECT DISTINCT ON (case_type, case_key)
            case_type, case_key, standing, quote, actor,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM physician_standing
      WHERE ($1::text IS NULL OR case_type = $1)
      ORDER BY case_type, case_key, created_at DESC`,
  standing_history:
    `SELECT case_type, case_key, standing, quote, actor,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM physician_standing
      WHERE case_type = $1 AND case_key = $2
      ORDER BY created_at DESC
      LIMIT 20`,
});
