"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { AdminShell } from "@/components/AdminShell";
import { getCurrentPosition, onPositionChange } from "@/lib/position";

interface Case {
  id: string;
  vc_id: string;
  surgeon_name: string;
  specialty: string;
  case_ref: string;
  surgery_date: string;
  procedure_label: string | null;
  patient_name: string | null;
  patient_mrn: string | null;
  case_status: "completed" | "cancelled" | "voided";
  source: "continuous" | "catchup_upload";
  entered_by_position: string;
  entered_at: string;
}

export default function AdminCasesPage() {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"completed" | "all">("all");
  const [working, setWorking] = useState<string | null>(null);
  const [position, setPosition] = useState<string | null>(null);

  useEffect(() => {
    setPosition(getCurrentPosition());
    return onPositionChange((name) => setPosition(name));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/cases?status=${statusFilter}&limit=200`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "load failed");
      setCases(j.cases);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function voidCase(id: string) {
    if (!position) {
      alert("Pick a position from the chip first.");
      return;
    }
    if (!confirm("Void this case? It will no longer count toward scoring.")) return;
    setWorking(id);
    try {
      const r = await fetch(`/api/cases/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_status: "voided", actor_position: position }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "void failed");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  }

  return (
    <AdminShell
      breadcrumbs={[{ label: "Admin", href: "/surgical-governance/admin" }, { label: "Cases" }]}
      title="Cases"
      subtitle={`${cases.length} ${statusFilter === "all" ? "total" : "completed"} · The spine of Surgical Governance — every observation references a case row`}
      actions={
        <>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "completed" | "all")}
            className="px-3 py-1.5 border border-stone-200 rounded-lg text-sm bg-white"
          >
            <option value="completed">Completed only</option>
            <option value="all">Include cancelled / voided</option>
          </select>
          <Link
            href="/surgical-governance/input/cases"
            className="bg-brand text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-hover transition"
          >
            + New case
          </Link>
        </>
      }
    >
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-900">
          {error}
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-stone-50">
            <tr className="text-left text-[11px] font-medium text-stone-500 tracking-wider uppercase">
              <th className="px-4 py-3">Case ref</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Surgeon</th>
              <th className="px-4 py-3">Procedure</th>
              <th className="px-4 py-3">Patient</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-stone-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && cases.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-stone-500">
                  No cases yet. Click <span className="font-medium">+ New case</span>.
                </td>
              </tr>
            )}
            {!loading &&
              cases.map((c) => (
                <tr key={c.id} className="hover:bg-stone-50 text-sm">
                  <td className="px-4 py-3 font-mono text-xs text-stone-700">{c.case_ref}</td>
                  <td className="px-4 py-3 text-stone-600 num">
                    {c.surgery_date.substring(0, 10)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.surgeon_name}</div>
                    <div className="text-xs text-stone-500">{c.specialty}</div>
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {c.procedure_label ?? <span className="text-stone-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {c.patient_name ? (
                      <>
                        {c.patient_name}
                        {c.patient_mrn && (
                          <span className="text-xs text-stone-400 ml-2 font-mono">
                            {c.patient_mrn}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <CaseStatusPill status={c.case_status} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[11px] text-stone-500">
                      {c.source === "continuous" ? "live" : "catch-up"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {c.case_status !== "voided" && (
                      <button
                        onClick={() => voidCase(c.id)}
                        disabled={working === c.id}
                        className="text-xs text-red-700 hover:underline disabled:opacity-50"
                      >
                        {working === c.id ? "Voiding…" : "Void"}
                      </button>
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

function CaseStatusPill({ status }: { status: Case["case_status"] }) {
  const styles = {
    completed: "bg-emerald-50 text-emerald-700",
    cancelled: "bg-amber-50 text-amber-700",
    voided: "bg-stone-100 text-stone-500",
  } as const;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}
