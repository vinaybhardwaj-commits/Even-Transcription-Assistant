"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";
import { probeIdbWritable } from "@/lib/chunk-store";
import { useMicLevel } from "@/lib/use-mic-level";
import { MIC_PREFLIGHT } from "@/lib/live-flags";

type Probe = {
  ok: boolean;
  latency_ms: number;
  error?: string;
};
type HealthResp = {
  ok: boolean;
  services: {
    db?: Probe;
    llm?: Probe;
    whisper?: Probe;
    resend?: Probe;
    r2?: Probe;
    kb?: Probe;
  };
};

type State =
  | { kind: "checking" }
  | { kind: "ok" }
  | { kind: "degraded"; failed: string[] }
  | { kind: "error"; message: string };

type Props = {
  onProceed: () => void;
  onCancel: () => void;
};

const FRIENDLY: Record<string, string> = {
  db: "Database",
  llm: "Local LLM (Mac Mini)",
  whisper: "Whisper (Mac Mini)",
  resend: "Email service",
  r2: "Audio storage",
  kb: "Knowledge base",
};

/**
 * Probes /api/health before recording starts. Per PRD §8.1.11 — warn
 * the doctor if any upstream is degraded but still let them record.
 * (Local audio backup is verified separately via probeIdbWritable(); it can
 * be unavailable, e.g. iOS Safari Private Browsing, in which case we warn.)
 *
 * Then (flag MIC_PREFLIGHT, default ON) a MICROPHONE gate: the doctor must see
 * their voice move a live meter before recording can start. A dead/muted/silent
 * mic blocks the start (with a "Record anyway" escape) — this is what prevents
 * the "recorded minutes of silence" failure.
 */
// AbortSignal.timeout() is unavailable on Safari < 16 / iOS 15. Calling it
// there throws and would mislabel a perfectly healthy backend as unreachable,
// blocking the consult. Feature-detect and degrade gracefully.
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
    if (typeof AbortController !== "undefined") {
      const c = new AbortController();
      setTimeout(() => c.abort(), ms);
      return c.signal;
    }
  } catch {
    /* very old engine — no abort support; proceed without a timeout */
  }
  return undefined;
}

