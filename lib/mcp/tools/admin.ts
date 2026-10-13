/**
 * lib/mcp/tools/admin.ts — scribe_admin: admin powers for room and kiosk repair (ADMIN-1, 13 Oct 2026).
 *
 * One tool, `action` picks the work. state and install_list are READ. Every other action is a WRITE and
 * needs the "admin" scope (lib/mcp/auth.ts: only a token whose map entry lists "admin" has it; the
 * single-token fallback never does). The tool itself is registered at read scope so the door admits a
 * read token for state / install_list; a write action throws ToolScopeError("admin"), which the handler
 * renders as the same -32001 scope_or_tool_unavailable an unregistered tool gets.
 *
 * EVERY WRITE: `reason` required (1..500 chars) else bad_args; exactly one audit_log row `admin.<action>`
 * (lib/admin-audit) with {reason, before, after, room_id}; a refusal writes `admin.<action>.refused`;
 * the response echoes {reason, before, after}; a no-op answers ok with changed:false and is still
 * audited; nothing is hard-deleted. The bootstrap token and the install command are returned ONCE by
 * install_mint and are never written to the audit row, a log line or an error.
 *
 * GUARDS. Patient gate: room_disable, install_retire and unbind are refused (patient_gate) while the room
 * is recording now (roomsRecordingNow, or the install's session_open) unless override_patient_gate=true
 * AND the reason contains "V GO". An unreadable recording state also refuses (fail closed). Live gate:
 * install_retire / unbind on an install seen in the last 10 minutes is refused (install_live) unless
 * confirm_live=true.
 */
import { InstallError, mintBootstrapToken, retireInstall } from "@/lib/room-install";
import { roomsRecordingNow } from "@/lib/bench-join";
import { writeAdminAudit, type AdminActor } from "@/lib/admin-audit";
import { sql } from "@/lib/db";
import { bindInstall, findBoundInstall, findInstall, listRoomInstalls, setRoomEnabled, type InstallRow } from "@/lib/room-admin";
import { argBool, argStr, failSafe, ToolScopeError, type McpTool, type ToolArgs, type ToolContext } from "../registry";
import { AmbiguousRoomError, resolveRoom, type RoomRef } from "./brain";

export const ADMIN_ACTIONS = ["state", "room_enable", "room_disable", "install_mint", "install_list", "install_retire", "bind", "unbind"] as const;
type AdminAction = (typeof ADMIN_ACTIONS)[number];
const READ_ACTIONS: ReadonlySet<string> = new Set(["state", "install_list"]);
export const REASON_MAX = 500;
export const LIVE_WINDOW_MS = 10 * 60 * 1000;

const HELP = [
  "WRITE (admin scope) room and kiosk repair. action=state|install_list need read; room_enable|room_disable|install_mint|install_retire|bind|unbind need admin.",
  "room = id, slug or exact name. Every write needs reason (1-500 chars), writes one audit row admin.<action>, returns {reason, before, after}, and is idempotent (no-op = changed:false).",
  "state: room, bound install, recording_now, last 3 retired installs, last 5 admin audit rows. install_list: the room's last 10 installs, no tokens.",
  "install_mint: new bootstrap command, shown ONCE, never audited. install_retire {install_id} / unbind (the live install): refused with patient_gate while the room records unless override_patient_gate=true and reason contains 'V GO'; refused with install_live if seen in the last 10 min unless confirm_live=true.",
  "room_disable has the same patient gate. bind {install_id}: restore a RETIRED, enrolled install of the SAME room when it has no live install (undo for a mistaken retire); the recorder must then be restarted, it stops polling after a 409.",
  "Refusals are audited as admin.<action>.refused. Times UTC.",
].join(" ");

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

const installView = (i: InstallRow) => ({
  install_id: i.install_id,
  created_at: iso(i.created_at),
  enrolled_at: iso(i.enrolled_at),
  retired_at: iso(i.retired_at),
  hostname: i.hostname,
  app_version: i.app_version,
  last_seen_at: iso(i.last_seen_at),
  update_channel: i.update_channel,
});

