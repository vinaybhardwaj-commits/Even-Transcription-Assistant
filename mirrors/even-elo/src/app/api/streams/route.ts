import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/streams[?team=OT][?component=adherence][?active=true]
 *
 * Returns the stream catalogue (PRD §5). Used by every input form to
 * discover the streams it owns plus their floor/target/direction config.
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const team = params.get("team");
    const component = params.get("component");
    const activeOnly = params.get("active") !== "false";

    const rows = await sql`
      SELECT id, component, label, team_owner, data_type, default_rule, direction,
             floor_value::float AS floor_value, target_value::float AS target_value,
             requires_reason_when, active
      FROM streams
      WHERE (${activeOnly} = false OR active = true)
        AND (${team}::text IS NULL OR team_owner = ${team})
        AND (${component}::text IS NULL OR component = ${component})
      ORDER BY component, label
    `;
    return NextResponse.json({ ok: true, streams: rows });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
