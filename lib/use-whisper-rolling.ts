"use client";

import * as React from "react";

/**
 * useWhisperRolling — rolling cumulative pass to whisper.cpp on the
 * Mac Mini for higher-accuracy transcription of medical terms.
 *
 * Strategy: cumulative-from-zero. Every intervalMs (default 10s), if
 * new chunks have arrived since the last pass, we concatenate ALL
 * chunks since enable and POST as one WebM blob. The response replaces
 * the in-flight transcript state. (MediaRecorder only writes the WebM
 * container header in the first chunk, so windowed-from-middle slices
 * are not standalone-playable. Cumulative-from-zero sidesteps this.)
 *
 * Trade-off: linearly growing payload + processing time as the visit
 * lengthens. At 5min visit on whisper-large-v3-turbo this is ~5-8s
 * per pass — still well under the 60s function timeout.
 */

export type WhisperPass = {
  pass_idx: number;
  text: string;
  language: string | null;
  duration_seconds: number | null;
  latency_ms: number;
  bytes: number;
  received_at: number; // client ms epoch when response arrived
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
  const lastSeenChunksRef = React.useRef(0); // count at last pass
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
    if (all.length === 0 || all.length === lastSeenChunksRef.current) return;
    lastSeenChunksRef.current = all.length;
    inFlightRef.current = true;
    setState("in_flight");

    const idx = ++passIdxRef.current;
    const blob = new Blob(all, { type: mimeRef.current });

    try {
      const form = new FormData();
      form.append("audio", blob, `pass_${idx}.webm`);
      form.append("pass_idx", String(idx));
      if (optsRef.current.encounterId) {
        form.append("encounter_id", optsRef.current.encounterId);
      }

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
        pass_idx?: string;
      };
      const pass: WhisperPass = {
        pass_idx: idx,
        text: (json.text ?? "").trim(),
        language: json.language ?? null,
        duration_seconds: json.duration_seconds ?? null,
        latency_ms: json.latency_ms ?? 0,
        bytes: json.bytes ?? blob.size,
        received_at: Date.now(),
      };
      setLatest(pass);
      optsRef.current.onPass?.(pass);
      setState("running");
      setError(null);
    } catch (e) {
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
