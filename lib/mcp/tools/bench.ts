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
 * scribe_set_audio_input (R4-D6) — the same path with args {device_uid?, input_volume?}, validated
 * before the room is resolved (bad_args), refused APP_TOO_OLD below app 0.1.21 (R4-D11); executed by
 * the native app only.
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
 * U4 (ETA-MCP-UPGRADE PRD §7 — use the backup microphone when the primary was lost):
 * with NO microphone named, scribe_extract_audio / scribe_transcribe_range build the periods the
 * primary was recorded as lost from the session's own mic events (lib/bench-source, D1 — nothing
 * listens to the audio) and answer an overlapping window from the backup, saying so with the
 * reason and the overlap. A microphone named explicitly always wins, either way. Where no backup
 * pieces exist the range resolver finds none and today's no_audio_in_range stands (never silence,
 * never invented audio).
 *
 * U1 (ETA-MCP-UPGRADE PRD §6, read only — DRY RUN, THE ONLY MODE):
 * scribe_replay_session — a finished day turned back into the stream of cues it would have
 *                     produced live. It WRITES NOTHING: no cue posted, no row inserted, no day
 *                     created, not behind a flag and not commented out. There is no write path
 *                     in this build; a future slice that wants to post replay output adds the
 *                     write then, with its own decision behind it. Input to the fuse work, not
 *                     a feature for the clinic.
 *
 * FUSE SLICE 2 (write) — that future slice is here, and it is a SEPARATE tool:
 * scribe_replay_write — the same cue list, written into a SCRATCH graph: a scratch room
 *                     derived from the session's real room, a scratch room_day for the
 *                     session's own IST date, and every write naming that day so the cue
 *                     route's guard refuses anything that is not a scratch day. Idempotent on
 *                     (session_id, type, at). Refuses any session whose status is not
 *                     'ended' (session_not_ended) — a live tape written into scratch is a
 *                     partial day that reads as a complete one. scribe_replay_session is not
 *                     touched by it — dry run stays the default because writing is a different
 *                     tool, not an option on this one, and a dry run of an open tape is safe.
 */

import { findBenchSession, listBenchChunks, listBenchConsultMarks, listBenchEvents, listBenchSessions, newEventId, splitChunksBySource, type BenchChunkRow, type BenchEventRow, type BenchSessionRollupRow } from "@/lib/bench";
import { renderBenchTimeline } from "@/lib/bench-timeline";
import { getObjectBytes, signGetUrl } from "@/lib/r2";
import { sql } from "@/lib/db";
import { transcribeWithWhisper, type WhisperSegment } from "@/lib/whisper";
import { fmtIstClock, istDate, parseOperatorTime, resolveRange, type CoveringChunk } from "@/lib/bench-range";
// T3 — the operator path's transcriber, named by the adapter rather than typed into a payload.
import { whisperAdapter } from "@/lib/stt/adapters/whisper";
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
// U4: which microphone answers a window — the recording's own events decide (D1, D13).
import { decideSource, sourceAnswer, type MicSource, type SourceDecision } from "@/lib/bench-source";
import { closeOrphanedSession } from "@/lib/bench-orphan";
// U3: the reaper's OWN window and badge rule — imported, never retyped (PRD D11).
import { isBenchStalled, STALLED_BADGE_MINUTES } from "@/lib/bench-reaper-core";
import { listCuesForDay, WINDOW_CUE_TYPE } from "@/lib/brain/state";
import { query as brainQuery } from "@/lib/brain/db";
// The live monitor's shared rules, imported so the MCP and the admin screen can never
// disagree about a threshold, a label, or what an unreadable marker means.
import {
  SQL_LAST_WINDOW_MARKER,
  SQL_ROOM_DAY_ROLLUP,
  SQL_VISITS_TODAY,
  istDayRangeUtc,
  listenerState as listenerStateOf,
  markerComplete,
  roomState,
} from "@/lib/admin/rooms-live";
// EVERY ROOM FACT IS DECIDED IN ONE PLACE (Build 1 §3.6). The door used to hold its own copy of
// half of these rules and disagree with the screen about the other half — the doctor clock fell
// back on one side only, the screen had the ended-disagrees alarm and the door only its mirror
// image, and the two processing switches were reported by neither. All of it now comes from the
// same pure module the screen renders from, so anything the screen can say the door can say, in
// the same words.
import {
  DOCTOR_CLOCK_NOTE,
  doctorClockLevel,
  doctorClockSilentMs,
  endedAtLies as endedAtLiesShared,
  hasDoctorClock,
  strandedAudio,
  tapeLane,
  transcriptLane,
  visitsLane,
  ZERO_STRANDED_RAW,
  type TranscriptCounts,
} from "@/lib/room-facts";
import { readChunksAfterEnd, readMicSizes, readSwitches, readTranscriptAndStranded } from "@/lib/admin/room-reads";
import { ENDED_DISAGREES_SKEW_GRACE_MS, ENDED_DISAGREES_HINT, ENDED_DISAGREES_TITLE, parseInstallState, type InstallStateFlag } from "@/lib/bench-bus-constants";
import { parseMicLevelPair } from "@/lib/bench-levels";
// Fuse slice 2: the scratch room and the scratch day the replay writer writes into (F6, F7).
import { resolveScratchGraph, SCRATCH_ROOM_PREFIX } from "@/lib/brain/scratch";
import { boundInstallForRoom, InstallError, readFleet } from "@/lib/room-install";
import { deriveRow } from "@/lib/room-install-view";
import {
  ACK_WAIT_MS,
  ackWaitMsFor,
  audioInputRefusal,
  BusError,
  classifyBusError,
  CommandArgsError,
  decideStart,
  findActiveSession,
  getListener,
  insertCommand,
  isListening,
  isTier1Verb,
  LISTENER_FRESH_MS,
  listCommands,
  parseSetAudioInputArgs,
  parseVerbArgs,
  TIER1_VERBS,
  verbRefusal,
  waitForAck,
  type CommandKind,
  type ListenerRow,
  type SetAudioInputArgs,
} from "@/lib/bench-commands";
import { argBool, argDate, argDetail, argInt, argStr, DETAIL_SCHEMA, failSafe, pickSummary, IST_DATE_RE, type McpTool, type ToolArgs, type ToolContext } from "../registry";
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
  "End the room's day via the kiosk (command end_day): the kiosk flushes the last chunk, ends the session, then acks. Requires a listener. May answer ack_timeout if the flush outlasts the 8 s wait — check scribe_get_session. DOES NOTHING to a session whose kiosk is GONE — the kiosk ends its OWN session and a replacement tab holds none; use scribe_close_orphaned_session for that.",
);

/**
 * R4-D6 — the MCP door onto `set_audio_input`, for driving OPD 3 / OPD 7 from the desk (the fleet
 * route is proxy-blocked from Cowork; this door is not). Not a simpleVerb: it carries args, and
 * they are validated BEFORE the room is looked up, so a bad call touches nothing.
 */
const setAudioInput: McpTool = {
  name: "scribe_set_audio_input",
  description:
    "Switch the room's recording device and/or set its input volume via the native Room Recorder (command set_audio_input, app 0.1.21+). Give device_uid (a uid from the fleet card's input_devices) and/or input_volume (0..1); at least one. Refused with error {code:\"APP_TOO_OLD\", app_version} unless the room's bound Mac reports 0.1.21 or later (an older app cannot decode the command). Requires a listener (app polled within 10 s) else kiosk_not_listening — no command row is written. Waits up to 8 s for the ack and returns it: failures are named by the app (device_not_present, volume_not_settable, unsupported_kind, bad_args). A browser kiosk ignores this kind, so a room recording in a browser answers ack_timeout. A recording in progress continues in a new segment of the same session. The device and volume the room now reports arrive on its next poll (the fleet card), not in this answer.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      ...ROOM_WRITE_ARGS,
      device_uid: { type: "string", description: "CoreAudio uid of an input the room reports in input_devices" },
      input_volume: { type: "number", minimum: 0, maximum: 1, description: "input volume, 0..1; refused by the app when the device's volume is not settable" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    // Only the two command fields go to the validator; JSON-RPC clients may send a number as a string.
    const raw: Record<string, unknown> = {};
    if (args.device_uid !== undefined) raw.device_uid = args.device_uid;
    if (args.input_volume !== undefined) {
      const v = args.input_volume;
      raw.input_volume = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    }
    let cmdArgs: SetAudioInputArgs;
    try {
      cmdArgs = parseSetAudioInputArgs(raw);
    } catch (e) {
      if (e instanceof CommandArgsError) return { ok: false, error: "bad_args", detail: e.reason };
      throw e;
    }
    const r = await resolveForWrite(args);
    if ("error" in r) return r.error;
    const room = r.room;
    const roomRef = { id: room.id, slug: room.slug, name: room.name };
    const now = new Date();
    try {
      // R4-D11. The room's bound Mac must report 0.1.21 or later; no bound Mac (a browser-kiosk room)
      // is refused the same way. Same error object as the route's 409, and nothing is inserted.
      const bound = await boundInstallForRoom(room.id);
      const tooOld = audioInputRefusal(bound?.app_version ?? null);
      if (tooOld) return { ok: false, error: tooOld, room: roomRef };
      const listener = await getListener(room.id);
      const ctx = { room: roomRef, listener: listenerView(listener, now) };
      if (!isListening(listener, now)) return { ok: false, error: "kiosk_not_listening", ...ctx };
      return await sendAndWait(room, "set_audio_input", cmdArgs, listener);
    } catch (e) {
      if (e instanceof InstallError) return { ok: false, error: "install_lookup_failed", detail: e.message.slice(0, 160), room: roomRef };
      return busErrorResult(e, { room: roomRef });
    }
  },
};

/**
 * Tier 1 §3 — the MCP door onto the native app's three operator verbs, and the ONE tool Tier 1 adds
 * here. Args are validated before the room is resolved (bad_args touches nothing), then D11's floor
 * at 0.1.22, then the listener. NOT sendAndWait: that helper's 8 s and its hint belong to the day
 * verbs, and `report_diag` waits 20 s. The wait below is sendAndWait's, with the kind's own timeout.
 */
const roomCommand: McpTool = {
  name: "scribe_room_command",
  description:
    "Send one of the native Room Recorder's operator verbs to a room (app 0.1.22+) and wait for its ack. kind: check_update_now — run the self-update check now, bypassing the six-hour interval only; it still defers while a session is open (result {checked_at, offered_version?, deferred, held?}); report_diag — the app's version, build sha, config without its session, tapewriter/ffmpeg versions, input devices, free disk, the last N log lines (args {log_lines?: 0..500}, default 100) and the update ledger, in result.diag (waits 20 s); restart_engine — the app acks, then exits for launchd to relaunch it (result {restarting:true}); refused session_open while a session is open unless args {force:true}. Every refusal is ok:false with the app's error name. Refused with error {code:\"APP_TOO_OLD\", app_version} unless the room's bound Mac reports 0.1.22 or later — nothing is inserted. Requires a listener (app polled within 10 s) else kiosk_not_listening. A browser kiosk ignores these kinds.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      ...ROOM_WRITE_ARGS,
      kind: { type: "string", enum: [...TIER1_VERBS] },
      args: { type: "object", description: "report_diag: {log_lines?: integer 0..500}; restart_engine: {force?: boolean}; check_update_now: omit" },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const kind = args.kind;
    if (!isTier1Verb(kind)) return { ok: false, error: "unknown_kind", allowed: [...TIER1_VERBS] };
    let cmdArgs: Record<string, unknown> | null;
    try {
      cmdArgs = parseVerbArgs(kind, args.args);
    } catch (e) {
      if (e instanceof CommandArgsError) return { ok: false, error: "bad_args", detail: e.reason };
      throw e;
    }
    const r = await resolveForWrite(args);
    if ("error" in r) return r.error;
    const room = r.room;
    const roomRef = { id: room.id, slug: room.slug, name: room.name };
    const now = new Date();
    try {
      const bound = await boundInstallForRoom(room.id);
      const tooOld = verbRefusal(kind, bound?.app_version ?? null);
      if (tooOld) return { ok: false, error: tooOld, room: roomRef };
      const listener = await getListener(room.id);
      if (!isListening(listener, now)) return { ok: false, error: "kiosk_not_listening", room: roomRef, listener: listenerView(listener, now) };
      const timeoutMs = ackWaitMsFor(kind);
      const insertedAt = Date.now();
      const commandId = await insertCommand({ roomId: room.id, kind, args: cmdArgs ?? undefined, source: "mcp" });
      const row = await waitForAck(commandId, { timeoutMs });
      const base = { room: roomRef, kind, command_id: commandId };
      if (!row) {
        let delivered = false;
        try {
          const l = await getListener(room.id);
          delivered = !!l && new Date(l.last_poll_at).getTime() >= insertedAt - 1_000;
        } catch {
          /* fall through: not shown to have been delivered */
        }
        return delivered
          ? { ok: false, error: "ack_timeout", ...base, hint: `the app received the command but has not acked within ${timeoutMs / 1000} s — check scribe_list_commands` }
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
    } catch (e) {
      if (e instanceof InstallError) return { ok: false, error: "install_lookup_failed", detail: e.message.slice(0, 160), room: roomRef };
      return busErrorResult(e, { room: roomRef });
    }
  },
};

