"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TopNav } from "@/components/TopNav";

const COMMITMENTS = [
  { key: "ot_timings", label: "Acknowledged OT timings and on-time arrival expectations" },
  { key: "formulary", label: "Will work within hospital formulary; will not push off-formulary drugs without justification" },
  { key: "vendor_mou", label: "Will not steer vendor selection; will respect hospital MOUs" },
  { key: "rental_equipment", label: "Understands rental-equipment policy and approval workflow" },
  { key: "weekend_protocol", label: "Acknowledges weekend/holiday on-call protocol" },
];

const SPECIALTIES = [
  "General Surgery", "Cardiology", "Cardiothoracic Surgery", "Orthopaedics",
  "Neurology", "Neurosurgery", "Anaesthesia", "Gastroenterology", "Urology",
  "Plastics", "ENT", "Ophthalmology", "Paediatrics", "OBGYN", "Internal Medicine",
  "Dermatology", "Pulmonology", "Nephrology", "Endocrinology", "Oncology",
  "Radiology", "Pathology", "Emergency Medicine", "Other",
];

export default function NewPrescreenPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [hospitals, setHospitals] = useState<Array<{ code: string }>>([]);
  const [pickedCodes, setPickedCodes] = useState<Set<string>>(new Set());
  const [yearsPg, setYearsPg] = useState("");
  const [priorsText, setPriorsText] = useState("");
  const [redFlags, setRedFlags] = useState("");
  const [commitments, setCommitments] = useState<Record<string, boolean>>({});
  const [override, setOverride] = useState(false);
  const [decision, setDecision] = useState<"invite" | "reject">("invite");

  useEffect(() => {
    fetch("/api/hospitals").then((r) => r.json()).then((j) => {
      if (j.ok) setHospitals(j.hospitals as Array<{ code: string }>);
    }).catch(() => undefined);
  }, []);

  function togglePick(code: string) {
    setPickedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priorRejectId, setPriorRejectId] = useState<string | null>(null);

  function toggleC(key: string) {
    setCommitments((c) => ({ ...c, [key]: !c[key] }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !fullName.trim()) {
      setError("Email and name are required.");
      return;
    }
    if (decision === "invite" && !COMMITMENTS.every((c) => commitments[c.key])) {
      setError("For invite, all 5 commitments must be acknowledged.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const priors = priorsText
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    try {
      const r = await fetch("/api/vc-onboarding/prescreens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prospective_email: email.trim(),
          prospective_full_name: fullName.trim(),
          prospective_specialty: specialty || null,
          hospital_codes: Array.from(pickedCodes),
          years_post_postgraduate: yearsPg ? parseInt(yearsPg, 10) : null,
          prior_corporate_hospitals: priors,
          commitments_acknowledged: commitments,
          red_flags: redFlags.trim() || null,
          decision,
          decision_rationale: rationale.trim() || null,
          cooldown_override: override,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Pre-screen submit failed.");
        if (j.prior_reject_id) setPriorRejectId(j.prior_reject_id);
        setSubmitting(false);
        return;
      }
      router.push(`/onboarding/${j.prescreen.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  const allCommitmentsAck = COMMITMENTS.every((c) => commitments[c.key]);

  return (
    <>
      <TopNav />
      <main className="max-w-[800px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2">
          <Link href="/onboarding" className="hover:text-stone-900">Credentialing</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">New invitation</span>
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">VC pre-screen</h1>
        <p className="text-sm text-stone-500 mt-1 mb-6">
          Stage 1 of 3. Decide whether to invite this VC for observation (3 cases minimum) or reject.
          Rejecting locks the email out for 12 months unless a super-admin overrides.
        </p>

        <form onSubmit={submit} className="space-y-4">
          <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-semibold">Prospective VC</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Email *</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dr.example@…" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Full name *</label>
                <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Dr Jane Doe" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Primary specialty</label>
                <select value={specialty} onChange={(e) => setSpecialty(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                  <option value="">—</option>
                  {SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-stone-500 mb-1">Hospitals * <span className="text-stone-400 font-normal">(multi-select for network VCs)</span></label>
                <div className="flex flex-wrap gap-1.5">
                  {hospitals.map((h) => {
                    const on = pickedCodes.has(h.code);
                    return (
                      <button type="button" key={h.code} onClick={() => togglePick(h.code)} className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${on ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}>
                        {h.code}
                      </button>
                    );
                  })}
                </div>
                {pickedCodes.size === 0 && <div className="text-[11px] text-stone-400 mt-1">Pick at least one</div>}
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1">Years post-PG</label>
                <input type="number" value={yearsPg} onChange={(e) => setYearsPg(e.target.value)} min="0" max="60" placeholder="8" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Prior corporate hospitals (one per line)</label>
              <textarea value={priorsText} onChange={(e) => setPriorsText(e.target.value)} rows={2} placeholder="Apollo BG Road · 2019-2022&#10;Manipal HAL Road · 2022-present" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed" />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Red flags (free-text)</label>
              <textarea value={redFlags} onChange={(e) => setRedFlags(e.target.value)} rows={2} placeholder="Anything you've heard from colleagues, prior workplaces, or peer reviews." className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed" />
            </div>
          </section>

          <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold">Commitments (required for invite)</h2>
            {COMMITMENTS.map((c) => (
              <label key={c.key} className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={!!commitments[c.key]} onChange={() => toggleC(c.key)} className="mt-0.5 accent-[color:var(--color-brand,#0f766e)]" />
                <span className="text-sm text-stone-700 leading-relaxed">{c.label}</span>
              </label>
            ))}
            {!allCommitmentsAck && decision === "invite" && (
              <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                All 5 must be acknowledged before invite.
              </div>
            )}
          </section>

          <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold">Decision</h2>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setDecision("invite")} className={`px-3 py-2.5 rounded-lg text-sm font-medium border ${decision === "invite" ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"}`}>
                Invite for observation
              </button>
              <button type="button" onClick={() => setDecision("reject")} className={`px-3 py-2.5 rounded-lg text-sm font-medium border ${decision === "reject" ? "bg-red-600 text-white border-red-600" : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"}`}>
                Reject
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Rationale (optional)</label>
              <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} placeholder={decision === "reject" ? "Why are we rejecting? (will be visible in audit)" : "Optional notes on the invite decision"} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed" />
            </div>
            <label className="flex items-start gap-2.5 cursor-pointer text-xs text-stone-600">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="mt-0.5 accent-[color:var(--color-brand,#0f766e)]" />
              <span>Override 12-month cooldown (super-admin only — used when a previously-rejected email needs re-screening within the cooldown window)</span>
            </label>
          </section>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
              {priorRejectId && (
                <>
                  {" "}
                  <Link href={`/onboarding/${priorRejectId}`} className="text-brand font-medium">View prior reject →</Link>
                </>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Link href="/onboarding" className="btn-ghost">Cancel</Link>
            <button type="submit" disabled={submitting || (decision === "invite" && !allCommitmentsAck)} className="bg-brand text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {submitting ? "Submitting…" : `Submit ${decision}`}
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
