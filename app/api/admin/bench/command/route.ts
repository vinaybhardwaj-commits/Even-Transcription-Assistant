/**
 * POST /api/admin/bench/command — the monitor's ONLY write.
 *
 * Queues one kiosk command (start_day | pause_day | resume_day | end_day) on the existing bus, and
 * since Tier 1 §3 one of the native app's three verbs (check_update_now | report_diag |
 * restart_engine), zod-validated and refused below app 0.1.22.
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
  CommandArgsError,
  ackWaitMsFor,
  classifyBusError,
  decideStart,
  findActiveSession,
  getCommand,
  getListener,
  insertCommand,
  isTier1Verb,
  parseVerbArgs,
  verbRefusal,
  type CommandKind,
} from "@/lib/bench-commands";
import { closeOrphanedSession, CLOSE_ORPHAN_KIND } from "@/lib/bench-orphan";
import { boundInstallForRoom } from "@/lib/room-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status, ...noStore });

/** Read one command's real bus lifecycle for the per-room outcome row. */
export async function GET(req: Request) {
  const guard = await benchAdminGuard();
  if (!guard.ok) return NextResponse.json({ error: { code: guard.code, message: guard.msg } }, { status: 401, ...noStore });
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^cmd_[a-z0-9]{8}$/.test(id)) return fail(400, "command_id_required");
  try {
    const row = await getCommand(id);
    if (!row) return fail(404, "command_not_found");
    return NextResponse.json({
      ok: true,
      command: {
        id: row.id,
        room_id: row.room_id,
        kind: row.kind,
        status: row.status,
        error: row.error,
        result: row.result,
        created_at: new Date(row.created_at).toISOString(),
        acked_at: row.acked_at ? new Date(row.acked_at).toISOString() : null,
      },
    }, noStore);
  } catch (e) {
    const b = e instanceof BusError ? e : classifyBusError(e);
    return fail(503, b.code);
  }
}

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
  kind: CommandKind | typeof CLOSE_ORPHAN_KIND,
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
  const kind = body.kind as CommandKind | typeof CLOSE_ORPHAN_KIND;
  if (!(COMMAND_KINDS as readonly string[]).includes(kind) && kind !== CLOSE_ORPHAN_KIND) {
    return fail(400, "unknown_kind", { allowed: [...COMMAND_KINDS, CLOSE_ORPHAN_KIND] });
  }
  const overridePause = body.override_pause === true;

  // ---- K5 A2: close_orphan — a REPAIR, and the one kind that is never queued ---------------
  //
  // Every other kind here is an instruction FOR A KIOSK, put on the bus for it to poll. This
  // one exists precisely because there is no kiosk to instruct: the tab that owned the session
  // is gone, so a queued command has nobody to execute it. It runs SERVER-SIDE and returns.
  //
  // It is deliberately NOT in COMMAND_KINDS. That list is the kiosk's vocabulary — pollCommands
  // hands those to a browser — and a kind the kiosk cannot execute has no business in it.
  if (kind === CLOSE_ORPHAN_KIND) {
    const out = await closeOrphanedSession({ roomId, actorType: "admin", actorId: adminId });
    if (!out.ok) {
      return fail(out.error === "db_error" ? 503 : 409, out.error, {
        session_id: out.session_id,
        ...(out.evidence ? { listener_evidence: out.evidence } : {}),
        hint:
          out.error === "kiosk_attached"
            ? "a kiosk is polling and claims this session — it is alive. Use stop to end the day."
            : out.error === "no_open_session"
              ? "this room has no session left open; nothing to repair"
              : undefined,
      });
    }
    await auditCommand(adminId, roomId, kind, overridePause, {
      queued: false,
      closed_session_id: out.session_id,
      chunks_preserved: out.chunks_before === out.chunks_after,
    });
    return NextResponse.json({ ...out, queued: false }, noStore);
  }

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

    // ---- Tier 1 §3: check_update_now | report_diag | restart_engine ------------------------
    // Args through the zod schemas in lib/bench-commands.ts (400 bad_args, nothing inserted), then
    // D11's floor for 0.1.22 against the room's bound Mac (409 APP_TOO_OLD, nothing inserted — a
    // room with no bound Mac is refused the same way, since a browser kiosk cannot run these).
    // Queued, not waited on, like pause / resume / end: the ack lands in `bench_command.result`.
    if (isTier1Verb(kind)) {
      let args: Record<string, unknown> | null;
      try {
        args = parseVerbArgs(kind, body.args);
      } catch (e) {
        if (e instanceof CommandArgsError) return fail(400, "bad_args", { detail: e.reason });
        throw e;
      }
      const bound = await boundInstallForRoom(roomId);
      const tooOld = verbRefusal(kind, bound?.app_version ?? null);
      if (tooOld) return fail(409, tooOld.code, { message: tooOld.message, app_version: tooOld.app_version });
      const id = await insertCommand({ roomId, kind, args: args ?? undefined, source: "admin" });
      await auditCommand(adminId, roomId, kind, overridePause, { queued: true, command_id: id, ...(args ? { args } : {}) });
      return NextResponse.json(
        { ok: true, command_id: id, kind, room_id: roomId, queued: true, ack_wait_ms: ackWaitMsFor(kind) },
        noStore,
      );
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
