"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  PIPE_STATUS_LABEL,
  SEVERITY_LABEL,
  type PhysicianDocumentationEvent,
  type PhysicianDocumentationHeadline,
} from "@/lib/document-audits";

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

interface DocPayload {
  ok: boolean;
  headline: PhysicianDocumentationHeadline;
  events: PhysicianDocumentationEvent[];
  adherence?: { state: string; label: string; percent: number | null; detail: string };
}

/**
 * Stage 4 — Physician Documentation section (timeline + finding panel).
 * Human-readable findings only — never raw CDMSS JSON.
 */
export function PhysicianDocumentationSection({ physicianId }: { physicianId: string }) {
  const [data, setData] = useState<DocPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/physicians/${physicianId}/documentation`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.ok) {
          setData(j as DocPayload);
          const first = (j.events as PhysicianDocumentationEvent[] | undefined)?.[0];
          setSelected(first?.finding_id ?? null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [physicianId]);

  const headline = data?.headline;
  const events = data?.events ?? [];
  const active = events.find((e) => e.finding_id === selected) ?? null;

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
        {[
          { label: "Doc audits", value: String(headline?.total ?? 0), hint: "This physician" },
          { label: "Open findings", value: String(headline?.open_findings ?? 0), hint: "Needs response" },
          { label: "Critical / High", value: String(headline?.critical_high ?? 0), hint: "Open severity" },
          {
            label: "Last audit event",
            value: headline?.last_event ?? "—",
            hint: headline?.honesty === "empty" ? "Honest empty" : "Most recent",
          },
          {
            label: "Adherence",
            value: data?.adherence?.label ?? "None yet",
            hint: data?.adherence?.state === "live" ? "Stage 4 live" : "Empty until audits",
          },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-stone-200 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
          >
            <div className="text-[11px] font-medium text-stone-500">{s.label}</div>
            <div className="mt-1 text-[1.25rem] font-bold tracking-tight text-stone-900">{s.value}</div>
            <div className="mt-1 text-[11px] text-stone-500">{s.hint}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Documentation timeline</h2>
              <p className="text-[11.5px] text-stone-500">
                Audit events · human-readable findings — not raw CDMSS JSON
              </p>
            </div>
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
              {events.length} events
            </span>
          </div>
          {loading ? (
            <div className="px-4 py-12 text-center text-sm text-stone-500">Loading…</div>
          ) : events.length === 0 ? (
            <div className="px-4 py-14 text-center">
              <div className="font-semibold text-stone-900">No documentation audit events yet</div>
              <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-stone-500">
                Honest empty for this physician. Feedback and ELO remain separate sections.
              </p>
              <Link href="/document-audits" className="mt-3 inline-block text-[12.5px] font-semibold text-brand hover:underline">
                Document Audits home →
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="bg-stone-50 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                    <th className="px-3.5 py-2.5">Date</th>
                    <th className="px-3.5 py-2.5">Doc type</th>
                    <th className="px-3.5 py-2.5">Finding</th>
                    <th className="px-3.5 py-2.5">Sev</th>
                    <th className="px-3.5 py-2.5">Status</th>
                    <th className="px-3.5 py-2.5">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr
                      key={ev.finding_id}
                      className={
                        "cursor-pointer border-t border-stone-100 " +
                        (selected === ev.finding_id ? "bg-teal-50" : "hover:bg-stone-50")
                      }
                      onClick={() => setSelected(ev.finding_id)}
                    >
                      <td className="px-3.5 py-2.5 whitespace-nowrap">{ev.date_label}</td>
                      <td className="px-3.5 py-2.5">{ev.doc_type_label}</td>
                      <td className="max-w-[200px] px-3.5 py-2.5 font-medium">{ev.finding_label}</td>
                      <td className="px-3.5 py-2.5">
                        <span className={"rounded-md px-1.5 py-0.5 text-[11px] font-semibold " + SEV_PILL[ev.severity]}>
                          {SEVERITY_LABEL[ev.severity]}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5">
                        <span className={"rounded-md px-1.5 py-0.5 text-[11px] font-semibold " + STATUS_PILL[ev.status]}>
                          {PIPE_STATUS_LABEL[ev.status]}
                        </span>
                      </td>
                      <td className="px-3.5 py-2.5 text-stone-500">
                        {ev.open_age_days > 0 ? `${ev.open_age_days}d` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="overflow-hidden rounded-xl border border-stone-200 bg-white lg:sticky lg:top-20 lg:self-start">
          <div className="border-b border-stone-200 px-4 py-3">
            <h2 className="text-sm font-semibold">Finding</h2>
            <p className="text-[11.5px] text-stone-500">Readable governance language</p>
          </div>
          <div className="px-4 py-4">
            {!active ? (
              <p className="py-8 text-center text-[13px] text-stone-500">
                Select a timeline row to inspect a finding.
              </p>
            ) : (
              <>
                <div className="mb-2 text-[10.5px] font-bold uppercase tracking-wide text-blue-700">
                  Authored by RMO · {active.authored_by_name}
                </div>
                <h3 className="text-[15px] font-semibold text-stone-900">{active.finding_label}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-stone-700">
                  {active.finding_body ||
                    "Human-readable finding summary. Raw CDMSS JSON is not shown on this surface."}
                </p>
                <div className="mt-3.5 grid gap-1.5 border-t border-stone-100 pt-3 text-[11.5px] text-stone-500">
                  <div>
                    <span className="inline-block min-w-[100px] text-stone-400">Audit ref</span>
                    <code className="rounded bg-stone-100 px-1 text-[11px]">{active.external_ref ?? active.audit_id.slice(0, 8)}</code>
                  </div>
                  <div>
                    <span className="inline-block min-w-[100px] text-stone-400">Doc type</span>
                    {active.doc_type_label}
                  </div>
                  <div>
                    <span className="inline-block min-w-[100px] text-stone-400">Severity</span>
                    {SEVERITY_LABEL[active.severity]}
                  </div>
                  <div>
                    <span className="inline-block min-w-[100px] text-stone-400">Status</span>
                    {PIPE_STATUS_LABEL[active.status]}
                  </div>
                </div>
                <div className="mt-3 rounded-lg border border-dashed border-stone-300 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
                  Remediator = this physician via doctor portal. Raw <code className="text-[11px]">CDMSS</code>{" "}
                  payload is never dumped here.
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href={`/document-audits/${active.audit_id}?finding=${active.finding_id}`}
                    className="inline-flex rounded-lg border border-stone-200 px-3 py-2 text-[12.5px] font-semibold text-brand hover:border-teal-300 hover:bg-teal-50"
                  >
                    Open full audit detail
                  </Link>
                  {active.cdmss_pdf_url ? (
                  <a
                    href={`/api/document-audits/${active.audit_id}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex rounded-lg bg-brand px-3 py-2 text-[12.5px] font-semibold text-white hover:opacity-90"
                  >
                    Download audit PDF
                  </a>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-[12.5px]">
        <Link href="/document-audits" className="font-semibold text-brand hover:underline">
          Document Audits →
        </Link>
        <Link href="/rmo-inbox" className="font-semibold text-brand hover:underline">
          RMO Inbox →
        </Link>
      </div>
    </div>
  );
}
