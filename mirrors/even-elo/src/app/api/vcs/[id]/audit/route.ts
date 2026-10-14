import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteParams {
  params: { id: string };
}

/**
 * GET /api/vcs/[id]/audit
 *
 * Returns CSV-formatted dump of all observations (current + superseded)
 * for cases owned by this VC. The artefact a committee member would
 * attach to a privileging review packet for legal defensibility.
 *
 * Columns: case_ref, surgery_date, procedure_label, stream_id, stream_label,
 *          value_kind, value_val, reason, entered_by_position, entered_at,
 *          is_current, superseded_at
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  try {
    const vcRows = (await sql`SELECT id, full_name FROM vcs WHERE id = ${params.id}`) as Array<{
      id: string;
      full_name: string;
    }>;
    if (vcRows.length === 0) {
      return NextResponse.json({ ok: false, error: "VC not found" }, { status: 404 });
    }
    const vcName = vcRows[0].full_name;

    const rows = (await sql`
      SELECT
        sc.case_ref,
        sc.surgery_date::text AS surgery_date,
        sc.procedure_label,
        co.stream_id,
        s.label AS stream_label,
        co.value,
        co.entered_by_position,
        co.entered_at,
        co.is_current,
        co.superseded_at
      FROM case_observations co
      JOIN surgical_cases sc ON sc.id = co.case_id
      JOIN streams s ON s.id = co.stream_id
      WHERE sc.vc_id = ${params.id}
      ORDER BY co.entered_at DESC
    `) as Array<Record<string, unknown>>;

    const header = [
      "case_ref",
      "surgery_date",
      "procedure_label",
      "stream_id",
      "stream_label",
      "value_kind",
      "value_val",
      "reason",
      "entered_by_position",
      "entered_at",
      "is_current",
      "superseded_at",
    ];

    const esc = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const lines = [header.join(",")];
    for (const r of rows) {
      const value = r.value as { kind?: string; val?: unknown; reason?: string } | null;
      lines.push(
        [
          esc(r.case_ref),
          esc(r.surgery_date),
          esc(r.procedure_label),
          esc(r.stream_id),
          esc(r.stream_label),
          esc(value?.kind ?? ""),
          esc(value?.val ?? ""),
          esc(value?.reason ?? ""),
          esc(r.entered_by_position),
          esc(r.entered_at),
          esc(r.is_current),
          esc(r.superseded_at),
        ].join(","),
      );
    }
    const csv = lines.join("\n");

    const safeName = vcName.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
    const filename = `even-elo-audit-${safeName}-${new Date().toISOString().substring(0, 10)}.csv`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
