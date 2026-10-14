import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { fetchOpdSignals } from "@/lib/gov-signals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side proxy to the CDMSS Governance Signals API (PRD v1.4 §6.1).
 * GOV_API_KEY never reaches the browser. Access = any active governance user
 * (V ruling 2 Jul: platform access is site-scoped, not module-scoped).
 */
export async function GET(req: NextRequest) {
  const u = await getCurrentUser();
  if (!u || u.status !== "active") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  try {
    const payload = await fetchOpdSignals({
      day: sp.get("day") || undefined,
      period: sp.get("period") || undefined,
      baselineDays: sp.get("baselineDays") ? Number(sp.get("baselineDays")) : undefined,
    });
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "CDMSS fetch failed" },
      { status: 502 },
    );
  }
}
