"use client";

import { useEffect, useState } from "react";
import { OpdSignalsSection } from "@/components/v2/OpdSignalsSection";
import { PhysicianAuditFindings } from "@/components/audit-findings/PhysicianAuditFindings";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { AddEngagementModal } from "@/components/AddEngagementModal";
import { AddQualificationModal } from "@/components/AddQualificationModal";
import { AddPrivilegeModal } from "@/components/AddPrivilegeModal";
import { TriggerFppeModal } from "@/components/TriggerFppeModal";
import { OppeReviewModal } from "@/components/OppeReviewModal";
import { EditPrivilegeModal } from "@/components/EditPrivilegeModal";
import { ChangeCategoryModal } from "@/components/ChangeCategoryModal";
import { MiniLineChart } from "@/components/MiniLineChart";
import { PhysicianDocumentationSection } from "@/components/document-audits/PhysicianDocumentationSection";

interface Physician {
  id: string;
  full_name: string;
  preferred_name: string | null;
  primary_specialty: string | null;
  registration_number: string | null;
  registration_council: string | null;
  registration_expiry: string | null;
  email: string | null;
  phone: string | null;
  date_joined_network: string | null;
  current_status: string;
  portal_access?: boolean;
  notes: string | null;
}

interface Engagement {
  id: string;
  hospital_code: string;
  hospital_name: string;
  category: string;
  start_date: string;
  end_date: string | null;
  specialty: string | null;
  status: string;
  status_reason: string | null;
}

interface OppeRow {
  id: string;
  hospital_id: string;
  hospital_code: string;
  period_start: string;
  period_end: string;
  due_at: string;
  status: string;
  completed_at: string | null;
  decision_notes: string | null;
  reviewer_email: string | null;
  reviewer_name: string | null;
  created_at: string;
}

interface Qualification {
  id: string;
  degree: string;
  institution: string | null;
  institution_tier: string | null;
  year_completed: number | null;
  country: string | null;
  verified: boolean;
  verified_at: string | null;
  verified_by_email: string | null;
  has_file: boolean;
  file_filename: string | null;
  file_mime: string | null;
  file_size_bytes: number | null;
  created_at: string;
}

interface Privilege {
  id: string;
  hospital_id: string;
  hospital_code: string;
  hospital_name: string;
  procedure_or_specialty: string;
  granted_date: string;
  basis: string;
  is_core: boolean;
  expires_at: string | null;
  granted_by_email: string | null;
  withdrawn_date: string | null;
  withdrawn_reason: string | null;
}

interface FeedbackRow {
  id: string;
  hospital_code: string;
  feedback_period: string;
  csat_score: number | null;
  complaint_count: number | null;
  source: string | null;
  uploaded_at: string;
  uploaded_by_email: string | null;
}

interface IncidentRow {
  id: string;
  submitted_at: string;
  anonymous_flag: boolean;
  submitter_label: string;
  category: string | null;
  severity: string | null;
  polarity: string;
  source: string;
  commendation_category: string | null;
  patient_rating: number | null;
  narrative_preview: string;
  status: string;
  retracted_at: string | null;
  retraction_reason: string | null;
  reply_count: number;
}

interface MetricsRow {
  hospital_code: string;
  year: number;
  month: number;
  opd_count: number | null;
  ipd_admissions: number | null;
  ot_cases: number | null;
  revenue_inr: number | null;
  uploaded_at: string;
  uploaded_by_email: string | null;
}

interface UserSummary {
  profileId: string;
  is_super_admin: boolean;
  is_hr: boolean;
  is_site_medical_head: boolean;
}

interface AuditRow {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  actor_email: string | null;
  actor_position: string | null;
}

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

const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  inactive: "bg-stone-100 text-stone-600",
  terminated: "bg-red-50 text-red-700",
};

// CR.1 — 5-state engagement status (decision #9)
const ENGAGEMENT_STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  suspended: "bg-amber-50 text-amber-800",
  revoked: "bg-red-50 text-red-700",
  resigned: "bg-stone-100 text-stone-600",
  lapsed: "bg-stone-100 text-stone-500",
};

// CR.1 — 5-value engagement category (decisions #2, #3, #18)
const CATEGORY_LABEL: Record<string, string> = {
  provisional: "Provisional",
  active: "Active",
  visiting_consultant: "VC",
  locum_tenens: "Locum",
  affiliate: "Affiliate",
};
const CATEGORY_PILL: Record<string, string> = {
  provisional: "bg-amber-50 text-amber-800",
  active: "bg-brand/10 text-brand",
  visiting_consultant: "bg-violet-50 text-violet-700",
  locum_tenens: "bg-sky-50 text-sky-700",
  affiliate: "bg-stone-100 text-stone-700",
};

