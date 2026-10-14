"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { getCurrentPosition, onPositionChange } from "@/lib/position";

interface VC {
  id: string;
  full_name: string;
  specialty: string;
  status: string;
}

function todayISO(): string {
  return new Date().toISOString().substring(0, 10);
}

export default function NewCasePage() {
  const [vcs, setVcs] = useState<VC[]>([]);
  const [vcId, setVcId] = useState("");
  const [surgeryDate, setSurgeryDate] = useState(todayISO());
  const [procedureLabel, setProcedureLabel] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientMrn, setPatientMrn] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<string | null>(null);

  useEffect(() => {
    setPosition(getCurrentPosition());
    const off = onPositionChange((name) => setPosition(name));
    fetch("/api/vcs")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setVcs(j.vcs);
      })
      .catch(() => {});
    return off;
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!position) {
      setError("Pick a position from the chip in the top-right first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vc_id: vcId,
          surgery_date: surgeryDate,
          procedure_label: procedureLabel || null,
          patient_name: patientName || null,
          patient_mrn: patientMrn || null,
          notes: notes || null,
          entered_by_position: position,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "create failed");

      const surgeon = vcs.find((v) => v.id === vcId)?.full_name ?? "VC";
      setToast(`Case ${j.case.case_ref} created. ${surgeon} recomputed (stub).`);
      // Sticky VC dropdown for fast multi-case entry; clear other fields.
      setProcedureLabel("");
      setPatientName("");
      setPatientMrn("");
      setNotes("");
      setSurgeryDate(todayISO());
      setTimeout(() => setToast(null), 4500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedVc = vcs.find((v) => v.id === vcId);

  return (
    <>
      <TopNav />
      <main className="max-w-[800px] mx-auto px-8 py-12">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Record a new surgical case</h1>
          <p className="text-sm text-stone-500 mt-1">
            Cases are the spine of Surgical Governance. Every observation references a case row.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="bg-white border border-stone-200 rounded-xl p-8 space-y-5"
        >
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Surgeon <span className="text-red-500">*</span>
            </label>
            <select
              value={vcId}
              onChange={(e) => setVcId(e.target.value)}
              required
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
            >
              <option value="">Select a VC…</option>
              {vcs.map((vc) => (
                <option key={vc.id} value={vc.id}>
                  {vc.full_name} — {vc.specialty}
                </option>
              ))}
            </select>
            {vcs.length === 0 && (
              <p className="text-xs text-amber-600 mt-1">
                No active VCs yet.{" "}
                <Link href="/surgical-governance/admin/vcs" className="underline">
                  Add some in /surgical-governance/admin/vcs
                </Link>
                .
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Surgery date <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={surgeryDate}
                onChange={(e) => setSurgeryDate(e.target.value)}
                required
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Auto-generated case ref</label>
              <input
                value="Auto-assigned on save"
                disabled
                className="mono w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-stone-50 text-stone-600"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">Procedure</label>
            <input
              type="text"
              value={procedureLabel}
              onChange={(e) => setProcedureLabel(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              placeholder="e.g. Lap Cholecystectomy"
            />
            <div className="text-xs text-stone-500 mt-1">
              Free text. Used for case identification on principal forms.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div>
              <label className="block text-sm font-medium mb-1.5">Patient name</label>
              <input
                type="text"
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
                placeholder="e.g. Mr Suresh Patel"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">MRN</label>
              <input
                type="text"
                value={patientMrn}
                onChange={(e) => setPatientMrn(e.target.value)}
                className="font-mono w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
                placeholder="e.g. EHRC-018-92341"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              placeholder="Any case-specific context the committee should see…"
            />
          </div>

          {error && <div className="text-sm text-red-700">{error}</div>}

          <div className="pt-4 border-t border-stone-100 flex items-center justify-between">
            <div className="text-xs text-stone-500">
              Stamped as{" "}
              <span className="font-medium text-stone-900">{position ?? "(no position)"}</span> ·
              Recompute fires on submit
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setVcId("");
                  setProcedureLabel("");
                  setPatientName("");
                  setPatientMrn("");
                  setNotes("");
                }}
                className="text-sm px-3 py-1.5 rounded-lg border border-stone-200 hover:border-stone-300"
              >
                Clear
              </button>
              <button
                type="submit"
                disabled={submitting || !vcId || !surgeryDate || !position}
                className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
              >
                {submitting ? "Creating…" : "Create case"}
              </button>
            </div>
          </div>
        </form>

        {selectedVc && (
          <div className="text-xs text-stone-500 mt-4 num text-right">
            Selected: {selectedVc.full_name} · {selectedVc.specialty}
          </div>
        )}

        <Link
          href="/surgical-governance/input/cases/upload"
          className="block mt-6 p-6 bg-white border-2 border-dashed border-stone-200 rounded-xl hover:border-brand transition"
        >
          <div className="flex items-start gap-4">
            <div className="text-2xl">📋</div>
            <div className="flex-1">
              <div className="font-medium">Catch-up upload →</div>
              <div className="text-sm text-stone-500 mt-1">
                Upload a CSV or paste tab-separated rows for cases missed during the month.
                Required columns:{" "}
                <span className="font-mono text-xs bg-stone-100 px-1 rounded">vc_full_name</span>{" "}
                ·{" "}
                <span className="font-mono text-xs bg-stone-100 px-1 rounded">surgery_date</span>
              </div>
            </div>
          </div>
        </Link>

        {toast && (
          <div className="fixed bottom-6 right-6 bg-stone-900 text-white px-5 py-3 rounded-xl shadow-2xl text-sm">
            {toast}
          </div>
        )}
      </main>
    </>
  );
}
