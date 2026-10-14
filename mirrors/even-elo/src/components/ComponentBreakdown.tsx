"use client";

import { useState } from "react";
import { ScoreBar } from "./ScoreBar";
import { Tier } from "./TierChip";

type Component = "outcomes" | "adherence" | "caseload";

interface StreamConfig {
  id: string;
  label: string;
  component: string;
}

interface StreamSubScore {
  stream_id: string;
  sub_score: number;
  n_observations: number;
  weight_sum: number;
}

interface ComponentResult {
  score: number | null;
  streams: StreamSubScore[];
  scoreable_stream_count: number;
}

interface ComponentBreakdownProps {
  caseload: ComponentResult;
  outcomes: ComponentResult;
  adherence: ComponentResult;
  streams: StreamConfig[];
  /** Tier driving the bar colour for sub-scores. */
  tier: Tier | string;
}

/**
 * Component breakdown table — toggle between outcomes / adherence / caseload.
 * Per-stream rows: label, sub-score, n observations.
 * Locked from EVEN-ELO-MOCKUPS.html /vc/[id] component breakdown.
 */
export function ComponentBreakdown({
  caseload,
  outcomes,
  adherence,
  streams,
  tier,
}: ComponentBreakdownProps) {
  const [active, setActive] = useState<Component>("outcomes");

  const result =
    active === "outcomes" ? outcomes : active === "adherence" ? adherence : caseload;

  const componentStreamIds = streams
    .filter((s) => s.component === active)
    .map((s) => s.id);

  // Stream rows: ordered by component catalogue order, joined with sub-score.
  const rows = componentStreamIds.map((id) => {
    const s = streams.find((x) => x.id === id);
    const sub = result.streams.find((x) => x.stream_id === id);
    return {
      stream_id: id,
      label: s?.label ?? id,
      sub_score: sub?.sub_score ?? null,
      n_observations: sub?.n_observations ?? 0,
    };
  });

  const componentScore = result.score;
  const insufficient = componentScore === null;

  return (
    <div className="card overflow-hidden bg-white border border-stone-200 rounded-xl">
      <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Component breakdown</div>
          <div className="text-xs text-stone-500 mt-0.5">
            Sub-scores by stream · last 6mo · decay-weighted
          </div>
        </div>
        <div className="flex gap-1">
          {(["outcomes", "adherence", "caseload"] as Component[]).map((c) => (
            <button
              key={c}
              onClick={() => setActive(c)}
              className={
                active === c
                  ? "px-2.5 py-1 text-xs font-medium bg-stone-100 rounded-md"
                  : "px-2.5 py-1 text-xs text-stone-500 hover:bg-stone-100 rounded-md"
              }
            >
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {insufficient && (
        <div className="px-5 py-4 bg-stone-50 text-xs text-stone-500">
          Insufficient data — only {result.scoreable_stream_count} of {rows.length} streams
          scoreable. Component dropped from composite (renormalized).
        </div>
      )}

      <div className="divide-y divide-stone-100">
        {rows.map((row) => (
          <div
            key={row.stream_id}
            className="px-5 py-3 grid grid-cols-12 gap-3 items-center text-sm"
          >
            <div className="col-span-5 font-medium">{row.label}</div>
            <div className="col-span-1 num text-right tabular-nums">
              {row.sub_score !== null ? Math.round(row.sub_score) : <span className="text-stone-400">—</span>}
            </div>
            <div className="col-span-4">
              <ScoreBar value={row.sub_score} tier={tier} width={120} />
            </div>
            <div className="col-span-2 text-xs text-stone-500 text-right num">
              {row.n_observations} {row.n_observations === 1 ? "obs" : "obs"}
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-5 py-6 text-sm text-stone-500 text-center">
            No streams in this component.
          </div>
        )}
      </div>
    </div>
  );
}
