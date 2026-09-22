"use client";

import * as React from "react";
import type {
  LevelSample,
  LevelTimelineResp,
} from "@/components/admin/bench-live/types";

const WIDTH = 1000;
const HEIGHT = 150;
const GAP_MS = 45_000;

function dayBounds(istDate: string): { start: number; end: number } {
  const start = Date.parse(`${istDate}T00:00:00.000+05:30`);
  return { start, end: start + 24 * 60 * 60_000 };
}

function pointOf(sample: LevelSample, start: number, end: number): [number, number] {
  const x = Math.max(0, Math.min(WIDTH, ((sample.t_ms - start) / (end - start)) * WIDTH));
  const scaled = Math.max(0, Math.min(1, Math.sqrt(Math.max(0, sample.peak) / 0.3)));
  return [x, HEIGHT - 10 - scaled * (HEIGHT - 20)];
}

function linePath(samples: readonly LevelSample[], start: number, end: number): string {
  return samples.map((sample, index) => {
    const [x, y] = pointOf(sample, start, end);
    const disconnected = index === 0 || sample.t_ms - samples[index - 1]!.t_ms > GAP_MS;
    return `${disconnected ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function fmtIst(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export function BenchLevelTimeline({
  roomId,
  istDate,
}: {
  roomId: string;
  istDate: string;
}) {
  const [data, setData] = React.useState<LevelTimelineResp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState<LevelSample | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({ room_id: roomId, ist_date: istDate });
        const response = await fetch(`/api/admin/bench/levels?${params}`, { cache: "no-store" });
        const json = (await response.json()) as LevelTimelineResp & { error?: { message?: string } };
        if (!response.ok) throw new Error(json.error?.message ?? `http_${response.status}`);
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(String((cause as Error)?.message ?? cause));
      }
    };
    void load();
    const timer = globalThis.setInterval(() => {
      if (!document.hidden) void load();
    }, 20_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [istDate, roomId]);

  const samples = data?.samples ?? [];
  const { start, end } = dayBounds(istDate);
  const path = linePath(samples, start, end);
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (samples.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const wanted = start + ((event.clientX - rect.left) / rect.width) * (end - start);
    let nearest = samples[0]!;
    for (const sample of samples) {
      if (Math.abs(sample.t_ms - wanted) < Math.abs(nearest.t_ms - wanted)) nearest = sample;
    }
    setHovered(nearest);
  };

  return (
    <section className="mt-4 rounded-xl border border-even-ink-200 bg-even-ink-50/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h4 className="text-label font-semibold text-even-navy-800">Today&apos;s microphone level</h4>
          <p className="text-caption text-even-ink-500">IST · 15-second display buckets · no audio leaves the room</p>
        </div>
        <span className="text-caption text-even-ink-500">
          {data ? `${data.sample_count.toLocaleString("en-IN")} samples` : "Loading…"}
        </span>
      </div>

      {error ? (
        <p className="mt-3 rounded-lg bg-warning-50 px-3 py-2 text-caption text-warning-700">
          Level history unavailable · {error}
        </p>
      ) : samples.length === 0 && data ? (
        <div className="mt-3 flex h-32 items-center justify-center rounded-lg border border-dashed border-even-ink-200 text-caption text-even-ink-400">
          No measured levels logged for this room today.
        </div>
      ) : (
        <div className="mt-3">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-32 w-full touch-none overflow-visible rounded-lg bg-even-white"
            role="img"
            aria-label={`Microphone peak timeline for ${istDate} IST`}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHovered(null)}
          >
            {[0.25, 0.5, 0.75].map((fraction) => (
              <line
                key={fraction}
                x1={WIDTH * fraction}
                x2={WIDTH * fraction}
                y1={0}
                y2={HEIGHT}
                stroke="#EDEEF2"
                strokeWidth={2}
              />
            ))}
            <path d={path} fill="none" stroke="#0055FF" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
            {samples.filter((sample) => (sample.zero_ratio ?? 0) >= 0.98).map((sample) => {
              const [x] = pointOf(sample, start, end);
              return <circle key={sample.t_ms} cx={x} cy={HEIGHT - 8} r={4} fill="#EF4444" />;
            })}
            {hovered ? (() => {
              const [x, y] = pointOf(hovered, start, end);
              return (
                <>
                  <line x1={x} x2={x} y1={0} y2={HEIGHT} stroke="#002054" strokeWidth={2} opacity={0.35} />
                  <circle cx={x} cy={y} r={7} fill="#FCFCFC" stroke="#0055FF" strokeWidth={4} />
                </>
              );
            })() : null}
          </svg>
          <div className="mt-1 flex justify-between text-[10px] text-even-ink-400">
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00 IST</span>
          </div>
          <p className="mt-2 min-h-4 font-mono text-[11px] text-even-ink-600">
            {hovered
              ? `${fmtIst(hovered.t_ms)} · peak ${hovered.peak.toFixed(4)} · ${
                  hovered.zero_ratio === null ? "zero ratio not reported" : `zero ${(hovered.zero_ratio * 100).toFixed(1)}%`
                }`
              : "Move across the timeline to inspect time, peak and zero ratio."}
          </p>
        </div>
      )}
    </section>
  );
}
