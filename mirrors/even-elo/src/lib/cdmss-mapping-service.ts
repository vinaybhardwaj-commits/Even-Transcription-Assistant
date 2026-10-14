/**
 * src/lib/cdmss-mapping-service.ts — doctor-mapping run + staff review (Round 2 / F3).
 *
 * `computeMapping` is the F1 matcher run against the live CDMSS directory and the active physicians;
 * the admin endpoint (/api/admin/map-cdmss-doctors) and the staff review page both call it, so the
 * review list IS the F1 endpoint's `review` list, not a second opinion.
 *
 * Review rules:
 *   · A weak match is a (CDMSS doctor, candidate physician) pair. Staff CONFIRM one pair (writes
 *     physicians.cdmss_doctor_uid) or REJECT one pair (it stops being offered).
 *   · A confirm is only accepted for a pair that is in the CURRENT review list (the list is recomputed
 *     on every decision, so a stale page cannot link a physician the matcher no longer proposes).
 *   · A confirm only ever fills an EMPTY link: a physician already linked to any uid is never
 *     overwritten here (409 physician_already_linked), and a CDMSS uid already held by another
 *     physician is refused by the unique index (409 uid_already_linked).
 *   · Every decision is written to cdmss_mapping_decisions (who, when, why) and to audit_log_v2.
 *     The decision row is written FIRST and removed again if the link write fails, so a link without
 *     its audit row cannot exist.
 */

import { sql } from "@/lib/db";
import { canActOnPhysician, physiciansInScope, type StaffScope } from "@/lib/staff-live";
import { fetchDoctorDirectory } from "@/lib/cdmss-doctor-directory";
import {
  matchDirectory,
  type MappingResult,
  type PhysicianRow,
  type ReviewReason,
} from "@/lib/cdmss-doctor-mapping";

export async function loadActivePhysicians(): Promise<PhysicianRow[]> {
  return (await sql`
    SELECT id::text AS id, full_name, phone, cdmss_doctor_uid, cdmss_alias_uids
    FROM physicians WHERE current_status = 'active'`) as unknown as PhysicianRow[];
}

export type MappingRun = MappingResult & { directory_count: number; physicians: PhysicianRow[] };

/** THROWS when the directory cannot be read (a half-read directory would invent "unmatched" doctors). */
export async function computeMapping(): Promise<MappingRun> {
  const [directory, physicians] = await Promise.all([fetchDoctorDirectory(), loadActivePhysicians()]);
  return { ...matchDirectory(directory, physicians), directory_count: directory.length, physicians };
}

export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  ambiguous_name: "Several physicians share this name; the phone number did not settle it",
  mobile_mismatch: "Same name, but the phone number's last four digits differ",
  partial_name: "Partial name match (a name part is missing on one side)",
  linked_to_other_uid: "A physician with this name is already linked to a different CDMSS doctor",
  physician_claimed_twice: "One physician matched two different CDMSS doctors",
  alias_name_mismatch: "CDMSS merged this doctor into another identity, but the names differ",
};

export interface ReviewCandidate {
  physician_id: string;
  physician_name: string;
  /** The CDMSS uid this physician is already linked to, if any. */
  linked_uid: string | null;
  confirmable: boolean;
}

export interface ReviewQueueItem {
  uid: string;
  name: string;
  reason: ReviewReason;
  reason_text: string;
  disabled: boolean;
  candidates: ReviewCandidate[];
}

export interface DecisionRow {
  id: string;
  decision: "confirm" | "reject";
  cdmss_uid: string;
  cdmss_name: string | null;
  physician_id: string | null;
  physician_name: string | null;
  reason: string | null;
  note: string | null;
  decided_by_email: string;
  decided_at: string;
}

async function loadRejected(): Promise<{ pairs: Set<string>; available: boolean }> {
  try {
    const rows = (await sql`
      SELECT cdmss_uid, physician_id::text AS physician_id FROM cdmss_mapping_decisions WHERE decision = 'reject'`) as unknown as Array<{
      cdmss_uid: string;
      physician_id: string | null;
    }>;
    return { pairs: new Set(rows.map((r) => `${r.cdmss_uid}|${r.physician_id}`)), available: true };
  } catch {
    return { pairs: new Set(), available: false };
  }
}

