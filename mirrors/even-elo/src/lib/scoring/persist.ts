import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";
import { computeScore } from "./index";
import {
  CaseRow,
  ComputeResult,
  Observation,
  ObservationValue,
  Stream,
  Weights,
} from "./types";

/**
 * DB-IO shell around the pure scoring pipeline (ELO.3a `computeScore`).
 *
 * `pullVcData` reads everything the engine needs in 4 parallel queries.
 * `writeSnapshot` appends a `score_snapshots` row + audit_log row.
 * `recomputeAndPersist` is the convenience entry point used by API routes.
 *
 * Performance budget (PRD §6.4): <2s per VC, <30s for 12 VCs in batch.
 */

export interface RecomputeInput {
  vcId: string;
  trigger:
    | "observation_write"
    | "case_create"
    | "case_status_change"
    | "weight_change"
    | "manual";
  triggeredByPosition: string;
}

export interface RecomputeOutput {
  result: ComputeResult;
  snapshotId: string;
  weightVersionId: string;
}

export async function pullVcData(vcId: string): Promise<{
  cases: CaseRow[];
  observations: Observation[];
  streams: Stream[];
  weights: Weights;
  weightVersionId: string;
}> {
  const [casesRows, obsRows, streamRows, weightRows] = await Promise.all([
    sql`
      SELECT id, vc_id, surgery_date::text AS surgery_date, case_status
      FROM surgical_cases
      WHERE vc_id = ${vcId}
    `,
    sql`
      SELECT co.case_id, co.stream_id, co.value
      FROM case_observations co
      JOIN surgical_cases sc ON sc.id = co.case_id
      WHERE sc.vc_id = ${vcId} AND co.is_current = true
    `,
    sql`
      SELECT id, component, label, team_owner, data_type, default_rule, direction,
             floor_value::float AS floor_value, target_value::float AS target_value
      FROM streams WHERE active = true
    `,
    sql`
      SELECT id, caseload_pct, outcomes_pct, adherence_pct
      FROM weight_versions WHERE is_current = true LIMIT 1
    `,
  ]);

  const weightRow = (weightRows as Array<{
    id: string;
    caseload_pct: number;
    outcomes_pct: number;
    adherence_pct: number;
  }>)[0];

  if (!weightRow) {
    throw new Error("No current weight_versions row — migration may be incomplete");
  }

  return {
    cases: casesRows as CaseRow[],
    observations: (obsRows as Array<{
      case_id: string;
      stream_id: string;
      value: ObservationValue;
    }>).map((r) => ({
      case_id: r.case_id,
      stream_id: r.stream_id,
      value: r.value,
    })),
    streams: streamRows as Stream[],
    weights: {
      caseload_pct: weightRow.caseload_pct,
      outcomes_pct: weightRow.outcomes_pct,
      adherence_pct: weightRow.adherence_pct,
    },
    weightVersionId: weightRow.id,
  };
}

export async function writeSnapshot(input: {
  vcId: string;
  result: ComputeResult;
  weightVersionId: string;
  trigger: RecomputeInput["trigger"];
  triggeredByPosition: string;
}): Promise<string> {
  const rows = (await sql`
    INSERT INTO score_snapshots (
      vc_id, caseload_score, outcomes_score, adherence_score,
      composite, tier, low_confidence, weights_version_id,
      trigger, triggered_by_position
    ) VALUES (
      ${input.vcId}::uuid,
      ${input.result.caseload.score},
      ${input.result.outcomes.score},
      ${input.result.adherence.score},
      ${input.result.composite},
      ${input.result.tier},
      ${input.result.low_confidence},
      ${input.weightVersionId}::uuid,
      ${input.trigger},
      ${input.triggeredByPosition}
    )
    RETURNING id
  `) as Array<{ id: string }>;

  await auditWrite({
    actor_position: input.triggeredByPosition,
    action: "recompute",
    entity_type: "vc",
    entity_id: input.vcId,
    after: {
      snapshot_id: rows[0].id,
      composite: input.result.composite,
      tier: input.result.tier,
      trigger: input.trigger,
      caseload_score: input.result.caseload.score,
      outcomes_score: input.result.outcomes.score,
      adherence_score: input.result.adherence.score,
      low_confidence: input.result.low_confidence,
    },
  });

  return rows[0].id;
}

/**
 * One-shot: pull → compute → persist. Used by every API route that
 * needs to recompute a VC.
 */
export async function recomputeAndPersist(
  input: RecomputeInput,
): Promise<RecomputeOutput> {
  const data = await pullVcData(input.vcId);
  const result = computeScore({
    cases: data.cases,
    observations: data.observations,
    streams: data.streams,
    weights: data.weights,
  });
  const snapshotId = await writeSnapshot({
    vcId: input.vcId,
    result,
    weightVersionId: data.weightVersionId,
    trigger: input.trigger,
    triggeredByPosition: input.triggeredByPosition,
  });
  return { result, snapshotId, weightVersionId: data.weightVersionId };
}
