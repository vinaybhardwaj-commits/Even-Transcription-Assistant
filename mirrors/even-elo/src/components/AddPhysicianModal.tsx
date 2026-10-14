"use client";

import { useEffect, useState } from "react";

const SPECIALTIES = [
  "General Surgery", "Cardiology", "Cardiothoracic Surgery", "Orthopaedics",
  "Neurology", "Neurosurgery", "Anaesthesia", "Gastroenterology", "Urology",
  "Plastics", "ENT", "Ophthalmology", "Paediatrics", "OBGYN", "Internal Medicine",
  "Dermatology", "Pulmonology", "Nephrology", "Endocrinology", "Oncology",
  "Radiology", "Pathology", "Emergency Medicine", "Other",
];
const COUNCILS = ["KMC", "MMC", "DMC", "MCI/NMC", "Other"];
const CATEGORIES = ["provisional", "active", "visiting_consultant", "locum_tenens", "affiliate"];

interface HospitalOption { id: string; code: string; }
interface CarryPrivilege {
  id: string;
  hospital_code: string;
  procedure_or_specialty: string;
  is_core: boolean;
  expires_at: string | null;
}

interface ExistingEngagement {
  hospital_code: string;
  hospital_id: string;
  status: string;
  category: string;
  start_date: string | null;
}
interface ExistingPhysician {
  id: string;
  full_name: string;
  primary_specialty: string | null;
  email: string | null;
  current_status: string;
  engagements: ExistingEngagement[];
}

