import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { recomputeAndPersist, type RecomputeInput } from "@/lib/scoring/persist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TRIGGERS: RecomputeInput["trigger"][] = [
  "observation_write",
  "case_create",
  "case_status_change",
  "weight_change",
  "manual",
];

interface RouteParams {
  params: { vcId: string };
}

/**
 * POST /api/recompute/[vcId]
 *
 * Pulls the VC's data (cases, observations, streams, current weights),
 * runs the pure scoring engine (`computeScore`), persists a snapshot row,
 * writes an audit_log row.
 *
 * Body (optional JSON):
 *   { trigger?: 'observation_write'|'case_create'|'case_status_change'|'weight_change'|'manual',
 *     triggered_by_position?: string }
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  if (!UUID_RE.test(params.vcId)) {
    return NextResponse.json({ ok: false, error: "invalid vcId" }, { status: 400 });
  }

  let trigger: RecomputeInput["trigger"] = "manual";
  let triggered_by_position = "Committee Admin";
  try {
    const body = await req.json();
    if (body?.trigger && VALID_TRIGGERS.includes(body.trigger)) trigger = body.trigger;
    if (body?.triggered_by_position && typeof body.triggered_by_position === "string") {
      triggered_by_position = body.triggered_by_position;
    }
  } catch {
    /* body optional */
  }

  // Existence check before pulling (gives a clean 404 vs cryptic empty result).
  const vcRows = (await sql`SELECT id, full_name FROM vcs WHERE id = ${params.vcId}`) as Array<{
    id: string;
    full_name: string;
  }>;
  if (vcRows.length === 0) {
    return NextResponse.json({ ok: false, error: "VC not found" }, { status: 404 });
  }

  const start = Date.now();
  try {
    const { result, snapshotId } = await recomputeAndPersist({
      vcId: params.vcId,
      trigger,
      triggeredByPosition: triggered_by_position,
    });
    return NextResponse.json({
      ok: true,
      vc_id: params.vcId,
      surgeon_name: vcRows[0].full_name,
      snapshot_id: snapshotId,
      composite: result.composite,
      tier: result.tier,
      low_confidence: result.low_confidence,
      caseload_score: result.caseload.score,
      outcomes_score: result.outcomes.score,
      adherence_score: result.adherence.score,
      total_observations: result.total_observations,
      case_count_window: result.case_count_window,
      duration_ms: Date.now() - start,
      trigger,
      triggered_by_position,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - start,
      },
      { status: 500 },
    );
  }
}
