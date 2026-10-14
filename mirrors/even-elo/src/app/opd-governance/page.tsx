import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { loadPendingRulings } from "@/lib/audit-ruling";
import { actionLabel } from "@/lib/audit-findings";
import {
  fetchOpdSignals,
  getSeries,
  latestSnapshot,
  computeAges,
  computeResolved,
  attrMeans,
  signalKey,
  type OpdSignal,
  type OpdSignalsPayload,
  type SnapshotRow,
} from "@/lib/gov-signals";

export const dynamic = "force-dynamic";

/**
 * OPD Governance (PRD v1.4-LOCKED §6, R3) — consumes CDMSS Governance Signals
 * API v1.1 (+v1.1b domain signals). Live fetch for the selected window;
 * snapshot store supplies aging, resolution and the trend chart.
 * Framing rules (§6.7) are contractual: advisory always, verbatim actions,
 * supportive non-punitive naming.
 */

interface InterventionRow {
  id: string;
  signal_key: string;
  signal_label: string | null;
  kind: string;
  note: string | null;
  done_on: string;
  actor_email: string | null;
  full_name: string | null;
}
interface CaptureGap {
  id: string;
  title: string;
  attr: string;
  status: string;
  baseline_mean: number | null;
  shipped_at: string | null;
}

const KIND_LABEL: Record<string, string> = {
  huddle_briefing: "Huddle briefing",
  supportive_1to1: "Supportive 1:1",
  spot_audit: "Spot audit",
  emr_ask: "EMR team ask",
  other: "Other",
};

function sevChip(sev: string, estimate?: boolean) {
  if (estimate)
    return "border border-dashed border-amber-300 bg-amber-50 text-amber-700";
  return sev === "act_now" ? "bg-rose-50 text-rose-700 border border-rose-200" : "bg-amber-50 text-amber-700 border border-amber-200";
}

function fmtVal(s: OpdSignal): string {
  if (typeof s.mean === "number") return `${s.mean.toFixed(1)} /5`;
  if (typeof s.value === "number")
    return `${s.value}${s.unit === "per_100_notes" ? " /100 notes" : s.unit === "pct" ? "%" : s.unit === "score" ? " score" : ""}`;
  return "";
}

