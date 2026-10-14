import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/vcs?status=active|all */
export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get("status") ?? "active";
    const rows =
      status === "all"
        ? await sql`SELECT id, full_name, specialty, registration_no, status, notes, created_at, updated_at FROM vcs ORDER BY full_name ASC`
        : await sql`SELECT id, full_name, specialty, registration_no, status, notes, created_at, updated_at FROM vcs WHERE status = ${status} ORDER BY full_name ASC`;
    return NextResponse.json({ ok: true, vcs: rows });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** POST /api/vcs — create new VC */
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
    const created_by_position = _actor.position_label;
const body = await req.json();
    const { full_name, specialty, registration_no, notes, _unused_created_by_position: _ } = body ?? {};

    if (!full_name || typeof full_name !== "string" || !full_name.trim()) {
      return NextResponse.json({ ok: false, error: "full_name required" }, { status: 400 });
    }
    if (!specialty || typeof specialty !== "string" || !specialty.trim()) {
      return NextResponse.json({ ok: false, error: "specialty required" }, { status: 400 });
    }
    if (!created_by_position || typeof created_by_position !== "string") {
      return NextResponse.json(
        { ok: false, error: "created_by_position required" },
        { status: 400 },
      );
    }

    const rows = (await sql`
      INSERT INTO vcs (full_name, specialty, registration_no, notes, created_by_position)
      VALUES (${full_name.trim()}, ${specialty.trim()}, ${registration_no ?? null}, ${notes ?? null}, ${created_by_position})
      RETURNING id, full_name, specialty, registration_no, status, notes, created_at, updated_at
    `) as Array<Record<string, unknown>>;

    const inserted = rows[0];
    await auditWrite({
      actor_position: created_by_position,
      action: "add_vc",
      entity_type: "vc",
      entity_id: String(inserted.id),
      after: inserted,
    });

    return NextResponse.json({ ok: true, vc: inserted }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
