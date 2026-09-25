/**
 * lib/tape-zero-alarm.ts — DRAFT (Fable ruling 255b / 343 / 345; scribe #2143, #2147; eta-refuter #2130): the EXACT-ZERO alarm, judged on the TAPE, per recording room.
 * THIS FILE IS INERT: it reads and it decides, and nothing calls it. No route, no cron, no migration, no write, no page. Whether anything pages, and on what numbers, is Fable's ruling; the
 * trigger below is a CANDIDATE.
 *
 * WHY THE TAPE AND NOT THE LEVEL LOG. The level log's `peak` is a duty-cycled 1.25 s RMS reading (eta-refuter #2095): near-silence from a fault and from an EMPTY, CLOSED room read the same on it, and it
 * logged exact 0 while a chime was playing. The TAPE does not have that problem: an Opus chunk of digital silence has ONE deterministic size, and an empty room does not produce it.
 * Measured over every full chunk in bench_chunk (Aug to 25 Sep, read-only, scribe #2143/#2147): 1,610 full chunks sit at EXACTLY 707.93 bytes per second (212,378 bytes per 300 s chunk) and nothing else
 * lies between 707.93 and 711.06; they occur only in OPD 4, OPD 3, Cardiology OPD and OPD 7 (57 runs; the longest 288 chunks); every other room, about 7,000 full chunks, has none; and on 25 Sep OPD 4's
 * EMPTY closed room read 892 to 1,449 B/s (a working mic in a quiet room encodes above the silence size). The 9 Sep unplug-versus-mute ground truth is what fixes 708 as bit-exact zero.
 *
 * DEFINITIONS (all decisions, all pinned by tests/unit/tape-zero-alarm.test.ts):
 *  - a chunk is FULL when its duration is at least MIN_FULL_CHUNK_MS (299 s of the 300 s chunk); short chunks (a stop, a rollover) are never judged;
 *  - it is EXACT ZERO when bytes-per-second = size_bytes * 1000 / duration_ms is within ZERO_CHUNK_TOLERANCE_BPS (1.0) of ZERO_CHUNK_BPS (707.93). NOT a "below 800" band: Home Office has a healthy chunk
 *    at 810, and the nearest non-zero class starts at 711.06 (25 chunks, near-zero with a trace of signal), which is listed as an observation and never alarmed on;
 *  - a RUN is consecutive chunk indexes (idx, idx+1, ...) of ONE session and ONE source (primary or backup mic), all exact; a missing index, a short chunk or a non-exact chunk ends it;
 *  - the CANDIDATE TRIGGER is CONSECUTIVE_TRIGGER (2) exact chunks, 10 minutes of tape. On the data that catches 52 of the 57 runs; 3 would catch 47. Unruled;
 *  - a run is OPEN while it includes the latest full chunk its session has, RECOVERED when a later full chunk exists that is not exact;
 *  - a room is UNKNOWN when it should be recording and its latest chunk ended more than STALE_CHUNK_MS ago (or it has none): "we never looked" must not read as "fine".
 * It says WHAT the tape held (exact digital silence) and never WHY (a muted or unplugged input, a lost permission and a wrong input all look the same).
 *
 * THREE LIMITS, stated so they are not read as covered (eta-refuter #2148):
 *  1. DEVICE CLASS. Three of the four rooms that produce exact zero (OPD 3, Cardiology OPD, OPD 7) are TM20 rooms, where r267/r280 ruled the cause the microphone's HARDWARE MUTE, a deliberate act; only OPD 4 (a
 *     C270, which has no mute button) has exact zero with no benign explanation. The tape cannot tell them apart, so the message takes the input device's class and words a TM20 hit as "the input was silenced (a
 *     hardware mute is likely deliberate)" and any other device as "no mute button on this device: investigate". The 57 historical runs are therefore NOT 57 unexplained faults.
 *  2. THE ENCODER IS NOT PINNED, AND THE CHUNK ROW DOES NOT SAY WHICH BUILD MADE IT. 212,378 bytes is what this app's Opus-in-WebM settings produce for 300 s of digital zero; it was stable across the 1,610
 *     chunks from 9 Sep to 21 Sep 15:51 IST (several app releases; the last exact-zero chunk on record is 21 Sep, so NO chunk since then shows what the current build produces for zeros), but a release that changed the bitrate, frame size or container would move it and the alarm would go silently BLIND (a "field stopped arriving" failure).
 *     bench_chunk carries no app version, so this module cannot refuse "an unmeasured version". What it does: it only judges chunks whose content_type is audio/webm (anything else is never exact zero and is
 *     counted as unjudged by the caller), and it names the requirement for whoever wires it: derive the baseline in the release process by encoding 300 s of zeros with the shipped tapewriter and settings, and
 *     fail the release if it is not ZERO_CHUNK_SIZE_BYTES. Until that exists, PAGING ON THIS RULE IS NOT SAFE, which is also why it is inert (ruling 376).
 *  3. PARTIAL CHUNKS. Only full 300 s chunks are judged, so a mute that starts mid-chunk is seen one chunk late, and the FINAL chunk of every session (shorter) is never judged. The constant is not scaled to other
 *     durations (container overhead is not proportional). The "two consecutive full chunks" trigger stays.
 */
