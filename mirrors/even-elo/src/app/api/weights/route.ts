import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";
import { recomputeAndPersist } from "@/lib/scoring/persist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/weights — list weight version history (most-recent first).
 */
export async function GET() {
  try {
    const rows = await sql`
      SELECT id, caseload_pct, outcomes_pct, adherence_pct,
             effective_from, set_by_position, rationale, is_current, created_at
      FROM weight_versions
      ORDER BY effective_from DESC
    `;
    return NextResponse.json({ ok: true, versions: rows });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/weights — create new weight version + batch recompute all active VCs.
 *
 * Body: { caseload_pct, outcomes_pct, adherence_pct, set_by_position, rationale? }
 * Validates that the three percentages sum to 100.
 *
 * Action sequence:
 *   1. Validate inputs
 *   2. Mark all existing weight_versions as is_current=false
 *   3. Insert new row with is_current=true
 *   4. audit_log entry (action='apply_weights')
 *   5. Batch recompute every active VC with trigger='weight_change'
 *   6. Return new version + per-VC recompute summary
 */
export async function POST(req: NextRequest) {
  try {
        // EPI.0b — actor identity from JWT (server-side authoritative)
    let _actor;
    try {
      const { actorFromRequest } = await import("@/lib/auth");
      _actor = await actorFromRequest();
    } catch {
      return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401 });
    }
    const set_by_position = _actor.position_label;
const body = await req.json();
    const { caseload_pct, outcomes_pct, adherence_pct, _unused_set_by_position: _, rationale } = body ?? {};

    if (typeof caseload_pct !== "number" || typeof outcomes_pct !== "number" || typeof adherence_pct !== "number") {
      return NextResponse.json(
        { ok: false, error: "caseload_pct, outcomes_pct, adherence_pct required (numbers)" },
        { status: 400 },
      );
    }
    if (![caseload_pct, outcomes_pct, adherence_pct].every((n) => Number.isInteger(n) && n >= 0 && n <= 100)) {
      return NextResponse.json(
        { ok: false, error: "weights must be integers in [0, 100]" },
        { status: 400 },
      );
    }
    const sum = caseload_pct + outcomes_pct + adherence_pct;
    if (sum !== 100) {
      return NextResponse.json(
        { ok: false, error: `weights must sum to 100, got ${sum}` },
        { status: 400 },
      );
    }
    if (!set_by_position || typeof set_by_position !== "string") {
      return NextResponse.json({ ok: false, error: "set_by_position required" }, { status: 400 });
    }

    // Get prior current for audit before/after.
    const priorRows = (await sql`
      SELECT id, caseload_pct, outcomes_pct, adherence_pct, rationale
      FROM weight_versions WHERE is_current = true LIMIT 1
    `) as Array<Record<string, unknown>>;
    const priorVersion = priorRows[0] ?? null;

    // Mark all existing as not-current.
    await sql`UPDATE weight_versions SET is_current = false WHERE is_current = true`;

    // Insert new current row.
    const inserted = (await sql`
      INSERT INTO weight_versions
        (caseload_pct, outcomes_pct, adherence_pct, set_by_position, rationale, is_current)
      VALUES (${caseload_pct}, ${outcomes_pct}, ${adherence_pct}, ${set_by_position}, ${rationale ?? null}, true)
      RETURNING id, caseload_pct, outcomes_pct, adherence_pct, set_by_position, rationale, effective_from, created_at, is_current
    `) as Array<Record<string, unknown>>;
    const newVersion = inserted[0];

    await auditWrite({
      actor_position: set_by_position,
      action: "apply_weights",
      entity_type: "weights",
      entity_id: String(newVersion.id),
      before: priorVersion,
      after: newVersion,
    });

    // Batch recompute all active VCs.
    const vcs = (await sql`
      SELECT id, full_name FROM vcs WHERE status = 'active' ORDER BY full_name
    `) as Array<{ id: string; full_name: string }>;

    const batchStart = Date.now();
    const results: Array<{
      vc_id: string;
      full_name: string;
      composite?: number;
      tier?: string;
      duration_ms?: number;
      error?: string;
    }> = [];

    for (const v of vcs) {
      const t0 = Date.now();
      try {
        const { result } = await recomputeAndPersist({
          vcId: v.id,
          trigger: "weight_change",
          triggeredByPosition: set_by_position,
        });
        results.push({
          vc_id: v.id,
          full_name: v.full_name,
          composite: result.composite,
          tier: result.tier,
          duration_ms: Date.now() - t0,
        });
      } catch (e) {
        results.push({
          vc_id: v.id,
          full_name: v.full_name,
          error: e instanceof Error ? e.message : String(e),
          duration_ms: Date.now() - t0,
        });
      }
    }

    return NextResponse.json({
      ok: results.every((r) => !r.error),
      version: newVersion,
      recompute: {
        count: results.length,
        successes: results.filter((r) => !r.error).length,
        failures: results.filter((r) => r.error).length,
        duration_ms: Date.now() - batchStart,
        results,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