function TrendChart({
  series,
  interventions,
}: {
  series: SnapshotRow[];
  interventions: InterventionRow[];
}) {
  const rows = series.filter((r) => (r.payload.notes_assessed ?? 0) > 0);
  if (rows.length < 2)
    return <p className="py-4 text-center text-sm text-stone-400">Trend chart appears once ≥2 audited days are in the snapshot store.</p>;
  const attrs = new Map<string, { label: string; pts: Array<{ i: number; mean: number }> }>();
  rows.forEach((row, i) => {
    for (const [attr, v] of Object.entries(attrMeans(row))) {
      if (!attrs.has(attr)) attrs.set(attr, { label: v.label, pts: [] });
      attrs.get(attr)!.pts.push({ i, mean: v.mean });
    }
  });
  const genChanges: number[] = [];
  rows.forEach((row, i) => {
    if (i > 0 && row.generator !== rows[i - 1].generator) genChanges.push(i);
  });
  const ivByDay = new Map<number, number>();
  for (const iv of interventions) {
    const idx = rows.findIndex((r) => r.day === iv.done_on);
    if (idx >= 0) ivByDay.set(idx, (ivByDay.get(idx) ?? 0) + 1);
  }
  const W = 860;
  const H = 230;
  const PL = 30;
  const PB = 24;
  const x = (i: number) => PL + (i * (W - PL - 10)) / (rows.length - 1);
  const y = (m: number) => 8 + (5 - m) * ((H - PB - 8) / 4);
  const palette = ["#0f766e", "#e11d48", "#d97706", "#2563eb", "#7c3aed", "#059669", "#db2777", "#64748b", "#b45309"];
  const entries = Array.from(attrs.entries());
  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="min-w-[640px]">
        {[1, 2, 3, 4, 5].map((m) => (
          <g key={m}>
            <line x1={PL} y1={y(m)} x2={W - 10} y2={y(m)} stroke="#f1f5f9" />
            <text x={PL - 6} y={y(m) + 3} fontSize="9" fill="#94a3b8" textAnchor="end">{m}</text>
          </g>
        ))}
        <line x1={PL} y1={y(2.5)} x2={W - 10} y2={y(2.5)} stroke="#e11d48" strokeDasharray="4 3" opacity="0.5" />
        <line x1={PL} y1={y(3.5)} x2={W - 10} y2={y(3.5)} stroke="#d97706" strokeDasharray="4 3" opacity="0.5" />
        {genChanges.map((i) => (
          <g key={`g${i}`}>
            <line x1={x(i)} y1={6} x2={x(i)} y2={H - PB} stroke="#7c3aed" strokeDasharray="2 3" opacity="0.6" />
            <text x={x(i) + 3} y={12} fontSize="8" fill="#7c3aed">{rows[i].generator}</text>
          </g>
        ))}
        {Array.from(ivByDay.entries()).map(([i, n]) => (
          <g key={`iv${i}`}>
            <rect x={x(i) - 4} y={H - PB - 10} width={8} height={8} transform={`rotate(45 ${x(i)} ${H - PB - 6})`} fill="#0f766e" />
            {n > 1 && <text x={x(i) + 6} y={H - PB - 8} fontSize="8" fill="#0f766e">×{n}</text>}
          </g>
        ))}
        {entries.map(([attr, a], ai) => (
          <polyline
            key={attr}
            points={a.pts.map((p) => `${x(p.i)},${y(p.mean)}`).join(" ")}
            fill="none"
            stroke={palette[ai % palette.length]}
            strokeWidth="1.8"
            opacity="0.9"
          />
        ))}
        {rows.map((r, i) => (
          <text key={r.day} x={x(i)} y={H - 8} fontSize="8.5" fill="#94a3b8" textAnchor="middle">
            {r.day.slice(5)}
          </text>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-500">
        {entries.map(([attr, a], ai) => (
          <span key={attr} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: palette[ai % palette.length] }} />
            {a.label}
          </span>
        ))}
        <span className="text-stone-400">· dashed rose/amber = act-now/watch thresholds · ◆ = logged intervention · violet = generator change</span>
      </div>
    </div>
  );
}