import { sql } from "@/lib/db";

/** bytes per second of a chunk of digital silence: 212,378 bytes / 300 s, the single value 1,610 chunks share. */
export const ZERO_CHUNK_BPS = 707.93;
/** the exact size of a full 300 s zero chunk: the spike is 1,610 chunks at exactly this many bytes (eta-refuter #2148). Documented; the rule itself is the rate above. */
export const ZERO_CHUNK_SIZE_BYTES = 212_378;
/** the only container the baseline was measured on. */
export const MEASURED_CONTENT_TYPE = "audio/webm";
/** tolerance around it; the next class starts 3.1 B/s higher (711.06), so this must stay small. */
export const ZERO_CHUNK_TOLERANCE_BPS = 1.0;
/** only chunks at least this long are judged (a full chunk is 300 s). */
export const MIN_FULL_CHUNK_MS = 299_000;
/** CANDIDATE, unruled: this many consecutive exact chunks make a run alarming. */
export const CONSECUTIVE_TRIGGER = 2;
/** a recording room whose newest chunk ended longer ago than this is UNKNOWN. */
export const STALE_CHUNK_MS = 15 * 60_000;
/** an open episode is re-announced only after this long without a notice (ruling 279). */
export const RENOTICE_AFTER_MS = 3 * 3_600_000;

export type TapeChunk = {
  room_id: string;
  session_id: string;
  idx: number;
  source: string;
  started_at_ms: number;
  ended_at_ms: number;
  duration_ms: number;
  size_bytes: number | null;
  /** the chunk's content type; the baseline was measured on audio/webm only */
  content_type: string | null;
};

/** PURE — bytes per second, or null when the size or the duration is not a usable number. */
export function chunkBps(c: Pick<TapeChunk, "size_bytes" | "duration_ms">): number | null {
  if (c.size_bytes === null || !Number.isFinite(c.size_bytes) || c.size_bytes < 0) return null;
  if (!Number.isFinite(c.duration_ms) || c.duration_ms <= 0) return null;
  return (c.size_bytes * 1000) / c.duration_ms;
}

export const isFullChunk = (c: Pick<TapeChunk, "duration_ms">): boolean => Number.isFinite(c.duration_ms) && c.duration_ms >= MIN_FULL_CHUNK_MS;

/** PURE — a chunk the baseline applies to: full, and (when the content type is known) in the container it was measured on. Only such a chunk can be exact zero OR evidence that a room recovered. */
export function isJudgeableChunk(c: Pick<TapeChunk, "duration_ms"> & { content_type?: string | null }): boolean {
  if (!isFullChunk(c)) return false;
  if (c.content_type === undefined) return true;
  return (c.content_type ?? "").split(";")[0]!.trim().toLowerCase() === MEASURED_CONTENT_TYPE;
}

