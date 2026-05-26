"use client";

import * as React from "react";

type Mode = "idle" | "recording" | "paused" | "busy";

export function RecordButton({
  mode,
  onClick,
  ariaLabel,
}: {
  mode: Mode;
  onClick: () => void;
  ariaLabel: string;
}) {
  const base = "w-44 h-44 rounded-full flex flex-col items-center justify-center gap-2 shadow-card-hover focus:outline-none focus:ring-4 focus:ring-even-blue-300 transition disabled:opacity-50";
  const cls =
    mode === "recording"
      ? "bg-danger-500 hover:bg-danger-700 text-white animate-pulse"
      : mode === "paused"
      ? "bg-warning-500 hover:bg-warning-700 text-white"
      : mode === "busy"
      ? "bg-even-ink-300 text-white"
      : "bg-even-blue-600 text-white hover:bg-even-blue-700";

  const glyph =
    mode === "recording" ? "■" : mode === "paused" ? "▶" : mode === "busy" ? "…" : "●";
  const label =
    mode === "recording" ? "Stop" : mode === "paused" ? "Resume" : mode === "busy" ? "Working" : "Record";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={mode === "busy"}
      className={`${base} ${cls}`}
      aria-label={ariaLabel}
    >
      <span className="text-5xl leading-none" aria-hidden="true">
        {glyph}
      </span>
      <span className="text-label">{label}</span>
    </button>
  );
}
