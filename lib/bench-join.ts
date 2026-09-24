/**
 * lib/bench-join.ts — the app's half of "hear a consultation" (ETA-MCP-UPGRADE PRD §5, U2).
 *
 * A real consultation always crosses a five-minute piece boundary, so until now the door could
 * not play one back: `scribe_extract_audio` answered `multi_chunk_not_supported_v1`. This module
 * turns a multi-piece window into ONE clip by asking the joining service (D14 — Cloudflare
 * Containers, `services/audio-join/`) to join the covering pieces and trim them to the window.
 *
 * What lives here:
 *   - the two refusals the app owns: over 30 minutes (D2) and any room recording (D15);
 *   - the clip key + provenance shape (D3, D4);
 *   - the client of the joining service, which NEVER throws and never waits forever, so the
 *     caller can degrade to today's multi-piece answer (D10).
 *
 * What does NOT live here: audio bytes. The app hands the service keys and takes a key back.
 *
 * No migration, no table, no column. The provenance rides on the stored object as R2 custom
 * metadata; the clip's existence is discoverable from its key.
 */

import { listBenchSessions } from "@/lib/bench";
import { getListener, isListening, type ListenerRow } from "@/lib/bench-commands";
import { isBenchStalled } from "@/lib/bench-reaper-core";
import { endpointsFor, poolConfigured, runPool, type Verdict } from "@/lib/service-pool";

/**
 * D2 — a joined window may be at most 30 minutes.
 *
 * The joining service states the same number in `services/audio-join/container/join-core.mjs`
 * (MAX_JOIN_MS). They are on opposite sides of a network boundary and each must be able to
 * refuse alone, so the number is written twice on purpose. Change one, change the other.
 */
export const JOIN_MAX_MS = 30 * 60_000;
export const JOIN_MAX_MINUTES = JOIN_MAX_MS / 60_000;

/** D3 — kept clips live in the SAME bucket as the tape, under their own prefix. Nothing under
 *  `clips/` is ever deleted or expired by this code. */
export const CLIPS_PREFIX = "clips/";

/** The joined clip's link. One hour — long enough to play a full consultation (the same window
 *  the manifest/chunk presigns use). The clip itself is kept; only the link expires. */
export const CLIP_PRESIGN_SECONDS = 3600;

/** The joining service is a cold container: 1–3 s to wake, then seconds of ffmpeg (a real
 *  12-minute, 3-piece join measured 7.2 s). 90 s fails by name long before the MCP route's own
 *  300 s ceiling, leaving room for the Whisper leg that follows it. */
const JOIN_TIMEOUT_MS = 90_000;

/**
 * Whisper's ceiling for a joined clip. The default 90 s is sized for a five-minute chunk; a
 * joined window can be six times that, and a timeout there would throw away a join that
 * succeeded. Scaled to the clip and capped so the tool call still fits inside `maxDuration`.
 */
export function whisperTimeoutForClip(durationMs: number): number {
  return Math.min(180_000, Math.max(90_000, Math.round(durationMs / 3)));
}

// ---------------------------------------------------------------------------
// Key + provenance (D3, D4) — PURE
// ---------------------------------------------------------------------------

/** Compact UTC stamp for a key segment: 2026-08-19T05:34:00.000Z → 20260819T053400Z. */
export function keyStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * `clips/<session_id>/<start>-<end>-<source>.webm`
 *
 * Deterministic: the same window on the same session and microphone is the same key, so asking
 * twice overwrites one object rather than growing the archive by one clip per curious click.
 */
export function clipKey(sessionId: string, startMs: number, endMs: number, source: "primary" | "backup"): string {
  return `${CLIPS_PREFIX}${sessionId}/${keyStamp(startMs)}-${keyStamp(endMs)}-${source}.webm`;
}

export type ClipMeta = {
  session_id: string;
  requested_start: string;
  requested_end: string;
  source: string;
  created_at: string;
};

/** D4 — what the stored object records about where it came from: session, window, microphone,
 *  and when it was made. Written as R2 custom metadata by the joining service. */
