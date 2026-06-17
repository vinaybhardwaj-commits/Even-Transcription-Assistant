"use client";

import * as React from "react";

/**
 * useMicLevel — live microphone input level (RMS, 0..1) from a MediaStream via
 * a passive AnalyserNode. Used by the pre-flight mic gate so the doctor can SEE
 * their voice move a meter before a recording is allowed to start (a dead/muted
 * mic shows a flat meter and blocks the start).
 *
 * SSR- and Safari-safe (webkitAudioContext fallback; context.resume() best-effort
 * for iOS, where the context can start suspended until a user gesture).
 *
 * NOTE: an AnalyserNode is a read-only tap, not a processing node — unlike the
 * Sarvam streaming worklet it does NOT pull/consume the track, so it is safe to
 * run alongside MediaRecorder. We still only use it on a STANDALONE pre-flight
 * stream (not the recorder's stream) to keep the live capture path untouched.
 *
 * Pass null to tear everything down.
 */
type MicLevel = { level: number; peak: number; active: boolean };

function audioCtxCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext || w.webkitAudioContext;
}

export function useMicLevel(stream: MediaStream | null): MicLevel {
  const [level, setLevel] = React.useState(0);
  const [peak, setPeak] = React.useState(0);
  const [active, setActive] = React.useState(false);

  React.useEffect(() => {
    if (!stream) { setLevel(0); setActive(false); return; }
    const Ctor = audioCtxCtor();
    if (!Ctor) { setActive(false); return; }

    let raf = 0;
    let stopped = false;
    let ctx: AudioContext | null = null;
    let src: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let peakSeen = 0;
    let lastEmit = 0;

    try {
      ctx = new Ctor();
      void ctx.resume?.()?.catch?.(() => {});
      src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      setActive(true);
      const tick = () => {
        if (stopped || !analyser) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > peakSeen) { peakSeen = rms; setPeak(rms); }
        // Throttle level state updates to ~12/s (the meter doesn't need 60fps).
        const now = Date.now();
        if (now - lastEmit > 80) { lastEmit = now; setLevel(rms); }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch {
      setActive(false);
    }

    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      try { src?.disconnect(); } catch { /* noop */ }
      try { analyser?.disconnect(); } catch { /* noop */ }
      try { void ctx?.close(); } catch { /* noop */ }
    };
  }, [stream]);

  return { level, peak, active };
}
