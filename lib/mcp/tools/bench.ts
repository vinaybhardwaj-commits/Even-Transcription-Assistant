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
 *
 * S3:
 * scribe_mark_consult (write)    — durable-first mirror of the kiosk consult mark: room's active
 *                                  session → INSERT bench_event consult_mark {source:"mcp"} 'failed'
 *                                  → cue via postBrainCue → UPDATE 'sent'. No active session → the
 *                                  cue still lands, event_row:"no_active_session" (PRD §9).
 * scribe_extract_audio (invoke)  — clock window (HH:MM[:SS] IST or ISO) → one covering chunk →
 *                                  short presigned GET + offsets; spanning → multi_chunk_not_supported_v1
 *                                  listing every covering chunk + presigns; none → no_audio_in_range.
 * scribe_transcribe_range (invoke)— same resolution → download that chunk → Mini Whisper (lib/whisper)
 *                                  → text for the WHOLE chunk (trimming is v1.1), never inline bytes.
 * scribe_list_commands (read)    — the bus queue (bench_command), newest first.
 *
 * U2 (ETA-MCP-UPGRADE PRD §5 + addendum 1 — hear a consultation, not a piece):
 * a window that crosses pieces is JOINED into one clip by the joining service
 * (D14, Cloudflare Containers — services/audio-join) and returned as one link plus the
 * window that was asked for. Over 30 minutes is refused (D2); joining is refused while
 * any room is recording (D15); an unreachable or refusing service degrades to exactly
 * today's multi-piece answer (D10). scribe_transcribe_range then runs Whisper on the
 * joined clip, so its text covers the window and not a five-minute slab (D9).
 *
 * U3 (ETA-MCP-UPGRADE PRD §4, read only):
 * scribe_day_report — one room, one IST day: sessions in start order, tape_ended_at from the
 *                     last piece on EITHER mic (the tape clock governs; stored ended_at shown
 *                     only when it differs), per-mic counts, gaps, consult marks, mic story,
 *                     remount events. No labels/notes (they can carry clinician names).
 * scribe_diff_room  — the now-picture across enabled rooms: page open (LISTENER_FRESH_MS),
 *                     recording, last cue, last piece, flags kiosk_not_listening / stalled /
 *                     tape_without_cues / ended_at_lies (all windows imported — D11).
 *
 * U1 (ETA-MCP-UPGRADE PRD §6, read only — DRY RUN, THE ONLY MODE):
 * scribe_replay_session — a finished day turned back into the stream of cues it would have
 *                     produced live. It WRITES NOTHING: no cue posted, no row inserted, no day
 *                     created, not behind a flag and not commented out. There is no write path
 *                     in this build; a future slice that wants to post replay output adds the
 *                     write then, with its own decision behind it. Input to the fuse work, not
 *                     a feature for the clinic.
 */

import { findBenchSession, listBenchChunks, listBenchConsultMarks, listBenchEvents, listBenchSessions, newEventId, splitChunksBySource, type BenchChunkRow, type BenchEventRow, type BenchSessionRollupRow } from "@/lib/bench";
import { renderBenchTimeline } from "@/lib/bench-timeline";
import { getObjectBytes, signGetUrl } from "@/lib/r2";
import { sql } from "@/lib/db";
import { transcribeWithWhisper } from "@/lib/whisper";
import { fmtIstClock, istDate, parseOperatorTime, resolveRange, type CoveringChunk } from "@/lib/bench-range";
// U2: the joining half — the 30-minute limit, the recording guard, the clip key/provenance and
// the client of the joining service (D2, D14, D15, D3/D4, D10).
import {
  buildJoinRequest,
  callJoinService,
  CLIP_PRESIGN_SECONDS,
  refuseIfTooLong,
  roomsRecordingNow,
  whisperTimeoutForClip,
  type JoinOutcome,
} from "@/lib/bench-join";
// U3: the reaper's OWN window and badge rule — imported, never retyped (PRD D11).
import { isBenchStalled, STALLED_BADGE_MINUTES } from "@/lib/bench-reaper-core";
import { listCuesForDay } from "@/lib/brain/state";
import {
  ACK_WAIT_MS,
  BusError,
  classifyBusError,
  decideStart,
  findActiveSession,
  getListener,
  insertCommand,
  isListening,
  LISTENER_FRESH_MS,
  listCommands,
  waitForAck,
  type CommandKind,
  type ListenerRow,
} from "@/lib/bench-commands";
import { argBool, argDate, argInt, argStr, failSafe, IST_DATE_RE, type McpTool, type ToolArgs, type ToolContext } from "../registry";
import { AmbiguousRoomError, postBrainCue, resolveRoom, type CueSource, type RoomRef } from "./brain";

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

// ---------------------------------------------------------------------------
// S3 — consult mark from the operator (write, durable-first)
// ---------------------------------------------------------------------------