/**
 * K5 A2 — the second door onto the orphan repair. Deliberately NOT a simpleVerb: every one of
 * those queues a command for a kiosk to execute, and this exists because there is no kiosk.
 */
const closeOrphaned: McpTool = {
  name: "scribe_close_orphaned_session",
  description:
    "REPAIR, NOT A STOP — close a session whose kiosk is GONE, server-side, so the room can record again. THE DEADLOCK IT BREAKS (seen on Home Office, 22 Aug): a kiosk tab dies mid-recording; end_day is a no-op because the kiosk ends its OWN session and the replacement tab holds none; start_day is refused because the room still has a session that is not 'ended'. The room is then unrecordable until the 30-minute reaper fires. REFUSES BY NAME when a kiosk is polling within 10 s AND claims that very session (kiosk_attached) — this can never stop a healthy recording, and stopping a live room is still end_day's job. Sets status='ended' and ended_at=NOW() on ONE row; NEVER touches bench_chunk, and returns the chunk count before and after so you can check that. Writes a bench.close_orphaned_session audit row carrying the session, the room, the actor and the listener evidence (tab, last poll, age, what it claimed). Returns { ok, session_id, ended_at, chunks_before, chunks_after, evidence }.",
  scope: "write",
  inputSchema: { type: "object", properties: ROOM_WRITE_ARGS, additionalProperties: false },
  handler: async (args: ToolArgs) => {
    const r = await resolveForWrite(args);
    if ("error" in r) return r.error;
    const room = r.room;
    const out = await closeOrphanedSession({ roomId: room.id, actorType: "system", actorId: "mcp" });
    const ctx = { room: { id: room.id, slug: room.slug, name: room.name } };
    if (!out.ok) {
      return {
        ...out,
        ...ctx,
        hint:
          out.error === "kiosk_attached"
            ? "a kiosk is polling and claims this session — it is alive. Use scribe_stop_recording."
            : out.error === "no_open_session"
              ? "this room has no session left open; nothing to repair"
              : undefined,
      };
    }
    return { ...out, ...ctx };
  },
};

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

type RangeArgsOk = {
  session: NonNullable<Awaited<ReturnType<typeof findBenchSession>>>;
  chunks: BenchChunkRow[];
  startMs: number;
  endMs: number;
  source: MicSource;
  istDay: string;
  /** U4 — which microphone answers, and why (lib/bench-source). */
  decision: SourceDecision;
  /** U4 — set when the mic story could not be read, so the primary was kept for want of evidence. */
  micDegraded: string | null;
};

