import Link from "next/link";
import { redirect } from "next/navigation";
import { neon } from "@neondatabase/serverless";
import { getCurrentUser } from "@/lib/auth";
import { getHospitalFilter, getHospitalFilterId } from "@/lib/hospital-filter";
import { TopNav } from "@/components/TopNav";
import MiniPhysicianDB from "@/components/MiniPhysicianDB";
import CensusCards from "@/components/CensusCards";
import InboxCard from "@/components/InboxCard";
import PendingVerificationsCard from "@/components/PendingVerificationsCard";
import PendingCredentialsKpi from "@/components/PendingCredentialsKpi";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

type Counts = { active_physicians: number; open_incidents: number; positive_feedback: number; pending_credentials: number };
type InboxRow = { id: string; polarity: string; category: string | null; commendation_category: string | null; severity: string | null; created_at: string; physician_name: string };
type AuditRow = { id: number; action: string; entity_type: string; entity_id: string | null; created_at: string; actor_email: string | null; actor_position: string | null };
type Spec = { specialty: string; vc: number; staff: number; total: number };
type Hosp = { code: string; name: string; vc: number; staff: number; total: number; specialties: Spec[] };

async function fetchData(hospitalId: string | null) {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = neon(url);

  const cRows = hospitalId
    ? (await sql`
        SELECT
          (SELECT count(DISTINCT pe.physician_id)::int FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
             WHERE pe.hospital_id=${hospitalId}::uuid AND pe.status='active' AND p.current_status='active') AS active_physicians,
          (SELECT count(*)::int FROM incidents WHERE status='open' AND polarity='negative' AND hospital_id=${hospitalId}::uuid) AS open_incidents,
          (SELECT count(*)::int FROM incidents WHERE polarity='positive' AND hospital_id=${hospitalId}::uuid) AS positive_feedback,
          (SELECT count(*)::int FROM qualifications WHERE verified=false) AS pending_credentials`) as Array<Counts>
    : (await sql`
        SELECT
          (SELECT count(*)::int FROM physicians WHERE current_status='active') AS active_physicians,
          (SELECT count(*)::int FROM incidents WHERE status='open' AND polarity='negative') AS open_incidents,
          (SELECT count(*)::int FROM incidents WHERE polarity='positive') AS positive_feedback,
          (SELECT count(*)::int FROM qualifications WHERE verified=false) AS pending_credentials`) as Array<Counts>;

  const iRows = hospitalId
    ? (await sql`
        SELECT i.id::text AS id, i.polarity, i.category, i.commendation_category, i.severity, i.created_at, p.full_name AS physician_name
        FROM incidents i JOIN physicians p ON p.id=i.target_physician_id
        WHERE ((i.status='open' AND i.polarity='negative') OR i.polarity='positive') AND i.hospital_id=${hospitalId}::uuid
        ORDER BY i.created_at DESC LIMIT 12`) as Array<InboxRow>
    : (await sql`
        SELECT i.id::text AS id, i.polarity, i.category, i.commendation_category, i.severity, i.created_at, p.full_name AS physician_name
        FROM incidents i JOIN physicians p ON p.id=i.target_physician_id
        WHERE ((i.status='open' AND i.polarity='negative') OR i.polarity='positive')
        ORDER BY i.created_at DESC LIMIT 12`) as Array<InboxRow>;

  const hospTotals = (hospitalId
    ? await sql`
        WITH base AS (SELECT pe.hospital_id, pe.physician_id, bool_or(pe.category='visiting_consultant') AS is_vc
          FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
          WHERE pe.status='active' AND p.current_status='active' AND pe.hospital_id=${hospitalId}::uuid GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, h.name, count(*) FILTER (WHERE base.is_vc)::int AS vc, count(*) FILTER (WHERE NOT base.is_vc)::int AS staff, count(*)::int AS total
        FROM base JOIN hospitals h ON h.id=base.hospital_id GROUP BY h.code, h.name ORDER BY h.name`
    : await sql`
        WITH base AS (SELECT pe.hospital_id, pe.physician_id, bool_or(pe.category='visiting_consultant') AS is_vc
          FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
          WHERE pe.status='active' AND p.current_status='active' GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, h.name, count(*) FILTER (WHERE base.is_vc)::int AS vc, count(*) FILTER (WHERE NOT base.is_vc)::int AS staff, count(*)::int AS total
        FROM base JOIN hospitals h ON h.id=base.hospital_id GROUP BY h.code, h.name ORDER BY h.name`) as Array<Omit<Hosp, "specialties">>;

  const specRows = (hospitalId
    ? await sql`
        WITH base AS (SELECT pe.hospital_id, pe.physician_id, bool_or(pe.category='visiting_consultant') AS is_vc,
            max(COALESCE(NULLIF(trim(p.primary_specialty),''),'Unspecified')) AS specialty
          FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
          WHERE pe.status='active' AND p.current_status='active' AND pe.hospital_id=${hospitalId}::uuid GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, base.specialty, count(*) FILTER (WHERE is_vc)::int AS vc, count(*) FILTER (WHERE NOT is_vc)::int AS staff, count(*)::int AS total
        FROM base JOIN hospitals h ON h.id=base.hospital_id GROUP BY h.code, base.specialty ORDER BY total DESC, base.specialty`
    : await sql`
        WITH base AS (SELECT pe.hospital_id, pe.physician_id, bool_or(pe.category='visiting_consultant') AS is_vc,
            max(COALESCE(NULLIF(trim(p.primary_specialty),''),'Unspecified')) AS specialty
          FROM physician_engagements pe JOIN physicians p ON p.id=pe.physician_id
          WHERE pe.status='active' AND p.current_status='active' GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, base.specialty, count(*) FILTER (WHERE is_vc)::int AS vc, count(*) FILTER (WHERE NOT is_vc)::int AS staff, count(*)::int AS total
        FROM base JOIN hospitals h ON h.id=base.hospital_id GROUP BY h.code, base.specialty ORDER BY total DESC, base.specialty`) as Array<{ code: string; specialty: string; vc: number; staff: number; total: number }>;

  const byCode = new Map<string, Spec[]>();
  for (const r of specRows) { if (!byCode.has(r.code)) byCode.set(r.code, []); byCode.get(r.code)!.push({ specialty: r.specialty, vc: r.vc, staff: r.staff, total: r.total }); }
  const byHospital: Hosp[] = hospTotals.map((h) => ({ ...h, specialties: byCode.get(h.code) ?? [] }));
  const specialtiesCount = new Set(specRows.map((r) => r.specialty)).size;

  const aRows = (await sql`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at, p.email AS actor_email, pos.position_name AS actor_position
    FROM audit_log_v2 a LEFT JOIN profiles p ON p.id=a.actor_user_id LEFT JOIN positions pos ON pos.id=p.position_id
    ORDER BY a.created_at DESC LIMIT 20`) as Array<AuditRow>;

  return { counts: cRows[0], inbox: iRows, byHospital, hospitalsCount: byHospital.length, specialtiesCount, audit: aRows };
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function actionColor(a: string) {
  if (a === "delete" || a === "retract") return "text-red-700";
  if (a === "update") return "text-blue-700";
  return "text-emerald-700";
}

export default async function HomePage() {
  // R2 (PRD v1.4 §4.2): with the v2 shell on, the governance home is the Overview signal board.
  if (process.env.NEXT_PUBLIC_UI_V2 === "1") redirect("/overview");

  const user = await getCurrentUser();
  if (!user) return null;
  const filterCode = await getHospitalFilter();
  const filterId = await getHospitalFilterId();
  const data = await fetchData(filterId);

  const counts = data?.counts ?? { active_physicians: 0, open_incidents: 0, positive_feedback: 0, pending_credentials: 0 };
  const byHospital = data?.byHospital ?? [];
  const hospitalsCount = data?.hospitalsCount ?? 0;
  const specialtiesCount = data?.specialtiesCount ?? 0;
  const audit = data?.audit ?? [];
  const canVerify = !!(user.is_super_admin || user.is_hr || user.is_site_medical_head);

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const HONORIFICS = new Set(["dr.", "dr", "prof.", "prof", "mr.", "mr", "ms.", "ms", "mrs.", "mrs"]);
  function firstNameFrom(fn: string): string { const toks = fn.trim().split(/\s+/); let i = 0; while (i < toks.length - 1 && HONORIFICS.has(toks[i].toLowerCase())) i++; return toks[i] ?? fn; }
  const firstName = firstNameFrom(user.full_name);

  const Kpi = ({ label, value, sub }: { label: string; value: React.ReactNode; sub: React.ReactNode }) => (
    <div className="bg-white border border-stone-200 rounded-xl p-4">
      <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">{label}</div>
      <div className="text-3xl font-semibold num mt-1.5">{value}</div>
      <div className="text-[11px] text-stone-500 mt-0.5">{sub}</div>
    </div>
  );

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-tight">Good morning, {firstName}</h1>
          <div className="text-sm text-stone-500 mt-1">
            {today}{user.is_super_admin ? " · Super Admin" : ""}
            {user.position_label && user.position_label !== "Hospital PM" ? ` · ${user.position_label}` : (!user.is_super_admin ? ` · ${user.position_label}` : "")}
            {" · viewing "}{filterCode === "all" ? "all hospitals" : filterCode}
          </div>
        </div>

        {/* KPI strip — 5 even cards */}
        <div className="grid grid-cols-5 gap-3 mb-4">
          <Kpi label="Active physicians" value={counts.active_physicians} sub="in network" />
          <Kpi label="Open concerns" value={counts.open_incidents} sub={<><span className="text-emerald-700 font-medium">{counts.positive_feedback} positive</span>{" · "}<Link href="/incidents" className="text-brand hover:underline">Feedback inbox →</Link></>} />
          <PendingCredentialsKpi initial={counts.pending_credentials} />
          <Kpi label="Hospitals" value={hospitalsCount} sub="with active doctors" />
          <Kpi label="Specialties" value={specialtiesCount} sub={filterCode === "all" ? "across network" : filterCode} />
        </div>

        {/* Row 1 — Physician DB + Census (equal) */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <MiniPhysicianDB />
          <CensusCards byHospital={byHospital} />
        </div>

        {/* Row 2 — Inbox + Audit (equal halves) */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <InboxCard openCount={counts.open_incidents} positiveCount={counts.positive_feedback} />

          <section className="bg-white border border-stone-200 rounded-xl flex flex-col h-[300px]">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-stone-100 shrink-0">
              <h2 className="text-sm font-semibold">Audit feed</h2>
              <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">{audit.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {audit.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-stone-500">No audit entries yet.</div>
              ) : (
                <div className="px-4 py-2 mono text-[11px] text-stone-700">
                  {audit.map((r) => (
                    <div key={r.id} className="py-1.5 border-b border-dashed border-stone-100 last:border-b-0 leading-relaxed">
                      <div className="text-stone-400 text-[10px]">{timeAgo(r.created_at)}</div>
                      <div>{r.actor_email ?? "—"}{r.actor_position ? ` · ${r.actor_position}` : ""}</div>
                      <div className={actionColor(r.action)}>{r.action} {r.entity_type}{r.entity_id ? ` (${r.entity_id})` : ""}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Credentials pending verification — surfaces portal-uploaded docs awaiting review */}
        <div className="mb-4">
          <PendingVerificationsCard canVerify={canVerify} />
        </div>

        {/* Slim Watchlist strip */}
        <section id="watchlist" className="bg-white border border-stone-200 rounded-xl px-5 py-3 flex items-center justify-between scroll-mt-20">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-semibold">Watchlist</h2>
            <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">0</span>
            <span className="text-[12px] text-stone-400 truncate">No tier moves yet — surgeons appear here when Surgical Governance data lands.</span>
          </div>
          <Link href="/surgical-governance" className="text-[12px] text-brand font-medium shrink-0 ml-3">Open Surgical Governance →</Link>
        </section>
      </main>
    </>
  );
}
