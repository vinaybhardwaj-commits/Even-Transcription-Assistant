"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { AddObservationModal } from "@/components/AddObservationModal";

interface ObservationCase {
  id: string;
  case_number: number;
  case_date: string;
  procedure: string;
  observer_role: string;
  observer_name: string;
  observer_email: string;
  scores: Record<string, number>;
  narrative_notes: string | null;
  flag_severity: string;
  created_at: string;
}

interface Prescreen {
  id: string;
  prospective_email: string;
  prospective_full_name: string;
  prospective_specialty: string | null;
  hospital_code: string;
  hospital_name: string;
  hospital_codes?: string[];                 // v3.0e — multi-site VCs
  cases_per_hospital?: Record<string, number>;
  years_post_postgraduate: number | null;
  prior_corporate_hospitals: string[] | null;
  commitments_acknowledged: Record<string, boolean> | null;
  red_flags: string | null;
  decision: string;
  decision_rationale: string | null;
  cooldown_override: boolean;
  stage: string;
  prescreened_by_email: string;
  prescreened_at: string;
  decided_at: string | null;
  physician_id: string | null;
  trigger?: string;
  fppe_from_profile?: boolean;
}

const COMMITMENT_LABEL: Record<string, string> = {
  ot_timings: "OT timings",
  formulary: "Formulary discipline",
  vendor_mou: "Vendor MOU respect",
  rental_equipment: "Rental equipment policy",
  weekend_protocol: "Weekend/holiday protocol",
};

const STAGE_LABEL: Record<string, { label: string; pill: string }> = {
  prescreen:    { label: "Pre-screen",    pill: "bg-stone-100 text-stone-700" },
  observation:  { label: "Observation",   pill: "bg-amber-50 text-amber-800" },
  decision:     { label: "Decision",      pill: "bg-blue-50 text-blue-800" },
  onboarded:    { label: "Onboarded",     pill: "bg-emerald-50 text-emerald-700" },
  rejected:     { label: "Rejected",      pill: "bg-stone-100 text-stone-600" },
  terminated:   { label: "Terminated",    pill: "bg-red-50 text-red-700" },
};

// CR.2: trigger-aware decision card labels (PRD §C.5 / decision #6). For
// non-VC triggers, 'Confirm privileges' reads as 'FPPE satisfactory' and
// 'Terminate' reads as 'FPPE unsatisfactory'. Extend stays the same.
const TRIGGER_LABEL: Record<string, string> = {
  new_visiting_consultant: "Visiting Consultant onboarding",
  new_employed_provisional: "FPPE · new employed (Provisional)",
  special_privilege_request: "FPPE · Special-privilege request",
  concern_raised: "FPPE · Concern raised",
};

const DECISION_LABELS_FOR_TRIGGER: Record<string, { confirm: string; extend: string; terminate: string; confirmPh: string; extendPh: string; terminatePh: string }> = {
  new_visiting_consultant: {
    confirm: "✓ Confirm privileges",
    extend: "+ Extend observation (max 5)",
    terminate: "✕ Terminate",
    confirmPh: "Why this VC is being confirmed for privileges?",
    extendPh: "Why extend to additional observation cases?",
    terminatePh: "Why is this VC being terminated?",
  },
  new_employed_provisional: {
    confirm: "✓ FPPE satisfactory",
    extend: "+ Extend (more cases)",
    terminate: "✕ FPPE unsatisfactory",
    confirmPh: "Why is this Provisional period being closed satisfactorily?",
    extendPh: "Why extend FPPE — what specifically needs more observation?",
    terminatePh: "Why is FPPE being closed as unsatisfactory? Suspension/revocation handled on the profile.",
  },
  special_privilege_request: {
    confirm: "✓ Approve Special privilege",
    extend: "+ Extend FPPE on this scope",
    terminate: "✕ Deny Special privilege",
    confirmPh: "Why is this Special-privilege grant being approved after FPPE?",
    extendPh: "What additional case observation is needed before deciding?",
    terminatePh: "Why is the Special-privilege request being denied?",
  },
  concern_raised: {
    confirm: "✓ Concern resolved",
    extend: "+ Continue under review",
    terminate: "✕ Concern upheld",
    confirmPh: "What evidence resolves the concern raised here?",
    extendPh: "What further observation is required?",
    terminatePh: "Why is the concern upheld? Suspension/revocation handled on the profile.",
  },
};

