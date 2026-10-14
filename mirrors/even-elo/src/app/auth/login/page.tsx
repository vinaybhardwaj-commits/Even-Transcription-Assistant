"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState(["", "", "", ""]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];
  const router = useRouter();

  function setDigit(i: number, v: string) {
    const d = v.replace(/\D/g, "").slice(0, 1);
    const next = [...pin];
    next[i] = d;
    setPin(next);
    if (d && i < 3) refs[i + 1].current?.focus();
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    const fullPin = pin.join("");
    if (fullPin.length !== 4) {
      setError("Enter all 4 digits.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, pin: fullPin }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Login failed.");
        setSubmitting(false);
        return;
      }
      router.push("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-stone-50 px-4">
      <div className="w-full max-w-[420px]">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-[10px] flex items-center justify-center bg-brand">
            <span className="text-white text-[13px] font-semibold tracking-wide">EPI</span>
          </div>
          <div>
            <div className="text-lg font-semibold tracking-tight">Even Physician Index</div>
            <div className="text-xs text-stone-500">Sign in to your account</div>
          </div>
        </div>

        <form onSubmit={submit} className="bg-white border border-stone-200 rounded-xl p-7">
          <label className="block text-xs font-medium text-stone-500 mb-1.5">Email</label>
          <input
            type="email"
            placeholder="you@even.in"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand mb-4"
            autoFocus
          />

          <label className="block text-xs font-medium text-stone-500 mb-1.5">4-digit PIN</label>
          <div className="flex gap-2 mb-5">
            {pin.map((d, i) => (
              <input
                key={i}
                ref={refs[i]}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={1}
                value={d}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && !pin[i] && i > 0) refs[i - 1].current?.focus();
                }}
                className="w-12 h-12 border border-stone-200 rounded-lg text-center text-lg font-medium outline-none focus:border-brand"
              />
            ))}
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 rounded-lg text-sm font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-60"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          <div className="text-center mt-5 text-xs text-stone-500">
            First time?{" "}
            <Link href="/auth/signup" className="text-brand font-medium">Create an account</Link>
          </div>
        </form>

        <div className="text-center mt-6 text-[11px] text-stone-400">
          Only @even.in addresses can sign in. New accounts require admin approval.
        </div>
      </div>
    </div>
  );
}
