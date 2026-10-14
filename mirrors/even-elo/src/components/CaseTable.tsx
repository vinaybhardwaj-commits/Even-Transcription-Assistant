"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CellValue, EditableCell, StreamConfig } from "./EditableCell";
import { getCurrentPosition, onPositionChange, POSITION_SEEDS } from "@/lib/position";

interface CaseRow {
  id: string;
  case_ref: string;
  surgery_date: string;
  patient_name: string | null;
  procedure_label: string | null;
  case_status: string;
}

interface VC {
  id: string;
  full_name: string;
  specialty: string;
}

interface CaseTableProps {
  /** Streams this team owns, in display order (column order). */
  streams: StreamConfig[];
  /** Team string from PRD §4.2 ('Anesthesia', 'OT', 'MS', etc.). Used for soft-warn position-team gate. */
  expectedTeam: string;
  /** Display title for the soft-warn banner (e.g. 'Customer Care' for the CC form). */
  expectedTeamLabel: string;
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Canonical per-team table form (PRD §7.2 / mockup screen #3).
 *
 * Reused by all 7 input forms in ELO.4–5. Renders rows = cases, columns =
 * streams. Each cell is an EditableCell that fires POST /api/observations
 * on save and updates state with the new composite + tier from the recompute.
 */
export function CaseTable({ streams, expectedTeam, expectedTeamLabel }: CaseTableProps) {
  const [vcs, setVcs] = useState<VC[]>([]);
  const [vcId, setVcId] = useState<string>("");
  const [month, setMonth] = useState<string>(thisMonth());
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [observations, setObservations] = useState<
    Record<string, Record<string, CellValue>>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [composite, setComposite] = useState<{ value: number; tier: string } | null>(null);

  // Load active VCs.
  useEffect(() => {
    fetch("/api/vcs")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setVcs(j.vcs);
          if (j.vcs.length > 0 && !vcId) setVcId(j.vcs[0].id);
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPosition(getCurrentPosition());
    return onPositionChange((name) => setPosition(name));
  }, []);

  const load = useCallback(async () => {
    if (!vcId) {
      setCases([]);
      setObservations({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fromDate = `${month}-01`;
      const [yyyy, mm] = month.split("-").map((s) => parseInt(s, 10));
      const lastDay = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
      const toDate = `${month}-${String(lastDay).padStart(2, "0")}`;

      const [casesRes, obsRes] = await Promise.all([
        fetch(
          `/api/cases?vc_id=${vcId}&status=completed&from=${fromDate}&to=${toDate}&limit=200`,
        ).then((r) => r.json()),
        fetch(`/api/observations?vc_id=${vcId}&month=${month}`).then((r) => r.json()),
      ]);
      if (!casesRes.ok) throw new Error(casesRes.error ?? "cases load failed");
      if (!obsRes.ok) throw new Error(obsRes.error ?? "observations load failed");

      setCases(casesRes.cases);
      const obsMap: Record<string, Record<string, CellValue>> = {};
      for (const obs of obsRes.observations as Array<{
        case_id: string;
        stream_id: string;
        value: CellValue;
      }>) {
        if (!obsMap[obs.case_id]) obsMap[obs.case_id] = {};
        obsMap[obs.case_id][obs.stream_id] = obs.value;
      }
      setObservations(obsMap);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [vcId, month]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveCell(caseId: string, stream: StreamConfig, value: CellValue) {
    if (!position) throw new Error("Pick a position from the chip top-right first.");
    const r = await fetch("/api/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        case_id: caseId,
        stream_id: stream.id,
        value,
        entered_by_position: position,
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error ?? "save failed");

    // Update local state.
    setObservations((prev) => ({
      ...prev,
      [caseId]: { ...(prev[caseId] ?? {}), [stream.id]: value },
    }));

    if (j.recompute?.ok) {
      const prev = composite?.value;
      setComposite({ value: j.recompute.composite, tier: j.recompute.tier });
      const surgeon = vcs.find((v) => v.id === vcId)?.full_name ?? "VC";
      const delta =
        prev !== undefined ? `${prev.toFixed(1)} → ${j.recompute.composite.toFixed(1)}` : j.recompute.composite.toFixed(1);
      setToast(`Cell saved · ${surgeon} score: ${delta} (${j.recompute.tier})`);
      setTimeout(() => setToast(null), 4000);
    } else if (j.recompute && !j.recompute.ok) {
      setToast(`Saved, but recompute failed: ${j.recompute.error}`);
      setTimeout(() => setToast(null), 6000);
    }
  }

  // Position-team gate (soft-warn, not block).
  const positionTeam = position
    ? POSITION_SEEDS.find((p) => p.name === position)?.team
    : null;
  const teamMismatch = position && positionTeam && positionTeam !== expectedTeam && positionTeam !== "Admin";

  // Footer math: how many cases have all of this team's `unknown`-default streams entered?
  const requiredStreamIds = streams
    .filter((s) => s.default_rule === "unknown")
    .map((s) => s.id);
  const completedCount = cases.filter((c) => {
    const obs = observations[c.id] ?? {};
    return requiredStreamIds.every((sid) => obs[sid] !== undefined);
  }).length;

  return (
    <>
      {teamMismatch && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 mb-4 text-sm text-amber-900 flex items-center justify-between">
          <span>
            You are logged in as <span className="font-semibold">{position}</span> ({positionTeam}{" "}
            team). This form is for the <span className="font-semibold">{expectedTeamLabel}</span>{" "}
            team. Saves will still record under your position — switch via the chip if that's not
            intentional.
          </span>
        </div>
      )}

      <div className="card p-4 mb-4 flex items-center gap-3 bg-white border border-stone-200 rounded-xl">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-stone-500 uppercase tracking-wider">
            Surgeon
          </span>
          <select
            value={vcId}
            onChange={(e) => setVcId(e.target.value)}
            className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white font-medium min-w-[220px]"
          >
            {vcs.length === 0 && <option value="">No active VCs</option>}
            {vcs.map((vc) => (
              <option key={vc.id} value={vc.id}>
                {vc.full_name} — {vc.specialty}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-stone-500 uppercase tracking-wider">
            Month
          </span>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white"
          />
        </div>
        <div className="flex-1" />
        <div className="text-xs text-stone-500">
          <span className="font-medium text-stone-900">
            {completedCount} of {cases.length}
          </span>{" "}
          cases have all required {expectedTeamLabel} fields complete
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
          {error}
        </div>
      )}

      <div className="card overflow-x-auto bg-white border border-stone-200 rounded-xl">
        <table className="w-full">
          <thead className="bg-stone-50">
            <tr className="text-left text-[11px] font-medium text-stone-500 tracking-wider uppercase">
              <th className="px-4 py-3 w-32">Case</th>
              <th className="px-4 py-3 w-24">Date</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Procedure</th>
              {streams.map((s) => (
                <th key={s.id} className="px-4 py-3 text-center w-32">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {loading && (
              <tr>
                <td colSpan={4 + streams.length} className="px-4 py-8 text-center text-sm text-stone-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && cases.length === 0 && (
              <tr>
                <td colSpan={4 + streams.length} className="px-4 py-8 text-center text-sm text-stone-500">
                  No cases for this VC in {month}.{" "}
                  <Link href="/input/cases" className="text-brand hover:underline">
                    Record a case →
                  </Link>
                </td>
              </tr>
            )}
            {!loading &&
              cases.map((c) => (
                <tr key={c.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3 font-mono text-xs text-stone-700">{c.case_ref}</td>
                  <td className="px-4 py-3 text-xs text-stone-600 num">
                    {c.surgery_date.substring(0, 10)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {c.patient_name ?? <span className="text-stone-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-stone-600">
                    {c.procedure_label ?? <span className="text-stone-400">—</span>}
                  </td>
                  {streams.map((s) => {
                    const obs = observations[c.id]?.[s.id] ?? null;
                    return (
                      <td key={s.id} className="px-4 py-3 text-center">
                        <EditableCell
                          caseId={c.id}
                          stream={s}
                          current={obs}
                          onSave={(value) => saveCell(c.id, s, value)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 bg-stone-900 text-white px-5 py-3 rounded-xl shadow-2xl text-sm">
          {toast}
        </div>
      )}
    </>
  );
}
