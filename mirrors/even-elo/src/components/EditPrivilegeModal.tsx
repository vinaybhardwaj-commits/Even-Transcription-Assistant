"use client";

import { useState } from "react";

interface PrivilegeIn {
  id: string;
  physician_id: string;
  hospital_code: string;
  procedure_or_specialty: string;
  is_core: boolean;
  expires_at: string | null;
  withdrawn_date: string | null;
  withdrawn_reason: string | null;
}

export function EditPrivilegeModal({
  privilege,
  onClose,
  onSaved,
}: {
  privilege: PrivilegeIn;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialExpiry =
    privilege.expires_at ? privilege.expires_at.slice(0, 10) : "";
  const [isCore, setIsCore] = useState<boolean>(privilege.is_core);
  const [expiresAt, setExpiresAt] = useState<string>(initialExpiry);
  const [withdraw, setWithdraw] = useState<boolean>(!!privilege.withdrawn_date);
  const [reason, setReason] = useState<string>(privilege.withdrawn_reason ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (withdraw && !reason.trim()) {
      setError("Reason required when withdrawing.");
      return;
    }
    setError(null); setSubmitting(true);
    const body: Record<string, unknown> = { is_core: isCore };
    // Send expires_at only if it changed from the initial (or if core toggled)
    if (isCore) {
      body.expires_at = null; // Core privileges don't expire
    } else if (expiresAt && expiresAt !== initialExpiry) {
      body.expires_at = expiresAt;
    } else if (!expiresAt && initialExpiry) {
      body.expires_at = null;
    }
    if (withdraw && !privilege.withdrawn_date) {
      body.withdrawn_date = new Date().toISOString().slice(0, 10);
      body.withdrawn_reason = reason.trim();
    } else if (!withdraw && privilege.withdrawn_date) {
      body.withdrawn_date = null;
      body.withdrawn_reason = null;
    } else if (withdraw && privilege.withdrawn_date && reason.trim() !== (privilege.withdrawn_reason ?? "")) {
      body.withdrawn_reason = reason.trim();
    }

    try {
      const r = await fetch(`/api/physicians/${privilege.physician_id}/privileges/${privilege.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not save changes.");
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
            <h2 className="text-base font-semibold tracking-tight">Edit privilege</h2>
            <div className="text-xs text-stone-500 mt-0.5">{privilege.procedure_or_specialty} · {privilege.hospital_code}</div>
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">Type</label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setIsCore(true)} className={`px-3 py-2 rounded-lg text-xs font-medium border ${isCore ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"}`}>
                Core
              </button>
              <button type="button" onClick={() => setIsCore(false)} className={`px-3 py-2 rounded-lg text-xs font-medium border ${!isCore ? "bg-violet-600 text-white border-violet-600" : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"}`}>
                Special
              </button>
            </div>
            <div className="text-[11px] text-stone-400 mt-1">
              {isCore
                ? "Core privileges don't expire; switching from Special clears the expiry date."
                : "Special privileges have an expiry; switching from Core defaults expiry to 1 year from today."}
            </div>
          </div>

          {!isCore && (
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Expires on</label>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
              <div className="text-[11px] text-stone-400 mt-1">
                Leave blank to clear expiry (rare — usually only when converting to Core).
              </div>
            </div>
          )}

          <div className="border-t border-stone-100 pt-4">
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={withdraw} onChange={(e) => setWithdraw(e.target.checked)} className="mt-1" />
              <div>
                <div className="font-medium text-stone-700">Withdraw this privilege</div>
                <div className="text-[11px] text-stone-500">
                  {privilege.withdrawn_date
                    ? "Already withdrawn — uncheck to restore."
                    : "Marks the privilege as withdrawn (audited). Doesn't delete the row."}
                </div>
              </div>
            </label>
            {withdraw && (
              <div className="mt-3">
                <label className="block text-xs font-medium text-stone-500 mb-1">Reason (required)</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="e.g. Doctor moved to a different specialty; competency concern; expiry not renewed."
                  className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed"
                />
              </div>
            )}
          </div>

          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
              {submitting ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