const SECTIONS = [
  { key: "overview", label: "Overview", available: true },
  { key: "engagements", label: "Engagements", available: true },
  { key: "qualifications", label: "Qualifications & privileges", available: true },
  { key: "metrics", label: "Clinical metrics", available: true },
  { key: "oppe", label: "OPPE", available: true },
  { key: "elo", label: "Surgical Governance score", available: false, sprint: "Phase 3" },
  { key: "feedback", label: "Feedback", available: true },
  { key: "documentation", label: "Documentation", available: true },
] as const;

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export default function PhysicianProfilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params?.id;

  const [physician, setPhysician] = useState<Physician | null>(null);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [gradReady, setGradReady] = useState<Set<string>>(new Set());
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [quals, setQuals] = useState<Qualification[]>([]);
  const [privs, setPrivs] = useState<Privilege[]>([]);
  const [me, setMe] = useState<UserSummary | null>(null);
  const [metrics, setMetrics] = useState<MetricsRow[]>([]);
  const [incidentsList, setIncidentsList] = useState<IncidentRow[]>([]);
  const [fbFilter, setFbFilter] = useState<{ pol: string; src: string }>({ pol: "all", src: "all" });
  const [addQual, setAddQual] = useState(false);
  const [addPriv, setAddPriv] = useState(false);
  const [triggerFppe, setTriggerFppe] = useState(false);
  const [oppeRows, setOppeRows] = useState<OppeRow[]>([]);
  const [openOppeId, setOpenOppeId] = useState<string | null>(null);
  const [editPrivId, setEditPrivId] = useState<string | null>(null);
  const [changeCatEngId, setChangeCatEngId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const tabParam = searchParams?.get("tab");
  const [section, setSection] = useState<string>(
    tabParam === "documentation" ? "documentation" : "overview",
  );
  const [addEng, setAddEng] = useState(false);

  useEffect(() => {
    if (tabParam === "documentation") setSection("documentation");
  }, [tabParam]);

  async function portalPost(bodyObj: Record<string, unknown>): Promise<boolean> {
    const r = await fetch(`/api/physicians/${id}/portal-access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyObj) });
    const j = await r.json();
    if (!r.ok || !j.ok) { alert(j.error || "Failed"); return false; }
    return true;
  }
  async function enablePortal() {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    if (await portalPost({ enabled: true, pin })) { alert(`Portal access enabled. Temporary PIN: ${pin}\n\nShare it with the doctor — they'll set their own on first login.`); load(); }
  }
  async function resetPortalPin() {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    if (await portalPost({ enabled: true, pin })) { alert(`Portal PIN reset. New temporary PIN: ${pin}`); load(); }
  }
  async function disablePortal() {
    if (!confirm("Disable portal access for this physician?")) return;
    if (await portalPost({ enabled: false })) load();
  }

  function load() {
    if (!id) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/physicians/${id}`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/audit?limit=20`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/qualifications`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/privileges`).then((r) => r.json()),
      fetch(`/api/auth/me`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/clinical-metrics?months=24`).then((r) => r.json()),
      fetch(`/api/incidents?physician_id=${id}&limit=100`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/oppe`).then((r) => r.json()),
    ])
      .then(([pj, aj, qj, prj, mj, mxj, inj, oj]) => {
        if (!pj.ok) { setErr(pj.error || "Not found"); return; }
        setPhysician(pj.physician as Physician);
        setEngagements((pj.engagements ?? []) as Engagement[]);
        setGradReady(new Set<string>(((pj as { graduation_ready_engagement_ids?: string[] }).graduation_ready_engagement_ids ?? [])));
        if (aj.ok) setAudit(aj.rows ?? []);
        if (qj.ok) setQuals(qj.rows ?? []);
        if (prj.ok) setPrivs(prj.rows ?? []);
        if (mj.ok) setMe(mj.user as UserSummary);
        if (mxj.ok) setMetrics(mxj.rows ?? []);
        if (inj.ok) setIncidentsList(inj.rows ?? []);
        if (oj.ok) setOppeRows((oj.rows ?? []) as OppeRow[]);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function graduateEngagement(eid: string) {
    if (!confirm("Graduate this engagement from Provisional → Active? This requires SMH/super_admin sign-off and is audited.")) return;
    const r = await fetch(`/api/physicians/${id}/engagements/${eid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: "active",
        status_reason: "Graduated from Provisional after satisfactory FPPE + 6mo tenure (CR.2).",
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error || "Could not graduate engagement.");
      return;
    }
    load();
  }

    async function endEngagement(eid: string, status: "resigned" | "revoked" | "suspended" | "lapsed" = "resigned") {
    const labelMap: Record<string, string> = {
      resigned: "Reason for resignation? (free text)",
      revoked: "Reason for revocation? (required — what was the cause for permanent removal?)",
      suspended: "Reason for suspension? (required — what investigation triggered this?)",
      lapsed: "Note for lapse? (optional — e.g. didn't recredential by deadline)",
    };
    const reason = prompt(labelMap[status] ?? "Reason?");
    if (reason === null) return;
    if ((status === "revoked" || status === "suspended") && !reason.trim()) {
      alert(`A reason is required when ${status === "revoked" ? "revoking" : "suspending"} an engagement.`);
      return;
    }
    await fetch(`/api/physicians/${id}/engagements/${eid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        end_date: status === "resigned" || status === "revoked"
          ? new Date().toISOString().slice(0, 10)
          : null,
        status_reason: reason.trim() || null,
      }),
    });
    load();
  }


  async function verifyQual(qid: string) {
    await fetch(`/api/physicians/${id}/qualifications/${qid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    load();
  }

  async function deleteQual(qid: string) {
    if (!confirm("Delete this qualification? This cannot be undone.")) return;
    await fetch(`/api/physicians/${id}/qualifications/${qid}`, { method: "DELETE" });
    load();
  }

  async function withdrawPrivilege(prid: string) {
    const reason = prompt("Reason for withdrawing this privilege?");
    if (reason === null) return;
    await fetch(`/api/physicians/${id}/privileges/${prid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        withdrawn_date: new Date().toISOString().slice(0, 10),
        withdrawn_reason: reason || null,
      }),
    });
    load();
  }

  async function deletePhysician() {
    if (!confirm(`Mark ${physician?.full_name} as terminated? They can be reactivated later.`)) return;
    await fetch(`/api/physicians/${id}`, { method: "DELETE" });
    router.push("/physicians");
  }

  async function reactivatePhysician() {
    if (!confirm(`Reactivate ${physician?.full_name}? Their current_status will flip back to 'active'. Engagement statuses are unchanged — if you want them taking cases again, ensure at least one engagement is also status='active'.`)) return;
    const r = await fetch(`/api/physicians/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_status: "active" }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error || "Could not reactivate.");
      return;
    }
    load();
  }

  if (loading) {
    return (
      <>
        <TopNav />
        <main className="max-w-[1400px] mx-auto px-8 py-8 text-sm text-stone-500">Loading…</main>
      </>
    );
  }
  if (err || !physician) {
    return (
      <>
        <TopNav />
        <main className="max-w-[1400px] mx-auto px-8 py-12 text-center">
          <h1 className="text-lg font-semibold mb-2">{err || "Physician not found"}</h1>
          <Link href="/physicians" className="text-brand text-sm font-medium">← Back to roster</Link>
        </main>
      </>
    );
  }

  const activeEng = engagements.filter((e) => e.status === "active");
  const sortedEng = [...engagements].sort((a, b) => (a.start_date < b.start_date ? 1 : -1));

  return (
    <>
      <TopNav />

      {/* Identity header */}
      <div className="bg-white border-b border-stone-200">
        <div className="max-w-[1400px] mx-auto px-8 py-6">
          <div className="text-sm text-stone-500 mb-2">
            <Link href="/physicians" className="hover:text-stone-900">Physician DB</Link>
            <span className="mx-1.5">/</span>
            <span className="text-stone-900 font-medium">{physician.full_name}</span>
          </div>
          <div className="flex items-start gap-6">
            <span className={`w-[72px] h-[72px] rounded-full inline-flex items-center justify-center text-[22px] font-medium ${colorFor(physician.full_name)}`}>
              {initials(physician.full_name)}
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-semibold tracking-tight">{physician.full_name}</h1>
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_PILL[physician.current_status] ?? "bg-stone-100 text-stone-600"}`}>
                  {physician.current_status}
                </span>
                {physician.primary_specialty && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-700">
                    {physician.primary_specialty}
                  </span>
                )}
              </div>
              <div className="text-sm text-stone-500">
                {physician.registration_number ? `${physician.registration_council ?? "Reg"} ${physician.registration_number} · ` : ""}
                {physician.email ?? "no email on file"}
                {physician.phone ? ` · ${physician.phone}` : ""}
              </div>
              <div className="flex gap-6 items-center mt-4">
                <div>
                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Active engagements</div>
                  <div className="num text-2xl font-semibold mt-1">{activeEng.length}</div>
                </div>
                <div className="border-l border-stone-200 h-9"></div>
                <div>
                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Joined network</div>
                  <div className="text-sm font-medium mt-1.5">{fmtDate(physician.date_joined_network)}</div>
                </div>
                <div className="border-l border-stone-200 h-9"></div>
                <div>
                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">License expires</div>
                  <div className="text-sm font-medium mt-1.5">{fmtDate(physician.registration_expiry)}</div>
                </div>
                <div className="border-l border-stone-200 h-9"></div>
                <div>
                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Governance score</div>
                  <div className="text-sm font-medium mt-1.5 text-stone-400">— · Phase 3</div>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              {physician.current_status === "active" && (me?.is_super_admin || me?.is_site_medical_head || me?.is_hr) && (
                <button onClick={() => setTriggerFppe(true)} title="Focused Professional Practice Evaluation" className="px-3 py-2 rounded-lg text-sm font-medium text-amber-800 bg-amber-50 hover:bg-amber-100">
                  Trigger FPPE
                </button>
              )}
              {physician.current_status === "terminated" ? (
                <button onClick={reactivatePhysician} className="px-3 py-2 rounded-lg text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100">
                  Reactivate
                </button>
              ) : (
                <button onClick={deletePhysician} className="px-3 py-2 rounded-lg text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100">
                  Mark terminated
                </button>
              )}
              {(me?.is_super_admin || me?.is_site_medical_head || me?.is_hr) && (
                physician.portal_access ? (
                  <>
                    <button onClick={resetPortalPin} className="px-3 py-2 rounded-lg text-sm font-medium text-teal-700 bg-teal-50 hover:bg-teal-100">Reset portal PIN</button>
                    <button onClick={disablePortal} className="px-3 py-2 rounded-lg text-sm font-medium text-stone-600 bg-stone-100 hover:bg-stone-200">Disable portal</button>
                  </>
                ) : (
                  <button onClick={enablePortal} className="px-3 py-2 rounded-lg text-sm font-medium text-teal-700 bg-teal-50 hover:bg-teal-100">Enable portal</button>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Body: sidebar + main pane */}
      <main className="max-w-[1400px] mx-auto px-8 py-6 grid grid-cols-[220px_1fr] gap-6">
        <aside>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => s.available && setSection(s.key)}
              disabled={!s.available}
              className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium transition ${
                section === s.key
                  ? "bg-brand-softer text-brand"
                  : s.available
                  ? "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
                  : "text-stone-300 cursor-not-allowed"
              }`}
            >
              <span>{s.label}</span>
              {!s.available && (
                <span className="ml-auto text-[10px] text-stone-300">{s.sprint}</span>
              )}
            </button>
          ))}
        </aside>

        <div>
          {section === "overview" && (
            <div className="space-y-4">
              <section className="bg-white border border-stone-200 rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-4">Snapshot</h2>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-stone-50 rounded-lg p-3">
                    <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Engagements</div>
                    <div className="num text-xl font-semibold mt-1">{engagements.length}</div>
                    <div className="text-[11px] text-stone-500 mt-0.5">{activeEng.length} active</div>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-3">
                    <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Open incidents</div>
                    <div className={`num text-xl font-semibold mt-1 ${incidentsList.filter((r) => r.status === "open").length > 0 ? "text-amber-700" : "text-stone-400"}`}>{incidentsList.filter((r) => r.status === "open").length}</div>
                    <button onClick={() => setSection("feedback")} className="text-[11px] text-brand hover:underline mt-0.5">View →</button>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-3">
                    <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Governance score</div>
                    <div className="num text-xl font-semibold mt-1 text-stone-400">—</div>
                    <div className="text-[11px] text-stone-400 mt-0.5">Phase 3</div>
                  </div>
                </div>
                {physician.notes && (
                  <div className="mt-4 pt-4 border-t border-stone-100">
                    <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase mb-2">Notes</div>
                    <div className="text-sm text-stone-700 whitespace-pre-wrap">{physician.notes}</div>
                  </div>
                )}
              </section>

              <OpdSignalsSection physicianId={id as string} />

              <PhysicianAuditFindings physicianId={id as string} />

              <section className="bg-white border border-stone-200 rounded-xl">
                <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Recent activity</h2>
                  <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">{audit.length}</span>
                </div>
                {audit.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-stone-500">No activity recorded yet.</div>
                ) : (
                  <div className="px-4 py-2 mono text-[11px] text-stone-700">
                    {audit.map((r) => (
                      <div key={r.id} className="py-1.5 border-b border-dashed border-stone-100 last:border-b-0 leading-relaxed">
                        <div className="text-stone-400 text-[10px]">{timeAgo(r.created_at)}</div>
                        <div>{r.actor_email ?? "—"}{r.actor_position ? ` · ${r.actor_position}` : ""}</div>
                        <div className={
                          r.action === "delete" || r.action === "retract" ? "text-red-700"
                          : r.action === "update" ? "text-blue-700" : "text-emerald-700"
                        }>
                          {r.action} {r.entity_type}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {section === "engagements" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Engagements <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{engagements.length}</span></h2>
                <button onClick={() => setAddEng(true)} className="text-[12px] text-brand font-medium">+ Add engagement</button>
              </div>
              {engagements.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-stone-500">
                  No engagements yet. <button onClick={() => setAddEng(true)} className="text-brand font-medium">Add the first one →</button>
                </div>
              ) : (
                <div className="divide-y divide-stone-100">
                  {sortedEng.map((e) => (
                    <div key={e.id} className="px-5 py-4 flex items-start gap-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        ENGAGEMENT_STATUS_PILL[e.status] ?? "bg-stone-100 text-stone-500"
                      }`}>
                        <button
                          type="button"
                          onClick={() => {
                            if (me?.is_super_admin || me?.is_site_medical_head) setChangeCatEngId(e.id);
                          }}
                          disabled={!(me?.is_super_admin || me?.is_site_medical_head)}
                          title={(me?.is_super_admin || me?.is_site_medical_head) ? "Change category" : undefined}
                          className={`mr-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${CATEGORY_PILL[e.category] ?? "bg-stone-100 text-stone-700"} ${(me?.is_super_admin || me?.is_site_medical_head) ? "hover:ring-2 hover:ring-stone-300 cursor-pointer" : "cursor-default"}`}
                        >
                          {CATEGORY_LABEL[e.category] ?? e.category}
                        </button>
                        <span>{e.status}</span>
                      </span>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-stone-900">{e.hospital_code} · {e.specialty ?? physician.primary_specialty ?? "—"}</div>
                        <div className="text-xs text-stone-500 mt-0.5">
                          {fmtDate(e.start_date)} → {e.end_date ? fmtDate(e.end_date) : "present"}
                          {e.status_reason && <span className="text-red-700"> · {e.status_reason}</span>}
                        </div>
                      </div>
                      {e.status === "active" && (
                        <div className="flex flex-col items-end gap-2">
                          {e.category === "provisional" && gradReady.has(e.id) && (me?.is_super_admin || me?.is_site_medical_head) && (
                            <button
                              onClick={() => graduateEngagement(e.id)}
                              className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700 border border-emerald-700"
                              title="6 months tenure + satisfactory FPPE complete — eligible for graduation"
                            >
                              ↑ Graduate to Active
                            </button>
                          )}
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-stone-400">End engagement</span>
                            <div className="flex flex-wrap items-center gap-1.5 justify-end">
                              <button onClick={() => endEngagement(e.id, "suspended")} className="px-2 py-1 rounded-md text-[11px] font-medium bg-white border border-amber-200 text-amber-800 hover:bg-amber-50">Suspend</button>
                              <button onClick={() => endEngagement(e.id, "revoked")} className="px-2 py-1 rounded-md text-[11px] font-medium bg-white border border-red-200 text-red-700 hover:bg-red-50">Revoke</button>
                              <button onClick={() => endEngagement(e.id, "resigned")} className="px-2 py-1 rounded-md text-[11px] font-medium bg-white border border-stone-200 text-stone-700 hover:bg-stone-50">Resign</button>
                              <button onClick={() => endEngagement(e.id, "lapsed")} className="px-2 py-1 rounded-md text-[11px] font-medium bg-white border border-stone-200 text-stone-500 hover:bg-stone-50">Lapsed</button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}


          {section === "qualifications" && (
            <div className="space-y-4">
              <section className="bg-white border border-stone-200 rounded-xl">
                <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Qualifications <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{quals.length}</span></h2>
                  <button onClick={() => setAddQual(true)} className="text-[12px] text-brand font-medium">+ Add qualification</button>
                </div>
                {quals.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-stone-500">
                    No qualifications yet. <button onClick={() => setAddQual(true)} className="text-brand font-medium">Add the first one →</button>
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {quals.map((q) => (
                      <div key={q.id} className="px-5 py-4 flex items-start gap-4">
                        <div className="flex-1">
                          <div className="text-sm font-medium text-stone-900">{q.degree}</div>
                          <div className="text-xs text-stone-500 mt-0.5">
                            {q.institution ?? "—"}
                            {q.institution_tier && q.institution_tier !== "Unknown" && (
                              <span className="ml-1 text-stone-400">· Tier {q.institution_tier}</span>
                            )}
                            {q.year_completed && <span className="ml-1">· {q.year_completed}</span>}
                            {q.country && <span className="ml-1">· {q.country}</span>}
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            {q.has_file && (
                              <a
                                href={`/api/physicians/${id}/qualifications/${q.id}/file`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 text-[12px] text-brand font-medium hover:underline"
                              >
                                View certificate
                                <span className="text-stone-400">· {q.file_filename} ({((q.file_size_bytes ?? 0) / 1024).toFixed(0)} KB)</span>
                              </a>
                            )}
                            {!q.has_file && <span className="text-[12px] text-stone-400">No certificate uploaded</span>}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {q.verified ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">
                              ✓ Verified{q.verified_by_email ? ` by ${q.verified_by_email.split("@")[0]}` : ""}
                            </span>
                          ) : (
                            (me?.is_super_admin || me?.is_hr || me?.is_site_medical_head) && (
                              <button
                                onClick={() => verifyQual(q.id)}
                                className="px-3 py-1 rounded-lg text-[12px] font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              >
                                Verify
                              </button>
                            )
                          )}
                          {me?.is_super_admin && (
                            <button onClick={() => deleteQual(q.id)} className="text-[11px] text-stone-400 hover:text-red-700">Delete</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="bg-white border border-stone-200 rounded-xl">
                <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Privileges <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{privs.length}</span></h2>
                  <button onClick={() => setAddPriv(true)} className="text-[12px] text-brand font-medium">+ Grant privilege</button>
                </div>
                {privs.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-stone-500">
                    No privileges yet. <button onClick={() => setAddPriv(true)} className="text-brand font-medium">Grant the first →</button>
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {privs.map((pr) => {
                      const withdrawn = !!pr.withdrawn_date;
                      return (
                        <div key={pr.id} className="px-5 py-4 flex items-start gap-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            withdrawn ? "bg-stone-100 text-stone-500" : "bg-emerald-50 text-emerald-700"
                          }`}>
                            {withdrawn ? "Withdrawn" : "Active"}
                          </span>
                          <div className="flex-1">
                            <div className="text-sm font-medium text-stone-900">{pr.procedure_or_specialty} <span className="font-normal text-stone-500">· {pr.hospital_code}</span></div>
                            <div className="text-xs text-stone-500 mt-0.5">
                              Granted {fmtDate(pr.granted_date)} · {pr.basis.replace(/_/g, " ")}
                              {pr.granted_by_email && <span className="ml-1">· by {pr.granted_by_email.split("@")[0]}</span>}
                            </div>
                            {withdrawn && (
                              <div className="text-xs text-red-700 mt-0.5">Withdrawn {fmtDate(pr.withdrawn_date)}{pr.withdrawn_reason ? ` · ${pr.withdrawn_reason}` : ""}</div>
                            )}
                          </div>
                          {(me?.is_super_admin || me?.is_site_medical_head) && (
                            <div className="flex gap-2 items-center">
                              <button
                                onClick={() => setEditPrivId(pr.id)}
                                className="text-[12px] text-brand font-medium hover:underline"
                              >
                                Edit
                              </button>
                              {!withdrawn && (
                                <button
                                  onClick={() => withdrawPrivilege(pr.id)}
                                  className="text-[12px] text-stone-500 hover:text-red-700"
                                >
                                  Withdraw
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}


          {section === "metrics" && (
            <div className="space-y-4">
              {metrics.length === 0 ? (
                <section className="bg-white border border-stone-200 rounded-xl py-12 text-center">
                  <div className="text-sm text-stone-700 font-medium">No clinical metrics yet</div>
                  <div className="text-xs text-stone-500 mt-1">Super-admin uploads monthly CSVs from <Link href="/admin/metrics" className="text-brand font-medium">/admin/metrics</Link>.</div>
                </section>
              ) : (
                (() => {
                  const byHospital = new Map<string, MetricsRow[]>();
                  for (const m of metrics) {
                    const list = byHospital.get(m.hospital_code) ?? [];
                    list.push(m);
                    byHospital.set(m.hospital_code, list);
                  }
                  return Array.from(byHospital.entries()).map(([code, list]) => {
                    const sorted = [...list].sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month));
                    const labels = sorted.map((m) => `${String(m.month).padStart(2, "0")}/${String(m.year).slice(2)}`);
                    const series = (key: keyof MetricsRow) =>
                      sorted.map((m, i) => ({ x: i, y: (m[key] as number | null) ?? null, label: labels[i] }));
                    const fmt = (n: number | null) => n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN");
                    return (
                      <section key={code} className="bg-white border border-stone-200 rounded-xl">
                        <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                          <h2 className="text-sm font-semibold">{code} <span className="text-[11px] text-stone-500 font-normal">· last {sorted.length} months</span></h2>
                        </div>
                        <div className="grid grid-cols-2 gap-3 px-5 py-4">
                          {[
                            { key: "opd_count" as const, label: "OPD visits", color: "#0f766e" },
                            { key: "ipd_admissions" as const, label: "IPD admissions", color: "#2563eb" },
                            { key: "ot_cases" as const, label: "OT cases", color: "#d97706" },
                            { key: "revenue_inr" as const, label: "Revenue (INR)", color: "#16a34a" },
                          ].map((m) => {
                            const last = sorted[sorted.length - 1];
                            const lastVal = last ? (last[m.key] as number | null) : null;
                            return (
                              <div key={m.key} className="bg-stone-50 rounded-lg p-3">
                                <div className="flex items-baseline justify-between mb-1.5">
                                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">{m.label}</div>
                                  <div className="text-sm font-semibold num">{fmt(lastVal)}</div>
                                </div>
                                <MiniLineChart points={series(m.key)} color={m.color} />
                              </div>
                            );
                          })}
                        </div>
                        <div className="border-t border-stone-100 px-5 py-3 max-h-[260px] overflow-y-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-stone-500 text-left">
                                <th className="py-1.5 font-medium">Month</th>
                                <th className="py-1.5 font-medium text-right">OPD</th>
                                <th className="py-1.5 font-medium text-right">IPD</th>
                                <th className="py-1.5 font-medium text-right">OT</th>
                                <th className="py-1.5 font-medium text-right">Revenue (INR)</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-stone-100">
                              {[...sorted].reverse().map((m, i) => (
                                <tr key={i}>
                                  <td className="py-1.5 num">{String(m.month).padStart(2, "0")}/{m.year}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.opd_count)}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.ipd_admissions)}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.ot_cases)}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.revenue_inr)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    );
                  });
                })()
              )}
            </div>
          )}


          {section === "oppe" && (
            <div className="space-y-4">
              <section className="bg-white border border-stone-200 rounded-xl">
                <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold">
                      OPPE reviews <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{oppeRows.length}</span>
                    </h2>
                    <div className="text-[11px] text-stone-500 mt-0.5">Ongoing Professional Practice Evaluation · auto-aggregated 6-month packets</div>
                  </div>
                  <a href="/guide#oppe" className="text-[11px] text-brand font-medium hover:underline shrink-0 ml-3">What is this? →</a>
                </div>
                {oppeRows.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-stone-500">
                    No OPPE reviews yet. The OPPE scheduler / Kickstart button on <a href="/admin" className="text-brand font-medium">/admin</a> populates these per engagement.
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {oppeRows.map((o) => {
                      const isOpen = o.status === "pending" || o.status === "in_review";
                      const pillCls = isOpen
                        ? "bg-amber-50 text-amber-800"
                        : o.status === "satisfactory"
                        ? "bg-emerald-50 text-emerald-700"
                        : o.status === "flagged"
                        ? "bg-amber-100 text-amber-900"
                        : o.status === "escalated_to_fppe"
                        ? "bg-red-50 text-red-700"
                        : "bg-stone-100 text-stone-700";
                      return (
                        <div key={o.id} className="px-5 py-4 flex items-start gap-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${pillCls}`}>
                            {o.status.replace(/_/g, " ")}
                          </span>
                          <div className="flex-1">
                            <div className="text-sm font-medium text-stone-900">{o.hospital_code} · {o.period_start} → {o.period_end}</div>
                            <div className="text-xs text-stone-500 mt-0.5">
                              {isOpen ? `Due ${o.due_at.slice(0, 10)}` : (o.completed_at ? `Closed ${o.completed_at.slice(0, 10)}${o.reviewer_name ? ` by ${o.reviewer_name}` : ""}` : "closed")}
                              {o.decision_notes && (
                                <span className="block text-stone-600 mt-1">{o.decision_notes}</span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => setOpenOppeId(o.id)}
                            className="px-3 py-1.5 rounded-md text-[12px] font-medium text-brand bg-brand/10 hover:bg-brand/20"
                          >
                            {isOpen ? "Sign off →" : "View packet"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          {section === "feedback" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  Feedback <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{incidentsList.length}</span>
                </h2>
                <Link href={`/incidents/new?target=${id}`} className="text-[12px] text-brand font-medium">+ Add feedback</Link>
              </div>
              <div className="px-5 py-2.5 border-b border-stone-100 flex flex-wrap items-center gap-1.5">
                {(([["all","All"],["positive","Positive"],["negative","Negative"]]) as [string,string][]).map(([v,l]) => (
                  <button key={v} type="button" onClick={() => setFbFilter((f) => ({ ...f, pol: v }))}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium border ${fbFilter.pol===v?"bg-stone-800 text-white border-stone-800":"bg-white text-stone-600 border-stone-200 hover:bg-stone-50"}`}>{l}</button>
                ))}
                <span className="w-px h-4 bg-stone-200 mx-1" />
                {(([["all","All sources"],["patient","Patient"],["peer","Peer"],["governance","Governance"]]) as [string,string][]).map(([v,l]) => (
                  <button key={v} type="button" onClick={() => setFbFilter((f) => ({ ...f, src: v }))}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium border ${fbFilter.src===v?"bg-brand text-white border-brand":"bg-white text-stone-600 border-stone-200 hover:bg-stone-50"}`}>{l}</button>
                ))}
              </div>
              {(() => {
                const filtered = incidentsList.filter((r) => (fbFilter.pol==="all"||r.polarity===fbFilter.pol) && (fbFilter.src==="all"||r.source===fbFilter.src));
                if (filtered.length===0) return <div className="px-5 py-12 text-center text-sm text-stone-500">No matching feedback.</div>;
                const sevPill: Record<string,string> = { low:"bg-stone-100 text-stone-700", medium:"bg-amber-50 text-amber-800", high:"bg-orange-50 text-orange-800", critical:"bg-red-50 text-red-800" };
                const statusPill: Record<string,string> = { open:"bg-emerald-50 text-emerald-700", closed:"bg-stone-100 text-stone-600", retracted:"bg-red-50 text-red-700" };
                const catLabel: Record<string,string> = { clinical:"Clinical", patient_safety:"Patient safety", medical_error:"Medical error", professionalism:"Professionalism", documentation:"Documentation", etiquette:"Etiquette", vendor_compliance:"Vendor compliance", other:"Other" };
                const srcLabel: Record<string,string> = { patient:"Patient", peer:"Peer", governance:"Governance" };
                return (
                  <div className="divide-y divide-stone-100">
                    {filtered.map((r) => {
                      const isRetracted = r.status === "retracted";
                      const isPos = r.polarity === "positive";
                      return (
                        <Link key={r.id} href={`/incidents/${r.id}`} className={`block px-5 py-4 hover:bg-stone-50 ${isRetracted?"opacity-70":""}`}>
                          <div className="flex items-start gap-1.5 flex-wrap">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${isPos?"bg-emerald-50 text-emerald-700":"bg-stone-800 text-white"}`}>{isPos?"Positive":"Negative"}</span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-violet-50 text-violet-700">{srcLabel[r.source] ?? r.source}</span>
                            {isPos
                              ? (r.commendation_category ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">{r.commendation_category}</span> : null)
                              : <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${sevPill[r.severity ?? ""] ?? "bg-stone-100 text-stone-700"}`}>{r.severity ?? "—"}</span>}
                            {!isPos && <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">{catLabel[r.category ?? ""] ?? r.category}</span>}
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${statusPill[r.status] ?? "bg-stone-100 text-stone-700"}`}>{r.status}</span>
                            {r.patient_rating != null && <span className="text-[11px] text-amber-700 px-2 py-0.5 rounded-full bg-amber-50">{"\u2605"} {r.patient_rating}/5</span>}
                          </div>
                          <div className="mt-1.5">
                            <div className={`text-sm font-medium ${isRetracted?"line-through text-stone-500":"text-stone-900"}`}>{r.anonymous_flag ? "Anonymous submission" : (r.submitter_label || "Submitter")}</div>
                            <div className="text-xs text-stone-500 mt-0.5 truncate">{r.narrative_preview}</div>
                            <div className="text-[11px] text-stone-400 mt-1">{timeAgo(r.submitted_at)}{r.reply_count>0?` · ${r.reply_count} ${r.reply_count===1?"reply":"replies"}`:""}{isRetracted&&r.retraction_reason?` · retracted: ${r.retraction_reason}`:""}</div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                );
              })()}
            </section>
          )}

          {section === "documentation" && id ? (
            <PhysicianDocumentationSection physicianId={id} />
          ) : null}

          {!["overview", "engagements", "qualifications", "metrics", "oppe", "feedback", "documentation"].includes(section) && (
            <div className="bg-white border border-stone-200 rounded-xl py-16 text-center">
              <div className="text-sm text-stone-500">This section ships in the next sprint.</div>
            </div>
          )}
        </div>
      </main>

      {addEng && (
        <AddEngagementModal
          physicianId={id!}
          defaultSpecialty={physician.primary_specialty}
          engagedHospitalCodes={engagements.filter((e) => e.status === "active").map((e) => e.hospital_code)}
          onClose={() => setAddEng(false)}
          onSaved={() => { setAddEng(false); load(); }}
        />
      )}

      {triggerFppe && physician && (
        <TriggerFppeModal
          physicianId={physician.id}
          physicianName={physician.full_name}
          hospitalOptions={Array.from(new Set(engagements.filter((e) => e.status === "active").map((e) => e.hospital_code))).map((code) => ({ code }))}
          onClose={() => setTriggerFppe(false)}
        />
      )}

      {openOppeId && (
        <OppeReviewModal
          oppeId={openOppeId}
          onClose={() => setOpenOppeId(null)}
          onSaved={() => { setOpenOppeId(null); load(); }}
        />
      )}

      {editPrivId && (() => {
        const pr = privs.find((p) => p.id === editPrivId);
        if (!pr || !physician) return null;
        return (
          <EditPrivilegeModal
            privilege={{
              id: pr.id,
              physician_id: physician.id,
              hospital_code: pr.hospital_code,
              procedure_or_specialty: pr.procedure_or_specialty,
              is_core: pr.is_core,
              expires_at: pr.expires_at,
              withdrawn_date: pr.withdrawn_date,
              withdrawn_reason: pr.withdrawn_reason,
            }}
            onClose={() => setEditPrivId(null)}
            onSaved={() => { setEditPrivId(null); load(); }}
          />
        );
      })()}

      {changeCatEngId && (() => {
        const eng = engagements.find((e) => e.id === changeCatEngId);
        if (!eng || !physician) return null;
        return (
          <ChangeCategoryModal
            engagement={{
              id: eng.id,
              physician_id: physician.id,
              hospital_code: eng.hospital_code,
              category: eng.category,
              start_date: eng.start_date,
            }}
            onClose={() => setChangeCatEngId(null)}
            onSaved={() => { setChangeCatEngId(null); load(); }}
          />
        );
      })()}
      {addQual && (
        <AddQualificationModal
          physicianId={id!}
          onClose={() => setAddQual(false)}
          onSaved={() => { setAddQual(false); load(); }}
        />
      )}
      {addPriv && (
        <AddPrivilegeModal
          physicianId={id!}
          defaultSpecialty={physician.primary_specialty}
          onClose={() => setAddPriv(false)}
          onSaved={() => { setAddPriv(false); load(); }}
        />
      )}
    </>
  );
}
