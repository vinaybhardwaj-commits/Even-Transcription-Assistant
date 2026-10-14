"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const TRIGGERS = [
  {
    v: "new_employed_provisional",
    label: "New employed (Provisional)",
    blurb: "5 proctored cases required before the doctor graduates to Active.",
  },
  {
    v: "special_privilege_request",
    label: "Special-privilege request",
    blurb: "3 proctored cases for the new advanced/high-risk procedure scope.",
  },
  {
    v: "concern_raised",
    label: "Concern raised",
    blurb: "5 cases under heightened review. Mandatory super-admin sign-off.",
  },
] as const;

type Trigger = (typeof TRIGGERS)[number]["v"];

export function TriggerFppeModal({
  physicianId,
  physicianName,
  hospitalOptions,
  onClose,
}: {
  physicianId: string;
  physicianName: string;
  hospitalOptions: Array<{ code: string }>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [trigger, setTrigger] = useState<Trigger>("concern_raised");
  const [hospitalCode, setHospitalCode] = useState<string>(hospitalOptions[0]?.code ?? "");
  const [notes, setNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!hospitalCode) { setError("Pick a hospital."); return; }
    setError(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/physicians/${physicianId}/fppe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger, hospital_code: hospitalCode, notes: notes.trim() || null }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not start FPPE.");
        setSubmitting(false);
        return;
      }
      router.push(`/onboarding/${j.prescreen_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[520px] shadow-xl">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Trigger FPPE</h2>
            <div className="text-xs text-stone-500 mt-0.5">Focused Professional Practice Evaluation · {physicianName}</div>
            <a href="/guide#fppe" target="_blank" rel="noopener noreferrer" className="text-[11px] text-brand hover:underline">What is FPPE? →</a>
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">Why are you triggering this FPPE?</label>
            <div className="space-y-1.5">
              {TRIGGERS.map((t) => (
                <label
                  key={t.v}
                  className={`flex items-start gap-3 px-3 py-2.5 border rounded-lg cursor-pointer ${
                    trigger === t.v ? "border-brand bg-brand/5" : "border-stone-200 hover:border-stone-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="fppe-trigger"
                    checked={trigger === t.v}
                    onChange={() => setTrigger(t.v)}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-stone-800">{t.label}</div>
                    <div className="text-[11px] text-stone-500 leading-relaxed">{t.blurb}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">At which hospital?</label>
            {hospitalOptions.length === 0 ? (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                No active engagement found — physician must be engaged at a hospital before an FPPE can run there.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {hospitalOptions.map((h) => (
                  <button
                    key={h.code}
                    type="button"
                    onClick={() => setHospitalCode(h.code)}
                    className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${
                      hospitalCode === h.code ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"
                    }`}
                  >
                    {h.code}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What prompted this — incident, complaint, new procedure scope, recent hire?"
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed"
            />
          </div>

          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button
              type="submit"
              disabled={submitting || hospitalOptions.length === 0}
              className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60"
            >
              {submitting ? "Starting…" : "Start FPPE"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
