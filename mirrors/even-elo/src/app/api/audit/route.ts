import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/audit
 *
 * Query params:
 *   action       — filter by audit action (create/overwrite/...)
 *   entity_type  — filter by entity_type (observation/case/...)
 *   actor        — filter by actor_position (substring match)
 *   limit        — default 100, max 1000
 *   offset       — pagination offset
 *   format       — 'json' (default) or 'csv'
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const action = params.get("action");
    const entity_type = params.get("entity_type");
    const actor = params.get("actor");
    const limit = Math.min(parseInt(params.get("limit") ?? "100", 10) || 100, 1000);
    const offset = parseInt(params.get("offset") ?? "0", 10) || 0;
    const format = params.get("format") ?? "json";

    const rows = await sql`
      SELECT id, actor_position, action, entity_type, entity_id,
             before_json, after_json, at
      FROM audit_log
      WHERE (${action}::text IS NULL OR action = ${action})
        AND (${entity_type}::text IS NULL OR entity_type = ${entity_type})
        AND (${actor}::text IS NULL OR actor_position ILIKE '%' || ${actor} || '%')
      ORDER BY at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    if (format === "csv") {
      const esc = (v: unknown): string => {
        if (v === null || v === undefined) return "";
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const header = ["at", "actor_position", "action", "entity_type", "entity_id", "before_json", "after_json"];
      const lines = [header.join(",")];
      for (const r of rows as Array<Record<string, unknown>>) {
        lines.push([
          esc(r.at),
          esc(r.actor_position),
          esc(r.action),
          esc(r.entity_type),
          esc(r.entity_id),
          esc(r.before_json),
          esc(r.after_json),
        ].join(","));
      }
      return new NextResponse(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="even-elo-audit-${new Date().toISOString().substring(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({ ok: true, rows, total: (rows as unknown[]).length });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
