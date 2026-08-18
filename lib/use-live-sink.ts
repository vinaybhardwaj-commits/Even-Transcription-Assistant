"use client";

/**
 * use-live-sink — Room Bench LIVE sink probe (Ambient Brain PRD §9, Kickoff B).
 *
 * Second consumer on the SAME getUserMedia stream the archive recorder owns:
 * a rolling ~250ms-timeslice MediaRecorder. This build is a go/no-go PROBE for
 * dual-consumer capture on Chrome-on-Mac — slices are logged/stubbed only:
 *
 *   - rolling in-memory window (last WINDOW_MS of slices, byte-capped);
 *   - per-session counters (slices, cadence, drops, stalls, archive seams,
 *     recorder errors per sink) surfaced on the kiosk debug line and logged to
 *     the console in a stable one-line JSON format for the bench orchestrator;
 *   - ≤1/min heartbeat cue (`type:"live_sink_stats"`, counters payload) via
 *     POST /api/bench/brain-proxy (room-cookie gated; the brain token never
 *     reaches the client). Its success/failure drives the kiosk listening-state
 *     chip: recording / brain unsure / brain down.
 *
 * NO STT, NO embeddings, NO Mini, NO raw audio leaves the browser.
 *
 * Archive is the P0 — the live sink is SACRIFICIAL. It stops itself (for the
 * rest of the day, logged) on: its own recorder error, an archive recorder
 * error, an archive chunk seam above SEAM_SACRIFICE_MS, or repeated slice
 * stalls. It never touches the archive recorder or the stream tracks.
 *
 * Only mounted when NEXT_PUBLIC_ETA_LIVE_SINK=1 (lib/live-flags LIVE_SINK).
 *
 * Console log lines (grep-stable):
 *   [live-sink] start      {"session_id","timeslice_ms","mime"}
 *   [live-sink] stop       {"reason", ...counters}
 *   [live-sink] stall      {"gap_ms","stalls"}
 *   [live-sink] error      {"sink":"live"|"archive","message"}
 *   [live-sink] seam       {"idx","seam_ms","stop_latency_ms"}
 *   [live-sink] stats      {...counters}            every STATS_LOG_MS
 *   [live-sink] heartbeat  {"ok","brain","brain_status","ms"}
 * (the archive hook itself logs `[bench-seam]` per rotation, flag on OR off)
 */

import * as React from "react";

export const LIVE_TIMESLICE_MS = 250;
const WINDOW_MS = 30_000; // rolling window kept in memory
const WINDOW_MAX_BYTES = 4 * 1024 * 1024;
const LATE_FACTOR = 2.5; // inter-slice gap > 2.5× timeslice counts as late
const STALL_MS = 3_000; // no slice for 3s while running = a stall episode
const STALL_HARD_MS = 10_000; // a single stall this long stops the sink
const STALL_MAX_EPISODES = 3; // this many stall episodes stops the sink
const SEAM_SACRIFICE_MS = 1_000; // archive seam above this stops the sink (D1 target <500ms)
const STATS_LOG_MS = 10_000;
const HEARTBEAT_MS = 60_000; // ≤1/min (binding)
const HEARTBEAT_TIMEOUT_MS = 5_000; // proxy itself caps the brain hop at 3s

export type LiveSinkState = "off" | "running" | "stopped";
export type BrainChip = "recording" | "unsure" | "down";

