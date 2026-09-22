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
  /** D36 — what the meter heard during this piece. Null where it could not be measured; the
   *  field is then OMITTED from the wire entirely rather than sent as a zero, because a zero
   *  and an absence mean opposite things to the size rule. */
  peak_level?: number | null;
  avg_level?: number | null;
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
      // Omitted, not zeroed, when the meter had nothing: an older server ignores the fields and
      // a newer one stores NULL, which reads as "not measured" rather than as silence.
      ...(typeof m.peak_level === "number" ? { peak_level: m.peak_level } : {}),
      ...(typeof m.avg_level === "number" ? { avg_level: m.avg_level } : {}),
      ...src,
    },
  };
}

// ---------------------------------------------------------------------------
// Silence watchdog (primary failsafe, R5)
// ---------------------------------------------------------------------------

export const SILENCE_RMS = 0.0015; // digital-zero territory; room noise on a live mic is ≫ this
export const SILENCE_TRIP_MS = 60_000;

/**
 * The cadence the watchdog is fed at, and therefore how many samples a trip needs.
 *
 * Build 2 §2.3 turned the trip condition from ELAPSED TIME into CONSECUTIVE EVIDENCE, so the
 * count matters where the duration used to: sixty consecutive silent samples at one a second.
 */
export const WATCHDOG_FEED_MS = 1_000;
export const SILENCE_TRIP_SAMPLES = Math.round(SILENCE_TRIP_MS / WATCHDOG_FEED_MS);

/**
 * How late a sample may be before it counts as a SKIPPED one rather than a consecutive one.
 *
 * Twice the cadence. A browser that throttles a background timer, a garbage collection pause or a
 * suspended AudioContext all produce a gap; none of them is evidence about the microphone.
 */
export const WATCHDOG_SKIP_AFTER_MS = WATCHDOG_FEED_MS * 2;

export type WatchdogEvent = "trip" | "clear" | null;

/**
 * The primary microphone's silence failsafe (R5).
 *
 * WHAT CHANGED IN BUILD 2 (§2.3, D37), and why it had to.
 *
 * It used to compare two WALL-CLOCK MOMENTS: it stamped `silentSince` on the first quiet sample
 * and tripped once `now - silentSince` passed a minute. Each sample is about eleven milliseconds
 * of audio — shorter than the pause between two words — so the stamp survived any gap in the
 * feed, and a minute of WALL CLOCK is not a minute of silence. A throttled timer, a long GC pause
 * or a suspended context could carry a stale stamp across a gap and trip on a microphone that was
 * working the whole time. That is what fired on two working microphones in one morning, and each
 * false trip bound every remaining window of the day to a spare.
 *
 * It now requires CONSECUTIVE EVIDENCE: sixty samples in a row that were actually taken, actually
 * quiet, and actually one second apart. A sample that arrives late — meaning one was skipped —
 * RESETS the run rather than extending it, because a gap is an absence of evidence and this
 * class's whole failure mode was treating absence as proof.
 *
 * The trip threshold is unchanged in wall-clock terms: sixty seconds of continuous silence still
 * trips it. What changed is that sixty seconds of NOT LOOKING no longer does.
 *
 * It is also no longer an input to which microphone answers a window (D37) — see lib/mic-health.ts.
 * It still does the one job it was built for: flushing the segment and reporting a room that has
 * genuinely gone silent.
 */
export class SilenceWatchdog {
  private silentRun = 0;
  private lastFeedMs: number | null = null;
  private tripped = false;
  constructor(private opts: { silentRms?: number; tripAfterMs?: number; feedMs?: number; skipAfterMs?: number } = {}) {}

  get isTripped(): boolean {
    return this.tripped;
  }

  /** How many consecutive quiet samples are currently counted. Exposed for tests and the chip. */
  get run(): number {
    return this.silentRun;
  }

