"use client";

import { useEffect, useState } from "react";

/**
 * Portal incident reporting (R5 PRD §3) — mobile-first form + My Reports +
 * anonymous reference lookup. Renders from the even-incident intake contract
 * (EVEN-INCIDENT-PORTAL-INTAKE-CONTRACT-v1.0.md): pick-lists from /meta,
 * narrative is the only hard-required field, 3-tier identity (Named default).
 */

interface MetaItem { id: string; name: string; category?: string }
interface Meta { departments: MetaItem[]; locations: MetaItem[]; types: MetaItem[] }
interface Report { reference: string; class: string | null; severity: string | null; status: string; submitted_at: string }

const SEVERITIES = [
  ["negligible", "Negligible / no harm"],
  ["minor", "Minor"],
  ["moderate", "Moderate"],
  ["major", "Major"],
  ["catastrophic", "Catastrophic"],
] as const;
const IMPACTS = [
  ["patient", "Patient"], ["staff", "Staff"], ["visitor", "Visitor"], ["property_asset", "Property / asset"],
  ["operations", "Operations"], ["data_privacy", "Data / privacy"], ["environment", "Environment"], ["none", "None"],
] as const;
const STATUS_LABEL: Record<string, string> = {
  open: "Open", under_investigation: "Under investigation", capa_assigned: "CAPA assigned", closed: "Closed", verified: "Verified",
};

const inputCls = "w-full rounded-lg border border-stone-200 px-3 py-2.5 text-[16px] bg-white";
const labelCls = "block text-[12px] font-semibold text-stone-500 mb-1";

