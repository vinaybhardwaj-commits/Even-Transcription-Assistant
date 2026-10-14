"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface OppePacket {
  snapshot_at?: string;
  period_start?: string;
  period_end?: string;
  clinical_metrics_monthly?: Array<{ year: number; month: number; opd_count?: number | null; ipd_admissions?: number | null; ot_cases?: number | null; revenue_inr?: number | null }>;
  incidents?: Array<{ id: string; category: string | null; severity: string | null; polarity?: string; source?: string; commendation_category?: string | null; patient_rating?: number | null; status: string; submitted_at: string; anonymous_flag?: boolean }>;
  feedback_summary?: { positive: number; negative: number; by_source: { patient: { positive: number; negative: number }; peer: { positive: number; negative: number }; governance: { positive: number; negative: number } }; avg_patient_rating: number | null; patient_rating_n: number };
  summary?: {
    months_covered: number;
    totals: { opd: number; ipd: number; ot: number; revenue: number };
    incidents_total: number;
    open_incidents: number;
    retracted_incidents: number;
    positive_feedback: number;
    negative_feedback: number;
  };
}

interface OppeDetail {
  id: string;
  physician_name: string;
  primary_specialty: string | null;
  hospital_code: string;
  hospital_name: string;
  period_start: string;
  period_end: string;
  due_at: string;
  status: string;
  packet_jsonb: OppePacket | null;
  completed_at: string | null;
  decision_notes: string | null;
}

type Decision = "satisfactory" | "flagged" | "escalated_to_fppe";

