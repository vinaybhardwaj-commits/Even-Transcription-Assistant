/**
 * lib/jobs/held-out.ts — K3-2 (REL2-R3): the CENTRAL held-out guard for jobs. A JobKind that reads room data declares `heldOut(args)`; submitJob runs it BEFORE the insert (a refused job leaves no row), and the
 * runner runs it again at the kind's FIRST step (a job inserted straight into the table fails there with zero reads). The registry refuses a kind that says it touches room data and has no guard. The guards
 * below are the shared building blocks; they ask only for placements (never content). A guard that cannot reach the database THROWS: no answer is not "clean".
 */
import { sql } from "@/lib/db";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { guardSessionSpan, roomDayIsBlind, spanTouchesBlindDay, windowBlindAny, windowsBlindAny } from "@/lib/voice-blind";

export type HeldOutVerdict = "blind_room_day" | "window_unplaced";
export type HeldOutGuard = (args: Record<string, unknown>) => Promise<HeldOutVerdict | null>;

/** A window job: ANY placement of the window held out, or its session's day / span held out. A window that does not exist is not refused here (the kind reports it and reads nothing). */
export async function windowHeldOut(windowId: string): Promise<HeldOutVerdict | null> {
  const rows = (await sql`SELECT session_id, start_ms, end_ms FROM bench_window WHERE id = ${windowId}::text LIMIT 1`) as Array<{ session_id: string; start_ms: string | number; end_ms: string | number }>;
  const w = rows[0];
  if (!w) return null;
  if (await windowBlindAny(windowId)) return "blind_room_day";
  return guardSessionSpan(w.session_id, { startMs: Number(w.start_ms), endMs: Number(w.end_ms) });
}

export const roomDayHeldOut = async (roomDayId: string): Promise<HeldOutVerdict | null> => ((await roomDayIsBlind(roomDayId)) ? "blind_room_day" : null);

/** A room given as an id or a slug: both spellings are checked (the mapped id too). */
async function roomIds(room: string): Promise<string[]> {
  const rows = (await sql`SELECT id FROM room WHERE id = ${room}::text OR slug = ${room}::text`) as Array<{ id: string }>;
  return [...new Set([room, ...rows.map((r) => r.id)])];
}

/** A (room, time span) job. */
export async function roomSpanHeldOut(room: string, startMs: number, endMs: number): Promise<HeldOutVerdict | null> {
  for (const id of await roomIds(room)) if (spanTouchesBlindDay(id, startMs, endMs)) return "blind_room_day";
  return null;
}

/** A (room, IST date) job. */
export async function roomDateHeldOut(room: string, istDate: string): Promise<HeldOutVerdict | null> {
  for (const id of await roomIds(room)) if (isBlindRoomDay(istDate, id)) return "blind_room_day";
  return null;
}

/** transcribe_range / stitch: a session (whole span of the range) or a room + range. */
export const sessionRangeHeldOut: HeldOutGuard = async (a) => {
  const start = Number(a.start), end = Number(a.end);
  const span = Number.isFinite(start) && Number.isFinite(end) ? { startMs: start, endMs: end } : undefined;
  if (typeof a.session_id === "string" && a.session_id) {
    const v = await guardSessionSpan(a.session_id, span);
    if (v) return v;
  }
  if (typeof a.room === "string" && a.room && span) return roomSpanHeldOut(a.room, span.startMs, span.endMs);
  return null;
};

export const windowArgHeldOut: HeldOutGuard = async (a) => (typeof a.window_id === "string" && a.window_id ? windowHeldOut(a.window_id) : null);
export const roomDayArgHeldOut: HeldOutGuard = async (a) => (typeof a.room_day_id === "string" && a.room_day_id ? roomDayHeldOut(a.room_day_id) : null);

