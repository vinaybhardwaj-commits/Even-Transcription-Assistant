import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: { id: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/vcs/[id] */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    if (!UUID_RE.test(params.id)) {
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }
    const rows = (await sql`
      SELECT id, full_name, specialty, registration_no, status, notes, created_by_position, created_at, updated_at
      FROM vcs WHERE id = ${params.id}
    `) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, vc: rows[0] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** PATCH /api/vcs/[id] */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    if (!UUID_RE.test(params.id)) {
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }
    const body = await req.json();
    const { full_name, specialty, registration_no, notes, status, actor_position } = body ?? {};

    if (!actor_position || typeof actor_position !== "string") {
      return NextResponse.json({ ok: false, error: "actor_position required" }, { status: 400 });
    }
    if (status && !["active", "suspended", "terminated"].includes(status)) {
      return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
    }

    const beforeRows = (await sql`SELECT * FROM vcs WHERE id = ${params.id}`) as Array<
      Record<string, unknown>
    >;
    if (beforeRows.length === 0) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const before = beforeRows[0];

    const newFullName = full_name?.trim() ?? before.full_name;
    const newSpecialty = specialty?.trim() ?? before.specialty;
    const newReg = registration_no ?? before.registration_no;
    const newNotes = notes ?? before.notes;
    const newStatus = status ?? before.status;

    const updated = (await sql`
      UPDATE vcs SET
        full_name = ${newFullName},
        specialty = ${newSpecialty},
        registration_no = ${newReg},
        notes = ${newNotes},
        status = ${newStatus},
        updated_at = now()
      WHERE id = ${params.id}
      RETURNING id, full_name, specialty, registration_no, status, notes, created_at, updated_at
    `) as Array<Record<string, unknown>>;

    await auditWrite({
      actor_position,
      action: "edit_vc",
      entity_type: "vc",
      entity_id: params.id,
      before,
      after: updated[0],
    });

    return NextResponse.json({ ok: true, vc: updated[0] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/vcs/[id] — soft delete via status='terminated'.
 * Hard delete blocked once cases reference the VC.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    if (!UUID_RE.test(params.id)) {
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }
    const actor_position = req.nextUrl.searchParams.get("actor_position");
    if (!actor_position) {
      return NextResponse.json(
        { ok: false, error: "actor_position query param required" },
        { status: 400 },
      );
    }

    const beforeRows = (await sql`SELECT * FROM vcs WHERE id = ${params.id}`) as Array<
      Record<string, unknown>
    >;
    if (beforeRows.length === 0) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const before = beforeRows[0];

    const updated = (await sql`
      UPDATE vcs SET status = 'terminated', updated_at = now() WHERE id = ${params.id}
      RETURNING id, full_name, specialty, status
    `) as Array<Record<string, unknown>>;

    await auditWrite({
      actor_position,
      action: "delete_vc",
      entity_type: "vc",
      entity_id: params.id,
      before,
      after: updated[0],
    });

    return NextResponse.json({ ok: true, vc: updated[0] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
