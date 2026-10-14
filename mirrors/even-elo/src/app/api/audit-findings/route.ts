import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { loadSyncFlags, loadWorklistRows } from "@/lib/audit-findings-server";
import { loadPendingRulings } from "@/lib/audit-ruling";
import { annotatePendingRulings, annotateSync, applyFilters, countBuckets, countNotSynced, parseFilters, sortRows, NOTE_CLASS_LABEL, STATUSES } from "@/lib/audit-findings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/audit-findings — the governance worklist: every routed audit thread across doctors.
 *
 * Staff only (super_admin, Site Medical Head, Site Governance Officer). A doctor's portal session is
 * a different cookie and gets 401; a staff session without the role gets 403.
 *
 * Query: view=attention|overdue|disagreed|awaiting_ruling|awaiting_doctor|all (default attention),
 * status, importance, response_required, note_class, doctor_uid, from, to (routed date, YYYY-MM-DD).
 * Counts are over the whole set, so the bucket tiles do not change when a filter is applied.
 * `sync` = { not_synced, failed, rulings_pending }: threads whose doctor answer has not reached CDMSS
 * (each such row carries `sync`) and threads with a saved ruling CDMSS has not confirmed (each such row
 * carries `pending_ruling`). Zeros when migrations 038/040 are not applied.
 */
export async function GET(req: NextRequest) {
  const gate = await requireStaff("view");
  if (!gate.ok) return gate.response;

  const loaded = await loadWorklistRows();
  if (!loaded.ok) {
    return NextResponse.json(
      { ok: false, error: "cdmss_unavailable", message: "CDMSS did not answer. The worklist cannot be shown right now." },
      { status: 502 },
    );
  }
  // Doctor answers that CDMSS does not have yet are flagged per thread and counted over the whole set.
  const pendingRulings = new Map<string, { action: string; attempts: number; since: string | null }>();
  for (const p of await loadPendingRulings(500)) {
    if (!pendingRulings.has(p.reference)) pendingRulings.set(p.reference, { action: p.action, attempts: p.attempts, since: p.created_at });
  }
  const all = annotatePendingRulings(annotateSync(loaded.rows, await loadSyncFlags()), pendingRulings);
  const filters = parseFilters(req.nextUrl.searchParams);
  const rows = sortRows(applyFilters(all, filters));

  // Filter choices come from the data, so the dropdowns only offer values that exist.
  const doctors = new Map<string, string>();
  const importances = new Set<string>();
  const responseRequired = new Set<string>();
  for (const r of all) {
    if (!doctors.has(r.doctor_uid)) doctors.set(r.doctor_uid, r.doctor_name ?? r.doctor_uid);
    if (r.importance) importances.add(r.importance);
    responseRequired.add(r.response_required);
  }

  return NextResponse.json({
    ok: true,
    filters,
    counts: countBuckets(all),
    sync: countNotSynced(all),
    rows,
    options: {
      doctors: Array.from(doctors.entries())
        .map(([uid, name]) => ({ uid, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      importances: Array.from(importances).sort(),
      response_required: Array.from(responseRequired).sort(),
      statuses: [...STATUSES],
      note_classes: Object.entries(NOTE_CLASS_LABEL).map(([value, label]) => ({ value, label })),
    },
  });
}
