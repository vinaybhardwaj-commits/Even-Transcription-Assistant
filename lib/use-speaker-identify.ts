"use client";

import * as React from "react";

/**
 * useSpeakerIdentify — V2.SD.2 live clinician identification for the Speakers
 * pill. Every `intervalMs`, sends a short recent audio window (header chunk +
 * last ~8s) to /api/voice/identify, which embeds it (Mac Mini /enroll) and
 * compares to the doctor's stored voice_print centroid. Surfaces whether the
 * clinician is identified + the best confidence. Latches once identified.
 */

type Options = { slug: string; enabled: boolean; intervalMs?: number; windowChunks?: number };

export function useSpeakerIdentify(opts: Options) {
  const intervalMs = opts.intervalMs ?? 8000;
  const windowChunks = opts.windowChunks ?? 36; // ~9s at 250ms
  const [enrolled, setEnrolled] = React.useState<boolean | null>(null);
  const [name, setName] = React.useState<string | null>(null);
  const [confidence, setConfidence] = React.useState<number | null>(null);
  const [identified, setIdentified] = React.useState(false);

  const chunksRef = React.useRef<Blob[]>([]);
  const headerRef = React.useRef<Blob | null>(null);
  const mimeRef = React.useRef("audio/webm");
  const inFlightRef = React.useRef(false);
  const bestRef = React.useRef(0);
  const optsRef = React.useRef(opts);
  React.useEffect(() => { optsRef.current = opts; }, [opts]);

  const sendChunk = React.useCallback((chunk: Blob) => {
    if (!chunk || chunk.size === 0) return;
    if (chunksRef.current.length === 0) headerRef.current = chunk;
    chunksRef.current.push(chunk);
    if (chunk.type) mimeRef.current = chunk.type;
  }, []);

  const flush = React.useCallback(async () => {
    if (inFlightRef.current) return;
    const all = chunksRef.current;
    if (all.length < 2) return;
    inFlightRef.current = true;
    try {
      const tail = all.slice(Math.max(1, all.length - windowChunks));
      const parts = headerRef.current ? [headerRef.current, ...tail] : tail;
      const blob = new Blob(parts, { type: mimeRef.current });
      const form = new FormData();
      form.append("audio", blob, "id_window.webm");
      const res = await fetch(`/${optsRef.current.slug}/api/voice/identify`, { method: "POST", body: form, cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { enrolled?: boolean; name?: string | null; confidence?: number | null; identified?: boolean };
      setEnrolled(!!j.enrolled);
      if (j.name) setName(j.name);
      if (typeof j.confidence === "number") {
        if (j.confidence > bestRef.current) { bestRef.current = j.confidence; setConfidence(j.confidence); }
      }
      if (j.identified) setIdentified(true);
    } catch {
      /* non-critical */
    } finally {
      inFlightRef.current = false;
    }
  }, [windowChunks]);

  React.useEffect(() => {
    if (!opts.enabled) return;
    const id = window.setInterval(() => { void flush(); }, intervalMs);
    return () => window.clearInterval(id);
  }, [opts.enabled, intervalMs, flush]);

  return { enrolled, name, confidence, identified, sendChunk };
}