export function OppeReviewModal({ oppeId, onClose, onSaved }: { oppeId: string; onClose: () => void; onSaved: () => void }) {
  const router = useRouter();
  const [data, setData] = useState<OppeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [notes, setNotes] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/oppe/${oppeId}`).then((r) => r.json()).then((j) => {
      if (cancelled) return;
      if (!j.ok) { setError(j.error || "Could not load OPPE."); setLoading(false); return; }
      setData(j.oppe as OppeDetail);
      setLoading(false);
    }).catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : "Network error"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [oppeId]);

  async function submit() {
    if (!decision) return;
    if (!notes.trim()) { setError("Decision notes required (audited)."); return; }
    setError(null); setWorking(true);
    try {
      const r = await fetch(`/api/oppe/${oppeId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, notes: notes.trim() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j.error || "Could not save decision."); setWorking(false); return; }
      if (decision === "escalated_to_fppe" && j.escalated_prescreen_id) {
        // Redirect to the new FPPE prescreen so the SMH can capture cases.
        router.push(`/onboarding/${j.escalated_prescreen_id}`);
        return;
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setWorking(false);
    }
  }

  const packet = data?.packet_jsonb ?? null;
  const monthLabel = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-stone-900/40 px-4 py-8 overflow-y-auto">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[820px] shadow-xl my-auto">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold tracking-tight">OPPE review</h2>
            <div className="text-[11px] text-stone-500 mt-0.5">Ongoing Professional Practice Evaluation · <a href="/guide#oppe" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">what is OPPE?</a></div>
            {data && (
              <div className="text-xs text-stone-500 mt-0.5">
                {data.physician_name} · {data.hospital_code} · {data.period_start} → {data.period_end}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {loading && <div className="text-sm text-stone-500">Loading packet…</div>}
          {!loading && data && (
            <>
              <section>
                <div className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-2">Summary</div>
                {packet?.summary ? (
                  <div className="grid grid-cols-4 gap-3">
                    <div className="bg-stone-50 rounded-lg p-3">
                      <div className="text-[11px] text-stone-500">Clinical months</div>
                      <div className="num text-lg font-semibold">{packet.summary.months_covered}</div>
                      <div className="text-[10px] text-stone-400 mt-0.5">OPD {packet.summary.totals.opd} · IPD {packet.summary.totals.ipd} · OT {packet.summary.totals.ot}</div>
                    </div>
                    <div className="bg-stone-50 rounded-lg p-3">
                      <div className="text-[11px] text-stone-500">Incidents</div>
                      <div className={`num text-lg font-semibold ${packet.summary.open_incidents > 0 ? "text-amber-700" : "text-stone-700"}`}>{packet.summary.incidents_total}</div>
                      <div className="text-[10px] text-stone-400 mt-0.5">{packet.summary.open_incidents} open · {packet.summary.retracted_incidents} retracted</div>
                    </div>
                    <div className="bg-stone-50 rounded-lg p-3">
                      <div className="text-[11px] text-stone-500">Feedback</div>
                      <div className="num text-lg font-semibold"><span className="text-emerald-700">{packet.summary.positive_feedback}</span> / <span className="text-stone-700">{packet.summary.negative_feedback}</span></div>
                      <div className="text-[10px] text-stone-400 mt-0.5">positive / negative</div>
                    </div>
                    <div className="bg-stone-50 rounded-lg p-3">
                      <div className="text-[11px] text-stone-500">Revenue (₹)</div>
                      <div className="num text-lg font-semibold">{packet.summary.totals.revenue.toLocaleString("en-IN")}</div>
                      <div className="text-[10px] text-stone-400 mt-0.5">window total</div>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-stone-500">Packet not available.</div>
                )}
              </section>

              {packet?.clinical_metrics_monthly && packet.clinical_metrics_monthly.length > 0 && (
                <section>
                  <div className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-2">Clinical metrics — monthly</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-stone-500 text-left border-b border-stone-200">
                          <th className="py-1.5 pr-3">Month</th>
                          <th className="py-1.5 pr-3 text-right">OPD</th>
                          <th className="py-1.5 pr-3 text-right">IPD</th>
                          <th className="py-1.5 pr-3 text-right">OT</th>
                          <th className="py-1.5 pr-3 text-right">Revenue ₹</th>
                        </tr>
                      </thead>
                      <tbody className="text-stone-700">
                        {packet.clinical_metrics_monthly.map((m) => (
                          <tr key={`${m.year}-${m.month}`} className="border-b border-stone-100">
                            <td className="py-1.5 pr-3 mono">{monthLabel(m.year, m.month)}</td>
                            <td className="py-1.5 pr-3 text-right num">{m.opd_count ?? "—"}</td>
                            <td className="py-1.5 pr-3 text-right num">{m.ipd_admissions ?? "—"}</td>
                            <td className="py-1.5 pr-3 text-right num">{m.ot_cases ?? "—"}</td>
                            <td className="py-1.5 pr-3 text-right num">{m.revenue_inr != null ? Number(m.revenue_inr).toLocaleString("en-IN") : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {packet?.incidents && packet.incidents.length > 0 && (
                <section>
                  <div className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-2">Incidents in window</div>
                  <div className="space-y-1.5">
                    {packet.incidents.map((i) => (
                      <div key={i.id} className="flex items-center gap-2 text-xs">
                        <span className={`px-2 py-0.5 rounded-full font-medium ${
                          i.status === "open" ? "bg-amber-50 text-amber-800" : i.status === "retracted" ? "bg-stone-100 text-stone-500" : "bg-emerald-50 text-emerald-700"
                        }`}>{i.status}</span>
                        <span className={`px-1.5 py-0.5 rounded-full font-medium ${i.polarity === "positive" ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-600"}`}>{i.polarity === "positive" ? "positive" : "negative"}</span>
                        <span className="text-stone-500">{i.source ?? "peer"}</span>
                        <span className="text-stone-400">·</span>
                        <span className={i.severity === "critical" ? "text-red-700 font-medium" : "text-stone-500"}>{i.polarity === "positive" ? (i.commendation_category ?? "commendation") : `${i.category ?? "—"} / ${i.severity ?? "—"}`}</span>
                        <span className="text-stone-400 mono text-[10px] ml-auto">{i.submitted_at?.slice(0, 10)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {packet?.feedback_summary && (
                <section>
                  <div className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-2">Feedback summary</div>
                  <div className="grid grid-cols-4 gap-2 text-xs">
                    {(([["patient","Patient"],["peer","Peer"],["governance","Governance"]]) as [("patient"|"peer"|"governance"), string][]).map(([k,label]) => (
                      <div key={k} className="border border-stone-200 rounded-lg px-3 py-2">
                        <div className="text-stone-500 font-medium">{label}</div>
                        <div className="mt-0.5"><span className="text-emerald-700 font-medium">{packet.feedback_summary!.by_source[k].positive}+</span> {" / "} <span className="text-stone-700 font-medium">{packet.feedback_summary!.by_source[k].negative}-</span></div>
                      </div>
                    ))}
                    <div className="border border-stone-200 rounded-lg px-3 py-2">
                      <div className="text-stone-500 font-medium">Avg patient rating</div>
                      <div className="mt-0.5 text-stone-700 font-medium">{packet.feedback_summary.avg_patient_rating ?? "—"}{packet.feedback_summary.patient_rating_n ? ` (${packet.feedback_summary.patient_rating_n})` : ""}</div>
                    </div>
                  </div>
                </section>
              )}

              {/* Decision controls */}
              {data.status === "pending" || data.status === "in_review" ? (
                <section className="border-t border-stone-100 pt-5">
                  <div className="text-[11px] uppercase tracking-wider text-stone-500 font-medium mb-2">Sign off</div>
                  <div className="grid grid-cols-3 gap-2">
                    <button onClick={() => setDecision("satisfactory")} className={`px-3 py-3 rounded-lg text-sm font-medium border-2 ${decision === "satisfactory" ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"}`}>✓ Satisfactory</button>
                    <button onClick={() => setDecision("flagged")} className={`px-3 py-3 rounded-lg text-sm font-medium border-2 ${decision === "flagged" ? "bg-amber-600 text-white border-amber-600" : "bg-white text-amber-700 border-amber-200 hover:bg-amber-50"}`}>⚐ Flagged</button>
                    <button onClick={() => setDecision("escalated_to_fppe")} className={`px-3 py-3 rounded-lg text-sm font-medium border-2 ${decision === "escalated_to_fppe" ? "bg-red-600 text-white border-red-600" : "bg-white text-red-700 border-red-200 hover:bg-red-50"}`}>↗ Escalate to FPPE</button>
                  </div>
                  {decision && (
                    <div className="mt-3">
                      <label className="block text-xs font-medium text-stone-500 mb-1.5">Decision notes (required, audited)</label>
                      <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows={3}
                        placeholder={
                          decision === "satisfactory"
                            ? "Why is this OPPE being signed off as satisfactory?"
                            : decision === "flagged"
                            ? "What's flagged here — what needs follow-up?"
                            : "Why is this being escalated to a focused FPPE? A concern_raised FPPE prescreen will be auto-created."
                        }
                        className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed"
                      />
                      <div className="flex justify-end gap-2 mt-3">
                        <button onClick={() => { setDecision(null); setNotes(""); }} className="btn-ghost">Cancel</button>
                        <button onClick={submit} disabled={working} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
                          {working ? "Saving…" : "Confirm decision"}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              ) : (
                <section className="border-t border-stone-100 pt-5 bg-stone-50 -mx-6 -mb-5 px-6 py-4 rounded-b-xl">
                  <div className="text-[11px] uppercase tracking-wider text-stone-500 font-medium">Closed</div>
                  <div className="text-sm text-stone-700 mt-1">
                    <strong>{data.status}</strong>{data.completed_at ? ` at ${data.completed_at.slice(0, 10)}` : ""}.
                  </div>
                  {data.decision_notes && <div className="text-xs text-stone-600 mt-1.5 whitespace-pre-wrap">{data.decision_notes}</div>}
                </section>
              )}

              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
            </>
          )}
          {!loading && !data && error && <div className="text-sm text-red-700">{error}</div>}
        </div>
      </div>
    </div>
  );
}
