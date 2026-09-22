"use client";

import { STRANDED_MEASURE_NOTE } from "@/lib/room-facts";
import type { DaySummary } from "@/components/admin/bench-live/types";

function fmtMinutes(ms: number): string {
  const minutes = Math.round((Number(ms) || 0) / 60_000);
  if (minutes < 60) return `${minutes} m`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

export function BenchDaySummary({ day }: { day: DaySummary }) {
  const metrics = [
    [fmtMinutes(day.audio_recorded_ms), "audio recorded"],
    [fmtMinutes(day.turned_into_words_ms), "turned into words"],
    [fmtMinutes(day.stranded?.total_ms ?? 0), "cannot be turned into words"],
    [String(day.gave_up), "gave up"],
    [String(day.visits_built), "visits built"],
  ];

  return (
    <div className="rounded-xl border border-even-ink-200 bg-even-white p-4">
      <p className="text-caption uppercase tracking-wide text-even-ink-500 mb-2">Today, all rooms</p>
      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3" data-testid="day-summary">
        {metrics.map(([value, label]) => (
          <div key={label} className="rounded-lg bg-even-ink-50 px-3 py-2.5">
            <dt className="sr-only">{label}</dt>
            <dd className="text-heading font-bold text-even-navy-800 tabular-nums">{value}</dd>
            <span className="text-caption text-even-ink-500">{label}</span>
          </div>
        ))}
      </dl>
      {day.stranded?.reasons.length ? (
        <ul className="mt-2 space-y-0.5" data-testid="day-stranded-reasons">
          {day.stranded.reasons.map((reason) => (
            <li key={reason.reason} className="text-caption text-even-ink-600 leading-snug">
              {fmtMinutes(reason.ms)} — {reason.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-caption text-even-ink-400 leading-snug">
        “Turned into words” and “cannot be turned into words” are {STRANDED_MEASURE_NOTE}.
      </p>
    </div>
  );
}
