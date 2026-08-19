/**
 * lib/mcp/tools/bench.ts — Bench tape read tools (Operator MCP S1, PRD §12 11.3, read subset).
 *
 * scribe_list_sessions — lib/bench listBenchSessions (the same helper behind the extended
 *                        GET /api/bench/sessions): room_id / room_slug / ist_date / status / limit.
 * scribe_get_session   — session + chunks + marks (findBenchSession, listBenchChunks,
 *                        listBenchConsultMarks — same as GET /api/bench/sessions/{id}).
 * scribe_get_recording — mode manifest|timeline|chunk|zip. Presigned GET URLs (1 h, the admin
 *                        presign family) for chunks; timeline is the generated markdown; the day
 *                        zip is streamed by the admin route and cannot be presigned → pointer.
 *                        Never bytes. R2 bench keys carry the UTC date of session start.
 *
 * S2 WRITE tools (PRD §8, §11.1 consent-aware/safe start; scope write):
 * scribe_start_recording / scribe_pause_recording / scribe_resume_recording /
 * scribe_stop_recording — resolve room (id/slug/name; ambiguous → error listing matches) →
 * listener check (bench_listener.last_poll_at within 10 s else kiosk_not_listening — no
 * command row is written to a dark room) → start pre-checks (already recording → return the
 * live session, no second tape; paused → room_paused unless override_pause, which is audited)
 * → INSERT bench_command → wait up to 8 s for the kiosk's ack → return it verbatim. Bus not
 * migrated / down → error bus_not_migrated / bus_down (never a 500).
 */

import { findBenchSession, listBenchChunks, listBenchConsultMarks, listBenchEvents, listBenchSessions, splitChunksBySource } from "@/lib/bench";
import { renderBenchTimeline } from "@/lib/bench-timeline";
import { signGetUrl } from "@/lib/r2";
import {
  ACK_WAIT_MS,
  BusError,
  classifyBusError,
  decideStart,
  findActiveSession,
  getListener,
  insertCommand,
  isListening,
  waitForAck,
  type CommandKind,
  type ListenerRow,
} from "@/lib/bench-commands";
import { argBool, argInt, argStr, failSafe, IST_DATE_RE, type McpTool, type ToolArgs } from "../registry";
import { AmbiguousRoomError, resolveRoom, type RoomRef } from "./brain";

const PRESIGN_SECONDS = 3600; // 1 h family (matches manifest route)

const listSessions: McpTool = {
  name: "scribe_list_sessions",
  description: "Bench sessions (last 200 by start, newest first) with chunk rollups. Filters: room_id, room_slug, ist_date (IST calendar date of session start), status (recording|paused|ended), limit (1..200).",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string" },
      room_slug: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata)" },
      status: { type: "string", enum: ["recording", "paused", "ended"] },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 200 },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ sessions: [] as unknown[] }, async () => {
      const istDate = argStr(args, "ist_date", 10);
      if (istDate && !IST_DATE_RE.test(istDate)) return { sessions: [], error: "invalid_ist_date" };
      const rows = await listBenchSessions({
        room_id: argStr(args, "room_id", 128),
        room_slug: argStr(args, "room_slug", 128),
        ist_date: istDate,
        status: argStr(args, "status", 32),
        limit: argInt(args, "limit", 200, 1, 200),
      });
      return {
        sessions: rows.map((r) => ({
          id: r.id,
          room_id: r.room_id,
          room_name: r.room_name,
          room_slug: r.room_slug,
          label: r.label,
          mic_label: r.mic_label,
          started_at: new Date(r.started_at).toISOString(),
          ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null,
          status: r.status,
          notes: r.notes,
          chunk_count: r.chunk_count,
          verified_count: r.verified_count,
          total_bytes: Number(r.total_bytes ?? 0),
          gap_ms: Number(r.gap_ms ?? 0),
          gap_count: r.gap_count,
          last_chunk_at: r.last_chunk_at ? new Date(r.last_chunk_at).toISOString() : null,
          // K-A / K-B (main): newest chunk across both mics, backup stream counts, mic story counts
          last_any_chunk_at: r.last_any_chunk_at ? new Date(r.last_any_chunk_at).toISOString() : null,
          backup_chunk_count: r.backup_chunk_count,
          backup_verified_count: r.backup_verified_count,
          primary_lost_count: r.primary_lost_count,
          primary_restored_count: r.primary_restored_count,
          mic_status:
            r.primary_lost_count > 0
              ? r.backup_chunk_count > 0
                ? r.primary_lost_count > r.primary_restored_count
                  ? "on_backup"
                  : "backup_covered"
                : "lost_no_backup"
              : null,
        })),
      };
    }),
};

