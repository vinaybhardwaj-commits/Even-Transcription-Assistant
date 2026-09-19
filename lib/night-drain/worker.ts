/**
 * lib/night-drain/worker.ts — the loop. Everything with an effect is injected, so a test drives it with a fake
 * clock, a fake queue and fake audio, and the real thing is wired in main.ts.
 *
 * WHAT THE LOOP GUARANTEES
 *   - runs only in closed hours, and starts nothing in the last START_BUFFER_MS of them;
 *   - starts a window only when the watchdog's last line says GO (fail closed, see pressure.ts);
 *   - takes a per-window lease in one statement before touching a window (store.claimNext);
 *   - ends every window in exactly one Outcome kind, and the switch below cannot be made to skip one;
 *   - releases the lease on every exit, or PARKS it when the window was deferred;
 *   - stops, at closed hours' end, between windows — or abandons the window in flight, writing nothing.
 */
import { abandonAtMs, isClosed, mayStartWindow, msUntilClose, msUntilOpenForWork, nightOf } from "./hours";
import type { GateDecision } from "./pressure";
import { assertNever, type FailedCode, type FatalCode, type Outcome } from "./outcome";
import { PARK_SECONDS, WINDOW_HARD_CAP_MS, type ClaimedWindow, type Remaining } from "./store";
import type { AudioFailure, RangeChunk, WindowAudio } from "./audio";

export type LogValue = string | number | boolean | null;
/** Counts, ids, codes and timings only. There is deliberately no field for free text. */
export type LogRecord = { event: string } & Record<string, LogValue>;

export type Mode = "run" | "dry-run" | "audio-only";

export type StageCtx = { signal: AbortSignal; phases: { mcp_ms: number | null; download_ms: number | null; join_ms: number | null } };

export type Deps = {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  gate(): GateDecision;
  serviceHealth(): Promise<{ ok: boolean; device: string | null }>;
  store: {
    claimNext(holder: string): Promise<ClaimedWindow | null>;
    release(windowId: string, holder: string): Promise<boolean>;
    park(windowId: string, holder: string, seconds: number): Promise<boolean>;
    remaining(): Promise<Remaining>;
    chunksForSession(sessionId: string): Promise<RangeChunk[]>;
    peek(limit: number): Promise<ClaimedWindow[]>;
  };
  audio(w: ClaimedWindow, chunks: RangeChunk[], signal: AbortSignal): Promise<WindowAudio | AudioFailure>;
  /** Diarize + write the terminal row (run), or diarize only (dry-run). Never throws: every ending is an Outcome. */
  diarize(w: ClaimedWindow, a: WindowAudio, ctx: StageCtx, mode: Mode, device: string | null): Promise<{ outcome: Outcome; diarize_ms: number | null }>;
  /** Write a `failed` row for a window-specific failure. Never throws. */
  recordFailed(w: ClaimedWindow, code: FailedCode, ctx: StageCtx, device: string | null): Promise<Outcome>;
  log(rec: LogRecord): void;
  holder: string;
};

export type Summary = {
  night: string;
  started: number;
  ok: number;
  no_speakers: number;
  failed: number;
  deferred: number;
  abandoned: number;
  wall_s_total: number;
  fatal: FatalCode | null;
};

const newSummary = (night: string): Summary => ({ night, started: 0, ok: 0, no_speakers: 0, failed: 0, deferred: 0, abandoned: 0, wall_s_total: 0, fatal: null });

const REMAINING_EVERY = 25;
const IDLE_MS = 300_000;
const GATE_POLL_MS = 20_000;
const SERVICE_POLL_MS = 30_000;
const DEFER_CIRCUIT = 5;

/** Turn an audio-stage failure into what the worker does next. An abandonment's REASON is resolved once, in processClaimed. */
async function audioFailureOutcome(deps: Deps, w: ClaimedWindow, f: AudioFailure, ctx: StageCtx, device: string | null): Promise<Outcome> {
  switch (f.kind) {
    case "failed": return deps.recordFailed(w, f.code, ctx, device);
    case "deferred": return { kind: "deferred", code: f.code };
    case "fatal": return { kind: "fatal", code: f.code };
    case "abandoned": return { kind: "abandoned", code: "stopped" };
    default: return assertNever(f);
  }
}

/**
 * ONE window, from claim to a logged ending. Returns the Outcome. The lease is released or parked in `finally`,
 * so no path — a throw included — leaves a live lease behind.
 */
