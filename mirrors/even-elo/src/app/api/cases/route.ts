import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";
import { insertCaseAtomic } from "@/lib/case-ref";
import { recomputeAndPersist } from "@/lib/scoring/persist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/cases?vc_id=...&status=...&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const vc_id = params.get("vc_id");
    const status = params.get("status") ?? "completed";
    const from = params.get("from");
    const to = params.get("to");
    const limit = Math.min(parseInt(params.get("limit") ?? "50", 10) || 50, 500);

    if (vc_id && !UUID_RE.test(vc_id)) {
      return NextResponse.json({ ok: false, error: "invalid vc_id" }, { status: 400 });
    }
    if (from && !DATE_RE.test(from)) {
      return NextResponse.json({ ok: false, error: "invalid from date" }, { status: 400 });
    }
    if (to && !DATE_RE.test(to)) {
      return NextResponse.json({ ok: false, error: "invalid to date" }, { status: 400 });
    }

    let rows;
    if (vc_id && from && to) {
      rows = await sql`
        SELECT sc.*, v.full_name AS surgeon_name, v.specialty
        FROM surgical_cases sc
        JOIN vcs v ON v.id = sc.vc_id
        WHERE sc.vc_id = ${vc_id}
          AND (${status} = 'all' OR sc.case_status = ${status})
          AND sc.surgery_date >= ${from}::date
          AND sc.surgery_date <= ${to}::date
        ORDER BY sc.surgery_date DESC, sc.created_at DESC
        LIMIT ${limit}
      `;
    } else if (vc_id) {
      rows = await sql`
        SELECT sc.*, v.full_name AS surgeon_name, v.specialty
        FROM surgical_cases sc
        JOIN vcs v ON v.id = sc.vc_id
        WHERE sc.vc_id = ${vc_id}
          AND (${status} = 'all' OR sc.case_status = ${status})
        ORDER BY sc.surgery_date DESC, sc.created_at DESC
        LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT sc.*, v.full_name AS surgeon_name, v.specialty
        FROM surgical_cases sc
        JOIN vcs v ON v.id = sc.vc_id
        WHERE (${status} = 'all' OR sc.case_status = ${status})
        ORDER BY sc.surgery_date DESC, sc.created_at DESC
        LIMIT ${limit}
      `;
    }
    return NextResponse.json({ ok: true, cases: rows });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** POST /api/cases — create new case via continuous entry. */
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
    const {
      vc_id,
      surgery_date,
      procedure_label,
      patient_name,
      patient_mrn,
      notes,
      _unused_entered_by_position: _,
    } = body ?? {};

    if (!vc_id || !UUID_RE.test(vc_id)) {
      return NextResponse.json({ ok: false, error: "valid vc_id required" }, { status: 400 });
    }
    if (!surgery_date || !DATE_RE.test(surgery_date)) {
      return NextResponse.json(
        { ok: false, error: "surgery_date required (YYYY-MM-DD)" },
        { status: 400 },
      );
    }
    if (!entered_by_position || typeof entered_by_position !== "string") {
      return NextResponse.json(
        { ok: false, error: "entered_by_position required" },
        { status: 400 },
      );
    }

    // Verify VC is active.
    const vcRows = (await sql`SELECT id, full_name, status FROM vcs WHERE id = ${vc_id}`) as Array<{
      id: string;
      full_name: string;
      status: string;
    }>;
    if (vcRows.length === 0) {
      return NextResponse.json({ ok: false, error: "VC not found" }, { status: 404 });
    }
    if (vcRows[0].status !== "active") {
      return NextResponse.json(
        { ok: false, error: `VC is ${vcRows[0].status} — cannot enter cases` },
        { status: 409 },
      );
    }

    const inserted = await insertCaseAtomic({
      vc_id,
      surgery_date,
      procedure_label: procedure_label ?? null,
      patient_name: patient_name ?? null,
      patient_mrn: patient_mrn ?? null,
      notes: notes ?? null,
      source: "continuous",
      entered_by_position,
    });

    await auditWrite({
      actor_position: entered_by_position,
      action: "create",
      entity_type: "case",
      entity_id: inserted.id,
      after: inserted as unknown as Record<string, unknown>,
    });

    // Real engine recompute (ELO.3b).
    let recompute:
      | { ok: true; composite: number; tier: string; snapshot_id: string; duration_ms: number }
      | { ok: false; error: string };
    const recomputeStart = Date.now();
    try {
      const { result, snapshotId } = await recomputeAndPersist({
        vcId: vc_id,
        trigger: "case_create",
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
        case: { ...inserted, surgeon_name: vcRows[0].full_name },
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
