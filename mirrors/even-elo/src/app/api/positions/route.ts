import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/positions */
export async function GET() {
  try {
    const rows = await sql`
      SELECT id, position_name, team, description, active, created_at
      FROM positions
      WHERE active = true
      ORDER BY position_name ASC
    `;
    return NextResponse.json({ ok: true, positions: rows });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** PATCH /api/positions — edit description by position_name */
export async function PATCH(req: NextRequest) {
  try {
        // EPI.0b — actor identity from JWT (server-side authoritative)
    let _actor;
    try {
      const { actorFromRequest } = await import("@/lib/auth");
      _actor = await actorFromRequest();
    } catch {
      return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401 });
    }
    const actor_position = _actor.position_label;
const body = await req.json();
    const { position_name, description, _unused_actor_position: _ } = body ?? {};

    if (!position_name || typeof position_name !== "string") {
      return NextResponse.json({ ok: false, error: "position_name required" }, { status: 400 });
    }
    if (!actor_position || typeof actor_position !== "string") {
      return NextResponse.json({ ok: false, error: "actor_position required" }, { status: 400 });
    }

    const beforeRows = (await sql`
      SELECT id, position_name, team, description, active FROM positions WHERE position_name = ${position_name}
    `) as Array<Record<string, unknown>>;

    if (beforeRows.length === 0) {
      return NextResponse.json({ ok: false, error: "position not found" }, { status: 404 });
    }
    const before = beforeRows[0];

    const updated = (await sql`
      UPDATE positions SET description = ${description ?? null} WHERE position_name = ${position_name}
      RETURNING id, position_name, team, description, active
    `) as Array<Record<string, unknown>>;

    await auditWrite({
      actor_position,
      action: "edit_position",
      entity_type: "position",
      entity_id: String(before.id),
      before,
      after: updated[0],
    });

    return NextResponse.json({ ok: true, position: updated[0] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
