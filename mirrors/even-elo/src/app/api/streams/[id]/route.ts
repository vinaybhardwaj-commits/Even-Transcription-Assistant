import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

/**
 * PATCH /api/streams/[id] — admin-only stream config edit (floor/target/active).
 *
 * Body: { floor_value?, target_value?, active?, actor_position }
 *
 * Does NOT trigger recompute automatically — UI dialog asks. Caller may
 * follow with POST /api/admin/recompute?all=true.
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const body = await req.json();
    const { floor_value, target_value, active, actor_position } = body ?? {};

    if (!actor_position || typeof actor_position !== "string") {
      return NextResponse.json({ ok: false, error: "actor_position required" }, { status: 400 });
    }
    if (
      floor_value !== undefined &&
      floor_value !== null &&
      typeof floor_value !== "number"
    ) {
      return NextResponse.json({ ok: false, error: "floor_value must be number or null" }, { status: 400 });
    }
    if (
      target_value !== undefined &&
      target_value !== null &&
      typeof target_value !== "number"
    ) {
      return NextResponse.json({ ok: false, error: "target_value must be number or null" }, { status: 400 });
    }
    if (active !== undefined && typeof active !== "boolean") {
      return NextResponse.json({ ok: false, error: "active must be boolean" }, { status: 400 });
    }

    const beforeRows = (await sql`SELECT * FROM streams WHERE id = ${params.id}`) as Array<
      Record<string, unknown>
    >;
    if (beforeRows.length === 0) {
      return NextResponse.json({ ok: false, error: "stream not found" }, { status: 404 });
    }
    const before = beforeRows[0];

    const newFloor = floor_value !== undefined ? floor_value : before.floor_value;
    const newTarget = target_value !== undefined ? target_value : before.target_value;
    const newActive = active !== undefined ? active : before.active;

    const updated = (await sql`
      UPDATE streams SET
        floor_value = ${newFloor},
        target_value = ${newTarget},
        active = ${newActive},
        updated_at = now()
      WHERE id = ${params.id}
      RETURNING id, label, component, team_owner, data_type, default_rule, direction,
                floor_value::float AS floor_value, target_value::float AS target_value,
                requires_reason_when, active, updated_at
    `) as Array<Record<string, unknown>>;

    await auditWrite({
      actor_position,
      action: "edit_stream",
      entity_type: "stream",
      entity_id: params.id,
      before,
      after: updated[0],
    });

    return NextResponse.json({ ok: true, stream: updated[0] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
