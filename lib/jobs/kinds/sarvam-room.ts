/**
 * lib/jobs/kinds/sarvam-room.ts — S8D (V ruling O5, 09 Oct 2026). ROOM audio for Sarvam, MCP callers only: a bench window, or an on-demand segment of a room session
 * ({session_id, from, to} or {room, date, from, to}). Production callers never reach this file (the parser refuses room arguments for them, scope_consult_only).
 * The held-out rule (lib/jobs/held-out.ts) runs BEFORE anything here reads a chunk; the caps and the paid-call row are the existing Sarvam ones (sarvam-transcribe.ts).
 * Results land in R2 mcp-sarvam/<job_id>.json and the job result only, labelled "sarvam_mcp_research": no cue, no stt_turn, no transcription_run, nothing the app or notes read.
 */
import { sql } from "@/lib/db";
import { listBenchChunks, listBenchSessions, type BenchChunkRow } from "@/lib/bench";
import { resolveRange, type CoveringChunk } from "@/lib/bench-range";
import { JOIN_MAX_MS, buildJoinRequest, callJoinService } from "@/lib/bench-join";
import { JobArgsError } from "../types";
import { guardSessionSpan } from "@/lib/voice-blind";

export type RoomSource =
  | { source: "window"; window_id: string }
  | { source: "range"; session_id?: string; room?: string; date?: string; start: number; end: number };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** PURE — an ISO time, epoch ms, or an HH:MM[:SS] IST clock on `date`; null when it is none of those. */
export function parseWhen(v: unknown, date?: string): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 1e11) return v;
  if (typeof v !== "string") return null;
  const t = v.trim();
  const c = CLOCK.exec(t);
  if (c) {
    if (!date || !DATE.test(date)) return null;
    const ms = Date.parse(`${date}T${c[1]}:${c[2]}:${c[3] ?? "00"}+05:30`);
    return Number.isFinite(ms) ? ms : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** PURE — the room source in a raw args object, or null when it names none. Throws JobArgsError on a malformed one (the 30-minute limit included). */
export function parseRoomSource(o: Record<string, unknown>): RoomSource | null {
  const win = typeof o.window_id === "string" ? o.window_id.trim() : "";
  const hasRange = o.session_id !== undefined || o.room !== undefined || o.from !== undefined || o.to !== undefined || o.date !== undefined;
  if (!win && !hasRange) return null;
  if (win && hasRange) throw new JobArgsError("give exactly one room source: {window_id} or {session_id | room+date, from, to}");
  if (win) {
    if (!ID.test(win)) throw new JobArgsError("bad args: window_id");
    return { source: "window", window_id: win };
  }
  const session = typeof o.session_id === "string" ? o.session_id.trim() : "";
  const room = typeof o.room === "string" ? o.room.trim() : "";
  const date = typeof o.date === "string" ? o.date.trim() : undefined;
  if (!session === !room) throw new JobArgsError("give exactly one of session_id or room");
  if (session && !/^bs_[A-Za-z0-9_-]{1,120}$/.test(session)) throw new JobArgsError("bad args: session_id");
  if (room && (!ID.test(room) || !date || !DATE.test(date))) throw new JobArgsError("bad args: room needs a date (YYYY-MM-DD)");
  const start = parseWhen(o.from, date), end = parseWhen(o.to, date);
  if (start === null || end === null) throw new JobArgsError("bad args: from and to must be ISO times, or HH:MM IST with a date");
  if (end <= start) throw new JobArgsError("end must be after start");
  if (end - start > JOIN_MAX_MS) throw new JobArgsError("window_too_long: at most 30 minutes a request");
  return { source: "range", ...(session ? { session_id: session } : { room, date }), start, end };
}

const asMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  if (v instanceof Date) return v.getTime();
  return null;
};

