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
  nonEnglish: boolean;
  error: string | null;
};

const LANG_NAMES: Record<string, string> = {
  "kn-IN": "Kannada", "hi-IN": "Hindi", "ta-IN": "Tamil", "te-IN": "Telugu",
  "ml-IN": "Malayalam", "mr-IN": "Marathi", "bn-IN": "Bengali", "gu-IN": "Gujarati",
  "pa-IN": "Punjabi", "od-IN": "Odia", "ur-IN": "Urdu", "en-IN": "English",
};

export function SarvamTranscript({ text, language, latencyMs, nonEnglish, error }: Props) {
  if (!text && !error) return null;
  const langLabel = language ? (LANG_NAMES[language] ?? language) : null;

  return (
    <div className="rounded-md border border-even-blue-200 bg-even-blue-50/40 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-caption font-medium text-even-navy-800">
          Live transcript{langLabel ? ` · ${langLabel}` : ""}{nonEnglish ? " (original script)" : ""}
        </span>
        <span className="text-caption text-even-ink-400">
          Sarvam{latencyMs != null ? ` · ${(latencyMs / 1000).toFixed(1)}s` : ""}
        </span>
      </div>
      {text ? (
        <p className="text-body text-even-ink-800 whitespace-pre-wrap leading-relaxed">{text}</p>
      ) : (
        <p className="text-caption text-even-ink-400 italic">Listening…</p>
      )}
      {error ? (
        <p className="text-caption text-danger-700 mt-1">Sarvam: {error}</p>
      ) : null}
    </div>
  );
}
