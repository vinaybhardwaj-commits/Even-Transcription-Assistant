import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";
import { recomputeAndPersist } from "@/lib/scoring/persist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * GET /api/observations?vc_id=<uuid>&month=YYYY-MM
 *
 * Returns all CURRENT observations for cases of the given VC in the given
 * surgery month. The CaseTable form uses this on mount to render existing
 * cell values.
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const vc_id = params.get("vc_id");
    const month = params.get("month");

    if (!vc_id || !UUID_RE.test(vc_id)) {
      return NextResponse.json({ ok: false, error: "valid vc_id required" }, { status: 400 });
    }
    if (!month || !MONTH_RE.test(month)) {
      return NextResponse.json(
        { ok: false, error: "month required (YYYY-MM)" },
        { status: 400 },
      );
    }

    const rows = await sql`
      SELECT co.id, co.case_id, co.stream_id, co.value, co.entered_by_position, co.entered_at
      FROM case_observations co
      JOIN surgical_cases sc ON sc.id = co.case_id
      WHERE sc.vc_id = ${vc_id}
        AND co.is_current = true
        AND to_char(sc.surgery_date, 'YYYY-MM') = ${month}
    `;
    return NextResponse.json({ ok: true, observations: rows });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/observations
 *
 * Body:
 *   { case_id, stream_id, value: { kind, val, reason? }, entered_by_position }
 *
 * Action sequence:
 *   1. Validate inputs.
 *   2. Mark prior current observation for (case_id, stream_id) as
 *      is_current=false + superseded_at=now (if any).
 *   3. Insert new observation row with is_current=true.
 *   4. audit_log row with before/after.
 *   5. Pull the case's vc_id and recomputeAndPersist({trigger:'observation_write'}).
 *   6. Return new observation + recompute summary.
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
    const entered_by_position = _actor.position_label;
const body = await req.json();
    const { case_id, stream_id, value, _unused_entered_by_position: _ } = body ?? {};

    if (!case_id || !UUID_RE.test(case_id)) {
      return NextResponse.json({ ok: false, error: "valid case_id required" }, { status: 400 });
    }
    if (!stream_id || typeof stream_id !== "string") {
      return NextResponse.json({ ok: false, error: "stream_id required" }, { status: 400 });
    }
    if (!entered_by_position || typeof entered_by_position !== "string") {
      return NextResponse.json(
        { ok: false, error: "entered_by_position required" },
        { status: 400 },
      );
    }
    if (!value || typeof value !== "object") {
      return NextResponse.json({ ok: false, error: "value required" }, { status: 400 });
    }
    if (value.kind !== "binary" && value.kind !== "numeric") {
      return NextResponse.json(
        { ok: false, error: "value.kind must be 'binary' or 'numeric'" },
        { status: 400 },
      );
    }
    if (value.kind === "binary" && typeof value.val !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "binary value.val must be boolean" },
        { status: 400 },
      );
    }
    if (value.kind === "numeric" && (typeof value.val !== "number" || isNaN(value.val))) {
      return NextResponse.json(
        { ok: false, error: "numeric value.val must be a real number" },
        { status: 400 },
      );
    }

    // Verify stream exists + is active.
    const streamRows = (await sql`
      SELECT id, requires_reason_when FROM streams WHERE id = ${stream_id} AND active = true
    `) as Array<{ id: string; requires_reason_when: string | null }>;
    if (streamRows.length === 0) {
      return NextResponse.json({ ok: false, error: "stream not found or inactive" }, { status: 404 });
    }
    const stream = streamRows[0];

    // requires_reason_when format: '<bool>[:optional]'
    //   'true'           → reason mandatory when val=true
    //   'false:optional' → reason field shown when val=false but optional
    // We only block save when the trigger value matches AND :optional is absent.
    if (stream.requires_reason_when && value.kind === "binary") {
      const [boolPart, ...mods] = stream.requires_reason_when.split(":");
      const trigger = boolPart === "true";
      const isOptional = mods.includes("optional");
      const triggered = value.val === trigger;
      const hasReason =
        value.reason && typeof value.reason === "string" && value.reason.trim().length > 0;
      if (triggered && !isOptional && !hasReason) {
        return NextResponse.json(
          { ok: false, error: "Reason is required for this stream" },
          { status: 400 },
        );
      }
    }

    // Look up the case's vc_id (also verifies case exists).
    const caseRows = (await sql`
      SELECT id, vc_id FROM surgical_cases WHERE id = ${case_id}
    `) as Array<{ id: string; vc_id: string }>;
    if (caseRows.length === 0) {
      return NextResponse.json({ ok: false, error: "case not found" }, { status: 404 });
    }
    const vc_id = caseRows[0].vc_id;

    // Step 2: supersede prior current row if any.
    const prior = (await sql`
      SELECT id, value FROM case_observations
      WHERE case_id = ${case_id} AND stream_id = ${stream_id} AND is_current = true
    `) as Array<{ id: string; value: unknown }>;

    let supersededId: string | null = null;
    let priorValue: unknown = null;
    if (prior.length > 0) {
      supersededId = prior[0].id;
      priorValue = prior[0].value;
      await sql`
        UPDATE case_observations
        SET is_current = false, superseded_at = now()
        WHERE id = ${supersededId}
      `;
    }

    // Step 3: insert new current row.
    const inserted = (await sql`
      INSERT INTO case_observations (case_id, stream_id, value, entered_by_position)
      VALUES (${case_id}, ${stream_id}, ${JSON.stringify(value)}::jsonb, ${entered_by_position})
      RETURNING id, case_id, stream_id, value, entered_by_position, entered_at
    `) as Array<Record<string, unknown>>;
    const observation = inserted[0];

    // Step 4: audit log.
    await auditWrite({
      actor_position: entered_by_position,
      action: supersededId ? "overwrite" : "create",
      entity_type: "observation",
      entity_id: String(observation.id),
      before: supersededId ? { value: priorValue, superseded_id: supersededId } : null,
      after: { case_id, stream_id, value },
    });

    // Step 5: real recompute.
    let recompute:
      | { ok: true; composite: number; tier: string; snapshot_id: string; duration_ms: number }
      | { ok: false; error: string };
    const recomputeStart = Date.now();
    try {
      const { result, snapshotId } = await recomputeAndPersist({
        vcId: vc_id,
        trigger: "observation_write",
        triggeredByPosition: entered_by_position,
      });
      recompute = {
        ok: true,
        composite: result.composite,
        tier: result.tier,
        snapshot_id: snapshotId,
        duration_ms: Date.now() - recomputeStart,
      };
    } catch (e) {
      recompute = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    return NextResponse.json(
      {
        ok: true,
        observation,
        superseded_id: supersededId,
        recompute,
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
