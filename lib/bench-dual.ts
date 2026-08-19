/**
 * lib/bench-dual.ts — pure helpers for Room Bench dual-mic capture (Kickoff K-B).
 *
 * No React, no DOM, no DB: everything here is unit-testable and is what the kiosk hook
 * (lib/use-room-recorder) leans on for the parts that must be provably right:
 *
 *   - ChunkSource + IndexedDB / R2 naming: primary keys are byte-identical to today
 *     (`{session}:{idx}`, `chunk_{idx}.webm`); backup adds a `backup` segment.
 *   - uploadBodies(): the presign / verify request bodies. For the PRIMARY stream the
 *     `source` field is OMITTED (the wire format of today's kiosk is unchanged); the
 *     backup stream sends `source:"backup"`.
 *   - SilenceWatchdog: the primary-mic failsafe (R5) — RMS≈0 for ~60 s trips, audio
 *     returning clears. Pure state machine fed with (rms, nowMs).
 *   - runLockstep(): run a session verb on the primary lane and the backup lane in
 *     SEPARATE try/catch domains — a backup failure is reported, never propagated, and
 *     can never stop the primary (R4/R8/R12).
 */

export type ChunkSource = "primary" | "backup";

export const BENCH_EVENT_KINDS = [
  "mic_primary_lost",
  "mic_primary_restored",
  "mic_backup_unavailable",
  "mic_backup_error",
  "mic_backup_restored",
] as const;
export type BenchMicEventKind = (typeof BENCH_EVENT_KINDS)[number];

/** IndexedDB record key. Primary = today's `{session}:{idx}`; backup = `{session}:backup:{idx}`. */
export function idbChunkKey(sessionId: string, idx: number, source: ChunkSource = "primary"): string {
  return source === "backup" ? `${sessionId}:backup:${idx}` : `${sessionId}:${idx}`;
}

/** R2 object basename inside the session folder. Primary = today's `chunk_{idx}.webm`. */
export function chunkBasename(idx: number, source: ChunkSource = "primary"): string {
  const n = String(idx).padStart(5, "0");
  return source === "backup" ? `backup_chunk_${n}.webm` : `chunk_${n}.webm`;
}

export type ChunkMeta = {
  session_id: string;
  idx: number;
  source: ChunkSource;
  content_type: string;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  gap_before_ms: number;
  size_bytes: number;
};

/** Request bodies for POST /api/bench/upload-url and POST /api/bench/chunks. */
export function uploadBodies(m: ChunkMeta): {
  presign: Record<string, unknown>;
  row: Record<string, unknown>;
} {
  const src = m.source === "backup" ? { source: "backup" } : {};
  return {
    presign: { session_id: m.session_id, idx: m.idx, content_type: m.content_type, ...src },
    row: {
      session_id: m.session_id,
      idx: m.idx,
      content_type: m.content_type,
      started_at: new Date(m.started_at).toISOString(),
      ended_at: new Date(m.ended_at).toISOString(),
      duration_ms: m.duration_ms,
      size_bytes: m.size_bytes,
      gap_before_ms: m.gap_before_ms,
      ...src,
    },
  };
}

// ---------------------------------------------------------------------------
// Silence watchdog (primary failsafe, R5)
// ---------------------------------------------------------------------------

export const SILENCE_RMS = 0.0015; // digital-zero territory; room noise on a live mic is ≫ this
export const SILENCE_TRIP_MS = 60_000;

export type WatchdogEvent = "trip" | "clear" | null;

export class SilenceWatchdog {
  private silentSince: number | null = null;
  private tripped = false;
  constructor(private opts: { silentRms?: number; tripAfterMs?: number } = {}) {}

  get isTripped(): boolean {
    return this.tripped;
  }

  /** Feed one RMS sample. Returns "trip" once when silence has lasted tripAfterMs, "clear" once when audio returns. */
  feed(rms: number, nowMs: number): WatchdogEvent {
    const thr = this.opts.silentRms ?? SILENCE_RMS;
    const after = this.opts.tripAfterMs ?? SILENCE_TRIP_MS;
    if (!Number.isFinite(rms) || rms < thr) {
      if (this.silentSince === null) this.silentSince = nowMs;
      if (!this.tripped && nowMs - this.silentSince >= after) {
        this.tripped = true;
        return "trip";
      }
      return null;
    }
    this.silentSince = null;
    if (this.tripped) {
      this.tripped = false;
      return "clear";
    }
    return null;
  }

  reset(): void {
    this.silentSince = null;
    this.tripped = false;
  }
}

/** RMS of a byte time-domain buffer (0..255 centred on 128), as the kiosk level meter computes it. */
export function rmsOfBytes(buf: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = ((buf[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return buf.length ? Math.sqrt(sum / buf.length) : 0;
}

// ---------------------------------------------------------------------------
// Lockstep (R7) with isolation (R4/R8/R12)
// ---------------------------------------------------------------------------

export type LockstepResult = {
  primary: { ok: true } | { ok: false; error: string };
  backup: { ok: true } | { ok: false; error: string } | { skipped: true };
};

/**
 * Run `verb` on both lanes. The primary runs first and its failure PROPAGATES (the caller
 * owns primary error handling as today). The backup runs in its own try/catch: its failure is
 * reported through `onBackupError` and in the result, never thrown, never able to touch the
 * primary. When `backup` is null (no backup device) it is skipped.
 */
export async function runLockstep(
  verb: string,
  lanes: { primary: () => Promise<void>; backup: (() => Promise<void>) | null },
  onBackupError?: (verb: string, error: string) => void,
): Promise<LockstepResult> {
  let primary: LockstepResult["primary"];
  try {
    await lanes.primary();
    primary = { ok: true };
  } catch (e) {
    primary = { ok: false, error: String((e as Error)?.message ?? e) };
    // Still give the backup its turn (isolation cuts both ways), then rethrow the primary error.
    const backup = await runBackup(verb, lanes.backup, onBackupError);
    void backup;
    throw e;
  }
  const backup = await runBackup(verb, lanes.backup, onBackupError);
  return { primary, backup };
}

async function runBackup(
  verb: string,
  fn: (() => Promise<void>) | null,
  onBackupError?: (verb: string, error: string) => void,
): Promise<LockstepResult["backup"]> {
  if (!fn) return { skipped: true };
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 200);
    try {
      onBackupError?.(verb, error);
    } catch {
      /* a reporter must never hurt the lanes */
    }
    return { ok: false, error };
  }
}

/** Heuristic default for the backup device: the machine's built-in mic, else any input that is not the primary. */
export function pickDefaultBackupDevice(
  devices: Array<{ deviceId: string; label: string }>,
  primaryDeviceId: string | null,
): string | null {
  const notPrimary = devices.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== primaryDeviceId);
  const builtIn = notPrimary.find((d) => /built-?in|internal|macbook|imac|mac mini|mac studio/i.test(d.label));
  if (builtIn) return builtIn.deviceId;
  return notPrimary[0]?.deviceId ?? null;
}
