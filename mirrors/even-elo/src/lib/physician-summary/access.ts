import type { NeonQueryFunction } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { getHospitalFilterId } from "@/lib/hospital-filter";
import { isVertexSummariesEnabled } from "@/lib/vertex/env";
import { scopeStats, type SafeFeedbackRow } from "./aggregate";
import { formatSummaryGeneratedIst, deriveSummaryState } from "./state";
import type { SummaryRecord, SummaryServerPayload } from "./view";

export type SqlClient = NeonQueryFunction<false, false>;

const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";
export const PHYSICIAN_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SummaryAccessError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface SummaryCaller {
  profileId: string;
  email: string;
  is_super_admin: boolean;
  is_sgc_member: boolean;
  myPhysicianId: string;
  hospitalId: string;
}

export interface FeedbackScope {
  specialty: string | null;
  rows: SafeFeedbackRow[];
  liveCount: number;
  newestAt: string | null;
}

function iso(v: unknown): string | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Read access matches GET /api/incidents/physician/:id — super admin,
 * submitter, or target physician (same hospital filter).
 */
export async function requireSummaryViewer(sql: SqlClient): Promise<SummaryCaller> {
  let actor;
  try {
    actor = await actorFromRequest();
  } catch {
    throw new SummaryAccessError(401, "unauthenticated", "Unauthenticated");
  }

  const meRows = (await sql`
    SELECT email, is_super_admin, is_sgc_member
    FROM profiles_with_roles
    WHERE id = ${actor.profileId}::uuid
    LIMIT 1
  `) as Array<{ email: string; is_super_admin: boolean; is_sgc_member: boolean }>;
  if (meRows.length === 0) {
    throw new SummaryAccessError(401, "no_profile", "no profile");
  }
  const me = meRows[0];
  const myPhys = (await sql`
    SELECT id::text AS id FROM physicians WHERE lower(email) = ${me.email.toLowerCase()} LIMIT 1
  `) as Array<{ id: string }>;
  const hospitalId = (await getHospitalFilterId()) ?? "";

  return {
    profileId: actor.profileId,
    email: me.email,
    is_super_admin: me.is_super_admin,
    is_sgc_member: me.is_sgc_member,
    myPhysicianId: myPhys[0]?.id ?? "",
    hospitalId,
  };
}

/**
 * Provisional B7.5 — Generate / Regenerate for SGC or super only until
 * regenerators are locked. Viewers of the page may still GET state.
 */
export async function requireSummaryStaff(sql: SqlClient): Promise<SummaryCaller> {
  const caller = await requireSummaryViewer(sql);
  if (!(caller.is_super_admin || caller.is_sgc_member)) {
    throw new SummaryAccessError(403, "forbidden", "Not permitted");
  }
  return caller;
}

export async function loadFeedbackScope(
  sql: SqlClient,
  caller: SummaryCaller,
  physicianId: string,
): Promise<FeedbackScope> {
  const physicianRows = (await sql`
    SELECT id::text AS id, primary_specialty AS specialty
    FROM physicians
    WHERE id = ${physicianId}::uuid
    LIMIT 1
  `) as Array<{ id: string; specialty: string | null }>;
  if (physicianRows.length === 0) {
    throw new SummaryAccessError(404, "not_found", "Physician not found");
  }

  // Narratives are included for RCA/CAPA Generate (Sprint 3.3).
  // AuthZ (viewer / SGC+super for Generate) is the control — not a prompt-layer PHI ban.
  const rows = (await sql`
    SELECT
      i.submitted_at,
      i.polarity,
      i.category,
      i.commendation_category,
      i.severity,
      i.status,
      i.source,
      i.patient_rating,
      i.narrative
    FROM incidents i
    WHERE i.target_physician_id = ${physicianId}::uuid
      AND (
        ${caller.is_super_admin}
        OR i.submitter_user_id = ${caller.profileId}::uuid
        OR (${caller.myPhysicianId} <> '' AND i.target_physician_id = ${caller.myPhysicianId || EMPTY_UUID}::uuid)
      )
      AND (${caller.hospitalId} = '' OR i.hospital_id = ${caller.hospitalId || EMPTY_UUID}::uuid)
    ORDER BY i.submitted_at DESC
    LIMIT 1000
  `) as Array<Record<string, unknown>>;

  const safe: SafeFeedbackRow[] = rows.map((row) => ({
    submitted_at: iso(row.submitted_at) ?? "",
    polarity: String(row.polarity ?? "negative"),
    category: (row.category as string | null) ?? null,
    commendation_category: (row.commendation_category as string | null) ?? null,
    severity: (row.severity as string | null) ?? null,
    status: String(row.status ?? ""),
    source: String(row.source ?? "peer"),
    patient_rating: row.patient_rating == null ? null : Number(row.patient_rating),
    narrative: row.narrative == null ? null : String(row.narrative),
  }));

  const { liveCount, newestAt } = scopeStats(safe);
  const specialty = String(physicianRows[0].specialty ?? "").trim() || null;
  return { specialty, rows: safe, liveCount, newestAt };
}

