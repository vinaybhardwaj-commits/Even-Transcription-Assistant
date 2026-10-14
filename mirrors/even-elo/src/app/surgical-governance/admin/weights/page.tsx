"use client";

import { useEffect, useState, useCallback } from "react";
import { AdminShell } from "@/components/AdminShell";
import { getCurrentPosition } from "@/lib/position";

interface WeightVersion {
  id: string;
  caseload_pct: number;
  outcomes_pct: number;
  adherence_pct: number;
  effective_from: string;
  set_by_position: string;
  rationale: string | null;
  is_current: boolean;
}

export default function AdminWeightsPage() {
  const [history, setHistory] = useState<WeightVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [caseload, setCaseload] = useState(33);
  const [outcomes, setOutcomes] = useState(34);
  const [adherence, setAdherence] = useState(33);
  const [rationale, setRationale] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/weights");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "load failed");
      setHistory(j.versions);
      const cur = (j.versions as WeightVersion[]).find((v) => v.is_current);
      if (cur) {
        setCaseload(cur.caseload_pct);
        setOutcomes(cur.outcomes_pct);
        setAdherence(cur.adherence_pct);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sum = caseload + outcomes + adherence;
  const valid = sum === 100;

  async function apply() {
    const actor = getCurrentPosition() ?? "Committee Admin";
    setApplying(true);
    setError(null);
    setApplyResult(null);
    try {
      const r = await fetch("/api/weights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseload_pct: caseload,
          outcomes_pct: outcomes,
          adherence_pct: adherence,
          set_by_position: actor,
          rationale: rationale || null,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "apply failed");
      setApplyResult(
        `Applied ${caseload}/${outcomes}/${adherence} · recomputed ${j.recompute.successes}/${j.recompute.count} VCs in ${(j.recompute.duration_ms / 1000).toFixed(1)}s`,
      );
      setRationale("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <AdminShell
      breadcrumbs={[{ label: "Admin", href: "/surgical-governance/admin" }, { label: "Weights" }]}
      title="Composite weight calibration"
      subtitle="Adjust how each component contributes to the composite score. Applying new weights triggers a batch recompute across all active VCs."
    >
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
          {error}
        </div>
      )}
      {applyResult && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 mb-4 text-sm text-emerald-900">
          ✓ {applyResult}
        </div>
      )}

      <div className="grid grid-cols-3 gap-6 mb-6">
        {[
          { label: "Caseload", value: caseload, set: setCaseload, hint: "Volume contribution" },
          { label: "Outcomes", value: outcomes, set: setOutcomes, hint: "Mortality, NPS, complaints, etc." },
          { label: "Adherence", value: adherence, set: setAdherence, hint: "PAC, OT discipline, denial, etc." },
        ].map((row) => (
          <div key={row.label} className="card p-6 bg-white border border-stone-200 rounded-xl">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-medium text-stone-700">{row.label}</div>
              <div className="num text-2xl font-semibold tabular-nums">{row.value}</div>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={row.value}
              onChange={(e) => row.set(parseInt(e.target.value, 10))}
              className="w-full accent-brand"
            />
            <div className="text-xs text-stone-500 mt-3">{row.hint}</div>
          </div>
        ))}
      </div>

      <div className="card p-6 bg-stone-50 border border-stone-200 rounded-xl mb-6">
        <div className="flex items-end justify-between mb-3">
          <div>
            <div className="text-sm font-medium">New weighting</div>
            <div className="text-xs text-stone-500 mt-0.5">Sum must equal 100 to apply</div>
          </div>
          <div
            className="num text-2xl font-bold"
            style={{ color: valid ? "#15803d" : "#dc2626" }}
          >
            {sum}
          </div>
        </div>

        <div className="flex h-3 rounded-full overflow-hidden mb-4">
          <div className="bg-teal-700 transition-all" style={{ width: `${sum > 0 ? (caseload / sum) * 100 : 0}%` }} />
          <div className="bg-teal-500 transition-all" style={{ width: `${sum > 0 ? (outcomes / sum) * 100 : 0}%` }} />
          <div className="bg-teal-300 transition-all" style={{ width: `${sum > 0 ? (adherence / sum) * 100 : 0}%` }} />
        </div>

        <label className="block text-sm font-medium mb-1.5">Rationale (recommended)</label>
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={2}
          placeholder="e.g. 'Pilot results show outcomes data is sparse — shifting weight to adherence which has stronger signal'"
          className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
        />

        <div className="mt-4 flex items-center justify-between">
          <div className="text-xs text-stone-500">
            Stamped as <span className="font-medium text-stone-900">{getCurrentPosition() ?? "Committee Admin"}</span>
          </div>
          <button
            onClick={apply}
            disabled={!valid || applying}
            className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
          >
            {applying ? "Applying & recomputing…" : `Apply ${caseload}/${outcomes}/${adherence} & recompute`}
          </button>
        </div>
      </div>

      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-stone-100">
          <div className="text-sm font-semibold">Weight version history</div>
          <div className="text-xs text-stone-500 mt-0.5">
            Every change is timestamped, attributable, and triggers a snapshot batch — defensible in privileging review
          </div>
        </div>
        <table className="w-full">
          <thead className="bg-stone-50">
            <tr className="text-left text-[11px] font-medium text-stone-500 tracking-wider uppercase">
              <th className="px-4 py-3">Effective from</th>
              <th className="px-4 py-3">Weights (C / O / A)</th>
              <th className="px-4 py-3">Set by</th>
              <th className="px-4 py-3">Rationale</th>
              <th className="px-4 py-3">Current</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-stone-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading &&
              history.map((v) => (
                <tr key={v.id} className="text-sm">
                  <td className="px-4 py-3 num">{new Date(v.effective_from).toLocaleString()}</td>
                  <td className="px-4 py-3 num font-medium">
                    {v.caseload_pct} / {v.outcomes_pct} / {v.adherence_pct}
                  </td>
                  <td className="px-4 py-3 text-stone-600">{v.set_by_position}</td>
                  <td className="px-4 py-3 text-stone-600 italic">
                    {v.rationale ?? <span className="text-stone-400 not-italic">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {v.is_current && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">
                        current
                      </span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