/** PURE — a FULL chunk whose rate is within the tolerance of the silence size. A short chunk, an unknown size or a malformed row is never exact zero. */
export function isExactZeroChunk(c: Pick<TapeChunk, "size_bytes" | "duration_ms"> & { content_type?: string | null }): boolean {
  // a short chunk, or one in a container the baseline was NOT measured on, is never exact zero
  if (!isJudgeableChunk(c)) return false;
  const bps = chunkBps(c);
  return bps !== null && Math.abs(bps - ZERO_CHUNK_BPS) <= ZERO_CHUNK_TOLERANCE_BPS;
}

export type ZeroRun = {
  room_id: string;
  session_id: string;
  source: string;
  start_idx: number;
  end_idx: number;
  /** consecutive exact chunks */
  length: number;
  start_ms: number;
  end_ms: number;
  /** the run includes the newest full chunk of its session/source: it is still going, as far as the tape shows */
  open: boolean;
  /** the start of the first later full, non-exact chunk, or null while open or when nothing later exists */
  recovered_at_ms: number | null;
};

/**
 * PURE — every run of consecutive exact chunks, per session and source, in room/session/source/idx order. Input order does not matter and duplicates of the same (session, source, idx) collapse to
 * the first. `trigger` filters to alarming runs (default CONSECUTIVE_TRIGGER); pass 1 to see every run.
 */
export function findZeroRuns(chunks: readonly TapeChunk[], trigger: number = CONSECUTIVE_TRIGGER): ZeroRun[] {
  const groups = new Map<string, TapeChunk[]>();
  for (const c of chunks) {
    const key = `${c.room_id}\u0000${c.session_id}\u0000${c.source}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const out: ZeroRun[] = [];
  for (const key of [...groups.keys()].sort()) {
    const seen = new Set<number>();
    const list = groups.get(key)!.sort((a, b) => a.idx - b.idx).filter((c) => (seen.has(c.idx) ? false : (seen.add(c.idx), true)));
    const lastFull = [...list].reverse().find(isJudgeableChunk);
    let cur: TapeChunk[] = [];
    const close = () => {
      if (cur.length > 0 && cur.length >= trigger) {
        const first = cur[0]!;
        const last = cur[cur.length - 1]!;
        const later = list.find((c) => c.idx > last.idx && isJudgeableChunk(c) && !isExactZeroChunk(c));
        out.push({
          room_id: first.room_id, session_id: first.session_id, source: first.source,
          start_idx: first.idx, end_idx: last.idx, length: cur.length,
          start_ms: first.started_at_ms, end_ms: last.ended_at_ms,
          open: lastFull !== undefined && lastFull.idx === last.idx,
          recovered_at_ms: later ? later.started_at_ms : null,
        });
      }
      cur = [];
    };
    for (const c of list) {
      const prev = cur[cur.length - 1];
      if (isExactZeroChunk(c) && (prev === undefined || c.idx === prev.idx + 1)) cur.push(c);
      else {
        close();
        if (isExactZeroChunk(c)) cur.push(c);
      }
    }
    close();
  }
  return out;
}

/** PURE — an OPEN run is re-announced only when the last notice is at least RENOTICE_AFTER_MS old; a run that has recovered, or is no longer open, is never re-announced. */
export function renoticeDue(run: Pick<ZeroRun, "open" | "recovered_at_ms">, lastNoticeMs: number, nowMs: number): boolean {
  return run.open && run.recovered_at_ms === null && nowMs - lastNoticeMs >= RENOTICE_AFTER_MS;
}

/**
 * PURE — rooms that should be recording and whose newest chunk ended more than STALE_CHUNK_MS before `nowMs` (or that have none): UNKNOWN, listed and never green. `expectedRoomIds` is the
 * caller's list of rooms that should be recording now.
 */
export function unknownRooms(expectedRoomIds: readonly string[], chunks: readonly Pick<TapeChunk, "room_id" | "ended_at_ms">[], nowMs: number): string[] {
  const newest = new Map<string, number>();
  for (const c of chunks) newest.set(c.room_id, Math.max(newest.get(c.room_id) ?? -Infinity, c.ended_at_ms));
  return [...new Set(expectedRoomIds)].filter((r) => !(nowMs - (newest.get(r) ?? -Infinity) <= STALE_CHUNK_MS)).sort();
}

export type DeviceClass = "tm20" | "other" | "unknown";

/** PURE — the class of an input device by its name: a TONOR TM20 (which has a hardware mute), any other named device, or unknown. */
export function deviceClass(name: string | null | undefined): DeviceClass {
  if (typeof name !== "string" || name.trim() === "") return "unknown";
  return /\bTM20\b|TONOR/i.test(name) ? "tm20" : "other";
}

const DEVICE_SENTENCE: Record<DeviceClass, string> = {
  tm20: "This input has a hardware mute; a mute is likely deliberate (a clinician pressing it), so this may be expected.",
  other: "This input has no mute button: investigate.",
  unknown: "The input device is not known here, so a hardware mute cannot be ruled in or out.",
};

/**
 * PURE — the message text. A room label the caller chooses, a count of chunks and minutes, a time, the device class: no audio, no transcript, no person. Says what the tape held, that it does not say why, and
 * (eta-refuter #2148) that a hit on a TM20 is likely a deliberate mute while a hit on a device with no mute is not.
 */
export function tapeZeroMessage(roomLabel: string, run: Pick<ZeroRun, "length" | "start_ms" | "end_ms" | "open" | "recovered_at_ms">, device: DeviceClass = "unknown"): { subject: string; text: string } {
  const minutes = Math.round((run.end_ms - run.start_ms) / 60_000);
  const at = (ms: number) => {
    const d = new Date(ms + 5.5 * 3_600_000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} IST`;
  };
  const state = run.recovered_at_ms !== null ? `It recovered at ${at(run.recovered_at_ms)}.` : run.open ? "It is still going on the newest chunk." : "It has not been followed by a good chunk yet.";
  return {
    subject: `EvenScribe: ${roomLabel} recorded exact digital silence for ${run.length} consecutive chunks (${minutes} min)`,
    text:
      `${roomLabel}: ${run.length} consecutive 5-minute chunks (${minutes} minutes, from ${at(run.start_ms)}) on the tape hold exact digital silence (the recorder delivered all zeros); an empty room does not do this. ${state} ` +
      `That does not say why: a muted or unplugged input, a lost microphone permission and a wrong input all look the same. ${DEVICE_SENTENCE[device]}`,
  };
}

