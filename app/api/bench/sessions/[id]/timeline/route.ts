/**
 * GET /api/bench/sessions/{id}/timeline — timeline.md alone (Ambient Brain Kickoff D,
 * decision D1: generated on download, every time; nothing stored). Admin-gated, same
 * pattern as the manifest route. text/markdown, filename timeline.md.
 *
 * Generation never 500s: lib/bench-timeline degrades per source (marks / brain picture)
 * and, at worst, returns the header + "*timeline unavailable*".
 */
import { NextRequest, NextResponse } from "next/server";
import { respondError } from "@/lib/respond";
import { benchAdminGuard, findBenchSession } from "@/lib/bench";
import { renderBenchTimeline } from "@/lib/bench-timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);
  if (!id.startsWith("bs_")) return respondError("VALIDATION_FAILED", "bad_session_id");

  const session = await findBenchSession(id);
  if (!session) return respondError("NOT_FOUND", "session_not_found");

  const { markdown } = await renderBenchTimeline(id, session);
  return new NextResponse(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="timeline.md"',
      "Cache-Control": "no-store",
    },
  });
}
