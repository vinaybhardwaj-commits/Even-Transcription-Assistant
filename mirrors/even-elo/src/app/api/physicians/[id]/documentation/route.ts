import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { loadPhysicianDocumentation } from "@/lib/document-audits-db";
import { adherencePresentation } from "@/lib/overview-modules";
import { loadAdherenceInputs } from "@/lib/document-audits-db";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/physicians/[id]/documentation — Stage 4 physician Documentation section.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401, headers: NO_STORE });
  }

  const id = params.id;
  if (!id) {
    return NextResponse.json({ ok: false, error: "missing id" }, { status: 400, headers: NO_STORE });
  }

  const { headline, events } = await loadPhysicianDocumentation(id);
  const adherence = adherencePresentation(await loadAdherenceInputs());

  return NextResponse.json(
    {
      ok: true,
      physician_id: id,
      headline,
      events,
      adherence: {
        state: adherence.state,
        label: adherence.label,
        percent: adherence.percent,
        detail: adherence.detail,
      },
    },
    { headers: NO_STORE },
  );
}