export async function loadRecentDecisions(limit = 25): Promise<DecisionRow[]> {
  try {
    return (await sql`
      SELECT id::text AS id, decision, cdmss_uid, cdmss_name, physician_id::text AS physician_id, physician_name,
             reason, note, decided_by_email, decided_at
      FROM cdmss_mapping_decisions ORDER BY decided_at DESC LIMIT ${limit}`) as unknown as DecisionRow[];
  } catch {
    return [];
  }
}

/** PURE. The run's review list, minus rejected pairs, with each candidate's link state. */
export function buildQueue(run: Pick<MappingRun, "review" | "physicians">, rejected: ReadonlySet<string>): ReviewQueueItem[] {
  const byId = new Map(run.physicians.map((p) => [p.id, p]));
  const items: ReviewQueueItem[] = [];
  for (const r of run.review) {
    const candidates: ReviewCandidate[] = r.candidates
      .filter((c) => !rejected.has(`${r.uid}|${c.physician_id}`))
      .map((c) => {
        const linked = byId.get(c.physician_id)?.cdmss_doctor_uid ?? null;
        return {
          physician_id: c.physician_id,
          physician_name: c.physician_name,
          linked_uid: linked,
          confirmable: !linked,
        };
      });
    if (candidates.length === 0) continue;
    items.push({
      uid: r.uid,
      name: r.name,
      reason: r.reason,
      reason_text: REVIEW_REASON_TEXT[r.reason] ?? r.reason,
      disabled: r.disabled,
      candidates,
    });
  }
  return items;
}

/** PURE. Keep only the candidates in `allowed`; an item with none left goes. */
export function restrictQueue(items: ReviewQueueItem[], allowed: ReadonlySet<string>): ReviewQueueItem[] {
  return items
    .map((i) => ({ ...i, candidates: i.candidates.filter((c) => allowed.has(c.physician_id)) }))
    .filter((i) => i.candidates.length > 0);
}

export async function reviewQueue(scope: StaffScope = { all: true }): Promise<{
  items: ReviewQueueItem[];
  directory_count: number;
  coverage: MappingResult["coverage"];
  decisions_available: boolean;
  recent: DecisionRow[];
}> {
  const [run, rejected, recent] = await Promise.all([computeMapping(), loadRejected(), loadRecentDecisions()]);
  let items = buildQueue(run, rejected.pairs);
  if (!scope.all) {
    const ids = items.flatMap((i) => i.candidates.map((c) => c.physician_id));
    items = restrictQueue(items, await physiciansInScope(scope, ids));
  }
  return {
    items,
    directory_count: run.directory_count,
    coverage: run.coverage,
    decisions_available: rejected.available,
    recent,
  };
}

export type DecisionResult =
  | { ok: true; decision: "confirm" | "reject"; physician_id: string; cdmss_uid: string }
  | {
      ok: false;
      http: 400 | 403 | 409 | 502 | 500;
      error:
        | "out_of_scope"
        | "directory_unavailable"
        | "not_in_review"
        | "physician_already_linked"
        | "uid_already_linked"
        | "decision_not_recorded";
      message: string;
    };

export interface MappingActor {
  profileId: string;
  email: string;
}

const UNIQUE_VIOLATION = /duplicate key|unique constraint|23505/i;

