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
 */

import * as React from "react";
import { useRoomRecorder } from "@/lib/use-room-recorder";

type Props = { slug: string; roomName: string };

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
  const { status, startDay, pauseDay, resumeDay, endDay, markEnded } = useRoomRecorder();

  const [label, setLabel] = React.useState("");
  const [mics, setMics] = React.useState<Array<{ deviceId: string; label: string }>>([]);
  const [micId, setMicId] = React.useState<string>("");
  const [micLevel, setMicLevel] = React.useState(0); // 0..1 rolling
  const [speechSeen, setSpeechSeen] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [endingUpload, setEndingUpload] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);

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
          setMics(
            devices
              .filter((d) => d.kind === "audioinput")
              .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
          );
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
  const onStart = React.useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
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
      await startDay(sid, micId || undefined);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [label, micLabelText, micId, startDay]);

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

  React.useEffect(() => {
    if (!endingUpload) return;
    if (status.state !== "ending") return;
    if (status.queuedCount > 0) return;
    void (async () => {
      await patchSession("end");
      markEnded();
      setEndingUpload(false);
    })();
  }, [endingUpload, status.state, status.queuedCount, patchSession, markEnded]);

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
          {pill}
        </div>

        <div className="px-6 py-6">
          {/* recovery banner */}
          {status.recoveredPending > 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-warning-100 px-4 py-2.5 text-caption font-semibold text-warning-700">
              ⟳ Recovering {status.recoveredPending} unfinished upload
              {status.recoveredPending === 1 ? "" : "s"} from a previous session…
            </div>
          )}

          {/* ============ START OF DAY ============ */}
          {idle && (
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
                  onChange={(e) => setMicId(e.target.value)}
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
          {(status.state === "recording" || status.state === "ending") && (
            <>
              <p className="text-center text-[52px] leading-none font-bold text-even-navy-800 tabular-nums tracking-wide my-4">
                {fmtClock(status.dayElapsedMs)}
              </p>
              <p className="text-center text-caption text-even-ink-400 mb-5">
                {status.dayStartedAt ? `since ${fmtTimeOfDay(status.dayStartedAt)} · ` : ""}
                chunk {status.currentIdx + 1} in progress ({fmtMinSec(status.chunkElapsedMs)} /
                5:00)
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
                </div>
              )}
              <p className="mt-4 text-center text-meta text-even-ink-400 leading-relaxed">
                Do not close this tab. If the machine restarts, sign in again — unfinished uploads
                resume automatically.
              </p>
            </>
          )}

          {/* ============ PAUSED ============ */}
          {status.state === "paused" && (
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
          {status.state === "ended" && (
            <div className="text-center py-8">
              <p className="text-heading font-bold text-even-navy-800 mb-2">Day ended</p>
              <p className="text-body text-even-ink-500 mb-6">
                {status.archivedCount} chunk{status.archivedCount === 1 ? "" : "s"} archived (
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
