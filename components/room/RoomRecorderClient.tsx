"use client";

/**
 * RoomRecorderClient — Room Bench kiosk surface (Room-Bench PRD §3.3;
 * binding mockup screens 1–3).
 *
 * Start-of-day: session label, mic picker + live level check, IRB notice.
 * Recording: big elapsed timer, chunk-in-progress line, archived/queued/
 * stored stats, last-verified row, Pause + End day.
 * Paused: greyed timer, "nothing is being recorded", Resume.
 * Warnings: offline/retry (recording continues), mic lost, storage blocked.
 * End day blocks with a spinner until the final chunk is verified (D8),
 * then flips the session to `ended`.
 *
 * Capture + upload only — no transcription, no vendor connections.
 *
 * Kickoff B (Ambient Brain PRD §9), behind NEXT_PUBLIC_ETA_LIVE_SINK only: the
 * live-sink probe mounts as a child (second MediaRecorder on the same stream,
 * logged/stubbed slices, ≤1/min heartbeat via /api/bench/brain-proxy), and the
 * kiosk gains the listening-state chip (recording / brain unsure / brain down)
 * plus a counters debug line. Flag off = nothing mounts, UI byte-identical.
 * Start-of-day notice copy is unchanged (consent copy is not this build's).
 *
 * Kickoff K-B — dual-mic: a second "Backup microphone" picker on the start screen
 * (persisted in the kiosk's IndexedDB settings; default = the built-in mic), the hook
 * records both lanes in lockstep, and the primary failsafe surfaces here: a big
 * persistent "ON BACKUP MIC" banner while the USB mic is lost/silent, a backup status
 * line, and mic-story events posted to /api/bench/events (durable-first, kiosk source).
 *
 * Operator MCP S2 (branch feat/operator-mcp): the kiosk is also an operator LISTENER —
 * lib/use-command-poll polls GET /api/bench/commands (1.5 s) whenever the page is signed in
 * and runs the SAME start / pause / resume / end flows the buttons run (startDayFlow,
 * onPause, onResume, endDayFlow — no second recorder). Remote actions and link state show
 * on the "Operator" chip under the day pill. Fail-open: bus down = chip only, buttons work.
 *
 * Remount resume (ETA-REMOUNT-RESUME PRD v1.0, MCP PRD §8.5 rev 3e): on mount, before the
 * start screen renders, the kiosk asks GET /api/bench/sessions/active whether this room has
 * a session to rejoin — the SERVER decides. Resumable → resumeSession (chunk counters seeded
 * from the server + the local unsent queue, D2), the D6 banner, and one durable
 * kiosk_remount_resumed gap event (D4). Not resumable, or any fault → the start screen,
 * exactly as before. A superseded tab (D3) stops recording, flushes + uploads its segment,
 * shows the takeover message, and never PATCHes end.
 */

import * as React from "react";
import {
  useRoomRecorder,
  loadBenchSetting,
  saveBenchSetting,
  pickDefaultBackupDevice,
  BACKUP_DEVICE_SETTING,
  PRIMARY_DEVICE_SETTING,
  type ArchiveSeamEvent,
  type BenchMicEvent,
} from "@/lib/use-room-recorder";
// S3-2: the pure constants module — never bench-commands, whose module graph carries the
// database driver and has no business in a kiosk bundle.
import { ACK_POLL_MS } from "@/lib/bench-bus-constants";
import { decideHandoverWait } from "@/lib/bench-resume-core";
import { LIVE_SINK } from "@/lib/live-flags";
import { useLiveSink, type LiveSinkCounters } from "@/lib/use-live-sink";
import { useCommandPoll, type CommandActions } from "@/lib/use-command-poll";

type Props = { slug: string; roomName: string };

const MARK_LATCH_MS = 15_000; // C5
const MARK_TIMEOUT_MS = 10_000; // proxy caps its brain hop at 3s; DB write on top