export async function decideMapping(input: {
  decision: "confirm" | "reject";
  uid: string;
  physicianId: string;
  note: string | null;
  actor: MappingActor;
  /** Where the caller may act (from requireStaff). Defaults to everywhere only for direct service calls. */
  scope: StaffScope;
}): Promise<DecisionResult> {
  const { decision, uid, physicianId, note, actor, scope } = input;
  // A Site Medical Head decides only for physicians at their own hospital(s).
  if (!(await canActOnPhysician(scope, physicianId))) {
    return {
      ok: false,
      http: 403,
      error: "out_of_scope",
      message: "This physician is not engaged at a hospital you head, so you cannot decide this match.",
    };
  }
  let run: MappingRun;
  try {
    run = await computeMapping();
  } catch (e) {
    return {
      ok: false,
      http: 502,
      error: "directory_unavailable",
      message: `The CDMSS doctor directory could not be read (${e instanceof Error ? e.message.slice(0, 80) : "error"}). Nothing was changed.`,
    };
  }
  const item = run.review.find((r) => r.uid === uid && r.candidates.some((c) => c.physician_id === physicianId));
  if (!item) {
    return {
      ok: false,
      http: 409,
      error: "not_in_review",
      message: "This match is no longer on the review list (it was settled or the data changed). Refresh the page.",
    };
  }
  const cand = item.candidates.find((c) => c.physician_id === physicianId)!;
  const physician = run.physicians.find((p) => p.id === physicianId);

  if (decision === "confirm" && physician?.cdmss_doctor_uid) {
    return {
      ok: false,
      http: 409,
      error: "physician_already_linked",
      message: "This physician is already linked to a CDMSS doctor. Linked physicians are not overwritten here.",
    };
  }

  // The audit row first: a link must never exist without it.
  let decisionId: string | null = null;
  try {
    const rows = (await sql`
      INSERT INTO cdmss_mapping_decisions
        (decision, cdmss_uid, cdmss_name, physician_id, physician_name, reason, note, decided_by_profile_id, decided_by_email)
      VALUES
        (${decision}, ${uid}, ${item.name}, ${physicianId}::uuid, ${cand.physician_name}, ${item.reason}, ${note},
         ${actor.profileId}::uuid, ${actor.email})
      ON CONFLICT (decision, cdmss_uid, physician_id) DO NOTHING
      RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
    decisionId = rows[0]?.id ?? null;
  } catch {
    return { ok: false, http: 500, error: "decision_not_recorded", message: "The decision could not be recorded, so nothing was changed." };
  }

  // A repeated reject is already on record: nothing more to write or audit.
  if (decision === "reject" && !decisionId) return { ok: true, decision, physician_id: physicianId, cdmss_uid: uid };

  if (decision === "confirm") {
    try {
      const linked = (await sql`
        UPDATE physicians SET cdmss_doctor_uid = ${uid}
        WHERE id = ${physicianId}::uuid AND cdmss_doctor_uid IS NULL
        RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
      if (linked.length === 0) {
        if (decisionId) await sql`DELETE FROM cdmss_mapping_decisions WHERE id = ${decisionId}::uuid`.catch(() => undefined);
        return {
          ok: false,
          http: 409,
          error: "physician_already_linked",
          message: "This physician was linked to a CDMSS doctor while you were reviewing. Nothing was changed.",
        };
      }
    } catch (e) {
      if (decisionId) await sql`DELETE FROM cdmss_mapping_decisions WHERE id = ${decisionId}::uuid`.catch(() => undefined);
      const msg = e instanceof Error ? e.message : "";
      if (UNIQUE_VIOLATION.test(msg)) {
        return {
          ok: false,
          http: 409,
          error: "uid_already_linked",
          message: "Another physician is already linked to this CDMSS doctor. Nothing was changed.",
        };
      }
      return { ok: false, http: 500, error: "decision_not_recorded", message: "The link could not be written. Nothing was changed." };
    }
  }

  try {
    await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (${actor.profileId}::uuid,
                      ${decision === "confirm" ? "cdmss_mapping_confirmed" : "cdmss_mapping_rejected"},
                      'physician', ${physicianId},
                      ${JSON.stringify({ cdmss_uid: uid, cdmss_name: item.name, reason: item.reason, decided_by: actor.email })}::jsonb)`;
  } catch {
    // cdmss_mapping_decisions already holds who and when.
  }
  return { ok: true, decision, physician_id: physicianId, cdmss_uid: uid };
}
