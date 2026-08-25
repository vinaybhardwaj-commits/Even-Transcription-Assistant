/**
 * GET /api/admin/bench/listeners — the FAST poll (3 s) behind the live operator monitor.
 *
 * One question only: is a kiosk page open in each room, and is it paused. That is the thing an
 * operator can act on within seconds, and it is one small table (bench_listener, PRIMARY KEY on
 * room_id) joined to `room`, so a 3 s cadence across a handful of rooms is cheap. Everything
 * that needs cue or chunk aggregation is on the 20 s route instead.
 *
 * THREE STATES AND A FAILURE (listenerState): never / stale / listening / unknown. A read that
 * FAILED is `unknown`, never `never` — sending an operator to open a page that is already open
 * costs them the one thing they have least of on a clinic day.
 *
 * Admin-gated by benchAdminGuard, like every /api/admin route. Read-only: this handler issues no
 * write of any kind. It never throws — a bus fault degrades to unknown listeners and a named
 * `degraded` entry, so the monitor keeps rendering.
 */
import { NextResponse } from "next/server";
import { benchAdminGuard } from "@/lib/bench";
import { listListeners, isListening, LISTENER_FRESH_MS, classifyBusError, BusError } from "@/lib/bench-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };

/** A stored level pair → the wire shape, or null where it was never measured. Tolerant on
 *  purpose: a row written before migration 0066 has no columns at all and must read as null
 *  rather than as zero, which the page would draw as an empty bar over a working microphone. */
function levelsOf(peak: unknown, avg: unknown): { peak: number; avg: number } | null {
  const n = (v: unknown): number | null => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : null;
  };
  const p = n(peak);
  const a = n(avg);
  return p === null && a === null ? null : { peak: p ?? 0, avg: a ?? 0 };
}

export async function GET() {
  const guard = await benchAdminGuard();
  if (!guard.ok) return NextResponse.json({ error: { code: guard.code, message: guard.msg } }, { status: 401, ...noStore });

  const now = new Date();
  try {
    const rows = await listListeners(now);
    return NextResponse.json(
      {
        now: now.toISOString(),
        freshness_window_ms: LISTENER_FRESH_MS,
        listeners: rows.map((l) => ({
          room_id: l.room_id,
          room_slug: l.slug,
          room_name: l.name,
          // listListeners already computes `listening` with the bus's own rule; isListening is
          // called here too so the two can never disagree about one row.
          listening: isListening(l, now),
          age_ms: l.age_ms,
          paused: l.paused,
          recording_session_id: l.recording_session_id,
          tab_id: l.tab_id,
          last_poll_at: new Date(l.last_poll_at).toISOString(),
          // §2.2 — what the microphones heard since this room's previous poll. NULL travels as
          // null all the way to the card, which renders NO BAR for it: not measured is not the
          // same fact as silent, and only one of them is a reason to walk to a room.
          mic: levelsOf(l.mic_peak, l.mic_avg),
          spare: levelsOf(l.spare_peak, l.spare_avg),
          levels_at: l.levels_at ? new Date(l.levels_at).toISOString() : null,
        })),
      },
      noStore,
    );
  } catch (e) {
    // A bus fault is UNKNOWN, not "no kiosk". The client reads an empty list with a degraded
    // reason as unknown for every room rather than as a room-wide alarm.
    const b = e instanceof BusError ? e : classifyBusError(e);
    return NextResponse.json(
      { now: now.toISOString(), freshness_window_ms: LISTENER_FRESH_MS, listeners: [], degraded: [`listeners_unavailable:${b.code}`] },
      noStore,
    );
  }
}
