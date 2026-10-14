import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { auditWrite } from "@/lib/audit";
import { insertCaseAtomic } from "@/lib/case-ref";
import { recomputeAndPersist } from "@/lib/scoring/persist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface UploadRow {
  vc_full_name: string;
  surgery_date: string;
  procedure_label?: string;
  patient_name?: string;
  patient_mrn?: string;
  notes?: string;
}

interface PreviewedRow {
  index: number;
  raw: UploadRow;
  vc_id?: string;
  resolved_vc?: { id: string; full_name: string; specialty: string };
  duplicate_of?: string;
  errors: string[];
}

/**
 * POST /api/cases/upload
 *
 * Body: { mode: 'preview'|'commit', rows: UploadRow[], entered_by_position: string }
 *
 * preview mode: validates each row, resolves vc_full_name → vc_id, flags
 * duplicates against existing cases on (vc_id, surgery_date, procedure_label).
 * Returns the previewed array WITHOUT inserting.
 *
 * commit mode: re-validates, then inserts every row whose `errors.length === 0`
 * and whose `duplicate_of` is null. Returns insert results.
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
    const { mode, rows, _unused_entered_by_position: _ } = body ?? {};

    if (!entered_by_position || typeof entered_by_position !== "string") {
      return NextResponse.json(
        { ok: false, error: "entered_by_position required" },
        { status: 400 },
      );
    }
    if (mode !== "preview" && mode !== "commit") {
      return NextResponse.json(
        { ok: false, error: "mode must be 'preview' or 'commit'" },
        { status: 400 },
      );
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "rows array required" },
        { status: 400 },
      );
    }
    if (rows.length > 500) {
      return NextResponse.json(
        { ok: false, error: "max 500 rows per upload" },
        { status: 413 },
      );
    }

    // Resolve all VC names in one query.
    const allVcs = (await sql`
      SELECT id, full_name, specialty FROM vcs WHERE status = 'active'
    `) as Array<{ id: string; full_name: string; specialty: string }>;

    const previewed: PreviewedRow[] = rows.map((raw: UploadRow, index: number) => {
      const errors: string[] = [];

      const vcName = (raw.vc_full_name ?? "").trim();
      if (!vcName) errors.push("vc_full_name is empty");

      const date = (raw.surgery_date ?? "").trim();
      if (!date) errors.push("surgery_date is empty");
      else if (!DATE_RE.test(date)) errors.push(`surgery_date '${date}' must be YYYY-MM-DD`);

      // Match VC by exact name (case-insensitive).
      const matches = allVcs.filter(
        (v) => v.full_name.toLowerCase() === vcName.toLowerCase(),
      );
      let vc_id: string | undefined;
      let resolved_vc: PreviewedRow["resolved_vc"];
      if (matches.length === 0 && vcName) {
        errors.push(`No active VC matches '${vcName}'`);
      } else if (matches.length > 1) {
        errors.push(`'${vcName}' is ambiguous (${matches.length} active VCs match)`);
      } else if (matches.length === 1) {
        vc_id = matches[0].id;
        resolved_vc = matches[0];
      }

      return {
        index,
        raw: {
          vc_full_name: vcName,
          surgery_date: date,
          procedure_label: raw.procedure_label?.trim(),
          patient_name: raw.patient_name?.trim(),
          patient_mrn: raw.patient_mrn?.trim(),
          notes: raw.notes?.trim(),
        },
        vc_id,
        resolved_vc,
        errors,
      };
    });

    // Duplicate detection — query in batches by (vc_id, surgery_date).
    const dupCandidates = previewed.filter((p) => p.vc_id && p.errors.length === 0);
    if (dupCandidates.length > 0) {
      const existing = (await sql`
        SELECT id, vc_id, surgery_date::text AS surgery_date, procedure_label
        FROM surgical_cases
        WHERE case_status != 'voided'
          AND (vc_id, surgery_date::text) IN (
            SELECT v::uuid, d FROM unnest(
              ${dupCandidates.map((p) => p.vc_id!)}::uuid[],
              ${dupCandidates.map((p) => p.raw.surgery_date)}::text[]
            ) AS t(v, d)
          )
      `) as Array<{ id: string; vc_id: string; surgery_date: string; procedure_label: string | null }>;

      for (const p of dupCandidates) {
        const match = existing.find(
          (e) =>
            e.vc_id === p.vc_id &&
            e.surgery_date === p.raw.surgery_date &&
            (e.procedure_label ?? "") === (p.raw.procedure_label ?? ""),
        );
        if (match) {
          p.duplicate_of = match.id;
        }
      }
    }

    if (mode === "preview") {
      return NextResponse.json({
        ok: true,
        mode: "preview",
        rows: previewed,
        summary: {
          total: previewed.length,
          ready_to_insert: previewed.filter((p) => p.errors.length === 0 && !p.duplicate_of).length,
          errors: previewed.filter((p) => p.errors.length > 0).length,
          duplicates: previewed.filter((p) => p.duplicate_of).length,
        },
      });
    }

    // commit mode
    const inserted: Array<{ index: number; case_ref: string; id: string }> = [];
    const skipped: Array<{ index: number; reason: string }> = [];

    for (const p of previewed) {
      if (p.errors.length > 0) {
        skipped.push({ index: p.index, reason: p.errors.join("; ") });
        continue;
      }
      if (p.duplicate_of) {
        skipped.push({ index: p.index, reason: `duplicate of ${p.duplicate_of}` });
        continue;
      }
      try {
        const row = await insertCaseAtomic({
          vc_id: p.vc_id!,
          surgery_date: p.raw.surgery_date,
          procedure_label: p.raw.procedure_label ?? null,
          patient_name: p.raw.patient_name ?? null,
          patient_mrn: p.raw.patient_mrn ?? null,
          notes: p.raw.notes ?? null,
          source: "catchup_upload",
          entered_by_position,
        });
        await auditWrite({
          actor_position: entered_by_position,
          action: "create",
          entity_type: "case",
          entity_id: row.id,
          after: row as unknown as Record<string, unknown>,
        });
        inserted.push({ index: p.index, case_ref: row.case_ref, id: row.id });
      } catch (e) {
        skipped.push({
          index: p.index,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Fire one real recompute per affected VC.
    const uniqueVcIds = Array.from(new Set(previewed.filter((p) => p.vc_id).map((p) => p.vc_id!)));
    for (const vc_id of uniqueVcIds) {
      try {
        await recomputeAndPersist({
          vcId: vc_id,
          trigger: "case_create",
          triggeredByPosition: entered_by_position,
        });
      } catch {
        // non-fatal — case rows are already committed
      }
    }

    return NextResponse.json({
      ok: true,
      mode: "commit",
      summary: {
        inserted: inserted.length,
        skipped: skipped.length,
        affected_vcs: uniqueVcIds.length,
      },
      inserted,
      skipped,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
