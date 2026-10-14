"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { DoctorLookup } from "@/components/shell/DoctorLookup";
import { HeadlineStrip, type HeadlineStat } from "@/components/shell/HeadlineStrip";
import {
  DOC_TYPE_LABEL,
  PIPE_STATUS_LABEL,
  SEVERITY_LABEL,
  filterAuditRows,
  formatAuditDate,
  type DocType,
  type DocumentAuditListItem,
  type DocumentAuditsHeadline,
  type FindingSeverity,
  type PipeStatus,
} from "@/lib/document-audits";

const HOSPITAL_EVENT = "epi-hospital-filter";

const SEV_PILL: Record<string, string> = {
  critical: "bg-red-50 text-red-800",
  high: "bg-orange-50 text-orange-800",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-stone-100 text-stone-700",
};

const STATUS_PILL: Record<string, string> = {
  open: "bg-sky-50 text-sky-800",
  in_progress: "bg-violet-50 text-violet-800",
  remediated: "bg-emerald-50 text-emerald-800",
  contested: "bg-amber-50 text-amber-900",
  escalated: "bg-rose-50 text-rose-800",
};

interface HomePayload {
  ok: boolean;
  headline: DocumentAuditsHeadline;
  rows: DocumentAuditListItem[];
  doctors: Array<{ id: string; name: string; specialty: string }>;
  hospital_code?: string;
  error?: string;
}

function auditDetailHref(row: DocumentAuditListItem): string {
  const path = `/document-audits/${encodeURIComponent(row.id)}`;
  return row.finding_id ? `${path}?finding=${encodeURIComponent(row.finding_id)}` : path;
}

