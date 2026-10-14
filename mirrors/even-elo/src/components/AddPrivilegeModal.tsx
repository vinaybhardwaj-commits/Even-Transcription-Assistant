"use client";

import { useEffect, useState } from "react";

const BASIS_OPTIONS = [
  { v: "initial", label: "Initial grant" },
  { v: "annual_review", label: "Annual review" },
  { v: "case_review", label: "Case review" },
  { v: "vc_observation_pass", label: "VC observation pass" },
] as const;

type Hospital = { id: string; code: string };

export function AddPrivilegeModal({
  physicianId,
  defaultSpecialty,
  engagedHospitalCodes,
  onClose,
  onSaved,
}: {
  physicianId: string;
  defaultSpecialty?: string | null;
  engagedHospitalCodes?: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [hospitalCode, setHospitalCode] = useState<string>(engagedHospitalCodes?.[0] ?? "");
  const [mode, setMode] = useState<"core" | "special">("core");
  const [scope, setScope] = useState(defaultSpecialty ?? "");
  const [grantedDate, setGrantedDate] = useState(new Date().toISOString().slice(0, 10));
  const [basis, setBasis] = useState<string>("initial");

  // Special-only fields
  const [expiresAt, setExpiresAt] = useState<string>(() => {
    const d = new Date(); d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [evidenceText, setEvidenceText] = useState<string>("");
  const [triggerFppe, setTriggerFppe] = useState<boolean>(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: "core" | "special"; message: string; linked_prescreen_id?: string | null } | null>(null);

  useEffect(() => {
    fetch("/api/hospitals").then((r) => r.json()).then((j) => {
      if (j.ok) {
        const opts = (j.hospitals as Hospital[]).filter((h) => !engagedHospitalCodes || engagedHospitalCodes.includes(h.code));
        setHospitals(opts);
        if (!hospitalCode && opts.length > 0) setHospitalCode(opts[0].code);
      }
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!scope.trim()) { setError("Scope / procedure / specialty required."); return; }
    if (!hospitalCode) { setError("Pick a hospital."); return; }
    setError(null); setSubmitting(true);
    try {
      if (mode === "core") {
        const r = await fetch(`/api/physicians/${physicianId}/privileges`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hospital_code: hospitalCode,
            procedure_or_specialty: scope.trim(),
            granted_date: grantedDate,
            basis,
            is_core: true,
            expires_at: null,
          }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) { setError(j.error || "Could not grant Core privilege."); setSubmitting(false); return; }
        onSaved();
      } else {
        const r = await fetch(`/api/physicians/${physicianId}/privilege-requests`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hospital_code: hospitalCode,
            specialty: defaultSpecialty ?? null,
            scope_text: scope.trim(),
            evidence_jsonb: evidenceText.trim() ? { notes: evidenceText.trim(), expires_at: expiresAt } : { expires_at: expiresAt },
            trigger_fppe: triggerFppe,
          }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) { setError(j.error || "Could not file privilege request."); setSubmitting(false); return; }
        setResult({
          kind: "special",
          message: triggerFppe
            ? "Special-privilege request filed. A focused FPPE prescreen was auto-created — log cases there before approval."
            : "Special-privilege request filed. Awaiting SMH/super_admin decision.",
          linked_prescreen_id: j.linked_prescreen_id,
        });
        setSubmitting(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[560px] shadow-xl">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">
            {mode === "core" ? "Grant Core privilege" : "Request Special privilege"}
          </h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>

        {result?.kind === "special" ? (
          <div className="px-6 py-6 space-y-4">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-900">
              {result.message}
            </div>
            {result.linked_prescreen_id && (
              <div className="text-xs text-stone-600">
                Linked FPPE: <a className="text-brand font-medium" href={`/onboarding/${result.linked_prescreen_id}`}>open prescreen →</a>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => { onSaved(); }} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium">Done</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="px-6 py-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Type</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setMode("core")} className={`px-3 py-2 rounded-lg text-xs font-medium border ${mode === "core" ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"}`}>
                  Core (direct grant)
                </button>
                <button type="button" onClick={() => setMode("special")} className={`px-3 py-2 rounded-lg text-xs font-medium border ${mode === "special" ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"}`}>
                  Special (request + FPPE)
                </button>
              </div>
              <div className="text-[11px] text-stone-400 mt-1">
                Core privileges are standard for the specialty; Special privileges (e.g. Da Vinci, bariatric) need extra training proof + an FPPE before approval.
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Hospital</label>
              <div className="flex flex-wrap gap-1.5">
                {hospitals.map((h) => (
                  <button type="button" key={h.code} onClick={() => setHospitalCode(h.code)} className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${hospitalCode === h.code ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}>{h.code}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">{mode === "core" ? "Procedure or specialty *" : "Special-scope description *"}</label>
              <input
                type="text"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder={mode === "core" ? (defaultSpecialty ?? "e.g. General Surgery, Laparoscopic procedures") : "e.g. Robotic-assisted laparoscopic surgery (Da Vinci)"}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
                autoFocus
              />
            </div>

            {mode === "core" ? (
              <>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">Granted on</label>
                  <input type="date" value={grantedDate} onChange={(e) => setGrantedDate(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">Basis</label>
                  <div className="grid grid-cols-2 gap-2">
                    {BASIS_OPTIONS.map((opt) => (
                      <button key={opt.v} type="button" onClick={() => setBasis(opt.v)} className={`px-3 py-2 rounded-lg text-xs font-medium border ${basis === opt.v ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"}`}>{opt.label}</button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">Privilege expires on (default 1yr)</label>
                  <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">Evidence (training, case volume, certifications)</label>
                  <textarea value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} rows={2} placeholder="e.g. 200 cases logged at AIIMS · da Vinci Si certification 2024" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed" />
                </div>
                <div className="flex items-start gap-2">
                  <input id="trigger-fppe" type="checkbox" checked={triggerFppe} onChange={(e) => setTriggerFppe(e.target.checked)} className="mt-1" />
                  <label htmlFor="trigger-fppe" className="text-xs text-stone-700">
                    <strong>Trigger an FPPE</strong> before approval (recommended). 3 proctored cases with trigger=<span className="mono text-stone-500">special_privilege_request</span> will be required.
                  </label>
                </div>
              </>
            )}

            {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
              <button type="submit" disabled={submitting} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
                {submitting ? "Saving…" : mode === "core" ? "Grant privilege" : "File request"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
