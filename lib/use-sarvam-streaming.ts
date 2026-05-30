"use client";

import * as React from "react";

/**
 * useSarvamStreaming — real-time multilingual live transcription via the Sarvam
 * streaming WebSocket (Saaras v3, codemix, VAD), through the Mac Mini relay.
 *
 * LANGUAGE STABILITY (fix): with language-code=unknown Sarvam re-detects the
 * language on every short VAD utterance, so a single-language conversation can
 * flip Marathi→Hindi→Kannada window-to-window (and misdetected windows produce
 * garbled/English output). So we AUTO-DETECT then LOCK: connect on `unknown`,
 * tally the detected language of the first few utterances, and once one Indian
 * language clearly dominates we reconnect with it pinned — the audio graph and
 * the accumulated transcript are preserved across the reconnect; only the
 * upstream socket is swapped. English stays inline either way (codemix).
 *
 * Public surface mirrors useSarvamRolling: { state, text, language, latest,
 * error, sendChunk } (sendChunk is a no-op — streaming uses the raw stream).
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
    let ctx: AudioContext | null = null;
    let node: AudioWorkletNode | null = null;
    let src: MediaStreamAudioSourceNode | null = null;
    let sink: GainNode | null = null;
    let ws: WebSocket | null = null;
    let flushTimer: number | null = null;

    // language auto-detect → lock
    const langCount = new Map<string, number>();
    let locked: string | null = null;
    let dataSeen = 0;

    const clearFlush = () => { if (flushTimer != null) { clearInterval(flushTimer); flushTimer = null; } };

    const openConnection = async (lang: string) => {
      const tr = await fetch(`/${optsRef.current.slug}/api/voice/stt-token`, { cache: "no-store" });
      const tj = (await tr.json().catch(() => ({}))) as { token?: string; relay_url?: string };
      const token = tj.token;
      const relay = (tj.relay_url || optsRef.current.relayUrl) as string;
      if (!token || !relay) throw new Error("no_token");
      if (cancelled) return;
      const url = `${relay.replace(/\/$/, "")}/ws?token=${encodeURIComponent(token)}&language-code=${encodeURIComponent(lang)}&mode=codemix`;
      const w = new WebSocket(url);
      ws = w;

      w.onopen = () => {
        if (cancelled) return;
        setState("live");
        clearFlush();
        flushTimer = window.setInterval(() => { try { w.readyState === WebSocket.OPEN && w.send(JSON.stringify({ type: "flush" })); } catch { /* noop */ } }, 1500);
      };
      w.onmessage = (ev) => {
        let r: { type?: string; data?: { transcript?: string; language_code?: string; signal_type?: string; metrics?: { processing_latency?: number } } };
        try { r = JSON.parse(String(ev.data)); } catch { return; }
        if (r.type === "data" && r.data?.transcript) {
          const t = r.data.transcript.trim();
          if (!t) return;
          committedRef.current = `${committedRef.current}${committedRef.current ? " " : ""}${t}`.trim();
          setText(committedRef.current);
          setLatest({ latency_ms: Math.round((r.data.metrics?.processing_latency ?? 0) * 1000) });
          setState("live");
          const lc = r.data.language_code || null;
          if (locked) {
            setLanguage(locked);
          } else if (lc) {
            setLanguage(lc);
            dataSeen += 1;
            if (lc !== "en-IN") langCount.set(lc, (langCount.get(lc) ?? 0) + 1);
            // lock once an Indian language clearly dominates (>=3 hits), or after
            // 8 utterances pick the most frequent non-English seen.
            let pick: string | null = null;
            for (const [l, n] of langCount) if (n >= 3) { pick = l; break; }
            if (!pick && dataSeen >= 8 && langCount.size > 0) {
              pick = [...langCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
            }
            if (pick) {
              locked = pick;
              setLanguage(pick);
              // swap the socket to the pinned language; keep audio + transcript
              try { w.close(); } catch { /* noop */ }
              clearFlush();
              void openConnection(pick).catch(() => {});
            }
          }
        } else if (r.type === "events") {
          if (r.data?.signal_type === "START_SPEECH") setState("listening");
        } else if (r.type === "error") {
          setState("error");
        }
      };
      w.onerror = () => { if (!cancelled) { setError("ws_error"); setState("error"); } };
      w.onclose = () => { /* may be an intentional lock-swap; ignore unless cancelled */ };
    };

    (async () => {
      setState("connecting");
      committedRef.current = "";
      setText("");
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new Ctx();
        await ctx.audioWorklet.addModule("/pcm16-worklet.js");
        if (cancelled) return;
        src = ctx.createMediaStreamSource(opts.stream!);
        node = new AudioWorkletNode(ctx, "pcm16-worklet");
        sink = ctx.createGain(); sink.gain.value = 0;
        src.connect(node); node.connect(sink); sink.connect(ctx.destination);
        node.port.onmessage = (e: MessageEvent) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          try { ws.send(JSON.stringify({ audio: { data: abToBase64(e.data as ArrayBuffer), sample_rate: "16000", encoding: "audio/wav" } })); } catch { /* noop */ }
        };
        await openConnection("unknown");
      } catch (e) {
        if (cancelled) return;
        const m = e instanceof Error ? e.message : String(e);
        setError(m); setState("error");
        optsRef.current.onError?.(new Error(m));
      }
    })();

    return () => {
      cancelled = true;
      clearFlush();
      try { ws?.close(); } catch { /* noop */ }
      try { node?.disconnect(); src?.disconnect(); sink?.disconnect(); } catch { /* noop */ }
      try { void ctx?.close(); } catch { /* noop */ }
    };
  }, [opts.enabled, opts.stream, opts.relayUrl]);

  const sendChunk = React.useCallback((_chunk: Blob) => { /* streaming uses the raw stream */ }, []);

  return { state, text, language, latest, error, sendChunk };
}
