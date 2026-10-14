import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";
import { recomputeAndPersist } from "@/lib/scoring/persist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteParams {
  params: { id: string };
}

/** GET /api/cases/[id] */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    if (!UUID_RE.test(params.id)) {
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }
    const rows = (await sql`
      SELECT sc.*, v.full_name AS surgeon_name, v.specialty
      FROM surgical_cases sc
      JOIN vcs v ON v.id = sc.vc_id
      WHERE sc.id = ${params.id}
    `) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, case: rows[0] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** PATCH /api/cases/[id] — change status (void / cancel) or update fields. */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
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
if (!UUID_RE.test(params.id)) {
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }
    const body = await req.json();
    const {
      case_status,
      procedure_label,
      patient_name,
      patient_mrn,
      surgery_date,
      los_days,
      notes,
      _unused_actor_position: _,
    } = body ?? {};

    if (!actor_position || typeof actor_position !== "string") {
      return NextResponse.json({ ok: false, error: "actor_position required" }, { status: 400 });
    }
    if (case_status && !["completed", "cancelled", "voided"].includes(case_status)) {
      return NextResponse.json({ ok: false, error: "invalid case_status" }, { status: 400 });
    }

    const beforeRows = (await sql`SELECT * FROM surgical_cases WHERE id = ${params.id}`) as Array<
      Record<string, unknown>
    >;
    if (beforeRows.length === 0) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const before = beforeRows[0];

    const newStatus = case_status ?? before.case_status;
    const newProc = procedure_label ?? before.procedure_label;
    const newPatient = patient_name ?? before.patient_name;
    const newMrn = patient_mrn ?? before.patient_mrn;
    const newDate = surgery_date ?? before.surgery_date;
    const newLos = los_days ?? before.los_days;
    const newNotes = notes ?? before.notes;

    const updated = (await sql`
      UPDATE surgical_cases SET
        case_status = ${newStatus},
        procedure_label = ${newProc},
        patient_name = ${newPatient},
        patient_mrn = ${newMrn},
        surgery_date = ${newDate}::date,
        los_days = ${newLos},
        notes = ${newNotes}
      WHERE id = ${params.id}
      RETURNING *
    `) as Array<Record<string, unknown>>;

    const action = case_status === "voided" ? "void" : "create"; // 'create' = generic edit
    await auditWrite({
      actor_position,
      action: action === "void" ? "void" : "edit_vc", // closest existing action
      entity_type: "case",
      entity_id: params.id,
      before,
      after: updated[0],
    });

    // Real engine recompute if the status changed in a way that affects scoring.
    let recompute:
      | { ok: true; composite: number; tier: string; snapshot_id: string }
      | undefined;
    if (case_status && case_status !== before.case_status) {
      try {
        const { result, snapshotId } = await recomputeAndPersist({
          vcId: String(before.vc_id),
          trigger: "case_status_change",
          triggeredByPosition: actor_position,
        });
        recompute = {
          ok: true,
          composite: result.composite,
          tier: result.tier,
          snapshot_id: snapshotId,
        };
      } catch {
        // Recompute failure is non-fatal — case patch already committed.
      }
    }

    return NextResponse.json({ ok: true, case: updated[0], recompute });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/cases/[id] — hard delete blocked once observations exist.
 * Use PATCH with case_status='voided' for the soft path instead.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    if (!UUID_RE.test(params.id)) {
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }
    // EPI.0b — actor from JWT
    let _actor2;
    try {
      const { actorFromRequest } = await import("@/lib/auth");
      _actor2 = await actorFromRequest();
    } catch {
      return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401 });
    }
    const actor_position = _actor2.position_label;
    if (!actor_position) {
      return NextResponse.json(
        { ok: false, error: "actor_position query param required" },
        { status: 400 },
      );
    }

    const obsCount = (await sql`
      SELECT COUNT(*)::int AS n FROM case_observations WHERE case_id = ${params.id}
    `) as Array<{ n: number }>;
    if ((obsCount[0]?.n ?? 0) > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `Hard delete blocked: ${obsCount[0].n} observations reference this case. Void it instead via PATCH case_status='voided'.`,
        },
        { status: 409 },
      );
    }

    const beforeRows = (await sql`SELECT * FROM surgical_cases WHERE id = ${params.id}`) as Array<
      Record<string, unknown>
    >;
    if (beforeRows.length === 0) {
      return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const before = beforeRows[0];

    await sql`DELETE FROM surgical_cases WHERE id = ${params.id}`;

    await auditWrite({
      actor_position,
      action: "void",
      entity_type: "case",
      entity_id: params.id,
      before,
      after: null,
    });

    return NextResponse.json({ ok: true, deleted: params.id });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
