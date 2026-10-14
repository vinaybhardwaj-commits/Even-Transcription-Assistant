/**
 * /api/admin/build-stay-library — build (and optionally store) the ClinicalState library for ONE
 * stay (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P2).
 *
 * ⚠️ NOT IN THE §7 P2 FILE CONTRACT — flagged in the P2 report. The contract lists the library
 * module, the migration and its admin route, and gives the CONSUMER to P3 ("lib/ipd-audit/run.ts —
 * consume library"). That leaves P2 with no way to put a row in the table, and two things in the PRD
 * need one before P3 exists: acceptance §8 #6 and #7 are claims about ROWS, and P4's gate is a HARD
 * HUMAN one — "the orchestrator samples P2 extracts and confirms span-cleanliness on the promote
 * fields" (§9) — which cannot be done against an empty table. This route is that sampling door.
 *
 * DRY RUN IS THE DEFAULT. Without `write: true` nothing is stored: the stay is fetched, built and
 * reported, and the table is untouched. That is the mode the orchestrator uses to read the span
 * report before deciding anything, and it is the right default for a module nothing consumes yet.
 *
 * WHAT IT CANNOT DO. It reads `ipd_discharge_audits` (three id columns), the discharge extract store
 * and the three db13 template tables; it writes `clinical_states` and nothing else. It runs no
 * model, triggers no audit, and moves no score — a stay-level re-audit is P3's job under its own
 * named engine version (O11), and P2 does not rescore anything (programme table §2).
 *
 * Auth: the ipd-audit-feedback pattern — ADMIN_TOKEN (Bearer / ?token=) OR an admin session.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { buildStayLibraryForAudit, spanReport } from '@/lib/stay-library/build';
import { stayDocMetaOf } from '@/lib/stay-library/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const isAuditId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const auditId = String(body.audit_id ?? '').trim();
  if (!isAuditId(auditId)) return NextResponse.json({ ok: false, error: 'bad audit id' }, { status: 400 });
  // Storing is opt-in and explicit. A typo cannot write the library.
  const write = body.write === true;

  const built = await buildStayLibraryForAudit({ auditId, write });
  if (!built.ok) return NextResponse.json({ ok: false, error: built.error }, { status: built.status });

  const { result } = built;
  return NextResponse.json({
    ok: true,
    dryRun: !write,
    encounterRef: result.encounterRef,
    coverage: result.coverage,
    // Enough per document to audit the build without shipping the states themselves back: the
    // stored text is de-identified but it is still clinical content, and a report is not a viewer.
    documents: result.documents.map((d) => {
      const meta = stayDocMetaOf(d.state);
      return {
        docKind: d.docKind,
        sourceUid: d.sourceUid,
        status: d.status,
        ...(d.reason ? { reason: d.reason } : {}),
        lookedFor: meta?.lookedFor ?? null,
        at: meta?.at ?? null,
        positives: d.state.positives.length,
        procedures: d.state.procedures?.length ?? 0,
        medications: d.state.medicationAssertions.length,
        missingCriticalData: d.state.missingCriticalData,
      };
    }),
    spans: spanReport(result.documents),
    written: result.written,
    notes: result.notes,
  });
}
