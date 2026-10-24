/**
 * GET /api/spine/transcript-final?after=<event_id>&limit=<n>&shadow=1 — the poll feed-orch reads (S7a). Bearer (SPINE_BEARER_TOKEN, as claim/report). Read-only; ids, counts, stamps, run ids and a sha256, never text.
 * Keyed by encounter_id with consult_uid / consult_key, room_id, ist_date, cut_version, the window and run ids, the four stamps; a newer cut_version is a new event. `next_after` is the cursor for the next poll.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkSpineBearer } from "@/lib/spine/auth";
import { readFinalEvents } from "@/lib/spine/transcript-final-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const bad = checkSpineBearer(req.headers);
  if (bad) return NextResponse.json({ ok: false, error: bad.error }, { status: bad.status });
  const p = req.nextUrl.searchParams;
  const num = (k: string): number | undefined => { const v = p.get(k); return v !== null && /^\d{1,12}$/.test(v) ? Number(v) : undefined; };
  try {
    return NextResponse.json({ ok: true, ...(await readFinalEvents({ after: num("after"), limit: num("limit"), shadow: p.get("shadow") === "1" })) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `db:${(e as { code?: string }).code ?? "unknown"}` }, { status: 503 });
  }
}
