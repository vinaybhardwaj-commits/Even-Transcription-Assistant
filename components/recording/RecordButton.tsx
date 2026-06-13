"use client";

import * as React from "react";

type Mode = "idle" | "recording" | "paused" | "busy";

function Glyph({ mode }: { mode: Mode }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "h-10 w-10", "aria-hidden": true };
  if (mode === "recording") return (<svg viewBox="0 0 24 24" {...common}><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>);
  if (mode === "paused") return (<svg viewBox="0 0 24 24" {...common}><path d="M7 5l12 7l-12 7z" /></svg>);
  if (mode === "busy") return (<svg viewBox="0 0 24 24" {...common} className="h-9 w-9 animate-spin"><path d="M12 3a9 9 0 1 0 9 9" /></svg>);
  return (<svg viewBox="0 0 24 24" {...common}><path d="M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1 -6 0z" /><path d="M5 10a7 7 0 0 0 14 0" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>);
}

export function RecordButton({ mode, onClick, ariaLabel }: { mode: Mode; onClick: () => void; ariaLabel: string }) {
  const base = "relative w-44 h-44 rounded-full flex flex-col items-center justify-center gap-2 shadow-card-hover focus:outline-none focus:ring-4 focus:ring-even-blue-200 transition disabled:opacity-50";
  const cls =
    mode === "recording" ? "bg-danger-500 hover:bg-danger-700 text-white"
    : mode === "paused" ? "bg-warning-500 hover:bg-warning-700 text-white"
    : mode === "busy" ? "bg-even-ink-300 text-white"
    : "bg-even-blue-600 hover:bg-even-blue-700 active:bg-even-blue-800 text-white";
  const label = mode === "recording" ? "Stop" : mode === "paused" ? "Resume" : mode === "busy" ? "Working" : "Record";

  return (
    <button type="button" onClick={onClick} disabled={mode === "busy"} className={`${base} ${cls}`} aria-label={ariaLabel}>
      {mode === "recording" ? (
        <span className="pointer-events-none absolute inset-0 rounded-full ring-4 ring-danger-500/40 animate-ping" aria-hidden="true" />
      ) : null}
      <Glyph mode={mode} />
      <span className="text-label">{label}</span>
    </button>
  );
}