export function DocumentAuditsHome() {
  const [data, setData] = useState<HomePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [physicianId, setPhysicianId] = useState<string | null>(null);
  const [docType, setDocType] = useState<DocType | "all">("all");
  const [severity, setSeverity] = useState<FindingSeverity | "all">("all");
  const [status, setStatus] = useState<PipeStatus | "all">("all");

  useEffect(() => {
    let cancelled = false;
    function load() {
      setLoading(true);
      const qs = new URLSearchParams();
      if (physicianId) qs.set("physician_id", physicianId);
      fetch(`/api/document-audits/home?${qs.toString()}`)
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.ok) {
            setData(j as HomePayload);
            setError("");
          } else {
            setError(j.error || "Could not load document audits");
          }
        })
        .catch(() => {
          if (!cancelled) setError("Could not load document audits");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    load();
    window.addEventListener(HOSPITAL_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(HOSPITAL_EVENT, load);
    };
  }, [physicianId]);

  const headline = data?.headline;
  const stats: HeadlineStat[] = headline
    ? [
        { label: "Audits (scope)", value: String(headline.total), hint: "Hospital filter" },
        {
          label: "Open findings",
          value: String(headline.open_findings),
          hint: "Physician remediates",
          tone: headline.open_findings > 0 ? "danger" : "default",
        },
        {
          label: "Critical / High",
          value: String(headline.critical_high),
          hint: "Open severity",
          tone: headline.critical_high > 0 ? "danger" : "default",
        },
        {
          label: "Doctors with findings",
          value: String(headline.doctors_with_findings),
          hint: "physician_id scoped",
        },
        {
          label: "Last ingest",
          value: headline.last_ingest ? formatAuditDate(headline.last_ingest) : headline.honesty_label,
          hint: headline.honesty === "empty" ? "Honest empty" : headline.honesty_label,
          tone: "muted",
          compact: true,
        },
      ]
    : [];

  const rows = useMemo(
    () =>
      filterAuditRows(data?.rows ?? [], {
        query,
        physicianId,
        docType,
        severity,
        status,
      }),
    [data?.rows, query, physicianId, docType, severity, status],
  );

  function onLookupChange(name: string) {
    setQuery(name);
    const hit = (data?.doctors ?? []).find((d) => d.name === name);
    setPhysicianId(hit?.id ?? null);
  }

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[1180px] px-6 py-8 lg:px-8">
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px] text-stone-500">
          <Link href="/overview" className="font-medium text-brand hover:underline">
            Governance
          </Link>
          <span className="text-stone-400">/</span>
          <span className="font-semibold text-stone-900">Document Audits</span>
        </div>

        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight text-stone-900">
              Document Audits
              <span
                className={
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide " +
                  (headline?.honesty === "live"
                    ? "bg-emerald-100 text-emerald-800"
                    : headline?.honesty === "stale"
                      ? "bg-orange-100 text-orange-800"
                      : "bg-stone-100 text-stone-600")
                }
              >
                {headline?.honesty_label ?? (loading ? "…" : "Empty")}
              </span>
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-500">
              Clinical document audits ingested into Governance (Progress · OT · Discharge) — not a CDMSS silo.
              RMOs author findings; portal doctors remediate. Distinct from Patient Feedback / e-IRIS.
            </p>
          </div>
          <Link
            href="/rmo-inbox"
            className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-[12.5px] font-semibold text-stone-700 hover:border-teal-300 hover:bg-teal-50"
          >
            RMO Inbox →
          </Link>
        </div>

        {headline?.honesty === "stale" ? (
          <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-950">
            <strong>Stale ingest signal.</strong> Last successful audit ingest is older than the freshness
            window. Treat counts as last-known — not live.
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
        ) : null}

        <HeadlineStrip stats={stats} />

        <section className="mb-4 rounded-xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-stone-900">Look up audits by doctor</h2>
            <span className="rounded-md bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-800">
              OPD shell pattern
            </span>
          </div>
          <p className="mb-3 text-[12px] text-stone-500">
            Shareable scope via <code className="rounded bg-stone-100 px-1 text-[11px]">physician_id</code>.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <DoctorLookup
              options={data?.doctors ?? []}
              value={query}
              onChange={onLookupChange}
              placeholder="Doctor name or physician_id…"
            />
            {physicianId ? (
              <button
                type="button"
                className="rounded-lg border border-stone-200 px-3 py-2 text-[12.5px] font-medium text-stone-600 hover:bg-stone-50"
                onClick={() => {
                  setPhysicianId(null);
                  setQuery("");
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </section>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-stone-500">Filters</span>
          <select
            className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[12.5px]"
            value={docType}
            onChange={(e) => setDocType(e.target.value as DocType | "all")}
            aria-label="Document type"
          >
            <option value="all">All doc types</option>
            {(Object.keys(DOC_TYPE_LABEL) as DocType[]).map((k) => (
              <option key={k} value={k}>
                {DOC_TYPE_LABEL[k]}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[12.5px]"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as FindingSeverity | "all")}
            aria-label="Severity"
          >
            <option value="all">All severities</option>
            {(Object.keys(SEVERITY_LABEL) as FindingSeverity[]).map((k) => (
              <option key={k} value={k}>
                {SEVERITY_LABEL[k]}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[12.5px]"
            value={status}
            onChange={(e) => setStatus(e.target.value as PipeStatus | "all")}
            aria-label="Pipe status"
          >
            <option value="all">All statuses</option>
            {(Object.keys(PIPE_STATUS_LABEL) as PipeStatus[]).map((k) => (
              <option key={k} value={k}>
                {PIPE_STATUS_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
          <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Audit queue</h2>
              <p className="text-[11.5px] text-stone-500">
                Human-readable findings · RMO author named · remediator = physician portal
              </p>
            </div>
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
              {rows.length} rows
            </span>
          </div>
          {loading ? (
            <div className="px-4 py-12 text-center text-sm text-stone-500">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-14 text-center">
              <div className="text-[0.98rem] font-semibold text-stone-900">No document audits yet</div>
              <p className="mx-auto mt-1.5 max-w-md text-[13px] text-stone-500">
                Honest empty — CDMSS ingest is not inventing volumes. Schema and staff UI are ready for
                Progress / OT / Discharge findings.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-[13px]">
                <thead>
                  <tr className="bg-stone-50 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                    <th className="px-3.5 py-2.5">Ref</th>
                    <th className="px-3.5 py-2.5">Doctor</th>
                    <th className="px-3.5 py-2.5">Doc type</th>
                    <th className="px-3.5 py-2.5">Finding</th>
                    <th className="px-3.5 py-2.5">Sev</th>
                    <th className="px-3.5 py-2.5">Status</th>
                    <th className="px-3.5 py-2.5">Authored by (RMO)</th>
                    <th className="px-3.5 py-2.5">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.finding_id ?? row.id} className="border-t border-stone-100 hover:bg-stone-50">
                      <td className="px-3.5 py-2.5 font-mono text-[12px] text-stone-600">
                        <Link
                          href={auditDetailHref(row)}
                          className="font-semibold text-brand hover:underline"
                        >
                          {row.external_ref ?? "Open"}
                        </Link>
                      </td>
                      <td className="px-3.5 py-2.5">
                        <Link
                          href={`/physicians/${row.physician_id}?tab=documentation`}
                          className="font-semibold text-brand hover:underline"
                        >
                          {row.physician_name}
                        </Link>
                        <div className="text-[11.5px] text-stone-500">{row.specialty}</div>
                      </td>
                      <td className="px-3.5 py-2.5">{row.doc_type_label}</td>
                      <td className="max-w-[220px] px-3.5 py-2.5 font-medium text-stone-800">
                        <Link href={auditDetailHref(row)} className="hover:text-brand hover:underline">
                          {row.finding_label}
                        </Link>
                      </td>
                      <td className="px-3.5 py-2.5">
                        {row.severity ? (
                          <span className={"rounded-md px-1.5 py-0.5 text-[11px] font-semibold " + SEV_PILL[row.severity]}>
                            {row.severity_label}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3.5 py-2.5">
                        {row.status ? (
                          <span
                            className={"rounded-md px-1.5 py-0.5 text-[11px] font-semibold " + STATUS_PILL[row.status]}
                          >
                            {row.status_label}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3.5 py-2.5 text-stone-600">{row.authored_by_name ?? "—"}</td>
                      <td className="px-3.5 py-2.5 text-stone-500">
                        {row.open_age_days != null ? `${row.open_age_days}d` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="mt-4 rounded-[10px] border border-dashed border-stone-300 bg-stone-50 px-4 py-3 text-[12.5px] text-stone-600">
          <strong className="text-stone-800">Surgical ELO / Adherence:</strong> Stage 4 starts Adherence from
          available document audits and surgical feedback (honest empty when none).{" "}
          <Link href="/surgical-governance" className="font-semibold text-brand hover:underline">
            Open Surgical ELO →
          </Link>
        </div>
      </main>
    </>
  );
}