const markConsult: McpTool = {
  name: "scribe_mark_consult",
  description: "Operator consult mark (PRD §9): durable-first like the kiosk — INSERT bench_event kind consult_mark {source:'mcp', note?} on the room's active session, then post the cue, then flip the row to 'sent'. With NO active session the cue still lands and event_row is 'no_active_session' (never a blocking 409).",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      ...ROOM_WRITE_ARGS,
      at: { type: "string", description: "ISO timestamp of the mark; default now" },
      note: { type: "string", maxLength: 500, description: "optional operator note stored on the event row + cue payload" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const r = await resolveForWrite(args);
    if ("error" in r) return r.error;
    const room = r.room;
    let at = new Date();
    if (args.at !== undefined && args.at !== null && args.at !== "") {
      const d = argDate(args, "at");
      if (!d) return { ok: false, error: "invalid_at" };
      at = d;
    }
    const note = argStr(args, "note", 500);
    const payload: Record<string, unknown> = { source: "mcp", ...(note ? { note } : {}) };

    // 1. durable row first (only when there is a live tape to hang it on)
    let session: { id: string; status: string } | null = null;
    let sessionLookupError: string | null = null;
    try {
      session = await findActiveSession(room.id);
    } catch (e) {
      sessionLookupError = String((e as Error)?.message ?? e).slice(0, 160);
    }
    let eventId: string | null = null;
    let eventRow: "inserted" | "no_active_session" | "write_failed" = "no_active_session";
    if (session) {
      eventId = newEventId();
      try {
        await sql`
          INSERT INTO bench_event (id, session_id, kind, at, brain_status, payload)
          VALUES (${eventId}, ${session.id}, 'consult_mark', ${at.toISOString()}, 'failed', ${JSON.stringify(payload)}::jsonb)
        `;
        eventRow = "inserted";
      } catch (e) {
        eventRow = "write_failed";
        sessionLookupError = String((e as Error)?.message ?? e).slice(0, 160);
        eventId = null;
      }
    }

    // 2. the cue — always attempted (the operator is a first-class cue source)
    const cue = await postBrainCue(ctx.origin, { room_id: room.id, type: "consult_mark", at: at.toISOString(), payload });

    // 3. flip the row on brain 2xx
    if (cue.ok && eventId) {
      try {
        await sql`UPDATE bench_event SET brain_status = 'sent' WHERE id = ${eventId}`;
      } catch {
        /* row stays 'failed' — the cue did land */
      }
    }
    return {
      ok: cue.ok || eventRow === "inserted",
      room: { id: room.id, slug: room.slug, name: room.name },
      at: at.toISOString(),
      session_id: session?.id ?? null,
      event_row: eventRow,
      event_id: eventId,
      // Remount-resume §3.6: echo the cue id at the top level when the cue lands.
      ...(cue.ok ? { cue_id: cue.cue_id } : {}),
      cue,
      ...(sessionLookupError ? { detail: sessionLookupError } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// S3 — audio by clock time (invoke)
// ---------------------------------------------------------------------------

const EXTRACT_PRESIGN_SECONDS = 900; // short-lived (§16): 15 min, admin presign family

type RangeArgsOk = { session: NonNullable<Awaited<ReturnType<typeof findBenchSession>>>; chunks: BenchChunkRow[]; startMs: number; endMs: number; source: "primary" | "backup"; istDay: string };

/** Shared arg resolution for extract/transcribe: session (by id or room+ist_date), window, source. */
async function resolveRangeArgs(args: ToolArgs): Promise<RangeArgsOk | { error: Record<string, unknown> }> {
  const sourceRaw = argStr(args, "source", 16) ?? "primary";
  if (sourceRaw !== "primary" && sourceRaw !== "backup") return { error: { ok: false, error: "bad_source" } };
  const source = sourceRaw;
  let session: Awaited<ReturnType<typeof findBenchSession>> = null;
  const sid = argStr(args, "session_id", 64);
  if (sid) {
    if (!sid.startsWith("bs_")) return { error: { ok: false, error: "bad_session_id" } };
    session = await findBenchSession(sid);
    if (!session) return { error: { ok: false, error: "session_not_found" } };
  } else {
    const r = await resolveForWrite(args);
    if ("error" in r) return { error: r.error };
    const d = argStr(args, "ist_date", 10);
    if (d && !IST_DATE_RE.test(d)) return { error: { ok: false, error: "invalid_ist_date" } };
    const wanted = d ?? istDate(new Date());
    const rows = await listBenchSessions({ room_id: r.room.id, ist_date: wanted, limit: 5 });
    if (rows.length === 0) return { error: { ok: false, error: "no_session_for_room_day", room: { id: r.room.id, slug: r.room.slug }, ist_date: wanted } };
    const picked = rows[0]!; // newest that day
    session = await findBenchSession(picked.id);
    if (!session) return { error: { ok: false, error: "session_not_found" } };
    if (rows.length > 1) (session as unknown as { _others?: string[] })._others = rows.slice(1).map((x) => x.id);
  }
  const istDay = istDate(new Date(session.started_at));
  const start = parseOperatorTime(args.start, istDay);
  const end = parseOperatorTime(args.end, istDay);
  if (!start) return { error: { ok: false, error: "invalid_start", hint: "HH:MM[:SS] IST or ISO" } };
  if (!end) return { error: { ok: false, error: "invalid_end", hint: "HH:MM[:SS] IST or ISO" } };
  if (!(end.ms > start.ms)) return { error: { ok: false, error: "end_before_start" } };
  const chunks = await listBenchChunks(session.id);
  return { session, chunks, startMs: start.ms, endMs: end.ms, source, istDay };
}

async function presignCovering(c: CoveringChunk<BenchChunkRow>) {
  let url: string | null = null;
  try {
    url = await signGetUrl({ key: c.chunk.r2_key, expiresInSeconds: EXTRACT_PRESIGN_SECONDS, contentType: c.chunk.content_type });
  } catch {
    url = null;
  }
  return {
    chunk_idx: c.chunk.idx,
    source: c.chunk.source ?? "primary",
    r2_key: c.chunk.r2_key,
    content_type: c.chunk.content_type,
    upload_state: c.chunk.upload_state,
    chunk_bounds: c.chunk_bounds,
    offset_in_chunk_s: c.offset_in_chunk_s,
    duration_s: c.duration_s,
    presigned_get: url,
    expires_in_seconds: url ? EXTRACT_PRESIGN_SECONDS : null,
  };
}

const RANGE_ARGS = {
  session_id: { type: "string", description: "bs_… (or give room + ist_date)" },
  room: { type: "string" },
  room_id: { type: "string" },
  room_slug: { type: "string" },
  ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata) when addressing by room; default today" },
  start: { type: "string", description: "HH:MM[:SS] IST clock on the session's day, or ISO" },
  end: { type: "string", description: "HH:MM[:SS] IST clock on the session's day, or ISO" },
  source: { type: "string", enum: ["primary", "backup"], default: "primary" },
};

// ---------------------------------------------------------------------------
// U2 — joining a window that crosses pieces (PRD §5, addendum 1)
//
// The order below is the kickoff's, and it matters: a window is measured before anything is
// asked of the database, the room is asked before anything is asked of the joining service, and
// the joining service is only reached once both are satisfied. Every step that says no says so
// by name, and NO step ends in an error page — the covering pieces are listed either way, which
// is exactly what the door answered before this slice existed (D10).
// ---------------------------------------------------------------------------

type JoinAttempt =
  /** The app itself said no, by name — over 30 minutes (D2) or a room is recording (D15). */
  | { kind: "refused"; body: Record<string, unknown> }
  /** One clip, written and kept. */
  | { kind: "clip"; key: string; bytes: number; duration_ms: number; guard_degraded?: string }
  /** The joining service is unreachable or refused → today's multi-piece answer (D10).
   *  `join_hop` names which of the service's three transfers broke, when one did. */
  | { kind: "fallback"; join_error: string; join_detail?: string; join_hop?: string; guard_degraded?: string };

async function attemptJoin(
  sessionId: string,
  covering: ReadonlyArray<CoveringChunk<BenchChunkRow>>,
  startMs: number,
  endMs: number,
  source: "primary" | "backup",
): Promise<JoinAttempt> {
  // 1. D2 — over 30 minutes, naming the limit.
  const tooLong = refuseIfTooLong(startMs, endMs);
  if (tooLong) {
    return { kind: "refused", body: { ok: false, ...tooLong, hint: `joining is capped at ${tooLong.limit_minutes} minutes — ask for a shorter window, or fetch the covering pieces below` } };
  }

  // 2. D15 — never compete with a live tape.
  const recording = await roomsRecordingNow();
  if (recording.known && recording.rooms.length > 0) {
    return {
      kind: "refused",
      body: {
        ok: false,
        error: "room_recording",
        recording_rooms: recording.rooms,
        hint: "joining is refused while any room is recording (D15) — try again once the day has ended; the covering pieces below are available now",
      },
    };
  }
  // The bus could not be read. That is not evidence of a live tape, so it does not refuse — but
  // it is carried into the answer rather than swallowed.
  const guardDegraded = recording.known ? undefined : recording.reason;

  // 3. Ask the joining service.
  const req = buildJoinRequest(sessionId, covering, startMs, endMs, source);
  const out: JoinOutcome = await callJoinService(req);
  if (!out.ok) {
    return { kind: "fallback", join_error: out.error, ...(out.detail ? { join_detail: out.detail } : {}), ...(out.hop ? { join_hop: out.hop } : {}), ...(guardDegraded ? { guard_degraded: guardDegraded } : {}) };
  }
  return { kind: "clip", key: out.key, bytes: out.bytes, duration_ms: out.duration_ms, ...(guardDegraded ? { guard_degraded: guardDegraded } : {}) };
}

/** Today's answer, unchanged: the multi-piece response listing every covering piece with its own
 *  link. This is the ONLY thing a caller sees when joining is unavailable (D10). */
async function multiPieceAnswer(
  covering: ReadonlyArray<CoveringChunk<BenchChunkRow>>,
  base: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const covering_chunks = await Promise.all(covering.map(presignCovering));
  return { ok: false, error: "multi_chunk_not_supported_v1", ...base, covering_chunks, ...extra };
}

const extractAudio: McpTool = {
  name: "scribe_extract_audio",
  description: "Audio by clock time (PRD §10 + U2): map an IST window onto the session's chunk rows. Inside ONE chunk → one short-lived presigned GET + { offset_in_chunk_s, duration_s, chunk_idx, chunk_bounds }. Spanning chunks → the pieces are JOINED into one kept clip and answered with a single 1 h link plus the window asked for. Refused by name over 30 minutes (window_too_long) and while any room is recording (room_recording). If the joining service is unreachable or refuses, the answer degrades to the multi-piece response listing every covering piece with its own link — never an error page. None → no_audio_in_range. Never inline bytes.",
  scope: "invoke",
  inputSchema: { type: "object", properties: RANGE_ARGS, required: ["start", "end"], additionalProperties: false },
  handler: async (args: ToolArgs) => {
    const r = await resolveRangeArgs(args);
    if ("error" in r) return r.error;
    const res = resolveRange(r.chunks, r.startMs, r.endMs, r.source);
    const requested = { start: new Date(r.startMs).toISOString(), end: new Date(r.endMs).toISOString(), start_ist: fmtIstClock(r.startMs), end_ist: fmtIstClock(r.endMs), source: r.source, ist_date: r.istDay };
    const base = { session_id: r.session.id, room_slug: r.session.room_slug, requested_range: requested };
    if (res.kind === "none") return { ok: false, error: "no_audio_in_range", ...base, chunks_on_session: r.chunks.filter((c) => (c.source ?? "primary") === r.source).length };
    if (res.kind === "multi") {
      const attempt = await attemptJoin(r.session.id, res.covering, r.startMs, r.endMs, r.source);
      if (attempt.kind === "refused") {
        // Named refusal first — and still the covering pieces, so no answer is a dead end.
        const covering_chunks = await Promise.all(res.covering.map(presignCovering));
        return { ...attempt.body, ...base, covering_chunks };
      }
      if (attempt.kind === "fallback") {
        return multiPieceAnswer(res.covering, base, {
          join_error: attempt.join_error,
          ...(attempt.join_detail ? { join_detail: attempt.join_detail } : {}),
          ...(attempt.join_hop ? { join_hop: attempt.join_hop } : {}),
          hint: "joining is unavailable — fetch the listed presigns in order; the window spans them",
        });
      }
      let url: string | null = null;
      try {
        url = await signGetUrl({ key: attempt.key, expiresInSeconds: CLIP_PRESIGN_SECONDS, contentType: "audio/webm" });
      } catch {
        url = null; // the clip is written and kept; only the link failed
      }
      return {
        ok: true,
        joined: true,
        ...base,
        clip: {
          r2_key: attempt.key,
          content_type: "audio/webm",
          bytes: attempt.bytes,
          duration_ms: attempt.duration_ms,
          presigned_get: url,
          expires_in_seconds: url ? CLIP_PRESIGN_SECONDS : null,
        },
        pieces: res.covering.map((c) => ({ chunk_idx: c.chunk.idx, source: c.chunk.source ?? "primary", r2_key: c.chunk.r2_key, chunk_bounds: c.chunk_bounds, offset_in_chunk_s: c.offset_in_chunk_s, duration_s: c.duration_s })),
        ...(attempt.guard_degraded ? { degraded: [attempt.guard_degraded] } : {}),
        note: "one clip covering the requested window, joined from the pieces listed and kept under clips/ with its session, window, microphone and creation time on the object; the link expires in 1 h, the clip does not",
      };
    }
    const clip = await presignCovering(res.covering);
    return { ok: true, ...base, ...clip, note: "presigned GET is the whole chunk; play from offset_in_chunk_s for duration_s" };
  },
};

const transcribeRange: McpTool = {
  name: "scribe_transcribe_range",
  description: "Hear the tape (PRD §11.1 + U2): resolve the window to the pieces that cover it. ONE piece → today's answer, Mini Whisper on that whole chunk. MORE than one → the pieces are joined and trimmed to the window first (D9) and the text covers the WINDOW asked for, not a five-minute slab. Refused by name over 30 minutes and while any room is recording; with joining unavailable the answer degrades to the multi-piece response. Text only, never bytes. v1: engine=whisper only.",
  scope: "invoke",
  inputSchema: { type: "object", properties: { ...RANGE_ARGS, engine: { type: "string", enum: ["whisper"], default: "whisper" }, language: { type: "string", description: "optional Whisper language hint, e.g. en" } }, required: ["start", "end"], additionalProperties: false },
  handler: async (args: ToolArgs) => {
    const engine = argStr(args, "engine", 32) ?? "whisper";
    if (engine !== "whisper") return { ok: false, error: "engine_not_supported_v1", engine, allowed: ["whisper"] };
    const r = await resolveRangeArgs(args);
    if ("error" in r) return r.error;
    const res = resolveRange(r.chunks, r.startMs, r.endMs, r.source);
    const requested = { start: new Date(r.startMs).toISOString(), end: new Date(r.endMs).toISOString(), start_ist: fmtIstClock(r.startMs), end_ist: fmtIstClock(r.endMs), source: r.source, ist_date: r.istDay };
    const base = { session_id: r.session.id, room_slug: r.session.room_slug, requested_range: requested, engine };
    const language = argStr(args, "language", 8) ?? undefined;
    if (res.kind === "none") return { ok: false, error: "no_audio_in_range", ...base };
    if (res.kind === "multi") {
      // D9 — transcription runs on the JOINED clip, not on whole pieces trimmed afterwards.
      const t0 = Date.now();
      const attempt = await attemptJoin(r.session.id, res.covering, r.startMs, r.endMs, r.source);
      if (attempt.kind === "refused") {
        const covering_chunks = await Promise.all(res.covering.map(presignCovering));
        return { ...attempt.body, ...base, covering_chunks };
      }
      if (attempt.kind === "fallback") {
        return multiPieceAnswer(res.covering, base, {
          join_error: attempt.join_error,
          ...(attempt.join_detail ? { join_detail: attempt.join_detail } : {}),
          ...(attempt.join_hop ? { join_hop: attempt.join_hop } : {}),
          hint: "joining is unavailable — transcribe one covering chunk at a time by narrowing the window to a single chunk_bounds",
        });
      }
      let clipBytes: Uint8Array | null = null;
      try {
        clipBytes = await getObjectBytes(attempt.key);
      } catch (e) {
        return { ok: false, error: "clip_download_failed", degraded: true, ...base, r2_key: attempt.key, detail: String((e as Error)?.message ?? e).slice(0, 160) };
      }
      if (!clipBytes) return { ok: false, error: "clip_missing_in_r2", ...base, r2_key: attempt.key };
      const wj = await transcribeWithWhisper(clipBytes, "audio/webm", { language, timeoutMs: whisperTimeoutForClip(attempt.duration_ms) });
      if (!wj.ok) return { ok: false, error: "whisper_failed", degraded: true, ...base, r2_key: attempt.key, detail: wj.error, latency_ms: wj.latency_ms };
      return {
        ok: true,
        joined: true,
        ...base,
        clip: { r2_key: attempt.key, bytes: attempt.bytes, duration_ms: attempt.duration_ms },
        pieces: res.covering.map((c) => ({ chunk_idx: c.chunk.idx, source: c.chunk.source ?? "primary", chunk_bounds: c.chunk_bounds, offset_in_chunk_s: c.offset_in_chunk_s, duration_s: c.duration_s })),
        text: wj.transcript,
        language: wj.language ?? null,
        audio_seconds: wj.duration_seconds ?? null,
        whisper_latency_ms: wj.latency_ms,
        total_ms: Date.now() - t0,
        ...(attempt.guard_degraded ? { degraded: [attempt.guard_degraded] } : {}),
        note: `text covers the requested window ${requested.start_ist}–${requested.end_ist} IST, transcribed from the joined clip of ${res.covering.length} pieces`,
      };
    }
    const c = res.covering;
    const t0 = Date.now();
    let bytes: Uint8Array | null = null;
    try {
      bytes = await getObjectBytes(c.chunk.r2_key);
    } catch (e) {
      return { ok: false, error: "chunk_download_failed", degraded: true, ...base, chunk_idx: c.chunk.idx, detail: String((e as Error)?.message ?? e).slice(0, 160) };
    }
    if (!bytes) return { ok: false, error: "chunk_missing_in_r2", ...base, chunk_idx: c.chunk.idx, r2_key: c.chunk.r2_key };
    const w = await transcribeWithWhisper(bytes, c.chunk.content_type || "audio/webm", { language });
    if (!w.ok) return { ok: false, error: "whisper_failed", degraded: true, ...base, chunk_idx: c.chunk.idx, detail: w.error, latency_ms: w.latency_ms };
    return {
      ok: true,
      ...base,
      chunk_idx: c.chunk.idx,
      chunk_bounds: c.chunk_bounds,
      offset_in_chunk_s: c.offset_in_chunk_s,
      duration_s: c.duration_s,
      text: w.transcript,
      language: w.language ?? null,
      audio_seconds: w.duration_seconds ?? null,
      whisper_latency_ms: w.latency_ms,
      total_ms: Date.now() - t0,
      note: `text covers the WHOLE chunk ${c.chunk.idx} (${c.chunk_bounds.started_at} → ${c.chunk_bounds.ended_at}), not the trimmed window ${requested.start_ist}–${requested.end_ist} IST; trimming is v1.1`,
    };
  },
};

// ---------------------------------------------------------------------------
// S3 — bus observability (read)
// ---------------------------------------------------------------------------

const listCommandsTool: McpTool = {
  name: "scribe_list_commands",
  description: "The operator command queue (bench_command): id, room, kind, status (pending|acked|failed|expired), source, created_at, acked_at, error. Filters: room (id/slug/name), status, limit (default 50, max 200). Newest first.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      ...ROOM_WRITE_ARGS,
      status: { type: "string", enum: ["pending", "acked", "failed", "expired"] },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    let roomId: string | null = null;
    if (argStr(args, "room", 128) || argStr(args, "room_id", 128) || argStr(args, "room_slug", 128)) {
      const r = await resolveForWrite(args);
      if ("error" in r) return { commands: [], ...r.error };
      roomId = r.room.id;
    }
    try {
      const rows = await listCommands({ roomId, status: argStr(args, "status", 16), limit: argInt(args, "limit", 50, 1, 200) });
      return {
        commands: rows.map((c) => ({
          id: c.id,
          room_id: c.room_id,
          room_slug: c.room_slug,
          room_name: c.room_name,
          kind: c.kind,
          status: c.status,
          source: c.source,
          args: c.args ?? null,
          result: c.result ?? null,
          error: c.error,
          created_at: new Date(c.created_at).toISOString(),
          acked_at: c.acked_at ? new Date(c.acked_at).toISOString() : null,
        })),
      };
    } catch (e) {
      return busErrorResult(e, { commands: [] });
    }
  },
};

// ---------------------------------------------------------------------------
// U3 — one day picture (read; ETA-MCP-UPGRADE PRD §4, D11)
//
// THE TAPE CLOCK GOVERNS: the end of a recording is the end of the last piece
// recorded on EITHER microphone (chunk ended_at — the recorder's clock), never
// the stored bench_session.ended_at, which can be a manual close hours later
// (bs_j9wgfa33, 19 Aug). Where the two disagree, both are shown and the
// disagreement is named. Every window below is the reaper's own
// STALLED_BADGE_MINUTES / the bus's own LISTENER_FRESH_MS — imported, never a
// second number. Read-only, no identity (labels and notes can carry clinician
// names, so neither tool returns them), fail-safe throughout.
// ---------------------------------------------------------------------------

const msOfLoose = (v: string | Date | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/** Gaps shorter than this are rotation seams, not silence — the same 2 s line the
 *  session rollup's gap_count draws (listBenchSessions: gap_before_ms >= 2000). */
export const DAY_GAP_MIN_MS = 2_000;

/** The tape's end: the newest chunk ended_at across BOTH microphones. Null when no piece. */
export function tapeEndMs(chunks: ReadonlyArray<{ ended_at: string | Date }>): number | null {
  let max: number | null = null;
  for (const c of chunks) {
    const t = msOfLoose(c.ended_at);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

/** The tape's start: the oldest chunk started_at across BOTH microphones. Null when no piece.
 *  U1 pairs it with tapeEndMs for the replay window — the FIRST and LAST piece recorded, which
 *  is the only honest session window (started_at can precede the first piece, and the stored
 *  ended_at is not the end of the recording at all). */
export function tapeStartMs(chunks: ReadonlyArray<{ started_at: string | Date }>): number | null {
  let min: number | null = null;
  for (const c of chunks) {
    const t = msOfLoose(c.started_at);
    if (t !== null && (min === null || t < min)) min = t;
  }
  return min;
}

/** U3 day report: stored end vs tape end differ by MORE than the reaper's badge window
 *  (either direction — a stored end far before the last piece is just as untrue). */
export function endTimeDisagrees(storedEndMs: number | null, tapeMs: number | null): boolean {
  if (storedEndMs == null || tapeMs == null) return false;
  return Math.abs(storedEndMs - tapeMs) > STALLED_BADGE_MINUTES * 60_000;
}

/** U3 diff flag: the stored end time is LATER than the last piece by more than the same
 *  window — the session claims tape that was never recorded (PRD: `ended_at_lies`). */
export function endedAtLies(storedEndMs: number | null, tapeMs: number | null): boolean {
  if (storedEndMs == null || tapeMs == null) return false;
  return storedEndMs - tapeMs > STALLED_BADGE_MINUTES * 60_000;
}

/** Periods with no piece on EITHER microphone: merge every chunk interval across both
 *  streams, report the holes ≥ minGapMs. A hole covered by the backup is not a gap. */
export function coverageGaps(
  chunks: ReadonlyArray<{ started_at: string | Date; ended_at: string | Date }>,
  minGapMs: number = DAY_GAP_MIN_MS,
): Array<{ from: string; to: string; seconds: number }> {
  const spans = chunks
    .map((c) => ({ s: msOfLoose(c.started_at), e: msOfLoose(c.ended_at) }))
    .filter((x): x is { s: number; e: number } => x.s !== null && x.e !== null && x.e > x.s)
    .sort((a, b) => a.s - b.s);
  const gaps: Array<{ from: string; to: string; seconds: number }> = [];
  let coveredTo: number | null = null;
  for (const sp of spans) {
    if (coveredTo !== null && sp.s - coveredTo >= minGapMs) {
      gaps.push({ from: new Date(coveredTo).toISOString(), to: new Date(sp.s).toISOString(), seconds: Math.round((sp.s - coveredTo) / 1000) });
    }
    coveredTo = coveredTo === null ? sp.e : Math.max(coveredTo, sp.e);
  }
  return gaps;
}

type DaySessionRow = Pick<BenchSessionRollupRow, "id" | "status" | "started_at" | "ended_at">;
type DayEventRow = Pick<BenchEventRow, "id" | "kind" | "at" | "brain_status" | "payload">;

/** PURE — one session of the day report, shaped from rows already read. */
export function buildDaySession(
  s: DaySessionRow,
  chunks: ReadonlyArray<Pick<BenchChunkRow, "source" | "started_at" | "ended_at" | "upload_state">>,
  events: ReadonlyArray<DayEventRow>,
): Record<string, unknown> {
  const primary = chunks.filter((c) => c.source !== "backup");
  const backup = chunks.filter((c) => c.source === "backup");
  const tapeMs = tapeEndMs(chunks);
  const storedMs = msOfLoose(s.ended_at);
  const tapeIso = tapeMs !== null ? new Date(tapeMs).toISOString() : null;
  const storedIso = storedMs !== null ? new Date(storedMs).toISOString() : null;
  const payloadOf = (e: DayEventRow): Record<string, unknown> =>
    typeof e.payload === "object" && e.payload !== null ? (e.payload as Record<string, unknown>) : {};
  const atIso = (e: DayEventRow) => new Date(e.at).toISOString();
  const byAt = (a: DayEventRow, b: DayEventRow) => msOfLoose(a.at)! - msOfLoose(b.at)!;
  return {
    session_id: s.id,
    status: s.status,
    started_at: new Date(s.started_at).toISOString(),
    // THE TAPE CLOCK: the last piece recorded, either microphone. Never the stored end.
    tape_ended_at: tapeIso,
    ...(storedIso !== null && storedIso !== tapeIso ? { ended_at: storedIso } : {}),
    end_time_disagrees: endTimeDisagrees(storedMs, tapeMs),
    chunks: {
      primary: { count: primary.length, verified: primary.filter((c) => c.upload_state === "verified").length },
      backup: { count: backup.length, verified: backup.filter((c) => c.upload_state === "verified").length },
    },
    gaps: coverageGaps(chunks),
    consult_marks: events
      .filter((e) => e.kind === "consult_mark")
      .sort(byAt)
      .map((e) => ({ id: e.id, at: atIso(e), reached_brain: e.brain_status === "sent" })),
    mic_events: events
      .filter((e) => e.kind.startsWith("mic_"))
      .sort(byAt)
      .map((e) => {
        const p = payloadOf(e);
        return { kind: e.kind, at: atIso(e), ...(typeof p.reason === "string" ? { reason: p.reason } : {}) };
      }),
    remount_events: events
      .filter((e) => e.kind === "kiosk_remount_resumed")
      .sort(byAt)
      .map((e) => {
        const p = payloadOf(e);
        return {
          at: atIso(e),
          silence_seconds: typeof p.silence_seconds === "number" ? p.silence_seconds : null,
          ...(typeof p.handover_timed_out === "boolean" ? { handover_timed_out: p.handover_timed_out } : {}),
        };
      }),
  };
}

const dayReport: McpTool = {
  name: "scribe_day_report",
  description:
    "One room, one IST calendar day (default today): every session in start order with tape_ended_at (the last piece recorded on EITHER microphone — the tape clock governs; the stored ended_at is shown only when it differs, and end_time_disagrees names a gap wider than the stall window), per-mic chunk counts, coverage gaps, consult marks (with whether each reached the brain), the mic story, and remount/rejoin events with their recorded silence. Read-only; no labels, no notes, no identity.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room: { type: "string", description: "room id, slug, or exact name" },
      room_id: { type: "string" },
      room_slug: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata); default today" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ sessions: [] as unknown[] }, async () => {
      let room: RoomRef | null;
      try {
        room = await resolveRoom(args);
      } catch (e) {
        if (e instanceof AmbiguousRoomError) {
          return { sessions: [], error: "ambiguous_room", matches: e.matches.map((m) => ({ id: m.id, slug: m.slug, name: m.name })) };
        }
        throw e;
      }
      if (!room) return { sessions: [], error: "unknown_room" };
      const d = argStr(args, "ist_date", 10);
      if (d && !IST_DATE_RE.test(d)) return { sessions: [], error: "invalid_ist_date" };
      const day = d ?? istDate(new Date());
      const rows = await listBenchSessions({ room_id: room.id, ist_date: day });
      const ordered = [...rows].sort((a, b) => (msOfLoose(a.started_at) ?? 0) - (msOfLoose(b.started_at) ?? 0));
      const degraded: string[] = [];
      const sessions = await Promise.all(
        ordered.map(async (s) => {
          let chunks: BenchChunkRow[] = [];
          try {
            chunks = await listBenchChunks(s.id); // fail-safe [] inside — but keep the guard
          } catch {
            degraded.push(`${s.id}:chunks_read_failed`);
          }
          let events: BenchEventRow[] = [];
          try {
            events = await listBenchEvents(s.id);
          } catch {
            degraded.push(`${s.id}:events_read_failed`);
          }
          return buildDaySession(s, chunks, events);
        }),
      );
      return {
        room: { id: room.id, slug: room.slug, name: room.name },
        ist_date: day,
        note: "tape_ended_at is the last piece recorded (either microphone) — the stored ended_at is not the end of the recording and is shown only where it differs",
        sessions,
        ...(degraded.length ? { degraded_reads: degraded } : {}),
      };
    }),
};

const diffRoom: McpTool = {
  name: "scribe_diff_room",
  description:
    "The now-picture across enabled rooms (or one room): is a page open (kiosk polled within the bus's freshness window), is anything recording, the last cue, the last piece recorded today, and four flags — kiosk_not_listening, stalled (recording but the last piece is older than the stall window), tape_without_cues (a recording exists today with no cue on the room's day), ended_at_lies (a stored end time later than the last piece by more than the stall window, with the offending session ids). Read-only; no identity.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room: { type: "string", description: "optional: one room by id, slug, or exact name" },
      room_id: { type: "string" },
      room_slug: { type: "string" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ rooms: [] as unknown[] }, async () => {
      const now = new Date();
      const today = istDate(now);
      let targets: RoomRef[] = [];
      if (argStr(args, "room", 128) || argStr(args, "room_id", 128) || argStr(args, "room_slug", 128)) {
        try {
          const one = await resolveRoom(args);
          if (!one) return { rooms: [], error: "unknown_room" };
          targets = [one];
        } catch (e) {
          if (e instanceof AmbiguousRoomError) {
            return { rooms: [], error: "ambiguous_room", matches: e.matches.map((m) => ({ id: m.id, slug: m.slug, name: m.name })) };
          }
          throw e;
        }
      } else {
        const rows = (await sql`
          SELECT id, slug, name FROM room WHERE disabled_at IS NULL ORDER BY created_at
        `) as Array<{ id: string; slug: string; name: string }>;
        targets = rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, enabled: true }));
      }

      const rooms = await Promise.all(
        targets.map(async (room) => {
          const reasons: string[] = [];
          // Page open now? The bus's own freshness rule (LISTENER_FRESH_MS, imported).
          let listener: ListenerRow | null = null;
          let pageOpen: boolean | null = null;
          try {
            listener = await getListener(room.id);
            pageOpen = isListening(listener, now);
          } catch (e) {
            const b = e instanceof BusError ? e : classifyBusError(e);
            reasons.push(`listener_unavailable:${b.code}`);
          }
          // Today's sessions (rollup: status, last_any_chunk_at, ended_at — the badge's own inputs).
          let sessions: BenchSessionRollupRow[] = [];
          try {
            sessions = await listBenchSessions({ room_id: room.id, ist_date: today });
          } catch {
            reasons.push("sessions_unavailable");
          }
          const recordingSession = sessions.find((s) => s.status === "recording") ?? null;
          const lastPieceMs = sessions.reduce<number | null>((acc, s) => {
            const t = msOfLoose(s.last_any_chunk_at);
            return t !== null && (acc === null || t > acc) ? t : acc;
          }, null);
          const anyTapeToday = sessions.some((s) => s.chunk_count + s.backup_chunk_count > 0);
          const stalled = sessions.some((s) => isBenchStalled(s, now.getTime()));
          const liars = sessions.filter((s) => endedAtLies(msOfLoose(s.ended_at), msOfLoose(s.last_any_chunk_at) ?? msOfLoose(s.started_at)));
          // The last cue on the room's brain day. A brain fault is UNKNOWN, never a flag.
          let lastCue: { id: string; type: string; at: string } | null = null;
          let cueCountKnown = false;
          try {
            const c = await listCuesForDay(room.id, today, { limit: 1 });
            cueCountKnown = true;
            const newest = c.cues[0] ?? null;
            if (newest) lastCue = { id: newest.id, type: newest.type, at: newest.at };
          } catch (e) {
            reasons.push(`cues_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
          }
          return {
            room: { id: room.id, slug: room.slug, name: room.name },
            page_open: pageOpen,
            listener_age_ms: listener ? now.getTime() - new Date(listener.last_poll_at).getTime() : null,
            recording: recordingSession !== null,
            recording_session_id: recordingSession?.id ?? null,
            last_piece_at: lastPieceMs !== null ? new Date(lastPieceMs).toISOString() : null,
            last_cue: lastCue,
            flags: {
              kiosk_not_listening: pageOpen === null ? null : !pageOpen,
              stalled,
              tape_without_cues: cueCountKnown ? anyTapeToday && lastCue === null : null,
              ended_at_lies: liars.length > 0,
            },
            ...(liars.length ? { ended_at_lies_sessions: liars.map((s) => s.id) } : {}),
            ...(reasons.length ? { degraded: reasons } : {}),
          };
        }),
      );
      return {
        ist_date: today,
        freshness_window_ms: LISTENER_FRESH_MS,
        stall_window_minutes: STALLED_BADGE_MINUTES,
        rooms,
      };
    }),
};

// ---------------------------------------------------------------------------
// U1 — replay a finished day (read; ETA-MCP-UPGRADE PRD §6)
//
// THERE IS NO WRITE PATH IN THIS BUILD. Dry run is the only mode. Everything below
// reads (findBenchSession / listBenchChunks / listBenchEvents — three SELECTs already
// in lib/bench) and shapes; nothing posts a cue, inserts a row, creates a day or leaves
// a scratch object. A write path that exists can be triggered by accident, and the thing
// it would overwrite is a real clinic day.
//
// DETERMINISM: two runs on the same session must be byte-identical, so nothing here reads
// the clock (no generated_at) and the order is total — time, then kind, then row id, so
// ties never shuffle. The natural key for whoever later builds the writer is
// (session_id, type, at); it is stated in the tool description so that contract is
// inherited rather than reinvented.
// ---------------------------------------------------------------------------

/** The seven event kinds a day replays as cues (PRD §6).
 *  NOT here, deliberately: speech turns (transcribing a whole day is a different job with a
 *  different cost, and it is not settled) and kiosk_handover_complete / kiosk_tab_gone
 *  (they describe the kiosk's own plumbing, not the day). */
export const REPLAY_KINDS = [
  "consult_mark",
  "mic_primary_lost",
  "mic_primary_restored",
  "mic_backup_unavailable",
  "mic_backup_error",
  "mic_backup_restored",
  "kiosk_remount_resumed",
] as const;

const REPLAY_KIND_SET: ReadonlySet<string> = new Set<string>(REPLAY_KINDS);

/**
 * Payload fields dropped before a cue leaves this tool. bench_event.payload is an open jsonb
 * written from kiosk and operator input, so it is filtered by name, not trusted: `note` is the
 * operator's free text on a consult mark (scribe_mark_consult), `message` is free text off a
 * browser error, and `label` / `mic_label` / `notes` / `device_label` are the human-readable
 * names of a session or a microphone. Every one of them can carry a clinician or patient name.
 * Operational fields (reason, idx, source, silence_seconds, next_idx, …) pass through unchanged.
 */
export const REPLAY_DROPPED_PAYLOAD_FIELDS = ["device_label", "label", "message", "mic_label", "note", "notes"] as const;

const REPLAY_DROP_SET: ReadonlySet<string> = new Set<string>(REPLAY_DROPPED_PAYLOAD_FIELDS);

export const REPLAY_DEFAULT_LIMIT = 500;
export const REPLAY_MAX_LIMIT = 1000;

/** Typed against the brain's own cue sources, so a replay cue is a legal cue by construction. */
const REPLAY_SOURCE: CueSource = "replay";

export type ReplayCue = {
  type: string;
  at: string;
  payload: Record<string, unknown>;
  source: CueSource;
  event_id: string;
};

/** Identity filter + stable key order (so the serialised cue cannot shuffle between runs). */
export function replayPayload(payload: unknown): { payload: Record<string, unknown>; dropped: string[] } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { payload: {}, dropped: [] };
  const src = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const k of Object.keys(src).sort()) {
    if (REPLAY_DROP_SET.has(k)) dropped.push(k);
    else out[k] = src[k];
  }
  return { payload: out, dropped };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type ReplayEventRow = Pick<BenchEventRow, "id" | "kind" | "at" | "payload">;

/**
 * PURE — event rows → the cue list. Only REPLAY_KINDS survive; the order is total (time, kind,
 * row id); over `limit` the FIRST `limit` in time order are returned and `truncated` says so
 * with the true total. Never silently truncates, never writes.
 */
export function buildReplayCues(
  events: ReadonlyArray<ReplayEventRow>,
  limit: number = REPLAY_DEFAULT_LIMIT,
): { cues: ReplayCue[]; emitted: number; total: number; truncated: boolean; dropped_payload_fields: string[] } {
  const eligible = events.filter((e) => REPLAY_KIND_SET.has(e.kind));
  const ordered = [...eligible].sort(
    (a, b) => (msOfLoose(a.at) ?? 0) - (msOfLoose(b.at) ?? 0) || cmp(a.kind, b.kind) || cmp(a.id, b.id),
  );
  const total = ordered.length;
  const kept = ordered.slice(0, Math.max(0, limit));
  const dropped = new Set<string>();
  const cues = kept.map((e) => {
    const p = replayPayload(e.payload);
    for (const f of p.dropped) dropped.add(f);
    return {
      type: e.kind,
      at: new Date(e.at).toISOString(),
      payload: p.payload,
      source: REPLAY_SOURCE,
      event_id: e.id,
    };
  });
  return {
    cues,
    emitted: cues.length,
    total,
    truncated: total > cues.length,
    dropped_payload_fields: [...dropped].sort(),
  };
}

const replaySession: McpTool = {
  name: "scribe_replay_session",
  description:
    "DRY RUN, THE ONLY MODE — replay a finished session as the cue list it would have produced live, and WRITE NOTHING (no cue posted, no row inserted, no day created). Cues in time order, each { type, at (the event's own recorded time, the client's wall clock), payload, source:'replay', event_id (the bench_event row it came from) }, plus a header with the session, room, IST day, the count emitted and the session window taken from the FIRST and LAST piece recorded (never the stored ended_at). Kinds replayed: consult_mark, mic_primary_lost, mic_primary_restored, mic_backup_unavailable, mic_backup_error, mic_backup_restored, kiosk_remount_resumed — no speech turns, no kiosk handover/tab-gone plumbing. Deterministic: ordered by time, then kind, then row id, so two runs on one session are identical. The natural key for a later writer is (session_id, type, at). limit default 500, max 1000; over the limit the first `limit` come back with truncated:true and the true total. No labels, no notes, no identity.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "bs_… id" },
      limit: { type: "integer", minimum: 1, maximum: REPLAY_MAX_LIMIT, default: REPLAY_DEFAULT_LIMIT },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ cues: [] as unknown[] }, async () => {
      const id = argStr(args, "session_id", 64);
      if (!id || !id.startsWith("bs_")) return { cues: [], error: "bad_session_id" };
      const session = await findBenchSession(id);
      if (!session) return { cues: [], error: "session_not_found" };
      const limit = argInt(args, "limit", REPLAY_DEFAULT_LIMIT, 1, REPLAY_MAX_LIMIT);

      const degraded: string[] = [];
      // The window: the first and last piece recorded on EITHER microphone.
      let chunks: BenchChunkRow[] = [];
      try {
        chunks = await listBenchChunks(session.id); // fail-safe [] inside — keep the guard
      } catch {
        degraded.push("chunks_read_failed");
      }
      const fromMs = tapeStartMs(chunks);
      const toMs = tapeEndMs(chunks);

      let events: BenchEventRow[] = [];
      try {
        events = await listBenchEvents(session.id);
      } catch {
        degraded.push("events_read_failed");
      }
      // listBenchEvents reads at most 2000 rows; at exactly that many the total below is a
      // floor, not the count. Say so rather than report a number that could be short.
      if (events.length >= 2000) degraded.push("event_read_cap_2000_reached");

      const built = buildReplayCues(events, limit);
      return {
        session_id: session.id,
        room: { id: session.room_id, slug: session.room_slug, name: session.room_name },
        ist_date: istDate(new Date(session.started_at)),
        session_window: {
          from: fromMs !== null ? new Date(fromMs).toISOString() : null,
          to: toMs !== null ? new Date(toMs).toISOString() : null,
        },
        emitted: built.emitted,
        total: built.total,
        truncated: built.truncated,
        ...(built.truncated
          ? { truncation_note: `list cut short at limit ${limit}: the first ${built.emitted} cues in time order, of ${built.total} replayable events on this session` }
          : {}),
        source: REPLAY_SOURCE,
        kinds: REPLAY_KINDS,
        natural_key: ["session_id", "type", "at"],
        dry_run: true,
        wrote: "nothing",
        ...(built.dropped_payload_fields.length ? { dropped_payload_fields: built.dropped_payload_fields } : {}),
        note: "dry run — nothing was written. The window is the first and last piece recorded on either microphone, not the stored ended_at. Order is time, then kind, then row id; the natural key for a writer is (session_id, type, at).",
        cues: built.cues,
        ...(degraded.length ? { degraded_reads: degraded } : {}),
      };
    }),
};

export const BENCH_TOOLS: McpTool[] = [
  listSessions,
  getSession,
  getRecording,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  markConsult,
  extractAudio,
  transcribeRange,
  listCommandsTool,
  dayReport,
  diffRoom,
  replaySession,
];
