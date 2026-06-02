"use client";

import * as React from "react";
import { TRIM_LIVE_BUFFERS } from "@/lib/live-flags";

/**
 * useWhisperRolling — rolling Whisper transcription via delta uploads
 * with a server-side R2 buffer (B7 fix).
 *
 * Strategy (post-B7): each pass sends ONLY the new chunks since the
 * last pass. The server maintains a per-encounter WebM buffer in R2
 * at `whisper-buffer/{encounter_id}.webm`, appends new chunks to the
 * existing buffer, and runs whisper.cpp on the full concatenated
 * audio. The cumulative blob NEVER traverses the client → Vercel
 * boundary as one request, so the Vercel serverless 4.5 MB body
 * limit no longer caps recording length.
 *
 * Why the WebM container is still valid: whisper.cpp needs the WebM
 * init segment (cluster header + codec config) which MediaRecorder
 * writes ONLY in the first chunk. The is_first flag tells the server
 * "this delta starts a new buffer." Subsequent passes append raw
 * MediaRecorder output to the existing buffer server-side — the
 * resulting concatenated blob is the same shape as the old
 * cumulative-from-zero blob, just assembled server-side.
 *
 * Self-healing: if a pass fails (network blip, 5xx from Mac Mini)
 * we DO NOT advance nextChunkIdxRef, so the next interval tick
 * retries from the same delta start plus anything new. Pre-B7 the
 * rolling would silently freeze at the last good pass and never
 * recover; now any single failure recovers on the next tick.
 */

export type WhisperPass = {
  pass_idx: number;
  text: string;
  language: string | null;
  duration_seconds: number | null;
  latency_ms: number;
  bytes: number;            // size of delta sent THIS pass (not cumulative)
  cumulative_bytes: number; // server-reported total buffer size
  received_at: number;
};

export type WhisperRollingState =
  | "idle"
  | "running"
  | "in_flight"
  | "error"
  | "stopped";

type Options = {
  slug: string;
  enabled: boolean;
  encounterId?: string;
  intervalMs?: number;
  onPass?: (p: WhisperPass) => void;
  onError?: (e: Error) => void;
};

export function useWhisperRolling(opts: Options) {
  const intervalMs = opts.intervalMs ?? 10_000;
  const [state, setState] = React.useState<WhisperRollingState>("idle");
  const [latest, setLatest] = React.useState<WhisperPass | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const chunksRef = React.useRef<Blob[]>([]);
  const mimeRef = React.useRef<string>("audio/webm");
  const passIdxRef = React.useRef(0);
  // Index of the next chunk to send. After a successful POST we advance
  // this to chunksRef.current.length. On failure we leave it untouched
  // so the next tick retries the same range + anything that's arrived
  // since.
  const nextChunkIdxRef = React.useRef(0);
  // Absolute index of chunksRef.current[0]. Stays 0 unless TRIM_LIVE_BUFFERS
  // drops consumed (already-uploaded) chunks off the front to bound memory.
  const baseRef = React.useRef(0);
  const inFlightRef = React.useRef(false);
  const optsRef = React.useRef(opts);
  React.useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const sendChunk = React.useCallback((chunk: Blob) => {
    if (!chunk || chunk.size === 0) return;
    chunksRef.current.push(chunk);
    if (chunk.type) mimeRef.current = chunk.type;
  }, []);

  const flush = React.useCallback(async () => {
    if (inFlightRef.current) return;
    const all = chunksRef.current;
    const base = baseRef.current;
    const startIdx = nextChunkIdxRef.current;
    const endIdx = base + all.length;
    if (endIdx === startIdx) return;          // no new chunks since last pass
    if (!optsRef.current.encounterId) return; // delta uploads need an encounter to key the R2 buffer

    inFlightRef.current = true;
    setState("in_flight");

    const idx = ++passIdxRef.current;
    const delta = all.slice(startIdx - base, endIdx - base);
    const isFirst = startIdx === 0;
    const blob = new Blob(delta, { type: mimeRef.current });

    try {
      const form = new FormData();
      form.append("audio", blob, `delta_${idx}.webm`);
      form.append("pass_idx", String(idx));
      form.append("encounter_id", optsRef.current.encounterId);
      form.append("is_first", isFirst ? "1" : "0");
      form.append("delta_start_idx", String(startIdx));
      form.append("delta_end_idx", String(endIdx));

      const res = await fetch(
        `/${optsRef.current.slug}/api/transcribe/whisper-chunk`,
        { method: "POST", body: form, cache: "no-store" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`http_${res.status}: ${text.slice(0, 120)}`);
      }
      const json = (await res.json()) as {
        text?: string;
        language?: string | null;
        duration_seconds?: number | null;
        latency_ms?: number;
        bytes?: number;
        cumulative_bytes?: number;
        pass_idx?: string;
      };
      // Pass succeeded — advance the watermark so we don't resend this delta.
      nextChunkIdxRef.current = endIdx;
      // Bound memory: drop uploaded chunks off the front. The server R2 buffer
      // already holds them (incl. the WebM header from the first delta), and we
      // never re-read consumed chunks here. The canonical upload copies (IDB +
      // RecordingScreen chunksMemRef) are separate and untouched.
      if (TRIM_LIVE_BUFFERS) {
        const consumed = nextChunkIdxRef.current - baseRef.current;
        if (consumed > 0) { all.splice(0, consumed); baseRef.current += consumed; }
      }
      const pass: WhisperPass = {
        pass_idx: idx,
        text: (json.text ?? "").trim(),
        language: json.language ?? null,
        duration_seconds: json.duration_seconds ?? null,
        latency_ms: json.latency_ms ?? 0,
        bytes: json.bytes ?? blob.size,
        cumulative_bytes: json.cumulative_bytes ?? 0,
        received_at: Date.now(),
      };
      setLatest(pass);
      optsRef.current.onPass?.(pass);
      setState("running");
      setError(null);
    } catch (e) {
      // Failure: DO NOT advance nextChunkIdxRef. Next tick retries the
      // same delta range plus any new chunks that have arrived since.
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setState("error");
      optsRef.current.onError?.(new Error(msg));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  // Interval driver — only when enabled
  React.useEffect(() => {
    if (!opts.enabled) {
      setState("stopped");
      return;
    }
    setState("running");
    const id = window.setInterval(() => {
      void flush();
    }, intervalMs);
    return () => {
      window.clearInterval(id);
      // one final flush attempt on cleanup so we don't lose the tail
      void flush();
    };
  }, [opts.enabled, intervalMs, flush]);

  return { state, latest, error, sendChunk, flushNow: flush };
}
