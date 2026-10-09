/**
 * lib/room-access/keys.ts — GUARD: the ONLY place an R2 ROOM-AUDIO key is built or its prefix named. The build gate (tests/unit/room-access-gate.test.ts) fails for any other file that
 * writes one of these prefixes. Each prefix maps to its PLACEMENT in lib/room-access/jobs.ts (clipKeyHeldOut): bench/ (room slug + date + session), clips/ (session), vad-trim/ (window),
 * reb/ (palimpsest tracks: the consult manifest shape only), consult-clips/ (consult uid), mcp-sarvam/ (Sarvam result JSON, by job).
 */
export const BENCH_PREFIX = "bench/";
export const CLIPS_PREFIX = "clips/";
export const VAD_TRIM_PREFIX = "vad-trim/";
export const REB_PREFIX = "reb/";
export const CONSULT_CLIPS_PREFIX = "consult-clips/";
export const MCP_SARVAM_PREFIX = "mcp-sarvam/";

/** `bench/{room_slug}/{YYYY-MM-DD}/{session_id}/chunk_{idx padded 5}.webm` (backup stream: backup_chunk_…). */
export function benchChunkKey(roomSlug: string, dateYmd: string, sessionId: string, idx: number, source: "primary" | "backup" = "primary"): string {
  const base = source === "backup" ? "backup_chunk_" : "chunk_";
  return `${BENCH_PREFIX}${roomSlug}/${dateYmd}/${sessionId}/${base}${String(idx).padStart(5, "0")}.webm`;
}

/** Compact UTC stamp for a key segment: 2026-08-19T05:34:00.000Z → 20260819T053400Z. */
export function keyStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** `clips/<session_id>/<start>-<end>-<source>.webm`: deterministic, so asking twice overwrites one object. */
export function clipKey(sessionId: string, startMs: number, endMs: number, source: "primary" | "backup"): string {
  return `${CLIPS_PREFIX}${sessionId}/${keyStamp(startMs)}-${keyStamp(endMs)}-${source}.webm`;
}

/** The R2 key for a window's speech-only file. Derived from ids only; deleted when the job finishes. */
export function trimmedAudioKey(windowId: string, runId: string): string {
  return `${VAD_TRIM_PREFIX}${windowId}/${runId}.wav`;
}

/** The Sarvam result object of a job. */
export const sarvamResultKey = (jobId: string): string => `${MCP_SARVAM_PREFIX}${jobId}.json`;

/** `consult-clips/<ist_date>/<room_slug>/<consult_uid>/consult.flac` (the CONSULT cutter's clip). The caller has validated every part. */
export const consultClipKey = (istDate: string, roomSlug: string, consultUid: string): string => `${CONSULT_CLIPS_PREFIX}${istDate}/${roomSlug}/${consultUid}/consult.flac`;

export const isBenchKey = (key: string): boolean => key.startsWith(BENCH_PREFIX);
/** True for any key under reb/ (never writable, readable only in the consult manifest shape: see sarvam-lab). */
export const isRebKey = (key: string): boolean => key.startsWith(REB_PREFIX);