export type LiveSinkCounters = {
  state: LiveSinkState;
  stop_reason: string | null;
  session_id: string | null;
  timeslice_ms: number;
  mime: string | null;
  started_at: number | null;
  running_ms: number;
  // slices
  slices_received: number;
  slices_empty: number;
  slices_late: number;
  /** cadence-based estimate: sum over late gaps of round(gap/timeslice)-1 */
  slices_dropped_est: number;
  bytes_total: number;
  last_slice_bytes: number;
  last_slice_at: number | null;
  interval_ema_ms: number;
  interval_max_ms: number;
  window_slices: number;
  window_bytes: number;
  window_span_ms: number;
  // health
  stalls: number;
  live_recorder_errors: number;
  archive_recorder_errors: number;
  archive_seams: number;
  archive_seam_last_ms: number | null;
  archive_seam_max_ms: number | null;
  archive_stop_latency_last_ms: number | null;
  // heartbeat
  heartbeats_sent: number;
  heartbeats_ok: number;
  heartbeats_failed: number;
  heartbeat_last_at: number | null;
  heartbeat_last_ms: number | null;
  brain: BrainChip;
};

export type ArchiveSeam = { idx: number; seam_ms: number; stop_latency_ms: number };

type Slice = { t: number; size: number; blob: Blob };

function freshCounters(): LiveSinkCounters {
  return {
    state: "off",
    stop_reason: null,
    session_id: null,
    timeslice_ms: LIVE_TIMESLICE_MS,
    mime: null,
    started_at: null,
    running_ms: 0,
    slices_received: 0,
    slices_empty: 0,
    slices_late: 0,
    slices_dropped_est: 0,
    bytes_total: 0,
    last_slice_bytes: 0,
    last_slice_at: null,
    interval_ema_ms: 0,
    interval_max_ms: 0,
    window_slices: 0,
    window_bytes: 0,
    window_span_ms: 0,
    stalls: 0,
    live_recorder_errors: 0,
    archive_recorder_errors: 0,
    archive_seams: 0,
    archive_seam_last_ms: null,
    archive_seam_max_ms: null,
    archive_stop_latency_last_ms: null,
    heartbeats_sent: 0,
    heartbeats_ok: 0,
    heartbeats_failed: 0,
    heartbeat_last_at: null,
    heartbeat_last_ms: null,
    brain: "unsure",
  };
}

function log(event: string, data: Record<string, unknown>) {
  // One line, JSON payload — stable for the orchestrator to read off the console.
  try {
    console.info(`[live-sink] ${event}`, JSON.stringify(data));
  } catch {
    console.info(`[live-sink] ${event}`);
  }
}

/** Plain-data snapshot for the heartbeat payload / UI (never includes blobs). */
function snapshot(c: LiveSinkCounters, now: number): LiveSinkCounters {
  return {
    ...c,
    running_ms: c.state === "running" && c.started_at ? now - c.started_at : c.running_ms,
  };
}