export function PreflightCheck({ onProceed, onCancel }: Props) {
  const [state, setState] = React.useState<State>({ kind: "checking" });
  // Two-step gate: connectivity first, then the microphone check.
  const [step, setStep] = React.useState<"connectivity" | "mic">("connectivity");

  // Advance from the connectivity step → mic gate (or straight through if the
  // mic gate is flagged off).
  const proceed = React.useCallback(() => {
    if (MIC_PREFLIGHT) setStep("mic");
    else onProceed();
  }, [onProceed]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/health", {
          cache: "no-store",
          signal: timeoutSignal(8000),
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: "error", message: `http_${res.status}` });
          return;
        }
        const json = (await res.json()) as HealthResp;
        // Things that block live capture: llm (cleanup), whisper (rolling), db.
        // r2 needed at submit time, not record time, but flag if down.
        const failed: string[] = [];
        for (const [name, probe] of Object.entries(json.services)) {
          if (probe && probe.ok === false) failed.push(FRIENDLY[name] ?? name);
        }
        // Verify local audio storage is actually writable. iOS Safari Private
        // Browsing blocks IndexedDB — recording still works (in-memory failsafe)
        // but the audio can't be recovered if the tab reloads.
        const idbWritable = await probeIdbWritable();
        if (cancelled) return;
        if (!idbWritable) {
          failed.push("Local audio backup is blocked — likely Private Browsing. Recording works, but it won't survive a tab reload; a normal Safari tab is recommended.");
        }
        setState(failed.length === 0 ? { kind: "ok" } : { kind: "degraded", failed });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-advance on OK after a brief beat so the user sees the check happened.
  React.useEffect(() => {
    if (step !== "connectivity") return;
    if (state.kind !== "ok") return;
    const t = window.setTimeout(proceed, 250);
    return () => window.clearTimeout(t);
  }, [step, state.kind, proceed]);

  // ---- Step 2: microphone gate ----
  if (step === "mic") {
    return <MicGate onPass={onProceed} onCancel={onCancel} />;
  }

  // ---- Step 1: connectivity ----
  if (state.kind === "checking" || state.kind === "ok") {
    return (
      <div className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-center justify-center p-6">
        <div className="rounded-xl bg-even-white border border-even-ink-100 p-6 max-w-sm w-full text-center shadow-card-hover">
          <p className="text-label text-even-navy-800 mb-1">
            {state.kind === "ok" ? "All systems ready" : "Checking connectivity…"}
          </p>
          <p className="text-caption text-even-ink-500">
            Verifying transcription and storage services.
          </p>
        </div>
      </div>
    );
  }

  // Error or degraded
  const isError = state.kind === "error";
  return (
    <div className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="rounded-xl bg-even-white border border-warning-500 p-5 max-w-md w-full shadow-card-hover space-y-4">
        <div>
          <p className="text-label text-warning-700 mb-1">
            {isError ? "Connectivity check failed" : "Some services are degraded"}
          </p>
          <p className="text-caption text-even-ink-500">
            {isError
              ? "Couldn't reach the health endpoint. You can still record — audio is captured locally."
              : "You can still record. Audio is captured locally and uploaded once everything is back online."}
          </p>
        </div>
        {!isError && state.kind === "degraded" ? (
          <ul className="text-body text-even-ink-800 list-disc pl-5 space-y-0.5">
            {state.failed.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
        {isError ? (
          <p className="text-caption text-even-ink-500 break-all">{state.message}</p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={proceed}>Record anyway</Button>
        </div>
      </div>
    </div>
  );
}

// RMS floor that counts as "real audio reached the mic". Background hiss sits
// well below this; a spoken word clears it easily.
const MIC_RMS_THRESHOLD = 0.02;
// How long to listen for audio before declaring the mic silent.
const MIC_LISTEN_MS = 6000;

type MicPhase = "opening" | "listening" | "ok" | "silent" | "denied" | "error";

/**
 * MicGate — opens the microphone on a STANDALONE stream and shows a live input
 * meter. The doctor must produce audible sound (the meter must move past a
 * floor) before "Start recording" proceeds. If the mic is silent/blocked, shows
 * troubleshooting + Test again + a Record-anyway escape (never hard-locks a
 * clinician out of documenting). The probe stream is stopped before proceeding
 * so the recorder opens the mic cleanly.
 */
function MicGate({ onPass, onCancel }: { onPass: () => void; onCancel: () => void }) {
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [phase, setPhase] = React.useState<MicPhase>("opening");
  const [attempt, setAttempt] = React.useState(0);
  const { level, peak } = useMicLevel(stream);
  const streamRef = React.useRef<MediaStream | null>(null);
  const peakRef = React.useRef(0);
  React.useEffect(() => { peakRef.current = peak; }, [peak]);

  const stopStream = React.useCallback(() => {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    streamRef.current = null;
  }, []);

  // Open the mic (re-runs on "Test again").
  React.useEffect(() => {
    let cancelled = false;
    setPhase("opening");
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = s;
        setStream(s);
        setPhase("listening");
      } catch (e) {
        const name = (e as { name?: string })?.name;
        setPhase(name === "NotAllowedError" || name === "PermissionDeniedError" ? "denied" : "error");
      }
    })();
    return () => {
      cancelled = true;
      try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      streamRef.current = null;
    };
  }, [attempt]);

  // Detect audio energy → pass.
  React.useEffect(() => {
    if (phase === "listening" && peak >= MIC_RMS_THRESHOLD) setPhase("ok");
  }, [phase, peak]);

  // No audio within the listen window → silent.
  React.useEffect(() => {
    if (phase !== "listening") return;
    const t = window.setTimeout(() => {
      if (peakRef.current < MIC_RMS_THRESHOLD) setPhase("silent");
    }, MIC_LISTEN_MS);
    return () => window.clearTimeout(t);
  }, [phase, attempt]);

  // On OK, release the probe mic and proceed (recorder opens its own stream).
  React.useEffect(() => {
    if (phase !== "ok") return;
    const t = window.setTimeout(() => { stopStream(); setStream(null); onPass(); }, 500);
    return () => window.clearTimeout(t);
  }, [phase, onPass, stopStream]);

  const recordAnyway = React.useCallback(() => { stopStream(); setStream(null); onPass(); }, [onPass, stopStream]);
  const testAgain = React.useCallback(() => { stopStream(); setStream(null); setAttempt((a) => a + 1); }, [stopStream]);

  // Meter geometry (amplify so normal speech fills most of the bar).
  const pct = Math.min(100, Math.round(level * 320));
  const meterColor = level >= MIC_RMS_THRESHOLD ? "bg-success-500" : "bg-even-ink-300";

  const Meter = (
    <div className="w-full">
      <div className="h-3 w-full rounded-full bg-even-ink-100 overflow-hidden" role="progressbar" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={`h-full ${meterColor} transition-[width] duration-75`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );

  // Listening / OK panel
  if (phase === "opening" || phase === "listening" || phase === "ok") {
    const ok = phase === "ok";
    return (
      <div className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-center justify-center p-6">
        <div className="rounded-xl bg-even-white border border-even-ink-100 p-6 max-w-sm w-full text-center shadow-card-hover space-y-4">
          <div>
            <p className="text-label text-even-navy-800 mb-1">
              {ok ? "Microphone OK" : phase === "opening" ? "Opening microphone…" : "Say something to test your mic"}
            </p>
            <p className="text-caption text-even-ink-500">
              {ok
                ? "We can hear you — starting the recording."
                : "Speak normally — the bar should move. We won't start until we can hear audio."}
            </p>
          </div>
          {Meter}
          {!ok ? (
            <button type="button" onClick={onCancel} className="text-caption text-even-ink-400 hover:underline">
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  // Silent / denied / error panel
  const denied = phase === "denied";
  return (
    <div className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="rounded-xl bg-even-white border border-danger-500 p-5 max-w-md w-full shadow-card-hover space-y-4">
        <div>
          <p className="text-label text-danger-700 mb-1">
            {denied ? "Microphone access blocked" : "We can't hear your microphone"}
          </p>
          <p className="text-caption text-even-ink-500">
            {denied
              ? "Allow microphone access for this site, then tap Test again."
              : "No audio is reaching the mic. Don't start a consult yet — fix this first:"}
          </p>
        </div>
        {!denied ? (
          <ul className="text-body text-even-ink-800 list-disc pl-5 space-y-0.5">
            <li>Check the mic isn&apos;t muted for this site (address-bar mic icon).</li>
            <li>Disconnect Bluetooth / AirPods and use the phone&apos;s mic.</li>
            <li>Close other apps using the mic (calls, voice memos).</li>
          </ul>
        ) : null}
        {Meter}
        <p className="text-caption text-even-ink-400 text-center">
          Speak now — if the bar above stays flat, the mic still isn&apos;t working.
        </p>
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={testAgain}>Test again</Button>
            <Button variant="primary" onClick={recordAnyway}>Record anyway</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
