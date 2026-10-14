/**
 * lib/case-ask/store.ts — the persistence layer for the shared case conversation
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / O5; table `case_ask_turns`, created by
 * /api/admin/migrate-case-ask; reference DDL in migrations/0046_case_ask_turns.sql).
 *
 * FAIL-SAFE THROUGHOUT — the whole file, reads and writes, copying the discipline of
 * lib/readmission/ask-store.ts (read for the pattern; NOT imported, per O3). The reasoning is the
 * same one it gives: a chat turn that fails to persist must not cost the auditor the ANSWER he is
 * waiting for. So every function returns an honest empty / null, never a throw, never a 500, and the
 * route reports `persisted:false` so the surface can say the thread is not being kept rather than
 * pretend it is.
 *
 * A consequence worth naming, and the reason §3.3 calls for it: BEFORE migration 0046 has run in
 * prod, every call here soft-fails, the Ask box behaves exactly as an ephemeral one, and nothing
 * else on either audit page notices.
 *
 * O5 — THE WRITE SURFACE IS FENCED IN CODE, not only by review. This file names exactly one table,
 * `case_ask_turns`, and touches nothing else. There is no clinical_review overlay on OPD or IPD this
 * ship, and so there is no column here to write one into: no audit or feedback table is named
 * anywhere in this file's CODE — the only place those names appear is this sentence — and a test
 * asserts it by reading this source with the comments stripped.
 *
 * ⚠️ INFERRED SQL throughout: this sandbox has no live Neon.
 */
import { sql } from '../db';
import { isCaseAskType } from '../case-ask-core';
import type { CaseAskThreadTurn, CaseAskTurnRole, CaseAskType } from '../case-ask-core';

/** One page-load never reads more than this many turns back. Well above the 20-turn model window:
 *  the SURFACE shows the whole argument, the MODEL sees the tail of it. */
const THREAD_LIMIT = 200;
/** A stored turn's text is capped here so one pasted document cannot become the thread. */
const CONTENT_MAX_CHARS = 8_000;

const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** The composite key of one thread: O5's unique index minus the turn index. */
export interface CaseAskThreadKey {
  caseType: CaseAskType;
  caseKey: string;
  engineVersion: string;
}

/**
 * A2 / kickoff acceptance #19 — the LAST gate before persist. This used to test `!k.caseType`, which
 * accepts any non-empty string: `case_type` is a TEXT column with no constraint, so a route that
 * read a case type off a query string and cast it could open a thread under a type this shell has
 * never heard of, and nothing downstream would notice until someone counted the rows. The type is
 * now checked as a VALUE against the union.
 *
 * The route rejects first, with a 400 (a 500 from the store would be a worse answer to a bad
 * request, and a soft-failed append would look to the caller like a DB outage). This is the second
 * of the two checks, and it is the one that holds for a caller that never existed when it was
 * written.
 */
const badKey = (k: CaseAskThreadKey): boolean =>
  !k || !isCaseAskType(k.caseType) || !k.caseKey || !k.engineVersion;

/**
 * The whole stored thread for one case at one engine version, oldest first. Fail-safe: any DB error
 * — including migration 0046 not having run — returns an empty thread with an honest error line.
 */
export async function readThread(
  key: CaseAskThreadKey,
): Promise<{ turns: CaseAskThreadTurn[]; error: string | null }> {
  if (badKey(key)) return { turns: [], error: 'case key required' };
  try {
    const rows = (await sql(
      `SELECT turn_index, role, content, actor, withheld,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM case_ask_turns
        WHERE case_type = $1 AND case_key = $2 AND engine_version = $3
        ORDER BY turn_index ASC
        LIMIT ${THREAD_LIMIT}`,
      [key.caseType, key.caseKey, key.engineVersion],
    )) as Array<Record<string, unknown>>;
    return {
      turns: rows.map((r) => ({
        turnIndex: Number(r.turn_index ?? 0),
        role: (String(r.role) === 'agent' ? 'agent' : 'user') as CaseAskTurnRole,
        content: String(r.content ?? ''),
        actor: s(r.actor),
        withheld: r.withheld === true,
        at: s(r.created_at),
      })),
      error: null,
    };
  } catch (e) {
    return { turns: [], error: `thread unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/**
 * Append ONE turn and return the row's id and index, or null on any fault.
 *
 * The index is allocated inside the same statement as the insert
 * (`SELECT coalesce(max(turn_index)+1, 0)` over the same key), so two turns racing cannot both claim
 * the same index without the unique index rejecting one of them — and a rejected append is a soft
 * failure, exactly like every other fault here.
 */
export async function appendTurn(a: CaseAskThreadKey & {
  role: CaseAskTurnRole;
  content: string;
  actor?: string | null;
  withheld?: boolean;
}): Promise<{ id: string; turnIndex: number } | null> {
  if (badKey(a) || !a.content) return null;
  try {
    const rows = (await sql(
      `INSERT INTO case_ask_turns (case_type, case_key, engine_version, turn_index, role, content, actor, withheld)
       SELECT $1, $2, $3, coalesce(max(turn_index) + 1, 0), $4, $5, $6, $7
         FROM case_ask_turns WHERE case_type = $1 AND case_key = $2 AND engine_version = $3
       RETURNING id, turn_index`,
      [
        a.caseType, a.caseKey, a.engineVersion,
        a.role === 'agent' ? 'agent' : 'user',
        String(a.content).slice(0, CONTENT_MAX_CHARS),
        a.actor ?? null, a.withheld === true,
      ],
    )) as Array<{ id: string; turn_index: number }>;
    const r = rows[0];
    return r?.id ? { id: String(r.id), turnIndex: Number(r.turn_index ?? 0) } : null;
  } catch {
    return null;
  }
}
