/**
 * POST /api/admin/bench/command — the monitor's ONLY write.
 *
 * Queues one kiosk command (start_day | pause_day | resume_day | end_day) on the existing bus.
 * It does not talk to a kiosk, does not touch bench_session, and does not decide anything on its
 * own: `start` is put through decideStart from lib/bench-commands.ts, which is the same function
 * scribe_start_recording uses. A second implementation of that decision is how the admin surface
 * and the MCP would start disagreeing about whether a room is already recording.
 *
 * WHAT IT REFUSES, BY NAME:
 *   kiosk_not_listening   no live kiosk tab — a queued start would expire unseen
 *   room_paused           consent pause, and no override was asked for
 *   already_recording     idempotent; the live session id is returned, never a second tape
 *
 * Stop takes two clicks in the UI, not here: confirmation is a property of the surface, and a
 * route that demanded a magic word would only be a worse version of the same idea.
 *
 * Admin-gated by benchAdminGuard. Every failure is a named JSON error, never a 500.
 *
 * AUDITED (22 Aug 2026): every command that reaches the bus writes one `bench.command`
 * audit_log row against the room, carrying the kind, the outcome, and override_pause —
 * see auditCommand below for why that flag is recorded even when it is false.
 */
import { NextResponse } from "next/server";
import { benchAdminGuard } from "@/lib/bench";
import { sql } from "@/lib/db";
import {
  COMMAND_KINDS,
  BusError,
  classifyBusError,
  decideStart,
  findActiveSession,
  getListener,
  insertCommand,
  type CommandKind,
} from "@/lib/bench-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status, ...noStore });

/**
 * The monitor's only write is also the only admin action that can start, pause or STOP a
 * live clinic recording, and until 22 Aug 2026 it left no trace at all. The row is written
 * for every outcome that reached the bus — queued, and the idempotent already_recording —
 * because "who stopped OPD-3, and when" is a question the audit log has to be able to answer.
 *
 * override_pause is recorded EXPLICITLY, and on every command rather than only on start.
 * It is the flag that overrides a CONSENT pause: a start that ran with it is a materially
 * different act from one that did not, and a metadata blob that omitted it when false would
 * make the two indistinguishable after the fact.
 *
 * Best-effort, like every other audit write in the app: a failed audit insert must never
 * turn a working stop button into a 503 in the middle of a recording day.
 */
async function auditCommand(
  adminId: string,
  roomId: string,
  kind: CommandKind,
  overridePause: boolean,
  outcome: Record<string, unknown>,
) {
  await sql`
    INSERT INTO audit_log
      (actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES
      ('admin', ${adminId}, 'bench.command', 'room', ${roomId},
       ${JSON.stringify({ kind, override_pause: overridePause, ...outcome })}::jsonb)
  `.catch(() => { /* intentional: best-effort audit write */ });
}

export async function POST(req: Request) {
  const guard = await benchAdminGuard();
  if (!guard.ok) return NextResponse.json({ error: { code: guard.code, message: guard.msg } }, { status: 401, ...noStore });
  const adminId = String(guard.claims.admin_id ?? "");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "invalid_json");
  }
  const roomId = typeof body.room_id === "string" && body.room_id.length > 0 && body.room_id.length <= 128 ? body.room_id : null;
  if (!roomId) return fail(400, "room_id_required");
  const kind = body.kind as CommandKind;
  if (!(COMMAND_KINDS as readonly string[]).includes(kind)) return fail(400, "unknown_kind", { allowed: COMMAND_KINDS });
  const overridePause = body.override_pause === true;

  try {
    // START is the only kind with a pre-check, and the pre-check is NOT ours. decideStart owns
    // "is the kiosk listening", "is this already recording" and "is the room paused"; this
    // route only carries its verdict back to the caller.
    if (kind === "start_day") {
      const [listener, activeSession] = await Promise.all([getListener(roomId), findActiveSession(roomId)]);
      const decision = decideStart({ listener, activeSession, overridePause });
      if (decision.action === "reject") {
        return fail(409, decision.error, {
          hint:
            decision.error === "kiosk_not_listening"
              ? "no kiosk tab is polling this room — open the room page on the clinic machine, then start"
              : "this room is paused for consent; re-send with override_pause:true to start anyway",
        });
      }
      if (decision.action === "already_recording") {
        // Idempotent by design: the live tape is returned rather than a second one begun.
        await auditCommand(adminId, roomId, kind, overridePause, { queued: false, already_recording: true, session_id: decision.session_id });
        return NextResponse.json({ ok: true, already_recording: true, session_id: decision.session_id }, noStore);
      }
      const id = await insertCommand({ roomId, kind, args: decision.args ?? undefined, source: "admin" });
      await auditCommand(adminId, roomId, kind, overridePause, { queued: true, command_id: id });
      return NextResponse.json({ ok: true, command_id: id, kind, room_id: roomId, queued: true }, noStore);
    }

    // pause / resume / end carry no pre-check: the kiosk is the authority on its own tape, and
    // queuing a no-op is harmless — the command expires if nothing picks it up.
    const id = await insertCommand({ roomId, kind, source: "admin" });
    await auditCommand(adminId, roomId, kind, overridePause, { queued: true, command_id: id });
    return NextResponse.json({ ok: true, command_id: id, kind, room_id: roomId, queued: true }, noStore);
  } catch (e) {
    const b = e instanceof BusError ? e : classifyBusError(e);
    return fail(503, b.code, { detail: String((e as Error)?.message ?? e).slice(0, 160) });
  }
}
