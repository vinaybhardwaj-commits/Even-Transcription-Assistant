/**
 * lib/brain/fuse/visit-update.ts — the first UPDATE visit path in this codebase (K2 Part C).
 *
 * Until now `visit` was insert-only: the fuse wrote rows with ON CONFLICT DO NOTHING and
 * nothing anywhere could change one afterwards. A visit could therefore never be corrected,
 * which is fine for a scratch replay and useless for a live day, where evidence arrives after
 * the row does.
 *
 * ─── WHAT MAY CHANGE, AND WHEN ───────────────────────────────────────────────────────────
 *
 *   state ∈ called | in_chair | at_diagnostics   →  EVERYTHING the fuse recomputes:
 *       state, ended_at, confidence, end_reason, ambiguity, session_id, tape_start_ms,
 *       tape_end_ms, clinician_id, clinician_source, clinician_confidence
 *
 *   state = 'ended'                              →  ONLY the three clinician columns.
 *       Everything else is FROZEN. A closed visit's account of what happened is final; a
 *       closed visit's account of WHO was in the room is not, because that is the knowledge
 *       that genuinely arrives late — a roster imported next week, an operator naming a
 *       clinician days later. Those are different kinds of fact and they get different rules.
 *
 * The freeze lives in the SQL (SQL_VISIT_UPDATE_OPEN carries `AND state <> 'ended'`), not in a
 * branch here, so a future caller cannot route around it by calling a different function.
 *
 * ─── OPTIMISTIC CONCURRENCY (C3) ─────────────────────────────────────────────────────────
 * Every update names the `updated_at` the caller READ. A stale computation therefore MUST
 * LOSE: it matches no row and changes nothing. Losing is a normal outcome, not an error —
 * `{ won: false }` means "someone else already moved this row", and the caller either re-reads
 * and re-applies or drops the write because the newer state already says the same thing. The
 * alternative, last-writer-wins, would let a fuse run that started ten seconds ago silently
 * overwrite an operator's correction made two seconds ago.
 *
 * ─── AUDIT (C2) ──────────────────────────────────────────────────────────────────────────
 * Every POST-CLOSE change writes an audit_log row. That write goes through lib/db (the APP
 * role), not the brain pool: audit_log is an app-owned table and brain_svc has no grant on it.
 * Two connections, one logical action — and the audit is best-effort, like every other audit
 * write in this codebase, because failing a clinician correction because the log was busy
 * would be the wrong trade.
 */

import { sql } from "@/lib/db";
import { query } from "@/lib/brain/db";
import {
  SQL_VISIT_BY_ID,
  SQL_VISIT_UPDATE_CLINICIAN,
  SQL_VISIT_UPDATE_OPEN,
  type Queryable,
} from "@/lib/brain/state";
import { CLINICIAN_SOURCES, type ClinicianSource } from "./types";

export type VisitRowForUpdate = {
  id: string;
  room_day_id: string;
  state: string;
  updated_at: Date | string;
  clinician_id: string | null;
  clinician_source: string | null;
  clinician_confidence: number | null;
  end_reason: string | null;
  ended_at: Date | string | null;
  arm: string | null;
  opened_by: string | null;
};

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** True once a visit is closed — the point after which only the clinician columns may move. */
export const isClosed = (state: string): boolean => state === "ended";

export async function readVisit(id: string, client?: Queryable): Promise<VisitRowForUpdate | null> {
  const r = client
    ? await client.query<VisitRowForUpdate>(SQL_VISIT_BY_ID, [id])
    : await query<VisitRowForUpdate>(SQL_VISIT_BY_ID, [id]);
  return r.rows[0] ?? null;
}

/** The fields an OPEN visit may have recomputed. Every one is nullable on the row. */
export type OpenVisitPatch = {
  state: string;
  ended_at: string | null;
  confidence: number;
  end_reason: string | null;
  ambiguity: string | null;
  session_id: string | null;
  tape_start_ms: number | null;
  tape_end_ms: number | null;
  clinician_id: string | null;
  clinician_source: ClinicianSource | null;
  clinician_confidence: number | null;
};

