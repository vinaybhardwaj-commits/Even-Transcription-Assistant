"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMediaRecorder } from "@/lib/use-media-recorder";
import { Button } from "@/components/ui/Button";

/**
 * VoiceEnrollClient — V2.SD.1 voice-enrollment wizard.
 * Six English sentences (1-3 phonetically diverse, 4-6 medical register, per
 * PRD §20.4.1) recorded one at a time. Each is a complete standalone webm clip.
 * On finish, all clips POST to /api/voice/enroll → Mac Mini /enroll ×N → centroid
 * → voice_print. English-only at launch; Hindi/Kannada enter via passive
 * accumulation. Skip (behind confirm) proceeds to recording un-enrolled.
 */

const SENTENCES = [
  "The quick brown fox jumps over the lazy dog.",
  "She sells seashells by the seashore.",
  "How razorback-jumping frogs can level six piqued gymnasts.",
  "The patient reports intermittent chest discomfort for two weeks.",
  "Heart sounds are normal with no audible murmurs or gallops.",
  "Please follow up in one week with the results of the lab tests.",
];

type Props = { slug: string; doctorName: string };

export function VoiceEnrollClient({ slug, doctorName }: Props) {
  const router = useRouter();
  const [idx, setIdx] = React.useState(0);
  const [clips, setClips] = React.useState<(Blob | null)[]>(() => Array(SENTENCES.length).fill(null));
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showSkip, setShowSkip] = React.useState(false);
  const chunksRef = React.useRef<Blob[]>([]);
  const mimeRef = React.useRef<string>("audio/webm");

  const rec = useMediaRecorder({
    chunkMs: 1000,
    onChunk: (chunk) => {
      if (chunk && chunk.size > 0) {
        chunksRef.current.push(chunk);
        if (chunk.type) mimeRef.current = chunk.type;
      }
    },
  });

  const recording = rec.state === "recording";
  const recordedCount = clips.filter(Boolean).length;
  const allDone = recordedCount === SENTENCES.length;

  const startRec = React.useCallback(() => {
    chunksRef.current = [];
    setError(null);
    void rec.start();
  }, [rec]);

  const stopRec = React.useCallback(async () => {
    await rec.stop();
    // chunks have flushed by the time stop() resolves
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    chunksRef.current = [];
    if (blob.size === 0) {
      setError("Nothing recorded — try again.");
      return;
    }
    setClips((prev) => {
      const next = [...prev];
      next[idx] = blob;
      return next;
    });
  }, [rec, idx]);

  const finish = React.useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      clips.forEach((c, i) => {
        if (c) form.append(`clip_${i}`, c, `clip_${i}.webm`);
      });
      const res = await fetch(`/${slug}/api/voice/enroll`, { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; sample_count?: number; error?: { message?: string } };
      if (!res.ok || !json.ok) {
        setError(json?.error?.message || `Enrollment failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      try { sessionStorage.setItem("eta:voice_enrolled", "1"); } catch { /* noop */ }
      router.push(`/${slug}/record`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [clips, slug, router]);

  const skip = React.useCallback(() => {
    try { sessionStorage.setItem("eta:voice_enroll_skipped", "1"); } catch { /* noop */ }
    router.push(`/${slug}/record`);
  }, [slug, router]);

  return (
    <main className="min-h-screen bg-even-white flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-even-ink-100">
        <span className="text-label text-even-navy-800">Voice setup · Dr {doctorName}</span>
        <button type="button" onClick={() => setShowSkip(true)} className="text-caption text-even-ink-400 hover:text-even-ink-600">
          Skip for now
        </button>
      </header>

      <section className="flex-1 flex flex-col items-center px-6 py-8 gap-6 max-w-xl mx-auto w-full">
        <div>
          <h1 className="text-display text-even-navy-800 text-center">Set up voice recognition</h1>
          <p className="text-caption text-even-ink-500 text-center mt-2">
            Read {SENTENCES.length} short sentences aloud (~90 seconds). This lets the app label you in recordings. English only for now.
          </p>
        </div>

        {/* progress dots */}
        <div className="flex items-center gap-2" aria-label={`Sentence ${idx + 1} of ${SENTENCES.length}`}>
          {SENTENCES.map((_, i) => (
            <span
              key={i}
              className={`h-2.5 w-2.5 rounded-full ${clips[i] ? "bg-success-500" : i === idx ? "bg-even-blue-600" : "bg-even-ink-200"}`}
            />
          ))}
        </div>

        <div className="w-full rounded-xl border border-even-ink-100 bg-even-white p-6 text-center">
          <p className="text-caption text-even-ink-400 mb-2">Sentence {idx + 1} of {SENTENCES.length}{idx >= 3 ? " · clinical" : ""}</p>
          <p className="text-[22px] leading-relaxed text-even-navy-800" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
            {"“"}{SENTENCES[idx]}{"”"}
          </p>
        </div>

        {!recording ? (
          <Button variant="primary" size="lg" onClick={startRec} className="w-full max-w-xs" disabled={submitting}>
            {clips[idx] ? "Re-record this sentence" : "Tap to record"}
          </Button>
        ) : (
          <Button variant="destructive" size="lg" onClick={() => void stopRec()} className="w-full max-w-xs">
            Stop
          </Button>
        )}

        {recording ? <p className="text-caption text-even-blue-600">Recording… read the sentence, then tap Stop.</p> : null}

        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0 || recording || submitting}>
            ‹ Previous
          </Button>
          {clips[idx] && idx < SENTENCES.length - 1 ? (
            <Button variant="primary" size="sm" onClick={() => setIdx((i) => Math.min(SENTENCES.length - 1, i + 1))} disabled={recording || submitting}>
              Next sentence ›
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setIdx((i) => Math.min(SENTENCES.length - 1, i + 1))} disabled={idx >= SENTENCES.length - 1 || recording || submitting}>
              Next ›
            </Button>
          )}
        </div>

        {allDone ? (
          <Button variant="primary" size="lg" onClick={() => void finish()} className="w-full max-w-xs" disabled={submitting}>
            {submitting ? "Enrolling…" : "Finish enrollment"}
          </Button>
        ) : (
          <p className="text-caption text-even-ink-400">{recordedCount} of {SENTENCES.length} recorded</p>
        )}

        {rec.state === "permission_denied" ? (
          <p className="text-caption text-danger-700 text-center max-w-sm">Microphone access denied. Allow mic for this site and reload.</p>
        ) : null}
        {error ? <p className="text-caption text-danger-700 text-center max-w-sm">{error}</p> : null}
      </section>

      {showSkip ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-xl bg-even-white p-5">
            <p className="text-label text-even-navy-800 mb-2">Skip voice setup?</p>
            <p className="text-caption text-even-ink-500 mb-4">
              Your voice won&apos;t be identified by name in recordings until you enroll. You can set this up later from the home screen.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowSkip(false)}>Keep setting up</Button>
              <Button variant="primary" size="sm" onClick={skip}>Skip for now</Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
