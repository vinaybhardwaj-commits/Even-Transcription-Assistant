"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { TierChip, Tier, TIER_TEXT_COLOR, TIER_BAR_COLOR } from "@/components/TierChip";
import { SparkLine } from "@/components/SparkLine";
import { TrajectoryChart } from "@/components/TrajectoryChart";
import { ActivityFeed } from "@/components/ActivityFeed";
import { ComponentBreakdown } from "@/components/ComponentBreakdown";

interface DetailResponse {
  ok: boolean;
  vc: {
    id: string;
    full_name: string;
    specialty: string;
    registration_no: string | null;
    status: string;
  };
  result: {
    caseload: { score: number | null; streams: ComponentStream[]; scoreable_stream_count: number };
    outcomes: { score: number | null; streams: ComponentStream[]; scoreable_stream_count: number };
    adherence: { score: number | null; streams: ComponentStream[]; scoreable_stream_count: number };
    composite: number;
    tier: Tier;
    low_confidence: boolean;
    total_observations: number;
    case_count_window: number;
  };
  streams: Array<{ id: string; label: string; component: string; default_rule: string }>;
  snapshot_history: Array<{
    composite: number;
    tier: string;
    computed_at: string;
  }>;
  cases: Array<{
    id: string;
    case_ref: string;
    surgery_date: string;
    procedure_label: string | null;
    patient_name: string | null;
    case_status: string;
    observation_count: number;
  }>;
  activity: Array<{
    id: string;
    actor_position: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before_json: Record<string, unknown> | null;
    after_json: Record<string, unknown> | null;
    at: string;
    case_ref_for_obs: string | null;
  }>;
  required_stream_count: number;
  weights: { caseload_pct: number; outcomes_pct: number; adherence_pct: number };
  error?: string;
}

interface ComponentStream {
  stream_id: string;
  sub_score: number;
  n_observations: number;
  weight_sum: number;
}

