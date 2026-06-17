"use client";

import * as React from "react";
import { useFlashTranslate } from "@/lib/use-flash-translate";

/**
 * LiveTranscript — the primary live panel for non-English encounters.
 *
 * Default view is "As spoken": the code-mixed/native transcript AS SPOKEN (no
 * translation to mangle) — the honest, accurate live view. A toggle switches to
 * "English (AI)", a Gemini-Flash translation of the accumulated text (coherent,
 * full-context) — replacing the old per-window Sarvam translation that produced
 * gibberish. Display-only; the note is built from the fused transcript at submit.
 */
const LANG_NAMES: Record<string, string> = {
  "kn-IN": "Kannada", "hi-IN": "Hindi", "ta-IN": "Tamil", "te-IN": "Telugu",
  "ml-IN": "Malayalam", "mr-IN": "Marathi", "bn-IN": "Bengali", "gu-IN": "Gujarati",
  "pa-IN": "Punjabi", "od-IN": "Odia", "ur-IN": "Urdu", "en-IN": "English",
};

type Props = {
  slug: string;
  nativeText: string;
  language: string | null;
  error: string | null;
  engine?: string;
  heading?: string;
  flashEnabled?: boolean;
};

export function LiveTranscript({
  slug, nativeText, language, error, engine = "Sarvam", heading = "Live transcript", flashEnabled = true,
}: Props) {
  const [view, setView] = React.useState<"native" | "english">("native");
  const showEnglish = view === "english";
  const flash = useFlashTranslate({ slug, text: nativeText, enabled: flashEnabled && showEnglish, intervalMs: 6000 });

  if (!nativeText && !error) return null;
  const langLabel = language ? (LANG_NAMES[language] ?? language) : null;
  const body = showEnglish ? flash.english : nativeText;

  return (
    <div className="rounded-2xl border border-even-blue-200 bg-even-blue-50 p-3.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-caption font-medium text-even-navy-800">
          {showEnglish ? `${heading} · English (AI)` : `${heading}${langLabel ? ` · ${langLabel}` : ""}`}
        </span>
        <div className="flex items-center gap-2">
          {flashEnabled ? (
            <div className="flex overflow-hidden rounded-full border border-even-ink-200 bg-even-white text-[11px]">
              <button
                type="button"
                onClick={() => setView("native")}
                className={`px-2 py-0.5 ${!showEnglish ? "bg-even-blue-600 text-white" : "text-even-ink-500"}`}
              >
                As spoken
              </button>
              <button
                type="button"
                onClick={() => setView("english")}
                className={`px-2 py-0.5 ${showEnglish ? "bg-even-blue-600 text-white" : "text-even-ink-500"}`}
              >
                English
              </button>
            </div>
          ) : null}
          <span className="text-caption text-even-ink-400">
            {showEnglish ? (flash.loading ? "Gemini…" : "Gemini") : engine}
          </span>
        </div>
      </div>
      {body ? (
        <p className="text-body text-even-ink-800 whitespace-pre-wrap leading-relaxed">{body}</p>
      ) : showEnglish ? (
        <p className="text-caption text-even-ink-400 italic">
          {flash.off ? "Live English translation unavailable." : "Translating…"}
        </p>
      ) : (
        <p className="text-caption text-even-ink-400 italic">Listening…</p>
      )}
      {error && !showEnglish ? (
        <p className="text-caption text-danger-700 mt-1">{engine}: {error}</p>
      ) : null}
    </div>
  );
}
