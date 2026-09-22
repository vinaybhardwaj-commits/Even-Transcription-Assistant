"use client";

import * as React from "react";
import type { BenchMeterLevels } from "@/lib/bench-meter";

function scaledPeak(peak: number): number {
  return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, peak) / 0.3)));
}

export function BenchLevelMeter({
  levels,
  live,
  digitalSilence = false,
  label = "Main microphone",
}: {
  levels: BenchMeterLevels | null | undefined;
  live: boolean;
  digitalSilence?: boolean;
  label?: string;
}) {
  const target = live && levels && !digitalSilence ? scaledPeak(levels.peak) : 0;
  const [display, setDisplay] = React.useState(target);

  React.useEffect(() => {
    if (!live || digitalSilence || !levels) {
      setDisplay(0);
      return;
    }
    setDisplay((value) => Math.max(value, target));
    let decayTimer: ReturnType<typeof setInterval> | null = null;
    const delay = globalThis.setTimeout(() => {
      decayTimer = globalThis.setInterval(() => {
        setDisplay((value) => (value < 0.012 ? 0 : value * 0.91));
      }, 90);
    }, 260);
    return () => {
      globalThis.clearTimeout(delay);
      if (decayTimer) globalThis.clearInterval(decayTimer);
    };
  }, [digitalSilence, levels, live, target]);

  const count = 18;
  const active = Math.round(display * count);
  const state = !live || !levels ? "idle" : digitalSilence ? "digital silence" : "live";

  return (
    <div className="mt-3" data-meter-state={state.replace(" ", "_")}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-even-ink-500">
          {label}
        </span>
        <span
          className={`text-[10px] font-semibold ${
            digitalSilence && live
              ? "text-danger-700"
              : live && levels
                ? "text-success-700"
                : "text-even-ink-400"
          }`}
        >
          {state}
        </span>
      </div>
      <div
        className="mt-1 flex h-4 items-stretch gap-[3px]"
        role="meter"
        aria-label={`${label} level, ${state}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(display * 100)}
      >
        {Array.from({ length: count }, (_, index) => {
          const lit = index < active && live && !digitalSilence;
          const band = index / count;
          const color = !lit
            ? digitalSilence && live
              ? "bg-danger-100"
              : "bg-even-ink-100"
            : band > 0.82
              ? "bg-warning-500"
              : band > 0.38
                ? "bg-success-500"
                : "bg-even-blue-500";
          return (
            <span
              key={index}
              className={`min-w-0 flex-1 rounded-[2px] transition-colors duration-100 ${color} ${
                digitalSilence && live && index % 3 === 1 ? "opacity-30" : ""
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}