const badArgs = (detail: string) => ({ ok: false, error: "bad_args", detail });

type Resolved = { room: RoomRef } | { out: Record<string, unknown> };

async function resolveAdminRoom(args: ToolArgs): Promise<Resolved> {
  try {
    const room = await resolveRoom(args);
    if (!room) return { out: { ok: false, error: "unknown_room" } };
    return { room };
  } catch (e) {
    if (e instanceof AmbiguousRoomError) return { out: { ok: false, error: "ambiguous_room", matches: e.matches.map((m) => ({ id: m.id, slug: m.slug, name: m.name })) } };
    throw e;
  }
}

async function recordingState(roomId: string, install: InstallRow | null): Promise<{ gated: boolean; why: string }> {
  const rec = await roomsRecordingNow();
  if (!rec.known) return { gated: true, why: "recording_state_unknown" };
  if (rec.rooms.some((r) => r.room_id === roomId)) return { gated: true, why: "room_recording" };
  if (install?.session_open === true) return { gated: true, why: "install_session_open" };
  return { gated: false, why: "" };
}

/** The shared body of install_retire and unbind. */
async function retireFlow(action: "install_retire" | "unbind", room: RoomRef, install: InstallRow, reason: string, args: ToolArgs, actor: AdminActor): Promise<Record<string, unknown>> {
  const auditAction = `admin.${action}` as const;
  const base = { room_id: room.id, install_id: install.install_id };
  if (install.retired_at) {
    const state = { retired_at: iso(install.retired_at) };
    const audited = await writeAdminAudit({ actor, action: auditAction, targetType: "room_install", targetId: install.install_id, meta: { reason, before: state, after: state, changed: false, ...base } });
    return { ok: true, action, changed: false, reason, before: state, after: state, audited, room: { id: room.id, slug: room.slug } };
  }
  const refuse = async (code: string, extra: Record<string, unknown>) => {
    await writeAdminAudit({ actor, action: `${auditAction}.refused`, targetType: "room_install", targetId: install.install_id, meta: { reason, refused: code, ...extra, ...base } });
    return { ok: false, error: code, action, ...extra };
  };
  const gate = await recordingState(room.id, install);
  if (gate.gated) {
    const override = argBool(args, "override_patient_gate") && /V GO/i.test(reason);
    if (!override) {
      return refuse("patient_gate", { why: gate.why, hint: "pass override_patient_gate=true and put 'V GO' in the reason only on V's go" });
    }
  }
  const seen = install.last_seen_at ? new Date(install.last_seen_at).getTime() : null;
  if (seen !== null && Date.now() - seen < LIVE_WINDOW_MS && !argBool(args, "confirm_live")) {
    return refuse("install_live", { last_seen_at: iso(install.last_seen_at), hint: "seen in the last 10 minutes; pass confirm_live=true to retire it anyway" });
  }
  const retired = await retireInstall(install.install_id, { actor, reason, action: auditAction });
  const before = { retired_at: null };
  if (!retired) {
    // lost a race: someone retired it between the read and the write
    const audited = await writeAdminAudit({ actor, action: auditAction, targetType: "room_install", targetId: install.install_id, meta: { reason, before, after: before, changed: false, ...base } });
    return { ok: true, action, changed: false, reason, before, after: before, audited, room: { id: room.id, slug: room.slug } };
  }
  const after = { retired_at: retired.retired_at };
  return {
    ok: true,
    action,
    changed: true,
    reason,
    before,
    after,
    ...(gate.gated ? { patient_gate_overridden: true } : {}),
    room: { id: room.id, slug: room.slug },
    note: "the recorder on that Mac is told RETIRED on its next poll and stops; the room is free for a new install",
  };
}

