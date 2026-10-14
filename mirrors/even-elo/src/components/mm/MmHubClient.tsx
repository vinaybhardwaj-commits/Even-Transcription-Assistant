"use client";

import { useEffect, useState } from "react";
import { OutcomeChip, StatusChip } from "./MmNav";

/**
 * /mm hub — KPI strip + case table (mockup screen 1).
 *
 * Data loading copies the SafetyHub pattern verbatim: useEffect → fetch →
 * `if (j.ok)`. Everything goes through the existing /api/safety/[...path]
 * proxy; the browser never talks to even-incident directly.
 *
 * The list carries no patient identifiers (PRD A3) — the API does not send them.
 */

interface MmCase {
  id: string;
  incident_ref: string | null;
  status: string;
  title: string;
  outcome_type: string;
  outcome_summary: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  ratified_by: string | null;
  ratified_at: string | null;
}

interface Totals {
  open: number;
  draft: number;
  in_review: number;
  ratified: number;
  gaps_open: number;
}

const STATUSES = ["draft", "in_review", "ratified"];

function Kpi({ n, label }: { n: React.ReactNode; label: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="text-2xl font-bold tracking-tight">{n}</div>
      <div className="mt-1 text-[12px] text-stone-500">{label}</div>
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "yesterday";
  return d.toLocaleDateString();
}

export default function MmHubClient() {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [cases, setCases] = useState<MmCase[] | null>(null);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/safety/mm/stats")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setTotals(j.totals);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setCases(null);
    setErr(null);
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    fetch(`/api/safety/mm/cases${qs}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setCases(j.cases);
        else {
          setCases([]);
          setErr(j.error || "Failed to load cases");
        }
      })
      .catch(() => {
        setCases([]);
        setErr("Failed to load cases");
      });
  }, [status]);

  return (
    <div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi n={totals ? totals.open : "—"} label="Open cases" />
        <Kpi n={totals ? totals.in_review : "—"} label="Awaiting review" />
        <Kpi n={totals ? totals.ratified : "—"} label="Ratified" />
        <Kpi n={totals ? totals.gaps_open : "—"} label="Protocol gaps open" />
      </div>

      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Cases</div>
          <div className="flex items-center gap-2">
            <select
              className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[13px]"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <a
              href="/mm/new"
              className="rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90"
            >
              ＋ New case
            </a>
          </div>
        </div>

        {err && <div className="mb-3 text-[13px] font-semibold text-red-700">{err}</div>}

        {!cases ? (
          <div className="text-sm text-stone-400">Loading…</div>
        ) : cases.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-10 text-center text-[13px] text-stone-500">
            {status ? `No ${status} cases.` : "No M&M cases yet."}
            <div className="mt-1 text-[12px] text-stone-400">
              Start one from an EHRC incident report, or directly for a death or morbid outcome with no incident on file.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {["Case", "Title", "Outcome", "Incident", "Status", "Pipeline", "Updated"].map((h) => (
                    <th
                      key={h}
                      className="border-b border-stone-200 px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-stone-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id} className="hover:bg-stone-50">
                    <td className="border-b border-stone-100 px-2 py-2 align-top">
                      <a href={`/mm/cases/${c.id}`} className="font-mono font-bold text-brand hover:underline">
                        {c.id}
                      </a>
                    </td>
                    <td className="border-b border-stone-100 px-2 py-2 align-top">
                      <a href={`/mm/cases/${c.id}`} className="hover:underline">
                        {c.title}
                      </a>
                    </td>
                    <td className="border-b border-stone-100 px-2 py-2 align-top">
                      <OutcomeChip outcome={c.outcome_type} />
                    </td>
                    <td className="border-b border-stone-100 px-2 py-2 align-top">
                      {c.incident_ref ? (
                        <a
                          href={`/safety/incidents/${c.incident_ref}`}
                          className="rounded bg-brand-softer px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-brand hover:underline"
                        >
                          {c.incident_ref}
                        </a>
                      ) : (
                        <span className="text-[11.5px] italic text-stone-400">— no incident filed</span>
                      )}
                    </td>
                    <td className="border-b border-stone-100 px-2 py-2 align-top">
                      <StatusChip status={c.status} />
                    </td>
                    <td className="border-b border-stone-100 px-2 py-2 align-top text-stone-400">—</td>
                    <td className="border-b border-stone-100 px-2 py-2 align-top text-stone-500">{when(c.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 text-[11.5px] italic text-stone-400">
          List never shows patient identifiers (PRD A3). Access: active + SGC/super-admin only — predicate re-stated on
          every page (decision 13). The pipeline column fills in once ingestion ships.
        </div>
      </div>
    </div>
  );
}
