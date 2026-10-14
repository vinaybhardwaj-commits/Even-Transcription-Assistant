import { portalJson } from "@/lib/portal/forbidden-keys";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { loadPortalRoutedFindings } from "@/lib/document-audits-db";
import { toDocumentCards } from "@/lib/doctor-card";
import { disabledRead, findingsEnabled } from "@/lib/portal-flags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/portal/document-audits — the signed-in physician's document-audit findings that a doctor
 * may see (visibility is decided per finding in SQL: portal_visible, never the audit's stamp).
 *
 * ⚠️ THE RESPONSE IS AN ALLOWLIST. Each stored row is rebuilt as a doctor card by `toDocumentCards`,
 * the same card shape the live Findings list uses. Authors, external references, severities,
 * statuses and signal references are not read, so they cannot be shipped. A finding that is also on
 * the live list is left out here (answering it there avoids asking the doctor twice).
 * The answer is `{ ok, cards }` and nothing else.
 */
export async function GET() {
  const p = await getCurrentPhysician();
  if (!p) return portalJson({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!findingsEnabled()) return disabledRead();

  const rows = await loadPortalRoutedFindings(p.physicianId);
  return portalJson({ ok: true, cards: toDocumentCards(rows) });
}
