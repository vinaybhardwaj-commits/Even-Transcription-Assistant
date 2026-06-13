"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMediaRecorder } from "@/lib/use-media-recorder";
import { Button } from "@/components/ui/Button";

/**
 * VoiceEnrollClient — voice-enrollment wizard (V2.SD.1 + recording-evidence).
 * Six English sentences recorded one at a time; each is a standalone webm clip.
 * On finish all clips POST to `enrollUrl` → Mac Mini /enroll ×N → centroid →
 * voice_print.
 *
 * Two contexts via props:
 *  - doctor self-serve (/{slug}/onboarding/voice): enrollUrl=/{slug}/api/voice/enroll,
 *    doneUrl=/{slug}/record, skip-confirm → /record.
 *  - admin kiosk (/admin/doctors/[id]/voice): enrollUrl=/api/admin/doctors/[id]/voice-enroll,
 *    doneUrl/cancelUrl=/admin/doctors, "Back to doctors" instead of skip.
 *
 * Recording evidence: live mic level meter (AnalyserNode) + elapsed timer +
 * pulsing red dot + live English transcription (via `transcribeUrl`).
 */

const SENTENCES = [
  "The quick brown fox jumps over the lazy dog.",
  "She sells seashells by the seashore.",
  "How razorback-jumping frogs can level six piqued gymnasts.",
  "The patient reports intermittent chest discomfort for two weeks.",
  "Heart sounds are normal with no audible murmurs or gallops.",
  "Please follow up in one week with the results of the lab tests.",
];

type Props = {
  doctorName: string;
  enrollUrl: string;
  doneUrl: string;
  context: "doctor" | "admin";
  cancelUrl?: string;
  transcribeUrl?: string;
};

