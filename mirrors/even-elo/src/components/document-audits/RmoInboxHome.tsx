"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { HeadlineStrip, type HeadlineStat } from "@/components/shell/HeadlineStrip";
import {
  authorAttribution,
  PIPE_STATUSES,
  PIPE_STATUS_LABEL,
  type PipeStatus,
  type RmoInboxHeadline,
  type RmoWorkItem,
  type SgcExceptionItem,
} from "@/lib/document-audits";

const HOSPITAL_EVENT = "epi-hospital-filter";

const SEV_PILL: Record<string, string> = {
  critical: "bg-red-50 text-red-800",
  high: "bg-orange-50 text-orange-800",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-stone-100 text-stone-700",
};

interface InboxPayload {
  ok: boolean;
  role: "rmo" | "sgc";
  can_sgc: boolean;
  headline: RmoInboxHeadline;
  pipe_counts?: Record<PipeStatus, number>;
  items: RmoWorkItem[];
  exceptions: SgcExceptionItem[];
  remediator_model?: string;
  error?: string;
}

export function RmoInboxHome() {
  const [data, setData] = useState<InboxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pipe, setPipe] = useState<PipeStatus>("open");
  const [role, setRole] = useState<"rmo" | "sgc">("rmo");
  const [query, setQuery] = useState("");
  const [rev, setRev] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function postAction(path: string, findingId: string) {
    setBusyId(findingId);
    setError("");
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ finding_id: findingId }),
      });
      const j = await r.json();
      if (!j.ok) setError(j.error || "Could not update this finding");
      else setRev((n) => n + 1);
    } catch {
      setError("Could not update this finding");
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    function load() {
      setLoading(true);
      const qs = new URLSearchParams({ pipe, role, q: query });
      fetch(`/api/rmo-inbox?${qs.toString()}`)
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.ok) {
            setData(j as InboxPayload);
            setError("");
            if (j.role === "sgc" || j.role === "rmo") setRole(j.role);
          } else {
            setError(j.error || "Could not load RMO inbox");
          }
        })
        .catch(() => {
          if (!cancelled) setError("Could not load RMO inbox");
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
  }, [pipe, role, query, rev]);

  const headline = data?.headline;
  const stats: HeadlineStat[] = headline
    ? [
        { label: "Open", value: String(headline.open), hint: "Awaiting physician response" },
        { label: "In progress", value: String(headline.in_progress), hint: "Active work" },
        {
          label: "Escalated",
          value: String(headline.escalated),
          hint: "Needs SGC",
          tone: headline.escalated > 0 ? "danger" : "default",
        },
        {
          label: "SLA breach risk",
          value: String(headline.sla_risk),
          hint: "Open age ↑",
          tone: headline.sla_risk > 0 ? "danger" : "default",
        },
        {
          label: "Hospital",
          value: headline.hospital_label,
          hint: "Switcher first-class",
          tone: "muted",
          compact: true,
        },
      ]
    : [];

  const pipeCounts: Record<PipeStatus, number> = data?.pipe_counts ?? {
    open: headline?.open ?? 0,
    in_progress: headline?.in_progress ?? 0,
    remediated: 0,
    contested: 0,
    escalated: headline?.escalated ?? 0,
  };
  const items = data?.items ?? [];
  const exceptions = data?.exceptions ?? [];

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[1240px] px-6 py-8 lg:px-8">
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px] text-stone-500">
          <Link href="/overview" className="font-medium text-brand hover:underline">
            Governance
          </Link>
          <span className="text-stone-400">/</span>
          <Link href="/document-audits" className="font-medium text-brand hover:underline">
            Document Audits
          </Link>
          <span className="text-stone-400">/</span>
          <span className="font-semibold text-stone-900">RMO Inbox</span>
        </div>

        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight text-stone-900">
              RMO Inbox
              <span className="inline-flex items-center rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-800">
                Viewing as · {role === "sgc" ? "SGC" : "RMO"}
              </span>
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-500">
              Pipe-to-people authoring queue — Open → In progress → Remediated / Contested / Escalated.
              RMOs write findings (attribution required). Doctors with portal access remediate — no
              RMO-as-fixer assignment.
            </p>
          </div>
          {data?.can_sgc ? (
            <div className="inline-flex rounded-lg border border-stone-200 bg-white p-1">
              <button
                type="button"
                className={
                  "rounded-md px-3 py-1.5 text-[12.5px] font-semibold " +
                  (role === "rmo" ? "bg-brand text-white" : "text-stone-600 hover:bg-stone-50")
                }
                onClick={() => setRole("rmo")}
              >
                RMO
              </button>
              <button
                type="button"
                className={
                  "rounded-md px-3 py-1.5 text-[12.5px] font-semibold " +
                  (role === "sgc" ? "bg-brand text-white" : "text-stone-600 hover:bg-stone-50")
                }
                onClick={() => setRole("sgc")}
              >
                SGC
              </button>
            </div>
          ) : null}
        </div>

        <div className="mb-4 rounded-[10px] border border-dashed border-teal-200 bg-teal-50/60 px-4 py-3 text-[12.5px] text-teal-950">
          <strong>Ownership model (locked):</strong> Author = RMO (always named). Remediator = target
          physician via doctor portal. This inbox is not an “assign RMO to fix” queue.
        </div>

        {headline?.honesty === "stale" ? (
          <div className="mb-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-950">
            <strong>Stale queue.</strong> Status sync older than freshness window — treat counts as
            last-known.
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
        ) : null}

        <HeadlineStrip stats={stats} />

        <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="RMO status pipe">
          {PIPE_STATUSES.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={pipe === p}
              onClick={() => setPipe(p)}
              className={
                "min-w-[110px] flex-1 rounded-[10px] border px-3 py-2.5 text-left " +
                (pipe === p
                  ? "border-brand bg-teal-50 shadow-[0_0_0_1px_#0d5f58]"
                  : "border-stone-200 bg-white hover:border-teal-200 hover:bg-teal-50/40")
              }
            >
              <div className="text-lg font-bold tracking-tight">{pipeCounts[p]}</div>
              <div className="text-[11.5px] font-semibold text-stone-500">{PIPE_STATUS_LABEL[p]}</div>
            </button>
          ))}
        </div>

        <div className={"grid gap-4 " + (role === "sgc" ? "lg:grid-cols-[1.35fr_0.9fr]" : "lg:grid-cols-1")}>
          <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">
                  {PIPE_STATUS_LABEL[pipe]} — {role === "rmo" ? "authoring queue" : "pipe list"}
                </h2>
                <p className="text-[11.5px] text-stone-500">
                  Human-readable findings · RMO author named · remediator on each card
                </p>
              </div>
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
                {items.length} items
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 bg-stone-50 px-4 py-2.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-stone-500">Doctor</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by doctor / physician_id"
                className="min-w-[180px] flex-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[13px]"
              />
              <Link
                href="/document-audits"
                className="rounded-lg px-2 py-1.5 text-[12px] font-medium text-brand hover:underline"
              >
                Audits home
              </Link>
            </div>
            {loading ? (
              <div className="px-4 py-12 text-center text-sm text-stone-500">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-14 text-center">
                <div className="text-[0.98rem] font-semibold text-stone-900">Nothing in this pipe stage</div>
                <p className="mx-auto mt-1.5 max-w-md text-[13px] text-stone-500">
                  Honest empty — prefer this over hunting a dashboard when no findings are authored yet.
                </p>
              </div>
            ) : (
              <ul>
                {items.map((item) => (
                  <li key={item.finding_id} className="border-b border-stone-100 px-4 py-3.5 last:border-0 hover:bg-stone-50">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 font-semibold text-stone-900">{item.finding_label}</div>
                      <span className={"shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold " + SEV_PILL[item.severity]}>
                        {item.severity}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-stone-500">
                      <Link href={`/physicians/${item.physician_id}?tab=documentation`} className="font-medium text-brand hover:underline">
                        {item.physician_name}
                      </Link>
                      <span className="mx-1 text-stone-300">·</span>
                      {item.doc_type_label}
                      <span className="mx-1 text-stone-300">·</span>
                      {item.hospital_code}
                      <span className="mx-1 text-stone-300">·</span>
                      {item.open_age_days}d open
                    </div>
                    <div className="mt-1.5 text-[12px] text-stone-600">
                      <strong>{authorAttribution(item.authored_by_name)}</strong>
                      <span className="mx-1 text-stone-300">·</span>
                      {item.remediator_note}
                      {item.signal_reference ? (
                        <span className="ml-1 text-stone-500">· {item.signal_reference}</span>
                      ) : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busyId === item.finding_id}
                        onClick={() => postAction("/api/rmo-inbox/author", item.finding_id)}
                        className="rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-stone-700 disabled:opacity-50"
                      >
                        {item.author_pending ? "Confirm author" : "Reconfirm author"}
                      </button>
                      {item.portal_visible ? (
                        <span className="rounded-md bg-teal-50 px-1.5 py-0.5 text-[11px] font-semibold text-teal-800">
                          On doctor portal
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busyId === item.finding_id}
                          onClick={() => postAction("/api/rmo-inbox/release", item.finding_id)}
                          className="rounded-lg border border-brand bg-brand/10 px-2.5 py-1 text-[12px] font-semibold text-brand disabled:opacity-50"
                        >
                          Release to portal
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {role === "sgc" ? (
            <aside className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
              <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">SGC exception queue</h2>
                  <p className="text-[11.5px] text-stone-500">Severity × recurrence × open age</p>
                </div>
                <span className="rounded-md bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-orange-800">
                  Work surface
                </span>
              </div>
              {exceptions.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-stone-500">No exceptions — queue empty.</div>
              ) : (
                <ul>
                  {exceptions.map((ex) => (
                    <li key={ex.finding_id} className="border-b border-stone-100 px-3.5 py-3 last:border-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-semibold text-stone-900">{ex.finding_label}</div>
                        <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[11px] font-bold text-orange-900">
                          score {ex.exception_score}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11.5px] text-stone-500">
                        <code className="rounded bg-stone-100 px-1">sev {ex.severity}</code>
                        <code className="rounded bg-stone-100 px-1">recurrence {ex.recurrence_count}</code>
                        <code className="rounded bg-stone-100 px-1">age {ex.open_age_days}d</code>
                      </div>
                      <div className="mt-1 text-[12px] text-stone-500">
                        {ex.physician_name} · {ex.hospital_code} · authored by {ex.authored_by_name}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          ) : null}
        </div>

        <div className="mt-4 rounded-[10px] border border-dashed border-stone-300 bg-stone-50 px-4 py-3 text-[12.5px] text-stone-600">
          <strong className="text-stone-800">Not this queue:</strong> Patient Feedback incidents, e-IRIS / ISS,
          nursing grievance stay in their modules.
        </div>
      </main>
    </>
  );
}
