"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import {
  PIPE_STATUS_LABEL,
  SEVERITY_LABEL,
  formatAuditDate,
  type FindingSeverity,
  type PipeStatus,
} from "@/lib/document-audits";

const SEV_PILL: Record<FindingSeverity, string> = {
  critical: "bg-red-50 text-red-800",
  high: "bg-orange-50 text-orange-800",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-stone-100 text-stone-700",
};

const STATUS_PILL: Record<PipeStatus, string> = {
  open: "bg-sky-50 text-sky-800",
  in_progress: "bg-violet-50 text-violet-800",
  remediated: "bg-emerald-50 text-emerald-800",
  contested: "bg-amber-50 text-amber-900",
  escalated: "bg-rose-50 text-rose-800",
};

interface Audit {
  id: string;
  external_ref: string | null;
  source_audit_id: string | null;
  hospital_code: string;
  physician_id: string;
  physician_name: string;
  specialty: string;
  doc_type: "progress" | "ot" | "discharge";
  doc_type_label: string;
  note_date: string | null;
  ingested_at: string;
  cdmss_pdf_url: string | null;
}

interface Finding {
  id: string;
  finding_label: string;
  finding_body: string | null;
  severity: FindingSeverity;
  status: PipeStatus;
  authored_by_name: string;
  authored_at: string;
  portal_visible: boolean;
  response_owner: string | null;
  signal_reference: string | null;
  doctor_response_verb: string | null;
  doctor_response_comment: string | null;
  doctor_responded_at: string | null;
}

