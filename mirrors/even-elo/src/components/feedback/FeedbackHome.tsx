"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { DoctorLookup } from "@/components/shell/DoctorLookup";
import { HeadlineStrip, type HeadlineStat } from "@/components/shell/HeadlineStrip";
import {
  categoryLabel,
  filterFeedItems,
  filterPhysicianRows,
  formatFeedbackDate,
  type FeedbackHomePayload,
  type PolarityFilter,
  type Severity,
  type StatusFilter,
} from "@/lib/feedback-home";

const SEV_PILL: Record<string, string> = {
  low: "bg-stone-100 text-stone-700",
  medium: "bg-amber-50 text-amber-800",
  high: "bg-orange-50 text-orange-800",
  critical: "bg-red-50 text-red-800",
};

const STATUS_PILL: Record<string, string> = {
  open: "bg-emerald-50 text-emerald-700",
  closed: "bg-stone-100 text-stone-600",
  retracted: "bg-red-50 text-red-700",
};

const HOSPITAL_EVENT = "epi-hospital-filter";

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function sourceLabel(source: string): string {
  if (source === "patient") return "Patient";
  if (source === "governance") return "Governance";
  if (source === "external_public") return "External";
  return "Peer";
}

export function FeedbackHome() {
  const [data, setData] = useState<FeedbackHomePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<"by-doctor" | "all">("by-doctor");
  const [query, setQuery] = useState("");
  const [polarity, setPolarity] = useState<PolarityFilter>("all");
  const [severity, setSeverity] = useState<"" | Severity>("");
  const [status, setStatus] = useState<StatusFilter>("all");

  useEffect(() => {
    let cancelled = false;
    function load() {
      setLoading(true);
      fetch("/api/incidents/home")
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.ok) {
            setData(j as FeedbackHomePayload);
            setError("");
          } else {
            setError(j.error || "Could not load feedback");
          }
        })
        .catch(() => {
          if (!cancelled) setError("Could not load feedback");
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
  }, []);

  const headline = data?.headline;
  const stats: HeadlineStat[] = headline
    ? [
        { label: "Feedback total", value: String(headline.total), hint: "All polarity" },
        { label: "Negative", value: String(headline.negative), hint: "Open + closed", tone: "danger" },
        { label: "Positive", value: String(headline.positive), hint: "All sources", tone: "ok" },
        { label: "Physicians with feedback", value: String(headline.physicians_with_feedback), hint: "Of roster" },
        { label: "Active physicians", value: String(headline.roster_size), hint: "Roster size", tone: "muted" },
        { label: "Summaries", value: headline.summaries_label, hint: "Not generated yet", tone: "muted", compact: true },
      ]
    : [];

  const physicians = filterPhysicianRows(data?.physicians ?? [], { query, polarity, severity });
  const feed = filterFeedItems(data?.feed ?? [], { query, polarity, severity, status });
  const attention = data?.needs_attention ?? [];

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[1180px] px-6 py-8 lg:px-8">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight text-stone-900">
              Patient Feedback
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800">
                Live
              </span>
            </h1>
            <p className="mt-1 text-sm text-stone-500">
              Grouped by doctor. Summaries are not generated yet.
            </p>
          </div>
          <Link href="/incidents/new" className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">
            + Add feedback
          </Link>
        </div>

        {loading && !data ? (
          <div className="py-16 text-center text-sm text-stone-500">Loading…</div>
        ) : error && !data ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
        ) : (
          <>
            <HeadlineStrip stats={stats} />

            {attention.length > 0 && (
              <section className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3" aria-label="Needs attention">
                <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-red-800">
                  <span className="h-2 w-2 rounded-full bg-red-700 shadow-[0_0_0_3px_rgba(185,28,28,0.2)]" aria-hidden />
                  Needs attention — recent critical open feedback
                </div>
                <div className="flex flex-col gap-1.5">
                  {attention.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-[13px]">
                      <strong className="font-semibold text-stone-900">{item.physician_name}</strong>
                      <span className="text-[12px] text-stone-500">{item.specialty}</span>
                      <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-800">
                        {item.severity}
                      </span>
                      <span className="text-[12px] text-stone-500">{categoryLabel(item.category)}</span>
                      <span className="text-[12px] text-stone-500">{formatFeedbackDate(item.submitted_at)}</span>
                      <Link href={`/incidents/${item.id}`} className="ml-auto rounded-md bg-brand px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-brand-hover">
                        Open
                      </Link>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5" role="tablist" aria-label="Feedback view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "by-doctor"}
                  onClick={() => setView("by-doctor")}
                  className={
                    "rounded-md px-3 py-1.5 text-[13px] font-medium " +
                    (view === "by-doctor" ? "bg-brand text-white shadow-sm" : "text-stone-500 hover:text-stone-900")
                  }
                >
                  By doctor
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "all"}
                  onClick={() => setView("all")}
                  className={
                    "rounded-md px-3 py-1.5 text-[13px] font-medium " +
                    (view === "all" ? "bg-brand text-white shadow-sm" : "text-stone-500 hover:text-stone-900")
                  }
                >
                  All feedback
                </button>
              </div>

              <DoctorLookup
                options={(data?.physicians ?? []).map((p) => ({ id: p.physician_id, name: p.name, specialty: p.specialty }))}
                value={query}
                onChange={setQuery}
              />

              <div className="flex flex-wrap gap-1.5" aria-label="Polarity">
                {(
                  [
                    ["all", "All polarity"],
                    ["negative", "Negative"],
                    ["positive", "Positive"],
                  ] as Array<[PolarityFilter, string]>
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPolarity(value)}
                    className={
                      "rounded-full border px-2.5 py-1 text-[12px] font-medium " +
                      (polarity === value
                        ? "border-teal-200 bg-brand-soft text-[#0d5f58]"
                        : "border-stone-200 bg-white text-stone-600 hover:border-stone-300")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>

              <label className="inline-flex items-center gap-1.5 text-[12px] text-stone-500">
                <span className="sr-only">Severity</span>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as "" | Severity)}
                  aria-label="Severity"
                  className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[12px] font-medium text-stone-700"
                >
                  <option value="">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
            </div>

            {view === "by-doctor" ? (
              <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
                  <h2 className="text-[15px] font-semibold text-stone-900">
                    Physicians with feedback
                    <span className="ml-1.5 text-[12px] font-medium text-stone-500">· ordered by total</span>
                  </h2>
                  <span className="text-[12px] text-stone-500">{physicians.length} shown</span>
                </div>
                {physicians.length === 0 ? (
                  <div className="px-4 py-16 text-center text-sm text-stone-500">No physicians match these filters.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="bg-stone-50 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                          <th className="px-4 py-2.5 font-semibold">Physician</th>
                          <th className="px-4 py-2.5 font-semibold">Polarity</th>
                          <th className="px-4 py-2.5 font-semibold">Total</th>
                          <th className="px-4 py-2.5 font-semibold">Last activity</th>
                          <th className="px-4 py-2.5 font-semibold">Summary</th>
                          <th className="px-4 py-2.5 font-semibold"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {physicians.map((row) => (
                          <tr key={row.physician_id} className="border-t border-stone-200 hover:bg-stone-50">
                            <td className="px-4 py-3">
                              <div className="font-semibold text-stone-900">{row.name}</div>
                              <div className="text-[12px] text-stone-500">{row.specialty}</div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1.5">
                                <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">{row.positive} pos</span>
                                <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 text-[12px] font-semibold text-red-700">{row.negative} neg</span>
                              </div>
                            </td>
                            <td className="num px-4 py-3 font-bold text-stone-900">{row.total}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-stone-700">{formatFeedbackDate(row.last_activity)}</td>
                            <td className="px-4 py-3">
                              <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-stone-600">
                                {row.summary_label}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <Link
                                href={`/incidents/physician/${row.physician_id}`}
                                className="inline-flex rounded-md bg-brand px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-brand-hover"
                              >
                                Open
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : (
              <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
                  <h2 className="text-[15px] font-semibold text-stone-900">All feedback</h2>
                  <span className="text-[12px] text-stone-500">{feed.length} shown</span>
                </div>
                <div className="flex flex-wrap gap-1.5 border-b border-stone-100 px-4 py-2.5">
                  {(
                    [
                      ["all", "All"],
                      ["open", "Open"],
                      ["closed", "Closed"],
                      ["retracted", "Retracted"],
                    ] as Array<[StatusFilter, string]>
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setStatus(value)}
                      className={
                        "rounded-lg px-2.5 py-1 text-[12px] font-medium " +
                        (status === value ? "bg-stone-900 text-white" : "border border-stone-200 bg-white text-stone-700 hover:bg-stone-50")
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {feed.length === 0 ? (
                  <div className="px-4 py-16 text-center text-sm text-stone-500">No feedback matches these filters.</div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {feed.map((r) => (
                      <Link
                        key={r.id}
                        href={`/incidents/${r.id}`}
                        className={`block px-4 py-3.5 hover:bg-stone-50 ${r.status === "retracted" ? "opacity-70" : ""}`}
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${r.polarity === "positive" ? "bg-emerald-50 text-emerald-700" : "bg-stone-800 text-white"}`}>
                            {r.polarity === "positive" ? "Positive" : "Negative"}
                          </span>
                          <span className="inline-flex rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                            {sourceLabel(r.source)}
                          </span>
                          {r.polarity === "positive"
                            ? (r.commendation_category ? <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{r.commendation_category}</span> : null)
                            : <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${SEV_PILL[r.severity ?? ""] ?? "bg-stone-100 text-stone-700"}`}>{r.severity ?? "—"}</span>}
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[r.status] ?? "bg-stone-100 text-stone-700"}`}>{r.status}</span>
                          {r.polarity !== "positive" && (
                            <span className="rounded-full bg-stone-50 px-2 py-0.5 text-[11px] text-stone-500">{categoryLabel(r.category)}</span>
                          )}
                          {r.patient_rating != null && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">★ {r.patient_rating}/5</span>}
                        </div>
                        <div className={`mt-1.5 text-sm font-medium ${r.status === "retracted" ? "text-stone-500 line-through" : "text-stone-900"}`}>
                          {r.target_physician_name}
                          <span className="font-normal text-stone-500"> · {r.specialty}</span>
                          {r.hospital_code ? <span className="font-normal text-stone-500"> · {r.hospital_code}</span> : null}
                        </div>
                        {r.narrative_preview ? <div className="mt-0.5 truncate text-xs text-stone-500">{r.narrative_preview}</div> : null}
                        <div className="mt-1 text-[11px] text-stone-400">
                          {formatFeedbackDate(r.submitted_at)} · {timeAgo(r.submitted_at)} · {r.anonymous_flag ? "Anonymous" : "Identified"}
                          {!r.anonymous_flag && r.submitter_label ? ` · ${r.submitter_label}` : ""}
                          {r.reply_count > 0 ? ` · ${r.reply_count} ${r.reply_count === 1 ? "reply" : "replies"}` : ""}
                          {r.status === "retracted" && r.retraction_reason ? ` · retracted: ${r.retraction_reason}` : ""}
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
