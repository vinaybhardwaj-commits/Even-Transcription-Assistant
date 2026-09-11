/**
 * POST /api/admin/installs/{installId}/assign-channel — "Move to stable" from the fleet card
 * (Install and Fleet PRD, Release B2 addendum, B2-D5).
 *
 * ONE-WAY, AND THE BODY IS HOW IT SAYS SO. `{ "channel": "stable" }` is the only body this route
 * accepts; `test`, an empty body, or anything else is 400 BAD_CHANNEL. The server may take a Mac off
 * `test` but never put one on it — that stays a hand on the Mac (R3-8's valve, per Mac), and
 * migration 0079's CHECK refuses any other value even if this route were bypassed.
 *
 * IT MOVES NOTHING BY ITSELF. It writes `assigned_channel` on the install row; the next native poll
 * carries it back in its response, and the app (0.1.20 and later) applies it when its own channel
 * is not already `stable`. The card shows the assignment until the Mac reports `stable` itself —
 * the Mac's own report is the only proof it moved. An app below 0.1.20 ignores the key.
 *
 * Same guard and same 404 as the retire route: an unknown or retired install is NOT_FOUND.
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
  if (channel !== "stable") {
    return installError("BAD_CHANNEL", "channel must be \"stable\" — the server never assigns test");
  }

  const { installId } = await ctx.params;
  try {
    const assigned = await assignInstallChannel(installId, "stable");
    if (!assigned) return installError("NOT_FOUND", "no such install, or it is already retired");
    return NextResponse.json(assigned, NO_STORE);
  } catch (e) {
    return installErrorFrom(e);
  }
}
