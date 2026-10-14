"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface Physician {
  id: string;
  full_name: string;
  primary_specialty: string | null;
  email: string | null;
  current_status: string;
  hospitals_active: string | null;
}

interface MeSummary {
  email: string;
  full_name: string;
  position_label: string;
  hospital_code: string;
  is_super_admin?: boolean;
  is_sgc_member?: boolean;
}

const CATEGORIES: { v: string; label: string }[] = [
  { v: "clinical", label: "Clinical" },
  { v: "patient_safety", label: "Patient safety" },
  { v: "medical_error", label: "Medical error" },
  { v: "professionalism", label: "Professionalism" },
  { v: "documentation", label: "Documentation" },
  { v: "etiquette", label: "Etiquette" },
  { v: "vendor_compliance", label: "Vendor compliance" },
  { v: "other", label: "Other" },
];

// Feedback PRD #16 — accepted commendation taxonomy (positive feedback).
const COMMENDATIONS: string[] = [
  "Clinical Excellence",
  "Patient Experience",
  "Teamwork & Collaboration",
  "Teaching & Mentorship",
  "Going Above & Beyond",
];

const SEV_OPTIONS = [
  { v: "low", label: "Low", cls: "bg-stone-100 text-stone-700 border-stone-200" },
  { v: "medium", label: "Medium", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  { v: "high", label: "High", cls: "bg-orange-50 text-orange-800 border-orange-200" },
  { v: "critical", label: "Critical", cls: "bg-red-50 text-red-800 border-red-200" },
] as const;

const AVATAR_COLORS = [
  "bg-teal-100 text-teal-800", "bg-orange-100 text-orange-800", "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800", "bg-lime-100 text-lime-800", "bg-sky-100 text-sky-800",
];
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

type Source = "patient" | "peer" | "governance";
type Polarity = "positive" | "negative";

function NewIncidentInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const preselectedTarget = sp?.get("target") ?? "";

  // Form state
  const [me, setMe] = useState<MeSummary | null>(null);
  const [target, setTarget] = useState<Physician | null>(null);
  const [targetEngagements, setTargetEngagements] = useState<Array<{ hospital_id: string; hospital_code: string; status: string; start_date: string | null }>>([]);
  const [hospitalId, setHospitalId] = useState<string>("");
  const [physicians, setPhysicians] = useState<Physician[]>([]);
  const [q, setQ] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);

  // Feedback-model state
  const [source, setSource] = useState<Source>("patient");
  const [polarity, setPolarity] = useState<Polarity>("negative");
  const [commendation, setCommendation] = useState<string>("");
  const [rating, setRating] = useState<number | null>(null);
  const [patientRef, setPatientRef] = useState("");

  const [category, setCategory] = useState<string>("");
  const [severity, setSeverity] = useState<string>("medium");
  const [narrative, setNarrative] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [attest, setAttest] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((j) => j.ok && setMe(j.user));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const u = new URL("/api/physicians", window.location.origin);
      u.searchParams.set("status", "active");
      if (q.trim()) u.searchParams.set("q", q.trim());
      fetch(u.toString()).then((r) => r.json()).then((j) => {
        if (j.ok) setPhysicians(j.rows ?? []);
      });
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const id = target?.id || preselectedTarget;
    if (!id) return;
    fetch(`/api/physicians/${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          const engs = ((j.engagements ?? []) as Array<{ hospital_id: string; hospital_code: string; status: string; start_date: string | null }>)
            .filter((e) => e.status === "active")
            .sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""));
          setTargetEngagements(engs);
          if (engs[0]) setHospitalId(engs[0].hospital_id);
          if (preselectedTarget && !target) {
            setTarget({
              id: j.physician.id,
              full_name: j.physician.full_name,
              primary_specialty: j.physician.primary_specialty,
              email: j.physician.email,
              current_status: j.physician.current_status,
              hospitals_active: engs.map((e) => e.hospital_code).join(", ") || null,
            });
          }
        }
      });
  }, [preselectedTarget, target]);

  const step = useMemo<1 | 2 | 3>(() => (!target ? 1 : 3), [target]);
  const contentOk = polarity === "negative" ? (!!category && !!severity) : !!commendation;
  const canSubmit = !!target && contentOk && narrative.trim().length > 0 && attest && !submitting && !!hospitalId;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    setSubmitting(true);
    const evidence_urls = urlsText.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    try {
      const r = await fetch("/api/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_physician_id: target.id,
          hospital_id: hospitalId,
          anonymous_flag: isAnonymous,
          polarity,
          source,
          category: polarity === "negative" ? category : null,
          severity: polarity === "negative" ? severity : null,
          commendation_category: polarity === "positive" ? commendation : null,
          patient_rating: source === "patient" ? rating : null,
          patient_ref: source === "patient" ? patientRef.trim() : null,
          narrative: narrative.trim(),
          evidence_urls,
          attestation: true,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Submit failed.");
        setSubmitting(false);
        return;
      }
      router.push(`/incidents/${j.incident.id}?just_submitted=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  const isPositive = polarity === "positive";

  return (
    <>
      <TopNav />
      <main className="max-w-[800px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2">
          <Link href="/incidents" className="hover:text-stone-900">Patient Feedback</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">New report</span>
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">Record feedback or an incident</h1>
        <p className="text-sm text-stone-500 mt-1 mb-6">
          Capture patient feedback (positive or negative) or a peer concern about a physician.
          Negative reports reach the named physician via their profile; positive feedback is recorded as a commendation.
        </p>

        <div className="flex items-center gap-3 mb-7 text-xs">
          {[
            { n: 1, label: "Physician", done: step > 1, active: step === 1 },
            { n: 2, label: "Identity", done: step > 1, active: false },
            { n: 3, label: "Details", done: false, active: step === 3 },
          ].map((s, i) => (
            <div key={s.n} className="flex items-center gap-2 flex-1">
              <span className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-full text-[11px] font-medium ${
                s.done || s.active ? "bg-brand text-white" : "bg-stone-100 text-stone-500"
              }`}>{s.done ? "✓" : s.n}</span>
              <span className={s.active || s.done ? "font-medium text-stone-900" : "text-stone-500"}>{s.label}</span>
              {i < 2 && <div className={`flex-1 h-px ${s.done ? "bg-brand" : "bg-stone-200"}`} />}
            </div>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-4">
          {/* STEP 1 — Target */}
          <section className="bg-white border border-stone-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold mb-3">1. Physician this report concerns</h2>
            {target ? (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-stone-50">
                <span className={`w-10 h-10 rounded-full inline-flex items-center justify-center text-[12px] font-medium ${colorFor(target.full_name)}`}>
                  {initials(target.full_name)}
                </span>
                <div className="flex-1">
                  <div className="text-sm font-medium">{target.full_name}</div>
                  <div className="text-xs text-stone-500">
                    {target.primary_specialty ?? "—"}
                    {target.hospitals_active ? ` · ${target.hospitals_active}` : ""}
                  </div>
                </div>
                <button type="button" onClick={() => setTarget(null)} className="text-[12px] text-brand font-medium">Change</button>
              </div>
            ) : (
              <>
                <input
                  type="search"
                  placeholder="Search physicians by name, email, registration…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand mb-3"
                  autoFocus
                />
                <div className="max-h-72 overflow-y-auto divide-y divide-stone-100 border border-stone-100 rounded-lg">
                  {physicians.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-stone-500">
                      {q ? "No matching physicians." : "Start typing to search…"}
                    </div>
                  ) : physicians.map((p) => (
                    <button key={p.id} type="button" onClick={() => setTarget(p)}
                      className="w-full text-left px-3 py-2.5 hover:bg-stone-50 flex items-center gap-3">
                      <span className={`w-8 h-8 rounded-full inline-flex items-center justify-center text-[11px] font-medium ${colorFor(p.full_name)}`}>
                        {initials(p.full_name)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{p.full_name}</div>
                        <div className="text-xs text-stone-500">
                          {p.primary_specialty ?? "—"}{p.hospitals_active ? ` · ${p.hospitals_active}` : ""}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>

          {/* STEP 2 — Identity */}
          {target && (
            <section className="bg-white border border-stone-200 rounded-xl p-5">
              <h2 className="text-sm font-semibold mb-3">2. Your identity on this report</h2>
              <div className="grid grid-cols-2 gap-3">
                <label className={`flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer ${!isAnonymous ? "border-brand bg-brand-softer" : "border-stone-200 bg-white"}`}>
                  <input type="radio" checked={!isAnonymous} onChange={() => setIsAnonymous(false)} className="mt-1 accent-[color:var(--color-brand,#0f766e)]" />
                  <div>
                    <div className="text-sm font-medium">Identified · {me?.full_name?.split(" ").slice(-1)[0] ?? "you"}</div>
                    <div className="text-[11px] text-stone-500 mt-0.5">Your name is on this report.</div>
                  </div>
                </label>
                <label className={`flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer ${isAnonymous ? "border-brand bg-brand-softer" : "border-stone-200 bg-white"}`}>
                  <input type="radio" checked={isAnonymous} onChange={() => setIsAnonymous(true)} className="mt-1" />
                  <div>
                    <div className="text-sm font-medium">Anonymous</div>
                    <div className="text-[11px] text-stone-500 mt-0.5">Hidden from the physician &amp; peers. Admins always see the reporter.</div>
                  </div>
                </label>
              </div>
            </section>
          )}

          {/* STEP 3 — Details */}
          {target && (
            <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold">3. The feedback</h2>

              {/* Source + polarity */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">Source</label>
                  <div className="flex gap-1.5">
                    {([["patient", "Patient feedback"], ["peer", "Peer concern"], ...((me?.is_super_admin || me?.is_sgc_member) ? ([["governance", "Governance"]] as [Source, string][]) : [])] as [Source, string][]).map(([v, label]) => (
                      <button key={v} type="button" onClick={() => setSource(v)}
                        className={`px-3 py-1.5 rounded-full text-[12px] font-medium border ${source === v ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">Polarity</label>
                  <div className="flex gap-1.5">
                    {([["positive", "Positive"], ["negative", "Negative"]] as [Polarity, string][]).map(([v, label]) => (
                      <button key={v} type="button" onClick={() => setPolarity(v)}
                        className={`px-3 py-1.5 rounded-full text-[12px] font-medium border ${polarity === v ? (v === "positive" ? "bg-emerald-600 text-white border-emerald-600" : "bg-stone-800 text-white border-stone-800") : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Hospital */}
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1.5">Hospital this concerns *</label>
                {targetEngagements.length === 0 ? (
                  <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    {target?.full_name} has no active engagements — a super admin needs to add one first.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {targetEngagements.map((e) => (
                      <button key={e.hospital_id} type="button" onClick={() => setHospitalId(e.hospital_id)}
                        className={`px-3 py-1.5 rounded-full text-[12px] font-medium border ${hospitalId === e.hospital_id ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}>
                        {e.hospital_code}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Negative → category + severity */}
              {!isPositive && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1.5">Category</label>
                    <select value={category} onChange={(e) => setCategory(e.target.value)}
                      className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                      <option value="">— Choose a category —</option>
                      {CATEGORIES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1.5">Severity</label>
                    <div className="grid grid-cols-4 gap-2">
                      {SEV_OPTIONS.map((s) => (
                        <button key={s.v} type="button" onClick={() => setSeverity(s.v)}
                          className={`px-3 py-2 rounded-lg text-xs font-medium border ${severity === s.v ? "border-stone-700 ring-2 ring-stone-300 " + s.cls : s.cls}`}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* Positive → commendation category */}
              {isPositive && (
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">Commendation category</label>
                  <select value={commendation} onChange={(e) => setCommendation(e.target.value)}
                    className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                    <option value="">— Choose a commendation —</option>
                    {COMMENDATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}

              {/* Patient-source extras: rating + reference */}
              {source === "patient" && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1.5">Patient rating <span className="text-stone-400">(optional, 1–5)</span></label>
                    <div className="flex gap-1.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} type="button" onClick={() => setRating(rating === n ? null : n)}
                          className={`w-9 h-9 rounded-lg text-sm font-medium border ${rating === n ? "bg-brand text-white border-brand" : "bg-white text-stone-700 border-stone-200 hover:bg-stone-50"}`}>
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1.5">Patient reference <span className="text-stone-400">(optional)</span></label>
                    <input value={patientRef} onChange={(e) => setPatientRef(e.target.value)}
                      placeholder="Name or MRN — leave blank for anonymous"
                      className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand" />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1.5">{isPositive ? "Describe the positive feedback" : "Describe what happened"}</label>
                <textarea value={narrative} onChange={(e) => setNarrative(e.target.value)}
                  placeholder={isPositive ? "What did this physician do well? Be specific." : "Be specific about date, time, place, and any patients or staff affected."}
                  rows={6}
                  className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed" />
                <div className="text-[11px] text-stone-400 mt-1">{narrative.length} characters</div>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1.5">Evidence URLs (optional, one per line)</label>
                <textarea value={urlsText} onChange={(e) => setUrlsText(e.target.value)}
                  placeholder="https://…" rows={2}
                  className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-mono leading-relaxed" />
              </div>

              <div className="bg-stone-50 rounded-lg p-3.5">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-0.5 accent-[color:var(--color-brand,#0f766e)]" />
                  <span className="text-sm leading-relaxed text-stone-700">
                    <strong>I attest that the information in this report is true to the best of my knowledge.</strong>
                  </span>
                </label>
              </div>

              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

              <div className="flex justify-end gap-2 pt-1">
                <Link href="/incidents" className="btn-ghost">Cancel</Link>
                <button type="submit" disabled={!canSubmit}
                  className="bg-brand text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed">
                  {submitting ? "Submitting…" : "Submit report"}
                </button>
              </div>
            </section>
          )}
        </form>
      </main>
    </>
  );
}

export default function NewIncidentPage() {
  return (
    <Suspense fallback={<div className="text-sm text-stone-500 px-8 py-8">Loading…</div>}>
      <NewIncidentInner />
    </Suspense>
  );
}
