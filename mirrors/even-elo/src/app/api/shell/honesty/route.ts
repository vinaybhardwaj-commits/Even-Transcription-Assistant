import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { shellBadgeModel } from "@/lib/overview-modules";
import { loadStage2Counts } from "@/lib/stage2-counts";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * Sidebar honesty badges. Proposed surfaces carry a null volume.
 * OPD stale and ELO empty are omitted when the database cannot be read.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401, headers: NO_STORE });
  }
  const db = await loadStage2Counts();
  const badges = shellBadgeModel(db);
  return NextResponse.json(
    {
      ok: true,
      documentAudits: badges.documentAudits,
      rmo: badges.rmo,
      opd: badges.opd,
      elo: badges.elo,
    },
    { headers: NO_STORE },
  );
}