export function VoiceEnrollClient({ doctorName, enrollUrl, doneUrl, context, cancelUrl, transcribeUrl }: Props) {
  const router = useRouter();
  const [idx, setIdx] = React.useState(0);
  const [clips, setClips] = React.useState<(Blob | null)[]>(() => Array(SENTENCES.length).fill(null));
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showSkip, setShowSkip] = React.useState(false);
  const [level, setLevel] = React.useState(0);
  const [elapsed, setElapsed] = React.useState(0);
  const [liveText, setLiveText] = React.useState("");
  const chunksRef = React.useRef<Blob[]>([]);
  const mimeRef = React.useRef<string>("audio/webm");

  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const onStream = React.useCallback((stream: MediaStream | null) => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (audioCtxRef.current) { void audioCtxRef.current.close().catch(() => { /* intentional: closing AudioContext; failure is harmless */ }); audioCtxRef.current = null; }
    setLevel(0);
    if (!stream) return;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        setLevel(Math.min(1, rms * 3.2));
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch { /* meter is best-effort */ }
  }, []);

  const rec = useMediaRecorder({
    chunkMs: 1000,
    onStream,
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

  React.useEffect(() => {
    if (!recording) return;
    setElapsed(0);
    const t0 = Date.now();
    const h = setInterval(() => setElapsed((Date.now() - t0) / 1000), 200);
    return () => clearInterval(h);
  }, [recording]);

  const sendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!recording || !transcribeUrl) return;
    const h = setInterval(async () => {
      if (sendingRef.current || chunksRef.current.length === 0) return;
      sendingRef.current = true;
      try {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        const fd = new FormData();
        fd.append("audio", blob, "win.webm");
        const r = await fetch(transcribeUrl, { method: "POST", body: fd });
        const j = (await r.json().catch(() => ({}))) as { data?: { text?: string }; text?: string };
        const text = j?.data?.text ?? j?.text ?? "";
        if (text) setLiveText(text);
      } catch { /* best-effort */ } finally { sendingRef.current = false; }
    }, 1600);
    return () => clearInterval(h);
  }, [recording, transcribeUrl]);

  React.useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    if (audioCtxRef.current) void audioCtxRef.current.close().catch(() => { /* intentional: closing AudioContext; failure is harmless */ });
  }, []);

  const startRec = React.useCallback(() => {
    chunksRef.current = [];
    setError(null);
    setLiveText("");
    void rec.start();
  }, [rec]);

  const stopRec = React.useCallback(async () => {
    await rec.stop();
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    chunksRef.current = [];
    if (blob.size === 0) { setError("Nothing recorded — try again."); return; }
    setClips((prev) => { const next = [...prev]; next[idx] = blob; return next; });
  }, [rec, idx]);

  const finish = React.useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      clips.forEach((c, i) => { if (c) form.append(`clip_${i}`, c, `clip_${i}.webm`); });
      const res = await fetch(enrollUrl, { method: "POST", body: form });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: { ok?: boolean }; error?: { message?: string } };
      const ok = json?.ok ?? json?.data?.ok;
      if (!res.ok || !ok) { setError(json?.error?.message || `Enrollment failed (${res.status})`); setSubmitting(false); return; }
      if (context === "doctor") { try { sessionStorage.setItem("eta:voice_enrolled", "1"); } catch { /* noop */ } }
      router.push(doneUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [clips, enrollUrl, doneUrl, context, router]);

  const skip = React.useCallback(() => {
    if (context === "doctor") { try { sessionStorage.setItem("eta:voice_enroll_skipped", "1"); } catch { /* noop */ } }
    router.push(cancelUrl ?? doneUrl);
  }, [context, cancelUrl, doneUrl, router]);

  const backLabel = context === "admin" ? "Back to doctors" : "Skip for now";

  return (
    <main className="min-h-screen bg-even-ink-50 flex flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-even-ink-100 bg-even-white/90 px-4 py-3 backdrop-blur">
        <span className="text-label text-even-navy-800">Voice setup · Dr {doctorName}</span>
        <button type="button" onClick={() => (context === "admin" ? skip() : setShowSkip(true))} className="text-caption text-even-ink-400 hover:text-even-ink-600">
          {backLabel}
        </button>
      </header>

      <section className="flex-1 flex flex-col items-center px-6 py-8 gap-6 max-w-xl mx-auto w-full">
        <div>
          <h1 className="text-display text-even-navy-800 text-center">Set up voice recognition</h1>
          <p className="text-caption text-even-ink-500 text-center mt-2">
            {context === "admin"
              ? `Have Dr ${doctorName} read ${SENTENCES.length} short sentences aloud (~90 seconds) at this mic. This lets the app label them in recordings. English only for now.`
              : `Read ${SENTENCES.length} short sentences aloud (~90 seconds). This lets the app label you in recordings. English only for now.`}
          </p>
        </div>

        <div className="flex items-center gap-2" aria-label={`Sentence ${idx + 1} of ${SENTENCES.length}`}>
          {SENTENCES.map((_, i) => (
            <span key={i} className={`h-2.5 w-2.5 rounded-full ${clips[i] ? "bg-success-500" : i === idx ? "bg-even-blue-600" : "bg-even-ink-200"}`} />
          ))}
        </div>

        <div className="w-full rounded-2xl border border-even-ink-100 bg-even-white p-6 text-center shadow-soft">
          <p className="text-caption text-even-ink-400 mb-2">Sentence {idx + 1} of {SENTENCES.length}{idx >= 3 ? " · clinical" : ""}</p>
          <p className="text-[22px] leading-relaxed text-even-navy-800" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
            {"“"}{SENTENCES[idx]}{"”"}
          </p>
        </div>

        {recording ? (
          <div className="w-full rounded-2xl border border-danger-500 bg-danger-100/40 p-4 flex flex-col gap-3 shadow-soft">
            <div className="flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full rounded-full bg-danger-500 opacity-75 animate-ping" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-danger-500" />
              </span>
              <span className="text-label text-danger-700">Recording</span>
              <span className="ml-auto text-caption tabular-nums text-even-ink-600">{elapsed.toFixed(1)}s</span>
            </div>
            <div className="flex items-end gap-[3px] h-8" aria-hidden>
              {Array.from({ length: 28 }).map((_, i) => {
                const center = Math.abs(i - 13.5) / 13.5;
                const gain = level * (1.1 - center * 0.6);
                const hPct = Math.max(6, Math.min(100, gain * 140));
                const lit = level > 0.04 + center * 0.12;
                return (
                  <span key={i} className="flex-1 rounded-sm transition-all duration-75" style={{ height: `${hPct}%`, backgroundColor: lit ? "#EF4444" : "#FCA5A5", opacity: lit ? 1 : 0.5 }} />
                );
              })}
            </div>
            {transcribeUrl ? (
              <p className="text-caption text-even-ink-600 min-h-[1.2em]">
                {liveText ? liveText : <span className="text-even-ink-400">Listening…</span>}
              </p>
            ) : null}
          </div>
        ) : null}

        {!recording ? (
          <Button variant="primary" size="lg" onClick={startRec} className="w-full max-w-xs" disabled={submitting}>
            {clips[idx] ? "Re-record this sentence" : "Tap to record"}
          </Button>
        ) : (
          <Button variant="destructive" size="lg" onClick={() => void stopRec()} className="w-full max-w-xs">
            Stop
          </Button>
        )}

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