export function useLiveSink(opts: {
  /** true only while the archive is actively recording (flag on) */
  enabled: boolean;
  getStream: () => MediaStream | null;
  sessionId: string | null;
  mimeType: string | undefined;
}) {
  const { enabled, getStream, sessionId, mimeType } = opts;

  const countersRef = React.useRef<LiveSinkCounters>(freshCounters());
  const [counters, setCounters] = React.useState<LiveSinkCounters>(countersRef.current);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const windowRef = React.useRef<Slice[]>([]);
  const inStallRef = React.useRef(false);
  const stoppedForDayRef = React.useRef(false); // sacrificed → stays down until a new day
  const sessionRef = React.useRef<string | null>(null);

  // A new session id (new day) resets the sacrifice latch + counters.
  React.useEffect(() => {
    if (sessionId && sessionId !== sessionRef.current) {
      sessionRef.current = sessionId;
      stoppedForDayRef.current = false;
      countersRef.current = { ...freshCounters(), session_id: sessionId };
      windowRef.current = [];
      setCounters(countersRef.current);
    }
  }, [sessionId]);

  const stopLiveRecorder = React.useCallback((reason: string) => {
    const c = countersRef.current;
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      try {
        rec.ondataavailable = null;
        rec.onerror = null;
        if (rec.state !== "inactive") rec.stop();
      } catch {
        /* noop — sacrificial */
      }
    }
    if (c.state === "running") {
      c.running_ms = c.started_at ? Date.now() - c.started_at : c.running_ms;
      c.state = "stopped";
      c.stop_reason = reason;
      log("stop", snapshot(c, Date.now()));
    }
  }, []);

  /** Sacrifice: stop for the rest of the day and remember why. */
  const sacrifice = React.useCallback(
    (reason: string) => {
      stoppedForDayRef.current = true;
      stopLiveRecorder(reason);
      countersRef.current.state = "stopped";
      countersRef.current.stop_reason = reason;
    },
    [stopLiveRecorder],
  );

  // ---- archive-side signals (wired by the kiosk from use-room-recorder) ----
  const reportArchiveSeam = React.useCallback(
    (s: ArchiveSeam) => {
      const c = countersRef.current;
      c.archive_seams += 1;
      c.archive_seam_last_ms = s.seam_ms;
      c.archive_seam_max_ms = Math.max(c.archive_seam_max_ms ?? 0, s.seam_ms);
      c.archive_stop_latency_last_ms = s.stop_latency_ms;
      log("seam", { idx: s.idx, seam_ms: s.seam_ms, stop_latency_ms: s.stop_latency_ms, live_state: c.state });
      if (c.state === "running" && s.seam_ms > SEAM_SACRIFICE_MS) {
        sacrifice(`archive_seam_exceeded_${s.seam_ms}ms`);
      }
    },
    [sacrifice],
  );

  const reportArchiveError = React.useCallback(
    (message: string) => {
      const c = countersRef.current;
      c.archive_recorder_errors += 1;
      log("error", { sink: "archive", message });
      if (c.state === "running") sacrifice("archive_recorder_error");
    },
    [sacrifice],
  );

  // ---- live recorder lifecycle: follows `enabled` (archive state === recording) ----
  React.useEffect(() => {
    if (!enabled) {
      stopLiveRecorder("disabled");
      return;
    }
    if (stoppedForDayRef.current) return; // sacrificed earlier today — stay down
    const stream = getStream();
    if (!stream) return;
    if (typeof MediaRecorder === "undefined") return;

    const c = countersRef.current;
    let rec: MediaRecorder;
    try {
      rec =
        mimeType && MediaRecorder.isTypeSupported(mimeType)
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
    } catch (e) {
      c.live_recorder_errors += 1;
      log("error", { sink: "live", message: `construct_failed:${String((e as Error)?.message ?? e)}` });
      sacrifice("live_recorder_construct_failed");
      return;
    }
    recRef.current = rec;
    c.mime = rec.mimeType || mimeType || null;
    c.state = "running";
    c.stop_reason = null;
    c.started_at = Date.now();
    c.last_slice_at = null;
    inStallRef.current = false;

    rec.ondataavailable = (e: BlobEvent) => {
      if (recRef.current !== rec) return;
      const now = Date.now();
      const size = e.data?.size ?? 0;
      if (size === 0) {
        c.slices_empty += 1;
        return;
      }
      if (c.last_slice_at !== null) {
        const gap = now - c.last_slice_at;
        c.interval_ema_ms = c.interval_ema_ms === 0 ? gap : c.interval_ema_ms * 0.8 + gap * 0.2;
        if (gap > c.interval_max_ms) c.interval_max_ms = gap;
        if (gap > LATE_FACTOR * LIVE_TIMESLICE_MS) {
          c.slices_late += 1;
          c.slices_dropped_est += Math.max(0, Math.round(gap / LIVE_TIMESLICE_MS) - 1);
        }
      }
      c.last_slice_at = now;
      c.slices_received += 1;
      c.bytes_total += size;
      c.last_slice_bytes = size;
      // rolling window — bounded by time and bytes; oldest evicted (not "drops")
      const w = windowRef.current;
      w.push({ t: now, size, blob: e.data });
      let bytes = c.window_bytes + size;
      while (w.length && (now - w[0]!.t > WINDOW_MS || bytes > WINDOW_MAX_BYTES)) {
        bytes -= w.shift()!.size;
      }
      c.window_bytes = bytes;
      c.window_slices = w.length;
      c.window_span_ms = w.length ? now - w[0]!.t : 0;
    };
    rec.onerror = (ev: Event) => {
      if (recRef.current !== rec) return;
      const msg =
        (ev as unknown as { error?: { message?: string } }).error?.message ?? "recorder_error";
      c.live_recorder_errors += 1;
      log("error", { sink: "live", message: msg });
      sacrifice("live_recorder_error");
    };

    try {
      rec.start(LIVE_TIMESLICE_MS);
    } catch (e) {
      c.live_recorder_errors += 1;
      log("error", { sink: "live", message: `start_failed:${String((e as Error)?.message ?? e)}` });
      sacrifice("live_recorder_start_failed");
      return;
    }
    log("start", { session_id: c.session_id, timeslice_ms: LIVE_TIMESLICE_MS, mime: c.mime });

    // Stall watchdog + UI tick (1s) + periodic stats line.
    let lastStatsAt = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      if (c.state === "running") {
        const since = now - (c.last_slice_at ?? c.started_at ?? now);
        if (since > STALL_MS) {
          if (!inStallRef.current) {
            inStallRef.current = true;
            c.stalls += 1;
            log("stall", { gap_ms: since, stalls: c.stalls });
            if (c.stalls >= STALL_MAX_EPISODES) sacrifice(`live_starved_${c.stalls}_stalls`);
          } else if (since > STALL_HARD_MS) {
            sacrifice(`live_starved_${since}ms`);
          }
        } else {
          inStallRef.current = false;
        }
      }
      if (now - lastStatsAt >= STATS_LOG_MS) {
        lastStatsAt = now;
        log("stats", snapshot(c, now));
      }
      setCounters(snapshot(c, now));
    }, 1000);

    return () => {
      clearInterval(tick);
      stopLiveRecorder("disabled");
      setCounters(snapshot(countersRef.current, Date.now()));
    };
    // mimeType is read once at construct; the archive picks it once per day too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, getStream, sacrifice, stopLiveRecorder]);

  // ---- heartbeat (≤1/min) while enabled; drives the listening-state chip ----
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const beat = async () => {
      const c = countersRef.current;
      const t0 = Date.now();
      c.heartbeats_sent += 1;
      let brain: BrainChip = "down";
      let ok = false;
      let brainStatus: number | null = null;
      let extra: Record<string, unknown> = {};
      try {
        const res = await fetch("/api/bench/brain-proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "live_sink_stats", payload: snapshot(c, t0) }),
          signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
        });
        const j = (await res.json().catch(() => null)) as
          | { ok?: boolean; brain?: string; brain_status?: number | null; throttled?: boolean; reason?: string }
          | null;
        if (res.ok && j?.throttled) return; // another beat landed recently — keep last chip
        ok = res.ok && j?.ok === true;
        brainStatus = typeof j?.brain_status === "number" ? j.brain_status : null;
        brain = ok ? "recording" : j?.brain === "unsure" ? "unsure" : "down";
        extra = { reason: j?.reason ?? null };
      } catch (e) {
        brain = "down";
        extra = { reason: (e as Error)?.name === "TimeoutError" ? "proxy_timeout" : "proxy_unreachable" };
      }
      if (cancelled) return;
      const ms = Date.now() - t0;
      if (ok) c.heartbeats_ok += 1;
      else c.heartbeats_failed += 1;
      c.heartbeat_last_at = Date.now();
      c.heartbeat_last_ms = ms;
      c.brain = brain;
      log("heartbeat", { ok, brain, brain_status: brainStatus, ms, ...extra });
      setCounters(snapshot(c, Date.now()));
    };
    void beat();
    const t = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled]);

  return { counters, reportArchiveSeam, reportArchiveError };
}