async function loadSessionBundle(sessionId: string) {
  const session = await findBenchSession(sessionId);
  if (!session) return null;
  const all = await listBenchChunks(sessionId); // K-B: both streams (primary first, then backup)
  const { primary: chunks, backup: backupChunks } = splitChunksBySource(all);
  let events: Array<{ id: string; kind: string; at: string; brain_status: string; payload: unknown }> = [];
  try {
    events = (await listBenchEvents(sessionId)).map((e) => ({ id: e.id, kind: e.kind, at: new Date(e.at).toISOString(), brain_status: e.brain_status, payload: e.payload ?? null }));
  } catch {
    events = [];
  }
  let marks: Array<{ id: string; kind: string; at: string; brain_status: string }> = [];
  let marksDegraded = false;
  try {
    marks = (await listBenchConsultMarks(sessionId)).map((m) => ({
      id: m.id,
      kind: "consult_mark",
      at: new Date(m.at).toISOString(),
      brain_status: m.brain_status,
    }));
  } catch {
    marksDegraded = true;
  }
  const verified = chunks.filter((c) => c.upload_state === "verified");
  return {
    session: {
      id: session.id,
      room_id: session.room_id,
      room_name: session.room_name,
      room_slug: session.room_slug,
      label: session.label,
      mic_label: session.mic_label,
      started_at: new Date(session.started_at).toISOString(),
      ended_at: session.ended_at ? new Date(session.ended_at).toISOString() : null,
      status: session.status,
      notes: session.notes,
    },
    totals: {
      chunk_count: chunks.length,
      verified_count: verified.length,
      total_bytes: all.reduce((a, c) => a + Number(c.size_bytes ?? 0), 0),
      gap_ms: chunks.reduce((a, c) => a + (c.gap_before_ms ?? 0), 0),
      backup_chunk_count: backupChunks.length,
      backup_verified_count: backupChunks.filter((c) => c.upload_state === "verified").length,
      primary_lost_count: events.filter((e) => e.kind === "mic_primary_lost").length,
      primary_restored_count: events.filter((e) => e.kind === "mic_primary_restored").length,
    },
    chunks: chunks.map((c) => ({
      id: c.id,
      idx: c.idx,
      source: "primary" as const,
      r2_key: c.r2_key,
      content_type: c.content_type,
      started_at: new Date(c.started_at).toISOString(),
      ended_at: new Date(c.ended_at).toISOString(),
      duration_ms: c.duration_ms,
      size_bytes: c.size_bytes === null ? null : Number(c.size_bytes),
      upload_state: c.upload_state,
      gap_before_ms: c.gap_before_ms,
    })),
    // K-B: second-mic stream (backup_chunk_{idx}.webm) + the mic story (bench_event mic_*)
    backup_chunks: backupChunks.map((c) => ({
      id: c.id,
      idx: c.idx,
      source: "backup" as const,
      r2_key: c.r2_key,
      content_type: c.content_type,
      started_at: new Date(c.started_at).toISOString(),
      ended_at: new Date(c.ended_at).toISOString(),
      duration_ms: c.duration_ms,
      size_bytes: c.size_bytes === null ? null : Number(c.size_bytes),
      upload_state: c.upload_state,
      gap_before_ms: c.gap_before_ms,
    })),
    events,
    marks,
    ...(marksDegraded ? { marks_degraded: true } : {}),
    _raw: { session, chunks, backupChunks, all },
  };
}