export default function VcDashboardPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/vcs/${params.id}/detail`);
      const j: DetailResponse = await r.json();
      if (!j.ok) throw new Error(j.error ?? "load failed");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !data) {
    return (
      <>
        <TopNav />
        <main className="max-w-[1400px] mx-auto px-8 py-8">
          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              {error}
            </div>
          ) : (
            <div className="text-sm text-stone-500">Loading…</div>
          )}
        </main>
      </>
    );
  }

  const { vc, result, streams, snapshot_history, cases, activity, required_stream_count, weights } = data;
  const composite = result.composite;
  const tier = result.tier;

  // Sparkline data per component (use snapshot history if available).
  const sparkComposite = snapshot_history.map((s) => s.composite);

  // Cases: order by date desc, compute completion %.
  const casesOrdered = [...cases].sort((a, b) =>
    a.surgery_date < b.surgery_date ? 1 : a.surgery_date > b.surgery_date ? -1 : 0,
  );

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-center gap-2 text-sm text-stone-500 mb-4">
          <Link href="/surgical-governance" className="hover:text-stone-900">
            Leaderboard
          </Link>
          <span>/</span>
          <span className="text-stone-900">{vc.full_name}</span>
        </div>

        {/* Hero card */}
        <div className="card p-6 mb-6 bg-white border border-stone-200 rounded-xl">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <h1 className="text-2xl font-semibold tracking-tight">{vc.full_name}</h1>
                <TierChip tier={tier} />
                <span className="text-xs px-2.5 py-1 rounded-full bg-stone-100 text-stone-600 font-medium capitalize">
                  {vc.status}
                </span>
                {result.low_confidence && (
                  <span className="text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 font-medium">
                    ⚠ Low confidence
                  </span>
                )}
              </div>
              <div className="text-sm text-stone-500 num">
                {vc.specialty}
                {vc.registration_no && ` · ${vc.registration_no}`} ·{" "}
                {result.case_count_window} cases in last 6mo · {result.total_observations} observations
              </div>
              <div className="text-xs text-stone-500 mt-1 num">
                Weights: {weights.caseload_pct} / {weights.outcomes_pct} / {weights.adherence_pct} (Caseload / Outcomes / Adherence)
              </div>
            </div>
            <div className="text-right">
              <div className={`score-display text-6xl ${TIER_TEXT_COLOR[tier]}`}>
                {composite.toFixed(1)}
              </div>
              {snapshot_history.length >= 2 && (
                <div className="text-xs text-stone-500 mt-1 num">
                  {(() => {
                    const prev = snapshot_history[snapshot_history.length - 2].composite;
                    const delta = composite - prev;
                    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "→";
                    return `${arrow} ${Math.abs(delta).toFixed(1)} since prior snapshot`;
                  })()}
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-stone-100 grid grid-cols-3 gap-6">
            {[
              { label: "Caseload", score: result.caseload.score, kind: "caseload" as const },
              { label: "Outcomes", score: result.outcomes.score, kind: "outcomes" as const },
              { label: "Adherence", score: result.adherence.score, kind: "adherence" as const },
            ].map((c) => (
              <div key={c.label}>
                <div className="flex items-baseline justify-between mb-2">
                  <div className="text-xs font-medium tracking-wider uppercase text-stone-500">{c.label}</div>
                  <div className="num text-lg font-semibold">
                    {c.score !== null ? Math.round(c.score) : <span className="text-stone-400">—</span>}
                  </div>
                </div>
                <div className="bg-stone-100 rounded h-1.5 mb-2 overflow-hidden">
                  {c.score !== null && (
                    <div
                      className={`h-full ${TIER_BAR_COLOR[tier]}`}
                      style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }}
                    />
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-stone-500">
                  <SparkLine values={sparkComposite.slice(-12)} color={TIER_BAR_HEX[tier]} />
                  <span>
                    {c.score !== null
                      ? `${result[c.kind].scoreable_stream_count} of ${streams.filter((s) => s.component === c.kind).length} scoreable`
                      : "Insufficient data"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* Left: Component breakdown + Activity feed */}
          <div className="col-span-2 space-y-6">
            <ComponentBreakdown
              caseload={result.caseload}
              outcomes={result.outcomes}
              adherence={result.adherence}
              streams={streams}
              tier={tier}
            />

            <div className="card overflow-hidden bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-4 border-b border-stone-100">
                <div className="text-sm font-semibold">Recent observation activity</div>
                <div className="text-xs text-stone-500 mt-0.5">
                  Every input write timestamped for audit defensibility
                </div>
              </div>
              <ActivityFeed rows={activity} streams={streams} />
            </div>
          </div>

          {/* Right column: actions + cases + trajectory */}
          <div className="col-span-1 space-y-6">
            <div className="card p-5 bg-white border border-stone-200 rounded-xl">
              <div className="text-sm font-semibold mb-3">Committee actions</div>
              {composite < 30 && (
                <button className="w-full px-3 py-2 mb-2 bg-red-50 text-red-700 hover:bg-red-100 transition rounded-lg text-sm font-medium text-left">
                  Convene suspension review
                  <div className="text-xs font-normal opacity-75 mt-0.5">
                    Score &lt; 30 · requires 4 of 5 votes
                  </div>
                </button>
              )}
              {composite >= 30 && composite < 45 && (
                <button className="w-full px-3 py-2 mb-2 bg-orange-50 text-orange-700 hover:bg-orange-100 transition rounded-lg text-sm font-medium text-left">
                  Open Performance Improvement Plan
                  <div className="text-xs font-normal opacity-75 mt-0.5">
                    90-day · weekly check-ins
                  </div>
                </button>
              )}
              {composite >= 45 && composite < 60 && (
                <button className="w-full px-3 py-2 mb-2 bg-amber-50 text-amber-700 hover:bg-amber-100 transition rounded-lg text-sm font-medium text-left">
                  Schedule Watch review
                  <div className="text-xs font-normal opacity-75 mt-0.5">
                    Quarterly committee review
                  </div>
                </button>
              )}
              <a
                href={`/api/vcs/${vc.id}/audit`}
                download
                className="block w-full px-3 py-2 bg-stone-50 text-stone-700 hover:bg-stone-100 transition rounded-lg text-sm font-medium text-left"
              >
                Export audit trail (CSV)
                <div className="text-xs font-normal opacity-75 mt-0.5">
                  All observations + supersession history
                </div>
              </a>
            </div>

            <div className="card overflow-hidden bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
                <div className="text-sm font-semibold">Recent cases</div>
                <span className="text-xs text-stone-500 num">{casesOrdered.length}</span>
              </div>
              <div className="divide-y divide-stone-100">
                {casesOrdered.slice(0, 6).map((c) => {
                  const pct =
                    required_stream_count > 0
                      ? Math.round((c.observation_count / required_stream_count) * 100)
                      : 0;
                  return (
                    <div key={c.id} className="px-5 py-3">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs text-stone-600">{c.case_ref}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            pct >= 100
                              ? "bg-emerald-50 text-emerald-700"
                              : pct > 0
                                ? "bg-amber-50 text-amber-700"
                                : "bg-stone-100 text-stone-500"
                          }`}
                        >
                          {Math.min(100, pct)}% complete
                        </span>
                      </div>
                      <div className="text-sm mt-1">
                        {c.procedure_label ?? <span className="text-stone-400">—</span>}
                      </div>
                      <div className="text-xs text-stone-500 mt-0.5 num">
                        {c.surgery_date} {c.patient_name && `· ${c.patient_name}`}
                      </div>
                    </div>
                  );
                })}
                {casesOrdered.length === 0 && (
                  <div className="px-5 py-6 text-sm text-stone-500 text-center">
                    No cases yet.
                  </div>
                )}
              </div>
            </div>

            <div className="card p-5 bg-white border border-stone-200 rounded-xl">
              <div className="text-sm font-semibold mb-3">90-day trajectory</div>
              <TrajectoryChart
                points={snapshot_history.map((s) => ({
                  composite: s.composite,
                  tier: s.tier,
                  computed_at: s.computed_at,
                }))}
                currentTier={tier}
              />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

const TIER_BAR_HEX: Record<string, string> = {
  distinguished: "#16a34a",
  standard: "#2563eb",
  watch: "#d97706",
  pip: "#ea580c",
  suspension_review: "#dc2626",
  no_recent_activity: "#71717a",
};