/** The session a {room, date, from, to} range lands on (the first session of the room that overlaps it), or the given session_id; null when none. Rows only, no chunk or audio read. */
export async function resolveRangeSession(a: Record<string, unknown>): Promise<string | null> {
  if (typeof a.session_id === "string" && a.session_id) return a.session_id;
  if (typeof a.room !== "string" || !a.room) return null;
  const start = Number(a.start), end = Number(a.end);
  const ids = (await sql`SELECT id FROM room WHERE id = ${a.room}::text OR slug = ${a.room}::text`) as Array<{ id: string }>;
  for (const r of ids) {
    const sessions = await listBenchSessions({ room_id: r.id });
    const hit = sessions.find((s) => { const x = asMs(s.started_at), y = asMs(s.last_any_chunk_at) ?? asMs(s.ended_at); return x !== null && x <= end && (y === null || y >= start); });
    if (hit) return hit.id;
  }
  return null;
}

export type RoomClip = { ok: true; clip_key: string; content_type: string; scope: "window" | "room_segment"; ref: string; source_kind: "room_window" | "room_segment"; chunk_whole?: boolean; clip_start_ms?: number; clip_end_ms?: number } | { ok: false; error: "source_not_found" | "no_audio_in_range" | "join_failed" | "session_unresolved" | "window_too_long" | "blind_room_day" };

/** Find the audio: the chunk that covers the span (one chunk = that chunk), or the joined clip. Reads chunk ROWS and, for a join, the join service; the held-out check has already run. */
export async function resolveRoomClip(a: Record<string, unknown>): Promise<RoomClip> {
  let sessionId = typeof a.session_id === "string" ? a.session_id : "";
  let start = Number(a.start), end = Number(a.end);
  let scope: "window" | "room_segment" = "room_segment";
  let ref = "";
  if (typeof a.window_id === "string" && a.window_id) {
    const rows = (await sql`SELECT session_id, start_ms, end_ms FROM bench_window WHERE id = ${a.window_id}::text LIMIT 1`) as Array<{ session_id: string; start_ms: string | number; end_ms: string | number }>;
    if (!rows[0]) return { ok: false, error: "source_not_found" };
    sessionId = rows[0].session_id; start = Number(rows[0].start_ms); end = Number(rows[0].end_ms);
    scope = "window"; ref = a.window_id;
  }
  if (!sessionId) sessionId = (await resolveRangeSession({ ...a, start, end })) ?? "";
  if (!sessionId) return { ok: false, error: "session_unresolved" };
  // D-1: the session this range LANDED on is held-out checked as a whole (B3-2), before any chunk is listed, whichever source named it
  if ((await guardSessionSpan(sessionId, { startMs: start, endMs: end })) === "blind_room_day") return { ok: false, error: "blind_room_day" };
  if (!ref) ref = sessionId;
  if (!(end > start) || end - start > JOIN_MAX_MS) return { ok: false, error: "window_too_long" };
  const chunks = await listBenchChunks(sessionId);
  const res = resolveRange(chunks, start, end, "primary");
  if (res.kind === "none") return { ok: false, error: "no_audio_in_range" };
  const covering = (res.kind === "single" ? [res.covering] : res.covering) as Array<CoveringChunk<BenchChunkRow>>;
  if (covering.length === 1) {
    const c = covering[0]!.chunk;
    // R-2 (refuter): the covering chunk goes whole; the result says so with the real span of the audio sent
    return { ok: true, clip_key: c.r2_key, content_type: c.content_type || "audio/webm", scope, ref, source_kind: scope === "window" ? "room_window" : "room_segment", chunk_whole: true, clip_start_ms: asMs(c.started_at) ?? start, clip_end_ms: asMs(c.ended_at) ?? end };
  }
  const joined = await callJoinService(buildJoinRequest(sessionId, covering, start, end, "primary"));
  if (!joined.ok) return { ok: false, error: "join_failed" };
  return { ok: true, clip_key: joined.key, content_type: "audio/webm", scope, ref, source_kind: scope === "window" ? "room_window" : "room_segment", chunk_whole: false, clip_start_ms: start, clip_end_ms: end };
}