const getSession: McpTool = {
  name: "scribe_get_session",
  description: "One Bench session: session row, chunk list (r2 keys, times, upload_state, gaps), totals, and consult marks { id, kind, at, brain_status }. Same as GET /api/bench/sessions/{id}.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: { session_id: { type: "string", description: "bs_… id" } },
    required: ["session_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ session: null as unknown, chunks: [] as unknown[], marks: [] as unknown[] }, async () => {
      const id = argStr(args, "session_id", 64);
      if (!id || !id.startsWith("bs_")) return { session: null, chunks: [], marks: [], error: "bad_session_id" };
      const b = await loadSessionBundle(id);
      if (!b) return { session: null, chunks: [], marks: [], error: "session_not_found" };
      const { _raw, ...out } = b;
      void _raw;
      return out;
    }),
};

const getRecording: McpTool = {
  name: "scribe_get_recording",
  description: "Pointers to a session's tape — never bytes. mode=manifest: manifest.json shape with per-chunk presigned GET URLs (1 h). mode=timeline: generated timeline.md text. mode=chunk: one presigned GET URL for chunk_idx (1 h). mode=zip: the admin day-zip route path (streamed on demand, admin cookie; not presignable).",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string" },
      mode: { type: "string", enum: ["manifest", "timeline", "chunk", "zip"], default: "manifest" },
      chunk_idx: { type: "integer", minimum: 0, description: "required for mode=chunk" },
      source: { type: "string", enum: ["primary", "backup"], default: "primary", description: "mode=chunk: which mic stream (K-B)" },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ mode: null as string | null }, async () => {
      const id = argStr(args, "session_id", 64);
      if (!id || !id.startsWith("bs_")) return { mode: null, error: "bad_session_id" };
      const modeRaw = argStr(args, "mode", 16) ?? "manifest";
      if (!["manifest", "timeline", "chunk", "zip"].includes(modeRaw)) return { mode: null, error: "bad_mode" };
      const mode = modeRaw as "manifest" | "timeline" | "chunk" | "zip";
      const b = await loadSessionBundle(id);
      if (!b) return { mode, error: "session_not_found" };
      const { session, chunks, backupChunks } = b._raw;

      if (mode === "timeline") {
        const { markdown } = await renderBenchTimeline(session.id, session);
        return { mode, session_id: session.id, markdown, route: `/api/bench/sessions/${session.id}/timeline` };
      }
      if (mode === "zip") {
        return {
          mode,
          session_id: session.id,
          route: `/api/bench/sessions/${session.id}/download`,
          auth: "admin cookie",
          note: "STORE zip streamed on demand (chunks + manifest.json + timeline.md); not an R2 object, so no presigned URL. Use mode=manifest for per-chunk presigned links.",
          chunk_count: chunks.length,
          total_bytes: b.totals.total_bytes,
        };
      }
      if (mode === "chunk") {
        const idx = argInt(args, "chunk_idx", -1, 0, 1_000_000);
        if (idx < 0 || args.chunk_idx === undefined) return { mode, error: "chunk_idx_required" };
        const src = argStr(args, "source", 16) === "backup" ? "backup" : "primary";
        const c = (src === "backup" ? backupChunks : chunks).find((x) => x.idx === idx);
        if (!c) return { mode, error: "chunk_not_found", source: src };
        let url: string | null = null;
        try {
          url = await signGetUrl({ key: c.r2_key, expiresInSeconds: PRESIGN_SECONDS, contentType: c.content_type });
        } catch {
          url = null;
        }
        return {
          mode,
          session_id: session.id,
          chunk: { idx: c.idx, source: src, r2_key: c.r2_key, content_type: c.content_type, started_at: new Date(c.started_at).toISOString(), ended_at: new Date(c.ended_at).toISOString(), duration_ms: c.duration_ms, upload_state: c.upload_state, size_bytes: c.size_bytes === null ? null : Number(c.size_bytes) },
          presigned_get: url,
          expires_in_seconds: url ? PRESIGN_SECONDS : null,
        };
      }
      // manifest — same shape as GET /api/bench/sessions/{id}/manifest (K-B: both streams)
      const presignAll = (rows: typeof chunks) => Promise.all(
        rows.map(async (c) => {
          let url: string | null = null;
          try {
            url = await signGetUrl({ key: c.r2_key, expiresInSeconds: PRESIGN_SECONDS, contentType: c.content_type });
          } catch {
            /* fail-safe: link degrades to null */
          }
          return {
            idx: c.idx,
            r2_key: c.r2_key,
            content_type: c.content_type,
            started_at: new Date(c.started_at).toISOString(),
            ended_at: new Date(c.ended_at).toISOString(),
            duration_ms: c.duration_ms,
            size_bytes: c.size_bytes === null ? null : Number(c.size_bytes),
            upload_state: c.upload_state,
            gap_before_ms: c.gap_before_ms,
            source: c.source ?? "primary",
            presigned_get: url,
          };
        }),
      );
      const [withUrls, backupWithUrls] = await Promise.all([presignAll(chunks), presignAll(backupChunks)]);
      return {
        mode,
        generated_at: new Date().toISOString(),
        session: b.session,
        totals: b.totals,
        marks: b.marks,
        events: b.events,
        chunks: withUrls,
        backup_chunks: backupWithUrls,
        expires_in_seconds: PRESIGN_SECONDS,
        note: "R2 bench keys use the UTC date of session start; backup stream = backup_chunk_{idx}.webm.",
      };
    }),
};

