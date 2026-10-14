import { NextRequest, NextResponse } from "next/server";
import { requireOps } from "@/lib/ops-auth";
import { sql } from "@/lib/db";
import { computeMapping } from "@/lib/cdmss-mapping-service";
import type { MappingResult } from "@/lib/cdmss-doctor-mapping";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Populate physicians.cdmss_doctor_uid (PRD §6.5) by matching EVERY active physician against the
 * canonical CDMSS roster (GET /api/governance/doctor-directory). F1 rewrite: the old version only
 * considered doctors who appeared in an OPD cohort signal's top-5 `affected[]`.
 *
 *   GET            dry run: before/after coverage, what would be linked, the review list. Writes nothing.
 *   POST           apply the AUTO links only (exact-unique name, or name + mobile last-4).
 *   POST ?dry_run=1  identical to GET (so a client can rehearse the exact request it will send).
 *
 * Weaker matches (ambiguous, mobile mismatch, partial name) are returned as `review` for governance
 * staff to resolve; they are never applied and never doctor-facing. super_admin only.
 */

async function compute(): Promise<MappingResult & { directory_count: number }> {
  return computeMapping();
}

function view(r: MappingResult & { directory_count: number }) {
  return {
    directory_count: r.directory_count,
    coverage: r.coverage,
    already_linked: r.already_linked,
    would_link: r.auto,
    alias_updates: r.alias_updates,
    review: r.review,
    unmatched: r.unmatched,
  };
}

export async function GET(req: Request) {
  const denied = await requireOps(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, mode: "dry_run", ...view(await compute()) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "directory_unavailable", message: e instanceof Error ? e.message : "failed" },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireOps(req);
  if (denied) return denied;
  let r: MappingResult & { directory_count: number };
  try {
    r = await compute();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "directory_unavailable", message: e instanceof Error ? e.message : "failed" },
      { status: 502 },
    );
  }
  if (req.nextUrl.searchParams.get("dry_run") === "1") {
    return NextResponse.json({ ok: true, mode: "dry_run", ...view(r) });
  }

  let applied = 0;
  const failed: Array<{ uid: string; physician_id: string; error: string }> = [];
  for (const m of r.auto) {
    try {
      // A physician is only written when unlinked, or when moving from one of this doctor's aliases
      // to the canonical uid. Never overwrites a link to some other uid.
      const selfAndAliases = [m.uid, ...m.alias_uids];
      const rows = (await sql`
        UPDATE physicians
        SET cdmss_doctor_uid = ${m.uid}, cdmss_alias_uids = ${m.alias_uids}::text[]
        WHERE id = ${m.physician_id}::uuid
          AND (cdmss_doctor_uid IS NULL OR cdmss_doctor_uid = ANY(${selfAndAliases}::text[]))
        RETURNING id`) as unknown as Array<{ id: string }>;
      if (rows.length > 0) applied += 1;
      else failed.push({ uid: m.uid, physician_id: m.physician_id, error: "physician_changed_since_preview" });
    } catch (e) {
      failed.push({ uid: m.uid, physician_id: m.physician_id, error: e instanceof Error ? e.message.slice(0, 120) : "update_failed" });
    }
  }
  let aliasesUpdated = 0;
  for (const u of r.alias_updates) {
    try {
      await sql`UPDATE physicians SET cdmss_alias_uids = ${u.alias_uids}::text[]
                WHERE id = ${u.physician_id}::uuid AND cdmss_doctor_uid = ${u.uid}`;
      aliasesUpdated += 1;
    } catch {
      // Best effort: an alias list that did not update is retried on the next run.
    }
  }
  try {
    await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
              VALUES ('cdmss_mapping_applied', 'physicians', 'bulk',
              ${JSON.stringify({
                applied,
                failed: failed.length,
                aliases_updated: aliasesUpdated,
                review: r.review.length,
                unmatched: r.unmatched.length,
                coverage_before: r.coverage.before,
                coverage_after: r.coverage.after,
              })}::jsonb)`;
  } catch {
    // The links are already written; losing the log row costs nothing else.
  }
  return NextResponse.json({
    ok: true,
    mode: "apply",
    applied,
    failed,
    aliases_updated: aliasesUpdated,
    coverage: r.coverage,
    review: r.review,
    unmatched: r.unmatched,
  });
}