/**
 * READ-ONLY — full chunks per room, from bench_chunk joined to its session. One statement, no write. `roomId` narrows it; `sinceMs`/`untilMs` bound the chunk's start (untilMs exclusive). Rows with an unknown
 * size are returned with size_bytes null (they are never exact zero) and ordered by session, source and idx.
 */
export async function readTapeChunks(opts: { roomId?: string; sinceMs: number; untilMs: number }): Promise<TapeChunk[]> {
  const since = new Date(opts.sinceMs).toISOString();
  const until = new Date(opts.untilMs).toISOString();
  const room = opts.roomId ?? null;
  const rows = (await sql`
    SELECT s.room_id, c.session_id, c.idx, coalesce(c.source, 'primary') AS source, c.started_at, c.ended_at, c.duration_ms, c.size_bytes, c.content_type
      FROM bench_chunk c
      JOIN bench_session s ON s.id = c.session_id
     WHERE c.started_at >= ${since}::timestamptz
       AND c.started_at <  ${until}::timestamptz
       AND (${room}::text IS NULL OR s.room_id = ${room}::text)
     ORDER BY s.room_id, c.session_id, source, c.idx
  `) as Array<{ room_id: string; session_id: string; idx: number | string; source: string; started_at: string | Date; ended_at: string | Date; duration_ms: number | string; size_bytes: number | string | null; content_type: string | null }>;
  return rows.map((r) => ({
    room_id: r.room_id,
    session_id: r.session_id,
    idx: Number(r.idx),
    source: r.source,
    started_at_ms: new Date(r.started_at).getTime(),
    ended_at_ms: new Date(r.ended_at).getTime(),
    duration_ms: Number(r.duration_ms),
    size_bytes: r.size_bytes === null ? null : Number(r.size_bytes),
    content_type: r.content_type,
  }));
}
