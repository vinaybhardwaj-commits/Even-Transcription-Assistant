"use client";

import { useState, useEffect } from "react";

const DIMENSIONS = [
  { key: "teamwork", label: "Teamwork", hint: "respect to nurses, anaesthesia, paramedical" },
  { key: "emr_documentation", label: "EMR/documentation", hint: "completeness, timeliness, accuracy" },
  { key: "ot_etiquette", label: "OT etiquette", hint: "punctuality, conduct, tone" },
  { key: "protocol_adherence", label: "Protocol adherence", hint: "WHO checklist, asepsis, time-out" },
  { key: "outcome", label: "Outcome", hint: "clinical result for THIS case" },
  { key: "demeanor", label: "Demeanor", hint: "with patient + family + staff" },
] as const;

const FLAG_OPTIONS = [
  { v: "none", label: "No concern", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { v: "concern", label: "Concern", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  { v: "immediate_termination_recommended", label: "Immediate termination", cls: "bg-red-50 text-red-800 border-red-200" },
] as const;

export function AddObservationModal({
  prescreenId,
  allowedRoles,
  hospitalOptions,
  onClose,
  onSaved,
}: {
  prescreenId: string;
  allowedRoles: string[];
  hospitalOptions: Array<{ id: string; code: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [caseDate, setCaseDate] = useState(new Date().toISOString().slice(0, 10));
  const [procedure, setProcedure] = useState("");
  const [observerRole, setObserverRole] = useState<string>(allowedRoles[0] ?? "");
  const [scores, setScores] = useState<Record<string, number>>({});
  const [narrative, setNarrative] = useState("");
  const [flagSeverity, setFlagSeverity] = useState<"none" | "concern" | "immediate_termination_recommended">("none");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hospitalId, setHospitalId] = useState<string>(hospitalOptions[0]?.id ?? "");

  useEffect(() => {
    if (!observerRole && allowedRoles.length > 0) setObserverRole(allowedRoles[0]);
  }, [allowedRoles, observerRole]);

  function setScore(dim: string, v: number) {
    setScores((s) => ({ ...s, [dim]: v }));
  }

  const allScored = DIMENSIONS.every((d) => scores[d.key] >= 1 && scores[d.key] <= 5);
  const avg = allScored
    ? DIMENSIONS.reduce((a, d) => a + scores[d.key], 0) / DIMENSIONS.length
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!procedure.trim()) { setError("Procedure required."); return; }
    if (!observerRole) { setError("Observer role required."); return; }
    if (!hospitalId) { setError("Hospital required."); return; }
    if (!allScored) { setError("All 6 dimensions must be scored 1-5."); return; }
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch(`/api/vc-onboarding/prescreens/${prescreenId}/observations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case_date: caseDate,
          procedure: procedure.trim(),
          observer_role: observerRole,
          hospital_id: hospitalId,
          scores,
          narrative_notes: narrative.trim() || null,
          flag_severity: flagSeverity,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not save observation.");
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
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[640px] shadow-xl my-auto">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">Add observation case</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Date of case</label>
              <input type="date" value={caseDate} onChange={(e) => setCaseDate(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Procedure</label>
              <input type="text" value={procedure} onChange={(e) => setProcedure(e.target.value)} placeholder="e.g. Laparoscopic cholecystectomy" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Hospital where this case happened *</label>
            {hospitalOptions.length === 0 ? (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">No hospitals on this prescreen — re-check the pre-screen record.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {hospitalOptions.map((h) => (
                  <button type="button" key={h.id} onClick={() => setHospitalId(h.id)} className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${hospitalId === h.id ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}>
                    {h.code}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Your observer role</label>
            <select value={observerRole} onChange={(e) => setObserverRole(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
              {allowedRoles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <label className="text-xs font-medium text-stone-500 uppercase tracking-wider">Six-dimension score (1–5)</label>
              {avg !== null && <div className="text-xs text-stone-500">avg <span className="font-semibold text-stone-900">{avg.toFixed(2)}</span></div>}
            </div>
            {DIMENSIONS.map((d) => (
              <div key={d.key} className="flex items-center gap-3">
                <div className="w-44 flex-shrink-0">
                  <div className="text-sm font-medium text-stone-700">{d.label}</div>
                  <div className="text-[11px] text-stone-400 leading-tight">{d.hint}</div>
                </div>
                <div className="flex gap-1 flex-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setScore(d.key, n)}
                      className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium border ${
                        scores[d.key] === n
                          ? "bg-brand text-white border-brand"
                          : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Narrative notes (optional)</label>
            <textarea value={narrative} onChange={(e) => setNarrative(e.target.value)} rows={3} placeholder="Specifics from this case — patient interactions, decisions made, anything noteworthy." className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed" />
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Flag severity</label>
            <div className="grid grid-cols-3 gap-2">
              {FLAG_OPTIONS.map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setFlagSeverity(opt.v as typeof flagSeverity)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border ${
                    flagSeverity === opt.v ? "border-stone-700 ring-2 ring-stone-300 " + opt.cls : opt.cls
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {flagSeverity === "immediate_termination_recommended" && (
              <div className="mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
                ⚠ This flag auto-advances the candidate to <strong>Decision</strong> stage and alerts super-admins.
              </div>
            )}
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting || !allScored} className="bg-brand text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {submitting ? "Saving…" : "Save observation case"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
