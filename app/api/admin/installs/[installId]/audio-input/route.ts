/**
 * POST /api/admin/installs/{installId}/audio-input — switch a room's recording device or set its
 * input volume from the fleet card (Install and Fleet PRD, Release R4 addendum, R4-D5).
 *
 * BODY = THE COMMAND'S ARGS. `{ device_uid?: string, input_volume?: number 0..1 }`, at least one,
 * nothing else — `parseSetAudioInputArgs` in lib/bench-commands.ts, the same validator the MCP tool
 * and `insertCommand` use. Anything else is 400 BAD_ARGS and the database is never touched.
 *
 * IT DOES NOT TALK TO A MAC. It resolves the install's room (404 for an unknown, unenrolled or retired
 * install — no command is written), refuses 409 APP_TOO_OLD `{ error: { code, message, app_version } }`
 * unless that install reports 0.1.21 or later (R4-D11 — again, nothing written), puts ONE `set_audio_input` on the bench bus with source `admin`,
 * and waits up to ACK_WAIT_MS for the room's app to ack it:
 *   · acked or failed → 200 `{ command: { id, status, result, error } }`; a failure's `error` is the
 *     app's own reason (`device_not_present`, `volume_not_settable`, …) and the card prints it
 *   · no ack in time → 504 ACK_TIMEOUT, with the command id so the card can look again. The row
 *     stays pending; if it was never delivered, the room's next poll after 15 s expires it unread.
 * The card's device and volume text come from the app's next poll, never from this answer — the
 * rule the fleet card is built around.
 *
 * No listener check, by the kickoff (the MCP tool has one): a room with no app polling times out
 * here as ACK_TIMEOUT, and its command expires unread on the next poll.
 *
 * Same guard and error envelope as assign-channel.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  ACK_WAIT_MS,
  audioInputRefusal,
  BusError,
  CommandArgsError,
  insertCommand,
  parseSetAudioInputArgs,
  waitForAck,
  type SetAudioInputArgs,
} from "@/lib/bench-commands";
import {
  boundInstallRoom,
  INSTALL_ERROR_STATUS,
  installAdminGuard,
  installError,
  installErrorFrom,
} from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The ack wait is ACK_WAIT_MS (8 s) plus a few short reads; the ceiling leaves room for both.
export const maxDuration = 30;

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
  let args: SetAudioInputArgs;
  try {
    args = parseSetAudioInputArgs(body);
  } catch (e) {
    if (e instanceof CommandArgsError) return installError("BAD_ARGS", e.reason);
    throw e;
  }

  const { installId } = await ctx.params;
  try {
    const bound = await boundInstallRoom(installId);
    if (!bound) return installError("NOT_FOUND", "no such install, or it is not bound (never enrolled, or retired)");

    // R4-D11. An app below 0.1.21 cannot decode the kind; a row handed to it blocks the room's bus.
    // Refused here, before the insert, with the version the Mac last reported.
    const tooOld = audioInputRefusal(bound.app_version);
    if (tooOld) return NextResponse.json({ error: tooOld }, { status: INSTALL_ERROR_STATUS.APP_TOO_OLD, ...NO_STORE });

    const id = await insertCommand({ roomId: bound.room_id, kind: "set_audio_input", args, source: "admin" });
    const row = await waitForAck(id, { timeoutMs: ACK_WAIT_MS });
    if (!row) {
      return NextResponse.json(
        {
          error: {
            code: "ACK_TIMEOUT",
            message: `no ack from the room within ${ACK_WAIT_MS / 1000} s; command ${id} is still pending`,
          },
          command: { id, status: "pending", result: null, error: null },
        },
        { status: 504, ...NO_STORE },
      );
    }
    return NextResponse.json(
      { command: { id: row.id, status: row.status, result: row.result ?? null, error: row.error ?? null } },
      NO_STORE,
    );
  } catch (e) {
    // The bus's own faults say which: not migrated, or down (with the database's reason, ≤200).
    if (e instanceof BusError) {
      return installError("STORE_UNAVAILABLE", e.cause_message ? `${e.code}: ${e.cause_message}` : e.code);
    }
    return installErrorFrom(e);
  }
}