export type UpdateOutcome = { won: boolean; updated_at: string | null };

/**
 * Recompute an OPEN visit. Returns won:false — changing nothing — when the row has moved since
 * `expectedUpdatedAt`, OR when it has since closed. Both are the same situation from the
 * caller's point of view: what it computed was about a row that no longer exists in that form.
 */
export async function updateOpenVisit(
  client: Queryable,
  id: string,
  expectedUpdatedAt: Date | string,
  patch: OpenVisitPatch,
): Promise<UpdateOutcome> {
  const r = await client.query<{ id: string; updated_at: Date }>(SQL_VISIT_UPDATE_OPEN, [
    id,
    iso(expectedUpdatedAt),
    patch.state,
    patch.ended_at,
    patch.confidence,
    patch.end_reason,
    patch.ambiguity,
    patch.session_id,
    patch.tape_start_ms,
    patch.tape_end_ms,
    patch.clinician_id,
    patch.clinician_source,
    patch.clinician_confidence,
  ]);
  const row = r.rows[0];
  return { won: (r.rowCount ?? 0) > 0, updated_at: row ? iso(row.updated_at) : null };
}

/**
 * Name the clinician on a visit in ANY state — the one change a closed visit still accepts.
 *
 * `source` is validated against 0056's closed set here because this entry point is reachable
 * from an operator tool, and a free-text source would defeat the CHECK's whole purpose by
 * arriving as a value the CHECK happens to allow. Arm A derives its own source and never
 * comes through this argument.
 */
export async function updateVisitClinician(
  client: Queryable,
  id: string,
  expectedUpdatedAt: Date | string,
  clinician: { id: string | null; source: ClinicianSource; confidence: number | null },
): Promise<UpdateOutcome> {
  if (!(CLINICIAN_SOURCES as readonly string[]).includes(clinician.source)) {
    throw new Error(`invalid_clinician_source:${clinician.source}`);
  }
  const r = await client.query<{ id: string; updated_at: Date }>(SQL_VISIT_UPDATE_CLINICIAN, [
    id,
    iso(expectedUpdatedAt),
    clinician.id,
    clinician.source,
    clinician.confidence,
  ]);
  const row = r.rows[0];
  return { won: (r.rowCount ?? 0) > 0, updated_at: row ? iso(row.updated_at) : null };
}

/**
 * C2 — one audit_log row per POST-CLOSE change. `before` and `after` are both recorded: a row
 * saying only the new value cannot answer "what did this used to say", which is the question
 * an audit of a late correction is for.
 *
 * Best-effort by design (see the header). A failure is logged, never thrown.
 */
export async function auditVisitClinicianChange(input: {
  visitId: string;
  roomDayId: string;
  actorType: "admin" | "system";
  actorId: string;
  before: { clinician_id: string | null; clinician_source: string | null; clinician_confidence: number | null };
  after: { clinician_id: string | null; clinician_source: string | null; clinician_confidence: number | null };
  visitState: string;
  note?: string | null;
}): Promise<void> {
  const meta = {
    room_day_id: input.roomDayId,
    visit_state: input.visitState,
    post_close: isClosed(input.visitState),
    before: input.before,
    after: input.after,
    ...(input.note ? { note: input.note } : {}),
  };
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES (${input.actorType}, ${input.actorId}, 'visit.set_clinician', 'visit', ${input.visitId},
              ${JSON.stringify(meta)}::jsonb)
    `;
  } catch (e) {
    console.warn(
      "[visit-update] audit_log insert failed (console fallback)",
      JSON.stringify({ visit_id: input.visitId, ...meta, err: String((e as Error)?.message ?? e).slice(0, 160) }),
    );
  }
}