async function runAction(action: AdminAction, args: ToolArgs, ctx: ToolContext) {
  const r = await resolveAdminRoom(args);
  if ("out" in r) return r.out;
  const room = r.room;
  const actor: AdminActor = { type: "system", id: ctx.actor };

  if (action === "state") {
    const degraded: string[] = [];
    const safe = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); } catch { degraded.push(name); return fallback; }
    };
    const [roomRow, bound, retired, audit, rec] = await Promise.all([
      safe("room", [] as Array<{ disabled_at: string | Date | null }>, async () => (await sql`SELECT disabled_at FROM room WHERE id = ${room.id} LIMIT 1`) as Array<{ disabled_at: string | Date | null }>),
      safe("bound_install", null as InstallRow | null, () => findBoundInstall(room.id)),
      safe("retired_installs", [] as Array<{ install_id: string; retired_at: string | Date; hostname: string | null }>, async () =>
        (await sql`
          SELECT install_id, retired_at, hostname
            FROM room_install
           WHERE room_id = ${room.id} AND retired_at IS NOT NULL
           ORDER BY retired_at DESC
           LIMIT 3
        `) as Array<{ install_id: string; retired_at: string | Date; hostname: string | null }>),
      safe("audit", [] as Array<{ action: string; actor_id: string | null; created_at: string | Date; reason: string | null }>, async () =>
        (await sql`
          SELECT action, actor_id, created_at, metadata_json->>'reason' AS reason
            FROM audit_log
           WHERE action LIKE 'admin.%' AND metadata_json->>'room_id' = ${room.id}
           ORDER BY created_at DESC
           LIMIT 5
        `) as Array<{ action: string; actor_id: string | null; created_at: string | Date; reason: string | null }>),
      safe("recording_now", null as Awaited<ReturnType<typeof roomsRecordingNow>> | null, () => roomsRecordingNow()),
    ]);
    const disabledAt = iso(roomRow[0]?.disabled_at);
    return {
      ok: true,
      room: { id: room.id, slug: room.slug, name: room.name, enabled: disabledAt === null, disabled_at: disabledAt },
      bound_install: bound
        ? { install_id: bound.install_id, hostname: bound.hostname, enrolled_at: iso(bound.enrolled_at), last_seen_at: iso(bound.last_seen_at), app_version: bound.app_version, update_channel: bound.update_channel, session_open: bound.session_open === true, mic_state: bound.mic_state }
        : null,
      recording_now: rec && rec.known ? rec.rooms.some((x) => x.room_id === room.id) : null,
      retired_installs: retired.map((x) => ({ install_id: x.install_id, retired_at: iso(x.retired_at), hostname: x.hostname })),
      admin_audit: audit.map((x) => ({ action: x.action, actor: x.actor_id, at: iso(x.created_at), reason: x.reason })),
      ...(degraded.length ? { degraded: true, degraded_parts: degraded } : {}),
    };
  }

  if (action === "install_list") {
    const rows = await listRoomInstalls(room.id, 10);
    return { ok: true, room: { id: room.id, slug: room.slug }, installs: rows.map(installView) };
  }

  // ---- writes: reason first -------------------------------------------------
  const reason = argStr(args, "reason", REASON_MAX);
  if (!reason) return badArgs(`reason is required (1-${REASON_MAX} chars) for ${action}`);

  if (action === "room_enable" || action === "room_disable") {
    if (action === "room_disable" && room.enabled) {
      const gate = await recordingState(room.id, await findBoundInstall(room.id));
      const override = argBool(args, "override_patient_gate") && /V GO/i.test(reason);
      if (gate.gated && !override) {
        await writeAdminAudit({ actor, action: "admin.room_disable.refused", targetType: "room", targetId: room.id, meta: { reason, refused: "patient_gate", why: gate.why, room_id: room.id } });
        return { ok: false, error: "patient_gate", action, why: gate.why, hint: "pass override_patient_gate=true and put 'V GO' in the reason only on V's go" };
      }
    }
    const out = await setRoomEnabled(room.id, action === "room_enable", actor, reason);
    if (!out.found) return { ok: false, error: "unknown_room" };
    return { ok: true, action, changed: out.changed, reason, before: out.before, after: out.after, audited: out.audited, room: { id: room.id, slug: room.slug } };
  }

  if (action === "install_mint") {
    try {
      const m = await mintBootstrapToken({ roomId: room.id, createdBy: ctx.actor });
      const before = null;
      const after = { install_id: m.install_id, expires_at: m.expires_at };
      // the audit row carries the install id and expiry only: NEVER m.token or m.command
      const audited = await writeAdminAudit({ actor, action: "admin.install_mint", targetType: "room_install", targetId: m.install_id, meta: { reason, before, after, room_id: room.id, install_id: m.install_id, release_version: m.release.version } });
      return {
        ok: true,
        action,
        changed: true,
        reason,
        before,
        after,
        audited,
        install_id: m.install_id,
        command: m.command,
        expires_at: m.expires_at,
        release: { version: m.release.version },
        room: { id: room.id, slug: room.slug },
        note: "the command is shown once and is not stored in the audit log; paste it on the Mac in that room",
      };
    } catch (e) {
      if (e instanceof InstallError) return { ok: false, error: e.code.toLowerCase(), detail: e.message.slice(0, 120) };
      throw e;
    }
  }

  if (action === "bind") {
    const installId = argStr(args, "install_id", 128);
    if (!installId) return badArgs("install_id is required for bind");
    const out = await bindInstall(room.id, installId, actor, reason);
    if (!out.ok) return { ok: false, error: out.error, action };
    return {
      ok: true,
      action,
      changed: out.changed,
      reason,
      before: out.before,
      after: out.after,
      audited: out.audited,
      room: { id: room.id, slug: room.slug },
      ...(out.changed ? { note: "restart the recorder on that Mac: it stops polling after a 409 RETIRED and will not resume on its own" } : {}),
    };
  }

  if (action === "install_retire") {
    const installId = argStr(args, "install_id", 128);
    if (!installId) return badArgs("install_id is required for install_retire");
    const inst = await findInstall(installId);
    if (!inst) return { ok: false, error: "no_install" };
    if (inst.room_id !== room.id) return { ok: false, error: "install_not_in_room" };
    return retireFlow("install_retire", room, inst, reason, args, actor);
  }

  // unbind
  const bound = await findBoundInstall(room.id);
  if (!bound) return { ok: false, error: "no_install" };
  return retireFlow("unbind", room, bound, reason, args, actor);
}

