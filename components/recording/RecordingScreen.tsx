"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RecordButton } from "@/components/recording/RecordButton";
import { ElapsedTimer } from "@/components/recording/ElapsedTimer";
import { LiveTranscript } from "@/components/recording/LiveTranscript";
import { useMediaRecorder } from "@/lib/use-media-recorder";
import { useDeepgramLive, type LiveUtterance } from "@/lib/use-deepgram-live";
import { useWhisperRolling } from "@/lib/use-whisper-rolling";
import { WhisperTranscript } from "@/components/recording/WhisperTranscript";
import { putChunk, purgeEncounter } from "@/lib/chunk-store";
import { Button } from "@/components/ui/Button";

type Props = { slug: string; doctorName: string };

type EncounterDraft = { id: string; status: "draft" };

type FinalRow = { id: string; text: string };

export function RecordingScreen({ slug, doctorName }: Props) {
  const router = useRouter();
  const [encounter, setEncounter] = React.useState<EncounterDraft | null>(null);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [chunksCount, setChunksCount] = React.useState(0);
  const [bytesEmitted, setBytesEmitted] = React.useState(0);
  const [finals, setFinals] = React.useState<FinalRow[]>([]);
  const [interim, setInterim] = React.useState("");

  // 1. Create draft encounter row on mount
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/${slug}/api/encounters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
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
  }, [slug]);

  // 2. Deepgram live — enabled once we have an encounter row
  const dg = useDeepgramLive({
    slug,
    enabled: encounter !== null,
    encounterId: encounter?.id,
    onFinal: React.useCallback((u: LiveUtterance) => {
      setFinals((prev) => [...prev, { id: u.id, text: u.text }]);
      setInterim("");
    }, []),
    onInterim: React.useCallback((u: LiveUtterance) => {
      setInterim(u.text);
    }, []),
  });

  // 2b. Whisper rolling — cumulative-from-zero every 10s for higher-accuracy
  // transcript of medical terms. Replaces (not appends) — each pass returns
  // the full transcript-to-date.
  const wh = useWhisperRolling({
    slug,
    enabled: encounter !== null,
    encounterId: encounter?.id,
    intervalMs: 10_000,
  });

  // 3. MediaRecorder — emit 250ms chunks; route to Deepgram + Whisper + counter
  const onChunk = React.useCallback(
    (chunk: Blob, _idx: number) => {
      setChunksCount((c) => c + 1);
      setBytesEmitted((b) => b + chunk.size);
      dg.sendChunk(chunk);
      wh.sendChunk(chunk);
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
    [dg, wh, encounter],
  );

  const rec = useMediaRecorder({ chunkMs: 250, onChunk });

  // 4. Auto-start recording once we have an encounter id + Deepgram open-ish
  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (encounter && !autoStartedRef.current && rec.state === "idle") {
      autoStartedRef.current = true;
      void rec.start();
    }
  }, [encounter, rec]);

  const onButton = React.useCallback(() => {
    if (rec.state === "recording") {
      void rec.stop();
    } else if (rec.state === "paused") {
      rec.resume();
    } else if (rec.state === "idle") {
      void rec.start();
    }
  }, [rec]);

  const buttonMode =
    rec.state === "recording"
      ? "recording"
      : rec.state === "paused"
      ? "paused"
      : rec.state === "permission_pending" || rec.state === "finalizing"
      ? "busy"
      : "idle";

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

  return (
    <main className="min-h-screen bg-even-white flex flex-col">
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
              ? "Stop recording"
              : rec.state === "paused"
              ? "Resume recording"
              : "Start recording"
          }
        />

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

        <div className="w-full max-w-2xl mt-2 space-y-3">
          <LiveTranscript finals={finals} interim={interim} />
          <WhisperTranscript
            state={wh.state}
            text={wh.latest?.text ?? ""}
            latencyMs={wh.latest?.latency_ms ?? null}
            passIdx={wh.latest?.pass_idx ?? null}
            language={wh.latest?.language ?? null}
            bytes={wh.latest?.bytes ?? null}
            error={wh.error}
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
