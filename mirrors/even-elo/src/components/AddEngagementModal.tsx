"use client";

import { useState, useEffect, useMemo } from "react";

interface Props {
  physicianId: string;
  defaultSpecialty?: string | null;
  engagedHospitalCodes?: string[]; // hospitals where physician is already active — disabled in picker
  onClose: () => void;
  onSaved: () => void;
}

interface HospitalOption { id: string; code: string; }

interface CarryPrivilege {
  id: string;
  hospital_id: string;
  hospital_code: string;
  procedure_or_specialty: string;
  is_core: boolean;
  expires_at: string | null;
}

interface CarryCandidates {
  engagements: Array<{ id: string; hospital_id: string; hospital_code: string; category: string; status: string; start_date: string }>;
  privileges: CarryPrivilege[];
  most_significant_category: string | null;
}

const CATEGORIES = [
  { v: "provisional", label: "Provisional" },
  { v: "active", label: "Active" },
  { v: "visiting_consultant", label: "VC" },
  { v: "locum_tenens", label: "Locum" },
  { v: "affiliate", label: "Affiliate" },
] as const;

export function AddEngagementModal({ physicianId, defaultSpecialty, engagedHospitalCodes = [], onClose, onSaved }: Props) {
  const engaged = useMemo(() => new Set(engagedHospitalCodes), [engagedHospitalCodes]);
  const [hospitals, setHospitals] = useState<HospitalOption[]>([]);
  const [hospitalCode, setHospitalCode] = useState("");
  const [category, setCategory] = useState<string>("active");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState("");
  const [specialty, setSpecialty] = useState(defaultSpecialty ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CR.5 carry-forward state
  const [carry, setCarry] = useState<CarryCandidates | null>(null);
  const [copyIds, setCopyIds] = useState<Set<string>>(new Set());

  // Load hospitals + carry candidates
  useEffect(() => {
    fetch("/api/hospitals").then((r) => r.json()).then((j) => {
      if (j.ok) {
        const opts = (j.hospitals as HospitalOption[]).filter((h) => !engaged.has(h.code));
        setHospitals(opts);
        if (opts.length > 0) setHospitalCode(opts[0].code);
      }
    }).catch(() => undefined);
    fetch(`/api/physicians/${physicianId}/carry-candidates`).then((r) => r.json()).then((j) => {
      if (j.ok) {
        setCarry(j as CarryCandidates);
        // PRD decision #12: pre-select ALL carryable privileges (admin can untick).
        // We only show privileges from hospitals OTHER than the chosen one — done in render.
        const allIds = new Set<string>((j.privileges ?? []).map((p: CarryPrivilege) => p.id));
        setCopyIds(allIds);
        if (j.most_significant_category) setCategory(j.most_significant_category);
      }
    }).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Visible carry list = privileges NOT at the chosen hospital
  const visibleCarry: CarryPrivilege[] = useMemo(() => {
    if (!carry) return [];
    return carry.privileges.filter((p) => p.hospital_code !== hospitalCode);
  }, [carry, hospitalCode]);

  function toggleCopy(id: string) {
    setCopyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!hospitalCode) { setError("Pick a hospital"); return; }
    setError(null);
    setSubmitting(true);
    try {
      const carryIds = Array.from(copyIds).filter((id) =>
        visibleCarry.some((p) => p.id === id),
      );
      const r = await fetch(`/api/physicians/${physicianId}/engagements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hospital_code: hospitalCode,
          category,
          start_date: startDate,
          end_date: endDate || null,
          specialty: specialty.trim() || null,
          also_copy_privileges: carryIds,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not save engagement.");
        setSubmitting(false);
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-stone-900/40 px-4 py-8 overflow-y-auto">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[560px] shadow-xl my-auto">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">Add engagement</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Hospital</label>
            <div className="flex flex-wrap gap-1.5">
              {hospitals.length === 0 ? (
                <span className="text-xs text-stone-500">All hospitals already engaged</span>
              ) : (
                hospitals.map((h) => (
                  <button
                    key={h.code}
                    type="button"
                    onClick={() => setHospitalCode(h.code)}
                    className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${hospitalCode === h.code ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}
                  >
                    {h.code}
                  </button>
                ))
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">
              Category
              {carry?.most_significant_category && (
                <span className="ml-2 text-[10px] text-stone-400 normal-case">
                  · carried from sibling engagement
                </span>
              )}
            </label>
            <div className="grid grid-cols-5 gap-2">
              {CATEGORIES.map(({ v: k, label }) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setCategory(k)}
                  className={`px-2 py-2 rounded-lg text-[11px] font-medium border ${
                    category === k
                      ? "bg-brand text-white border-brand"
                      : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Start date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">End date (optional)</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Specialty at this hospital (optional)</label>
            <input type="text" value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder={defaultSpecialty ?? "e.g. Cardiology"} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
          </div>

          {visibleCarry.length > 0 && (
            <div className="border border-stone-200 rounded-lg p-3 bg-stone-50">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] font-medium text-stone-600 uppercase tracking-wider">
                  Auto-carry privileges from sibling hospitals
                </div>
                <div className="text-[10px] text-stone-500">
                  PRD §C.11 · admin can untick
                </div>
              </div>
              <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                {visibleCarry.map((p) => {
                  const checked = copyIds.has(p.id);
                  return (
                    <label key={p.id} className="flex items-start gap-2 text-xs cursor-pointer">
                      <input type="checkbox" checked={checked} onChange={() => toggleCopy(p.id)} className="mt-0.5" />
                      <div className="flex-1">
                        <div className="text-stone-800 font-medium">
                          {p.procedure_or_specialty}
                          <span className={`ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${p.is_core ? "bg-emerald-50 text-emerald-700" : "bg-violet-50 text-violet-700"}`}>
                            {p.is_core ? "Core" : "Special"}
                          </span>
                        </div>
                        <div className="text-[10px] text-stone-500 mt-0.5">
                          from {p.hospital_code}{p.expires_at ? ` · expires ${p.expires_at.slice(0, 10)}` : ""}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
              {submitting ? "Saving…" : "Add engagement"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
