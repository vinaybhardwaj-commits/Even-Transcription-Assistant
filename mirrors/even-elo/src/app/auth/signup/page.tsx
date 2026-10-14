"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Position {
  id: string;
  position_name: string;
}
interface Hospital {
  id: string;
  code: string;
}
interface RoleRequest {
  hospital_code: string;
  role: string;
}
const ROLE_OPTS = [
  { value: "site_medical_head", label: "Site Medical Head" },
  { value: "hr", label: "HR" },
  { value: "sgc_member", label: "SGC member" },
];

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [positionId, setPositionId] = useState("");
  const [pin, setPin] = useState(["", "", "", ""]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [homeHospital, setHomeHospital] = useState("EHRC");
  const [roleReqs, setRoleReqs] = useState<RoleRequest[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];
  const router = useRouter();

  useEffect(() => {
    fetch("/api/positions")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && Array.isArray(j.positions)) setPositions(j.positions);
      })
      .catch(() => undefined);
    fetch("/api/hospitals-public")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && Array.isArray(j.hospitals)) {
          setHospitals(j.hospitals);
          if (j.hospitals[0]?.code) setHomeHospital(j.hospitals[0].code);
        }
      })
      .catch(() => undefined);
  }, []);

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
    setSuccess(null);
    const fullPin = pin.join("");
    if (fullPin.length !== 4) {
      setError("Enter all 4 digits.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          full_name: fullName,
          pin: fullPin,
          position_id: positionId,
          hospital_code: homeHospital,
          requested_roles: roleReqs.filter((rr) => rr.hospital_code && rr.role),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Signup failed.");
        setSubmitting(false);
        return;
      }
      if (j.autoLogin) {
        router.push("/home");
      } else {
        setSuccess("Account created. Awaiting admin approval.");
        setTimeout(() => router.push("/auth/pending"), 1200);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-stone-50 px-4 py-8">
      <div className="w-full max-w-[460px]">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-[10px] flex items-center justify-center bg-brand">
            <span className="text-white text-[13px] font-semibold tracking-wide">EPI</span>
          </div>
          <div>
            <div className="text-lg font-semibold tracking-tight">Even Physician Index</div>
            <div className="text-xs text-stone-500">Create your account</div>
          </div>
        </div>

        <form onSubmit={submit} className="bg-white border border-stone-200 rounded-xl p-7">
          <label className="block text-xs font-medium text-stone-500 mb-1.5">Email (@even.in)</label>
          <input
            type="email"
            placeholder="you@even.in"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand mb-4"
            autoFocus
          />

          <label className="block text-xs font-medium text-stone-500 mb-1.5">Full name</label>
          <input
            type="text"
            placeholder="Dr Jane Doe"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand mb-4"
          />

          <label className="block text-xs font-medium text-stone-500 mb-1.5">Home hospital</label>
          <select
            value={homeHospital}
            onChange={(e) => setHomeHospital(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand mb-4 bg-white"
          >
            {hospitals.map((h) => <option key={h.code} value={h.code}>{h.code}</option>)}
          </select>

          <label className="block text-xs font-medium text-stone-500 mb-1.5">Your position</label>
          <select
            value={positionId}
            onChange={(e) => setPositionId(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand mb-4 bg-white"
          >
            <option value="">— Select position —</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>{p.position_name}</option>
            ))}
          </select>

          <label className="block text-xs font-medium text-stone-500 mb-1.5">Hospital roles I need <span className="text-stone-400 font-normal">(optional — admin will review)</span></label>
          <div className="mb-4 space-y-1.5">
            {roleReqs.map((rr, i) => (
              <div key={i} className="flex gap-2 items-center">
                <select
                  value={rr.hospital_code}
                  onChange={(e) => setRoleReqs((prev) => prev.map((x, j) => j === i ? { ...x, hospital_code: e.target.value } : x))}
                  className="flex-1 px-2 py-1.5 border border-stone-200 rounded-lg text-xs bg-white"
                >
                  <option value="">— hospital —</option>
                  {hospitals.map((h) => <option key={h.code} value={h.code}>{h.code}</option>)}
                </select>
                <select
                  value={rr.role}
                  onChange={(e) => setRoleReqs((prev) => prev.map((x, j) => j === i ? { ...x, role: e.target.value } : x))}
                  className="flex-1 px-2 py-1.5 border border-stone-200 rounded-lg text-xs bg-white"
                >
                  <option value="">— role —</option>
                  {ROLE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button type="button" onClick={() => setRoleReqs((prev) => prev.filter((_, j) => j !== i))} className="text-stone-400 hover:text-red-700 px-1.5 text-base" title="Remove">×</button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRoleReqs((prev) => [...prev, { hospital_code: "", role: "" }])}
              className="text-[12px] text-brand font-medium hover:underline"
            >
              + Request role
            </button>
          </div>

          <label className="block text-xs font-medium text-stone-500 mb-1.5">Choose a 4-digit PIN</label>
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
          {success && (
            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-4">
              {success}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 rounded-lg text-sm font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-60"
          >
            {submitting ? "Creating account…" : "Create account"}
          </button>

          <div className="text-center mt-5 text-xs text-stone-500">
            Already have an account?{" "}
            <Link href="/auth/login" className="text-brand font-medium">Sign in</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
