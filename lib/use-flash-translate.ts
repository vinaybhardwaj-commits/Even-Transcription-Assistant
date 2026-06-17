"use client";

import * as React from "react";

/**
 * useFlashTranslate — rolling LIVE English translation via Gemini Flash.
 *
 * When `enabled` (the doctor toggled the live transcript to "English (AI)"),
 * POSTs the accumulated as-spoken text to /{slug}/api/translate-live on a fixed
 * cadence and exposes the latest clean English. Translating the WHOLE accumulated
 * text each tick (with full context) is what makes it coherent — unlike the old
 * per-window Sarvam translation. Disabled = no calls (zero cost/latency).
 */
export function useFlashTranslate(opts: {
  slug: string;
  text: string;
  enabled: boolean;
  intervalMs?: number;
}): { english: string; loading: boolean; off: boolean } {
  const { slug, text, enabled, intervalMs = 6000 } = opts;
  const [english, setEnglish] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [off, setOff] = React.useState(false);
  const textRef = React.useRef(text);
  textRef.current = text;
  const lastSent = React.useRef("");
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = async () => {
      if (inFlight.current) return;
      const t = (textRef.current || "").trim();
      if (t.length < 8 || t === lastSent.current) return;
      inFlight.current = true;
      lastSent.current = t;
      setLoading(true);
      try {
        const res = await fetch(`/${slug}/api/translate-live`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: t }),
          cache: "no-store",
        });
        if (!cancelled && res.ok) {
          const j = (await res.json()) as { english?: string; provider?: string };
          if (j.provider === "off") setOff(true);
          if (typeof j.english === "string" && j.english.length > 0) setEnglish(j.english);
        }
      } catch {
        /* soft-fail: keep the last good English */
      } finally {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      }
    };

    void tick(); // translate immediately on toggle
    const iv = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [enabled, slug, intervalMs]);

  return { english, loading, off };
}
