"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";

export function ChangePasswordModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (next.length < 10) { setError("New password must be at least 10 characters."); return; }
      if (next !== confirm) { setError("New + confirm don't match."); return; }
      if (next === current)  { setError("New password must differ from current."); return; }
      setSubmitting(true);
      try {
        const res = await fetch("/api/admin/password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_password: current, new_password: next }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
        onChanged();
      } catch (e2) {
        setError(e2 instanceof Error ? e2.message : String(e2));
        setSubmitting(false);
      }
    },
    [current, next, confirm, onChanged],
  );

  return (
    <div
      className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={onSubmit}
        className="rounded-xl bg-even-white border border-even-ink-100 p-6 max-w-sm w-full shadow-card-hover space-y-3"
      >
        <h3 className="text-heading text-even-navy-800">Change admin password</h3>
        <p className="text-caption text-even-ink-500">Minimum 10 characters. Different from current.</p>
        <div>
          <label htmlFor="cp-cur" className="block text-label text-even-navy-800 mb-1">Current password</label>
          <input id="cp-cur" type="password" autoComplete="current-password" value={current}
            onChange={(e) => setCurrent(e.target.value)} required
            className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
        </div>
        <div>
          <label htmlFor="cp-new" className="block text-label text-even-navy-800 mb-1">New password</label>
          <input id="cp-new" type="password" autoComplete="new-password" value={next}
            onChange={(e) => setNext(e.target.value)} required minLength={10}
            className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
        </div>
        <div>
          <label htmlFor="cp-conf" className="block text-label text-even-navy-800 mb-1">Confirm new password</label>
          <input id="cp-conf" type="password" autoComplete="new-password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} required minLength={10}
            className="w-full rounded-md border border-even-ink-200 px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300" />
        </div>
        {error ? <p className="text-caption text-danger-700">{error}</p> : null}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={submitting}
            className="text-label text-even-ink-500 hover:underline px-3 py-2">Cancel</button>
          <Button variant="primary" disabled={submitting}>{submitting ? "Saving…" : "Change password"}</Button>
        </div>
      </form>
    </div>
  );
}