export default function OnboardingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [data, setData] = useState<Prescreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cases, setCases] = useState<ObservationCase[]>([]);
  const [allowedRoles, setAllowedRoles] = useState<string[]>([]);
  const [me, setMe] = useState<{ is_super_admin: boolean; is_site_medical_head: boolean } | null>(null);
  const [allHospitals, setAllHospitals] = useState<Array<{ id: string; code: string }>>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [decisionMode, setDecisionMode] = useState<"confirm_privileges" | "extend_observation" | "terminate" | null>(null);
  const [decisionRationale, setDecisionRationale] = useState("");
  const [decisionWorking, setDecisionWorking] = useState(false);
  const [decisionResult, setDecisionResult] = useState<{ stage: string; physician_id: string | null } | null>(null);

  function load() {
    if (!id) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/vc-onboarding/prescreens/${id}`).then((r) => r.json()),
      fetch(`/api/vc-onboarding/prescreens/${id}/observations`).then((r) => r.json()),
      fetch(`/api/auth/me`).then((r) => r.json()),
      fetch(`/api/hospitals`).then((r) => r.json()),
    ])
      .then(([pj, oj, mj, hj]) => {
        if (!pj.ok) { setError(pj.error || "Not found"); return; }
        setData(pj.prescreen as Prescreen);
        if (oj.ok) {
          setCases((oj.rows ?? []) as ObservationCase[]);
          setAllowedRoles(oj.allowed_roles ?? []);
        }
        if (mj.ok) setMe(mj.user as { is_super_admin: boolean; is_site_medical_head: boolean });
        if (hj.ok) setAllHospitals(hj.hospitals as Array<{ id: string; code: string }>);
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);


  async function submitDecision() {
    if (!decisionMode) return;
    if (!decisionRationale.trim()) return;
    setDecisionWorking(true);
    try {
      const r = await fetch(`/api/vc-onboarding/prescreens/${id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: decisionMode, rationale: decisionRationale.trim() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        alert(j.error || "Decision failed");
        return;
      }
      setDecisionResult({ stage: j.stage, physician_id: j.physician_id });
      setDecisionMode(null);
      setDecisionRationale("");
      load();
    } finally {
      setDecisionWorking(false);
    }
  }

  if (loading) return (<><TopNav /><main className="max-w-[900px] mx-auto px-8 py-8 text-sm text-stone-500">Loading…</main></>);
  if (error || !data) return (
    <>
      <TopNav />
      <main className="max-w-[900px] mx-auto px-8 py-12 text-center">
        <h1 className="text-lg font-semibold mb-2">{error || "Not found"}</h1>
        <Link href="/onboarding" className="text-brand text-sm font-medium">← Back</Link>
      </main>
    </>
  );

  const stage = STAGE_LABEL[data.stage] ?? { label: data.stage, pill: "bg-stone-100 text-stone-700" };
  const trig = data.trigger ?? "new_visiting_consultant";
  const trigLabels = DECISION_LABELS_FOR_TRIGGER[trig] ?? DECISION_LABELS_FOR_TRIGGER.new_visiting_consultant;
  const trigBadge = TRIGGER_LABEL[trig] ?? null;
  const commitments = data.commitments_acknowledged ?? {};

  return (
    <>
      <TopNav />
      <main className="max-w-[900px] mx-auto px-8 py-8 space-y-4">
        <div className="text-sm text-stone-500">
          <Link href="/onboarding" className="hover:text-stone-900">Credentialing</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">{data.prospective_full_name}</span>
        </div>

        <section className="bg-white border border-stone-200 rounded-xl p-5">
          <div className="flex items-start gap-3 mb-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${stage.pill}`}>{stage.label}</span>
            <div className="flex flex-wrap gap-1.5">
              {((data.hospital_codes && data.hospital_codes.length > 0) ? data.hospital_codes : [data.hospital_code]).map((c) => (
                <span key={c} className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50 font-medium">{c}</span>
              ))}
            </div>
            {data.decision === "reject" && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-700">
                Rejected{data.cooldown_override ? " · override" : " · 12mo cooldown"}
              </span>
            )}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{data.prospective_full_name}</h1>
          <div className="text-sm text-stone-500 mt-1">
            {data.prospective_email}
            {data.prospective_specialty ? ` · ${data.prospective_specialty}` : ""}
            {data.years_post_postgraduate ? ` · ${data.years_post_postgraduate}y post-PG` : ""}
          </div>
          <div className="text-xs text-stone-500 mt-3">
            Pre-screened by {data.prescreened_by_email} · {new Date(data.prescreened_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          </div>
          {data.decision_rationale && (
            <div className="mt-3 px-3 py-2 bg-stone-50 rounded-lg text-sm">
              <strong className="text-stone-700">Rationale:</strong> {data.decision_rationale}
            </div>
          )}
        </section>

        <div className="grid grid-cols-2 gap-4">
          <section className="bg-white border border-stone-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold mb-2">Commitments</h2>
            <ul className="text-xs space-y-1.5">
              {Object.entries(COMMITMENT_LABEL).map(([k, label]) => (
                <li key={k} className="flex items-center gap-2">
                  <span className={commitments[k] ? "text-emerald-700" : "text-stone-400"}>{commitments[k] ? "✓" : "○"}</span>
                  <span className={commitments[k] ? "text-stone-700" : "text-stone-400"}>{label}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="bg-white border border-stone-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold mb-2">Prior corporate hospitals</h2>
            {data.prior_corporate_hospitals && data.prior_corporate_hospitals.length > 0 ? (
              <ul className="text-xs text-stone-700 space-y-1 list-disc pl-4">
                {data.prior_corporate_hospitals.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            ) : (
              <div className="text-xs text-stone-400">None recorded</div>
            )}
            {data.red_flags && (
              <div className="mt-3 pt-3 border-t border-stone-100">
                <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase mb-1">Red flags</div>
                <div className="text-xs text-stone-700 whitespace-pre-wrap">{data.red_flags}</div>
              </div>
            )}
          </section>
        </div>

        {(data.stage === "observation" || data.stage === "decision" || data.stage === "onboarded" || data.stage === "terminated") && (
          <section className="bg-white border border-stone-200 rounded-xl">
            <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                Observation cases <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{cases.length}/3+</span>
              </h2>
              {cases.length < 5 && data.stage !== "terminated" && data.stage !== "onboarded" && (
                <button onClick={() => setAddOpen(true)} className="text-[12px] text-brand font-medium">+ Add observation case</button>
              )}
            </div>
            {cases.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-stone-500">
                No observation cases yet. <button onClick={() => setAddOpen(true)} className="text-brand font-medium">Add the first →</button>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {cases.map((c) => {
                  const avg = Object.values(c.scores).reduce((a: number, b: number) => a + b, 0) / Math.max(1, Object.keys(c.scores).length);
                  const flagPill =
                    c.flag_severity === "immediate_termination_recommended" ? "bg-red-50 text-red-700" :
                    c.flag_severity === "concern" ? "bg-amber-50 text-amber-800" :
                    "bg-emerald-50 text-emerald-700";
                  const flagLabel =
                    c.flag_severity === "immediate_termination_recommended" ? "Immediate termination" :
                    c.flag_severity === "concern" ? "Concern" : "No concern";
                  return (
                    <div key={c.id} className="px-5 py-4">
                      <div className="flex items-start gap-3 mb-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-700">
                          Case {c.case_number}
                        </span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${flagPill}`}>
                          {flagLabel}
                        </span>
                        <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">{c.case_date.slice(0, 10)}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-stone-900">{c.procedure}</div>
                          <div className="text-xs text-stone-500 mt-0.5">{c.observer_role} · {c.observer_name}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[11px] text-stone-500 uppercase tracking-wider">avg</div>
                          <div className="text-sm font-semibold num">{avg.toFixed(2)}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-6 gap-1.5 mt-2">
                        {["teamwork","emr_documentation","ot_etiquette","protocol_adherence","outcome","demeanor"].map((dim) => (
                          <div key={dim} className="text-center bg-stone-50 rounded p-1.5">
                            <div className="text-[10px] text-stone-500">{dim.split("_")[0].slice(0, 7)}</div>
                            <div className="text-sm font-semibold num">{c.scores[dim] ?? "—"}</div>
                          </div>
                        ))}
                      </div>
                      {c.narrative_notes && (
                        <div className="mt-2.5 text-xs text-stone-700 bg-stone-50 rounded px-3 py-2 whitespace-pre-wrap">{c.narrative_notes}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {data.stage === "decision" && cases.length >= 3 && (
              <div className="px-5 py-3 border-t border-stone-100 bg-amber-50/30 text-xs text-amber-800">
                ⏳ Ready for decision — see the Decision card below.
              </div>
            )}
          </section>
        )}

        {data.stage === "decision" && (
          <section className="bg-white border border-stone-200 rounded-xl">
            <div className="px-5 py-3.5 border-b border-stone-100">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">Final decision</h2>
                {trigBadge && trig !== "new_visiting_consultant" && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-200">{trigBadge}</span>
                )}
              </div>
              <div className="text-xs text-stone-500 mt-0.5">
                {cases.length} {cases.length === 1 ? "case" : "cases"} observed.
                {cases.length > 0 && (
                  (() => {
                    const allScores = cases.flatMap((c) => Object.values(c.scores));
                    const avg = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
                    const flags = cases.filter((c) => c.flag_severity !== "none").length;
                    return ` Overall avg ${avg.toFixed(2)}/5${flags > 0 ? ` · ${flags} ${flags === 1 ? "flag" : "flags"}` : ""}.`;
                  })()
                )}
              </div>
              {(() => {
                const codes = (data.hospital_codes && data.hospital_codes.length > 0) ? data.hospital_codes : [data.hospital_code];
                const counts = data.cases_per_hospital ?? {};
                return (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {codes.map((c) => {
                      const n = counts[c] ?? 0;
                      const cls = n === 0
                        ? "bg-amber-50 text-amber-800 border border-amber-200"
                        : "bg-emerald-50 text-emerald-700 border border-emerald-200";
                      return (
                        <span key={c} className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}`}>
                          {n === 0 ? "⚠ " : ""}{c} · {n} {n === 1 ? "case" : "cases"}
                        </span>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {(me?.is_super_admin || me?.is_site_medical_head) ? (
              <>
                <div className="px-5 py-4 grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setDecisionMode("confirm_privileges")}
                    className={`px-3 py-3 rounded-lg text-sm font-medium border-2 ${decisionMode === "confirm_privileges" ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"}`}
                  >
                    {trigLabels.confirm}
                  </button>
                  <button
                    onClick={() => setDecisionMode("extend_observation")}
                    className={`px-3 py-3 rounded-lg text-sm font-medium border-2 ${decisionMode === "extend_observation" ? "bg-amber-600 text-white border-amber-600" : "bg-white text-amber-700 border-amber-200 hover:bg-amber-50"}`}
                  >
                    {trigLabels.extend}
                  </button>
                  <button
                    onClick={() => setDecisionMode("terminate")}
                    className={`px-3 py-3 rounded-lg text-sm font-medium border-2 ${decisionMode === "terminate" ? "bg-red-600 text-white border-red-600" : "bg-white text-red-700 border-red-200 hover:bg-red-50"}`}
                  >
                    {trigLabels.terminate}
                  </button>
                </div>

                {decisionMode && (
                  <div className="px-5 pb-5">
                    <label className="block text-xs font-medium text-stone-500 mb-1.5">
                      Rationale (required, audited)
                    </label>
                    <textarea
                      value={decisionRationale}
                      onChange={(e) => setDecisionRationale(e.target.value)}
                      rows={3}
                      placeholder={
                        decisionMode === "confirm_privileges"
                          ? trigLabels.confirmPh
                          : decisionMode === "extend_observation"
                          ? trigLabels.extendPh
                          : trigLabels.terminatePh
                      }
                      className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand font-sans leading-relaxed"
                    />
                    <div className="flex justify-end gap-2 mt-3">
                      <button onClick={() => { setDecisionMode(null); setDecisionRationale(""); }} className="btn-ghost">Cancel</button>
                      <button
                        onClick={submitDecision}
                        disabled={!decisionRationale.trim() || decisionWorking}
                        className={`px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 ${
                          decisionMode === "confirm_privileges" ? "bg-emerald-600 hover:bg-emerald-700"
                          : decisionMode === "extend_observation" ? "bg-amber-600 hover:bg-amber-700"
                          : "bg-red-600 hover:bg-red-700"
                        }`}
                      >
                        {decisionWorking ? "Working…" : "Submit decision"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="px-5 py-8 text-center text-sm text-stone-500">
                Awaiting Site Medical Head or super-admin to make the final decision.
              </div>
            )}
          </section>
        )}

        {data.stage === "onboarded" && (
          <section className="bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4 text-sm text-emerald-800">
            ✓ <strong>Onboarded</strong>{decisionResult?.physician_id || data.physician_id ? (
              <>
                {" "}— physician record live.
                <Link href={`/physicians/${decisionResult?.physician_id || data.physician_id}`} className="ml-2 text-emerald-900 font-medium underline">
                  Open physician profile →
                </Link>
              </>
            ) : null}
          </section>
        )}

        {data.stage === "terminated" && (
          <section className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 text-sm text-red-800">
            ✕ <strong>Terminated.</strong> Re-onboarding requires super-admin override + documented re-evaluation per locked decision #32.
          </section>
        )}
      </main>

      {addOpen && (
        <AddObservationModal
          prescreenId={id!}
          allowedRoles={allowedRoles}
          hospitalOptions={(data?.hospital_codes && data.hospital_codes.length > 0 ? data.hospital_codes : [data?.hospital_code].filter(Boolean) as string[])
            .map((code) => allHospitals.find((h) => h.code === code))
            .filter((h): h is { id: string; code: string } => !!h)}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); load(); }}
        />
      )}
    </>
  );
}
