"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { FindingsTable } from "@/components/audit-findings/FindingsTable";
import {
  BUCKET_LABEL,
  responseRequiredText,
  type Bucket,
  type BucketCounts,
  type FindingRow,
} from "@/lib/audit-findings";

interface Options {
  doctors: Array<{ uid: string; name: string }>;
  importances: string[];
  response_required: string[];
  statuses: string[];
  note_classes: Array<{ value: string; label: string }>;
}

interface Payload {
  ok: boolean;
  counts?: BucketCounts;
  sync?: { not_synced: number; failed: number; rulings_pending: number };
  rows?: FindingRow[];
  options?: Options;
  message?: string;
  error?: string;
}

const STATUS_WORDS: Record<string, string> = {
  routed: "Routed (awaiting doctor)",
  responded: "Doctor responded",
  escalated: "Escalated (awaiting ruling)",
  ruled: "Ruled",
  closed: "Closed",
};

const TILE_ORDER: Bucket[] = ["attention", "overdue", "disagreed", "awaiting_ruling", "awaiting_doctor", "all"];

export function AuditFindingsWorklist() {
  const [view, setView] = useState<Bucket>("attention");
  const [status, setStatus] = useState("");
  const [importance, setImportance] = useState("");
  const [responseRequired, setResponseRequired] = useState("");
  const [noteClass, setNoteClass] = useState("");
  const [doctor, setDoctor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ view });
    if (status) qs.set("status", status);
    if (importance) qs.set("importance", importance);
    if (responseRequired) qs.set("response_required", responseRequired);
    if (noteClass) qs.set("note_class", noteClass);
    if (doctor) qs.set("doctor_uid", doctor);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    setLoading(true);
    fetch(`/api/audit-findings?${qs.toString()}`)
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Payload }))
      .then(({ status: code, body }) => {
        if (body.ok) {
          setData(body);
          setFailed(null);
        } else if (code === 403 || code === 401) {
          setFailed("You do not have access to Audit findings. Ask a super admin, Site Medical Head or Site Governance Officer.");
        } else {
          setFailed(body.message ?? "The worklist could not be loaded.");
        }
      })
      .catch(() => setFailed("The worklist could not be loaded."))
      .finally(() => setLoading(false));
  }, [view, status, importance, responseRequired, noteClass, doctor, from, to]);

  useEffect(load, [load]);

  const counts = data?.counts;
  const options = data?.options;
  const rows = data?.rows ?? [];
  const filtered = !!(status || importance || responseRequired || noteClass || doctor || from || to);

  const selectCls = "rounded-md border border-stone-200 bg-white px-2 py-1.5 text-[12.5px] text-stone-800";

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[1400px] px-6 py-8 lg:px-8">
        <div className="mb-3 flex items-center gap-1.5 text-[13px] text-stone-500">
          <Link href="/overview" className="font-medium text-brand hover:underline">Governance</Link>
          <span className="text-stone-400">/</span>
          <span className="font-semibold text-stone-900">Audit findings</span>
        </div>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[1.55rem] font-bold tracking-tight text-stone-900">Audit findings</h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-500">
              Every finding the quality team routed to a doctor, across all doctors. The default view shows what needs a
              decision: overdue threads, doctors who disagreed, and threads waiting for a ruling.
            </p>
          </div>
          <Link
            href="/audit-findings/mapping"
            className="rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-stone-700 hover:bg-stone-50"
          >
            Doctor mapping review
          </Link>
        </div>

        {data?.sync && data.sync.not_synced > 0 ? (
          <div
            role="status"
            className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-950"
          >
            <span className="num font-semibold">{data.sync.not_synced}</span>{" "}
            {data.sync.not_synced === 1 ? "doctor answer is" : "doctor answers are"} not yet synced to CDMSS
            {data.sync.failed > 0 ? ` (${data.sync.failed} failed to send)` : ""}. They are marked{" "}
            <span className="font-semibold">Not yet synced</span> below and retried every night.
          </div>
        ) : null}
        {data?.sync && data.sync.rulings_pending > 0 ? (
          <div
            role="status"
            className="mb-4 rounded-lg border border-violet-200 bg-violet-50 px-4 py-2.5 text-[13px] text-violet-950"
          >
            <span className="num font-semibold">{data.sync.rulings_pending}</span>{" "}
            {data.sync.rulings_pending === 1 ? "ruling is" : "rulings are"} saved here but not confirmed by CDMSS yet. They are marked{" "}
            <span className="font-semibold">Pending sync</span> below, are not applied until CDMSS confirms, and are retried every night.
          </div>
        ) : null}

        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {TILE_ORDER.map((b) => {
            const active = view === b;
            return (
              <button
                key={b}
                type="button"
                onClick={() => setView(b)}
                className={
                  "rounded-xl border px-3 py-2.5 text-left transition " +
                  (active ? "border-brand bg-brand-soft" : "border-stone-200 bg-white hover:bg-stone-50")
                }
              >
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-stone-500">{BUCKET_LABEL[b]}</div>
                <div className="num text-2xl font-semibold text-stone-900">
                  {counts ? counts[b] : "…"}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2.5">
          <select className={selectCls} value={doctor} onChange={(e) => setDoctor(e.target.value)} aria-label="Doctor">
            <option value="">All doctors</option>
            {(options?.doctors ?? []).map((d) => (
              <option key={d.uid} value={d.uid}>{d.name}</option>
            ))}
          </select>
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            {(options?.statuses ?? []).map((s) => (
              <option key={s} value={s}>{STATUS_WORDS[s] ?? s}</option>
            ))}
          </select>
          <select className={selectCls} value={importance} onChange={(e) => setImportance(e.target.value)} aria-label="Importance">
            <option value="">Any importance</option>
            {(options?.importances ?? []).map((s) => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
          <select className={selectCls} value={responseRequired} onChange={(e) => setResponseRequired(e.target.value)} aria-label="Response required">
            <option value="">Any response ask</option>
            {(options?.response_required ?? []).map((s) => (
              <option key={s} value={s}>{responseRequiredText(s)}</option>
            ))}
          </select>
          <select className={selectCls} value={noteClass} onChange={(e) => setNoteClass(e.target.value)} aria-label="Note type">
            <option value="">All note types</option>
            {(options?.note_classes ?? []).map((n) => (
              <option key={n.value} value={n.value}>{n.label}</option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[12px] text-stone-500">
            Routed from
            <input type="date" className={selectCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex items-center gap-1 text-[12px] text-stone-500">
            to
            <input type="date" className={selectCls} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {filtered ? (
            <button
              type="button"
              className="text-[12px] font-semibold text-brand hover:underline"
              onClick={() => {
                setStatus("");
                setImportance("");
                setResponseRequired("");
                setNoteClass("");
                setDoctor("");
                setFrom("");
                setTo("");
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>

        <section className="rounded-xl border border-stone-200 bg-white px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {BUCKET_LABEL[view]}{" "}
              <span className="ml-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600">{loading ? "…" : rows.length}</span>
            </h2>
            <button type="button" onClick={load} className="text-[12px] font-semibold text-brand hover:underline">Refresh</button>
          </div>
          {failed ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-950">{failed}</div>
          ) : loading && !data ? (
            <div className="py-8 text-center text-sm text-stone-400">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-stone-500">
              {view === "attention" && !filtered ? "Nothing needs attention right now." : "No threads match."}
            </div>
          ) : (
            <FindingsTable rows={rows} showDoctor />
          )}
        </section>
      </main>
    </>
  );
}