  /**
   * Feed one RMS sample. Returns "trip" once when silence has lasted for the required run of
   * consecutive samples, "clear" once when audio returns.
   */
  feed(rms: number, nowMs: number): WatchdogEvent {
    const thr = this.opts.silentRms ?? SILENCE_RMS;
    const feedMs = this.opts.feedMs ?? WATCHDOG_FEED_MS;
    const skipAfter = this.opts.skipAfterMs ?? Math.max(feedMs * 2, WATCHDOG_SKIP_AFTER_MS);
    const needed = Math.max(1, Math.round((this.opts.tripAfterMs ?? SILENCE_TRIP_MS) / feedMs));

    // A SKIPPED SAMPLE RESETS THE RUN. The gap tells us nothing about the microphone, and the old
    // version's habit of carrying a stale stamp across exactly this gap is what made it fire on
    // healthy rooms. Counted from the previous feed, so a first sample never counts as a skip.
    const gap = this.lastFeedMs === null ? 0 : nowMs - this.lastFeedMs;
    const skipped = this.lastFeedMs !== null && gap > skipAfter;
    this.lastFeedMs = nowMs;
    if (skipped) {
      this.silentRun = 0;
      return null; // never trip and never clear on a gap: it is not evidence either way
    }

    if (!Number.isFinite(rms) || rms < thr) {
      this.silentRun++;
      if (!this.tripped && this.silentRun >= needed) {
        this.tripped = true;
        return "trip";
      }
      return null;
    }
    this.silentRun = 0;
    if (this.tripped) {
      this.tripped = false;
      return "clear";
    }
    return null;
  }

  reset(): void {
    this.silentRun = 0;
    this.lastFeedMs = null;
    this.tripped = false;
  }
}

/**
 * WHAT A MICROPHONE HEARD OVER AN INTERVAL (Build 2 §2.2, D36).
 *
 * ONE SAMPLE IS NOT A LEVEL. The analyser reads about eleven milliseconds of audio, which is
 * shorter than the pause between two words, so a snapshot taken at the wrong instant reads zero on
 * a room in full conversation. Everything that consumes a level in this build — the operator
 * page's bars, and the per-piece evidence the size rule needs — wants a summary over a span
 * instead: the HIGHEST reading, which says somebody spoke at all, and the MEAN, which says how
 * much of the span had sound in it. Neither is derivable from the other and both are kept.
 *
 * TAKE-AND-RESET. `take()` returns the summary and starts a fresh interval, so consecutive reads
 * describe consecutive spans and never overlap. A span with no samples in it returns NULL, never
 * zero: nothing was measured, and a zero would be indistinguishable from a microphone that heard
 * silence — which is the exact confusion this build exists to remove.
 *
 * Deliberately not a hook and not React-aware: it is fed from a bare interval and read from a
 * poll, both outside the render cycle, and made a class so a test can drive it directly.
 */
export type LevelSummary = { peak: number; avg: number; zero_ratio: number };

export class LevelAccumulator {
  private peak = 0;
  private sum = 0;
  private n = 0;
  private zeroN = 0;

  /** Feed one RMS reading. Non-finite and negative values are ignored, never counted as zero. */
  add(rms: number): void {
    if (!Number.isFinite(rms) || rms < 0) return;
    if (rms > this.peak) this.peak = rms;
    this.sum += rms;
    this.n++;
    if (rms <= SILENCE_RMS) this.zeroN++;
  }

  /** How many samples this interval has so far. */
  get samples(): number {
    return this.n;
  }

  /** The summary WITHOUT resetting — for a reader that must not disturb another's interval. */
  peek(): LevelSummary | null {
    if (this.n === 0) return null;
    return {
      peak: this.peak,
      avg: this.sum / this.n,
      zero_ratio: this.zeroN / this.n,
    };
  }

  /** The summary, and start a fresh interval. NULL when nothing was measured. */
  take(): LevelSummary | null {
    const out = this.peek();
    this.reset();
    return out;
  }

  reset(): void {
    this.peak = 0;
    this.sum = 0;
    this.n = 0;
    this.zeroN = 0;
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