async function processClaimed(deps: Deps, w: ClaimedWindow, mode: Mode, signal: AbortSignal, device: string | null): Promise<Outcome> {
  const t0 = deps.now();
  const cap = new AbortController();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  timers.push(setTimeout(() => cap.abort("hard_cap"), WINDOW_HARD_CAP_MS));
  if (isClosed(t0)) timers.push(setTimeout(() => cap.abort("closed_hours_ended"), Math.max(0, abandonAtMs(t0) - t0)));
  const sig = AbortSignal.any([signal, cap.signal]);
  const stopReason = (): "closed_hours_ended" | "stopped" | "hard_cap" => (signal.aborted ? "stopped" : cap.signal.reason === "hard_cap" ? "hard_cap" : "closed_hours_ended");
  const ctx: StageCtx = { signal: sig, phases: { mcp_ms: null, download_ms: null, join_ms: null } };

  let outcome: Outcome;
  let diarizeMs: number | null = null;
  let segments: number | null = null;
  let speakers: number | null = null;
  let audioSeconds: number | null = null;
  try {
    const chunks = await deps.store.chunksForSession(w.session_id);
    const a = await deps.audio(w, chunks, sig);
    if (!a.ok) {
      outcome = await audioFailureOutcome(deps, w, a, ctx, device);
    } else {
      ctx.phases = { mcp_ms: a.mcp_ms, download_ms: a.download_ms, join_ms: a.join_ms };
      audioSeconds = Math.round(a.seconds * 10) / 10;
      if (mode === "audio-only") {
        outcome = { kind: "recorded", state: "ok", speakers: 0, segments: 0 };
      } else {
        const r = await deps.diarize(w, a, ctx, mode, device);
        diarizeMs = r.diarize_ms;
        outcome = r.outcome;
      }
    }
  } catch (e) {
    console.warn(`[night-drain] window ${w.id}: ${(e as Error)?.name ?? "error"} while reading (deferred)`);
    outcome = { kind: "deferred", code: "db_error" };
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  // ONE place decides why a window was cut off. The hard cap is a recorded failure (a window that eats its whole
  // cap is failing, and an unrecorded one would loop for ever); the end of closed hours and a stop are not.
  if (outcome.kind === "abandoned") {
    const why = stopReason();
    outcome = why === "hard_cap" ? await deps.recordFailed(w, "hard_cap", ctx, device) : { kind: "abandoned", code: why };
  }
  if (outcome.kind === "recorded" && outcome.state !== "failed") { segments = outcome.segments; speakers = outcome.speakers; }

  // The lease: parked for a deferral, released for everything else. `audio-only` and `dry-run` took none.
  if (mode === "run") {
    try {
      if (outcome.kind === "deferred") await deps.store.park(w.id, deps.holder, PARK_SECONDS);
      else await deps.store.release(w.id, deps.holder);
    } catch (e) {
      console.warn(`[night-drain] window ${w.id}: lease ${outcome.kind === "deferred" ? "park" : "release"} failed (${(e as Error)?.name ?? "error"}); it expires by itself`);
    }
  }

  const ended =
    outcome.kind === "recorded" ? (outcome.state === "failed" ? `failed:${outcome.code}` : outcome.state)
    : `${outcome.kind}:${outcome.code}`;
  // `dry-run` and `audio-only` write no row, so their endings are marked and cannot be mistaken for a recording.
  const terminal = mode === "run" ? ended : mode === "audio-only" && outcome.kind === "recorded" && outcome.state === "ok" ? "audio_only_ok" : `${mode}:${ended}`;
  deps.log({
    event: "window", window_id: w.id, wall_s: Math.round((deps.now() - t0) / 100) / 10,
    segments, speakers, terminal_state: terminal, retry: w.is_retry, mode,
    audio_s: audioSeconds, mcp_ms: ctx.phases.mcp_ms, download_ms: ctx.phases.download_ms, join_ms: ctx.phases.join_ms, diarize_ms: diarizeMs,
  });
  return outcome;
}

function tally(s: Summary, o: Outcome): void {
  switch (o.kind) {
    case "recorded": if (o.state === "ok") s.ok += 1; else if (o.state === "no_speakers") s.no_speakers += 1; else s.failed += 1; return;
    case "deferred": s.deferred += 1; return;
    case "abandoned": s.abandoned += 1; return;
    case "fatal": s.fatal = o.code; return;
    default: return assertNever(o);
  }
}

/** One closed period. Returns when closed hours end (or nearly), when aborted, or on a fatal outcome. */
export async function runNight(deps: Deps, signal: AbortSignal): Promise<Summary> {
  const s = newSummary(nightOf(deps.now()));
  const startRem = await deps.store.remaining().catch((e: unknown) => {
    deps.log({ event: "remaining_failed", error: (e as Error)?.name ?? "error" });
    return null;
  });
  deps.log({ event: "night_start", night: s.night, ...(startRem ?? {}) });

  let lastGate = "";
  let consecutiveDeferred = 0;
  let idleClaims = 0;
  while (!signal.aborted) {
    const now = deps.now();
    if (!mayStartWindow(now)) break;                     // the night is over: stop BETWEEN windows

    const g = deps.gate();
    if (!g.go) {
      if (g.reason !== lastGate) deps.log({ event: "gate_hold", reason: g.reason });
      lastGate = g.reason;
      await deps.sleep(Math.min(GATE_POLL_MS, msUntilClose(now)), signal);
      continue;
    }
    if (lastGate) deps.log({ event: "gate_go", after: lastGate });
    lastGate = "";

    const h = await deps.serviceHealth();
    if (!h.ok) {
      deps.log({ event: "service_down" });
      await deps.sleep(SERVICE_POLL_MS, signal);
      continue;
    }

    let w: ClaimedWindow | null;
    try {
      w = await deps.store.claimNext(deps.holder);
    } catch (e) {
      deps.log({ event: "claim_failed", code: "db_error", error: (e as Error)?.name ?? "error" });
      await deps.sleep(SERVICE_POLL_MS, signal);
      continue;
    }
    if (!w) {
      // Nothing claimable: either the queue is empty or another copy won the race. Look again shortly, then idle.
      idleClaims += 1;
      if (idleClaims === 1) deps.log({ event: "queue_idle" });
      await deps.sleep(idleClaims <= 3 ? 3_000 : IDLE_MS, signal);
      continue;
    }
    idleClaims = 0;

    s.started += 1;
    const t0 = deps.now();
    const outcome = await processClaimed(deps, w, "run", signal, h.device);
    s.wall_s_total += Math.round((deps.now() - t0) / 100) / 10;
    tally(s, outcome);

    if (outcome.kind === "fatal") {
      deps.log({ event: "fatal", code: outcome.code });
      break;
    }
    if (outcome.kind === "deferred") {
      consecutiveDeferred += 1;
      if (consecutiveDeferred >= DEFER_CIRCUIT) {
        deps.log({ event: "circuit_open", consecutive_deferred: consecutiveDeferred, pause_s: IDLE_MS / 1000 });
        await deps.sleep(IDLE_MS, signal);
        consecutiveDeferred = 0;
      }
    } else {
      consecutiveDeferred = 0;
    }
    if (s.started % REMAINING_EVERY === 0) {
      const r = await deps.store.remaining().catch(() => null);
      if (r) deps.log({ event: "remaining", night: s.night, processed: s.started, ...r });
    }
  }

  const endRem = await deps.store.remaining().catch(() => null);
  deps.log({
    event: "night_end", night: s.night, started: s.started, ok: s.ok, no_speakers: s.no_speakers, failed: s.failed,
    deferred: s.deferred, abandoned: s.abandoned, wall_s_total: Math.round(s.wall_s_total),
    fatal: s.fatal, ...(endRem ?? {}),
    ...(startRem && endRem ? { net_never_handled: startRem.never_handled - endRem.never_handled } : {}),
  });
  return s;
}

/**
 * The long-lived loop: idle outside closed hours, drain inside them, until stopped or fatal. It enters a night only
 * when a window could actually START, so the last four minutes of closed hours (and all of the day) are one quiet
 * sleep, not a stream of empty night_start / night_end pairs.
 */
export async function serve(deps: Deps, signal: AbortSignal): Promise<{ fatal: FatalCode | null }> {
  while (!signal.aborted) {
    const now = deps.now();
    if (!mayStartWindow(now)) {
      const wait = isClosed(now) ? msUntilClose(now) + 1_000 : msUntilOpenForWork(now);
      await deps.sleep(Math.min(60_000, Math.max(1_000, wait)), signal);
      continue;
    }
    const r = await runNight(deps, signal);
    if (r.fatal) return { fatal: r.fatal };
  }
  return { fatal: null };
}

/**
 * The measuring modes. `audio-only` fetches and joins the next `limit` windows and NOTHING else: no lease, no
 * diarize call, no write, any time of day — it is light. `dry-run` also diarizes them, so it is closed hours + the
 * gate, like the real thing, and still writes nothing.
 */
export async function runBatch(deps: Deps, mode: "audio-only" | "dry-run", limit: number, signal: AbortSignal): Promise<Summary> {
  const s = newSummary(nightOf(deps.now()));
  const list = await deps.store.peek(limit);
  deps.log({ event: "batch_start", mode, windows: list.length });
  let device: string | null = null;
  if (mode === "dry-run") device = (await deps.serviceHealth()).device;
  for (const w of list) {
    if (signal.aborted) break;
    if (mode === "dry-run") {
      const now = deps.now();
      const g = deps.gate();
      if (!mayStartWindow(now) || !g.go) { deps.log({ event: "batch_stopped", reason: !mayStartWindow(now) ? "not_closed_hours" : g.reason }); break; }
    }
    s.started += 1;
    tally(s, await processClaimed(deps, w, mode, signal, device));
    if (s.fatal) { deps.log({ event: "fatal", code: s.fatal }); break; }   // a refused credential stops the batch at the first window
  }
  deps.log({ event: "batch_end", mode, started: s.started, ok: s.ok, failed: s.failed, deferred: s.deferred, abandoned: s.abandoned });
  return s;
}