/** A window job whose window must EXIST to be placed: an unknown window is window_unplaced (used where the id comes out of a storage key, so fail closed). */
export async function windowHeldOutStrict(windowId: string): Promise<HeldOutVerdict | null> {
  const rows = (await sql`SELECT 1 AS one FROM bench_window WHERE id = ${windowId}::text LIMIT 1`) as unknown[];
  if (rows.length === 0) return "window_unplaced";
  return windowHeldOut(windowId);
}

/**
 * K4-1: the audio key prefixes a key-taking job (route_transcribe, audio_measure, stt_fanout) may name, each mapped to its placement. An ALLOWLIST: any other prefix is refused
 * (`window_unplaced`, fail closed). Every R2 key builder in the tree (lib/r2.ts, bench-join, diarize-vad-trim, voice-samples, sarvam-common, rubrics/store, consult-clip) is listed in the K4 report.
 *   bench/<room slug>/<IST date>/<session>/chunk_…       room slug + date + session (all three)
 *   clips/<session>/…                                    the session (joined window clips)
 *   vad-trim/<window id>/<run>.wav                       the WINDOW (diarize's trimmed copy of a window's audio), any placement
 *   encounters/<id>.<ext>, whisper-buffer/<id>.webm      doctor-PWA encounter audio: no room placement
 * Not audio sources for these kinds, so refused: voice-samples/ (clinician samples), mcp-sarvam/ and rubric/ (result JSON), consult-clips/ (resolved by consult uid in S8C's own path).
 */
export const AUDIO_KEY_PREFIXES = ["bench/", "clips/", "vad-trim/", "encounters/", "whisper-buffer/"] as const;
export const clipKeyHeldOut: HeldOutGuard = async (a) => {
  const key = typeof a.clip_key === "string" ? a.clip_key : "";
  if (!key || key.includes("..") || key.startsWith("/") || !AUDIO_KEY_PREFIXES.some((p) => key.startsWith(p))) return "window_unplaced";
  const m = /^bench\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(bs_[^/]+)\/[^/]+$/.exec(key);
  if (m) {
    if ((await roomDateHeldOut(m[1]!, m[2]!)) || (await guardSessionSpan(m[3]!))) return "blind_room_day";
    return null;
  }
  const c = /^clips\/(bs_[^/]+)\/[^/]+$/.exec(key);
  if (c) return (await guardSessionSpan(c[1]!)) ?? null;
  const v = /^vad-trim\/([A-Za-z0-9_-]{1,80})\/[A-Za-z0-9_.-]{1,120}$/.exec(key);
  if (v) return windowHeldOutStrict(v[1]!);
  if (/^(encounters|whisper-buffer)\/[A-Za-z0-9_.-]{1,160}$/.test(key)) return null;
  return "window_unplaced"; // an allowed prefix with a shape this code cannot place
};

/** (room, IST date) args (day_manifest). */
export const roomDateArgHeldOut: HeldOutGuard = async (a) => (typeof a.room === "string" && typeof a.ist_date === "string" ? roomDateHeldOut(a.room, a.ist_date) : null);

/**
 * The rubric kinds: every unit is read through the rubric readers, which refuse a held-out unit on all placements and EXCLUDE it, counted (blind_excluded), without failing the run. The hook is declared so the
 * registry is uniform; it names that rule rather than refusing a whole run for one unit.
 */
export const perUnitHeldOut: HeldOutGuard = async () => null;

/**
 * K4-2: a room-day job that iterates windows leaves out every window with ANY held-out placement (windowBlindAny's set: bench, diarize, turn rows, window text, emotion rows), inside the
 * loop's input, and counts them (`n_blind_excluded`). A day whose own room-day is held out is refused earlier (the hook); this is for a clean day with one window placed elsewhere.
 */
export async function splitBlindWindows<T>(items: readonly T[], idOf: (t: T) => string): Promise<{ kept: T[]; excluded: number }> {
  const blind = await windowsBlindAny(items.map(idOf));
  const kept = items.filter((x) => !blind.has(idOf(x)));
  return { kept, excluded: items.length - kept.length };
}
