import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getHospitalFilter } from "@/lib/hospital-filter";
import { normalizePipeStatus, type PipeStatus } from "@/lib/document-audits";
import { loadRmoInbox } from "@/lib/document-audits-db";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/rmo-inbox — Stage 4 RMO authoring / triage pipe + SGC exception queue.
 * RMOs author findings; remediator = target physician (portal). No RMO-fixer assignee.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401, headers: NO_STORE });
  }

  const hospitalCode = await getHospitalFilter();
  const sp = request.nextUrl.searchParams;
  const pipeRaw = sp.get("pipe");
  const pipe = pipeRaw === "all" || !pipeRaw ? "all" : normalizePipeStatus(pipeRaw);
  const role = sp.get("role") === "sgc" ? "sgc" : "rmo";
  const q = sp.get("q") ?? "";

  const data = await loadRmoInbox({
    hospitalCode: hospitalCode === "all" ? null : hospitalCode,
    pipe: (pipe ?? "all") as PipeStatus | "all",
    physicianQuery: q,
  });

  const canSgc = !!(user.is_super_admin || user.is_sgc_member);

  return NextResponse.json(
    {
      ok: true,
      role: canSgc && role === "sgc" ? "sgc" : "rmo",
      can_sgc: canSgc,
      hospital_code: hospitalCode,
      headline: data.headline,
      pipe_counts: data.pipe_counts,
      items: data.items,
      exceptions: data.exceptions,
      doctors: data.doctors,
      // Explicit product lock — surfaced so UI never invents an assignee picker.
      remediator_model: "target_physician_portal",
      author_model: "rmo_attribution_required",
    },
    { headers: NO_STORE },
  );
}
