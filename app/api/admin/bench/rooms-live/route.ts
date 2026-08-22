/**
 * GET /api/admin/bench/rooms-live — the SLOW poll (20 s) behind the live operator monitor.
 *
 * Everything that needs aggregation: today's sessions with per-source chunk freshness, the
 * doctor clock, the marks, the stall age, and the newest completeness marker. Twenty seconds
 * rather than three because these reads touch `cue` and `bench_chunk`, which a clinic day fills
 * with thousands of rows — and because none of these vitals changes meaningfully faster.
 *
 * The client does NOT poll to keep ages current. It recomputes every displayed age once a
 * second from the instants this route returns, so the wall clock ticks smoothly at one request
 * per twenty seconds rather than one per tick.
 *
 * Admin-gated, read-only, and it never throws: readRoomsLive guards each read separately, so a
 * fault degrades that section to empty and names itself while the rest of the monitor renders.
 */
import { NextResponse } from "next/server";
import { benchAdminGuard } from "@/lib/bench";
import { readRoomsLive } from "@/lib/admin/rooms-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };

export async function GET() {
  const guard = await benchAdminGuard();
  if (!guard.ok) return NextResponse.json({ error: { code: guard.code, message: guard.msg } }, { status: 401, ...noStore });

  try {
    return NextResponse.json(await readRoomsLive(new Date()), noStore);
  } catch (e) {
    // readRoomsLive is already fail-safe; this is the belt to that braces. An empty monitor with
    // a named reason, never a 500 — the operator must always get a screen.
    return NextResponse.json(
      {
        ist_date: "",
        now: new Date().toISOString(),
        rooms: [],
        degraded: [`rooms_live_unavailable:${String((e as Error)?.message ?? e).slice(0, 120)}`],
      },
      noStore,
    );
  }
}
