"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SurgicalCaptureNav } from "@/components/capture/SurgicalCaptureNav";
import { TopNav } from "@/components/TopNav";
import { TierChip, Tier, TIER_ORDER, TIER_TEXT_COLOR } from "@/components/TierChip";
import { ScoreBar } from "@/components/ScoreBar";
import { TierDistributionBar } from "@/components/TierDistributionBar";

interface Row {
  vc_id: string;
  full_name: string;
  specialty: string;
  registration_no: string | null;
  status: string;
  composite: number | null;
  caseload_score: number | null;
  outcomes_score: number | null;
  adherence_score: number | null;
  tier: Tier;
  low_confidence: boolean;
  computed_at: string;
  total_observations: number;
  case_count_window: number;
}

interface LeaderboardResponse {
  ok: boolean;
  rows: Row[];
  distribution: Record<string, number>;
  total: number;
  weights: { caseload_pct: number; outcomes_pct: number; adherence_pct: number } | null;
  generated_at: string;
  error?: string;
}

type SortKey =
  | "rank"
  | "name"
  | "specialty"
  | "composite"
  | "caseload"
  | "outcomes"
  | "adherence"
  | "obs"
  | "computed_at";
type SortDir = "asc" | "desc";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function SurgicalLeaderboard() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);

  const [specialty, setSpecialty] = useState<string>("all");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [hideLowConf, setHideLowConf] = useState<boolean>(false);
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/leaderboard");
      const j = (await r.json()) as LeaderboardResponse;
      if (!j.ok) throw new Error(j.error ?? "leaderboard load failed");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function recomputeAll() {
    setRecomputing(true);
    setRecomputeMsg(null);
    try {
      const r = await fetch("/api/admin/recompute?all=true", { method: "POST" });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "batch recompute failed");
      setRecomputeMsg(
        `Recomputed ${j.successes}/${j.count} VCs in ${(j.duration_ms / 1000).toFixed(1)}s`,
      );
      await load();
      setTimeout(() => setRecomputeMsg(null), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecomputing(false);
    }
  }

  const specialties = useMemo(() => {
    const s = new Set<string>();
    for (const r of data?.rows ?? []) s.add(r.specialty);
    return Array.from(s).sort();
  }, [data?.rows]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      if (specialty !== "all" && r.specialty !== specialty) return false;
      if (tierFilter !== "all" && r.tier !== tierFilter) return false;
      if (hideLowConf && r.low_confidence) return false;
      return true;
    });
  }, [data, specialty, tierFilter, hideLowConf]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.full_name.localeCompare(b.full_name) * dir;
        case "specialty":
          return a.specialty.localeCompare(b.specialty) * dir;
        case "composite":
          return ((a.composite ?? -Infinity) - (b.composite ?? -Infinity)) * dir;
        case "caseload":
          return ((a.caseload_score ?? -Infinity) - (b.caseload_score ?? -Infinity)) * dir;
        case "outcomes":
          return ((a.outcomes_score ?? -Infinity) - (b.outcomes_score ?? -Infinity)) * dir;
        case "adherence":
          return ((a.adherence_score ?? -Infinity) - (b.adherence_score ?? -Infinity)) * dir;
        case "obs":
          return (a.total_observations - b.total_observations) * dir;
        case "computed_at":
          return (
            (new Date(a.computed_at).getTime() - new Date(b.computed_at).getTime()) * dir
          );
        default:
          return 0;
      }
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "specialty" ? "asc" : "desc");
    }
  }

  const month = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <SurgicalCaptureNav current="home" />
        {/* Hero */}
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="text-xs font-medium text-stone-500 tracking-wider uppercase mb-1">
              EHRC · {month}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Surgical ELO
            </h1>
            <p className="text-sm text-stone-500 mt-2 num">
              {data ? `${data.total} ${data.total === 1 ? "VC" : "VCs"}` : "…"} ·{" "}
              {data
                ? data.rows.reduce((s, r) => s + r.total_observations, 0)
                : "…"}{" "}
              observations in last 6mo · Composite score weighted{" "}
              {data?.weights
                ? `${data.weights.caseload_pct} / ${data.weights.outcomes_pct} / ${data.weights.adherence_pct}`
                : "—"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/surgical-governance/admin/vcs" className="btn-ghost text-sm">
              + Add VC
            </Link>
            <button
              onClick={recomputeAll}
              disabled={recomputing}
              className="btn-ghost text-sm flex items-center gap-2"
            >
              {recomputing ? "Recomputing…" : "Recompute all"}
            </button>
          </div>
        </div>

        {/* Tier distribution */}
        {data && (
          <div className="mb-6">
            <TierDistributionBar distribution={data.distribution} />
          </div>
        )}

        {recomputeMsg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 mb-4 text-sm text-emerald-900">
            ✓ {recomputeMsg}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
            {error}
          </div>
        )}

        {/* Filters */}
        <div className="flex items-center gap-3 mb-4 text-sm flex-wrap">
          <select
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
            className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white"
          >
            <option value="all">All specialties</option>
            {specialties.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value)}
            className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white"
          >
            <option value="all">All tiers</option>
            {TIER_ORDER.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-stone-600">
            <input
              type="checkbox"
              checked={hideLowConf}
              onChange={(e) => setHideLowConf(e.target.checked)}
              className="accent-brand"
            />
            Hide low-confidence
          </label>
        </div>

        {/* Table */}
        <div className="card overflow-hidden bg-white border border-stone-200 rounded-xl">
          <table className="w-full">
            <thead>
              <tr className="text-left text-[11px] font-medium text-stone-500 tracking-wider uppercase border-b border-stone-200 bg-stone-50">
                <th className="w-12 text-center px-4 py-3">#</th>
                <SortableTh label="Surgeon" k="name" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortableTh label="Specialty" k="specialty" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <SortableTh label="Score" k="composite" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="text-right w-24" />
                <SortableTh label="Caseload" k="caseload" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="w-32" />
                <SortableTh label="Outcomes" k="outcomes" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="w-32" />
                <SortableTh label="Adherence" k="adherence" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="w-32" />
                <th className="w-36 px-4 py-3">Tier</th>
                <SortableTh label="6mo obs" k="obs" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="text-right w-20" />
                <SortableTh label="Last computed" k="computed_at" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="text-right w-32" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {loading && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-sm text-stone-500">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-sm text-stone-500">
                    {data?.rows.length === 0
                      ? "No VCs yet have a score snapshot. Add VCs in /surgical-governance/admin/vcs and record cases via /surgical-governance/input/cases."
                      : "No VCs match the current filters."}
                  </td>
                </tr>
              )}
              {!loading &&
                sorted.map((r, i) => (
                  <tr
                    key={r.vc_id}
                    className="hover:bg-stone-50 cursor-pointer text-sm"
                    onClick={() => (window.location.href = `/surgical-governance/vc/${r.vc_id}`)}
                  >
                    <td className="px-4 py-4 text-center text-sm font-semibold text-stone-500 num">
                      {i + 1}
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{r.full_name}</div>
                      {r.low_confidence && (
                        <div className="text-[10px] text-amber-600 font-medium mt-0.5">
                          ⚠ Low confidence — {r.total_observations} obs
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-4 text-stone-600">{r.specialty}</td>
                    <td className="px-4 py-4 text-right">
                      <div className={`num text-2xl font-semibold tabular-nums ${TIER_TEXT_COLOR[r.tier]}`}>
                        {r.composite !== null ? r.composite.toFixed(1) : "—"}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <ScoreBar value={r.caseload_score} tier={r.tier} />
                    </td>
                    <td className="px-4 py-4">
                      <ScoreBar value={r.outcomes_score} tier={r.tier} />
                    </td>
                    <td className="px-4 py-4">
                      <ScoreBar value={r.adherence_score} tier={r.tier} />
                    </td>
                    <td className="px-4 py-4">
                      <TierChip tier={r.tier} />
                    </td>
                    <td className="px-4 py-4 text-right text-xs text-stone-500 num">
                      {r.total_observations}
                    </td>
                    <td className="px-4 py-4 text-right text-xs text-stone-500 num">
                      {r.computed_at ? relativeTime(r.computed_at) : "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {data && data.total > 0 && (
          <p className="text-xs text-stone-400 mt-4 text-center">
            Click any row to drill into the VC&apos;s score breakdown · per-VC dashboard ships in
            Surgical Governance
          </p>
        )}
      </main>
    </>
  );
}

function SortableTh({
  label,
  k,
  sortKey,
  sortDir,
  onClick,
  className,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  className?: string;
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === "asc" ? "↑" : "↓") : "";
  return (
    <th
      className={`px-4 py-3 cursor-pointer hover:text-stone-700 select-none ${className ?? ""}`}
      onClick={() => onClick(k)}
    >
      {label}
      {arrow && <span className="ml-1">{arrow}</span>}
    </th>
  );
}