export default async function OpdGovernancePage({
  searchParams,
}: {
  searchParams: { period?: string; day?: string; speciality?: string; estimates?: string; logged?: string };
}) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") redirect("/auth/login");

  const period = ["week", "month", "day"].includes(searchParams.period || "") ? (searchParams.period as string) : "week";
  const speciality = searchParams.speciality || undefined;
  const includeEstimates = searchParams.estimates === "1";
  const day = searchParams.day || undefined;

  let live: OpdSignalsPayload | null = null;
  let liveError: string | null = null;
  let grouped: OpdSignalsPayload | null = null;
  try {
    [live, grouped] = await Promise.all([
      fetchOpdSignals({ period, day, speciality, includeEstimates }),
      fetchOpdSignals({ period: "week", groupBy: "speciality" }),
    ]);
  } catch (e) {
    liveError = e instanceof Error ? e.message : "CDMSS fetch failed";
  }

  const series = await getSeries(90);
  const latest = latestSnapshot(series);
  const ages = computeAges(series);
  const resolved = computeResolved(series);

  // A governance ruling counts as done only once CDMSS confirmed it: unconfirmed ones are listed apart
  // below as "Pending sync" and kept out of this list and the trend markers. (Before migration 037 the
  // sync column does not exist, so fall back to the plain list.)
  let interventions: InterventionRow[];
  try {
    interventions = (await sql`
      SELECT i.id, i.signal_key, i.signal_label, i.kind, i.note, i.done_on::text AS done_on, i.actor_email, p.full_name
      FROM gov_interventions i LEFT JOIN physicians p ON p.id=i.physician_id
      WHERE i.cdmss_sync_state IS NULL OR i.cdmss_sync_state = 'synced'
      ORDER BY i.done_on DESC, i.created_at DESC LIMIT 100`) as unknown as InterventionRow[];
  } catch {
    interventions = (await sql`
      SELECT i.id, i.signal_key, i.signal_label, i.kind, i.note, i.done_on::text AS done_on, i.actor_email, p.full_name
      FROM gov_interventions i LEFT JOIN physicians p ON p.id=i.physician_id
      ORDER BY i.done_on DESC, i.created_at DESC LIMIT 100`) as unknown as InterventionRow[];
  }
  const pendingRulings = await loadPendingRulings(25);
  const ivBySignal = new Map<string, InterventionRow[]>();
  for (const iv of interventions) {
    if (!ivBySignal.has(iv.signal_key)) ivBySignal.set(iv.signal_key, []);
    ivBySignal.get(iv.signal_key)!.push(iv);
  }

  const gaps = (await sql`
    SELECT id, title, attr, status, baseline_mean, shipped_at::text AS shipped_at
    FROM gov_capture_gaps ORDER BY created_at ASC`) as unknown as CaptureGap[];
  const latestMeans = latest ? attrMeans(latest) : {};

  const signals = live?.report?.signals ?? [];
  const allAffectedUids = Array.from(
    new Set(signals.flatMap((s) => (s.affected ?? []).map((a) => a.uid)).filter(Boolean)),
  );
  const mapped = allAffectedUids.length
    ? ((await sql`
        SELECT id, cdmss_doctor_uid FROM physicians
        WHERE cdmss_doctor_uid = ANY(${allAffectedUids})`) as unknown as Array<{ id: string; cdmss_doctor_uid: string }>)
    : [];
  const uidToPhysician = new Map(mapped.map((m) => [m.cdmss_doctor_uid, m.id]));

  const specialities = (grouped?.by_speciality ?? []).map((b) => b.speciality);
  const qp = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { period, day, speciality, estimates: includeEstimates ? "1" : undefined, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  return (
    <AppShell>
      <main className="mx-auto max-w-[1200px] px-4 py-8 sm:px-8">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-stone-500">
              <Link href="/overview" className="hover:text-stone-900">Governance</Link>
              <span>/</span>
              <span className="font-medium text-stone-900">OPD Governance</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">OPD Governance</h1>
            <p className="mt-1 text-sm text-stone-500">
              Note-quality governance signals · CDMSS {live?.generator ?? latest?.generator ?? "opd-governance"} · audit {live?.engine ?? ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-stone-200 bg-white text-[12.5px] font-semibold">
              {(["week", "month", "day"] as const).map((p) => (
                <Link key={p} href={`/opd-governance${qp({ period: p })}`} className={"px-3.5 py-1.5 capitalize " + (p === period ? "bg-brand-softer text-brand" : "text-stone-500 hover:bg-stone-50")}>
                  {p}
                </Link>
              ))}
            </div>
            <form method="get" className="flex items-center gap-1.5">
              <input type="hidden" name="period" value={period} />
              {includeEstimates && <input type="hidden" name="estimates" value="1" />}
              <select name="speciality" defaultValue={speciality || ""} className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-stone-600">
                <option value="">All departments</option>
                {specialities.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button type="submit" className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-stone-600 hover:bg-stone-50">Apply</button>
            </form>
            <Link
              href={`/opd-governance${qp({ estimates: includeEstimates ? undefined : "1" })}`}
              className={"rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold " + (includeEstimates ? "border-amber-300 bg-amber-50 text-amber-700" : "border-stone-200 bg-white text-stone-500 hover:bg-stone-50")}
            >
              {includeEstimates ? "Estimates: on" : "Include estimates"}
            </Link>
          </div>
        </div>

        {searchParams.logged && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-[12.5px] text-emerald-800">Intervention logged. It will appear as a ◆ marker on the trend chart from today&apos;s date.</div>
        )}

        {liveError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">CDMSS signals API unreachable: {liveError}. Snapshot-based history below remains available.</div>
        ) : live ? (
          <>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-stone-500">
              <span><b className="num text-stone-900">{live.notes_total ?? "—"}</b> notes in window</span>·
              <span><b className="num text-stone-900">{live.notes_assessed ?? "—"}</b> assessed</span>·
              <span><b className="num text-stone-900">{live.doctors_seen ?? "—"}</b> doctors</span>·
              <span>window {live.window?.from} → {live.window?.to}</span>·
              <span>baseline {live.baseline?.from} → {live.baseline?.to}</span>
              {live.speciality && <span className="font-semibold text-brand">dept: {live.speciality}</span>}
            </div>
            {live.advisory && (
              <div className="mb-4 rounded-xl border border-sky-100 bg-sky-50 px-4 py-2.5 text-[12.5px] leading-snug text-sky-900">ⓘ {live.advisory}</div>
            )}
            {live.speciality && (
              <div className="mb-4 rounded-lg border border-stone-200 bg-stone-50 px-4 py-2 text-[12px] text-stone-500">Numbers are scoped to {live.speciality}; the specifics embedded in action wording (top gaps, interaction pairs) remain hospital-wide until CDMSS v1.2.</div>
            )}

            <div className="space-y-4">
              {signals.map((s) => {
                const key = signalKey(s);
                const isEstimate = s.confidence === "estimate";
                const share = typeof s.affected_share === "number" ? Math.round(s.affected_share * 100) : null;
                const ivs = ivBySignal.get(key) ?? [];
                return (
                  <section key={key} className={"min-w-0 rounded-xl border bg-white " + (isEstimate ? "border-dashed border-amber-300" : s.severity === "act_now" ? "border-stone-200 border-l-4 border-l-rose-500" : "border-stone-200 border-l-4 border-l-amber-400")}>
                    <div className="flex flex-wrap items-center gap-2.5 px-5 pb-1 pt-4">
                      <h3 className="text-[15px] font-semibold tracking-tight">{s.label}</h3>
                      <span className={"rounded-full px-2.5 py-0.5 text-[10.5px] font-bold uppercase " + sevChip(s.severity, isEstimate)}>
                        {isEstimate ? "estimate" : s.severity === "act_now" ? "act now" : "watch"}
                      </span>
                      <span className={"text-[12px] font-bold " + (s.trend === "worsening" ? "text-rose-600" : s.trend === "improving" ? "text-emerald-600" : "text-stone-400")}>
                        {s.trend === "worsening" ? `▼ ${Math.abs(s.delta ?? 0).toFixed(1)} worsening` : s.trend === "improving" ? `▲ ${Math.abs(s.delta ?? 0).toFixed(1)} improving` : s.trend === "no_baseline" ? "no baseline" : "— flat"}
                      </span>
                      <span className="rounded bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">{s.scope}</span>
                      {ages[key] && !speciality && (
                        <span className={"rounded-full border px-2 py-0.5 text-[10.5px] font-bold " + (ages[key].regressed ? "border-rose-200 bg-rose-50 text-rose-700" : "border-violet-200 bg-violet-50 text-violet-700")}>
                          {ages[key].regressed ? "back · " : ""}signalling {ages[key].ageDays < 14 ? `${Math.max(ages[key].ageDays, 1)}d` : `${Math.round(ages[key].ageDays / 7)} wks`}
                        </span>
                      )}
                      <span className="ml-auto text-xl font-bold tracking-tight num">
                        {fmtVal(s)} <span className="text-[11px] font-medium text-stone-400">n {s.n}</span>
                      </span>
                    </div>
                    <div className="px-5 pb-4">
                      {s.definition && <p className="mb-2 text-[12.5px] text-stone-500">{s.definition}</p>}
                      {share !== null && s.eligible_doctors ? (
                        <div className="mb-2">
                          <div className="text-[11.5px] text-stone-500">{share}% of {s.eligible_doctors} eligible doctors</div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-stone-100">
                            <div className={"h-full rounded-full " + (s.severity === "act_now" ? "bg-rose-500" : "bg-amber-500")} style={{ width: `${share}%` }} />
                          </div>
                        </div>
                      ) : null}
                      {s.action && (
                        <div className="rounded-lg border border-teal-200 bg-brand-softer px-3.5 py-2.5 text-[13px]">
                          <b className="text-brand">Action:</b> {s.action}
                        </div>
                      )}
                      {(s.affected ?? []).length > 0 && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-stone-400">Worst first (supportive follow-up):</span>
                          {(s.affected ?? []).map((a) => {
                            const pid = uidToPhysician.get(a.uid);
                            const txt = `${a.name} · ${typeof a.mean === "number" ? a.mean.toFixed(1) : a.value} (n ${a.n})`;
                            return pid ? (
                              <Link key={a.uid} href={`/physicians/${pid}`} className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[11.5px] font-medium hover:border-brand hover:text-brand">{txt}</Link>
                            ) : (
                              <span key={a.uid} className="rounded-full border border-stone-100 bg-stone-50 px-2.5 py-1 text-[11.5px] text-stone-500" title="Not yet mapped to an EPI physician">{txt}</span>
                            );
                          })}
                        </div>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-stone-100 pt-2.5">
                        {ivs.slice(0, 3).map((iv) => (
                          <span key={iv.id} className="text-[11.5px] text-stone-500">◆ {KIND_LABEL[iv.kind] ?? iv.kind} · {iv.done_on}{iv.full_name ? ` · ${iv.full_name}` : ""}</span>
                        ))}
                        <details className="ml-auto">
                          <summary className="cursor-pointer text-[12px] font-semibold text-brand">+ Log intervention</summary>
                          <form method="post" action="/api/opd-governance/interventions" className="mt-2 flex w-72 flex-col gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3">
                            <input type="hidden" name="signal_key" value={key} />
                            <input type="hidden" name="signal_label" value={s.label} />
                            <select name="kind" className="rounded border border-stone-200 px-2 py-1.5 text-[12.5px]" defaultValue="huddle_briefing">
                              <option value="huddle_briefing">Huddle briefing</option>
                              <option value="supportive_1to1">Supportive 1:1</option>
                              <option value="spot_audit">Spot audit</option>
                              <option value="emr_ask">EMR team ask</option>
                              <option value="other">Other</option>
                            </select>
                            <textarea name="note" rows={2} placeholder="What was done / agreed…" className="rounded border border-stone-200 px-2 py-1.5 text-[12.5px]" />
                            <button type="submit" className="rounded bg-brand px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-brand-hover">Log</button>
                          </form>
                        </details>
                      </div>
                    </div>
                  </section>
                );
              })}
              {signals.length === 0 && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-6 text-center text-sm text-emerald-800">No active signals in this window. ✓</div>
              )}
            </div>

            <div className="mt-4 space-y-2">
              {(live.report?.healthy ?? []).length > 0 && (
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-[12.5px] text-emerald-900">✓ PDQI healthy — {(live.report?.healthy ?? []).map((h) => `${h.label} ${h.mean.toFixed(1)}`).join(" · ")}{resolved.length > 0 ? ` · resolved recently: ${resolved.map((r) => r.label).join(", ")}` : ""}</div>
              )}
              {(live.report?.domain_healthy ?? []).length > 0 && (
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-[12.5px] text-emerald-900">✓ Domain healthy — {(live.report?.domain_healthy ?? []).map((d) => `${d.label} ${d.value}${d.unit === "pct" ? "%" : d.unit === "per_100_notes" ? "/100" : ""}`).join(" · ")}</div>
              )}
            </div>
          </>
        ) : null}

        {pendingRulings.length > 0 && (
          <section role="status" className="mt-6 rounded-xl border border-violet-200 bg-violet-50 px-5 py-3.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">Pending sync</span>
              <span className="text-[13px] font-semibold text-violet-950">
                {pendingRulings.length} governance {pendingRulings.length === 1 ? "ruling is" : "rulings are"} saved but not confirmed by CDMSS
              </span>
            </div>
            <p className="mb-2 text-[12px] text-violet-900">
              These are not done yet: the audit thread still shows its old status in CDMSS. They are retried every night.
            </p>
            <ul className="space-y-0.5 text-[12.5px]">
              {pendingRulings.map((r) => (
                <li key={r.id}>
                  <Link href={`/audit-findings/${encodeURIComponent(r.reference)}`} className="font-medium text-brand hover:underline">{r.reference}</Link>
                  <span className="text-stone-600"> · {actionLabel(r.action)}{r.actor_email ? ` · ${r.actor_email}` : ""}{r.attempts > 0 ? ` · ${r.attempts} retr${r.attempts === 1 ? "y" : "ies"}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Trend chart */}
        <section className="mt-6 min-w-0 rounded-xl border border-stone-200 bg-white p-5">
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-400">Attribute trends — is the intervention working?</h2>
          <TrendChart series={series} interventions={interventions} />
        </section>

        {/* Dept mini-reports */}
        {!speciality && (grouped?.by_speciality ?? []).length > 0 && (
          <section className="mt-6 min-w-0 rounded-xl border border-stone-200 bg-white p-5">
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-400">By department (week window · PDQI only · v1.1)</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-[10.5px] uppercase tracking-wide text-stone-400">
                    <th className="py-2 pr-3">Department</th>
                    <th className="py-2 pr-3">Notes</th>
                    <th className="py-2 pr-3">Doctors</th>
                    <th className="py-2">Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {(grouped?.by_speciality ?? []).slice(0, 14).map((b) => (
                    <tr key={b.speciality} className="border-b border-stone-50">
                      <td className="py-2 pr-3 font-medium">
                        {b.speciality === "Unattributed" ? (
                          <span className="text-stone-400" title="doctor_uid missing from doctor_directory — data hygiene, not a department">Unattributed</span>
                        ) : (
                          <Link href={`/opd-governance${qp({ speciality: b.speciality, period: "week" })}`} className="text-brand hover:underline">{b.speciality}</Link>
                        )}
                      </td>
                      <td className="num py-2 pr-3">{b.notes_assessed}</td>
                      <td className="num py-2 pr-3">{b.doctors_seen}</td>
                      <td className="py-2">
                        {(b.signals ?? []).length === 0 ? (
                          <span className="text-emerald-600">✓ none</span>
                        ) : (
                          (b.signals ?? []).map((s) => (
                            <span key={signalKey(s)} className={"mr-1.5 inline-block rounded-full px-2 py-0.5 text-[10.5px] font-bold " + (s.severity === "act_now" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700")}>
                              {s.label} {typeof s.mean === "number" ? s.mean.toFixed(1) : s.value}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Capture-gap register */}
        <section id="capture-gaps" className="mt-6 min-w-0 scroll-mt-20 rounded-xl border border-stone-200 bg-white p-5">
          <h2 className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-400">EMR capture-gap register</h2>
          <p className="mb-3 text-[12px] text-stone-500">Systemic asks to the EMR/design team (source: capture-gap design report, 2 Jul 2026). Post-ship lift is measured on the trend chart — these are capture-design problems, not clinician problems.</p>
          <div className="divide-y divide-stone-100">
            {gaps.map((g) => {
              const current = latestMeans[g.attr]?.mean ?? null;
              const delta = current !== null && g.baseline_mean !== null ? Math.round((current - Number(g.baseline_mean)) * 10) / 10 : null;
              return (
                <div key={g.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className={"rounded-full px-2 py-0.5 text-[10px] font-bold uppercase " + (g.status === "shipped" ? "bg-emerald-50 text-emerald-700" : g.status === "with_design" ? "bg-sky-50 text-sky-700" : "bg-stone-100 text-stone-500")}>{g.status.replace("_", " ")}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{g.title}</div>
                    <div className="text-[11.5px] text-stone-400">
                      {latestMeans[g.attr]?.label ?? g.attr} · baseline {g.baseline_mean ?? "—"}
                      {current !== null ? ` → now ${current.toFixed(1)}` : ""}
                      {delta !== null ? (
                        <span className={delta > 0 ? " text-emerald-600" : delta < 0 ? " text-rose-600" : ""}> ({delta > 0 ? "+" : ""}{delta})</span>
                      ) : null}
                      {g.shipped_at ? ` · shipped ${g.shipped_at}` : ""}
                    </div>
                  </div>
                  {user.is_super_admin && (
                    <form method="post" action="/api/opd-governance/capture-gaps" className="flex items-center gap-1.5">
                      <input type="hidden" name="id" value={g.id} />
                      <select name="status" defaultValue={g.status} className="rounded border border-stone-200 px-2 py-1 text-[11.5px]">
                        <option value="open">open</option>
                        <option value="with_design">with design</option>
                        <option value="shipped">shipped</option>
                      </select>
                      <button type="submit" className="rounded border border-stone-200 px-2 py-1 text-[11.5px] font-semibold text-stone-600 hover:bg-stone-50">Set</button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </AppShell>
  );
}
