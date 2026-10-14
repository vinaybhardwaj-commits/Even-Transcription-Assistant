"use client";
import { useState } from "react";

export default function PortalLogin() {
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setSubmitting(true);
    try {
      const r = await fetch("/api/portal/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim().toLowerCase(), pin }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || "Login failed."); setSubmitting(false); return; }
      window.location.href = j.must_change_pin ? "/portal/set-pin" : "/portal";
    } catch { setError("Network error."); setSubmitting(false); }
  }

  async function requestPin() {
    setError(null); setNotice(null);
    if (!email.trim() || !email.includes("@")) { setError("Enter your hospital email above, then tap ‘Email me a PIN’."); return; }
    setRequesting(true);
    try {
      const r = await fetch("/api/portal/auth/request-pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim().toLowerCase() }) });
      const j = await r.json();
      setNotice(j.message || "If an account exists for that email, a PIN has been sent to it.");
    } catch { setError("Network error."); }
    setRequesting(false);
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-b from-teal-50 to-stone-50 px-4">
      <form onSubmit={submit} className="bg-white border border-stone-200 rounded-2xl p-7 w-full max-w-sm shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-teal-600 text-white text-xs font-bold">EPI</span>
          <span className="font-semibold">Even Physician Portal</span>
        </div>
        <p className="text-sm text-stone-500 mt-1 mb-5">Sign in with your hospital email and portal PIN.</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-3 border border-stone-200 rounded-lg text-[16px] outline-none focus:border-teal-600" placeholder="you@even.in" autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">PIN</label>
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} className="w-full px-3 py-3 border border-stone-200 rounded-lg text-[16px] num outline-none focus:border-teal-600" placeholder="****" />
          </div>
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          {notice && <div className="text-sm text-teal-800 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">{notice}</div>}
          <button type="submit" disabled={submitting || !email.trim() || pin.length !== 4} className="w-full bg-teal-600 text-white px-4 py-3 rounded-lg text-[16px] font-semibold hover:bg-teal-700 disabled:opacity-50">
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </div>
        <div className="mt-4 pt-4 border-t border-stone-100 text-center">
          <p className="text-xs text-stone-500 mb-1">First time here, or forgot your PIN?</p>
          <button type="button" onClick={requestPin} disabled={requesting} className="text-sm font-medium text-teal-700 hover:text-teal-800 disabled:opacity-50">
            {requesting ? "Sending…" : "Email me a PIN"}
          </button>
        </div>
      </form>
    </main>
  );
}
