"use client";

import { useEffect, useState } from "react";
import { PortalNav, MobileTabBar, type Dest } from "@/components/portal/PortalNav";
import { HomeExtras, type AnnData } from "@/components/portal/HomeExtras";
import { FindingsForDoctor } from "@/components/portal/FindingsForDoctor";
import { LocalDocumentAuditsForDoctor } from "@/components/portal/LocalDocumentAuditsForDoctor";
import { ADVISORY_FOOTER } from "@/lib/finding-labels";
import { IncidentReporting } from "@/components/portal/IncidentReporting";

interface Phys { id: string; full_name: string; preferred_name: string | null; primary_specialty: string | null; registration_number: string | null; registration_council: string | null; registration_expiry: string | null; email: string | null; phone: string | null; date_joined_network: string | null; current_status: string }
interface Eng { id: string; hospital_id: string; category: string; status: string; start_date: string | null; hospital_code: string; hospital_name: string }
interface Qual { id: string; degree: string; institution: string | null; institution_tier: string | null; year_completed: number | null; country: string | null; verified: boolean; has_file: boolean; file_filename: string | null }
interface Priv { id: string; procedure_or_specialty: string; is_core: boolean; granted_date: string | null; expires_at: string | null; withdrawn_date: string | null; hospital_code: string }
interface Reply { id: string; text: string; at: string; author: string }
interface About { id: string; polarity: string; source: string; category: string | null; severity: string | null; commendation_category: string | null; patient_rating: number | null; narrative: string; status: string; anonymous_flag: boolean; submitted_at: string; hospital_code: string | null; reporter_display: string; replies: Reply[] }
interface ResignReq { id: string; reason: string; intended_last_date: string | null; status: string; requested_at: string; hospital_code: string | null }
interface PerfRow { week: string; doctor_specialty: string | null; doctor_channel_type: string | null; total_consults: number | null; csat_pct: number | null; csat_responses: number | null; positive_csat_count: number | null; doctor_noshow_tc_rate: number | null; patient_noshow_rate: number | null; cancellation_rate: number | null; doctor_cancellation_rate: number | null; missing_prescription_rate: number | null; presc_under_30_pct: number | null; inperson_consult_count: number | null; tc_active_event_count: number | null; tc_events_missing_recording_count: number | null; unwritten_count: number | null; completed_presc_count: number | null; cancelled_count: number | null; patient_noshow_count: number | null }

const CAT_LABEL: Record<string, string> = { provisional: "Provisional", active: "Active", visiting_consultant: "Visiting Consultant", locum_tenens: "Locum", affiliate: "Affiliate" };
const FB_CATEGORIES: { v: string; label: string }[] = [
  { v: "clinical", label: "Clinical" }, { v: "patient_safety", label: "Patient safety" }, { v: "medical_error", label: "Medical error" },
  { v: "professionalism", label: "Professionalism" }, { v: "documentation", label: "Documentation" }, { v: "etiquette", label: "Etiquette" },
  { v: "vendor_compliance", label: "Vendor compliance" }, { v: "other", label: "Other" },
];
const FB_COMMENDATIONS = ["Clinical Excellence", "Patient Experience", "Teamwork & Collaboration", "Teaching & Mentorship", "Going Above & Beyond"];

function fmt(d: string | null) { return d ? d.slice(0, 10) : "—"; }

function readFile(f: File): Promise<{ filename: string; mime: string; size_bytes: number; data: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve({ filename: f.name, mime: f.type, size_bytes: f.size, data: s.split(",")[1] ?? "" }); };
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}

