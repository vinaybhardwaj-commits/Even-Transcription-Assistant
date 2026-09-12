/**
 * POST /api/admin/installs/{installId}/assign-channel — "Move to stable" from the fleet card
 * (Install and Fleet PRD, Release B2 addendum, B2-D5), and since Tier 1 §3 "move to test".
 *
 * TWO BODIES, AND ONLY TWO. `{ "channel": "stable" }` or `{ "channel": "test" }`; an empty body or
 * anything else is 400 BAD_CHANNEL, and migration 0081's CHECK refuses any other value even if this
 * route were bypassed. B2 made this one-way; Tier 1's D1 (amended) lets the server assign `test`,
 * and puts the valve back on the Mac as `channel_locked` in its own config.json — a locked Mac
 * ignores every assignment and says so on its poll.
 *
 * IT MOVES NOTHING BY ITSELF. It writes `assigned_channel` on the install row; the next native poll
 * carries it back in its response. A 0.1.22 app applies either value unless its channel is locked;
 * a 0.1.20 or 0.1.21 app applies only `stable`, so `test` is inert there (and CHANNEL_DRIFT names
 * it after thirty minutes); an app below 0.1.20 ignores the key. The assignment clears itself on the
 * poll where the Mac reports the assigned channel — the Mac's own report is the only proof it moved.
 *
 * Same guard and same 404 as the retire route: an unknown or retired install is NOT_FOUND.
 *
 * TIER 2 §2.1 — `test` is refused with 409 APP_TOO_OLD when the bound Mac reports below 0.1.22,
 * because a 0.1.20/0.1.21 app applies only `stable` and the assignment would sit inert (OPD 6,
 * 12 Sep: taken at 04:57:30Z, never consumed, cleared by hand at 05:08:47Z). `stable` is never
 * gated — the rollback path must not depend on a version floor. §2.2 — the guard's `adminId` is
 * carried into the `install.assign_channel` audit row as the actor.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  assignInstallChannel,
  installAdminGuard,
  installError,
  installErrorFrom,
} from "@/lib/room-install";

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

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const channel = (body as { channel?: unknown } | null)?.channel;
  if (channel !== "stable" && channel !== "test") {
    return installError("BAD_CHANNEL", "channel must be \"stable\" or \"test\"");
  }

  const { installId } = await ctx.params;
  try {
    const assigned = await assignInstallChannel(installId, channel, guard.adminId);
    if (!assigned) return installError("NOT_FOUND", "no such install, or it is already retired");
    return NextResponse.json(assigned, NO_STORE);
  } catch (e) {
    return installErrorFrom(e);
  }
}
