/**
 * GET /api/admin/bench/fleet — the card's only read (PRD §4.2, §6, D13).
 *
 * ONE ROUTE FEEDS BOTH CADENCES. The fleet table polls it every 20 s and the open checklist polls
 * it every 3 s, and there is no second endpoint for the checklist because there is no second
 * question: the five steps are derived from the same install row the table renders. A separate
 * per-install route would be a second place for the same truth to come from.
 *
 * That is why each row carries three installs, not one. `install` is the bound Mac — enrolled and
 * not retired, at most one by the partial unique index. `pending` is a minted token's install,
 * which is what the checklist watches between the copy and the first poll, and which the table
 * shows as `enrolling` rather than as nothing. `last_retired` is what makes §6's `retired` state
 * mean something: a room that HAD a Mac reads differently from one that never did.
 *
 * READ-ONLY AND FAIL-SAFE, the readRoomsLive convention. `readFleet` guards the room read, the
 * install read and the release read separately and names whichever failed in `degraded`, so a
 * fault in one leaves the rest of the card standing. An operator must always get a screen.
 */
import { NextRequest, NextResponse } from "next/server";
import { installAdminGuard, readFleet } from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: NextRequest) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "admin or migration secret required" } },
      { status: 401, ...NO_STORE },
    );
  }

  try {
    return NextResponse.json(await readFleet(new Date()), NO_STORE);
  } catch (e) {
    // readFleet is already fail-safe per section; this is the belt to that braces. An empty card
    // with a named reason, never a 500.
    return NextResponse.json(
      {
        now: new Date().toISOString(),
        rows: [],
        latest_release: null,
        degraded: [`fleet_unavailable:${String((e as Error)?.message ?? e).slice(0, 120)}`],
      },
      NO_STORE,
    );
  }
}