// ---------------------------------------------------------------------------
// S2 — remote tape control (write)
// ---------------------------------------------------------------------------

const ROOM_WRITE_ARGS = {
  room: { type: "string", description: "room id, slug (opd-test-a7q9), or exact name (OPD Test)" },
  room_id: { type: "string" },
  room_slug: { type: "string" },
};

type ResolveOutcome = { room: RoomRef } | { error: Record<string, unknown> };

async function resolveForWrite(args: ToolArgs): Promise<ResolveOutcome> {
  try {
    const room = await resolveRoom(args);
    if (!room) return { error: { error: "unknown_room" } };
    if (!room.enabled) return { error: { error: "room_disabled", room: { id: room.id, slug: room.slug, name: room.name } } };
    return { room };
  } catch (e) {
    if (e instanceof AmbiguousRoomError) {
      return { error: { error: "ambiguous_room", matches: e.matches.map((m) => ({ id: m.id, slug: m.slug, name: m.name })) } };
    }
    return { error: { error: "room_lookup_failed", detail: String((e as Error)?.message ?? e).slice(0, 160), degraded: true } };
  }
}

function listenerView(l: ListenerRow | null, now: Date) {
  if (!l) return null;
  return {
    tab_id: l.tab_id,
    last_poll_at: new Date(l.last_poll_at).toISOString(),
    age_ms: now.getTime() - new Date(l.last_poll_at).getTime(),
    recording_session_id: l.recording_session_id,
    paused: l.paused,
    listening: isListening(l, now),
  };
}

function busErrorResult(e: unknown, extra: Record<string, unknown> = {}) {
  const b = e instanceof BusError ? e : classifyBusError(e);
  return { ok: false, error: b.code, ...(b.cause_message ? { detail: b.cause_message } : {}), ...extra };
}

/** Insert the command and wait for the kiosk's ack; return the kiosk's result verbatim. */
async function sendAndWait(room: RoomRef, kind: CommandKind, args: unknown, listener: ListenerRow | null) {
  const insertedAt = Date.now();
  const commandId = await insertCommand({ roomId: room.id, kind, args, source: "mcp" });
  const row = await waitForAck(commandId, { timeoutMs: ACK_WAIT_MS });
  const base = { room: { id: room.id, slug: room.slug, name: room.name }, kind, command_id: commandId };
  if (!row) {
    // No ack in 8 s. Was it ever delivered? (a poll AFTER the insert means the kiosk has it —
    // e.g. end_day still flushing). Never delivered → kiosk_not_listening; the 15 s lazy expiry
    // will mark the row.
    let delivered = false;
    try {
      const l = await getListener(room.id);
      // a poll at/after the insert (1 s clock-skew tolerance) means the kiosk fetched the row
      delivered = !!l && !!listener && new Date(l.last_poll_at).getTime() >= insertedAt - 1_000;
    } catch {
      /* fall through */
    }
    return delivered
      ? { ok: false, error: "ack_timeout", ...base, hint: "kiosk received the command but has not acked within 8 s (a stop may still be flushing) — check scribe_get_session" }
      : { ok: false, error: "kiosk_not_listening", ...base };
  }
  const result = (typeof row.result === "object" && row.result !== null ? row.result : {}) as Record<string, unknown>;
  return {
    ok: row.status === "acked",
    status: row.status,
    ...base,
    result,
    ...(row.error ? { error: row.error } : {}),
    acked_at: row.acked_at ? new Date(row.acked_at).toISOString() : null,
  };
}