export const adminTool: McpTool = {
  name: "scribe_admin",
  description: HELP,
  // Registered at READ so the door admits a read token for state / install_list. Every write action
  // re-checks for "admin" below and throws ToolScopeError, which the handler renders as -32001.
  scope: "read",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ADMIN_ACTIONS] },
      room: { type: "string", description: "id, slug or name" },
      reason: { type: "string", description: "writes: 1-500 chars" },
      install_id: { type: "string" },
      override_patient_gate: { type: "boolean", description: "needs 'V GO' in reason" },
      confirm_live: { type: "boolean" },
    },
    required: ["action", "room"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const action = argStr(args, "action", 32);
    if (!action || !(ADMIN_ACTIONS as readonly string[]).includes(action)) {
      return { ok: false, error: "unknown_action", allowed: [...ADMIN_ACTIONS] };
    }
    if (!READ_ACTIONS.has(action) && !ctx.scopes.has("admin")) throw new ToolScopeError("admin", { action });
    // A room-restricted token never reaches this tool (default deny, registry.ts); belt and braces.
    if (ctx.rooms) throw new ToolScopeError("admin", { action });
    return failSafe({ ok: false }, async () => runAction(action as AdminAction, args, ctx));
  },
};

export const ADMIN_TOOLS: McpTool[] = [adminTool];
