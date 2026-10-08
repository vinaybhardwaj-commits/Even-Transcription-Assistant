/**
 * GET /api/rooms-live/now — the Rooms Live screen's one read (SPEC-v1 §2, AMENDMENT 2). Open access (owner ruling 8 Oct 2026; lib/rooms-live/guard.ts never denies), no-store.
 * Reads only, with ONE exception: a claim whose room is back in listening/quiet (or has no doctor) is cleared with by="auto", at most once per room per minute per
 * instance (lib/rooms-live/claims.ts). Never a 500: a failed read is named in `degraded` and its rooms come back "unknown".
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { roomsLiveGuard } from "@/lib/rooms-live/guard";
import { realClaimsPort } from "@/lib/rooms-live/claims";
import { ROOMS } from "@/lib/rooms-live/rooms";
import { loadRoster } from "@/lib/rooms-live/roster";
import { getSnapshot, type Snapshot } from "@/lib/rooms-live/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request) {
  await roomsLiveGuard(req); // always ok: access is open (owner ruling 8 Oct 2026)
  try {
    return NextResponse.json(await getSnapshot({ db: sql, claims: realClaimsPort(sql as never) }), { headers: NO_STORE });
  } catch (e) {
    console.error("[rooms-live] snapshot failed:", e instanceof Error ? e.message.slice(0, 160) : "error");
    const empty: Snapshot = {
      generated_at: new Date().toISOString(),
      degraded: ["snapshot"],
      steward_status: { state: "unavailable" },
      changes_today: [],
      rooms: (await loadRoster(sql as never).catch(() => ROOMS)).map((r) => ({
        room_id: r.room_id,
        label: r.label,
        doctor: null,
        doctor_known: false,
        state: "unknown",
        state_since: null,
        detail_code: "source_unavailable",
        level: { rms: null, zero: null, at: null, stale: true },
        baseline_rms: null,
        device: { name: null, missing: false },
        session: { open: false, since: null, chunk_age_s: null },
        steward: null,
        steward_line: null,
        steward_log: [],
        claim: null,
        ages_s: { listener: null, heartbeat: null, ext: null },
      })),
    };
    return NextResponse.json(empty, { headers: NO_STORE });
  }
}
