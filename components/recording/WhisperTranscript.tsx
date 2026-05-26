"use client";

import * as React from "react";

type WhisperState = "idle" | "running" | "in_flight" | "error" | "stopped";

export function WhisperTranscript({
  state,
  text,
  latencyMs,
  passIdx,
  language,
  bytes,
  error,
}: {
  state: WhisperState;
  text: string;
  latencyMs: number | null;
  passIdx: number | null;
  language: string | null;
  bytes: number | null;
  error: string | null;
}) {
  const [open, setOpen] = React.useState(false);

  const pillCls =
    state === "running"
      ? "bg-success-100 text-success-700"
      : state === "in_flight"
      ? "bg-even-blue-100 text-even-blue-700"
      : state === "error"
      ? "bg-danger-100 text-danger-700"
      : "bg-even-ink-100 text-even-ink-500";

  const pillLabel =
    state === "running"
      ? "Whisper · waiting"
      : state === "in_flight"
      ? "Whisper · transcribing…"
      : state === "error"
      ? "Whisper · error"
      : "Whisper · idle";

  return (
    <details
      className="rounded-md border border-even-ink-100 bg-even-white"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none flex items-center justify-between px-3 py-2 text-caption">
        <span className={`rounded-full px-2 py-0.5 ${pillCls}`}>{pillLabel}</span>
        <span className="text-even-ink-400">
          {passIdx ? `pass #${passIdx}` : "no pass yet"}
          {latencyMs != null ? ` · ${(latencyMs / 1000).toFixed(1)}s` : ""}
          {language ? ` · ${language}` : ""}
          {bytes != null ? ` · ${(bytes / 1024).toFixed(0)} KB` : ""}
        </span>
      </summary>
      <div className="px-3 pb-3 pt-1 text-body text-even-ink-700 max-h-[40vh] overflow-y-auto leading-relaxed whitespace-pre-wrap">
        {error ? (
          <span className="text-danger-700 text-caption">{error}</span>
        ) : text ? (
          text
        ) : (
          <span className="text-even-ink-400 italic">
            No Whisper pass yet — first cumulative pass happens ~10 s after recording starts.
          </span>
        )}
      </div>
    </details>
  );
}
