"use client";

import * as React from "react";

/**
 * SarvamTranscript — near-live original-language transcript panel.
 *
 * Shown when Sarvam is producing text (i.e. an Indian-language encounter,
 * where Deepgram's English-only live transcript stays blank). Displays the
 * accumulated original script as it streams in, with the detected language.
 * The doctor's workflow is unchanged — this panel just fills in where the
 * English live transcript can't.
 */

type Props = {
  text: string;
  language: string | null;
  latencyMs: number | null;
  error: string | null;
  engine?: string;   // default "Sarvam"
  heading?: string;  // default "Live transcript"
  tone?: "blue" | "navy";  // default blue
};

const LANG_NAMES: Record<string, string> = {
  "kn-IN": "Kannada", "hi-IN": "Hindi", "ta-IN": "Tamil", "te-IN": "Telugu",
  "ml-IN": "Malayalam", "mr-IN": "Marathi", "bn-IN": "Bengali", "gu-IN": "Gujarati",
  "pa-IN": "Punjabi", "od-IN": "Odia", "ur-IN": "Urdu", "en-IN": "English",
};

export function SarvamTranscript({ text, language, latencyMs, error, engine = "Sarvam", heading = "Live transcript", tone = "blue" }: Props) {
  const wrap = tone === "navy" ? "border-even-navy-200 bg-even-navy-50" : "border-even-blue-200 bg-even-blue-50";
  const head = tone === "navy" ? "text-even-navy-900" : "text-even-navy-800";
  if (!text && !error) return null;
  const langLabel = language ? (LANG_NAMES[language] ?? language) : null;

  return (
    <div className={`rounded-2xl border ${wrap} p-3.5`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-caption font-medium ${head}`}>
          {heading}{langLabel ? ` · ${langLabel}` : ""}
        </span>
        <span className="text-caption text-even-ink-400">
          {engine}{latencyMs != null ? ` · ${(latencyMs / 1000).toFixed(1)}s` : ""}
        </span>
      </div>
      {text ? (
        <p className="text-body text-even-ink-800 whitespace-pre-wrap leading-relaxed">{text}</p>
      ) : (
        <p className="text-caption text-even-ink-400 italic">Listening…</p>
      )}
      {error ? (
        <p className="text-caption text-danger-700 mt-1">{engine}: {error}</p>
      ) : null}
    </div>
  );
}
