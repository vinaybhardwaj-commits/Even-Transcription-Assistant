import Link from "next/link";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { AdminShell } from "@/components/AdminShell";
import { MIGRATIONS } from "@/lib/migrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Counts {
  vcs_active: number;
  vcs_total: number;
  cases_total: number;
  observations_total: number;
  snapshots_total: number;
  audit_log_total: number;
  current_weights: { caseload_pct: number; outcomes_pct: number; adherence_pct: number } | null;
  migrations_applied: number;
  migrations_pending: number;
}

async function getCounts(): Promise<Counts | { error: string }> {
  noStore();
  try {
    const [vcs, cases, obs, snaps, audit, weights, migrations] = await Promise.all([
      sql`SELECT
        COUNT(*) FILTER (WHERE status='active')::int AS active,
        COUNT(*)::int AS total
        FROM vcs`,
      sql`SELECT COUNT(*)::int AS total FROM surgical_cases`,
      sql`SELECT COUNT(*)::int AS total FROM case_observations WHERE is_current = true`,
      sql`SELECT COUNT(*)::int AS total FROM score_snapshots`,
      sql`SELECT COUNT(*)::int AS total FROM audit_log`,
      sql`SELECT caseload_pct, outcomes_pct, adherence_pct FROM weight_versions WHERE is_current = true LIMIT 1`,
      sql`SELECT COUNT(*)::int AS total FROM _migrations`,
    ]);

    const v = (vcs as Array<{ active: number; total: number }>)[0];
    const c = (cases as Array<{ total: number }>)[0];
    const o = (obs as Array<{ total: number }>)[0];
    const s = (snaps as Array<{ total: number }>)[0];
    const a = (audit as Array<{ total: number }>)[0];
    const w = (weights as Array<{ caseload_pct: number; outcomes_pct: number; adherence_pct: number }>)[0];
    const m = (migrations as Array<{ total: number }>)[0];

    return {
      vcs_active: v?.active ?? 0,
      vcs_total: v?.total ?? 0,
      cases_total: c?.total ?? 0,
      observations_total: o?.total ?? 0,
      snapshots_total: s?.total ?? 0,
      audit_log_total: a?.total ?? 0,
      current_weights: w ?? null,
      migrations_applied: m?.total ?? 0,
      migrations_pending: MIGRATIONS.length - (m?.total ?? 0),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function AdminDashboardPage() {
  const result = await getCounts();
  const errored = "error" in result;
  const counts = errored ? null : result;

  return (
    <AdminShell
      breadcrumbs={[{ label: "Admin" }]}
      title="Admin"
      subtitle="System state at a glance · Manage VCs, positions, weights, and audit"
    >
      {errored && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 mb-6">
          <div className="text-sm font-medium text-red-900">Database not reachable</div>
          <div className="text-xs text-red-700 mt-1 font-mono">{(result as { error: string }).error}</div>
          <div className="text-sm text-red-800 mt-3">
            If this is the first deploy after initial setup, apply migrations:{" "}
            <code className="font-mono text-xs bg-white px-2 py-0.5 rounded border border-red-200">
              POST /api/admin/migrate
            </code>
          </div>
        </div>
      )}

      {counts && (
        <>
          <div className="grid grid-cols-4 gap-4 mb-6">
            <StatCard label="Visiting Consultants" value={counts.vcs_active} caption={`${counts.vcs_total} total`} href="/surgical-governance/admin/vcs" />
            <StatCard label="Surgical cases" value={counts.cases_total} caption="across all status" />
            <StatCard label="Observations" value={counts.observations_total} caption="current (live)" />
            <StatCard label="Audit entries" value={counts.audit_log_total} caption="all time" href="/surgical-governance/admin/audit" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="card p-5 bg-white border border-stone-200 rounded-xl">
              <div className="text-xs font-medium tracking-wider uppercase text-stone-500 mb-3">
                Composite weights
              </div>
              {counts.current_weights ? (
                <div className="flex items-baseline gap-3 num">
                  <span className="text-3xl font-semibold tabular-nums">
                    {counts.current_weights.caseload_pct}
                  </span>
                  <span className="text-stone-300">/</span>
                  <span className="text-3xl font-semibold tabular-nums">
                    {counts.current_weights.outcomes_pct}
                  </span>
                  <span className="text-stone-300">/</span>
                  <span className="text-3xl font-semibold tabular-nums">
                    {counts.current_weights.adherence_pct}
                  </span>
                  <span className="text-xs text-stone-500 ml-3">
                    Caseload / Outcomes / Adherence
                  </span>
                </div>
              ) : (
                <div className="text-sm text-stone-500">No weight version set</div>
              )}
              <Link
                href="/surgical-governance/admin/weights"
                className="text-xs text-brand hover:underline mt-3 inline-block"
              >
                Adjust weights → (ships soon)
              </Link>
            </div>

            <div className="card p-5 bg-white border border-stone-200 rounded-xl">
              <div className="text-xs font-medium tracking-wider uppercase text-stone-500 mb-3">
                Migrations
              </div>
              <div className="flex items-baseline gap-3 num">
                <span className="text-3xl font-semibold tabular-nums">
                  {counts.migrations_applied}
                </span>
                <span className="text-sm text-stone-500">
                  of {MIGRATIONS.length} applied
                </span>
              </div>
              <div className="text-xs text-stone-500 mt-2">
                {counts.migrations_pending === 0
                  ? "✓ Schema up to date"
                  : `${counts.migrations_pending} pending — POST /api/admin/migrate`}
              </div>
            </div>
          </div>

          <div className="mt-8">
            <div className="text-xs font-medium tracking-wider uppercase text-stone-500 mb-3">
              Quick links
            </div>
            <div className="grid grid-cols-3 gap-3">
              <QuickLink href="/surgical-governance/admin/vcs" title="VC roster" desc="Add, edit, suspend Visiting Consultants" />
              <QuickLink href="/surgical-governance/admin/positions" title="Positions" desc="9 stamping roles for audit defensibility" />
              <QuickLink href="/surgical-governance/admin/audit" title="Audit log" desc="Append-only record (ships soon)" />
            </div>
          </div>
        </>
      )}
    </AdminShell>
  );
}

function StatCard({
  label,
  value,
  caption,
  href,
}: {
  label: string;
  value: number;
  caption: string;
  href?: string;
}) {
  const inner = (
    <div className="card p-5 bg-white border border-stone-200 rounded-xl hover:border-stone-300 transition">
      <div className="text-xs font-medium tracking-wider uppercase text-stone-500">{label}</div>
      <div className="num text-3xl font-semibold tabular-nums mt-2">{value}</div>
      <div className="text-xs text-stone-500 mt-1">{caption}</div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

function QuickLink({
  href,
  title,
  desc,
}: {
  href: string;
  title: string;
  desc: string;
}) {
  return (
    <Link
      href={href}
      className="card p-4 bg-white border border-stone-200 rounded-xl hover:border-brand transition block"
    >
      <div className="font-medium text-sm">{title}</div>
      <div className="text-xs text-stone-500 mt-1">{desc}</div>
    </Link>
  );
}
