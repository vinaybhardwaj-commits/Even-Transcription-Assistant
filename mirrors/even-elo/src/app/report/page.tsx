"use client";

import { useEffect, useRef, useState } from "react";

interface PublicPhysician {
  id: string;
  full_name: string;
  primary_specialty: string | null;
  hospitals_active: string | null;
}

const CATEGORIES: { v: string; label: string }[] = [
  { v: "", label: "Not sure / prefer not to say" },
  { v: "clinical", label: "Clinical care" },
  { v: "patient_safety", label: "Patient safety" },
  { v: "medical_error", label: "Medical error" },
  { v: "professionalism", label: "Professionalism / conduct" },
  { v: "documentation", label: "Documentation" },
  { v: "etiquette", label: "Communication / etiquette" },
  { v: "vendor_compliance", label: "Billing / compliance" },
  { v: "other", label: "Other" },
];

export default function ReportPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicPhysician[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<PublicPhysician | null>(null);
  const [category, setCategory] = useState("");
  const [narrative, setNarrative] = useState("");
  const [attest, setAttest] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (picked) return; // not searching once a doctor is chosen
    if (q.trim().length < 2) { setResults([]); return; }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/public/physicians?q=${encodeURIComponent(q.trim())}`, { cache: "no-store" });
        const j = await r.json();
        setResults(j.ok ? (j.rows as PublicPhysician[]) : []);
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [q, picked]);

  async function submit() {
    setError(null);
    if (!name.trim()) return setError("Please enter your name.");
    if (!email.trim()) return setError("Please enter your email address.");
    if (!picked) return setError("Please search for and select the doctor your report is about.");
    if (narrative.trim().length < 10) return setError("Please describe what happened.");
    if (!attest) return setError("Please tick the confirmation box before submitting.");
    setSubmitting(true);
    try {
      const r = await fetch("/api/public/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_physician_id: picked.id,
          reporter_name: name.trim(),
          reporter_email: email.trim(),
          category,
          narrative: narrative.trim(),
          attestation: true,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || "Something went wrong. Please try again."); return; }
      setDone(true);
    } catch {
      setError("Could not submit right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-emerald-600 text-white grid place-items-center text-xs font-bold">EVEN</div>
          <div className="leading-tight">
            <div className="font-semibold text-slate-900">Even Hospitals</div>
            <div className="text-xs text-slate-500">Report a concern about a doctor</div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        {done ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
            <div className="text-2xl mb-2">Thank you</div>
            <p className="text-slate-700">Your report has been recorded and will be reviewed by the hospital governance team. We may contact you at the email you provided if we need more detail.</p>
            <button
              onClick={() => { setDone(false); setName(""); setEmail(""); setQ(""); setPicked(null); setResults([]); setCategory(""); setNarrative(""); setAttest(false); }}
              className="mt-6 px-4 py-2 rounded-lg border border-emerald-300 bg-white text-emerald-800 text-sm font-medium hover:bg-emerald-50"
            >Submit another report</button>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 space-y-6">
            <p className="text-sm text-slate-600">
              Use this form to raise a concern about a doctor at an Even hospital. You do not need an account. Your name and
              email are recorded with the report as confirmation of who raised it — they are visible only to the hospital
              governance team.
            </p>

            {/* Reporter identity */}
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Your name <span className="text-rose-600">*</span></label>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="Full name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Your email <span className="text-rose-600">*</span></label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" maxLength={200}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="you@example.com" />
              </div>
            </div>

            {/* Doctor picker */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Which doctor is this about? <span className="text-rose-600">*</span></label>
              {picked ? (
                <div className="flex items-center justify-between rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2">
                  <div className="text-sm">
                    <span className="font-medium text-slate-900">{picked.full_name}</span>
                    <span className="text-slate-500">{picked.primary_specialty ? ` · ${picked.primary_specialty}` : ""}{picked.hospitals_active ? ` · ${picked.hospitals_active}` : ""}</span>
                  </div>
                  <button onClick={() => { setPicked(null); setQ(""); }} className="text-xs text-slate-500 hover:text-slate-800 underline">Change</button>
                </div>
              ) : (
                <>
                  <input value={q} onChange={(e) => setQ(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder="Start typing the doctor's name…" />
                  {q.trim().length >= 2 && (
                    <div className="mt-2 rounded-lg border border-slate-200 divide-y divide-slate-100 max-h-60 overflow-auto">
                      {searching && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
                      {!searching && results.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No matching doctor found.</div>}
                      {results.map((p) => (
                        <button key={p.id} onClick={() => { setPicked(p); setResults([]); }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50">
                          <span className="font-medium text-slate-900">{p.full_name}</span>
                          <span className="text-slate-500">{p.primary_specialty ? ` · ${p.primary_specialty}` : ""}{p.hospitals_active ? ` · ${p.hospitals_active}` : ""}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Category */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">What is this about?</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                {CATEGORIES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
              </select>
            </div>

            {/* Narrative */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">What happened? <span className="text-rose-600">*</span></label>
              <textarea value={narrative} onChange={(e) => setNarrative(e.target.value)} rows={6} maxLength={8000}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder="Please include the date, time, place, and anyone involved. Be as specific as you can." />
              <div className="text-xs text-slate-400 mt-1">{narrative.length}/8000</div>
            </div>

            {/* Attestation */}
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
              <span>I confirm that this report is accurate and true to the best of my knowledge.</span>
            </label>

            {error && <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-800">{error}</div>}

            <button onClick={submit} disabled={submitting}
              className="w-full rounded-lg bg-emerald-600 text-white text-sm font-semibold py-2.5 hover:bg-emerald-700 disabled:opacity-60">
              {submitting ? "Submitting…" : "Submit report"}
            </button>
            <p className="text-xs text-slate-400 text-center">Even Hospitals · governance &amp; quality</p>
          </div>
        )}
      </main>
    </div>
  );
}