export function AddPhysicianModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [fullName, setFullName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [regNo, setRegNo] = useState("");
  const [council, setCouncil] = useState("");
  const [regExpiry, setRegExpiry] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [joined, setJoined] = useState(new Date().toISOString().slice(0, 10));
  const [hospitals, setHospitals] = useState<HospitalOption[]>([]);
  const [pickedCodes, setPickedCodes] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string>("active");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<ExistingPhysician | null>(null);
  const [carryPrivs, setCarryPrivs] = useState<CarryPrivilege[]>([]);
  const [copyIds, setCopyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/hospitals").then((r) => r.json()).then((j) => {
      if (j.ok) setHospitals(j.hospitals as HospitalOption[]);
    }).catch(() => undefined);
  }, []);

  function togglePick(code: string) {
    setPickedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  async function doSubmit(extendId?: string) {
    if (!fullName.trim()) { setError("Full name is required."); return; }
    if (pickedCodes.size === 0) { setError("Pick at least one hospital."); return; }
    setError(null); setSubmitting(true);
    try {
      const r = await fetch("/api/physicians", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          full_name: fullName.trim(),
          primary_specialty: specialty || null,
          registration_number: regNo.trim() || null,
          registration_council: council || null,
          registration_expiry: regExpiry || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          date_joined_network: joined || null,
          hospital_codes: Array.from(pickedCodes),
          category,
          extend_physician_id: extendId ?? null,
          also_copy_privileges: extendId
            ? Array.from(copyIds).filter((id) => carryPrivs.some((p) => p.id === id))
            : [],
        }),
      });
      const j = await r.json();
      if (r.status === 409 && j.duplicate) {
        setDuplicate(j.existing_physician as ExistingPhysician);
        // CR.5: fetch carry candidates so we can render the preview.
        try {
          const cr = await fetch(`/api/physicians/${(j.existing_physician as ExistingPhysician).id}/carry-candidates`);
          const cj = await cr.json();
          if (cj.ok) {
            const privs = (cj.privileges ?? []) as CarryPrivilege[];
            setCarryPrivs(privs);
            // Pre-select ALL by default per decision #12 — admin unticks
            setCopyIds(new Set(privs.map((p) => p.id)));
          }
        } catch {
          // Ignore — extend still works without carry preview
        }
        setSubmitting(false);
        return;
      }
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not create physician.");
        setSubmitting(false);
        return;
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  function dismissDupe() { setDuplicate(null); }

  // Available hospitals to add (when extending): exclude ones already engaged
  const dupeEngagedCodes = new Set((duplicate?.engagements ?? []).filter((e) => e.status === "active").map((e) => e.hospital_code));
  const dupeNewCodes = Array.from(pickedCodes).filter((c) => !dupeEngagedCodes.has(c));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[560px] shadow-xl">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">{duplicate ? "Existing physician found" : "Add physician"}</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>

        {duplicate ? (
          <div className="px-6 py-5 space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
              A physician with email <strong>{duplicate.email}</strong> already exists:
              <div className="mt-2 text-stone-800">
                <strong>{duplicate.full_name}</strong>{duplicate.primary_specialty ? <span className="text-stone-500"> · {duplicate.primary_specialty}</span> : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {(duplicate.engagements ?? []).map((e) => (
                  <span key={e.hospital_code} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${e.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-600"}`}>
                    {e.hospital_code} · {e.category}
                  </span>
                ))}
                {(duplicate.engagements ?? []).length === 0 && <span className="text-[11px] text-stone-500">no active engagements</span>}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-stone-500 mb-1">You picked:</div>
              <div className="flex flex-wrap gap-1.5">
                {Array.from(pickedCodes).map((c) => {
                  const isNew = !dupeEngagedCodes.has(c);
                  return (
                    <span key={c} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${isNew ? "bg-brand-softer text-brand" : "bg-stone-100 text-stone-400 line-through"}`}>
                      {c}{isNew ? "" : " · already engaged"}
                    </span>
                  );
                })}
              </div>
            </div>
            {dupeNewCodes.length === 0 ? (
              <div className="text-sm text-stone-500">All your picks are already engaged. Nothing new to add.</div>
            ) : (
              <div className="text-sm text-stone-700">
                Extend the existing record with <strong>{dupeNewCodes.length}</strong> new engagement{dupeNewCodes.length > 1 ? "s" : ""}: {dupeNewCodes.join(", ")}?
              </div>
            )}

            {dupeNewCodes.length > 0 && carryPrivs.length > 0 && (
              <div className="border border-stone-200 rounded-lg p-3 bg-stone-50">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-medium text-stone-600 uppercase tracking-wider">
                    Auto-carry privileges
                  </div>
                  <div className="text-[10px] text-stone-500">PRD §C.11 · admin can untick</div>
                </div>
                <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                  {carryPrivs.map((p) => {
                    const checked = copyIds.has(p.id);
                    return (
                      <label key={p.id} className="flex items-start gap-2 text-xs cursor-pointer">
                        <input type="checkbox" checked={checked} onChange={() => {
                          setCopyIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                            return next;
                          });
                        }} className="mt-0.5" />
                        <div className="flex-1">
                          <div className="text-stone-800 font-medium">
                            {p.procedure_or_specialty}
                            <span className={`ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${p.is_core ? "bg-emerald-50 text-emerald-700" : "bg-violet-50 text-violet-700"}`}>
                              {p.is_core ? "Core" : "Special"}
                            </span>
                          </div>
                          <div className="text-[10px] text-stone-500 mt-0.5">
                            from {p.hospital_code}{p.expires_at ? ` · expires ${p.expires_at.slice(0, 10)}` : ""}
                            <span className="ml-1 text-stone-400">→ will copy to {dupeNewCodes.join(", ")}</span>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={dismissDupe} className="btn-ghost">Back</button>
              {dupeNewCodes.length > 0 && (
                <button type="button" disabled={submitting} onClick={() => doSubmit(duplicate.id)} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
                  {submitting ? "Extending…" : `Extend existing record`}
                </button>
              )}
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); doSubmit(); }} className="px-6 py-5 space-y-4 max-h-[80vh] overflow-y-auto">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Full name *</label>
              <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Dr Manoj Kumar" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Hospitals * <span className="text-stone-400 font-normal">(one engagement per hospital will be created)</span></label>
              <div className="flex flex-wrap gap-1.5">
                {hospitals.map((h) => {
                  const on = pickedCodes.has(h.code);
                  return (
                    <button type="button" key={h.code} onClick={() => togglePick(h.code)} className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${on ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}>
                      {h.code}
                    </button>
                  );
                })}
              </div>
              {pickedCodes.size === 0 && <div className="text-[11px] text-stone-400 mt-1">Pick at least one</div>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Primary specialty</label>
                <select value={specialty} onChange={(e) => setSpecialty(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                  <option value="">—</option>
                  {SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Registration number</label>
                <input type="text" value={regNo} onChange={(e) => setRegNo(e.target.value)} placeholder="MCI-12345" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Council</label>
                <select value={council} onChange={(e) => setCouncil(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                  <option value="">—</option>
                  {COUNCILS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Registration expiry</label>
                <input type="date" value={regExpiry} onChange={(e) => setRegExpiry(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Joined network</label>
                <input type="date" value={joined} onChange={(e) => setJoined(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dr.kumar@even.in" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Phone</label>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
              </div>
            </div>
            {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
              <button type="submit" disabled={submitting} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
                {submitting ? "Adding…" : "Add physician"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
