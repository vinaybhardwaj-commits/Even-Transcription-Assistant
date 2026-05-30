"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RecordButton } from "@/components/recording/RecordButton";
import { ElapsedTimer } from "@/components/recording/ElapsedTimer";
import { useMediaRecorder } from "@/lib/use-media-recorder";
import { useDeepgramLive, type LiveUtterance } from "@/lib/use-deepgram-live";
import { useWhisperRolling } from "@/lib/use-whisper-rolling";
import { SarvamTranscript } from "@/components/recording/SarvamTranscript";
import { useSarvamRolling } from "@/lib/use-sarvam-rolling";
import { useSarvamStreaming } from "@/lib/use-sarvam-streaming";
import { useSpeakerIdentify } from "@/lib/use-speaker-identify";
import { putChunk, purgeEncounter } from "@/lib/chunk-store";
import { useEncounterSubmit } from "@/lib/use-encounter-submit";
import { useUtteranceCleanup } from "@/lib/use-utterance-cleanup";
import { Button } from "@/components/ui/Button";
import { PreflightCheck } from "@/components/recording/PreflightCheck";

type Props = { slug: string; doctorName: string };

type EncounterDraft = { id: string; status: "draft" };

type FinalRow = { id: string; text: string };

export function RecordingScreen({ slug, doctorName }: Props) {
  const router = useRouter();
  const [preflightPassed, setPreflightPassed] = React.useState(false);
  const [preflightCancelled, setPreflightCancelled] = React.useState(false);
  const [encounter, setEncounter] = React.useState<EncounterDraft | null>(null);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [chunksCount, setChunksCount] = React.useState(0);
  const [bytesEmitted, setBytesEmitted] = React.useState(0);
  const [finals, setFinals] = React.useState<FinalRow[]>([]);
  // duration_seconds at stop — captured when the user taps Submit
  const recordStartedAtRef = React.useRef<number | null>(null);
  const [recordedSeconds, setRecordedSeconds] = React.useState<number | null>(null);

  // 1. Create draft encounter row only after preflight gate clears.
  //    B11 Part A: read the patient label HomeShell stashed in sessionStorage
  //    and pass it to the POST so it persists as encounter.patient_label_raw.
  //    Without this, every encounter ends up with patient_label_raw = NULL
  //    and the library shows "Untitled encounter" until the LLM populates
  //    note_json.chief_complaint (which still doesn't reflect the typed name).
  React.useEffect(() => {
    if (!preflightPassed) return;
    let cancelled = false;
    let pendingLabel: string | null = null;
    let pendingNoteType: string | null = null;
    try {
      const raw = sessionStorage.getItem("eta:pending_patient_label");
      if (raw && raw.trim().length > 0) {
        pendingLabel = raw.trim().slice(0, 200);
      }
      // Clear immediately so a subsequent "blank" recording doesn't reuse it.
      sessionStorage.removeItem("eta:pending_patient_label");
      // V2.S2 note-type (physician allow-list); default clinic_encounter server-side.
      const nt = sessionStorage.getItem("eta:pending_note_type");
      if (
        nt === "general_medical" || nt === "clinic_encounter" ||
        nt === "operative_procedure" || nt === "dietetic_consult" || nt === "physiotherapy"
      ) pendingNoteType = nt;
      sessionStorage.removeItem("eta:pending_note_type");
    } catch {
      /* private mode / storage disabled — silently skip */
    }
    (async () => {
      try {
        const createBody: Record<string, string> = {};
        if (pendingLabel) createBody.patient_label = pendingLabel;
        if (pendingNoteType) createBody.note_type = pendingNoteType;
        const res = await fetch(`/${slug}/api/encounters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createBody),
        });
        if (!res.ok) {
          setCreateError(`http_${res.status}`);
          return;
        }
        const json = (await res.json()) as { encounter: EncounterDraft };
        if (!cancelled) setEncounter(json.encounter);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setCreateError(msg);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, preflightPassed]);

  // 2a. Per-utterance cleanup via llama3.1:8b — strips filler words,
  // normalizes mispronunciations on Deepgram finals. Soft-fail to raw.
  // Declared above Deepgram so onFinal can reference it.
  const cleanup = useUtteranceCleanup({
    slug,
    enabled: encounter !== null,
    concurrency: 2,
  });

  // 2. Deepgram live — enabled once we have an encounter row
  const dg = useDeepgramLive({
    slug,
    enabled: encounter !== null,
    encounterId: encounter?.id,
    onFinal: React.useCallback((u: LiveUtterance) => {
      setFinals((prev) => [...prev, { id: u.id, text: u.text }]);
      cleanup.enqueue(u.id, u.text);
    }, [cleanup]),
  });

  // Mic stream captured from the recorder; feeds the Sarvam streaming worklet.
  const [micStream, setMicStream] = React.useState<MediaStream | null>(null);

  // 2b. Whisper rolling — cumulative-from-zero every 10s for higher-accuracy
  // transcript of medical terms. Replaces (not appends) — each pass returns
  // the full transcript-to-date.
  const wh = useWhisperRolling({
    slug,
    enabled: encounter !== null,
    encounterId: encounter?.id,
    intervalMs: 10_000,
  });

  // 2c. Sarvam near-live rolling — multilingual (Indian-language) transcription.
  // Sends decodable <=30s webm windows every 10s; accumulates the original
  // script (for the live panel + preservation) and the English translation
  // (for the note). Drives the native-script live panel for non-English
  // encounters; English encounters keep the Deepgram experience untouched.
  // Real-time streaming (B) when a relay is configured, else the REST refine (A).
  // If streaming errors (token/WS), fall back to the REST trace so the live
  // panel + multilingual detection keep working (note is safe regardless).
  const RELAY_URL = process.env.NEXT_PUBLIC_STT_RELAY_URL || null;
  const STREAMING = !!RELAY_URL;
  const svStream = useSarvamStreaming({
    slug,
    enabled: encounter !== null && STREAMING,
    stream: micStream,
    relayUrl: RELAY_URL,
  });
  const useStream = STREAMING && svStream.state !== "error";
  const svRoll = useSarvamRolling({
    slug,
    enabled: encounter !== null && !useStream,
    encounterId: encounter?.id,
    intervalMs: 2_000,
  });
  const sv = useStream ? svStream : svRoll;

  // 2d. Live clinician identification (V2.SD.2) — drives the Speakers pill.
  const spk = useSpeakerIdentify({ slug, enabled: encounter !== null });


  // Submit pipeline (read IDB → R2 PUT → finalize)
  const submit = useEncounterSubmit({
    slug,
    encounterId: encounter?.id ?? null,
    durationSeconds: recordedSeconds,
    deepgramTranscript: finals
      .map((f) => cleanup.cleanedById[f.id] ?? f.text)
      .join(" "),
    whisperTranscript: wh.latest?.text ?? "",
    sarvamCodemix: sv.text,
    sarvamLanguage: sv.language,
  });

  // 3. MediaRecorder — emit 250ms chunks; route to Deepgram + Whisper + counter
  const onChunk = React.useCallback(
    (chunk: Blob, _idx: number) => {
      setChunksCount((c) => c + 1);
      setBytesEmitted((b) => b + chunk.size);
      dg.sendChunk(chunk);
      wh.sendChunk(chunk);
      sv.sendChunk(chunk);
      spk.sendChunk(chunk);
      // Persist to IndexedDB for crash recovery (PRD §4.18). Fire-and-forget;
      // we don't block the live transcription pipeline on disk write.
      if (encounter) {
        void putChunk(
          encounter.id,
          _idx,
          chunk,
          chunk.type || "audio/webm",
        ).catch((e) => {
          // eslint-disable-next-line no-console
          console.warn("idb_put_failed", e);
        });
      }
    },
    [dg, wh, sv, spk, encounter],
  );

  const rec = useMediaRecorder({ chunkMs: 250, onChunk, onStream: setMicStream });

  // Track when recording actually started (for duration_seconds at Submit)
  React.useEffect(() => {
    if (rec.state === "recording" && recordStartedAtRef.current === null) {
      recordStartedAtRef.current = Date.now();
    }
  }, [rec.state]);

  // 4. Auto-start recording once we have an encounter id + Deepgram open-ish
  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (encounter && !autoStartedRef.current && rec.state === "idle") {
      autoStartedRef.current = true;
      void rec.start();
    }
  }, [encounter, rec]);

  // Main big-button: when recording → Finalize (stops + shows Submit).
  // When paused → Resume. When idle → Start.
  const onButton = React.useCallback(() => {
    if (rec.state === "recording" || rec.state === "paused") {
      if (recordStartedAtRef.current !== null) {
        setRecordedSeconds(
          Math.max(1, Math.floor((Date.now() - recordStartedAtRef.current) / 1000)),
        );
      }
      void rec.stop();
    } else if (rec.state === "idle") {
      void rec.start();
    }
  }, [rec]);

  // Separate pause button — only meaningful while recording.
  const onPause = React.useCallback(() => {
    rec.pause();
  }, [rec]);
  const onResume = React.useCallback(() => {
    rec.resume();
  }, [rec]);

  const onSubmit = React.useCallback(async () => {
    const r = await submit.submit();
    if (r.ok) {
      try {
        sessionStorage.setItem("eta:last_submitted_encounter", r.encounterId);
      } catch {
        /* private mode */
      }
      // Land on the encounter detail page — it will auto-trigger processing
      // and show the note + CDMSS as they come back.
      router.push(`/${slug}/encounter/${r.encounterId}`);
    }
  }, [submit, router, slug]);

  const buttonMode =
    rec.state === "recording"
      ? "recording"
      : rec.state === "paused"
      ? "paused"
      : rec.state === "permission_pending" || rec.state === "finalizing"
      ? "busy"
      : "idle";
  const showPauseControls = rec.state === "recording" || rec.state === "paused";

  const running = rec.state === "recording";

  const dgStatus =
    dg.state === "open"
      ? "Live"
      : dg.state === "connecting"
      ? "Connecting…"
      : dg.state === "closed"
      ? "Disconnected"
      : dg.state === "error"
      ? `Error: ${dg.error ?? "unknown"}`
      : "Idle";

  const dgPillCls =
    dg.state === "open"
      ? "bg-success-100 text-success-700"
      : dg.state === "error"
      ? "bg-danger-100 text-danger-700"
      : "bg-even-ink-100 text-even-ink-500";

  // Pre-flight: when cancelled, bounce back to home
  React.useEffect(() => {
    if (preflightCancelled) router.push(`/${slug}`);
  }, [preflightCancelled, router, slug]);

  return (
    <main className="min-h-screen bg-even-white flex flex-col">
      {!preflightPassed && !preflightCancelled ? (
        <PreflightCheck
          onProceed={() => setPreflightPassed(true)}
          onCancel={() => setPreflightCancelled(true)}
        />
      ) : null}
      <header className="flex items-center justify-between px-4 py-3 border-b border-even-ink-100">
        <button
          type="button"
          onClick={async () => {
            // Purge any chunks we wrote — Cancel = clean abandon.
            if (encounter) {
              try { await purgeEncounter(encounter.id); } catch { /* noop */ }
            }
            router.push(`/${slug}`);
          }}
          className="text-label text-even-blue-600 hover:underline"
        >
          ‹ Cancel
        </button>
        <span className="text-label text-even-navy-800">Dr {doctorName}</span>
        <span
          className={`text-caption rounded-full px-2 py-0.5 ${dgPillCls}`}
          aria-live="polite"
        >
          {dgStatus}
        </span>
      </header>

      <section className="flex-1 flex flex-col items-center px-6 py-8 gap-6">
        {rec.state === "paused" ? (
          <div className="w-full max-w-md rounded-md border border-warning-500 bg-warning-100/40 px-4 py-2 text-center" role="status">
            <p className="text-label text-warning-700">Recording paused</p>
            <p className="text-caption text-even-ink-500">Resume to keep capturing audio.</p>
          </div>
        ) : null}

        <div className="text-display text-even-navy-800 mt-2">
          <ElapsedTimer running={running} />
        </div>

        <p className="text-caption text-even-ink-400 -mt-3">
          {rec.state === "recording"
            ? "Recording…"
            : rec.state === "paused"
            ? "Paused"
            : rec.state === "permission_pending"
            ? "Asking mic permission…"
            : rec.state === "permission_denied"
            ? "Microphone permission denied"
            : rec.state === "finalizing"
            ? "Saving recording…"
            : "Ready"}
        </p>

        <RecordButton
          mode={buttonMode}
          onClick={onButton}
          ariaLabel={
            rec.state === "recording"
              ? "Finalize recording"
              : rec.state === "paused"
              ? "Finalize paused recording"
              : "Start recording"
          }
        />

        {showPauseControls ? (
          <div className="flex items-center gap-3 mt-1">
            {rec.state === "recording" ? (
              <Button variant="secondary" size="sm" onClick={onPause}>
                Pause
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={onResume}>
                Resume
              </Button>
            )}
            <span className="text-caption text-even-ink-400">
              Big button finalizes the recording
            </span>
          </div>
        ) : null}

        {rec.state === "permission_denied" ? (
          <div className="mt-6 max-w-sm text-center">
            <p className="text-body text-danger-700 mb-3">
              We need microphone access to capture the encounter.
            </p>
            <p className="text-caption text-even-ink-500 mb-4">
              Open your browser settings, allow microphone for this site, then reload.
            </p>
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        ) : null}

        {rec.error && rec.state === "error" ? (
          <p className="text-caption text-danger-700 max-w-sm text-center">
            {rec.error}
          </p>
        ) : null}

        {createError ? (
          <p className="text-caption text-danger-700 max-w-sm text-center">
            Could not create encounter: {createError}
          </p>
        ) : null}

        {/* Submit appears after recording has stopped and we have any audio */}
        {rec.state === "idle" && chunksCount > 0 && submit.stage !== "done" ? (
          <div className="w-full max-w-md mt-2 space-y-3">
            {submit.stage === "idle" || submit.stage === "error" ? (
              <Button
                variant="primary"
                size="lg"
                onClick={() => void onSubmit()}
                className="w-full"
              >
                Submit recording
              </Button>
            ) : (
              <div className="rounded-md border border-even-blue-100 bg-even-blue-50 p-4">
                <p className="text-label text-even-navy-800 mb-2">
                  {submit.stage === "reading" && "Reading audio…"}
                  {submit.stage === "requesting_url" && "Requesting upload URL…"}
                  {submit.stage === "uploading" &&
                    `Uploading… ${(submit.totalBytes / 1024).toFixed(1)} KB`}
                  {submit.stage === "finalizing" && "Finalizing…"}
                  {submit.stage === "purging" && "Cleaning up…"}
                </p>
                <div
                  className="h-1.5 w-full rounded-full bg-even-ink-100 overflow-hidden"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(submit.progress * 100)}
                >
                  <div
                    className="h-full bg-even-blue-600 transition-all"
                    style={{ width: `${Math.round(submit.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}
            {submit.error ? (
              <p className="text-caption text-danger-700 text-center">
                {submit.error}
              </p>
            ) : null}
          </div>
        ) : null}

        {spk.enrolled ? (() => {
          // Subtle live speaker cue. The identify window (~9s) tells us whether
          // YOU dominated the latest audio; when another voice does, we show it.
          // True N-speaker separation is computed at submit (shown post-record).
          const cur = spk.current;
          const speaking = sv.text.trim().length > 0;
          const state: "you" | "other" | "listening" =
            cur?.isClinician ? "you" : cur && speaking ? "other" : "listening";
          const cfg = {
            you: { ring: "border-success-500 bg-success-100/40 text-success-700", dot: "bg-success-500" },
            other: { ring: "border-warning-500 bg-warning-100/50 text-warning-700", dot: "bg-warning-500" },
            listening: { ring: "border-even-ink-200 bg-even-ink-50 text-even-ink-500", dot: "bg-even-ink-300 animate-pulse" },
          }[state];
          return (
            <div className="w-full max-w-2xl flex flex-col items-start gap-1">
              <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-caption transition-colors duration-300 ${cfg.ring}`}>
                <span className={`h-2 w-2 rounded-full ${cfg.dot} ${state === "other" ? "animate-pulse" : ""}`} />
                {state === "you" ? (
                  <span>You · Dr {spk.name}{cur?.confidence != null ? ` · ${(cur.confidence * 100).toFixed(0)}%` : ""}</span>
                ) : state === "other" ? (
                  <span>Another voice in the room</span>
                ) : (
                  <span>Listening for your voice…</span>
                )}
              </div>
              {state === "other" ? (
                <span className="pl-1 text-[11px] text-even-ink-400">Full speaker breakdown ready after you finish.</span>
              ) : null}
            </div>
          );
        })() : null}

        <div className="w-full max-w-2xl mt-2">
          <SarvamTranscript
            text={sv.text}
            language={sv.language}
            latencyMs={sv.latest?.latency_ms ?? null}
            error={sv.error}
          />
        </div>
      </section>

      <footer className="px-4 py-3 border-t border-even-ink-100 flex items-center justify-between text-caption text-even-ink-400">
        <span>
          {chunksCount} chunks · {(bytesEmitted / 1024).toFixed(1)} KB · {finals.length} finals
        </span>
        <span>{rec.mimeType ?? "—"}</span>
      </footer>
    </main>
  );
}
