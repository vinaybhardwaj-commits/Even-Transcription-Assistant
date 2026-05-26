"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RecordButton } from "@/components/recording/RecordButton";
import { ElapsedTimer } from "@/components/recording/ElapsedTimer";
import { useMediaRecorder } from "@/lib/use-media-recorder";
import { Button } from "@/components/ui/Button";

type Props = { slug: string; doctorName: string };

type EncounterDraft = { id: string; status: "draft" };

export function RecordingScreen({ slug, doctorName }: Props) {
  const router = useRouter();
  const [encounter, setEncounter] = React.useState<EncounterDraft | null>(null);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [chunksCount, setChunksCount] = React.useState(0);
  const [bytesEmitted, setBytesEmitted] = React.useState(0);

  const onChunk = React.useCallback((chunk: Blob, _idx: number) => {
    setChunksCount((c) => c + 1);
    setBytesEmitted((b) => b + chunk.size);
    // Sprint 1.F.2+ : pipe to Deepgram WS + IndexedDB + Whisper
  }, []);

  const rec = useMediaRecorder({ chunkMs: 5000, onChunk });

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
  }, []);

  // 2. Auto-start recording once we have an encounter id + mic permission
  // Per PRD §8.1.3 — clinicians shouldn't have to tap twice.
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

  return (
    <main className="min-h-screen bg-even-white flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-even-ink-100">
        <button
          type="button"
          onClick={() => router.push(`/${slug}`)}
          className="text-label text-even-blue-600 hover:underline"
        >
          ‹ Cancel
        </button>
        <span className="text-label text-even-navy-800">Dr {doctorName}</span>
        <span className="text-caption text-even-ink-400">
          {encounter ? encounter.id.slice(0, 8) : "…"}
        </span>
      </header>

      <section className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="text-display text-even-navy-800 mb-2">
          <ElapsedTimer running={running} />
        </div>

        <p className="text-caption text-even-ink-400 mb-12">
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
          <div className="mt-10 max-w-sm text-center">
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
          <p className="mt-6 text-caption text-danger-700 max-w-sm text-center">
            {rec.error}
          </p>
        ) : null}

        {createError ? (
          <p className="mt-6 text-caption text-danger-700 max-w-sm text-center">
            Could not create encounter: {createError}
          </p>
        ) : null}
      </section>

      <footer className="px-4 py-3 border-t border-even-ink-100 flex items-center justify-between text-caption text-even-ink-400">
        <span>
          {chunksCount} chunks · {(bytesEmitted / 1024).toFixed(1)} KB
        </span>
        <span>{rec.mimeType ?? "—"}</span>
      </footer>
    </main>
  );
}
