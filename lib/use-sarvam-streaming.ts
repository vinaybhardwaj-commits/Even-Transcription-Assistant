"use client";

import * as React from "react";

/**
 * useSarvamStreaming — true real-time multilingual live transcription via the
 * Sarvam streaming WebSocket (Saaras v3, codemix mode, VAD), routed through the
 * Mac Mini relay (browser can't set the auth header; Vercel can't hold a
 * socket). Mic audio is resampled to 16k mono PCM by an AudioWorklet and sent
 * as base64 frames; Sarvam returns one finalized codemix utterance per VAD
 * segment (~0.2s after each phrase), which we append into a continuous trace.
 *
 * Public surface mirrors useSarvamRolling so RecordingScreen can swap them:
 *   { state, text, language, latest, error, sendChunk }
 * (sendChunk is a no-op here — streaming consumes the raw MediaStream, not the
 * recorder's webm chunks.) Gated by NEXT_PUBLIC_STT_RELAY_URL; when unset or on
 * any failure the caller keeps the REST refine trace.
 */

export type SarvamStreamState = "idle" | "connecting" | "live" | "listening" | "error" | "stopped";

type Options = {
  slug: string;
  enabled: boolean;
  stream: MediaStream | null;
  relayUrl: string | null;
  onError?: (e: Error) => void;
};

function abToBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export function useSarvamStreaming(opts: Options) {
  const [state, setState] = React.useState<SarvamStreamState>("idle");
  const [text, setText] = React.useState("");
  const [language, setLanguage] = React.useState<string | null>(null);
  const [latest, setLatest] = React.useState<{ latency_ms: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const committedRef = React.useRef("");
  const optsRef = React.useRef(opts);
  React.useEffect(() => { optsRef.current = opts; }, [opts]);

  React.useEffect(() => {
    if (!opts.enabled || !opts.stream || !opts.relayUrl) { setState("stopped"); return; }

    let cancelled = false;
    let ws: WebSocket | null = null;
    let ctx: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;
    let src: MediaStreamAudioSourceNode | null = null;
    let sink: GainNode | null = null;
    let flushTimer: number | null = null;

    (async () => {
      setState("connecting");
      committedRef.current = "";
      setText("");
      try {
        const tr = await fetch("/api/voice/stt-token", { cache: "no-store" });
        const tj = (await tr.json().catch(() => ({}))) as { token?: string; relay_url?: string; error?: unknown };
        const token = tj.token;
        const relay = (tj.relay_url || opts.relayUrl) as string;
        if (!token || !relay) throw new Error("no_token");
        if (cancelled) return;

        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new Ctx();
        await ctx.audioWorklet.addModule("/pcm16-worklet.js");
        if (cancelled) return;
        src = ctx.createMediaStreamSource(opts.stream!);
        node = new AudioWorkletNode(ctx, "pcm16-worklet");
        sink = ctx.createGain(); sink.gain.value = 0;           // keep the graph pulling, silent
        src.connect(node); node.connect(sink); sink.connect(ctx.destination);

        const url = `${relay.replace(/\/$/, "")}/ws?token=${encodeURIComponent(token)}&language-code=unknown&mode=codemix`;
        ws = new WebSocket(url);

        ws.onopen = () => {
          if (cancelled) return;
          setState("live");
          flushTimer = window.setInterval(() => { try { ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "flush" })); } catch { /* noop */ } }, 1500);
        };
        ws.onmessage = (ev) => {
          let r: { type?: string; data?: { transcript?: string; language_code?: string; signal_type?: string; metrics?: { processing_latency?: number } } };
          try { r = JSON.parse(String(ev.data)); } catch { return; }
          if (r.type === "data" && r.data?.transcript) {
            const t = r.data.transcript.trim();
            if (t) {
              committedRef.current = `${committedRef.current}${committedRef.current ? " " : ""}${t}`.trim();
              setText(committedRef.current);
              if (r.data.language_code) setLanguage(r.data.language_code);
              setLatest({ latency_ms: Math.round((r.data.metrics?.processing_latency ?? 0) * 1000) });
              setState("live");
            }
          } else if (r.type === "events") {
            if (r.data?.signal_type === "START_SPEECH") setState("listening");
          } else if (r.type === "error") {
            setState("error");
          }
        };
        ws.onerror = () => { if (!cancelled) { setError("ws_error"); setState("error"); } };
        ws.onclose = () => { if (!cancelled) setState("stopped"); };

        node.port.onmessage = (e: MessageEvent) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.send(JSON.stringify({ audio: { data: abToBase64(e.data as ArrayBuffer), sample_rate: "16000", encoding: "audio/wav" } }));
          } catch { /* noop */ }
        };
      } catch (e) {
        if (cancelled) return;
        const m = e instanceof Error ? e.message : String(e);
        setError(m); setState("error");
        optsRef.current.onError?.(new Error(m));
      }
    })();

    return () => {
      cancelled = true;
      if (flushTimer != null) clearInterval(flushTimer);
      try { ws?.close(); } catch { /* noop */ }
      try { node?.disconnect(); src?.disconnect(); sink?.disconnect(); } catch { /* noop */ }
      try { void ctx?.close(); } catch { /* noop */ }
    };
  }, [opts.enabled, opts.stream, opts.relayUrl]);

  // sendChunk is a no-op (interface parity with useSarvamRolling)
  const sendChunk = React.useCallback((_chunk: Blob) => { /* streaming uses the raw stream */ }, []);

  return { state, text, language, latest, error, sendChunk };
}
