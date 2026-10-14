import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Anonymous reference-code lookup (Ask C): status-only, no identity. */
export async function GET(req: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return portalJson({ ok: false, error: "Unauthorized" }, { status: 401 });
  const BASE = process.env.INCIDENT_API_BASE;
  const TOK = process.env.INCIDENT_API_TOKEN;
  if (process.env.PORTAL_INCIDENTS !== "1" || !BASE || !TOK) {
    return portalJson({ ok: false, error: "Not enabled" }, { status: 404 });
  }
  const ref = (req.nextUrl.searchParams.get("ref") || "").trim().toUpperCase();
  // A1-D28: the unit prefix is per-site (EHRC, EHBR, EHIN, EHBO, EHSB), so the
  // guard matches any four-letter unit. Narrower than this and four hospitals'
  // reporters would be told their own reference is malformed.
  if (!/^[A-Z]{4}-INC-\d{4}-\d{1,6}$/.test(ref)) {
    return portalJson({ ok: false, error: "Reference looks like EHRC-INC-2026-0001" }, { status: 400 });
  }
  try {
    const res = await fetch(`${BASE}/api/intake/portal/reports/by-reference/${encodeURIComponent(ref)}`, {
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