export function clipMeta(sessionId: string, startMs: number, endMs: number, source: "primary" | "backup", now: Date = new Date()): ClipMeta {
  return {
    session_id: sessionId,
    requested_start: new Date(startMs).toISOString(),
    requested_end: new Date(endMs).toISOString(),
    source,
    created_at: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// D2 — the 30-minute refusal (PURE)
// ---------------------------------------------------------------------------

export type TooLong = { error: "window_too_long"; requested_minutes: number; limit_minutes: number };

/** Null when the window is allowed; the named refusal when it is not. */
export function refuseIfTooLong(startMs: number, endMs: number): TooLong | null {
  const span = endMs - startMs;
  if (span <= JOIN_MAX_MS) return null;
  return {
    error: "window_too_long",
    requested_minutes: Math.round((span / 60_000) * 10) / 10,
    limit_minutes: JOIN_MAX_MINUTES,
  };
}

// ---------------------------------------------------------------------------
// D15 — joining is refused while any room is recording
//
// A thirty-minute join is far heavier than a single transcription call, and listening back must
// never compete with recording. The question "is anything recording?" is asked with EXACTLY the
// state `scribe_diff_room` reads — the session rollup (`listBenchSessions`), the kiosk listener
// (`getListener` / `isListening`) and the reaper's stall rule (`isBenchStalled`) — imported, not
// re-implemented. A third way of asking would drift from the other two.
//
// A session left 'recording' by a crashed browser is NOT recording: the reaper's own badge rule
// says so, and `scribe_diff_room` already flags it `stalled`. Without that test one dead tab
// would block every future join for ever.
// ---------------------------------------------------------------------------

export type RecordingRoom = { room_id: string; room_slug: string; session_id: string; last_piece_at: string | null; page_open: boolean | null };

export type RecordingCheck =
  | { known: true; rooms: RecordingRoom[] }
  /** The DB could not be asked. We do NOT guess — the caller degrades rather than refusing or
   *  allowing on a coin toss. */
  | { known: false; reason: string };

/** PURE — given the rollup rows and each room's listener, which rooms are genuinely recording. */
export function pickRecordingRooms(
  sessions: ReadonlyArray<{ id: string; room_id: string; room_slug: string; status: string; started_at: string | Date; last_any_chunk_at: string | Date | null }>,
  listeners: ReadonlyMap<string, ListenerRow | null>,
  now: Date,
): RecordingRoom[] {
  const out: RecordingRoom[] = [];
  for (const s of sessions) {
    if (s.status !== "recording") continue;
    const listener = listeners.get(s.room_id) ?? null;
    const pageOpen = listener ? isListening(listener, now) : false;
    // Stalled AND no live kiosk → a dead tab, not a recording. A fresh poll from the kiosk
    // overrides the stall: the tape may simply be between chunk rotations.
    if (isBenchStalled(s, now.getTime()) && !pageOpen) continue;
    out.push({
      room_id: s.room_id,
      room_slug: s.room_slug,
      session_id: s.id,
      last_piece_at: s.last_any_chunk_at ? new Date(s.last_any_chunk_at).toISOString() : null,
      page_open: listener ? pageOpen : null,
    });
  }
  return out;
}

/** Which rooms are recording right now. Never throws — an unreadable bus is `known:false`. */
export async function roomsRecordingNow(now: Date = new Date()): Promise<RecordingCheck> {
  let sessions: Awaited<ReturnType<typeof listBenchSessions>>;
  try {
    sessions = await listBenchSessions({ status: "recording" });
  } catch (e) {
    return { known: false, reason: `sessions_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
  if (sessions.length === 0) return { known: true, rooms: [] };
  const listeners = new Map<string, ListenerRow | null>();
  await Promise.all(
    [...new Set(sessions.map((s) => s.room_id))].map(async (roomId) => {
      try {
        listeners.set(roomId, await getListener(roomId));
      } catch {
        // The bus may not be migrated on this environment. A missing listener is not proof of
        // anything, so the stall rule alone decides — see pickRecordingRooms.
        listeners.set(roomId, null);
      }
    }),
  );
  return { known: true, rooms: pickRecordingRooms(sessions, listeners, now) };
}

// ---------------------------------------------------------------------------
// The client of the joining service
// ---------------------------------------------------------------------------

export type JoinPiece = { key: string; idx: number };

/**
 * Build 3.1 — the output container. Optional, and ABSENT MEANS webm, so every existing caller's
 * request is byte-identical to what it sent before this field existed.
 *
 * Only the mux changes: the codec is libopus either way, so an ogg clip and a webm clip of the
 * same window carry the same Opus audio at the same bitrate. The service owns the key's
 * extension (`outKeyForFormat`), so the two containers can never collide on one deterministic
 * clip key and silently overwrite each other.
 */
export type JoinFormat = "webm" | "ogg";

export type JoinRequest = {
  pieces: JoinPiece[];
  trim: { start_ms: number; end_ms: number };
  out_key: string;
  meta: ClipMeta;
  /** Absent = webm. The service refuses an unknown name rather than falling back. */
  format?: JoinFormat;
};

export type JoinOutcome =
  | { ok: true; key: string; bytes: number; duration_ms: number; served_by?: string }
  /** `hop` names WHICH of the joining service's three transfers failed — worker_to_do,
   *  do_to_container or clip_to_r2. Absent when the failure was not a transfer (a refusal, a
   *  timeout, an unreachable box). */
  | { ok: false; error: string; detail?: string; hop?: string; served_by?: string };

/**
 * PURE — the request body for a window that spans pieces.
 *
 * `covering` is the covering-piece list `resolveRange` already produced, IN ORDER. The trim is
 * expressed against the JOINED stream, which has no gaps in it:
 *   start = how far into the first piece the window begins;
 *   end   = start + every second of the window that actually exists on tape.
 * (The middle pieces are covered end to end, so their `duration_s` is their whole length.)
 */
export function buildJoinRequest(
  sessionId: string,
  covering: ReadonlyArray<{ chunk: { idx: number; r2_key: string }; offset_in_chunk_s: number; duration_s: number }>,
  startMs: number,
  endMs: number,
  source: "primary" | "backup",
  now: Date = new Date(),
  /** Build 3.1 — omitted keeps today's exact request shape: no `format` key on the wire at all. */
  format?: JoinFormat,
): JoinRequest {
  const trimStartMs = Math.round((covering[0]?.offset_in_chunk_s ?? 0) * 1000);
  const coveredMs = Math.round(covering.reduce((a, c) => a + c.duration_s, 0) * 1000);
  return {
    pieces: covering.map((c) => ({ key: c.chunk.r2_key, idx: c.chunk.idx })),
    trim: { start_ms: trimStartMs, end_ms: trimStartMs + coveredMs },
    out_key: clipKey(sessionId, startMs, endMs, source),
    meta: clipMeta(sessionId, startMs, endMs, source, now),
    // Spread rather than `format: format` so an omitted format leaves the KEY OFF the JSON
    // entirely. `{"format": undefined}` and no key at all serialise the same today, but the
    // difference is one JSON.stringify change away from mattering, and "byte-identical to
    // yesterday" is the property this parameter was allowed to exist on.
    ...(format ? { format } : {}),
  };
}

export function joinServiceConfigured(): boolean {
  return Boolean(process.env.AUDIO_JOIN_URL) || poolConfigured("join");
}

/**
 * REDUNDANCY-R1 — which join answers mean "try the next instance". Down (unreachable, timeout, a 5xx,
 * or a 5xx whose body was not JSON) and BUSY: `join_already_running` is one instance's single-flight
 * mutex, and a second instance is exactly what can take the job instead. Everything else — a refusal,
 * a bad request, a failed transfer the service itself reported — is the answer.
 */
export function joinVerdict(o: JoinOutcome): Verdict {
  if (o.ok) return "ok";
  if (o.error === "join_unreachable" || o.error === "join_timeout" || o.error === "join_already_running") return "failover";
  if (/^join_http_5\d\d$/.test(o.error)) return "failover";
  if (o.error === "join_bad_response" && /^status 5\d\d$/.test(o.detail ?? "")) return "failover";
  return "final";
}

/**
 * Call the joining service. NEVER throws, never hangs: an unset URL, a dead box, a timeout and a
 * refusal all come back as `{ ok:false, error }` so the caller can answer with the multi-piece
 * response instead of an error page (D10).
 */
export async function callJoinService(req: JoinRequest, opts: { timeoutMs?: number } = {}): Promise<JoinOutcome> {
  const endpoints = endpointsFor("join");
  if (endpoints.length === 0) return { ok: false, error: "join_service_not_configured" };
  // ONE token for every instance: the twins are the same service, deployed with the same secret.
  const token = process.env.AUDIO_JOIN_TOKEN;
  if (!token) return { ok: false, error: "join_token_not_configured" };
  // R1: the whole pool gets the ONE timeout this call always had; a failover gets only what is left.
  const { value, served_by } = await runPool(
    "join", endpoints,
    (base, budgetMs) => callJoinAt(base, token, req, { timeoutMs: budgetMs }),
    joinVerdict,
    { budgetMs: opts.timeoutMs ?? JOIN_TIMEOUT_MS },
  );
  return served_by ? { ...value, served_by } : value;
}

async function callJoinAt(base: string, token: string, req: JoinRequest, opts: { timeoutMs?: number }): Promise<JoinOutcome> {
  // ONE id per caller request, logged by both layers of the service.
  //
  // A Worker and the Durable Object it calls each emit their own invocation log, so a single POST
  // from here appears in `wrangler tail` as TWO "POST /join" lines. This id is what tells that
  // pair apart from a genuine retry: the same id twice is one request seen at two layers; two ids
  // is something calling twice. One fetch per INSTANCE, no retry wrapper. With a pool configured, a
  // failover to the next instance is a new call and gets a new id, so two ids for one window means two
  // instances were asked, and `served_by` on the outcome says which one answered. Each instance's own
  // mutex answers `join_already_running` to a second job, so a duplicate could never make one container
  // do the work twice. The id is here so that is provable rather than argued.
  const rid = `j_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? JOIN_TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-join-request-id": rid,
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: "join_bad_response", detail: `status ${res.status}` };
    }
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.ok === true && typeof b.key === "string") {
      return { ok: true, key: b.key, bytes: Number(b.bytes ?? 0), duration_ms: Number(b.duration_ms ?? 0) };
    }
    return {
      ok: false,
      error: typeof b.error === "string" ? b.error : `join_http_${res.status}`,
      ...(typeof b.detail === "string" ? { detail: b.detail } : {}),
      // Carried out to the MCP answer so a failure names its own hop there too.
      ...(typeof b.hop === "string" ? { hop: b.hop } : {}),
    };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return { ok: false, error: aborted ? "join_timeout" : "join_unreachable", detail: String((e as Error)?.message ?? e).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}
