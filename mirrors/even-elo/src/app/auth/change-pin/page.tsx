"use client";

import { useState } from "react";

export default function ChangePinPage() {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^\d{4}$/.test(pin) && pin === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{4}$/.test(pin)) { setError("PIN must be exactly 4 digits."); return; }
    if (pin !== confirm) { setError("The two PINs don't match."); return; }
    setSubmitting(true);
    try {
      const r = await fetch("/api/auth/change-pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ new_pin: pin }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || "Could not set PIN."); setSubmitting(false); return; }
      window.location.href = "/home";
    } catch {
      setError("Network error."); setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-stone-50 px-4">
      <form onSubmit={submit} className="bg-white border border-stone-200 rounded-xl p-6 w-full max-w-sm">
        <h1 className="text-lg font-semibold tracking-tight">Set a new PIN</h1>
        <p className="text-sm text-stone-500 mt-1 mb-5">Your account was created with a temporary PIN. Choose a new 4-digit PIN to continue.</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">New PIN</label>
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm num outline-none focus:border-brand" placeholder="****" autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Confirm PIN</label>
            <input type="password" inputMode="numeric" value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, "").slice(0, 4))} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm num outline-none focus:border-brand" placeholder="****" />
          </div>
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          <button type="submit" disabled={!valid || submitting} className="w-full bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? "Saving..." : "Set PIN & continue"}
          </button>
        </div>
      </form>
    </main>
  );
}