export async function loadStoredSummary(
  sql: SqlClient,
  physicianId: string,
): Promise<SummaryRecord | null> {
  const rows = (await sql`
    SELECT
      summary_body,
      generated_at,
      model_id,
      vertex_location,
      vertex_project,
      feedback_count_at_gen
    FROM physician_feedback_summaries
    WHERE physician_id = ${physicianId}::uuid
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const row = rows[0];
  const generated_at = iso(row.generated_at);
  if (!generated_at) return null;
  return {
    body: String(row.summary_body ?? ""),
    generated_at,
    generated_ist: formatSummaryGeneratedIst(generated_at),
    model_id: String(row.model_id ?? ""),
    vertex_location: String(row.vertex_location ?? ""),
    vertex_project: row.vertex_project == null ? null : String(row.vertex_project),
    feedback_count_at_gen: Number(row.feedback_count_at_gen) || 0,
  };
}

export async function upsertSummary(
  sql: SqlClient,
  input: {
    physicianId: string;
    body: string;
    modelId: string;
    location: string;
    project: string;
    feedbackCount: number;
    profileId: string;
  },
): Promise<SummaryRecord> {
  const rows = (await sql`
    INSERT INTO physician_feedback_summaries (
      physician_id,
      summary_body,
      generated_at,
      model_id,
      vertex_location,
      vertex_project,
      feedback_count_at_gen,
      generated_by_profile_id,
      updated_at
    ) VALUES (
      ${input.physicianId}::uuid,
      ${input.body},
      now(),
      ${input.modelId},
      ${input.location},
      ${input.project},
      ${input.feedbackCount},
      ${input.profileId}::uuid,
      now()
    )
    ON CONFLICT (physician_id) DO UPDATE SET
      summary_body = EXCLUDED.summary_body,
      generated_at = EXCLUDED.generated_at,
      model_id = EXCLUDED.model_id,
      vertex_location = EXCLUDED.vertex_location,
      vertex_project = EXCLUDED.vertex_project,
      feedback_count_at_gen = EXCLUDED.feedback_count_at_gen,
      generated_by_profile_id = EXCLUDED.generated_by_profile_id,
      updated_at = EXCLUDED.updated_at
    RETURNING
      summary_body,
      generated_at,
      model_id,
      vertex_location,
      vertex_project,
      feedback_count_at_gen
  `) as Array<Record<string, unknown>>;

  const row = rows[0];
  const generated_at = iso(row.generated_at) ?? new Date().toISOString();
  return {
    body: String(row.summary_body ?? input.body),
    generated_at,
    generated_ist: formatSummaryGeneratedIst(generated_at),
    model_id: String(row.model_id ?? input.modelId),
    vertex_location: String(row.vertex_location ?? input.location),
    vertex_project: row.vertex_project == null ? input.project : String(row.vertex_project),
    feedback_count_at_gen: Number(row.feedback_count_at_gen) || input.feedbackCount,
  };
}

/**
 * GET body for the summary panel. Flag-off omits any stored body so production
 * stays gated until FEATURE_VERTEX_SUMMARIES is enabled after QA.
 */
export async function getSummaryResponse(
  sql: SqlClient,
  physicianId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SummaryServerPayload> {
  const caller = await requireSummaryViewer(sql);
  const scope = await loadFeedbackScope(sql, caller, physicianId);
  const stored = await loadStoredSummary(sql, physicianId);
  const featureEnabled = isVertexSummariesEnabled(env);
  const { state, stale } = deriveSummaryState({
    featureEnabled,
    liveCount: scope.liveCount,
    summary: stored
      ? { generated_at: stored.generated_at, feedback_count_at_gen: stored.feedback_count_at_gen }
      : null,
    newestFeedbackAt: scope.newestAt,
  });

  const exposeBody = featureEnabled && (state === "ready" || state === "stale");
  return {
    ok: true,
    feature_enabled: featureEnabled,
    state,
    live_feedback_count: scope.liveCount,
    newest_feedback_at: scope.newestAt,
    stale_detail: stale,
    summary: exposeBody ? stored : null,
  };
}
