"use client";

import { useState } from "react";

const CATEGORIES = [
  { v: "provisional", label: "Provisional", blurb: "Under supervision; cases proctored via FPPE." },
  { v: "active", label: "Active", blurb: "Full independent privileges; voting + on-call." },
  { v: "visiting_consultant", label: "Visiting Consultant", blurb: "Occasional use, no admin burden." },
  { v: "locum_tenens", label: "Locum Tenens", blurb: "Time-limited (maternity covers, staffing gaps)." },
  { v: "affiliate", label: "Affiliate / Referring", blurb: "Outpatient-only; refer + view EMR, no treatment." },
] as const;

type Category = (typeof CATEGORIES)[number]["v"];

export function ChangeCategoryModal({
  engagement,
  onClose,
  onSaved,
}: {
  engagement: {
    id: string;
    physician_id: string;
    hospital_code: string;
    category: string;
    start_date: string;
  };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState<Category>(engagement.category as Category);
  const [reason, setReason] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = category !== engagement.category;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!changed) { setError("Pick a different category to change."); return; }
    if (!reason.trim()) { setError("Reason required (audited)."); return; }
    setError(null); setSubmitting(true);
    try {
      const r = await fetch(`/api/physicians/${engagement.physician_id}/engagements/${engagement.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          status_reason: `Category change ${engagement.category} → ${category}: ${reason.trim()}`,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not change category.");
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[520px] shadow-xl">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Change engagement category</h2>
            <div className="text-xs text-stone-500 mt-0.5">{engagement.hospital_code} · current: <strong>{engagement.category.replace(/_/g, " ")}</strong></div>
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">New category</label>
            <div className="space-y-1.5">
              {CATEGORIES.map((c) => (
                <label
                  key={c.v}
                  className={`flex items-start gap-3 px-3 py-2.5 border rounded-lg cursor-pointer ${category === c.v ? "border-brand bg-brand/5" : "border-stone-200 hover:border-stone-300"}`}
                >
                  <input
                    type="radio"
                    name="cat"
                    checked={category === c.v}
                    onChange={() => setCategory(c.v)}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-stone-800">{c.label}{c.v === engagement.category && <span className="ml-1.5 text-[10px] text-stone-400">· current</span>}</div>
                    <div className="text-[11px] text-stone-500 leading-relaxed">{c.blurb}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Reason (required, audited)</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Graduated from provisional after 6mo + FPPE satisfactory; demoted to provisional after concern raised; converted to VC after employment ended."
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed"
            />
          </div>

          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting || !changed} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
              {submitting ? "Saving…" : "Save change"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