/** Shared arg resolution for extract/transcribe: session (by id or room+ist_date), window, source. */
async function resolveRangeArgs(args: ToolArgs): Promise<RangeArgsOk | { error: Record<string, unknown> }> {
  // U4: "not named" and "named primary" are different answers, so the absence is kept, not
  // defaulted away. Only an explicit name reaches `requested`.
  const sourceRaw = argStr(args, "source", 16);
  if (sourceRaw !== null && sourceRaw !== "primary" && sourceRaw !== "backup") return { error: { ok: false, error: "bad_source" } };
  const requested: MicSource | null = sourceRaw;
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

  // U4 — with a microphone named, the events are not consulted at all: a stated choice is never
  // overridden, so there is nothing for them to decide and nothing to ask the database for. With
  // none named, the recording's own mic story decides (D1) against the tape clock, which is the
  // end of the last piece recorded on EITHER microphone — so an unpaired loss is held open to the
  // real end of the recording rather than tidied away.
  let micEvents: BenchEventRow[] = [];
  let micDegraded: string | null = null;
  if (requested === null) {
    try {
      micEvents = await listBenchEvents(session.id);
    } catch (e) {
      // Unreadable events are not evidence the primary was lost. The primary is kept and the
      // caller is told the story could not be read, rather than being quietly switched or lied to.
      micDegraded = `mic_events_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`;
    }
  }
  const decision = decideSource({ requested, events: micEvents, tapeEndMs: tapeEndMs(chunks), startMs: start.ms, endMs: end.ms });
  return { session, chunks, startMs: start.ms, endMs: end.ms, source: decision.source, istDay, decision, micDegraded };
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
  // U4: NO default. Omitted means "let the recording's own mic events decide"; naming one always
  // wins. The two are different questions and a default would erase one of them.
  source: { type: "string", enum: ["primary", "backup"], description: "omit to let the session's mic events choose (backup over a period the primary was recorded as lost); naming one always wins" },
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
  description: "Audio by clock time (PRD §10 + U2 + U4): map an IST window onto the session's chunk rows. Inside ONE chunk → one short-lived presigned GET + { offset_in_chunk_s, duration_s, chunk_idx, chunk_bounds }. Spanning chunks → the pieces are JOINED into one kept clip and answered with a single 1 h link plus the window asked for. Refused by name over 30 minutes (window_too_long) and while any room is recording (room_recording). If the joining service is unreachable or refuses, the answer degrades to the multi-piece response listing every covering piece with its own link — never an error page. MICROPHONE (U4): with `source` omitted, a window overlapping a period the recording's own events say the primary was lost is answered from the BACKUP, and the answer carries source_used:'backup', reason:'primary_lost' and the lost interval it met with the overlap; naming `source` explicitly always wins, silence and all. Nothing listens to the audio to judge silence. Where no backup piece covers the window → no_audio_in_range; audio is never invented. Never inline bytes.",
  scope: "invoke",
  inputSchema: {
    type: "object",
    properties: {
      ...RANGE_ARGS,
      async: { type: "boolean", default: false, description: "Tier 2 §3 — submit the equivalent `stitch` job and return {job_id} instead of waiting. Default false keeps today's behaviour for one release." },
    },
    required: ["start", "end"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    // Tier 2 §3 — `async:true` submits the equivalent job and returns its id. The synchronous
    // path below is UNCHANGED and stays the default for one release, so nothing that calls this
    // tool today sees a different answer.
    if (argBool(args, "async")) {
      const { submitJob, JobArgsError, UnknownKindError } = await import("@/lib/jobs/submit");
      try {
        const job = await submitJob({ kind: "stitch", args: args as Record<string, unknown>, actor: ctx.actor, origin: ctx.origin });
        return { ok: true, async: true, job_id: job.id, kind: job.kind, status: job.status };
      } catch (e) {
        if (e instanceof UnknownKindError) return { ok: false, error: "unknown_kind" };
        if (e instanceof JobArgsError) return { ok: false, error: "bad_args", detail: e.reason };
        throw e;
      }
    }
    const r = await resolveRangeArgs(args);
    if ("error" in r) return r.error;
    const res = resolveRange(r.chunks, r.startMs, r.endMs, r.source);
    const requested = { start: new Date(r.startMs).toISOString(), end: new Date(r.endMs).toISOString(), start_ist: fmtIstClock(r.startMs), end_ist: fmtIstClock(r.endMs), source: r.source, ist_date: r.istDay };
    // U4: source_used / source_requested ride on EVERY answer, including the failures, so the
    // microphone a caller got is never something it has to discover afterwards.
    const base = { session_id: r.session.id, room_slug: r.session.room_slug, requested_range: requested, ...sourceAnswer(r.decision), ...(r.micDegraded ? { degraded_reads: [r.micDegraded] } : {}) };
    // No backup piece where the primary was lost is exactly today's answer (§7): the window is
    // named, the reason is named, and no audio is invented to fill it.
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


// ---------------------------------------------------------------------------
// Speech turns, slice A — the tape becomes evidence (migration 0050)
//
// Whisper already knew where each phrase started; the client used to drop that and hand back
// one slab of text. It now returns segments, and everything below turns those segments into
// cues that the fuse can read alongside marks and warehouse events.
//
// Three rules, and they are the whole slice:
//
//   1. THE CLIP'S TRUE START. Segment seconds are relative to whatever audio was sent, and the
//      two branches send different audio: the single-chunk branch transcribes the WHOLE chunk,
//      so the clip starts at the chunk's own start; the joined branch is trimmed to the window,
//      so it starts where the trim began. Getting this wrong shifts every turn of the day by
//      minutes, silently, and nothing downstream could tell.
//   2. FLOOR, NEVER ROUND. A turn's identity is its millisecond bounds (they are two of the four
//      fields of its key), so the conversion has to be the same conversion every time. Rounding
//      moves a boundary by a millisecond depending on which side it fell, and the same turn
//      re-transcribed would then be a different turn.
//   3. A WINDOW THAT SURVIVED NOTHING SAYS SO. Six hours of tape with no speech and no cue is
//      indistinguishable from six hours nobody asked about. One stt_silence covering the asked
//      window is the difference between "nothing was said" and "nothing was looked at".
// ---------------------------------------------------------------------------

export const TURN_CUE_TYPE = "stt_turn";
export const SILENCE_CUE_TYPE = "stt_silence";

/**
 * K3 §3 — the completeness cue's speaker slot. `window` rather than `-`, so the window's own row
 * can never collide with the stt_silence that covers the same instants: both are one row over the
 * whole window, so without a different slot they would share a source_ref and the within-write
 * key would drop one of them.
 */
export const WINDOW_SPEAKER_SLOT = "window";

/**
 * K3 §2 — how long the ONE batch write may take. Deliberately not BRAIN_TIMEOUT_MS (5 s, sized
 * for a single cue): this request carries a whole window, and the transaction behind it takes the
 * day lock, deletes the old set, inserts the new one and reads the graph back. The lock's own
 * SET LOCAL statement_timeout ('10s' in lib/brain/lock.ts) is the real ceiling on any one
 * statement inside it; this is the ceiling on the round trip around all of them.
 */
const TURN_BATCH_TIMEOUT_MS = 30_000;

/**
 * The speaker slot in slice A, on every turn and on every silence, for ever. Slice B puts an
 * integer there; the literal `-` is what makes an anonymous turn and a diarised one different
 * rows rather than a collision.
 */
export const TURN_SPEAKER_UNKNOWN = "-";

/** Turns and silences are written as replay cues — the same `source` column the replay uses. */
const TURN_CUE_SOURCE: CueSource = "replay";

// K3 §2 removed the per-row budget and the consecutive-failure cut-out that used to live here.
// Both existed because the writer posted one HTTP request per cue: measured in production on the
// Cardiology window, 71 rows spread `created_at` over 44.3 s — 624 ms a row. A 165-segment window
// would have cost 103 s of inserts alone against this tool's 115 s cap, so no budget could have
// made a six-minute window finish. There is now ONE request for the whole window, and its ceiling
// is TURN_BATCH_TIMEOUT_MS. A partial no longer needs guarding against by counting failures,
// because a partial can no longer be committed: the transaction either takes the window or none
// of it (§4).

/**
 * The key, and the only definition of it in this codebase:
 *
 *     {session_id}|{start_ms}|{end_ms}|{speaker}
 *
 * Four fields, pipe separated, no spaces. start_ms and end_ms are integer epoch milliseconds,
 * FLOORED — never rounded, never ISO. The format never gains a fifth field.
 *
 *     bs_xvntaugh|1755576000000|1755576004320|-
 *
 * 0050's partial unique index is (source_ref, type) over exactly this string.
 */
export function turnSourceRef(sessionId: string, startMs: number, endMs: number, speaker: string = TURN_SPEAKER_UNKNOWN): string {
  return `${sessionId}|${Math.floor(startMs)}|${Math.floor(endMs)}|${speaker}`;
}

export type TurnDraft = {
  type: typeof TURN_CUE_TYPE | typeof SILENCE_CUE_TYPE | typeof WINDOW_CUE_TYPE;
  at: string;
  start_ms: number;
  end_ms: number;
  speaker: string;
  text: string;
  source_ref: string;
  payload: Record<string, unknown>;
};

export type TurnBuild = {
  turns: TurnDraft[];
  /** True when the window survived nothing and the single stt_silence is what came back. */
  silence: boolean;
  segments_considered: number;
  dropped_outside_window: number;
  dropped_blank: number;
};

/**
 * PURE — Whisper segments → the cues they become. No clock, no database, no I/O, so two runs
 * over the same segments are byte-identical and the whole mapping is testable.
 *
 * The order is the settled one: offset onto the clip's true start, filter to the window asked
 * for, drop blank text, and emit ONE stt_silence when nothing is left.
 *
 * A segment is kept when it OVERLAPS the window, not when it is contained by it: a phrase that
 * straddles the boundary was still spoken partly inside it, and its true bounds are what go in
 * the key — clamping them would invent a turn that nobody said. A zero-length segment is not a
 * turn and is dropped with the rest.
 *
 * A DELIBERATE DEVIATION FROM PRD D10, kept by K2: D10 said to drop a segment by its START.
 * Doing that loses speech at every window edge, and it buys nothing, because source_ref carries
 * the segment's OWN start and end — so the identical turn recovered from the adjacent window
 * produces the identical key and 0050's index absorbs it. Acceptance item 7 is rewritten to
 * match: a window emits no segment that fails to overlap it.
 */
export function buildTurns(opts: {
  sessionId: string;
  /**
   * K4b T3 — THE ENGINE THAT PRODUCED THESE SEGMENTS. Required, and every caller passes an
   * adapter's own `key` rather than a string. It used to be the literal "whisper" baked into
   * the payload here, which was true only for as long as Whisper was the only transcriber; the
   * room drain adds a second, and a cue that names the wrong engine is evidence of nothing.
   * This system has shipped a typed provider label twice and both times it hid a wrong provider
   * for months, so the type makes omitting it a compile error rather than a default.
   */
  engine: string;
  clipStartMs: number;
  windowStartMs: number;
  windowEndMs: number;
  segments: readonly WhisperSegment[];
  language?: string | null;
  speaker?: string;
  /** U4's answer for this window: 'primary' | 'backup'. Absent → null, i.e. unreported. */
  sourceUsed?: string | null;
}): TurnBuild {
  const speaker = opts.speaker ?? TURN_SPEAKER_UNKNOWN;
  const language = opts.language ?? null;
  const sourceUsed = opts.sourceUsed ?? null;
  // THE WINDOW ASKED FOR, on every cue this call emits — K2 correction 4. PRD §10's day
  // counters (minutes asked, minutes with words, minutes silent, windows on the backup mic,
  // the language whisper.cpp reported) are all rollups over `payload.window` and
  // `payload.source_used`, and none of them is derivable from a turn's own bounds: a turn is
  // as long as the phrase, not as long as the tape somebody asked about. FLOORED like every
  // other millisecond in this file, and IDENTICAL on every cue of the window so the rollup can
  // group by it.
  const windowStartMs = Math.floor(opts.windowStartMs);
  const windowEndMs = Math.floor(opts.windowEndMs);
  const asked = { start_ms: windowStartMs, end_ms: windowEndMs };
  // FAIL SAFE at the boundary: a transcriber that sent no segments at all — an older Whisper
  // build, a stub, a future engine — is a SILENT window, not a crash. The whole point of this
  // function is that the answer is always a cue list.
  const segments = Array.isArray(opts.segments) ? opts.segments : [];
  let droppedOutside = 0;
  let droppedBlank = 0;
  const turns: TurnDraft[] = [];

  for (const seg of segments) {
    // 1. onto the clock, with Math.floor on both ends.
    const startMs = Math.floor(opts.clipStartMs + seg.start_s * 1000);
    const endMs = Math.floor(opts.clipStartMs + seg.end_s * 1000);
    // 2. the window asked for, half-open like every other range in this file.
    if (!(startMs < opts.windowEndMs && endMs > opts.windowStartMs)) {
      droppedOutside++;
      continue;
    }
    // 3. blank text is not a turn. Whisper emits empty and whitespace-only segments over music,
    //    breathing and room tone, and a cue with no words is evidence of nothing.
    const text = seg.text.trim();
    if (!text) {
      droppedBlank++;
      continue;
    }
    turns.push({
      type: TURN_CUE_TYPE,
      at: new Date(startMs).toISOString(),
      start_ms: startMs,
      end_ms: endMs,
      speaker,
      text,
      source_ref: turnSourceRef(opts.sessionId, startMs, endMs, speaker),
      payload: {
        text,
        start_ms: startMs,
        end_ms: endMs,
        speaker,
        engine: opts.engine,
        language,
        session_id: opts.sessionId,
        window: asked,
        source_used: sourceUsed,
        ...(seg.no_speech_prob === undefined ? {} : { no_speech_prob: seg.no_speech_prob }),
      },
    });
  }

  const considered = segments.length;
  if (turns.length > 0) {
    return { turns, silence: false, segments_considered: considered, dropped_outside_window: droppedOutside, dropped_blank: droppedBlank };
  }

  // 4. nothing survived → ONE silence over the whole window asked for, keyed the same way, so a
  //    re-run of the same window writes the same single row rather than a second one.
  const startMs = windowStartMs;
  const endMs = windowEndMs;
  const silence: TurnDraft = {
    type: SILENCE_CUE_TYPE,
    at: new Date(startMs).toISOString(),
    start_ms: startMs,
    end_ms: endMs,
    speaker: TURN_SPEAKER_UNKNOWN, // a silence has no speaker in any slice
    text: "",
    source_ref: turnSourceRef(opts.sessionId, startMs, endMs, TURN_SPEAKER_UNKNOWN),
    payload: {
      start_ms: startMs,
      end_ms: endMs,
      speaker: TURN_SPEAKER_UNKNOWN,
      engine: opts.engine,
      language,
      session_id: opts.sessionId,
      // The same two fields, on the silence too. A window that produced no words is still a
      // window that was ASKED, and it is the entire population of "minutes silent".
      window: asked,
      source_used: sourceUsed,
      segments_considered: considered,
      dropped_outside_window: droppedOutside,
      dropped_blank: droppedBlank,
    },
  };
  return { turns: [silence], silence: true, segments_considered: considered, dropped_outside_window: droppedOutside, dropped_blank: droppedBlank };
}

/**
 * K3 §3 — the completeness cue for one asked window. PURE, like buildTurns.
 *
 * ONE row per asked window, saying whether the window was FINISHED. It is not evidence and it
 * never claims anything was heard; it is the difference between "we asked and could not finish"
 * and "we never asked", which no absence of turns can express on its own.
 *
 * `payload.window` is present here for the same reason it is on every turn, and it is REQUIRED
 * rather than decorative: SQL_CUE_DELETE_WINDOW matches on it, so a window cue without one could
 * never be replaced and would accumulate one row per run — the exact failure K3 exists to fix.
 * (K3 §3 lists the payload fields without naming `window`; §1 and §3's own "delete-then-insert
 * applies to stt_window, exactly as for turns" require it. Included, and flagged in the report.)
 */
export function buildWindowCue(opts: {
  sessionId: string;
  /** K4b T3 — as on buildTurns: the engine that produced the window, never typed. */
  engine: string;
  windowStartMs: number;
  windowEndMs: number;
  complete: boolean;
  segmentCount: number;
  language?: string | null;
  sourceUsed?: string | null;
  stoppedEarly?: string | null;
}): TurnDraft {
  const startMs = Math.floor(opts.windowStartMs);
  const endMs = Math.floor(opts.windowEndMs);
  const asked = { start_ms: startMs, end_ms: endMs };
  return {
    type: WINDOW_CUE_TYPE,
    at: new Date(startMs).toISOString(),
    start_ms: startMs,
    end_ms: endMs,
    speaker: WINDOW_SPEAKER_SLOT,
    text: "",
    source_ref: turnSourceRef(opts.sessionId, startMs, endMs, WINDOW_SPEAKER_SLOT),
    payload: {
      // `end` as the kickoff names it, ISO, beside the ms the delete and the rollup read.
      end: new Date(endMs).toISOString(),
      engine: opts.engine,
      source_used: opts.sourceUsed ?? null,
      complete: opts.complete,
      segment_count: opts.segmentCount,
      language: opts.language ?? null,
      session_id: opts.sessionId,
      window: asked,
      start_ms: startMs,
      end_ms: endMs,
      ...(opts.stoppedEarly ? { stopped_early: opts.stoppedEarly } : {}),
    },
  };
}

export type TurnWriteCounts = {
  deleted: number;
  written: number;
  already_existed: number;
  /** K4 §4 — WITHIN-WRITE key conflicts only. A bug, and never a turn count on a failure path. */
  dropped: number;
  /** K4 §4 — turns that could not be written at all, with `failed_reason` naming the cause. */
  failed: number;
  failed_reason?: string;
  attempted: number;
  complete: boolean;
  /** True only when the day itself holds a record of this ask. False → this answer is the record. */
  window_recorded: boolean;
  stopped_early?: string;
  turn_write_error?: string;
  detail?: string;
};

type BatchPost =
  | { ok: true; deleted: number; written: number; already_existed: number; dropped: number; attempted: number }
  | { ok: false; error: string; detail?: string };

/**
 * K4 §4 — why the turns could not be written, in the three kinds that call for different action.
 *
 * `dropped` used to absorb this and it lied: reporting 144 drops for a permission error invited
 * reading it as 144 key collisions, which is a data problem, when it was one missing GRANT.
 */
export function failureReason(error: string): "permission" | "transport" | "incomplete_write" {
  if (error === "brain_permission_denied") return "permission";
  if (error === "brain_timeout" || error === "brain_unreachable" || error === "service_token_not_configured") return "transport";
  return "incomplete_write";
}

/**
 * K3 §2 — POST one window as ONE request. Never throws.
 *
 * Goes straight at this app's own origin rather than through postBrainCue: the batch shape is
 * this route's own and there is exactly one brain now (lib/brain, in this deployment). One
 * door, and it is this app's.
 */
export async function postTurnBatch(
  origin: string,
  body: {
    room_id: string;
    room_day_id: string;
    session_id: string;
    source: string;
    /** OPTIONAL (K4 §3). Absent → the route issues NO DELETE, which is what lets the marker-only
     *  request record a failure without needing the verb the failed write needed. */
    replace_window?: { session_id: string; start_ms: number; end_ms: number };
    cues: Array<{ type: string; at: string; payload: Record<string, unknown>; source_ref: string }>;
  },
): Promise<BatchPost> {
  const token = process.env.BRAIN_SERVICE_TOKEN;
  if (!token) return { ok: false, error: "service_token_not_configured" };
  try {
    const res = await fetch(new URL("/api/brain/cues", origin).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TURN_BATCH_TIMEOUT_MS),
      cache: "no-store",
    });
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || j?.ok !== true) {
      return { ok: false, error: String(j?.error ?? `brain_${res.status}`) };
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return { ok: true, deleted: num(j.deleted), written: num(j.written), already_existed: num(j.already_existed), dropped: num(j.dropped), attempted: num(j.attempted) };
  } catch (e) {
    const name = (e as Error)?.name;
    return {
      ok: false,
      error: name === "TimeoutError" || name === "AbortError" ? "brain_timeout" : "brain_unreachable",
      detail: String((e as Error)?.message ?? e).slice(0, 160),
    };
  }
}

const asBatchCue = (d: TurnDraft) => ({ type: d.type, at: d.at, payload: d.payload, source_ref: d.source_ref });

/**
 * K3 §1 + §4, amended by K4 — write ONE window as a set: delete what was there, insert what there
 * is now, and record whether it finished.
 *
 * WHY REPLACE AND NOT MERGE. Whisper is not a deterministic writer — two runs of the same clip
 * returned 162 and 165 segments. source_ref is built from segment boundaries, so a second run's
 * keys mostly MISS the first run's and an insert-only writer accumulates two disagreeing opinions
 * of one window. Segmentation is Whisper's opinion about a window, and an opinion is replaced.
 *
 * THE MARKER DOES NOT SHARE THE TURNS' VERBS (K4). It used to: the fallback marker carried the
 * same `replace_window`, so it needed the same DELETE, so when the hole window died on a missing
 * DELETE grant the record of that death died with it. A marker that fails whenever the thing it
 * reports on fails is not a record. Now:
 *
 *   SUCCESS  one request: delete stt_turn/stt_silence for the pair → batch-insert the turns
 *            (DO NOTHING) → upsert the marker complete:true (DO UPDATE). One transaction.
 *   FAILURE  a second request carrying NO replace_window and ONE stt_window cue with
 *            complete:false, stopped_early and segment_count. It issues no DELETE at all, so it
 *            needs only INSERT and UPDATE — the verbs that were never in question.
 *   NEITHER  if the marker request also fails, the day holds NO record of this ask and the
 *            answer says exactly that. It does not imply otherwise (K4 §3).
 */
export async function writeWindowCues(
  origin: string,
  roomId: string,
  roomDayId: string,
  sessionId: string,
  window: { startMs: number; endMs: number },
  turns: readonly TurnDraft[],
  windowCueFor: (complete: boolean, stoppedEarly: string | null) => TurnDraft,
): Promise<TurnWriteCounts> {
  const replace_window = { session_id: sessionId, start_ms: Math.floor(window.startMs), end_ms: Math.floor(window.endMs) };
  const common = { room_id: roomId, room_day_id: roomDayId, session_id: sessionId, source: TURN_CUE_SOURCE };

  const whole = await postTurnBatch(origin, {
    ...common,
    replace_window,
    cues: [...turns, windowCueFor(true, null)].map(asBatchCue),
  });
  if (whole.ok) {
    return {
      deleted: whole.deleted,
      written: whole.written,
      already_existed: whole.already_existed,
      // A within-write conflict is the ONLY thing this counts, and after a delete it should be 0.
      dropped: whole.dropped,
      failed: 0,
      attempted: whole.attempted,
      complete: true,
      window_recorded: true,
    };
  }

  // ---- §3/§4: the turns rolled back. Record the ask anyway, with no DELETE. -----------
  const marker = await postTurnBatch(origin, {
    ...common,
    // NO replace_window. This is the point of K4: the route skips the delete entirely, so this
    // request cannot fail for the reason the request above just failed.
    cues: [windowCueFor(false, whole.error)].map(asBatchCue),
  });
  const reason = failureReason(whole.error);
  if (marker.ok) {
    return {
      deleted: marker.deleted,
      written: marker.written,
      already_existed: marker.already_existed,
      // NOT the turn count. Nothing collided; the write never happened.
      dropped: marker.dropped,
      failed: turns.length,
      failed_reason: reason,
      attempted: turns.length + marker.attempted,
      complete: false,
      window_recorded: true,
      stopped_early: whole.error,
      turn_write_error: whole.error,
      ...(whole.detail ? { detail: whole.detail } : {}),
    };
  }
  // Nothing was committed at all — not even the admission. Claim nothing.
  return {
    deleted: 0,
    written: 0,
    already_existed: 0,
    dropped: 0,
    failed: turns.length,
    failed_reason: reason,
    attempted: turns.length,
    complete: false,
    window_recorded: false,
    stopped_early: whole.error,
    turn_write_error: marker.error,
    ...(marker.detail ? { detail: marker.detail } : {}),
  };
}

/**
 * K5 — the one Whisper error that is not a failure.
 *
 * lib/whisper.ts returns `empty_transcript` ONLY on a 200 whose text and segment text are both
 * empty (a non-200 exits earlier as `http_<status>`). That is a SUCCESSFUL transcription of a
 * quiet room, mislabelled — and it is exactly the case stt_silence exists for, which until now
 * was the one case it could not handle, because the tool aborted on ok:false before ever
 * reaching the segment filter that emits the silence.
 *
 * The client is NOT changed. The same signal means opposite things in two places: on the
 * encounter pipeline an empty transcript really is a failure, because no note can be made from
 * silence. Only the caller knows what it asked for, so only the caller may decide.
 */
export const EMPTY_TRANSCRIPT = "empty_transcript";

type ScratchTarget =
  | { ok: true; ist: string; roomId: string; dayId: string; roomCreated: boolean; dayCreated: boolean }
  | { ok: false; error: string; detail?: string; room_day_id?: string };

/**
 * The scratch room-day this session's windows are written to. Shared by every write path so that
 * a speech window, a silent window and a failed ask all land on ONE day and all refuse by the
 * same names.
 *
 * The day is the session's own IST date, never the server clock — the same derivation as
 * scribe_replay_write, so a replayed day and its turns cannot end up on two different days.
 */
async function resolveScratchTarget(
  session: { id: string; room_id: string; room_slug: string; room_name: string; started_at: string | Date },
): Promise<ScratchTarget> {
  const ist = istDate(new Date(session.started_at));
  let scratch: Awaited<ReturnType<typeof resolveScratchGraph>>;
  try {
    scratch = await resolveScratchGraph({ id: session.room_id, slug: session.room_slug, name: session.room_name }, ist);
  } catch (e) {
    return { ok: false, error: "scratch_graph_failed", detail: String((e as Error)?.message ?? e).slice(0, 160) };
  }
  if (!scratch.ok) return { ok: false, error: scratch.error, ...(scratch.detail ? { detail: scratch.detail } : {}) };
  // Belt and braces: the cue route's guard is authoritative and re-reads the flag inside its
  // lock, but there is no reason to send a request at a day this side already knows is live.
  if (scratch.day.scratch !== true) return { ok: false, error: "not_a_scratch_day", room_day_id: scratch.day.id };
  return { ok: true, ist, roomId: scratch.room.id, dayId: scratch.day.id, roomCreated: scratch.room.created, dayCreated: scratch.day.created };
}

/**
 * K5 — write ONLY the completeness marker, for an ask that never produced a transcript.
 *
 * NO replace_window, for K4's reason and one of its own: the request issues no DELETE, so it
 * cannot fail for a verb it does not need — and a failed ask has nothing to replace the window
 * WITH. Deleting a previous run's real turns because a later ask timed out would destroy evidence
 * to record a failure, which is the wrong way round.
 */
async function writeWindowMarkerOnly(
  origin: string,
  roomId: string,
  roomDayId: string,
  sessionId: string,
  cue: TurnDraft,
): Promise<{ ok: true; deleted: number; written: number; already_existed: number; dropped: number; attempted: number } | { ok: false; error: string; detail?: string }> {
  return postTurnBatch(origin, {
    room_id: roomId,
    room_day_id: roomDayId,
    session_id: sessionId,
    source: TURN_CUE_SOURCE,
    cues: [asBatchCue(cue)],
  });
}

/** What a dry run reports, and what a write reports before its counts. */
const shownTurns = (b: TurnBuild) =>
  b.turns.map((t) => ({ type: t.type, at: t.at, start_ms: t.start_ms, end_ms: t.end_ms, speaker: t.speaker, text: t.text, source_ref: t.source_ref }));

type TurnAnswer = Record<string, unknown>;

/**
 * The write half of scribe_transcribe_range, shared by both branches. Fails safe to a NAMED
 * refusal in every direction — the transcription itself has already succeeded by the time this
 * runs, and a failure to record it must never take the text away from the caller.
 */
async function turnsAnswer(
  ctx: ToolContext,
  session: { id: string; room_id: string; room_slug: string; room_name: string; started_at: string | Date },
  build: TurnBuild,
  dryRun: boolean,
  win: { startMs: number; endMs: number; language: string | null; sourceUsed: string | null },
): Promise<TurnAnswer> {
  // The completeness cue for THIS window, complete or not. Built here rather than by the caller
  // so both the success and the refusal shape it identically — the only difference between them
  // is the two fields the writer sets.
  const windowCueFor = (complete: boolean, stoppedEarly: string | null) =>
    buildWindowCue({
      engine: whisperAdapter.key,
      sessionId: session.id,
      windowStartMs: win.startMs,
      windowEndMs: win.endMs,
      complete,
      // What Whisper actually returned for the window, which is the number that moved between
      // runs and the reason the write unit changed.
      segmentCount: build.segments_considered,
      language: win.language,
      sourceUsed: win.sourceUsed,
      stoppedEarly,
    });
  const base = {
    turns: shownTurns(build),
    turn_counts: {
      turns: build.turns.filter((t) => t.type === TURN_CUE_TYPE).length,
      silences: build.turns.filter((t) => t.type === SILENCE_CUE_TYPE).length,
      segments_considered: build.segments_considered,
      dropped_outside_window: build.dropped_outside_window,
      dropped_blank: build.dropped_blank,
    },
    dry_run: dryRun,
  };
  // Every refusal below returns the SAME four counts as a write, so a caller never has to ask
  // whether a missing field meant zero or meant "this shape does not have that field".
  const noWrite = { deleted: 0, written: 0, already_existed: 0, dropped: 0, failed: 0, attempted: 0, complete: false, window_recorded: false };
  if (dryRun) {
    return {
      ...base,
      ...noWrite,
      window_cue: shownTurns({ ...build, turns: [windowCueFor(true, null)] })[0],
      note_turns: "dry run — nothing written; pass dry_run:false to write this window into the scratch graph. A write REPLACES the window: every stt_turn and stt_silence already recorded for this session and this asked window is deleted first, in the same transaction. The stt_window marker is NOT deleted — it is upserted, so that recording a FAILED window never needs the DELETE the failed window died on.",
    };
  }

  const target = await resolveScratchTarget(session);
  if (!target.ok) {
    return {
      ...base, ...noWrite,
      turn_write_error: target.error,
      ...(target.detail ? { detail: target.detail } : {}),
      ...(target.room_day_id ? { room_day_id: target.room_day_id } : {}),
    };
  }

  const counts = await writeWindowCues(
    ctx.origin, target.roomId, target.dayId, session.id,
    { startMs: win.startMs, endMs: win.endMs }, build.turns, windowCueFor,
  );
  // K4 §3 — when even the marker could not be written, the day holds NOTHING about this ask and
  // the answer must not read as though it does. Said in a field and in words, because the counts
  // alone (all zero) look identical to a window nobody asked about.
  const record = counts.window_recorded
    ? {}
    : {
        window_record: "none" as const,
        note_window_record: "NOT RECORDED IN THE GRAPH. The turns were rolled back and the completeness marker could not be written either, so the room-day holds no trace of this ask — this response is the only record that it happened. Re-run the window once the cause named in turn_write_error is fixed.",
      };
  return {
    ...base,
    ...record,
    room_day_id: target.dayId,
    scratch_room: { id: target.roomId, created: target.roomCreated },
    scratch_room_day_created: target.dayCreated,
    ist_date: target.ist,
    ...counts,
    // NOT `source` — that word is already the microphone in this tool's answer (source_used /
    // source_requested), and two different questions must not share a key.
    turn_cue_source: TURN_CUE_SOURCE,
    natural_key: ["source_ref", "type"],
    write_unit: ["session_id", "window.start_ms", "window.end_ms"],
    note_turns: "written to a scratch room-day, never a live one. The WRITE UNIT IS THE WINDOW, not the turn: every stt_turn and stt_silence already recorded for this session and this asked window is DELETED and the new set inserted, in one transaction. The stt_window marker is UPSERTED rather than deleted, so that recording a failed window never needs the verb the failed window died on. Re-running a window therefore REPLACES it — a different segment count on the second run is a replace and is correct, not a failure. source_ref = {session_id}|{start_ms}|{end_ms}|{speaker} remains the WITHIN-write key, so two turns sharing a start both land. An stt_window row records whether the window finished; complete:false means the turns were rolled back and none was kept.",
  };
}

/**
 * K5 — what to do when Whisper returns ok:false, which is now TWO different situations.
 *
 *   empty_transcript  A quiet room, transcribed successfully. The window gets ONE stt_silence and
 *                     a marker saying complete:true with segment_count 0, because this WAS an ask
 *                     that finished. Zero turns. It is never counted as `failed`, and no speech is
 *                     invented. The answer is ok:true — nothing went wrong.
 *
 *   anything else     A failed ask: http_*, a timeout, a malformed body. No silence and no turns,
 *                     because we do not know what was in the window. One marker, complete:false,
 *                     with stopped_early naming the error. If even that cannot be written the
 *                     answer says the day holds no record — it never implies one.
 *
 * The silence path runs through the SAME buildTurns/turnsAnswer machinery as a speech window, so
 * the window delete, the scratch guard, the lock, the room-day derivation and the dry-run rule are
 * all exactly what they are for speech. A silent window replaces whatever the same
 * (session_id, window) held before, like any other.
 */
async function whisperNotOkAnswer(
  ctx: ToolContext,
  session: { id: string; room_id: string; room_slug: string; room_name: string; started_at: string | Date },
  w: { error: string; latency_ms: number },
  dryRun: boolean,
  win: { startMs: number; endMs: number; sourceUsed: string | null },
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // ---- the quiet room ------------------------------------------------------------------
  if (w.error === EMPTY_TRANSCRIPT) {
    // Zero segments in, and buildTurns' own rule does the rest: a window that survives nothing is
    // ONE stt_silence covering exactly what was asked for. Nothing special-cased, so a silent
    // window and a window whose every segment was blank produce the identical row.
    const build = buildTurns({
      engine: whisperAdapter.key,
      sessionId: session.id,
      clipStartMs: win.startMs,
      windowStartMs: win.startMs,
      windowEndMs: win.endMs,
      segments: [],
      language: null,
      sourceUsed: win.sourceUsed,
    });
    const written = await turnsAnswer(ctx, session, build, dryRun, { startMs: win.startMs, endMs: win.endMs, language: null, sourceUsed: win.sourceUsed });
    return {
      ok: true,
      ...base,
      ...extra,
      silent_window: true,
      text: "",
      language: null,
      whisper_latency_ms: w.latency_ms,
      ...written,
      note: "SILENT WINDOW. Whisper transcribed this window successfully and it contained no speech; the client reports that as `empty_transcript`, which on this path is a fact about the room and not a failure. One stt_silence covers the window and the completeness marker says complete:true with segment_count 0 — the ask finished. No turn was written and no speech was inferred.",
    };
  }

  // ---- a failed ask --------------------------------------------------------------------
  const failedBase = {
    ok: false as const,
    error: "whisper_failed",
    degraded: true,
    ...base,
    ...extra,
    detail: w.error,
    latency_ms: w.latency_ms,
    // The five counts, in the same shape a write returns, so a reader never has to wonder
    // whether an absent field meant zero.
    deleted: 0,
    written: 0,
    already_existed: 0,
    dropped: 0,
    failed: 0,
    attempted: 0,
    complete: false,
  };
  const markerFor = () =>
    buildWindowCue({
      engine: whisperAdapter.key,
      sessionId: session.id,
      windowStartMs: win.startMs,
      windowEndMs: win.endMs,
      complete: false,
      // Whisper returned no segments at all — saying 0 here is the truth, not a default.
      segmentCount: 0,
      language: null,
      sourceUsed: win.sourceUsed,
      stoppedEarly: w.error,
    });

  if (dryRun) {
    return { ...failedBase, window_recorded: false, window_cue: shownTurns({ turns: [markerFor()], silence: false, segments_considered: 0, dropped_outside_window: 0, dropped_blank: 0 })[0], note_turns: "dry run — nothing written. A write would record one stt_window with complete:false for this window." };
  }
  const target = await resolveScratchTarget(session);
  if (!target.ok) {
    return { ...failedBase, window_recorded: false, turn_write_error: target.error, ...(target.detail ? { detail_write: target.detail } : {}), ...(target.room_day_id ? { room_day_id: target.room_day_id } : {}) };
  }
  const marker = await writeWindowMarkerOnly(ctx.origin, target.roomId, target.dayId, session.id, markerFor());
  if (!marker.ok) {
    return {
      ...failedBase,
      window_recorded: false,
      room_day_id: target.dayId,
      turn_write_error: marker.error,
      window_record: "none" as const,
      note_window_record: "NOT RECORDED IN THE GRAPH. The transcription failed and the completeness marker could not be written either, so the room-day holds no trace of this ask — this response is the only record that it happened. Re-run the window once the causes named in detail and turn_write_error are fixed.",
    };
  }
  return {
    ...failedBase,
    written: marker.written,
    already_existed: marker.already_existed,
    attempted: marker.attempted,
    window_recorded: true,
    room_day_id: target.dayId,
    ist_date: target.ist,
    stopped_early: w.error,
    note_turns: "The ask FAILED: no turn and no stt_silence was written, because what the window contained is unknown. One stt_window records complete:false with stopped_early naming the cause. Any turns a previous run wrote for this window are left untouched — a failed ask has nothing to replace them with.",
  };
}

const transcribeRange: McpTool = {
  name: "scribe_transcribe_range",
  description:
    "Hear the tape: resolve a window to its covering pieces, join and trim when there is more than one, transcribe. Text only, never bytes. Refused over 30 minutes and while any room records. Omit `source` and a window overlapping a lost primary is read from the BACKUP, which it says. Whisper only in v1. `turns` keeps segments by overlap, so a phrase starting early stays whole. An empty transcript on a 200 is a quiet room: one stt_silence, complete:true, never counted as `failed`; any other Whisper error is a failed ask. dry_run defaults TRUE; false writes turn cues. ASYNC (§3): async:true returns {job_id, status_pointer}, NEVER text; transcription_run_id is NULL and no turn cues are written until Slice C.",
  scope: "invoke",
  inputSchema: {
    type: "object",
    properties: {
      async: { type: "boolean", default: false, description: "Tier 2 §3 — submit the equivalent job and return {job_id} instead of waiting. Default false keeps today's behaviour for one release." },

      ...RANGE_ARGS,
      engine: { type: "string", enum: ["whisper"], default: "whisper" },
      language: { type: "string", description: "optional Whisper language hint, e.g. en" },
      dry_run: { type: "boolean", default: true, description: "default TRUE — return the turns without writing them; false writes them into the scratch graph" },
    },
    required: ["start", "end"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    // Tier 2 §3 — `async:true` submits the equivalent job and returns its id. The synchronous
    // path below is UNCHANGED and stays the default for one release, so nothing that calls this
    // tool today sees a different answer.
    if (argBool(args, "async")) {
      const { submitJob, JobArgsError, UnknownKindError } = await import("@/lib/jobs/submit");
      try {
        const job = await submitJob({ kind: "transcribe_range", args: args as Record<string, unknown>, actor: ctx.actor, origin: ctx.origin });
        // The description promises {job_id, status_pointer} and no text: this is that shape.
        return { ok: true, async: true, job_id: job.id, kind: job.kind, status: job.status, status_pointer: { tool: "scribe_job_status", job_id: job.id } };
      } catch (e) {
        if (e instanceof UnknownKindError) return { ok: false, error: "unknown_kind" };
        if (e instanceof JobArgsError) return { ok: false, error: "bad_args", detail: e.reason };
        throw e;
      }
    }
    const engine = argStr(args, "engine", 32) ?? "whisper";
    if (engine !== "whisper") return { ok: false, error: "engine_not_supported_v1", engine, allowed: ["whisper"] };
    // `dry_run` defaults TRUE, and it FAILS DRY: only an explicit false turns writing on.
    // Reading it as `args.dry_run === undefined ? true : argBool(...)` would make every value
    // argBool does not recognise — a typo, a string, a null from a client that serialises
    // absent fields — mean WRITE, which is the wrong way round for the one flag standing
    // between a transcription and rows in the graph.
    const dryRun = !(args.dry_run === false || args.dry_run === "false" || args.dry_run === 0);
    const r = await resolveRangeArgs(args);
    if ("error" in r) return r.error;
    const res = resolveRange(r.chunks, r.startMs, r.endMs, r.source);
    const requested = { start: new Date(r.startMs).toISOString(), end: new Date(r.endMs).toISOString(), start_ist: fmtIstClock(r.startMs), end_ist: fmtIstClock(r.endMs), source: r.source, ist_date: r.istDay };
    // U4: same disclosure as extract — which microphone answered, and why, on every branch.
    const base = { session_id: r.session.id, room_slug: r.session.room_slug, requested_range: requested, engine, ...sourceAnswer(r.decision), ...(r.micDegraded ? { degraded_reads: [r.micDegraded] } : {}) };
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
      // K5 — empty_transcript is a SILENT window, not a failure; every other error is a failed
      // ask. Both are answered here, and both now leave a record of having been asked.
      if (!wj.ok) {
        return await whisperNotOkAnswer(
          ctx, r.session, wj, dryRun,
          { startMs: r.startMs, endMs: r.endMs, sourceUsed: r.decision.source },
          base,
          { joined: true, r2_key: attempt.key, clip: { r2_key: attempt.key, bytes: attempt.bytes, duration_ms: attempt.duration_ms }, total_ms: Date.now() - t0 },
        );
      }
      // THE CLIP'S TRUE START on this branch: the joining service trimmed the first piece by
      // exactly offset_in_chunk_s (buildJoinRequest), so the clip begins there and NOT at the
      // window the operator asked for — a window that starts before the first covering piece
      // trims to zero and the clip starts at the piece instead.
      const joinedClipStartMs = Date.parse(res.covering[0]!.chunk_bounds.started_at) + Math.round(res.covering[0]!.offset_in_chunk_s * 1000);
      const jBuild = buildTurns({ engine: whisperAdapter.key, sessionId: r.session.id, clipStartMs: joinedClipStartMs, windowStartMs: r.startMs, windowEndMs: r.endMs, segments: wj.segments, language: wj.language ?? null, sourceUsed: r.decision.source });
      const jTurns = await turnsAnswer(ctx, r.session, jBuild, dryRun, { startMs: r.startMs, endMs: r.endMs, language: wj.language ?? null, sourceUsed: r.decision.source });
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
        clip_start_ms: joinedClipStartMs,
        ...jTurns,
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
    // K5 — same two situations on the single-piece branch.
    if (!w.ok) {
      return await whisperNotOkAnswer(
        ctx, r.session, w, dryRun,
        { startMs: r.startMs, endMs: r.endMs, sourceUsed: r.decision.source },
        base,
        { chunk_idx: c.chunk.idx, chunk_bounds: c.chunk_bounds, r2_key: c.chunk.r2_key, total_ms: Date.now() - t0 },
      );
    }
    // THE CLIP'S TRUE START on this branch: the WHOLE chunk was sent, so segment second zero is
    // the chunk's own start — not the window, which is why the turns below are then filtered to
    // the window while the `text` above still covers the whole chunk.
    const chunkStartMs = Date.parse(c.chunk_bounds.started_at);
    const sBuild = buildTurns({ engine: whisperAdapter.key, sessionId: r.session.id, clipStartMs: chunkStartMs, windowStartMs: r.startMs, windowEndMs: r.endMs, segments: w.segments, language: w.language ?? null, sourceUsed: r.decision.source });
    const sTurns = await turnsAnswer(ctx, r.session, sBuild, dryRun, { startMs: r.startMs, endMs: r.endMs, language: w.language ?? null, sourceUsed: r.decision.source });
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
      clip_start_ms: chunkStartMs,
      ...sTurns,
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
  // THE RULE ITSELF LIVES IN lib/room-facts.ts NOW (§3.6), so the screen raises the same check
  // with the same window. This keeps the door's existing one-argument-pair shape and its name;
  // it is the stall window that both sides must agree on, and there is one of it.
  return endedAtLiesShared(storedEndMs, tapeMs, STALLED_BADGE_MINUTES * 60_000);
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
) {
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
      detail: DETAIL_SCHEMA,
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
      // Tier 2 §2.4. Summary is the day's shape — one line per session; `full` keeps every
      // chunk and event, which is what makes this tool large on a busy day. `degraded_reads`
      // rides both: a session whose chunks failed to read must not look like a quiet session.
      const detail = argDetail(args);
      return {
        room: { id: room.id, slug: room.slug, name: room.name },
        ist_date: day,
        note: "tape_ended_at is the last piece recorded (either microphone) — the stored ended_at is not the end of the recording and is shown only where it differs",
        sessions: detail === "full" ? sessions : sessions.map((x) => pickSummary(x, SUMMARY_DAY_SESSION_FIELDS, SUMMARY_DAY_SESSION_OPTIONAL)),
        ...(degraded.length ? { degraded_reads: degraded } : {}),
      };
    }),
};

/**
 * The live monitor's fields for one room (K-live). ADDITIVE: every existing scribe_diff_room
 * field is computed exactly as it was, and nothing here can change one.
 *
 * Each read is guarded on its own. A failure names itself in `degraded` and leaves its fields
 * null — never a throw, and never a number that is really an absence.
 */
async function liveMonitorExtras(
  roomId: string,
  istDay: string,
  now: Date,
  recording: boolean,
  paused: boolean,
  sessionIds: readonly string[],
  reasons: string[],
  listener: ListenerRow | null,
): Promise<Record<string, unknown>> {
  const { fromIso, toIso } = istDayRangeUtc(istDay);
  let lastPrimary: string | null = null;
  let lastBackup: string | null = null;
  let backupChunks = 0;
  let audioRecordedMs = 0;
  let marksNotSent = 0;
  try {
    // Per-source maxima on the UPLOAD clock (created_at), the same FILTER shape the kiosk's
    // active-session route uses. HALF-OPEN started_at range so 0054's index is usable.
    //
    // THE MARK COUNT USED TO BE IN THIS QUERY AND WAS WRONG. It joined bench_chunk AND
    // bench_event off the same session row, which is a cross product: every chunk paired with
    // every event, so `backup_chunks` was multiplied by the number of events on the session and
    // `marks_not_sent` by the number of chunks. It only ever read correctly on a session with no
    // events at all, which is why nobody saw it. The screen counted the same two facts in two
    // separate reads and got them right, so the door and the screen disagreed about a room by a
    // whole multiplication. Split, and it now agrees.
    const rows = (await sql`
      SELECT MAX(c.created_at) FILTER (WHERE c.source = 'primary') AS last_primary_at,
             MAX(c.created_at) FILTER (WHERE c.source = 'backup')  AS last_backup_at,
             COUNT(c.id)       FILTER (WHERE c.source = 'backup')::int AS backup_chunks,
             COALESCE(SUM(c.duration_ms) FILTER (WHERE c.source = 'primary'), 0)::bigint AS audio_ms
        FROM bench_session s
        LEFT JOIN bench_chunk c ON c.session_id = s.id
       WHERE s.room_id = ${roomId}
         AND s.started_at >= ${fromIso}::timestamptz
         AND s.started_at <  ${toIso}::timestamptz
    `) as Array<{ last_primary_at: string | Date | null; last_backup_at: string | Date | null; backup_chunks: number; audio_ms: string | number }>;
    const r = rows[0];
    if (r) {
      lastPrimary = r.last_primary_at ? new Date(r.last_primary_at).toISOString() : null;
      lastBackup = r.last_backup_at ? new Date(r.last_backup_at).toISOString() : null;
      backupChunks = Number(r.backup_chunks) || 0;
      audioRecordedMs = Number(r.audio_ms) || 0;
    }
  } catch (e) {
    reasons.push(`chunk_sources_unavailable:${String((e as Error)?.message ?? e).slice(0, 60)}`);
  }
  try {
    // Marks the kiosk recorded and could not get to the brain. Its own read, for the reason
    // above. bench_event_session_kind_idx (0054) serves it.
    const rows = (await sql`
      SELECT COUNT(*)::int AS marks_not_sent
        FROM bench_event e
        JOIN bench_session s ON s.id = e.session_id
       WHERE s.room_id = ${roomId}
         AND s.started_at >= ${fromIso}::timestamptz
         AND s.started_at <  ${toIso}::timestamptz
         AND e.kind = 'consult_mark'
         AND e.brain_status <> 'sent'
    `) as Array<{ marks_not_sent: number }>;
    marksNotSent = Number(rows[0]?.marks_not_sent) || 0;
  } catch (e) {
    reasons.push(`marks_not_sent_unavailable:${String((e as Error)?.message ?? e).slice(0, 60)}`);
  }

  let lastWarehouse: string | null = null;
  let marksToday = 0;
  let lastMark: string | null = null;
  let lastWindowAt: string | null = null;
  let lastWindowComplete: boolean | null = null;
  // The rollup selects FROM room_day, so a room with no day today yields NO ROW — which is
  // exactly the fact the no-day-record alarm turns on. `dayKnown` separates that from a failed
  // read, and only a successful read may answer the question at all.
  let dayKnown = false;
  let roomDayFound = false;
  try {
    const r = await brainQuery<{ last_warehouse_at: Date | null; marks_today: number; last_mark_at: Date | null }>(SQL_ROOM_DAY_ROLLUP, [istDay, [roomId]]);
    dayKnown = true;
    const row = r.rows[0];
    if (row) {
      roomDayFound = true;
      lastWarehouse = row.last_warehouse_at ? new Date(row.last_warehouse_at).toISOString() : null;
      marksToday = Number(row.marks_today) || 0;
      lastMark = row.last_mark_at ? new Date(row.last_mark_at).toISOString() : null;
    }
  } catch (e) {
    reasons.push(`warehouse_rollup_unavailable:${String((e as Error)?.message ?? e).slice(0, 60)}`);
  }
  try {
    const r = await brainQuery<{ at: Date; payload: unknown }>(SQL_LAST_WINDOW_MARKER, [istDay, [roomId]]);
    const row = r.rows[0];
    if (row) {
      lastWindowAt = new Date(row.at).toISOString();
      // A marker whose payload never says `complete` reads as UNKNOWN, never as failed. Reading
      // that silence as false would invent a failure nothing reported.
      lastWindowComplete = markerComplete(row.payload);
    }
  } catch (e) {
    reasons.push(`window_marker_unavailable:${String((e as Error)?.message ?? e).slice(0, 60)}`);
  }

  // ---- the two processing switches (§3.6) -------------------------------------------------
  //
  // THE DOOR COULD NOT REPORT THESE AT ALL, which is the divergence that matters most of the
  // three: an automated watcher had no way to warn that a room was recording into nothing.
  // NULL where the read failed — never false, because "off" is a claim and a failed read is not.
  const sw = await readSwitches(roomId);
  if (sw.degraded) reasons.push(sw.degraded);

  // ---- the three lanes, in the SCREEN'S OWN WORDS -----------------------------------------
  let counts: TranscriptCounts | null = null;
  let strandedRaw = ZERO_STRANDED_RAW;
  if (sessionIds.length) {
    const ts = await readTranscriptAndStranded(sessionIds);
    if (ts.degraded) reasons.push(ts.degraded);
    const mine = ts.value.get(roomId) ?? null;
    if (mine) { counts = mine.counts; strandedRaw = mine.stranded; }
    else if (!ts.degraded) counts = { done: 0, waiting: 0, no_day: 0, in_progress: 0, failed: 0, words_ms: 0 };
  } else {
    counts = { done: 0, waiting: 0, no_day: 0, in_progress: 0, failed: 0, words_ms: 0 };
  }

  let visits: { built: number; open: number } | null = null;
  try {
    const r = await brainQuery<{ room_id: string; built: number; open: number }>(SQL_VISITS_TODAY, [istDay, [roomId]]);
    const row = r.rows[0];
    visits = { built: Number(row?.built) || 0, open: Number(row?.open) || 0 };
  } catch (e) {
    reasons.push(`visits_unavailable:${String((e as Error)?.message ?? e).slice(0, 60)}`);
  }

  // Does a room_day exist for this room today? SQL_ROOM_DAY_ROLLUP selects FROM room_day, so a
  // room with no day yields no row. `dayKnown` is false when the brain read FAILED, and null is
  // passed rather than false: telling a watcher a room has no day because a database was briefly
  // unreachable is how the one true alarm on this surface gets ignored.
  const hasRoomDayToday = dayKnown ? roomDayFound : null;

  // ---- ENDED DISAGREES, which the door could not raise ------------------------------------
  const afterEnd = await readChunksAfterEnd(roomId, fromIso, toIso, ENDED_DISAGREES_SKEW_GRACE_MS);
  if (afterEnd.degraded) reasons.push(afterEnd.degraded);
  const disagreeing = [...afterEnd.value.entries()].filter(([, n]) => n > 0);

  // THE DOCTOR CLOCK, and its name is deliberate. Counted only while recording and not paused,
  // and ONLY where a genuine warehouse-typed cue exists — there is no fallback to the session's
  // own start on either surface any more (§3.1). It measures Pulse clocks from the LABELLED
  // DOCTOR and cannot see the room at all: even_hospitals.doctor_opd_rooms is null on every
  // hospital. A gap means that doctor has not clocked, NOT that the room is empty and NOT that
  // the warehouse is down (D13).
  const warehouseSilentMs = doctorClockSilentMs({
    lastWarehouseAt: lastWarehouse,
    recording,
    paused,
    nowMs: now.getTime(),
  });

  const stranded = strandedAudio(strandedRaw, hasRoomDayToday);

  // §3.5/§3.6 (Build 3 §2.5) — THE DOOR NOW REPORTS THE LEVEL NUMBERS THE SCREEN RENDERS. Build 2
  // put level bars on the page; the door could not report them, so the screen and the door knew
  // different things again — the exact divergence Build 1 was meant to end. From the SAME shared
  // sources the card reads: the per-microphone level pair off the listener row (bench_listener,
  // 0066), and the size vital off readMicSizes — the learned baseline and the D36/D37 judgement
  // inputs (newest verdict, the tiny run, and proven_dead_by_size). A NULL level is "not measured",
  // never silent, exactly as the card treats it.
  // §2.4 — a spare exists only where the client reported an explicitly chosen second device.
  const spareExists = listener?.spare_device === true;
  const micLevelNow = listener ? parseMicLevelPair(listener.mic_peak, listener.mic_avg) : null;
  const spareLevelNow = spareExists && listener
    ? parseMicLevelPair(listener.spare_peak, listener.spare_avg)
    : null;
  let micSize: unknown = null;
  let spareSize: unknown = null;
  if (sessionIds.length) {
    const sizes = await readMicSizes(sessionIds);
    if (sizes.degraded) reasons.push(sizes.degraded);
    const s = sizes.value.get(roomId);
    if (s) {
      micSize = s.primary;
      spareSize = s.backup;
    }
  }

  return {
    last_primary_at: lastPrimary,
    last_backup_at: lastBackup,
    backup_chunks_today: backupChunks,
    // §2.5 — the levels and the size judgement, in the screen's own numbers.
    mic_level: micLevelNow,
    spare_level: spareLevelNow,
    levels_at: listener?.levels_at ? new Date(listener.levels_at).toISOString() : null,
    spare_exists: spareExists,
    mic_size: micSize,
    spare_size: spareSize,
    audio_recorded_ms: audioRecordedMs,
    last_warehouse_at: lastWarehouse,
    has_doctor_clock: hasDoctorClock(lastWarehouse),
    warehouse_silent_ms: warehouseSilentMs,
    warehouse_silent_level: doctorClockLevel(warehouseSilentMs),
    doctor_clock_note: DOCTOR_CLOCK_NOTE,
    marks_today: marksToday,
    last_mark_at: lastMark,
    marks_not_sent: marksNotSent,
    last_window_asked_at: lastWindowAt,
    last_window_complete: lastWindowComplete,
    // --- the switches, the lanes and the stranded minutes: what the screen says, verbatim ---
    transcript_enabled: sw.value.transcript_enabled,
    visits_enabled: sw.value.visits_enabled,
    has_room_day_today: hasRoomDayToday,
    transcript_counts: counts,
    visit_counts: visits,
    lanes: {
      transcript: counts === null || sw.value.transcript_enabled === null
        ? null
        : transcriptLane(sw.value.transcript_enabled, counts, hasRoomDayToday),
      visits: visits === null || sw.value.visits_enabled === null
        ? null
        : visitsLane(sw.value.visits_enabled, visits),
    },
    stranded_audio: stranded,
    ended_disagrees: disagreeing.length > 0,
    ended_disagrees_sessions: disagreeing.map(([id, n]) => ({ session_id: id, chunks_after_end: n })),
    ...(disagreeing.length ? { ended_disagrees_title: ENDED_DISAGREES_TITLE, ended_disagrees_hint: ENDED_DISAGREES_HINT } : {}),
  };
}

/**
 * Tier 2 §2.4 — what `detail:"summary"` keeps. The question this answers is "what is wrong right
 * now, and can I act": the room's identity, whether anyone is listening, whether tape is moving,
 * the operator-language state with its install flags, and the two clocks an operator checks next.
 * Everything omitted is still one `detail:"full"` away — see docs/operator-mcp/TOOL-NOTES.md.
 */
export const SUMMARY_ROOM_FIELDS = [
  "room", "page_open", "listener_state", "recording", "recording_session_id",
  "room_state", "tape_lane", "paused_listener", "paused_session", "paused_disagrees",
  "last_piece_at", "last_cue", "stalled_age_ms", "flags", "degraded",
] as const;

/**
 * `degraded` is spread conditionally — it exists only when a section of the read failed, and its
 * absence is the good news. Everything else in the list above is unconditional, so `pickSummary`
 * throws if one goes missing. (Found by that throw: the first version of this list would have
 * crashed every healthy room, which is exactly the signal the silent version never gave.)
 */
export const SUMMARY_ROOM_OPTIONAL = ["degraded"] as const;

/**
 * Tier 2 §2.4 — one line per session: what happened, when, how much tape, and whether the two
 * clocks agree. TYPED AGAINST THE REAL ROW: `satisfies readonly (keyof DaySessionRow)[]` makes a
 * name `buildDaySession` does not return a tsc error here, at the list, rather than a field that
 * silently vanishes from the answer. The Refuter's (d): six of these were wrong and nothing failed.
 *
 * THIS ONLY WORKS BECAUSE `buildDaySession` HAS NO RETURN ANNOTATION. It used to be declared
 * `): Record<string, unknown>`, which makes `keyof` collapse to `string` — so both this `satisfies`
 * and `pickSummary`'s `readonly (keyof T)[]` accepted anything and the guard was theatre. Do not
 * re-add one. Verified by adding "id" to the list: tsc fails TS2322 here and TS2345 at the call
 * site, naming every real key.
 */
type DayReportSession = ReturnType<typeof buildDaySession>;
export const SUMMARY_DAY_SESSION_FIELDS = [
  "session_id", "status", "started_at", "tape_ended_at", "ended_at",
  "end_time_disagrees", "chunks", "gaps",
] as const satisfies readonly (keyof DayReportSession)[];

/**
 * `ended_at` is emitted ONLY when the stored end disagrees with the tape clock (buildDaySession
 * spreads it conditionally), so its absence is a fact about the session, not a missing field.
 * Everything else above is unconditional and `pickSummary` throws if one goes missing.
 */
export const SUMMARY_DAY_SESSION_OPTIONAL = ["ended_at"] as const satisfies readonly (keyof DayReportSession)[];

const diffRoom: McpTool = {
  name: "scribe_diff_room",
  description:
    "The now-picture for one room or every enabled room: is the kiosk listening, is anything recording, the last cue and the last piece today, plus room_state — the operator-language answer to \"what can I do about this room\", as { state, label, hint, level, start_available } with state one of cant_tell | paused | recording | finished | ready | dropped | offline, in that precedence. Same function the admin page uses, so door and screen cannot disagree. room_state also carries flags and drift_since: the bound Mac's named install states (SILENT_WHILE_RECORDING, CLIPPING, DEVICE_MISSING, DEVICE_CHANGED, ENCODER_STALLED, DISK_LOW, CHANNEL_DRIFT) as a SET — several hold at once. flags is NULL, never [], where no Mac is bound, the install was never evaluated, or the read failed; [] means looked at and well: a flag means go and look, never a diagnosis. detail:\"full\" adds lanes, counts and clocks — see docs/operator-mcp/TOOL-NOTES.md. Read-only.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      detail: DETAIL_SCHEMA,
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
        // The all-rooms sweep excludes scratch rooms (fuse slice 2): they have no kiosk, no
        // tape and no listener, so every one of them would raise kiosk_not_listening for ever.
        // `_` is a single-character wildcard in LIKE, so the prefix is matched with
        // left()/length() rather than a pattern. Naming one explicitly still resolves — the
        // resolveRoom branch above is deliberately not filtered.
        const rows = (await sql`
          SELECT id, slug, name FROM room
           WHERE disabled_at IS NULL
             AND left(id, length(${SCRATCH_ROOM_PREFIX}::text)) <> ${SCRATCH_ROOM_PREFIX}::text
           ORDER BY created_at
        `) as Array<{ id: string; slug: string; name: string }>;
        targets = rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, enabled: true }));
      }

      const detail = argDetail(args);
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
          // ---- the live monitor's fields (additive; nothing above changes) ----------------
          // bench_listener.paused and recording_session_id were already read into `listener`
          // above and thrown away. Reporting them costs no new query.
          const pausedListener = listener ? Boolean(listener.paused) : false;
          const pausedSession = sessions.some((s) => s.status === "paused");
          const stalledSession = sessions.find((s) => isBenchStalled(s, now.getTime())) ?? null;
          const stalledAgeMs = stalledSession
            ? now.getTime() - (msOfLoose(stalledSession.last_any_chunk_at) ?? msOfLoose(stalledSession.started_at) ?? now.getTime())
            : null;
          // last_backup_at needs a per-source maximum, which the session rollup does not expose
          // (it carries primary-only and both-combined). listBenchSessions is NOT changed for
          // it — other consumers depend on that shape — so the helper reads it directly.
          // D30 — the room's MOST RECENT session today, and whether it is an ended one. The
          // seventh state's own input, computed here so the door reaches the same chain the
          // screen does with the same facts.
          const newestSession = sessions.reduce<BenchSessionRollupRow | null>((acc, sn) => {
            const t = msOfLoose(sn.started_at);
            if (t === null) return acc;
            const at = acc === null ? null : msOfLoose(acc.started_at);
            return at === null || t > at ? sn : acc;
          }, null);
          const lastSessionEnded =
            newestSession?.status === "ended" && recordingSession === null && !pausedSession;
          const primaryChunks = sessions.reduce((a, sn) => a + (Number(sn.chunk_count) || 0), 0);

          // Tier 1 §2, orchestrator ruling seam 1 — THE NAMED INSTALL STATES, ON THIS DOOR TOO.
          // The card has had them since Slice A; without them here the acceptance test ("mute the
          // TONOR three minutes and read SILENT_WHILE_RECORDING in scribe_diff_room") had no
          // surface to read. One SELECT on the bound install; `flags` is NULL — never [] — where
          // there is no bound Mac, where the column was never evaluated, or where the read failed,
          // because "no flags" and "nobody looked" are different answers.
          let installFlags: InstallStateFlag[] | null = null;
          let driftSince: string | null = null;
          try {
            const st = (await sql`
              SELECT state_flags FROM room_install
               WHERE room_id = ${room.id} AND enrolled_at IS NOT NULL AND retired_at IS NULL
               ORDER BY created_at DESC LIMIT 1
            `) as Array<{ state_flags: unknown }>;
            const raw = st[0]?.state_flags ?? null;
            if (raw !== null && raw !== undefined) {
              const rec = parseInstallState(raw);
              installFlags = rec.flags;
              driftSince = rec.drift_since;
            }
          } catch (e) {
            reasons.push(`install_state_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
          }

          const live = await liveMonitorExtras(
            room.id, today, now, recordingSession !== null, pausedListener || pausedSession,
            sessions.map((sn) => sn.id), reasons, listener,
          );

          const full = {
            room: { id: room.id, slug: room.slug, name: room.name },
            page_open: pageOpen,
            listener_age_ms: listener ? now.getTime() - new Date(listener.last_poll_at).getTime() : null,
            recording: recordingSession !== null,
            recording_session_id: recordingSession?.id ?? null,
            last_piece_at: lastPieceMs !== null ? new Date(lastPieceMs).toISOString() : null,
            last_cue: lastCue,
            // --- additive from here; every field above is untouched --------------------------
            listener_state: listenerStateOf(listener, pageOpen === null, now.getTime()),
            // K2 §6 — the SAME function the admin page calls, so the door and the screen cannot
            // disagree about a room. Six states, one precedence order, one place.
            room_state: {
              ...roomState({
                listenerReadFailed: pageOpen === null,
                listener: listener ? { last_poll_at: listener.last_poll_at, paused: Boolean(listener.paused) } : null,
                pausedSession,
                recording: recordingSession !== null,
                recordingSince: recordingSession ? new Date(recordingSession.started_at).toISOString() : null,
                nowMs: now.getTime(),
                lastSessionEnded,
                recordedMsToday: Number(live.audio_recorded_ms) || 0,
              }),
              // Additive and ORTHOGONAL to `state` above: that is a precedence chain, these are a
              // set and several hold at once. `drift_since` is CHANNEL_DRIFT's clock, non-null
              // while the Mac disagrees with its assignment whether or not thirty minutes have run.
              flags: installFlags,
              drift_since: driftSince,
            },
            // The Tape lane, in the screen's words. The other two are assembled in
            // liveMonitorExtras, where their counts are read.
            tape_lane: tapeLane({
              recording: recordingSession !== null,
              paused_session: pausedSession,
              stalled,
              stalled_age_ms: stalledAgeMs,
              session_started_at: recordingSession ? new Date(recordingSession.started_at).toISOString() : null,
              primary_chunks: primaryChunks,
              nowMs: now.getTime(),
            }),
            paused_listener: pausedListener,
            paused_session: pausedSession,
            // Named rather than resolved: the kiosk and the tape are two witnesses, and when they
            // disagree an operator needs to know that, not a winner picked for them.
            paused_disagrees: listener !== null && pausedListener !== pausedSession,
            stalled_age_ms: stalledAgeMs,
            ...live,
            flags: {
              kiosk_not_listening: pageOpen === null ? null : !pageOpen,
              stalled,
              tape_without_cues: cueCountKnown ? anyTapeToday && lastCue === null : null,
              ended_at_lies: liars.length > 0,
            },
            ...(liars.length ? { ended_at_lies_sessions: liars.map((s) => s.id) } : {}),
            ...(reasons.length ? { degraded: reasons } : {}),
          };
          // Tier 2 §2.4 — summary is the default and is a NARROWER SELECTION OF THE SAME FACTS.
          // Nothing is computed differently and nothing new appears in `full`; the wide payload is
          // one argument away. `degraded` rides both, because a caller must never be told a room is
          // fine when a section of the read failed.
          // `full` is the object literal built just above, so `keyof typeof full` is its real
          // shape and pickSummary's `readonly (keyof T)[]` rejects any name that is not on it.
          return detail === "full" ? full : pickSummary(full, SUMMARY_ROOM_FIELDS, SUMMARY_ROOM_OPTIONAL);
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

// ---------------------------------------------------------------------------
// Fuse slice 2 — write the replay into a SCRATCH graph (write scope)
//
// scribe_replay_session above is untouched: still read scope, still dry_run:true, still
// writes nothing. Writing is a SEPARATE tool at write scope (F10), so "dry run is the
// default" holds by construction rather than by an option someone can pass.
//
// Where the cues go: NEVER a live room-day. A scratch room is derived from the session's
// real room and a scratch room_day from the session's own IST date (lib/brain/scratch), and
// every write names that day explicitly so POST /api/brain/cues applies its scratch guard
// inside the lock. The cue list is the one slice 1 produces — same buildReplayCues, same
// order, same filtered payloads.
//
// Idempotency, not atomicity (F11). Each cue is its own request, as today. The natural key
// (session_id, type, at) is a partial unique index over replay cues only, so a re-run writes
// only what is missing and a run that stopped half way is resumed by running it again.
// ---------------------------------------------------------------------------

export const REPLAY_WRITE_DEFAULT_LIMIT = 200;
export const REPLAY_WRITE_MAX_LIMIT = 500;

/**
 * Stop writing and report it rather than be killed mid-run. Each cue is its own request, and
 * lib/mcp/handler.ts gives a write tool 55 s before it cuts the call off — a run that is cut
 * off returns nothing, so the operator cannot tell what landed. This budget sits below that,
 * so the tool always gets to say what it wrote and what is left. A re-run resumes.
 */
const REPLAY_WRITE_BUDGET_MS = 45_000;
/** A brain that is refusing every write will refuse the next 200 too. Stop, and say so. */
const REPLAY_WRITE_MAX_CONSECUTIVE_FAILURES = 3;

const replayWrite: McpTool = {
  name: "scribe_replay_write",
  description:
    "WRITES — replay a FINISHED session into a SCRATCH graph, so the fuse has something to run against without touching a real clinic day. The session's status must be 'ended': a session that is still recording, or paused, is refused by name with session_not_ended (the answer carries the actual status) and nothing at all is written, because a live tape would land in scratch as a partial day that looks complete. The cue list is exactly the one scribe_replay_session shows (same kinds, same time order, same filtered payloads); it is written to a scratch room-day derived from the session's room and its own IST date, never to a live room-day — every write names that day and the cue route refuses any day whose scratch flag is not true. Idempotent on the natural key (session_id, type, at): running it twice writes nothing the second time, and a run that stopped half way is resumed by running it again. Each cue is one request, so limit defaults to 200 and caps at 500; over the limit the first `limit` in time order are written and truncated says so with the true total. Returns { room_day_id, written, already_existed, failed, truncated, natural_key }.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "bs_… id" },
      limit: { type: "integer", minimum: 1, maximum: REPLAY_WRITE_MAX_LIMIT, default: REPLAY_WRITE_DEFAULT_LIMIT },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) =>
    failSafe({ written: 0, already_existed: 0, failed: 0 }, async () => {
      const id = argStr(args, "session_id", 64);
      if (!id || !id.startsWith("bs_")) return { ok: false, error: "bad_session_id", written: 0, already_existed: 0, failed: 0 };
      const session = await findBenchSession(id);
      if (!session) return { ok: false, error: "session_not_found", written: 0, already_existed: 0, failed: 0 };

      // H1 — a session that is not `ended` is refused, recording and paused alike. A live tape
      // is still growing, so the cue list is a PREFIX of the day; written into scratch it would
      // sit there looking like a complete day and there is nothing in the rows to say it is not.
      // Refuse before reading or writing anything. (scribe_replay_session, the dry run, is
      // unchanged: reading an open session harmlessly is fine.)
      if (session.status !== "ended") {
        return {
          ok: false,
          error: "session_not_ended",
          status: session.status,
          session_id: session.id,
          written: 0,
          already_existed: 0,
          failed: 0,
          note: "replay is written only from a finished session — stop the recording first, or use scribe_replay_session for a dry run of the tape so far.",
        };
      }

      const limit = argInt(args, "limit", REPLAY_WRITE_DEFAULT_LIMIT, 1, REPLAY_WRITE_MAX_LIMIT);

      let events: BenchEventRow[] = [];
      try {
        events = await listBenchEvents(session.id);
      } catch (e) {
        return { ok: false, error: "events_read_failed", written: 0, already_existed: 0, failed: 0, detail: String((e as Error)?.message ?? e).slice(0, 160) };
      }
      const built = buildReplayCues(events, limit);

      // The day is the session's own IST date — never the server clock.
      const ist = istDate(new Date(session.started_at));
      const scratch = await resolveScratchGraph({ id: session.room_id, slug: session.room_slug, name: session.room_name }, ist);
      if (!scratch.ok) {
        return { ok: false, error: scratch.error, written: 0, already_existed: 0, failed: 0, ...(scratch.detail ? { detail: scratch.detail } : {}) };
      }
      // Belt and braces: the route's guard is authoritative, but there is no reason to send
      // 200 requests at a day this side already knows is not scratch.
      if (scratch.day.scratch !== true) {
        return { ok: false, error: "not_a_scratch_day", written: 0, already_existed: 0, failed: 0, room_day_id: scratch.day.id };
      }

      const t0 = Date.now();
      let written = 0;
      let alreadyExisted = 0;
      let failed = 0;
      let consecutiveFailures = 0;
      const failures: Array<{ type: string; at: string; error: string }> = []; // first 5, for the report
      let stoppedEarly: string | null = null;

      for (const cue of built.cues) {
        if (Date.now() - t0 > REPLAY_WRITE_BUDGET_MS) {
          stoppedEarly = "time_budget";
          break;
        }
        const out = await postBrainCue(ctx.origin, {
          room_id: scratch.room.id,
          type: cue.type,
          at: cue.at, // the event's own recorded time, never the clock
          payload: cue.payload, // exactly what the dry run shows — nothing added, nothing forced
          room_day_id: scratch.day.id,
          session_id: session.id,
          source: cue.source, // 'replay' — the column, which is what the natural key keys on
        });
        if (out.ok) {
          consecutiveFailures = 0;
          if (out.already_existed) alreadyExisted += 1;
          else written += 1;
        } else {
          failed += 1;
          consecutiveFailures += 1;
          if (failures.length < 5) failures.push({ type: cue.type, at: cue.at, error: out.error });
          if (consecutiveFailures >= REPLAY_WRITE_MAX_CONSECUTIVE_FAILURES) {
            stoppedEarly = "consecutive_failures";
            break;
          }
        }
      }

      const attempted = written + alreadyExisted + failed;
      return {
        ok: failed === 0 && stoppedEarly === null,
        session_id: session.id,
        room: { id: session.room_id, slug: session.room_slug, name: session.room_name },
        scratch_room: { id: scratch.room.id, created: scratch.room.created },
        room_day_id: scratch.day.id,
        scratch_room_day_created: scratch.day.created,
        ist_date: ist,
        written,
        already_existed: alreadyExisted,
        failed,
        attempted,
        emitted: built.emitted,
        total: built.total,
        truncated: built.truncated,
        ...(built.truncated
          ? { truncation_note: `write cut short at limit ${limit}: the first ${built.emitted} cues in time order, of ${built.total} replayable events on this session. Raise limit or run again — a re-run writes only what is missing.` }
          : {}),
        ...(stoppedEarly ? { stopped_early: stoppedEarly, stopped_after: attempted } : {}),
        ...(failures.length ? { failures } : {}),
        source: REPLAY_SOURCE,
        natural_key: ["session_id", "type", "at"],
        note: "written to a scratch room-day, never a live one. Idempotent on (session_id, type, at) for source='replay': run it again to resume, and nothing already written is written twice.",
      };
    }),
};


/**
 * Tier 2 §2.7 — `scribe_fleet`. The fleet card's own payload, through the MCP door.
 *
 * WHY IT EXISTS. `/api/admin/bench/fleet` is the only place the install rows live — app version,
 * channel, assignment, disk, device, the Tier 1 `state_flags` — and it is reachable only with an
 * admin cookie from a browser. An agent shell has no cookie, so the one surface that answers
 * "which Mac runs which room, on what build, and is it healthy" was unreachable from here. This is
 * the SAME function the page calls (`readFleet`), so the door and the screen cannot disagree.
 *
 * READ SCOPE, and it carries no identity: hostnames and device names describe machines, not people.
 */
const fleet: McpTool = {
  name: "scribe_fleet",
  description:
    "The room-recorder fleet: one row per room with its bound Mac — app_version, build_sha, update_channel, assigned_channel (and whether an assignment is still pending), channel_locked, last_seen_at, mic_state, input_device_name, disk, and the Tier 1 state_flags (SILENT_WHILE_RECORDING, CLIPPING, DEVICE_MISSING, DEVICE_CHANGED, ENCODER_STALLED, DISK_LOW, CHANNEL_DRIFT — a SET, null where never evaluated, [] where looked at and well). Also the newest release on each channel, so a row is measured against the shelf it actually asks for. Computed by the same function the admin fleet card calls, so the two cannot disagree. detail:\"summary\" (default) gives the identity/version/channel/health fields; detail:\"full\" gives the card's whole payload. Read-only.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      detail: DETAIL_SCHEMA,
      room: { type: "string", description: "optional: one room by id, slug, or exact name" },
    },
  },
  handler: async (args: ToolArgs) =>
    failSafe({ rooms: [] as unknown[] }, async () => {
      const detail = argDetail(args);
      const want = argStr(args, "room", 128);
      const payload = await readFleet(new Date());
      const rows = payload.rows.filter((r) =>
        !want ||
        r.room_id === want ||
        r.room_slug === want ||
        (r.room_name ?? "").toLowerCase() === want.toLowerCase(),
      );
      const view = rows.map((row) => {
        const derived = deriveRow({ row, latestRelease: payload.latest_release, nowMs: Date.now() });
        const full = {
          room: { id: row.room_id, slug: row.room_slug, name: row.room_name },
          disabled: row.disabled,
          install: row.install ?? null,
          derived,
        };
        if (detail === "full") return full;
        const i = row.install;
        return {
          room: full.room,
          // The install fields an operator reads first. Null install = no Mac bound to this room,
          // which is a different answer from a Mac that is bound and silent.
          install: i
            ? {
                install_id: i.install_id,
                app_version: i.app_version,
                build_sha: i.build_sha,
                update_channel: i.update_channel,
                assigned_channel: i.assigned_channel,
                channel_locked: i.channel_locked,
                state_flags: i.state_flags,
                session_open: i.session_open,
                last_seen_at: i.last_seen_at,
                mic_state: i.mic_state,
                input_device_name: i.input_device_name,
              }
            : null,
          state: derived.state,
          assigned_pending: derived.assigned_pending,
          disk_level: derived.disk_level,
          version_hint: derived.version_hint,
        };
      });
      return {
        now: payload.now,
        releases: payload.releases,
        rooms: view,
        ...(payload.degraded.length ? { degraded: payload.degraded } : {}),
      };
    }),
};

export const BENCH_TOOLS: McpTool[] = [
  closeOrphaned,
  listSessions,
  getSession,
  getRecording,
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  setAudioInput,
  roomCommand,
  markConsult,
  extractAudio,
  transcribeRange,
  listCommandsTool,
  fleet,
  dayReport,
  diffRoom,
  replaySession,
  replayWrite,
];
