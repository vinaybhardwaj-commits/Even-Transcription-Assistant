import { portalJson } from "@/lib/portal/forbidden-keys";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** My Reports (Ask B): the signed-in doctor's own submissions (named + confidential). */
export async function GET() {
  const p = await getCurrentPhysician();
  if (!p) return portalJson({ ok: false, error: "Unauthorized" }, { status: 401 });
  const BASE = process.env.INCIDENT_API_BASE;
  const TOK = process.env.INCIDENT_API_TOKEN;
  if (process.env.PORTAL_INCIDENTS !== "1" || !BASE || !TOK) {
    return portalJson({ ok: false, error: "Not enabled" }, { status: 404 });
  }
  try {
    const res = await fetch(`${BASE}/api/intake/portal/reports?external_ref=${encodeURIComponent(`epi:${p.physicianId}`)}`, {
      headers: { Authorization: `Bearer ${TOK}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    return portalJson(j, { status: res.status });
  } catch {
    return portalJson({ ok: false, error: "Incident system unreachable" }, { status: 502 });
  }
}
