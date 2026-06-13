"use client";

import * as React from "react";
import { TRIM_LIVE_BUFFERS } from "@/lib/live-flags";
import { boundedWindowStart, MAX_WINDOW_BYTES } from "@/lib/live-window";

/**
 * useIndicRolling — near-live PURE NATIVE-SCRIPT transcription via AI4Bharat
 * IndicConformer (Mac-Mini), running in parallel with the Sarvam code-mix box.
 *
 * IndicConformer needs an EXPLICIT language and does not auto-detect, so this
 * hook stays idle until Sarvam has locked a non-English language, then sends
 * decodable webm windows to /indic-live with that language. Same growing-window
 * refine+commit + byte-cap model as useSarvamRolling (so windows stay under
 * Vercel's payload cap and the tail self-heals across tick boundaries).
 *
 * It does NOT feed the note — purely the live original-script display. Soft-fail.
 */
export type IndicBlock = { block_idx: number; text: string | null; latency_ms: number; received_at: number };
export type IndicRollingState = "idle" | "running" | "in_flight" | "error" | "stopped";

type Options = {
  slug: string;
  enabled: boolean;
  language: string | null;     // the language Sarvam has locked (IN-22, e.g. "hi-IN")
  intervalMs?: number;
};

const CHUNK_MS = 250;
const COMMIT_SECONDS = 22;
const COMMIT_CHUNKS = Math.round((COMMIT_SECONDS * 1000) / CHUNK_MS);

function isIndicLang(lang: string | null): boolean {
  if (!lang) return false;
  const c = lang.toLowerCase().split(/[-_]/)[0];
  return c.length >= 2 && c !== "en";
}

export function useIndicRolling(opts: Options) {
  const intervalMs = opts.intervalMs ?? 2_000;
  const [state, setState] = React.useState<IndicRollingState>("idle");
  const [text, setText] = React.useState("");
  const [latest, setLatest] = React.useState<IndicBlock | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const chunksRef = React.useRef<Blob[]>([]);
  const headerRef = React.useRef<Blob | null>(null);
  const mimeRef = React.useRef<string>("audio/webm");
  const committedRef = React.useRef<string>("");
  const watermarkRef = React.useRef(0);
  const baseRef = React.useRef(0);
  const blockIdxRef = React.useRef(0);
  const inFlightRef = React.useRef(false);
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
    const lang = optsRef.current.language;
    if (!isIndicLang(lang)) return; // wait for Sarvam to lock a non-English language
    const all = chunksRef.current;
    const base = baseRef.current;
    const start = watermarkRef.current;
    const end = base + all.length;
    if (end <= start) return;

    inFlightRef.current = true;
    setState("in_flight");
    const idx = ++blockIdxRef.current;

    const headerSize = start > 0 && headerRef.current ? headerRef.current.size : 0;
    const effStart = boundedWindowStart(all.map((b) => b.size), start, base, headerSize, MAX_WINDOW_BYTES);
    const forcedAdvance = effStart > start;

    const parts =
      effStart === 0
        ? all.slice(0, end - base)
        : headerRef.current
          ? [headerRef.current, ...all.slice(effStart - base, end - base)]
          : all.slice(effStart - base, end - base);
    const blob = new Blob(parts, { type: mimeRef.current });

    try {
      const form = new FormData();
      form.append("audio", blob, `indic_block_${idx}.webm`);
      form.append("block_idx", String(idx));
      form.append("language", lang as string);
      const res = await fetch(`/${optsRef.current.slug}/api/transcribe/indic-live`, { method: "POST", body: form, cache: "no-store" });
      if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`http_${res.status}: ${t.slice(0, 120)}`); }
      const json = (await res.json()) as { text?: string | null; latency_ms?: number };
      const tail = (json.text ?? "").trim();
      setText(`${committedRef.current}${committedRef.current && tail ? " " : ""}${tail}`.trim());
      const block: IndicBlock = { block_idx: idx, text: tail || null, latency_ms: json.latency_ms ?? 0, received_at: Date.now() };
      setLatest(block);
      setState("running");
      setError(null);

      const shouldCommit = end - start >= COMMIT_CHUNKS || forcedAdvance;
      if (shouldCommit) {
        if (tail) committedRef.current = `${committedRef.current}${committedRef.current ? " " : ""}${tail}`.trim();
        watermarkRef.current = end;
        if (TRIM_LIVE_BUFFERS) {
          const consumed = watermarkRef.current - baseRef.current;
          if (consumed > 0) { all.splice(0, consumed); baseRef.current += consumed; }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  React.useEffect(() => {
    if (!opts.enabled) { setState("stopped"); return; }
    setState("running");
    const id = window.setInterval(() => { void flush(); }, intervalMs);
    return () => { window.clearInterval(id); void flush(); };
  }, [opts.enabled, intervalMs, flush]);

  return { state, text, latest, error, sendChunk };
}
