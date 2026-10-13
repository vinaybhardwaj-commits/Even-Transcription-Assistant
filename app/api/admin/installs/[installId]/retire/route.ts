/**
 * POST /api/admin/installs/{installId}/retire — unbind a Mac from a room (PRD §4.2, §4.5 rule 5).
 *
 * THE MANUAL FORM OF A SUPERSESSION (the automatic one is the first-poll handover in lib/room-install.ts, not the enrol exchange). Setting `retired_at` takes the
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
import {
  LIVE_INSTALL_MS,
  installAdminGuard,
  installError,
  installErrorFrom,
  retireInstall,
  roomOfInstall,
} from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };

/**
 * gating/opd4-guard S1. An install that polled in the last 10 minutes is LIVE and is refused (409 INSTALL_LIVE) unless the body says `{"force": true,
 * "confirm_room": "<the room's name>"}`: the confirm step the Retire button shows. The name is checked HERE as well as in the page, so a script cannot force by
 * accident. Every retirement writes an `install.retire` audit row (actor, install, room, reason, last-seen age) and queues an alert.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ installId: string }> }) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "admin or migration secret required" } },
      { status: 401, ...NO_STORE },
    );
  }

  const { installId } = await ctx.params;
  let body: { force?: unknown; confirm_room?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as typeof body;
  } catch {
    return installError("BAD_ARGS", "body must be JSON: { force?: boolean, confirm_room?: string }");
  }
  const force = body.force === true;

  try {
    if (force) {
      const room = await roomOfInstall(installId);
      if (!room) return installError("NOT_FOUND", "no such install, or it is already retired");
      const typed = typeof body.confirm_room === "string" ? body.confirm_room.trim().toLowerCase() : "";
      if (!typed || (typed !== room.name.trim().toLowerCase() && typed !== room.slug.toLowerCase())) {
        return installError("BAD_ARGS", "a forced retire needs confirm_room to be the room's name");
      }
    }
    const out = await retireInstall(installId, { actor: guard.adminId, force });
    if (!out.ok) {
      if (out.code === "LIVE") {
        const mins = Math.max(0, Math.floor(out.last_seen_age_s / 60));
        return installError(
          "INSTALL_LIVE",
          `this install polled ${mins} min ago (live means within ${LIVE_INSTALL_MS / 60_000} min); retire needs force and the room's name`,
        );
      }
      return installError("NOT_FOUND", "no such install, or it is already retired");
    }
    return NextResponse.json({ install: out.install, reason: out.reason, last_seen_age_s: out.last_seen_age_s }, NO_STORE);
  } catch (e) {
    return installErrorFrom(e);
  }
}
