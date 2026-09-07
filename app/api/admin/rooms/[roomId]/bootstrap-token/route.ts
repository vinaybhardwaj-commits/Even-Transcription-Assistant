/**
 * POST /api/admin/rooms/{roomId}/bootstrap-token — mint the one-liner (PRD §4.2, D9).
 *
 * This is the whole install, from the operator's side. The route creates the `room_install` row
 * and the `room_bootstrap_token` row in one transaction and returns the exact command string the
 * page puts on the clipboard. The page COPIES THAT STRING WITHOUT CHANGING IT — the command is
 * assembled here, once, by `installCommand`, so the card cannot drift from the route that has to
 * honour it.
 *
 * THE SAME ACTION RE-ENROLS A ROOM. There is no separate re-enrol route and there should not be:
 * a new token retires the old install at the enrol exchange (§4.5 rule 2), so "install" and
 * "re-install" are one paste with one meaning. The `bootout` line in the script stops the earlier
 * copy before its bundle is replaced.
 *
 * NO RELEASE, NO TOKEN — 409 NO_RELEASE. The script this token would fetch substitutes a Blob URL
 * and a sha256 from the published release. Handing an operator a command that can only produce a
 * failed download is worse than refusing, because they would carry it to the room first.
 *
 * THE TOKEN IS RETURNED IN THE CLEAR, once, to the admin who minted it. It is the credential; it
 * has a 30-minute life and one use, and it is never shown again — a second Copy mints a second
 * token and a second install row.
 */
import { NextRequest, NextResponse } from "next/server";
import { installAdminGuard, installErrorFrom, mintBootstrapToken } from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function POST(req: NextRequest, ctx: { params: Promise<{ roomId: string }> }) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "admin or migration secret required" } },
      { status: 401, ...NO_STORE },
    );
  }

  const { roomId } = await ctx.params;

  // NO CHANNEL PARAMETER. §4.2 gives this route no request at all, and an unratified `?channel=`
  // would have been a real inconsistency rather than a harmless extra: the token row has no
  // channel column to carry the choice, so the bootstrap fetch — which reads the release at FETCH
  // time, minutes later — would have served a stable script for a token minted against test. One
  // channel on this path, and it is the published stable release.
  try {
    const minted = await mintBootstrapToken({ roomId, createdBy: guard.adminId });
    return NextResponse.json(
      {
        token: minted.token,
        install_id: minted.install_id,
        command: minted.command,
        expires_at: minted.expires_at,
        room: minted.room,
        release: { id: minted.release.id, version: minted.release.version, channel: minted.release.channel },
      },
      { status: 201, ...NO_STORE },
    );
  } catch (e) {
    return installErrorFrom(e);
  }
}
