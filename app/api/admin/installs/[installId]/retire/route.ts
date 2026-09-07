/**
 * POST /api/admin/installs/{installId}/retire — unbind a Mac from a room (PRD §4.2, §4.5 rule 5).
 *
 * THE SAME SUPERSESSION THE ENROL EXCHANGE PERFORMS, done by hand. Setting `retired_at` takes the
 * row out of the partial unique index, so the room is free for a new install; and the next poll
 * carrying this `install_id` is answered 409 RETIRED, which is how the app on that Mac learns to
 * stop. It then writes `bench_listener` no more, so the new install owns the row (§4.5 rule 4).
 *
 * IT REMOVES NO SOFTWARE. §10.6 is explicit: retire marks a row. The app is still on that Mac and
 * still installed; it has simply been told it is no longer this room's recorder. Anyone reading
 * this route looking for a remote uninstall should stop here — that is not built and is out of
 * scope for the whole module.
 *
 * THE ROW IS KEPT. It is the only record that a Mac was ever bound to a room, and deleting it
 * would make the retired install's next poll a 404 — indistinguishable from "never enrolled",
 * which is exactly the state the app must not confuse this with.
 */
import { NextRequest, NextResponse } from "next/server";
import { installAdminGuard, installError, installErrorFrom, retireInstall } from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function POST(req: NextRequest, ctx: { params: Promise<{ installId: string }> }) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "admin or migration secret required" } },
      { status: 401, ...NO_STORE },
    );
  }

  const { installId } = await ctx.params;
  try {
    const install = await retireInstall(installId);
    if (!install) return installError("NOT_FOUND", "no such install, or it is already retired");
    return NextResponse.json({ install }, NO_STORE);
  } catch (e) {
    return installErrorFrom(e);
  }
}
