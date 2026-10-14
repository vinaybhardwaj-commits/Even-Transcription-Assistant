import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { OverviewModules } from "@/components/overview/OverviewModules";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { buildOverviewModel, type IrisCounts } from "@/lib/overview-modules";
import { loadStage2Counts } from "@/lib/stage2-counts";
import {
  getSeries,
  latestSnapshot,
  computeAges,
  computeResolved,
  computeMovers,
  signalKey,
  getIncidentSeries,
  computeClusterSignals,
  type SnapshotRow,
} from "@/lib/gov-signals";

export const dynamic = "force-dynamic";

/**
 * Overview — programme home (Sprint 2.1) plus the continuous signal board
 * (PRD v1.4-LOCKED §4.2). Tiles use live counts. Document Audits and RMO stay
 * proposed. /home redirects here while UI_V2 is on.
 */

interface PendingQual {
  id: string;
  degree: string | null;
  year_completed: number | null;
  physician_id: string;
  full_name: string;
  created_at: string;
}
interface Expiry {
  id: string;
  full_name: string;
  kind: string;
  expires_on: string;
  days_left: number;
}
interface NegIncident {
  id: string;
  full_name: string;
  category: string | null;
  severity: string | null;
  submitted_at: string;
}

function ageBadge(days: number, regressed: boolean) {
  const label =
    days < 1 ? "new" : days < 14 ? `active ${days}d` : `active ${Math.round(days / 7)} wks`;
  return (
    <span
      className={
        "shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-bold " +
        (regressed
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-violet-200 bg-violet-50 text-violet-700")
      }
    >
      {regressed ? `back · ${label}` : label}
    </span>
  );
}

async function incidentStats(): Promise<IrisCounts> {
  const none: IrisCounts = { open: null, total: null, highSev: null, withRca: null, overdue: null };
  const base = process.env.INCIDENT_API_BASE;
  const tok = process.env.INCIDENT_API_TOKEN;
  if (!base || !tok) return none;
  try {
    const res = await fetch(`${base}/api/office/stats`, {
      headers: { Authorization: `Bearer ${tok}` },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return none;
    // Shape verified live 2 Jul: { ok, totals: { total, open, near_miss, high_sev, with_rca }, ... }
    const j = (await res.json()) as {
      totals?: { total?: number; open?: number; high_sev?: number; with_rca?: number; overdue?: number };
    };
    const num = (value: unknown) => (typeof value === "number" ? value : null);
    return {
      open: num(j.totals?.open),
      total: num(j.totals?.total),
      highSev: num(j.totals?.high_sev),
      withRca: num(j.totals?.with_rca),
      overdue: num(j.totals?.overdue),
    };
  } catch {
    return none;
  }
}

/**
 * M&M aggregates for the tile + queue. Copies incidentStats() exactly: explicit
 * 4s timeout, no-store, every error swallowed to nulls so an unreachable module
 * degrades the tile rather than the board. Carries no patient identifiers (A3).
 */
async function mmStats(): Promise<{
  open: number | null;
  inReview: number | null;
  gapsOpen: number | null;
  queue: Array<{ id: string; title: string; updated_at: string }>;
}> {
  const base = process.env.INCIDENT_API_BASE;
  const tok = process.env.INCIDENT_API_TOKEN;
  const none = { open: null, inReview: null, gapsOpen: null, queue: [] };
  if (!base || !tok) return none;
  try {
    const res = await fetch(`${base}/api/mm/stats`, {
      headers: { Authorization: `Bearer ${tok}` },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return none;
    const j = (await res.json()) as {
      ok?: boolean;
      totals?: { open?: number; in_review?: number; gaps_open?: number };
      in_review?: Array<{ id: string; title: string; updated_at: string }>;
    };
    if (j.ok === false) return none;
    return {
      open: typeof j.totals?.open === "number" ? j.totals.open : null,
      inReview: typeof j.totals?.in_review === "number" ? j.totals.in_review : null,
      gapsOpen: typeof j.totals?.gaps_open === "number" ? j.totals.gaps_open : null,
      queue: Array.isArray(j.in_review) ? j.in_review.slice(0, 3) : [],
    };
  } catch {
    return none;
  }
}

function ageDays(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const d = Math.floor(ms / 86400000);
  return d < 1 ? "today" : `${d}d`;
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: { window?: string };
}) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") redirect("/auth/login");

  const windowDays = [7, 30, 90].includes(Number(searchParams.window))
    ? Number(searchParams.window)
    : 30;

  let series: SnapshotRow[] = [];
  try {
    series = await getSeries(90);
  } catch {
    series = [];
  }
  const latest = latestSnapshot(series);
  const signals = latest?.payload.report?.signals ?? [];
  const healthy = latest?.payload.report?.healthy ?? [];
  const ages = computeAges(series);
  const resolved = computeResolved(series);
  const movers = computeMovers(series, windowDays);
  let clusterSignals: ReturnType<typeof computeClusterSignals> = [];
  try {
    clusterSignals = computeClusterSignals(await getIncidentSeries(90)).slice(0, 4);
  } catch {
    clusterSignals = [];
  }

  const pendingQuals = (await sql`
    SELECT q.id, q.degree, q.year_completed, q.created_at, p.id AS physician_id, p.full_name
    FROM qualifications q JOIN physicians p ON p.id = q.physician_id
    WHERE q.verified = false ORDER BY q.created_at ASC LIMIT 5`) as unknown as PendingQual[];

  const expiries = (await sql`
    SELECT * FROM (
      SELECT id, full_name, 'Registration' AS kind, registration_expiry AS expires_on,
             (registration_expiry - current_date)::int AS days_left
      FROM physicians WHERE current_status='active' AND registration_expiry IS NOT NULL
        AND registration_expiry BETWEEN current_date AND current_date + 30
      UNION ALL
      SELECT id, full_name, 'Indemnity' AS kind, indemnity_expiry AS expires_on,
             (indemnity_expiry - current_date)::int AS days_left
      FROM physicians WHERE current_status='active' AND indemnity_expiry IS NOT NULL
        AND indemnity_expiry BETWEEN current_date AND current_date + 30
    ) e ORDER BY days_left ASC LIMIT 6`) as unknown as Expiry[];

  const negIncidents = (await sql`
    SELECT i.id, p.full_name, i.category, i.severity, i.submitted_at
    FROM incidents i JOIN physicians p ON p.id = i.target_physician_id
    WHERE i.status='open' AND i.polarity='negative'
    ORDER BY i.submitted_at DESC LIMIT 3`) as unknown as NegIncident[];

  const inc = await incidentStats();

  // M&M is SGC/super-only (decision 13) — don't surface its counts, or fetch
  // them, for users who cannot open the module.
  const showMm = user.is_super_admin || user.is_sgc_member;
  const mm = showMm ? await mmStats() : { open: null, inReview: null, gapsOpen: null, queue: [] };
  const stage2 = await loadStage2Counts();
  const overviewModel = buildOverviewModel(stage2, inc, {
    canOpenElo: user.is_super_admin,
    canOpenSafety: showMm,
  });

  const canVerify = user.is_super_admin || user.is_hr || user.is_site_medical_head;

  return (
    <AppShell>
      <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-8">
        <OverviewModules model={overviewModel} />

        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-stone-800">Ongoing signals</h2>
            <p className="mt-0.5 text-[12.5px] text-stone-500">
              {latest
                ? `OPD audit data through ${latest.day}${overviewModel.opd.stale ? " · snapshot labeled Stale on the tiles above" : ""}`
                : stage2?.opdLastDay
                  ? `Last stored OPD snapshot is ${stage2.opdLastDay}, outside this 90-day window · labeled Stale. No act-now volume is invented from it.`
                  : "No OPD snapshot stored"}
              {latest?.payload.engine ? ` · ${latest.payload.engine}` : ""}
            </p>
          </div>
          <div className="flex overflow-hidden rounded-lg border border-stone-200 bg-white text-[12.5px] font-semibold">
            {[7, 30, 90].map((w) => (
              <Link
                key={w}
                href={`/overview?window=${w}`}
                className={
                  "px-3.5 py-1.5 " +
                  (w === windowDays ? "bg-brand-softer text-brand" : "text-stone-500 hover:bg-stone-50")
                }
              >
                {w}d
              </Link>
            ))}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          {/* Active signals */}
          <section className="min-w-0 rounded-xl border border-stone-200 bg-white p-5">
            <h2 className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-400">
              Active signals — ranked by severity × persistence
            </h2>
            {signals.length > 0 && latest?.payload.advisory && (
              <p className="mb-3 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-[11.5px] leading-snug text-sky-900">
                {latest.payload.advisory}
              </p>
            )}
            {latest ? (
              <div className="divide-y divide-stone-100">
                {signals.map((s) => (
                  <div key={signalKey(s)} className="flex items-start gap-3 py-3">
                    <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (s.severity === "act_now" ? "bg-rose-600" : "bg-amber-500")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
                        {s.kind === "domain" ? "OPD domain" : "Documentation"} · {s.label}{" "}
                        <span className="num">
                          {typeof s.mean === "number"
                            ? s.mean.toFixed(1)
                            : typeof s.value === "number"
                              ? `${s.value}${s.unit === "per_100_notes" ? "/100 notes" : ""}`
                              : ""}
                        </span>
                        <span className={"text-[12px] font-bold " + (s.trend === "worsening" ? "text-rose-600" : s.trend === "improving" ? "text-emerald-600" : "text-stone-400")}>
                          {s.trend === "worsening" ? `▼${Math.abs(s.delta ?? 0).toFixed(1)}` : s.trend === "improving" ? `▲${Math.abs(s.delta ?? 0).toFixed(1)}` : "—"}
                        </span>
                        <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">{s.scope}</span>
                      </div>
                      {s.action && <div className="mt-0.5 truncate text-[12.5px] text-stone-500">{s.action}</div>}
                      {typeof s.affected_share === "number" && s.eligible_doctors ? (
                        <div className="mt-0.5 text-[11.5px] text-stone-400">
                          {Math.round(s.affected_share * 100)}% of {s.eligible_doctors} eligible doctors
                        </div>
                      ) : null}
                    </div>
                    {ages[signalKey(s)] && ageBadge(ages[signalKey(s)].ageDays, ages[signalKey(s)].regressed)}
                  </div>
                ))}
                {clusterSignals.map((c) => (
                  <Link key={c.id} href="/safety" className="flex items-start gap-3 py-3 hover:bg-brand-softer">
                    <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + ((c.risk_score ?? 0) >= 10 ? "bg-rose-600" : "bg-amber-500")} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-semibold">
                        Incident · {c.label} — recurring
                        {typeof c.countDelta30d === "number" && c.countDelta30d > 0 ? (
                          <span className="ml-1.5 text-[12px] font-bold text-rose-600">▲ +{c.countDelta30d} in 30d</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[12.5px] text-stone-500">
                        risk {c.risk_score ?? "—"} · {c.rca_count}/{c.member_count} with RCA · last {c.last_seen ? String(c.last_seen).slice(0, 10) : "—"}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10.5px] font-bold text-rose-700">×{c.recurrence_count}</span>
                  </Link>
                ))}
                {expiries.slice(0, 2).map((e) => (
                  <div key={`${e.id}-${e.kind}`} className="flex items-start gap-3 py-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-semibold">
                        Credentialing · {e.kind} expiring — <Link href={`/physicians/${e.id}`} className="text-brand hover:underline">{e.full_name}</Link>
                      </div>
                      <div className="mt-0.5 text-[12.5px] text-stone-500">{e.days_left} days remaining</div>
                    </div>
                  </div>
                ))}
                {signals.length === 0 && clusterSignals.length === 0 && expiries.length === 0 && (
                  <p className="py-6 text-center text-sm text-stone-400">No active signals — a good stretch. ✓</p>
                )}
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-stone-400">
                {stage2?.opdLastDay
                  ? `Last OPD snapshot ${stage2.opdLastDay} is outside this window and is labeled Stale. No act-now volume is invented from it.`
                  : "No OPD snapshots yet — the 06:00 IST cron (or a backfill run) populates this board."}
              </p>
            )}
            {(movers.improving.length > 0 || movers.worsening.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border border-stone-100 bg-stone-50 px-3 py-2 text-[12px]">
                {movers.improving.length > 0 && (
                  <span className="text-emerald-700">
                    ▲ Improving: {movers.improving.map((m) => `${m.label} +${m.delta.toFixed(1)}`).join(" · ")}
                  </span>
                )}
                {movers.worsening.length > 0 && (
                  <span className="text-rose-700">
                    ▼ Worsening: {movers.worsening.map((m) => `${m.label} ${m.delta.toFixed(1)}`).join(" · ")}
                  </span>
                )}
              </div>
            )}
          </section>

          {/* Open work */}
          <section className="min-w-0 rounded-xl border border-stone-200 bg-white p-5">
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-400">
              Open work — governance queue
            </h2>
            <div className="divide-y divide-stone-100">
              {canVerify &&
                pendingQuals.map((q) => (
                  <Link key={q.id} href={`/physicians/${q.physician_id}`} className="flex items-center gap-3 py-2.5 hover:bg-brand-softer">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">
                        Verify {q.degree || "qualification"} — {q.full_name}
                      </div>
                      <div className="text-[11.5px] text-stone-400">uploaded via portal</div>
                    </div>
                  </Link>
                ))}
              {expiries.map((e) => (
                <Link key={`w-${e.id}-${e.kind}`} href={`/physicians/${e.id}`} className="flex items-center gap-3 py-2.5 hover:bg-brand-softer">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">
                      {e.kind} nudge — {e.full_name}
                    </div>
                    <div className="text-[11.5px] text-stone-400">{e.days_left}d left</div>
                  </div>
                </Link>
              ))}
              {negIncidents.map((i) => (
                <Link key={i.id} href={`/incidents/${i.id}`} className="flex items-center gap-3 py-2.5 hover:bg-brand-softer">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">Open feedback — {i.full_name}</div>
                    <div className="text-[11.5px] text-stone-400">
                      {i.category || "uncategorised"} · {i.severity || "unrated"}
                    </div>
                  </div>
                </Link>
              ))}
              {/* M&M rows show status only — never findings or patient identifiers. */}
              {mm.queue.map((m) => (
                <Link key={m.id} href={`/mm/cases/${m.id}`} className="flex items-center gap-3 py-2.5 hover:bg-brand-softer">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-violet-500" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">
                      Case {m.id} awaiting reviewer disposition
                    </div>
                    <div className="text-[11.5px] text-stone-400">M&amp;M · presenting clinician · {ageDays(m.updated_at)}</div>
                  </div>
                </Link>
              ))}
              {!canVerify && pendingQuals.length === 0 && expiries.length === 0 && negIncidents.length === 0 && mm.queue.length === 0 && (
                <p className="py-6 text-center text-sm text-stone-400">Queue is clear. ✓</p>
              )}
            </div>
          </section>
        </div>

        {/* Healthy strip */}
        <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-[12.5px] text-emerald-900">
          ✓ Currently healthy —{" "}
          {healthy.length > 0
            ? healthy.map((h) => `${h.label} ${h.mean.toFixed(1)}`).join(" · ")
            : "no healthy-attribute data yet"}
          {expiries.length === 0 ? " · no credential expiries in 30d" : ""}
          {resolved.length > 0 ? ` · resolved recently: ${resolved.map((r) => r.label).join(", ")}` : ""}
        </div>

        {/* Watchlist strip (sidebar anchor) */}
        <section id="watchlist" className="mt-4 flex scroll-mt-20 items-center justify-between rounded-xl border border-stone-200 bg-white px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-sm font-semibold">Watchlist</h2>
            <span className="truncate text-[12px] text-stone-400">
              Physicians under active governance attention — tier moves land here from Surgical Governance.
            </span>
          </div>
          <Link href="/physicians" className="ml-3 shrink-0 text-[12px] font-medium text-brand">
            Open roster →
          </Link>
        </section>
      </main>
    </AppShell>
  );
}