/** IST wall clock HH:MM for the "Marked HH:MM" latch label. */
function fmtIstHm(t: number): string {
  return new Date(t).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type LiveHandlers = {
  onSeam?: (s: ArchiveSeamEvent) => void;
  onRecorderError?: (message: string) => void;
};

/**
 * Mounted ONLY when LIVE_SINK is on. Runs the live sink hook, hands the
 * archive-side callbacks up through `handlersRef`, and lifts counters to the
 * kiosk (which renders the chip + debug line). Renders nothing itself.
 */
function LiveSinkProbe(props: {
  active: boolean;
  sessionId: string | null;
  mimeType: string | undefined;
  getStream: () => MediaStream | null;
  handlersRef: React.MutableRefObject<LiveHandlers>;
  onCounters: (c: LiveSinkCounters) => void;
}) {
  const { active, sessionId, mimeType, getStream, handlersRef, onCounters } = props;
  const { counters, reportArchiveSeam, reportArchiveError } = useLiveSink({
    enabled: active,
    getStream,
    sessionId,
    mimeType,
  });
  React.useEffect(() => {
    handlersRef.current = { onSeam: reportArchiveSeam, onRecorderError: reportArchiveError };
    return () => {
      handlersRef.current = {};
    };
  }, [handlersRef, reportArchiveSeam, reportArchiveError]);
  React.useEffect(() => {
    onCounters(counters);
  }, [counters, onCounters]);
  return null;
}

function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function fmtMinSec(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function fmtTimeOfDay(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function RoomRecorderClient({ slug, roomName }: Props) {
  // Kickoff B: archive-side signals reach the live sink through this ref; with the
  // flag off nothing ever assigns it, so the callbacks are no-ops.
  const liveHandlersRef = React.useRef<LiveHandlers>({});
  // K-B: mic-story events → POST /api/bench/events (durable-first; fail-silent here).
  const sessionIdForEventsRef = React.useRef<string | null>(null);
  const postMicEvent = React.useCallback((e: BenchMicEvent) => {
    void fetch("/api/bench/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: e.kind,
        at: new Date(e.at).toISOString(),
        session_id: sessionIdForEventsRef.current,
        payload: e.payload,
      }),
      keepalive: true,
    }).catch(() => {
      /* the console line from the hook is the fallback record */
    });
  }, []);
  const recorderOpts = React.useMemo(
    () => ({
      onSeam: (s: ArchiveSeamEvent) => liveHandlersRef.current.onSeam?.(s),
      onRecorderError: (m: string) => liveHandlersRef.current.onRecorderError?.(m),
      onEvent: postMicEvent,
    }),
    [postMicEvent],
  );
  const { status, startDay, resumeSession, pauseDay, resumeDay, endDay, markEnded, getStream } =
    useRoomRecorder(recorderOpts);
  const [live, setLive] = React.useState<LiveSinkCounters | null>(null);

  const [label, setLabel] = React.useState("");
  const [mics, setMics] = React.useState<Array<{ deviceId: string; label: string }>>([]);
  const [micId, setMicId] = React.useState<string>("");
  // K-B: backup (second) microphone — persisted choice; "" = none
  const [backupMicId, setBackupMicId] = React.useState<string>("");
  const backupChoiceLoadedRef = React.useRef(false);
  const [micLevel, setMicLevel] = React.useState(0); // 0..1 rolling
  const [speechSeen, setSpeechSeen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [endingUpload, setEndingUpload] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  // Remount resume: hold the start screen until the server has answered (§3.1);
  // `resumed` drives the D6 banner; `takenOver` is the D3 superseded-tab message.
  // FU2: the operator poll starts only after the first /active look (`pollEnabled`), so
  // this tab's own poll cannot overwrite the listener row before handover_pending reads it;
  // `handingOver` shows the short wait line.
  const [boot, setBoot] = React.useState<"checking" | "ready">("checking");
  const [resumed, setResumed] = React.useState<null | { status: "recording" | "paused" }>(null);
  const [takenOver, setTakenOver] = React.useState(false);
  const [pollEnabled, setPollEnabled] = React.useState(false);
  const [handingOver, setHandingOver] = React.useState(false);
  const operatorTabIdRef = React.useRef("");

  const meterStreamRef = React.useRef<MediaStream | null>(null);
  const meterCtxRef = React.useRef<AudioContext | null>(null);
  const meterRafRef = React.useRef<number>(0);

  const idle = status.state === "idle" || status.state === "error";

  // ---- mic enumeration + live level meter (start screen only) ----
  React.useEffect(() => {
    if (!idle) return;
    let cancelled = false;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micId ? { deviceId: { exact: micId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        meterStreamRef.current = stream;
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) {
          const inputs = devices
            .filter((d) => d.kind === "audioinput")
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
          setMics(inputs);
          // K-B: backup mic = persisted choice if still present, else the built-in mic.
          if (!backupChoiceLoadedRef.current) {
            backupChoiceLoadedRef.current = true;
            const saved = await loadBenchSetting<string>(BACKUP_DEVICE_SETTING);
            const primary = micId || inputs[0]?.deviceId || null;
            const pick =
              saved && inputs.some((d) => d.deviceId === saved) && saved !== primary
                ? saved
                : pickDefaultBackupDevice(inputs, primary);
            if (!cancelled) setBackupMicId(pick ?? "");
          }
        }
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        meterCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const loop = () => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i]! - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setMicLevel((prev) => prev * 0.7 + rms * 0.3);
          if (rms > 0.02) setSpeechSeen(true);
          meterRafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch {
        // No permission yet / no device — the Start button will surface it.
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(meterRafRef.current);
      try {
        meterStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {
        /* noop */
      }
      meterStreamRef.current = null;
      void meterCtxRef.current?.close().catch(() => undefined);
      meterCtxRef.current = null;
    };
  }, [idle, micId]);

  const micLabelText = React.useMemo(() => {
    const found = mics.find((m) => m.deviceId === micId);
    return found?.label ?? mics[0]?.label ?? "Default microphone";
  }, [mics, micId]);

  // ---- start of day ----
  // Shared by the button (onStart) and the operator listener (start_day): create the
  // bench_session row, free the meter stream, start the recorder. Throws on failure.
  const startDayFlow = React.useCallback(async (): Promise<{ session_id: string }> => {
    const res = await fetch("/api/bench/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: label.trim() || null,
        mic_label: micLabelText,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error(j?.error?.message ?? `session_create_failed_${res.status}`);
    }
    const j = (await res.json()) as { session?: { id?: string } };
    const sid = j.session?.id;
    if (!sid) throw new Error("session_create_malformed");
    setSessionId(sid);
    // Free the meter stream before the recorder opens the device.
    try {
      meterStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    sessionIdForEventsRef.current = sid; // K-B: mic-story events carry the session
    await startDay(sid, micId || undefined, backupMicId || null); // K-B: backup lane
    return { session_id: sid };
  }, [label, micLabelText, micId, backupMicId, startDay]);

  const onStart = React.useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      await startDayFlow();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [startDayFlow]);

  // ---- Remount resume (ETA-REMOUNT-RESUME §3.1 + addendum 2): ask the server ONCE, on
  // mount, whether this room has a session to rejoin — before the start screen renders.
  // The server decides (GET /api/bench/sessions/active → decideResume); the kiosk only
  // obeys. FU2: when a LIVE tab still holds the room (handover_pending) the kiosk waits —
  // bounded by ACK_WAIT_MS — for that tab's kiosk_handover_complete event, then takes its
  // numbers from a FRESH answer, so two tabs are never issued the same chunk number.
  // Any fault, here or there, degrades to the start screen: today's behaviour.
  const bootRanRef = React.useRef(false);
  React.useEffect(() => {
    if (bootRanRef.current) return;
    bootRanRef.current = true;
    type ActiveAnswer = {
      ok?: boolean;
      resumable?: boolean;
      session?: {
        id?: string;
        status?: string;
        started_at?: string;
        last_any_chunk_at?: string | null;
      } | null;
      next_idx?: { primary?: number; backup?: number } | null;
      handover_pending?: boolean;
      handover_started?: boolean | null;
      handover_complete?: boolean | null;
    };
    const getActive = async (since?: string): Promise<ActiveAnswer | null> => {
      const qs = new URLSearchParams();
      if (operatorTabIdRef.current) qs.set("tab_id", operatorTabIdRef.current);
      if (since) qs.set("since", since);
      const res = await fetch(`/api/bench/sessions/active?${qs.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      const j = (await res.json().catch(() => null)) as ActiveAnswer | null;
      return res.ok ? j : null;
    };
    void (async () => {
      let rejoining = false;
      try {
        let first: ActiveAnswer | null = null;
        try {
          first = await getActive();
        } catch {
          first = null;
        }
        // The operator listener starts only AFTER the first look at the listener row —
        // this tab's own poll would otherwise overwrite the row before handover_pending
        // could see the tab being displaced.
        setPollEnabled(true);
        if (!first?.ok || !first.resumable || !first.session) return;
        let s = first.session;
        let next = first.next_idx;
        const sid = s.id;
        if (!sid || (s.status !== "recording" && s.status !== "paused")) return;

        // FU2c + S3-1c — ordered handover, proof of life not freshness: probe for the losing
        // tab's kiosk_handover_started announce (a dead tab never announces — start at once,
        // no timeout recorded), then wait for its kiosk_handover_complete, then re-read.
        let handoverTimedOut = false;
        if (first.handover_pending === true) {
          setHandingOver(true);
          const since = new Date().toISOString();
          let stageT0 = Date.now(); // stage clock: reset when the announce is first seen
          let startedSeen = false;
          for (;;) {
            let complete = false;
            try {
              const p = await getActive(since);
              if (p?.handover_started === true && !startedSeen) {
                startedSeen = true;
                stageT0 = Date.now(); // stage two begins — the ack window runs from here
              }
              complete = p?.handover_complete === true;
            } catch {
              complete = false;
            }
            const d = decideHandoverWait({
              handoverPending: true,
              handoverStarted: startedSeen,
              handoverComplete: complete,
              waitedMs: Date.now() - stageT0,
            });
            if (d === "start") break;
            if (d === "timeout_start") {
              handoverTimedOut = true;
              break;
            }
            await new Promise((r) => setTimeout(r, ACK_POLL_MS));
          }
          setHandingOver(false);
          try {
            const fresh = await getActive();
            if (fresh?.ok && fresh.resumable === false) return; // no longer rejoinable — start screen
            if (fresh?.ok && fresh.resumable && fresh.session?.id === sid) {
              s = fresh.session;
              next = fresh.next_idx;
            }
          } catch {
            /* keep the first answer — the seeded counters still protect stored audio */
          }
        }
        const finalStatus: "recording" | "paused" = s.status === "paused" ? "paused" : "recording";

        // FU3 + S3-3 — the room's chosen primary mic, asked directly: the hook opens the
        // stored id and, if it does not open, falls back to the default and writes the
        // mic_primary_lost(device_missing_on_resume) event itself. No enumeration — a
        // device that opens is present, a device that does not open is absent.
        const storedPrimary = await loadBenchSetting<string>(PRIMARY_DEVICE_SETTING);
        const storedBackup = await loadBenchSetting<string>(BACKUP_DEVICE_SETTING);

        const startedMs = s.started_at ? Date.parse(s.started_at) : NaN;
        const lastAudioIso = s.last_any_chunk_at ?? s.started_at ?? null;
        const lastAudioMs = lastAudioIso ? Date.parse(lastAudioIso) : NaN;
        setSessionId(sid);
        sessionIdForEventsRef.current = sid; // mic-story events during the rejoin carry the session
        rejoining = true;
        const seeded = await resumeSession(sid, {
          nextPrimaryIdx: next?.primary ?? 0,
          nextBackupIdx: next?.backup ?? 0,
          paused: finalStatus === "paused",
          dayStartedAt: Number.isFinite(startedMs) ? startedMs : null,
          deviceId: storedPrimary || undefined,
          backupDeviceId: storedBackup || null,
        });
        setResumed({ status: finalStatus });
        // §3.4 gap record — fire-and-forget: a lost record must not disturb the rejoin.
        const silenceSeconds = Number.isFinite(lastAudioMs)
          ? Math.max(0, Math.round((Date.now() - lastAudioMs) / 1000))
          : 0;
        void fetch("/api/bench/sessions/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "kiosk_remount_resumed",
            session_id: sid,
            silence_seconds: silenceSeconds,
            next_idx: { primary: seeded.primaryStartIdx, backup: seeded.backupStartIdx },
            ...(handoverTimedOut ? { handover_timed_out: true } : {}),
          }),
          keepalive: true,
        }).catch(() => undefined);
      } catch (e) {
        // A failed rejoin (e.g. mic permission) surfaces like a failed Start; a failed
        // lookup surfaces as nothing at all — the start screen.
        if (rejoining) setStartError(e instanceof Error ? e.message : String(e));
      } finally {
        setHandingOver(false);
        setBoot("ready");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchSession = React.useCallback(
    async (action: "pause" | "resume" | "end") => {
      if (!sessionId) return;
      try {
        await fetch(`/api/bench/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
      } catch {
        // Non-fatal: chunk rows carry the ground truth; status catches up on
        // the next PATCH. Capture behavior is unaffected.
      }
    },
    [sessionId],
  );

  const onPause = React.useCallback(async () => {
    await pauseDay();
    void patchSession("pause");
  }, [pauseDay, patchSession]);

  const onResume = React.useCallback(() => {
    resumeDay();
    void patchSession("resume");
  }, [resumeDay, patchSession]);

  // End day: stop capture, then hold a spinner until every queued chunk is
  // verified, then flip the session to ended (PRD §9.3).
  const onEndDay = React.useCallback(async () => {
    setEndingUpload(true);
    await endDay();
  }, [endDay]);

  // Operator listener (S2): end_day must ack only after the flush + PATCH end — these
  // resolvers fire from the same effect that flips the session to ended.
  const endWaitersRef = React.useRef<Array<() => void>>([]);
  const endDayFlow = React.useCallback((): Promise<void> => {
    return new Promise<void>((resolve) => {
      endWaitersRef.current.push(resolve);
      void onEndDay();
    });
  }, [onEndDay]);

  React.useEffect(() => {
    if (!endingUpload) return;
    if (status.state !== "ending") return;
    if (status.queuedCount > 0) return;
    void (async () => {
      await patchSession("end");
      markEnded();
      setEndingUpload(false);
      const waiters = endWaitersRef.current;
      endWaitersRef.current = [];
      for (const w of waiters) w();
    })();
  }, [endingUpload, status.state, status.queuedCount, patchSession, markEnded]);

  // FU2b — the losing tab signals the handover once its last segment is uploaded: one
  // kiosk_handover_complete event carrying the last number it used per stream (-1 = the
  // stream never produced a chunk in this tab's life). Still never PATCH end — the new
  // tab owns the session and is waiting on exactly this event.
  const handoverPostedRef = React.useRef(false);
  React.useEffect(() => {
    if (!takenOver || handoverPostedRef.current) return;
    if (status.state !== "ending" || status.queuedCount > 0) return;
    if (!sessionId) return;
    handoverPostedRef.current = true;
    void fetch("/api/bench/sessions/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "kiosk_handover_complete",
        session_id: sessionId,
        last_idx: { primary: status.currentIdx - 1, backup: status.backupIdx - 1 },
      }),
      keepalive: true,
    }).catch(() => undefined);
  }, [takenOver, sessionId, status.state, status.queuedCount, status.currentIdx, status.backupIdx]);

  // ---- Kickoff C: "Mark consult" (decisions C3/C5/C6) ----
  // A press posts a consult_mark to the room-cookie proxy (durable-first there);
  // it never touches the recorders, the archive cycle, or the live sink. Latch 15s
  // on ok; on a failed POST no latch, quiet "Not saved — tap again", re-press allowed.
  const [mark, setMark] = React.useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "latched"; at: number }
    | { kind: "failed" }
  >({ kind: "idle" });
  const markTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    return () => {
      if (markTimerRef.current) clearTimeout(markTimerRef.current);
    };
  }, []);

  const onMarkConsult = React.useCallback(async () => {
    if (mark.kind === "sending" || mark.kind === "latched") return;
    const pressedAt = Date.now();
    setMark({ kind: "sending" });
    let ok = false;
    try {
      const res = await fetch("/api/bench/brain-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "consult_mark",
          at: new Date(pressedAt).toISOString(),
          session_id: sessionId,
        }),
        signal: AbortSignal.timeout(MARK_TIMEOUT_MS),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      ok = res.ok && j?.ok === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      setMark({ kind: "failed" });
      return;
    }
    setMark({ kind: "latched", at: pressedAt });
    if (markTimerRef.current) clearTimeout(markTimerRef.current);
    markTimerRef.current = setTimeout(() => setMark({ kind: "idle" }), MARK_LATCH_MS);
  }, [mark.kind, sessionId]);

  // ---- Operator MCP S2: command listener ----
  // Snapshot via refs so the poll never sees a stale closure; actions are the SAME flows
  // the buttons run. Mounted whenever this (signed-in) page is open — idle or recording.
  const stateRef = React.useRef(status.state);
  stateRef.current = status.state;
  const sessionIdRef = React.useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Remount-resume D3: a newer tab took the room. S3-1a — announce FIRST (the proof of
  // life the new tab's probe is watching for), then stop both streams and flush the current
  // segment to disk + upload (endDay does exactly that) — but NEVER PATCH end: endingUpload
  // stays false, so the drained-queue effect never fires and the new tab keeps the session.
  const onTakeover = React.useCallback(async () => {
    setTakenOver(true);
    const st = stateRef.current;
    if (st === "recording" || st === "paused") {
      const sid = sessionIdRef.current;
      if (sid) {
        void fetch("/api/bench/sessions/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "kiosk_handover_started", session_id: sid }),
          keepalive: true,
        }).catch(() => undefined);
      }
      await endDay();
    }
  }, [endDay]);
  const commandActions = React.useMemo<CommandActions>(
    () => ({
      getSnapshot: () => ({ state: stateRef.current, sessionId: sessionIdRef.current }),
      start: startDayFlow,
      pause: onPause,
      resume: async () => {
        onResume();
      },
      end: endDayFlow,
      takeover: onTakeover,
    }),
    [startDayFlow, onPause, onResume, endDayFlow, onTakeover],
  );
  // FU2: the poll waits for the first /active look (pollEnabled) — see the mount effect.
  const operator = useCommandPoll({ enabled: pollEnabled, actions: commandActions });
  operatorTabIdRef.current = operator.tab_id;

  // ---- shared bits ----
  const today = new Date();
  const longDate = today.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const shortDate = today.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  const pill =
    status.state === "recording" || status.state === "ending" ? (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-caption font-semibold bg-even-pink-50 text-even-pink-700">
        <span className="w-2 h-2 rounded-full bg-even-pink-600 animate-pulse" aria-hidden="true" />
        Recording
      </span>
    ) : status.state === "paused" ? (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-caption font-semibold bg-warning-100 text-warning-700">
        ❙❙ Paused
      </span>
    ) : (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-caption font-semibold bg-even-ink-100 text-even-ink-500">
        Not recording
      </span>
    );

  const headerSub =
    idle || !label.trim() ? longDate : `${shortDate} · ${label.trim()}`;

  // Kickoff B listening-state chip — flag on, while capturing only. Three states
  // (designer §2.1): recording / brain unsure / brain down, from the heartbeat
  // proxy's success/failure. NO visit graph, NO identities on the kiosk.
  const brainChip =
    LIVE_SINK && live && (status.state === "recording" || status.state === "ending") ? (
      live.brain === "recording" ? (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-meta font-semibold bg-success-100 text-success-700">
          <span className="w-1.5 h-1.5 rounded-full bg-success-700" aria-hidden="true" />
          Brain · recording
        </span>
      ) : live.brain === "unsure" ? (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-meta font-semibold bg-warning-100 text-warning-700">
          <span className="w-1.5 h-1.5 rounded-full bg-warning-700" aria-hidden="true" />
          Brain · unsure
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-meta font-semibold bg-even-ink-100 text-even-ink-500">
          <span className="w-1.5 h-1.5 rounded-full bg-even-ink-400" aria-hidden="true" />
          Brain · down
        </span>
      )
    ) : null;

  // Operator chip (S2): remote actions are as visible as a finger on the button; link
  // state otherwise. Pause remains the consent off-switch — this chip only reports.
  const operatorChip = (() => {
    const base = "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-meta font-semibold";
    const act = operator.last_action;
    if (act) {
      return act.ok ? (
        <span className={`${base} bg-even-blue-50 text-even-blue-700`} data-testid="operator-chip" title={`tab ${operator.tab_id}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-even-blue-600" aria-hidden="true" />
          {act.label} · {fmtTimeOfDay(act.at)}
        </span>
      ) : (
        <span className={`${base} bg-warning-100 text-warning-700`} data-testid="operator-chip">
          <span className="w-1.5 h-1.5 rounded-full bg-warning-700" aria-hidden="true" />
          {act.label}
        </span>
      );
    }
    switch (operator.link) {
      case "listening":
        return (
          <span className={`${base} bg-even-ink-50 text-even-ink-500`} data-testid="operator-chip" title={`tab ${operator.tab_id}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-success-500" aria-hidden="true" />
            Operator link · listening
          </span>
        );
      case "superseded":
        return (
          <span className={`${base} bg-warning-100 text-warning-700`} data-testid="operator-chip">
            Another tab took over
          </span>
        );
      case "down":
        return (
          <span className={`${base} bg-even-ink-100 text-even-ink-500`} data-testid="operator-chip" title={operator.last_error ?? ""}>
            <span className="w-1.5 h-1.5 rounded-full bg-even-ink-400" aria-hidden="true" />
            Operator link down
          </span>
        );
      case "not_migrated":
        return (
          <span className={`${base} bg-even-ink-100 text-even-ink-500`} data-testid="operator-chip">
            Operator link · not enabled
          </span>
        );
      case "connecting":
        return (
          <span className={`${base} bg-even-ink-50 text-even-ink-400`} data-testid="operator-chip">
            Operator link · connecting…
          </span>
        );
      default:
        return null;
    }
  })();

  const levelBars = (
    <span aria-hidden="true" className="tracking-tighter">
      {["▂", "▄", "▆", "▅", "▃"]
        .map((b, i) => (micLevel * 14 > i + 1 ? b : "▁"))
        .join("")}
    </span>
  );

  return (
    <main className="min-h-screen bg-even-cream px-4 py-8 flex items-start justify-center">
      <div className="w-full max-w-lg bg-even-white border border-even-ink-100 rounded-3xl overflow-hidden shadow-card-hover">
        {/* header */}
        <div className="px-6 py-4 border-b border-even-ink-100 flex items-center justify-between">
          <div>
            <p className="text-heading font-bold text-even-navy-800">{roomName}</p>
            <p className="text-caption text-even-ink-400">{headerSub}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            {pill}
            {LIVE_SINK && brainChip}
            {operatorChip}
            {/* FU4: the silence failsafe is not armed — the rejoin had no tap. */}
            {status.watchdogSuspended && (
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-meta font-semibold bg-warning-100 text-warning-700"
                data-testid="watchdog-chip"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-warning-700" aria-hidden="true" />
                Tap the screen to arm mic monitoring
              </span>
            )}
          </div>
        </div>
        {LIVE_SINK && (
          <LiveSinkProbe
            active={status.state === "recording"}
            sessionId={sessionId}
            mimeType={status.mimeType}
            getStream={getStream}
            handlersRef={liveHandlersRef}
            onCounters={setLive}
          />
        )}

        <div className="px-6 py-6">
          {/* ============ TAKEN OVER (remount-resume D3) ============ */}
          {takenOver && (
            <div className="text-center py-8" role="alert" data-testid="takeover-message">
              <p className="text-heading font-bold text-even-navy-800 mb-2">
                Another tab has taken over this room
              </p>
              <p className="text-body text-even-ink-500">
                This tab has stopped recording. Today&apos;s session continues in the new tab.
                {status.queuedCount > 0
                  ? ` Finishing ${status.queuedCount} queued upload${status.queuedCount === 1 ? "" : "s"} — keep this tab open until it clears.`
                  : ""}
              </p>
            </div>
          )}

          {/* recovery banner */}
          {!takenOver && status.recoveredPending > 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-warning-100 px-4 py-2.5 text-caption font-semibold text-warning-700">
              ⟳ Recovering {status.recoveredPending} unfinished upload
              {status.recoveredPending === 1 ? "" : "s"} from a previous session…
            </div>
          )}

          {/* remount-resume banner (D6) */}
          {!takenOver && resumed && status.state !== "idle" && status.state !== "error" && (
            <div
              className="mb-4 flex items-center gap-2 rounded-xl bg-even-blue-50 px-4 py-2.5 text-caption font-semibold text-even-blue-700"
              data-testid="resume-banner"
            >
              ↻{" "}
              {resumed.status === "paused"
                ? "Rejoined today's session — still paused"
                : "Rejoined today's session — recording continues on the same tape"}
            </div>
          )}

          {/* ============ CHECKING (before the start screen may render, §3.1) ============ */}
          {!takenOver && boot === "checking" && idle && (
            <div
              className="flex items-center justify-center gap-3 py-10 text-body font-semibold text-even-ink-500"
              data-testid="resume-check"
            >
              <span
                className="w-4 h-4 rounded-full border-2 border-even-blue-600 border-t-transparent animate-spin"
                aria-hidden="true"
              />
              {handingOver ? "Handing over from another tab…" : "Checking for today's session…"}
            </div>
          )}

          {/* ============ START OF DAY ============ */}
          {!takenOver && boot === "ready" && idle && (
            <>
              <div className="mb-4">
                <label className="block text-caption font-semibold text-even-navy-800 mb-1.5">
                  Session label
                </label>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={`${roomName} · clinic`}
                  className="w-full rounded-xl border border-even-ink-200 bg-even-white px-3 py-2.5 text-body text-even-ink-800"
                />
              </div>
              <div className="mb-4">
                <label className="block text-caption font-semibold text-even-navy-800 mb-1.5">
                  Microphone in use
                </label>
                <select
                  value={micId}
                  onChange={(e) => {
                    setMicId(e.target.value);
                    // FU3: a rejoined tape must reopen this choice, not the browser default.
                    void saveBenchSetting(PRIMARY_DEVICE_SETTING, e.target.value);
                  }}
                  className="w-full rounded-xl border border-even-ink-200 bg-even-white px-3 py-2.5 text-body text-even-ink-800"
                >
                  {mics.length === 0 && <option value="">Default microphone</option>}
                  {mics.map((m) => (
                    <option key={m.deviceId} value={m.deviceId}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mb-4">
                <label className="block text-caption font-semibold text-even-navy-800 mb-1.5">
                  Backup microphone <span className="font-normal text-even-ink-400">(records alongside; used if the main mic drops)</span>
                </label>
                <select
                  value={backupMicId}
                  onChange={(e) => {
                    setBackupMicId(e.target.value);
                    void saveBenchSetting(BACKUP_DEVICE_SETTING, e.target.value);
                  }}
                  data-testid="backup-mic"
                  className="w-full rounded-xl border border-even-ink-200 bg-even-white px-3 py-2.5 text-body text-even-ink-800"
                >
                  <option value="">No backup microphone</option>
                  {mics
                    .filter((m) => m.deviceId !== (micId || mics[0]?.deviceId))
                    .map((m) => (
                      <option key={m.deviceId} value={m.deviceId}>
                        {m.label}
                      </option>
                    ))}
                </select>
              </div>
              <div className="mb-4">
                <p className="text-caption font-semibold text-even-navy-800 mb-1.5">Mic check</p>
                <div
                  className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-body font-semibold ${
                    speechSeen
                      ? "bg-success-100 text-success-700"
                      : "bg-even-ink-100 text-even-ink-500"
                  }`}
                >
                  {levelBars}
                  <span>
                    {speechSeen ? "Level OK — speech detected" : "Listening… say something"}
                  </span>
                </div>
              </div>
              {startError && (
                <p className="mb-3 text-caption text-danger-700" role="alert">
                  Could not start: {startError}
                </p>
              )}
              <button
                type="button"
                onClick={onStart}
                disabled={starting}
                className="eta-btn-primary w-full py-5 text-heading"
              >
                ●&nbsp;&nbsp;{starting ? "Starting…" : "Start recording day"}
              </button>
              <p className="mt-4 text-center text-meta text-even-ink-400 leading-relaxed">
                Continuous recording · 5-minute archived chunks · originals preserved permanently
                <br />
                Patients and staff in this room are recorded under the hospital&apos;s IRB-approved
                protocol.
              </p>
            </>
          )}

          {/* ============ RECORDING / ENDING ============ */}
          {!takenOver && (status.state === "recording" || status.state === "ending") && (
            <>
              <p className="text-center text-[52px] leading-none font-bold text-even-navy-800 tabular-nums tracking-wide my-4">
                {fmtClock(status.dayElapsedMs)}
              </p>
              <p className="text-center text-caption text-even-ink-400 mb-5">
                {status.dayStartedAt ? `since ${fmtTimeOfDay(status.dayStartedAt)} · ` : ""}
                chunk {status.currentIdx + 1} in progress ({fmtMinSec(status.chunkElapsedMs)} /
                5:00)
              </p>
              {/* K-B primary failsafe — as loud as the recording pill, persistent until restored */}
              {status.primaryMic !== "active" && (
                <div
                  className="mb-4 rounded-2xl bg-danger-100 border-2 border-danger-700 px-4 py-4 text-center"
                  role="alert"
                  data-testid="on-backup-banner"
                >
                  <p className="text-heading font-bold text-danger-700 tracking-wide">
                    {status.backupMic === "active"
                      ? "ON BACKUP MIC"
                      : status.backupMic === "off"
                        ? "MAIN MIC LOST — NO BACKUP"
                        : "MAIN MIC LOST — BACKUP NOT READY"}
                  </p>
                  <p className="mt-1 text-caption font-semibold text-danger-700">
                    {status.primaryMic === "silent" ? "Main microphone is silent" : "Main microphone disconnected"}
                    {status.primaryLostAt ? ` since ${fmtTimeOfDay(status.primaryLostAt)}` : ""} · check the USB
                    mic — recording resumes on it automatically when it is back
                  </p>
                </div>
              )}
              <p className="text-center text-meta text-even-ink-400 mb-4" data-testid="backup-line">
                {status.backupMic === "active"
                  ? `Backup mic recording · ${status.backupArchivedCount} backup chunk${status.backupArchivedCount === 1 ? "" : "s"} archived`
                  : status.backupMic === "acquiring"
                    ? "Backup mic connecting…"
                    : status.backupMic === "error"
                      ? `Backup mic error — retrying (${status.backupError ?? "unknown"})`
                      : "No backup microphone"}
              </p>
              <div className="grid grid-cols-3 gap-2.5 mb-4">
                <div className="rounded-xl bg-even-ink-50 border border-even-ink-100 px-2 py-3 text-center">
                  <p className="text-heading font-bold text-even-navy-800 tabular-nums">
                    {status.archivedCount}
                  </p>
                  <p className="text-meta text-even-ink-500 mt-0.5">Chunks archived</p>
                </div>
                <div className="rounded-xl bg-even-ink-50 border border-even-ink-100 px-2 py-3 text-center">
                  <p
                    className={`text-heading font-bold tabular-nums ${
                      status.queuedCount > 0 ? "text-warning-700" : "text-even-navy-800"
                    }`}
                  >
                    {status.queuedCount}
                  </p>
                  <p className="text-meta text-even-ink-500 mt-0.5">Queued</p>
                </div>
                <div className="rounded-xl bg-even-ink-50 border border-even-ink-100 px-2 py-3 text-center">
                  <p className="text-heading font-bold text-even-navy-800 tabular-nums">
                    {fmtMb(status.archivedBytes)}
                  </p>
                  <p className="text-meta text-even-ink-500 mt-0.5">Stored today</p>
                </div>
              </div>

              {status.offline ? (
                <div className="mb-3 flex items-center gap-2 rounded-xl bg-warning-100 px-4 py-2.5 text-body font-semibold text-warning-700">
                  ⚠&nbsp; Network unreachable — {status.queuedCount} chunk
                  {status.queuedCount === 1 ? "" : "s"} queued locally, retrying · recording
                  continues
                </div>
              ) : status.micLost ? (
                <div className="mb-3 flex items-center gap-2 rounded-xl bg-danger-100 px-4 py-2.5 text-body font-semibold text-danger-700">
                  ⚠&nbsp; Microphone signal lost — check the USB mic
                </div>
              ) : status.lastVerifiedAt ? (
                <div className="mb-3 flex items-center gap-2 rounded-xl bg-success-100 px-4 py-2.5 text-body font-semibold text-success-700">
                  ✓&nbsp; Last chunk verified in R2 ·{" "}
                  {fmtMinSec(Math.max(0, Date.now() - status.lastVerifiedAt))} ago
                </div>
              ) : (
                <div className="mb-3 flex items-center gap-2 rounded-xl bg-even-ink-50 px-4 py-2.5 text-body font-semibold text-even-ink-500">
                  First chunk uploads at the 5-minute mark
                </div>
              )}
              {status.storageBlocked && (
                <div className="mb-3 flex items-center gap-2 rounded-xl bg-warning-100 px-4 py-2.5 text-caption font-semibold text-warning-700">
                  ⚠ Local storage unavailable — chunks held in memory only; do not reload this
                  tab
                </div>
              )}

              {status.state === "ending" ? (
                <div className="flex items-center justify-center gap-3 rounded-2xl border border-even-ink-200 py-4 text-body font-semibold text-even-navy-800">
                  <span className="w-4 h-4 rounded-full border-2 border-even-blue-600 border-t-transparent animate-spin" />
                  Finishing — uploading final chunk ({status.queuedCount} left)…
                </div>
              ) : (
                <div className="flex gap-2.5">
                  <button type="button" onClick={onPause} className="eta-btn-secondary flex-1 py-3.5">
                    ❙❙&nbsp;&nbsp;Pause
                  </button>
                  <button
                    type="button"
                    onClick={onEndDay}
                    className="flex-1 py-3.5 rounded-2xl font-medium border border-even-pink-600 text-even-pink-700 bg-even-white hover:bg-even-pink-50 transition"
                  >
                    End day
                  </button>
                  {/* Kickoff C — Mark consult: outline, subordinate to the day pill; visible only
                      while actively recording (C3). Latches "Marked HH:MM" 15s on success (C5). */}
                  <button
                    type="button"
                    onClick={onMarkConsult}
                    disabled={mark.kind === "sending" || mark.kind === "latched"}
                    aria-live="polite"
                    data-testid="mark-consult"
                    className={`flex-1 py-3.5 rounded-2xl font-medium border transition ${
                      mark.kind === "latched"
                        ? "border-even-ink-200 text-even-ink-500 bg-even-ink-50 cursor-default"
                        : "border-even-ink-300 text-even-navy-800 bg-even-white hover:bg-even-ink-50 disabled:opacity-60"
                    }`}
                  >
                    {mark.kind === "latched"
                      ? `✓ Marked ${fmtIstHm(mark.at)}`
                      : mark.kind === "sending"
                        ? "⚑ Marking…"
                        : "⚑ Mark consult"}
                  </button>
                </div>
              )}
              {status.state === "recording" && mark.kind === "failed" && (
                <p className="mt-2 text-right text-[13px] text-even-ink-500" role="status">
                  Not saved — tap again
                </p>
              )}
              <p className="mt-4 text-center text-meta text-even-ink-400 leading-relaxed">
                Do not close this tab. If the machine restarts, sign in again — unfinished uploads
                resume automatically.
              </p>
              {LIVE_SINK && live && (
                <p
                  className="mt-3 text-center font-mono text-[10px] leading-relaxed text-even-ink-400 break-words"
                  data-testid="live-sink-debug"
                >
                  live-sink {live.state}
                  {live.stop_reason ? ` (${live.stop_reason})` : ""} · slices {live.slices_received}
                  {" "}· late {live.slices_late} · drop~{live.slices_dropped_est} · empty{" "}
                  {live.slices_empty} · ema {Math.round(live.interval_ema_ms)}ms · max{" "}
                  {live.interval_max_ms}ms · win {live.window_slices}/
                  {Math.round(live.window_bytes / 1024)}KB · stalls {live.stalls} · err L
                  {live.live_recorder_errors}/A{live.archive_recorder_errors} · seam{" "}
                  {live.archive_seams} last {live.archive_seam_last_ms ?? "–"}ms max{" "}
                  {live.archive_seam_max_ms ?? "–"}ms · hb {live.heartbeats_ok}/
                  {live.heartbeats_sent} {live.brain}
                </p>
              )}
            </>
          )}

          {/* ============ PAUSED ============ */}
          {!takenOver && status.state === "paused" && (
            <>
              <p className="text-center text-[52px] leading-none font-bold text-even-ink-300 tabular-nums tracking-wide my-4">
                {fmtClock(status.dayElapsedMs)}
              </p>
              <p className="text-center text-caption text-even-ink-400 mb-6">
                Paused{status.pausedAt ? ` at ${fmtTimeOfDay(status.pausedAt)}` : ""} — nothing is
                being recorded
              </p>
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={onResume}
                  className="eta-btn-primary flex-[2] py-5 text-heading"
                >
                  ▶&nbsp;&nbsp;Resume recording
                </button>
                <button
                  type="button"
                  onClick={onEndDay}
                  className="flex-1 py-3.5 rounded-2xl font-medium border border-even-pink-600 text-even-pink-700 bg-even-white hover:bg-even-pink-50 transition"
                >
                  End day
                </button>
              </div>
              <p className="mt-4 text-center text-meta text-even-ink-400">
                Use Pause when a patient or staff member asks not to be recorded.
              </p>
            </>
          )}

          {/* ============ ENDED ============ */}
          {!takenOver && status.state === "ended" && (
            <div className="text-center py-8">
              <p className="text-heading font-bold text-even-navy-800 mb-2">Day ended</p>
              <p className="text-body text-even-ink-500 mb-6">
                {status.archivedCount} chunk{status.archivedCount === 1 ? "" : "s"} archived
                {status.backupArchivedCount > 0 ? ` + ${status.backupArchivedCount} backup` : ""} (
                {fmtMb(status.archivedBytes)}) — all uploads verified.
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="eta-btn-secondary px-6 py-3"
              >
                Start a new day
              </button>
            </div>
          )}
        </div>
      </div>
      <span className="sr-only">{slug}</span>
    </main>
  );
}