interface DetailPayload {
  ok: boolean;
  audit?: Audit;
  findings?: Finding[];
  error?: string;
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

function responseVerbLabel(value: string | null): string {
  if (value === "agree") return "Agreed";
  if (value === "disagree") return "Disagreed";
  if (value === "needs_clarification") return "Needs clarification";
  return "No response yet";
}

function responseOwnerLabel(value: string | null): string {
  if (value === "pipe_a") return "Pipe A";
  if (value === "local") return "Local governance";
  return "Not assigned";
}

export function DocumentAuditDetail({
  auditId,
  initialFinding,
}: {
  auditId: string;
  initialFinding: string | null;
}) {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [selected, setSelected] = useState<string | null>(initialFinding);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/document-audits/${encodeURIComponent(auditId)}`)
      .then(async (response) => {
        const payload = (await response.json()) as DetailPayload;
        if (!response.ok || !payload.ok || !payload.audit) {
          throw new Error(payload.error || "Could not load document audit");
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        const nextFindings = payload.findings ?? [];
        setAudit(payload.audit ?? null);
        setFindings(nextFindings);
        setSelected(
          nextFindings.some((finding) => finding.id === initialFinding)
            ? initialFinding
            : (nextFindings[0]?.id ?? null),
        );
        setError("");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not load document audit");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auditId, initialFinding]);

  const active = findings.find((finding) => finding.id === selected) ?? null;

  function selectFinding(findingId: string) {
    setSelected(findingId);
    const url = new URL(window.location.href);
    url.searchParams.set("finding", findingId);
    window.history.replaceState(null, "", url);
  }

  if (loading) {
    return (
      <>
        <TopNav />
        <main className="mx-auto max-w-[1180px] px-6 py-12 text-sm text-stone-500 lg:px-8">
          Loading document audit…
        </main>
      </>
    );
  }

  if (error || !audit) {
    return (
      <>
        <TopNav />
        <main className="mx-auto max-w-[760px] px-6 py-14 text-center lg:px-8">
          <h1 className="text-lg font-semibold text-stone-900">{error || "Document audit not found"}</h1>
          <Link href="/document-audits" className="mt-3 inline-block text-sm font-semibold text-brand hover:underline">
            ← Back to Document Audits
          </Link>
        </main>
      </>
    );
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
          <Link href="/document-audits" className="font-medium text-brand hover:underline">
            Document Audits
          </Link>
          <span className="text-stone-400">/</span>
          <span className="font-semibold text-stone-900">
            {audit.external_ref ?? audit.source_audit_id ?? audit.id.slice(0, 8)}
          </span>
        </div>

        <section className="mb-4 rounded-xl border border-stone-200 bg-white p-5 shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-teal-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-800">
                  {audit.doc_type_label}
                </span>
                <span className="rounded-md bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
                  {audit.hospital_code}
                </span>
              </div>
              <h1 className="text-[1.55rem] font-bold tracking-tight text-stone-900">Document audit detail</h1>
              <p className="mt-1 text-sm text-stone-500">
                Human-readable governance findings · raw CDMSS payloads are not shown
              </p>
            </div>
            {audit.cdmss_pdf_url ? (
              <a
                href={`/api/document-audits/${audit.id}/pdf`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex rounded-lg bg-brand px-3.5 py-2 text-[12.5px] font-semibold text-white hover:opacity-90"
              >
                Download audit PDF
              </a>
            ) : null}
          </div>

          <dl className="mt-5 grid gap-x-6 gap-y-3 border-t border-stone-100 pt-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Physician</dt>
              <dd className="mt-1">
                <Link
                  href={`/physicians/${audit.physician_id}?tab=documentation`}
                  className="font-semibold text-brand hover:underline"
                >
                  {audit.physician_name}
                </Link>
                {audit.specialty ? <span className="ml-1.5 text-stone-500">· {audit.specialty}</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Note date</dt>
              <dd className="mt-1 font-medium text-stone-800">{formatAuditDate(audit.note_date)}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Ingested</dt>
              <dd className="mt-1 font-medium text-stone-800">{formatDateTime(audit.ingested_at)}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Hospital</dt>
              <dd className="mt-1 font-medium text-stone-800">{audit.hospital_code}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">External ref</dt>
              <dd className="mt-1 break-all font-mono text-[12px] text-stone-700">{audit.external_ref ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Source audit ID</dt>
              <dd className="mt-1 break-all font-mono text-[12px] text-stone-700">
                {audit.source_audit_id ?? "—"}
              </dd>
            </div>
          </dl>
        </section>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section className="overflow-hidden rounded-xl border border-stone-200 bg-white">
            <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-stone-900">Findings</h2>
                <p className="text-[11.5px] text-stone-500">Every finding recorded on this audit</p>
              </div>
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
                {findings.length}
              </span>
            </div>
            {findings.length === 0 ? (
              <div className="px-4 py-14 text-center">
                <div className="font-semibold text-stone-900">No findings recorded</div>
                <p className="mt-1 text-[13px] text-stone-500">This audit exists without any governance findings.</p>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {findings.map((finding) => (
                  <button
                    key={finding.id}
                    type="button"
                    onClick={() => selectFinding(finding.id)}
                    className={
                      "block w-full px-4 py-3.5 text-left transition-colors " +
                      (finding.id === selected ? "bg-teal-50" : "hover:bg-stone-50")
                    }
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="font-semibold text-stone-900">{finding.finding_label}</div>
                      <div className="flex items-center gap-1.5">
                        <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${SEV_PILL[finding.severity]}`}>
                          {SEVERITY_LABEL[finding.severity]}
                        </span>
                        <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_PILL[finding.status]}`}>
                          {PIPE_STATUS_LABEL[finding.status]}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-stone-600">
                      {finding.finding_body || "No additional narrative recorded."}
                    </p>
                    <div className="mt-2 text-[11px] text-stone-500">
                      RMO {finding.authored_by_name} · {formatDateTime(finding.authored_at)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <aside className="overflow-hidden rounded-xl border border-stone-200 bg-white lg:sticky lg:top-20 lg:self-start">
            <div className="border-b border-stone-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-stone-900">Finding detail</h2>
              <p className="text-[11.5px] text-stone-500">Readable governance language</p>
            </div>
            {!active ? (
              <p className="px-4 py-12 text-center text-[13px] text-stone-500">
                {findings.length === 0 ? "No finding to inspect." : "Select a finding to inspect it."}
              </p>
            ) : (
              <div className="px-4 py-4">
                <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-blue-700">
                  Authored by RMO · {active.authored_by_name}
                </div>
                <h3 className="text-[15px] font-semibold text-stone-900">{active.finding_label}</h3>
                <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-stone-700">
                  {active.finding_body || "No additional narrative recorded."}
                </p>

                <dl className="mt-4 grid gap-2 border-t border-stone-100 pt-3 text-[12px]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-400">Severity</dt>
                    <dd className="font-medium text-stone-700">{SEVERITY_LABEL[active.severity]}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-400">Status</dt>
                    <dd className="font-medium text-stone-700">{PIPE_STATUS_LABEL[active.status]}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-400">Authored</dt>
                    <dd className="text-right font-medium text-stone-700">{formatDateTime(active.authored_at)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-400">Portal visible</dt>
                    <dd className="font-medium text-stone-700">{active.portal_visible ? "Yes" : "No"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-400">Response owner</dt>
                    <dd className="font-medium text-stone-700">{responseOwnerLabel(active.response_owner)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-400">Signal reference</dt>
                    <dd className="break-all text-right font-mono text-[11px] text-stone-700">
                      {active.signal_reference ?? "—"}
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-3 py-3">
                  <div className="text-[10.5px] font-bold uppercase tracking-wide text-stone-500">
                    Doctor response
                  </div>
                  <div className="mt-1 text-[13px] font-semibold text-stone-800">
                    {responseVerbLabel(active.doctor_response_verb)}
                  </div>
                  {active.doctor_response_comment ? (
                    <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-stone-700">
                      {active.doctor_response_comment}
                    </p>
                  ) : null}
                  {active.doctor_responded_at ? (
                    <div className="mt-2 text-[11px] text-stone-500">
                      Responded {formatDateTime(active.doctor_responded_at)}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </aside>
        </div>
      </main>
    </>
  );
}