export default function PortalHome() {
  const [me, setMe] = useState<Phys | null>(null);
  const [engs, setEngs] = useState<Eng[]>([]);
  const [quals, setQuals] = useState<Qual[]>([]);
  const [privs, setPrivs] = useState<Priv[]>([]);
  const [tab, setTab] = useState<"overview" | "performance" | "findings" | "qualifications" | "privileges" | "report" | "aboutme" | "resign">("overview");
  const [ann, setAnn] = useState<AnnData | null>(null);
  const [features, setFeatures] = useState<{
    incidents: boolean;
    findings: boolean;
    reactions: boolean;
    findingsRespond: boolean;
  }>({ incidents: false, findings: false, reactions: false, findingsRespond: false });
  const [reportMode, setReportMode] = useState<"chooser" | "incident" | "feedback">("chooser");
  useEffect(() => {
    fetch("/api/portal/announcements").then((r) => r.json()).then((j) => {
      if (j.ok) {
        setAnn({ whats_new: j.whats_new ?? [], coming_soon: j.coming_soon ?? [] });
        setFeatures(j.features ?? {
          incidents: false,
          findings: false,
          reactions: false,
          findingsRespond: false,
        });
      }
    }).catch(() => undefined);
  }, []);
  // Five-destination nav (R5): map destinations onto the existing tab keys.
  const dest: Dest = tab === "overview" ? "home" : tab === "performance" ? "performance" : tab === "findings" ? "findings" : tab === "report" ? "report" : tab === "qualifications" || tab === "privileges" ? "credentials" : "me";
  const goDest = (d: Dest) => {
    if (d === "home") setTab("overview");
    else if (d === "performance") setTab("performance");
    else if (d === "findings") setTab("findings");
    else if (d === "report") { setTab("report"); setReportMode("chooser"); }
    else if (d === "credentials") setTab("qualifications");
    else setTab("aboutme");
  };
  const [loading, setLoading] = useState(true);
  const [perf, setPerf] = useState<PerfRow[]>([]);
  const [perfMapped, setPerfMapped] = useState(true);
  const [perfSnap, setPerfSnap] = useState<string | null>(null);
  const [perfLoading, setPerfLoading] = useState(false);
  const [perfLoaded, setPerfLoaded] = useState(false);
  useEffect(() => {
    // Guard on perfLoaded (a one-time "have we fetched" flag) rather than perf.length:
    // a zero-row result (unmapped doctor, or mapped with no data) leaves perf empty, and
    // using perf.length > 0 as the guard caused an infinite refetch loop → perpetual "Loading…".
    if (tab !== "performance" || perfLoaded || perfLoading) return;
    setPerfLoading(true);
    fetch("/api/portal/performance").then((r) => r.json()).then((j) => {
      if (j.ok) { setPerf(j.rows ?? []); setPerfMapped(j.mapped !== false); setPerfSnap(j.snapshot_at ?? null); }
    }).catch(() => undefined).finally(() => { setPerfLoaded(true); setPerfLoading(false); });
  }, [tab, perfLoaded, perfLoading]);

  // add-qual form
  const [showAdd, setShowAdd] = useState(false);
  const [qDegree, setQDegree] = useState(""); const [qInst, setQInst] = useState(""); const [qYear, setQYear] = useState(""); const [qCountry, setQCountry] = useState("");
  const [qFile, setQFile] = useState<File | null>(null);
  const [qErr, setQErr] = useState<string | null>(null); const [qBusy, setQBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [eDegree, setEDegree] = useState(""); const [eInst, setEInst] = useState(""); const [eYear, setEYear] = useState("");
  // report-on-others
  const [rQ, setRQ] = useState(""); const [rResults, setRResults] = useState<Array<{ id: string; full_name: string; primary_specialty: string | null }>>([]);
  const [rTarget, setRTarget] = useState<{ id: string; full_name: string } | null>(null);
  const [rPolarity, setRPolarity] = useState<"positive" | "negative">("negative");
  const [rCategory, setRCategory] = useState(""); const [rSeverity, setRSeverity] = useState("medium"); const [rComm, setRComm] = useState("");
  const [rNarr, setRNarr] = useState(""); const [rAnon, setRAnon] = useState(false);
  const [rBusy, setRBusy] = useState(false); const [rErr, setRErr] = useState<string | null>(null); const [rDone, setRDone] = useState(false);
  // about-me + resign
  const [about, setAbout] = useState<About[]>([]);
  const [replyFor, setReplyFor] = useState<string | null>(null); const [replyText, setReplyText] = useState("");
  const [resignReqs, setResignReqs] = useState<ResignReq[]>([]);
  const [resReason, setResReason] = useState(""); const [resDate, setResDate] = useState(""); const [resHosp, setResHosp] = useState("");
  const [resBusy, setResBusy] = useState(false); const [resErr, setResErr] = useState<string | null>(null);

  function loadAll() {
    setLoading(true);
    Promise.all([
      fetch("/api/portal/me").then((r) => r.json()),
      fetch("/api/portal/qualifications").then((r) => r.json()),
      fetch("/api/portal/privileges").then((r) => r.json()),
      fetch("/api/portal/about-me").then((r) => r.json()),
      fetch("/api/portal/resignation").then((r) => r.json()),
    ]).then(([m, q, p, a, rg]) => {
      if (m.ok) { setMe(m.physician); setEngs(m.engagements ?? []); }
      if (q.ok) setQuals(q.rows ?? []);
      if (p.ok) setPrivs(p.rows ?? []);
      if (a.ok) setAbout(a.rows ?? []);
      if (rg.ok) setResignReqs(rg.rows ?? []);
    }).finally(() => setLoading(false));
  }
  useEffect(() => { loadAll(); }, []);
  useEffect(() => {
    if (tab !== "report" || rTarget) return;
    const t = setTimeout(() => {
      fetch(`/api/portal/physicians?q=${encodeURIComponent(rQ.trim())}`).then((r) => r.json()).then((j) => { if (j.ok) setRResults(j.rows ?? []); }).catch(() => undefined);
    }, 200);
    return () => clearTimeout(t);
  }, [rQ, tab, rTarget]);

  async function submitReport(e: React.FormEvent) {
    e.preventDefault(); setRErr(null);
    if (!rTarget) { setRErr("Pick a doctor."); return; }
    if (!rNarr.trim()) { setRErr("Describe the feedback."); return; }
    if (rPolarity === "negative" && !rCategory) { setRErr("Choose a category."); return; }
    if (rPolarity === "positive" && !rComm) { setRErr("Choose a commendation."); return; }
    setRBusy(true);
    try {
      const r = await fetch("/api/portal/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        target_physician_id: rTarget.id, polarity: rPolarity,
        category: rPolarity === "negative" ? rCategory : null, severity: rPolarity === "negative" ? rSeverity : null,
        commendation_category: rPolarity === "positive" ? rComm : null,
        anonymous_flag: rPolarity === "negative" ? rAnon : false, narrative: rNarr.trim(),
      }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { setRErr(j.error || "Failed to submit."); setRBusy(false); return; }
      setRDone(true); setRTarget(null); setRQ(""); setRNarr(""); setRCategory(""); setRComm(""); setRAnon(false);
      setRBusy(false);
    } catch { setRErr("Network error."); setRBusy(false); }
  }

  async function logout() { await fetch("/api/portal/auth/logout", { method: "POST" }); window.location.href = "/portal/login"; }

  async function addQual(e: React.FormEvent) {
    e.preventDefault(); setQErr(null);
    if (!qDegree.trim()) { setQErr("Degree is required."); return; }
    setQBusy(true);
    try {
      let file = undefined;
      if (qFile) {
        if (qFile.size > 2 * 1024 * 1024) { setQErr("File exceeds 2 MB."); setQBusy(false); return; }
        file = await readFile(qFile);
      }
      const r = await fetch("/api/portal/qualifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ degree: qDegree.trim(), institution: qInst.trim() || null, year_completed: qYear ? Number(qYear) : null, country: qCountry.trim() || null, file }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { setQErr(j.error || "Failed to add."); setQBusy(false); return; }
      setShowAdd(false); setQDegree(""); setQInst(""); setQYear(""); setQCountry(""); setQFile(null);
      loadAll();
    } finally { setQBusy(false); }
  }

  function startEdit(q: Qual) { setEditId(q.id); setEDegree(q.degree); setEInst(q.institution ?? ""); setEYear(q.year_completed ? String(q.year_completed) : ""); }
  async function saveEdit(qid: string) {
    const r = await fetch(`/api/portal/qualifications/${qid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ degree: eDegree.trim(), institution: eInst.trim() || null, year_completed: eYear ? Number(eYear) : null }) });
    const j = await r.json();
    if (!r.ok || !j.ok) { alert(j.error || "Edit failed"); return; }
    setEditId(null); loadAll();
  }

  async function sendReply(incidentId: string) {
    if (!replyText.trim()) return;
    const r = await fetch(`/api/portal/incidents/${incidentId}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reply_text: replyText.trim() }) });
    const j = await r.json();
    if (!r.ok || !j.ok) { alert(j.error || "Reply failed"); return; }
    setReplyText(""); setReplyFor(null); loadAll();
  }
  async function submitResign(e: React.FormEvent) {
    e.preventDefault(); setResErr(null);
    if (!resReason.trim()) { setResErr("Please give a reason."); return; }
    setResBusy(true);
    try {
      const r = await fetch("/api/portal/resignation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: resReason.trim(), intended_last_date: resDate || null, hospital_id: resHosp || null }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { setResErr(j.error || "Failed."); setResBusy(false); return; }
      setResReason(""); setResDate(""); setResHosp(""); loadAll(); setResBusy(false);
    } catch { setResErr("Network error."); setResBusy(false); }
  }

  // NOTE: "Resign" tab intentionally hidden for all doctors (stakeholder decision — portal-initiated
// resignations withdrawn). The resign panel + submitResign handler remain in the code, just unreachable.

  return (
    <main className="flex h-screen flex-col bg-stone-50" style={{ height: "100dvh" }}>
      <header className="bg-white border-b border-stone-200 shrink-0 z-10">
        <div className="max-w-[900px] mx-auto px-4 sm:px-6 min-h-14 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-brand text-white text-[11px] font-bold shrink-0">EPI</span>
            <span className="font-semibold text-sm whitespace-nowrap">Even Physician Portal</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-stone-500 min-w-0">
            <span className="truncate">{me?.full_name ?? ""}</span>
            <button onClick={logout} className="text-stone-500 hover:text-stone-900 shrink-0 whitespace-nowrap">Sign out</button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-5 pb-8">
        {/* R5 nav: bottom bar on phones, pills on desktop */}
        <PortalNav dest={dest} onChange={goDest} showFindings={features.findings} />

        {loading ? <div className="text-sm text-stone-500">Loading…</div> : (
        <>
          {tab === "overview" && me && (
            <div className="space-y-4">
              <HomeExtras ann={ann} />
              {/* WM2 teaser — the HomeExtras card shell. Renders ONLY when the flag is on, so a
                  dark flag leaves no trace of Findings on Home. */}
              {features.findings && (
                <section className="bg-white border border-stone-200 rounded-xl p-5">
                  <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-brand mb-2">Findings</h2>
                  <div className="text-[13px] text-stone-500 leading-snug">Documentation and prescribing observations on your notes, with the evidence behind each one.</div>
                  <button onClick={() => goDest("findings")} className="mt-3 px-3.5 py-1.5 rounded-lg text-[13px] font-medium bg-brand text-white">View findings</button>
                </section>
              )}
              <section className="bg-white border border-stone-200 rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-3">Your profile</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 text-sm">
                  <div className="min-w-0"><span className="text-stone-500">Name</span><div className="font-medium break-words">{me.full_name}</div></div>
                  <div className="min-w-0"><span className="text-stone-500">Specialty</span><div className="font-medium break-words">{me.primary_specialty ?? "—"}</div></div>
                  <div className="min-w-0"><span className="text-stone-500">Email</span><div className="font-medium break-words">{me.email ?? "—"}</div></div>
                  <div className="min-w-0"><span className="text-stone-500">Phone</span><div className="font-medium break-words">{me.phone ?? "—"}</div></div>
                  <div className="min-w-0"><span className="text-stone-500">Registration</span><div className="font-medium break-words">{me.registration_number ?? "—"} {me.registration_council ? `· ${me.registration_council}` : ""}</div></div>
                  <div className="min-w-0"><span className="text-stone-500">License expires</span><div className="font-medium break-words">{fmt(me.registration_expiry)}</div></div>
                </div>
              </section>
              <section className="bg-white border border-stone-200 rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-3">Engagements</h2>
                {engs.length === 0 ? <div className="text-sm text-stone-500">No engagements on record.</div> : (
                  <div className="space-y-2">
                    {engs.map((e) => (
                      <div key={e.id} className="flex items-center gap-3 text-sm border border-stone-100 rounded-lg px-3 py-2">
                        <span className="font-medium">{e.hospital_code}</span>
                        <span className="text-stone-500">{e.hospital_name}</span>
                        <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-700">{CAT_LABEL[e.category] ?? e.category}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${e.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-600"}`}>{e.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === "findings" && (
            <div className="space-y-4">
              <FindingsForDoctor
                reactions={features.reactions}
                respond={features.findingsRespond}
              />
              <LocalDocumentAuditsForDoctor respond={features.findingsRespond} />
              <p className="text-[12px] text-stone-500 leading-snug px-1">{ADVISORY_FOOTER}</p>
            </div>
          )}

          {tab === "performance" && (
            perfLoading ? <div className="text-sm text-stone-500">Loading…</div> :
            !perfMapped ? (
              <section className="bg-white border border-stone-200 rounded-xl p-6 text-sm text-stone-600">Your clinical-metrics account is not linked yet. Once governance links your profile to the performance system, your weekly metrics will appear here.</section>
            ) : perf.length === 0 ? (
              <section className="bg-white border border-stone-200 rounded-xl p-6 text-sm text-stone-600">No performance data available yet.</section>
            ) : (() => {
              const latest = perf[perf.length - 1];
              const p = (v: number | null) => (v == null ? "\u2014" : `${v}%`);
              const num = (v: number | null) => (v == null ? "\u2014" : String(v));
              const tiles: Array<[string, string, string]> = [
                ["Consults", num(latest.total_consults), latest.doctor_channel_type ?? ""],
                ["CSAT", p(latest.csat_pct), `${latest.csat_responses ?? 0} responses`],
                ["Patient no-show", p(latest.patient_noshow_rate), ""],
                ["Doctor no-show", p(latest.doctor_noshow_tc_rate), ""],
                ["Cancellation", p(latest.cancellation_rate), ""],
                ["Missing prescription", p(latest.missing_prescription_rate), ""],
              ];
              return (
                <div className="space-y-4">
                  <section className="bg-white border border-stone-200 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-sm font-semibold">This week <span className="text-[11px] text-stone-400 font-normal">· week of {fmt(latest.week)}</span></h2>
                      <span className="text-[11px] text-stone-400">{latest.doctor_specialty ?? ""}</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {tiles.map(([label, value, sub]) => (
                        <div key={label} className="border border-stone-100 rounded-lg p-3">
                          <div className="text-[10px] font-medium text-stone-500 tracking-wider uppercase">{label}</div>
                          <div className="text-2xl font-semibold num mt-1">{value}</div>
                          {sub ? <div className="text-[11px] text-stone-400 mt-0.5">{sub}</div> : null}
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="bg-white border border-stone-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                      <h2 className="text-sm font-semibold">Weekly trend</h2>
                      {perfSnap ? <span className="text-[11px] text-stone-400">data as of {fmt(perfSnap)}</span> : null}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead className="bg-stone-50 text-stone-500 text-[11px] uppercase tracking-wider">
                          <tr>
                            <th className="text-left px-4 py-2 font-medium">Week</th>
                            <th className="text-right px-3 py-2 font-medium">Consults</th>
                            <th className="text-right px-3 py-2 font-medium">CSAT</th>
                            <th className="text-right px-3 py-2 font-medium">Pt no-show</th>
                            <th className="text-right px-3 py-2 font-medium">Cancel</th>
                            <th className="text-right px-3 py-2 font-medium">Missing Rx</th>
                            <th className="text-right px-3 py-2 font-medium">Rx &lt;30m</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-50">
                          {[...perf].reverse().map((w) => (
                            <tr key={w.week} className="hover:bg-stone-50">
                              <td className="px-4 py-2 font-medium text-stone-800">{fmt(w.week)}</td>
                              <td className="px-3 py-2 text-right num">{num(w.total_consults)}</td>
                              <td className="px-3 py-2 text-right num">{p(w.csat_pct)}</td>
                              <td className="px-3 py-2 text-right num">{p(w.patient_noshow_rate)}</td>
                              <td className="px-3 py-2 text-right num">{p(w.cancellation_rate)}</td>
                              <td className="px-3 py-2 text-right num">{p(w.missing_prescription_rate)}</td>
                              <td className="px-3 py-2 text-right num">{p(w.presc_under_30_pct)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              );
            })()
          )}

          {tab === "qualifications" && (
            <div className="space-y-3">
              <div className="flex gap-1.5 mb-1">
                <button onClick={() => setTab("qualifications")} className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium ${(tab as string) === "qualifications" ? "bg-brand-softer text-brand border border-teal-200" : "bg-white border border-stone-200 text-stone-600"}`}>Qualifications</button>
                <button onClick={() => setTab("privileges")} className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium ${(tab as string) === "privileges" ? "bg-brand-softer text-brand border border-teal-200" : "bg-white border border-stone-200 text-stone-600"}`}>Privileges</button>
              </div>
            </div>
          )}
          {tab === "qualifications" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Qualifications</h2>
                <button onClick={() => setShowAdd((v) => !v)} className="text-[12px] text-teal-700 font-medium">{showAdd ? "Cancel" : "+ Add qualification"}</button>
              </div>
              {showAdd && (
                <form onSubmit={addQual} className="px-5 py-4 border-b border-stone-100 bg-stone-50 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="block text-xs font-medium text-stone-500 mb-1">Degree *</label><input value={qDegree} onChange={(e) => setQDegree(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" placeholder="MBBS, MS Ortho…" /></div>
                    <div><label className="block text-xs font-medium text-stone-500 mb-1">Institution</label><input value={qInst} onChange={(e) => setQInst(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" /></div>
                    <div><label className="block text-xs font-medium text-stone-500 mb-1">Year</label><input value={qYear} onChange={(e) => setQYear(e.target.value.replace(/\D/g, "").slice(0, 4))} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm num" /></div>
                    <div><label className="block text-xs font-medium text-stone-500 mb-1">Country</label><input value={qCountry} onChange={(e) => setQCountry(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" /></div>
                  </div>
                  <div><label className="block text-xs font-medium text-stone-500 mb-1">Certificate (PDF/PNG/JPEG, optional, ≤2 MB)</label><input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setQFile(e.target.files?.[0] ?? null)} className="text-sm" /></div>
                  {qErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{qErr}</div>}
                  <div className="text-[11px] text-stone-400">Submitted qualifications start unverified — an administrator reviews them.</div>
                  <button type="submit" disabled={qBusy} className="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50">{qBusy ? "Adding…" : "Add"}</button>
                </form>
              )}
              {quals.length === 0 ? <div className="px-5 py-10 text-center text-sm text-stone-500">No qualifications yet.</div> : (
                <div className="divide-y divide-stone-100">
                  {quals.map((q) => (
                    <div key={q.id} className="px-5 py-3">
                      {editId === q.id ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-3 gap-2">
                            <input value={eDegree} onChange={(e) => setEDegree(e.target.value)} className="px-2 py-1.5 border border-stone-200 rounded text-sm" placeholder="Degree" />
                            <input value={eInst} onChange={(e) => setEInst(e.target.value)} className="px-2 py-1.5 border border-stone-200 rounded text-sm" placeholder="Institution" />
                            <input value={eYear} onChange={(e) => setEYear(e.target.value.replace(/\D/g, "").slice(0, 4))} className="px-2 py-1.5 border border-stone-200 rounded text-sm num" placeholder="Year" />
                          </div>
                          <div className="flex gap-2"><button onClick={() => saveEdit(q.id)} className="text-xs bg-teal-600 text-white px-3 py-1.5 rounded-lg font-medium">Save</button><button onClick={() => setEditId(null)} className="text-xs text-stone-500">Cancel</button></div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <div className="flex-1">
                            <div className="text-sm font-medium">{q.degree} {q.year_completed ? <span className="text-stone-400 font-normal">· {q.year_completed}</span> : null}</div>
                            <div className="text-xs text-stone-500">{q.institution ?? "—"}{q.has_file ? ` · 📎 ${q.file_filename ?? "certificate"}` : ""}</div>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${q.verified ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{q.verified ? "Verified" : "Pending verification"}</span>
                          {!q.verified && <button onClick={() => startEdit(q)} className="text-[12px] text-teal-700 font-medium">Edit</button>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {tab === "privileges" && (
            <div className="space-y-3">
              <div className="flex gap-1.5 mb-1">
                <button onClick={() => setTab("qualifications")} className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium ${(tab as string) === "qualifications" ? "bg-brand-softer text-brand border border-teal-200" : "bg-white border border-stone-200 text-stone-600"}`}>Qualifications</button>
                <button onClick={() => setTab("privileges")} className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium ${(tab as string) === "privileges" ? "bg-brand-softer text-brand border border-teal-200" : "bg-white border border-stone-200 text-stone-600"}`}>Privileges</button>
              </div>
            </div>
          )}
          {tab === "privileges" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100"><h2 className="text-sm font-semibold">Current Privileges <span className="text-[11px] text-stone-400 font-normal">· read-only</span></h2></div>
              {privs.filter((p) => !p.withdrawn_date).length === 0 ? <div className="px-5 py-10 text-center text-sm text-stone-500">No active privileges on record.</div> : (
                <div className="divide-y divide-stone-100">
                  {privs.filter((p) => !p.withdrawn_date).map((p) => (
                    <div key={p.id} className="px-5 py-3 flex items-center gap-3 text-sm">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${p.is_core ? "bg-brand/10 text-brand" : "bg-violet-50 text-violet-700"}`}>{p.is_core ? "Core" : "Special"}</span>
                      <div className="flex-1"><span className="font-medium">{p.procedure_or_specialty}</span> <span className="text-stone-400">· {p.hospital_code}</span></div>
                      {p.expires_at && <span className="text-[11px] text-stone-500">expires {fmt(p.expires_at)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === "aboutme" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100"><h2 className="text-sm font-semibold">Feedback about you</h2></div>
              {about.length === 0 ? <div className="px-5 py-10 text-center text-sm text-stone-500">Nothing has been filed about you.</div> : (
                <div className="divide-y divide-stone-100">
                  {about.map((a) => {
                    const isPos = a.polarity === "positive";
                    return (
                      <div key={a.id} className={`px-5 py-4 ${a.status === "retracted" ? "opacity-70" : ""}`}>
                        <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${isPos ? "bg-emerald-50 text-emerald-700" : "bg-stone-800 text-white"}`}>{isPos ? "Positive" : "Concern"}</span>
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-violet-50 text-violet-700">{a.source === "patient" ? "Patient" : a.source === "governance" ? "Governance" : "Peer"}</span>
                          {isPos ? (a.commendation_category && <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">{a.commendation_category}</span>)
                                 : <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-800">{a.severity ?? "—"}</span>}
                          {a.patient_rating != null && <span className="px-2 py-0.5 rounded-full text-[11px] text-amber-700 bg-amber-50">{a.patient_rating}/5</span>}
                          {a.status === "retracted" && <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-700">retracted</span>}
                        </div>
                        <div className="text-sm text-stone-800">{a.narrative}</div>
                        <div className="text-[11px] text-stone-400 mt-1">From: {a.reporter_display}{a.hospital_code ? ` · ${a.hospital_code}` : ""} · {new Date(a.submitted_at).toISOString().slice(0, 10)}</div>
                        {a.replies.length > 0 && (
                          <div className="mt-2 space-y-1.5 border-l-2 border-stone-100 pl-3">
                            {a.replies.map((rp) => (<div key={rp.id} className="text-xs text-stone-600"><span className="font-medium">{rp.author}</span>: {rp.text} <span className="text-stone-400">· {new Date(rp.at).toISOString().slice(0, 10)}</span></div>))}
                          </div>
                        )}
                        {replyFor === a.id ? (
                          <div className="mt-2 flex gap-2">
                            <input value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Your response…" className="flex-1 px-3 py-1.5 border border-stone-200 rounded-lg text-sm" />
                            <button onClick={() => sendReply(a.id)} className="text-xs bg-teal-600 text-white px-3 py-1.5 rounded-lg font-medium">Send</button>
                            <button onClick={() => { setReplyFor(null); setReplyText(""); }} className="text-xs text-stone-500">Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => setReplyFor(a.id)} className="mt-2 text-[12px] text-teal-700 font-medium">Respond</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {tab === "resign" && (
            <section className="bg-white border border-stone-200 rounded-xl p-5">
              <h2 className="text-sm font-semibold mb-1">Submit a resignation</h2>
              <p className="text-[11px] text-stone-400 mb-4">This sends a request to administrators — they process the formal status change. You can withdraw by contacting your administrator.</p>
              {resignReqs.length > 0 && (
                <div className="mb-4 space-y-1.5">
                  {resignReqs.map((rq) => (
                    <div key={rq.id} className="flex items-center gap-2 text-xs border border-stone-100 rounded-lg px-3 py-2">
                      <span className="font-medium">{rq.hospital_code ?? "All hospitals"}</span>
                      <span className="text-stone-500">{rq.intended_last_date ? `last day ${rq.intended_last_date.slice(0, 10)}` : ""}</span>
                      <span className={`ml-auto px-2 py-0.5 rounded-full font-medium ${rq.status === "pending" ? "bg-amber-50 text-amber-800" : rq.status === "processed" ? "bg-stone-100 text-stone-600" : "bg-stone-100 text-stone-500"}`}>{rq.status}</span>
                    </div>
                  ))}
                </div>
              )}
              <form onSubmit={submitResign} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">Hospital</label>
                    <select value={resHosp} onChange={(e) => setResHosp(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                      <option value="">All my engagements</option>
                      {engs.map((e) => <option key={e.id} value={e.hospital_id}>{e.hospital_code}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1">Intended last working day</label>
                    <input type="date" value={resDate} onChange={(e) => setResDate(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">Reason</label>
                  <textarea value={resReason} onChange={(e) => setResReason(e.target.value)} rows={4} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" />
                </div>
                {resErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{resErr}</div>}
                <button type="submit" disabled={resBusy} className="bg-stone-800 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-stone-900 disabled:opacity-50">{resBusy ? "Submitting…" : "Submit resignation request"}</button>
              </form>
            </section>
          )}

          {tab === "report" && reportMode === "chooser" && (
            <div className="space-y-3">
              {features.incidents && (
                <button onClick={() => setReportMode("incident")} className="w-full rounded-xl border border-stone-200 bg-white p-5 text-left hover:border-brand">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-50 text-rose-600 text-lg">⚑</span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold">Report an incident</span>
                      <span className="block text-[12.5px] text-stone-500">Patient safety, staff, facility or service — named, confidential or anonymous. Goes to the RCA/CAPA pipeline.</span>
                    </span>
                  </div>
                </button>
              )}
              <button onClick={() => setReportMode("feedback")} className="w-full rounded-xl border border-stone-200 bg-white p-5 text-left hover:border-brand">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-50 text-sky-600 text-lg">✉</span>
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">Feedback about a colleague</span>
                    <span className="block text-[12.5px] text-stone-500">Commendations or concerns about another doctor&apos;s practice — goes to physician governance.</span>
                  </span>
                </div>
              </button>
            </div>
          )}
          {tab === "report" && reportMode === "incident" && features.incidents && me && (
            <div className="space-y-3">
              <button onClick={() => setReportMode("chooser")} className="text-[13px] font-medium text-stone-500">← Back</button>
              <IncidentReporting doctorName={me.full_name} />
            </div>
          )}
          {tab === "report" && reportMode === "feedback" && (
            <section className="bg-white border border-stone-200 rounded-xl p-5">
              <button onClick={() => setReportMode("chooser")} className="mb-2 text-[13px] font-medium text-stone-500">← Back</button>
              <h2 className="text-sm font-semibold mb-1">Report feedback on another doctor</h2>
              <p className="text-[11px] text-stone-400 mb-4">Positive feedback is shared with your name. Negative reports can be anonymous to the doctor and peers — administrators always see who filed it.</p>
              {rDone && (
                <div className="mb-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center justify-between">
                  <span>Feedback submitted. Thank you.</span>
                  <button onClick={() => setRDone(false)} className="text-[12px] text-emerald-700 font-medium">File another</button>
                </div>
              )}
              {!rDone && (
              <form onSubmit={submitReport} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">Doctor</label>
                  {rTarget ? (
                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-stone-50">
                      <span className="text-sm font-medium flex-1">{rTarget.full_name}</span>
                      <button type="button" onClick={() => setRTarget(null)} className="text-[12px] text-teal-700 font-medium">Change</button>
                    </div>
                  ) : (
                    <>
                      <input value={rQ} onChange={(e) => setRQ(e.target.value)} placeholder="Search doctors by name…" className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-teal-600" />
                      {rResults.length > 0 && (
                        <div className="mt-1 max-h-52 overflow-y-auto border border-stone-100 rounded-lg divide-y divide-stone-100">
                          {rResults.map((p) => (
                            <button key={p.id} type="button" onClick={() => { setRTarget({ id: p.id, full_name: p.full_name }); setRResults([]); }} className="w-full text-left px-3 py-2 hover:bg-stone-50 text-sm">
                              {p.full_name} <span className="text-stone-400">· {p.primary_specialty ?? "—"}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">Type</label>
                  <div className="flex gap-1.5">
                    {(["positive", "negative"] as const).map((v) => (
                      <button key={v} type="button" onClick={() => setRPolarity(v)} className={`px-3 py-1.5 rounded-full text-[12px] font-medium border ${rPolarity === v ? (v === "positive" ? "bg-emerald-600 text-white border-emerald-600" : "bg-stone-800 text-white border-stone-800") : "bg-white text-stone-700 border-stone-200"}`}>{v === "positive" ? "Positive" : "Concern"}</button>
                    ))}
                  </div>
                </div>
                {rPolarity === "negative" ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-stone-500 mb-1.5">Category</label>
                      <select value={rCategory} onChange={(e) => setRCategory(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                        <option value="">— Choose —</option>
                        {FB_CATEGORIES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-stone-500 mb-1.5">Severity</label>
                      <div className="grid grid-cols-4 gap-2">
                        {["low", "medium", "high", "critical"].map((sv) => (
                          <button key={sv} type="button" onClick={() => setRSeverity(sv)} className={`px-3 py-2 rounded-lg text-xs font-medium border ${rSeverity === sv ? "border-stone-700 ring-2 ring-stone-200 bg-stone-50" : "bg-white border-stone-200"}`}>{sv}</button>
                        ))}
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rAnon} onChange={(e) => setRAnon(e.target.checked)} className="accent-teal-600" /> File anonymously (hidden from the doctor &amp; peers)</label>
                  </>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-stone-500 mb-1.5">Commendation</label>
                    <select value={rComm} onChange={(e) => setRComm(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white">
                      <option value="">— Choose —</option>
                      {FB_COMMENDATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">{rPolarity === "positive" ? "What did they do well?" : "What happened?"}</label>
                  <textarea value={rNarr} onChange={(e) => setRNarr(e.target.value)} rows={5} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-teal-600" />
                </div>
                {rErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{rErr}</div>}
                <button type="submit" disabled={rBusy} className="bg-teal-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50">{rBusy ? "Submitting…" : "Submit feedback"}</button>
              </form>
              )}
            </section>
          )}

        </>
        )}
      </div>
      </div>
      <MobileTabBar dest={dest} onChange={goDest} showFindings={features.findings} />
    </main>
  );
}