export function IncidentReporting({ doctorName }: { doctorName: string }) {
  const [view, setView] = useState<"form" | "mine">("form");
  const [meta, setMeta] = useState<Meta | null>(null);

  // form state
  const [narrative, setNarrative] = useState("");
  const [cls, setCls] = useState("");
  const [dept, setDept] = useState("");
  const [loc, setLoc] = useState("");
  const [when, setWhen] = useState("");
  const [severity, setSeverity] = useState("");
  const [nearMiss, setNearMiss] = useState(false);
  const [impact, setImpact] = useState("");
  const [action, setAction] = useState("");
  const [tier, setTier] = useState<"named" | "confidential" | "anonymous">("named");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null); // reference code

  // my reports
  const [mine, setMine] = useState<Report[] | null>(null);
  const [lookupRef, setLookupRef] = useState("");
  const [lookupResult, setLookupResult] = useState<Report | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/portal/incidents/meta").then((r) => r.json()).then((j) => { if (j.ok) setMeta(j); }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (view !== "mine" || mine !== null) return;
    fetch("/api/portal/incidents/mine").then((r) => r.json()).then((j) => { if (j.ok) setMine(j.reports ?? []); else setMine([]); }).catch(() => setMine([]));
  }, [view, mine]);

  async function submit() {
    setErr(null);
    if (narrative.trim().length < 10) { setErr("Please describe what happened (at least 10 characters)."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/portal/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tier,
          incident: {
            narrative: narrative.trim(),
            class: cls || undefined,
            department: dept || undefined,
            location: loc || undefined,
            occurred_at: when ? new Date(when).toISOString() : undefined,
            severity: severity || undefined,
            near_miss: nearMiss,
            impact_domain: impact || undefined,
            immediate_action: action.trim() || undefined,
          },
        }),
      });
      const j = await r.json();
      if (j.ok && j.reference) {
        setDone(j.reference);
        setMine(null); // refetch next time
      } else setErr(j.error || "Submission failed — please try again.");
    } catch {
      setErr("Network problem — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function lookup() {
    setLookupErr(null); setLookupResult(null);
    const r = await fetch(`/api/portal/incidents/lookup?ref=${encodeURIComponent(lookupRef.trim())}`);
    const j = await r.json();
    if (j.ok && j.report) setLookupResult(j.report);
    else setLookupErr(j.error || "Not found.");
  }

  if (done) {
    return (
      <section className="bg-white border border-emerald-200 rounded-xl p-6 text-center space-y-3">
        <div className="text-3xl">✓</div>
        <h2 className="text-base font-semibold">Incident reported</h2>
        <p className="text-sm text-stone-500">Your reference code — save it{tier === "anonymous" ? " (it is the only way to track an anonymous report)" : ""}:</p>
        <div className="mx-auto inline-block rounded-lg bg-stone-100 px-4 py-2 font-mono text-lg font-bold tracking-wide select-all">{done}</div>
        <p className="text-[12.5px] text-stone-400">The governance team reviews every report. {tier !== "anonymous" ? "Track progress under My Reports." : "Track progress anytime by entering this code under My Reports."}</p>
        <div className="flex justify-center gap-2 pt-1">
          <button onClick={() => { setDone(null); setNarrative(""); setCls(""); setDept(""); setLoc(""); setWhen(""); setSeverity(""); setNearMiss(false); setImpact(""); setAction(""); setTier("named"); }} className="rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium">Report another</button>
          <button onClick={() => { setView("mine"); setDone(null); }} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">My Reports</button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        <button onClick={() => setView("form")} className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium ${view === "form" ? "bg-brand text-white" : "bg-white border border-stone-200 text-stone-700"}`}>New report</button>
        <button onClick={() => setView("mine")} className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium ${view === "mine" ? "bg-brand text-white" : "bg-white border border-stone-200 text-stone-700"}`}>My Reports</button>
      </div>

      {view === "form" ? (
        <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
          <div>
            <label className={labelCls}>What happened? *</label>
            <textarea value={narrative} onChange={(e) => setNarrative(e.target.value)} rows={5} placeholder="Describe the incident in your own words — this is the most important field." className={inputCls} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Incident type</label>
              <select value={cls} onChange={(e) => setCls(e.target.value)} className={inputCls}>
                <option value="">Select…</option>
                {(meta?.types ?? []).map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Department</label>
              <select value={dept} onChange={(e) => setDept(e.target.value)} className={inputCls}>
                <option value="">Select…</option>
                {(meta?.departments ?? []).map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Location</label>
              <select value={loc} onChange={(e) => setLoc(e.target.value)} className={inputCls}>
                <option value="">Select…</option>
                {(meta?.locations ?? []).map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
              </select>
            </div>
            <div>
              <label className={labelCls}>When did it occur?</label>
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Actual harm / impact severity</label>
            <div className="flex flex-wrap gap-1.5">
              {SEVERITIES.map(([v, label]) => (
                <button key={v} type="button" onClick={() => setSeverity(severity === v ? "" : v)} className={`px-3 py-2 rounded-lg text-[12.5px] font-medium border ${severity === v ? "bg-brand text-white border-brand" : "bg-white border-stone-200 text-stone-600"}`}>{label}</button>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-[13px] text-stone-600">
              <input type="checkbox" checked={nearMiss} onChange={(e) => setNearMiss(e.target.checked)} className="h-4 w-4" />
              This was a near-miss (caught before causing harm)
            </label>
          </div>
          <div>
            <label className={labelCls}>Who or what was affected?</label>
            <div className="flex flex-wrap gap-1.5">
              {IMPACTS.map(([v, label]) => (
                <button key={v} type="button" onClick={() => setImpact(impact === v ? "" : v)} className={`px-3 py-2 rounded-lg text-[12.5px] font-medium border ${impact === v ? "bg-brand text-white border-brand" : "bg-white border-stone-200 text-stone-600"}`}>{label}</button>
              ))}
            </div>
          </div>
          <div>
            <label className={labelCls}>Immediate action taken (optional)</label>
            <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. informed nursing in-charge, isolated equipment" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Report as</label>
            <div className="space-y-1.5">
              {([
                ["named", `Named — ${doctorName}`, "Your name travels with the report. Fastest follow-up."],
                ["confidential", "Confidential", "Your identity is stored but masked in the back office."],
                ["anonymous", "Anonymous", "No identity stored at all — keep your reference code to track it."],
              ] as const).map(([v, label, hint]) => (
                <label key={v} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer ${tier === v ? "border-brand bg-brand-softer" : "border-stone-200 bg-white"}`}>
                  <input type="radio" name="tier" checked={tier === v} onChange={() => setTier(v)} className="mt-0.5" />
                  <span>
                    <span className="block text-[13.5px] font-semibold">{label}</span>
                    <span className="block text-[12px] text-stone-500">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          {err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">{err}</div>}
          <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-brand py-3 text-[15px] font-semibold text-white disabled:opacity-50">
            {busy ? "Submitting…" : "Submit report"}
          </button>
          <p className="text-center text-[11.5px] text-stone-400">Goes to the governance incident system (RCA/CAPA pipeline) — not to your manager.</p>
        </section>
      ) : (
        <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
          {mine === null ? (
            <div className="text-sm text-stone-500">Loading…</div>
          ) : mine.length === 0 ? (
            <div className="text-sm text-stone-500">No reports linked to your account yet. (Anonymous reports don&apos;t appear here — track them by reference code below.)</div>
          ) : (
            <div className="divide-y divide-stone-100">
              {mine.map((r) => (
                <div key={r.reference} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[12.5px] font-bold">{r.reference}</div>
                    <div className="text-[12px] text-stone-500">{r.class ?? "Unclassified"}{r.severity ? ` · ${r.severity}` : ""} · {r.submitted_at?.slice(0, 10)}</div>
                  </div>
                  <span className="shrink-0 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-600">{STATUS_LABEL[r.status] ?? r.status}</span>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-stone-100 pt-3">
            <label className={labelCls}>Track an anonymous report by reference code</label>
            <div className="flex gap-2">
              <input value={lookupRef} onChange={(e) => setLookupRef(e.target.value)} placeholder="<UNIT>-INC-2026-0001" className={inputCls + " font-mono"} />
              <button onClick={lookup} className="shrink-0 rounded-lg border border-stone-200 px-4 text-sm font-medium">Check</button>
            </div>
            {lookupErr && <div className="mt-2 text-[12.5px] text-rose-600">{lookupErr}</div>}
            {lookupResult && (
              <div className="mt-2 rounded-lg border border-stone-100 bg-stone-50 px-3 py-2 text-[13px]">
                <span className="font-mono font-bold">{lookupResult.reference}</span> · {lookupResult.class ?? "Unclassified"} ·{" "}
                <span className="font-semibold">{STATUS_LABEL[lookupResult.status] ?? lookupResult.status}</span>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