const startRecording: McpTool = {
  name: "scribe_start_recording",
  description: "Start the Bench tape in a room via its listening kiosk (command start_day). Requires a listener (kiosk polled within 10 s) else kiosk_not_listening — no session row is faked. Idempotent: already recording → { already_recording:true, session_id }. Paused-for-consent → room_paused unless override_pause:true (audited). Waits up to 8 s for the kiosk ack.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: { ...ROOM_WRITE_ARGS, override_pause: { type: "boolean", default: false, description: "resume over a consent pause — rare, audited" } },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const r = await resolveForWrite(args);
    if ("error" in r) return r.error;
    const room = r.room;
    const now = new Date();
    try {
      const [listener, active] = await Promise.all([getListener(room.id), findActiveSession(room.id)]);
      const overridePause = argBool(args, "override_pause");
      const d = decideStart({ listener, activeSession: active, overridePause, now });
      const ctx = { room: { id: room.id, slug: room.slug, name: room.name }, listener: listenerView(listener, now), active_session: active };
      if (d.action === "reject") return { ok: false, error: d.error, ...ctx };
      if (d.action === "already_recording") return { ok: true, already_recording: true, session_id: d.session_id, ...ctx };
      const out = await sendAndWait(room, "start_day", d.args, listener);
      return { ...out, ...(d.args?.override_pause ? { override_pause: true } : {}) };
    } catch (e) {
      return busErrorResult(e, { room: { id: room.id, slug: room.slug, name: room.name } });
    }
  },
};

function simpleVerb(name: string, kind: CommandKind, description: string): McpTool {
  return {
    name,
    description,
    scope: "write",
    inputSchema: { type: "object", properties: ROOM_WRITE_ARGS, additionalProperties: false },
    handler: async (args: ToolArgs) => {
      const r = await resolveForWrite(args);
      if ("error" in r) return r.error;
      const room = r.room;
      const now = new Date();
      try {
        const listener = await getListener(room.id);
        const ctx = { room: { id: room.id, slug: room.slug, name: room.name }, listener: listenerView(listener, now) };
        if (!isListening(listener, now)) return { ok: false, error: "kiosk_not_listening", ...ctx };
        return await sendAndWait(room, kind, null, listener);
      } catch (e) {
        return busErrorResult(e, { room: { id: room.id, slug: room.slug, name: room.name } });
      }
    },
  };
}

const pauseRecording = simpleVerb(
  "scribe_pause_recording",
  "pause_day",
  "Pause the room's tape via the kiosk (command pause_day; the kiosk runs its own Pause). Requires a listener. Kiosk answers not_recording if nothing is recording.",
);
const resumeRecording = simpleVerb(
  "scribe_resume_recording",
  "resume_day",
  "Resume a paused tape via the kiosk (command resume_day). Requires a listener. Kiosk answers not_paused if the room is not paused.",
);
const stopRecording = simpleVerb(
  "scribe_stop_recording",
  "end_day",
  "End the room's day via the kiosk (command end_day): the kiosk flushes the last chunk, ends the session, then acks. Requires a listener. May answer ack_timeout if the flush outlasts the 8 s wait — check scribe_get_session.",
);

export const BENCH_TOOLS: McpTool[] = [listSessions, getSession, getRecording, startRecording, pauseRecording, resumeRecording, stopRecording];
