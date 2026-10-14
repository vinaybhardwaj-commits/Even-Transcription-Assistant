"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { CaptureBanner, HospitalSwitcher } from "@/components/capture/CaptureChrome";
import { SurgicalCaptureNav } from "@/components/capture/SurgicalCaptureNav";
import { ABX_ON_TIME_LABEL } from "@/lib/capture/sheet-form";

interface SheetItem {
  id: string;
  surgery_date_label: string;
  ot_no: string | null;
  surgeon_name: string | null;
  surgery_name: string | null;
  patient_name: string | null;
  review_status: string;
  abx_label: string;
  abx_on_time: boolean;
}

interface SheetStats {
  sheets_today: number;
  needs_review: number;
  approved: number;
  abx_label: string;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "pending_human", label: "pending_human" },
  { id: "approved", label: "approved" },
  { id: "rejected", label: "rejected" },
] as const;

export function SheetsClient() {
  const [hospital, setHospital] = useState("EHRC");
  const [review, setReview] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [q, setQ] = useState("");
  const [stats, setStats] = useState<SheetStats | null>(null);
  const [rows, setRows] = useState<SheetItem[]>([]);
  const [ocr, setOcr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ hospital, review, q });
    fetch(`/api/capture/sheets?${params.toString()}`)
      .then((response) => response.json())
      .then((json: { ok?: boolean; error?: string; stats?: SheetStats; sheets?: SheetItem[]; ocr_enabled?: boolean }) => {
        if (cancelled) return;
        if (!json.ok) {
          setError(json.error || "Could not load OT sheets.");
          setRows([]);
          return;
        }
        setError(null);
        setStats(json.stats ?? null);
        setRows(json.sheets ?? []);
        setOcr(json.ocr_enabled === true);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load OT sheets.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hospital, review, q]);

  const cards = [
    { label: "Sheets today", value: stats ? String(stats.sheets_today) : "—", hint: "Surgery date is today · IST" },
    { label: "Needs review", value: stats ? String(stats.needs_review) : "—", hint: "pending_human", warn: (stats?.needs_review ?? 0) > 0 },
    { label: "Approved", value: stats ? String(stats.approved) : "—", hint: "Human gate", ok: (stats?.approved ?? 0) > 0 },
    { label: "Abx on-time", value: stats?.abx_label ?? "—", hint: "≤60m before incision" },
  ];

  return (
    <>
      <TopNav />
      <CaptureBanner kicker="Stage 2" note="human review" />
      <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5 sm:px-6">
        <span className="rounded-full border border-stone-200 bg-stone-100 px-3 py-1 text-[12px] font-medium text-stone-600">
          <strong className="font-semibold text-[#0d5f58]">HF draft</strong>
          <span> · Stage 2 · ot-sheets</span>
        </span>
        <HospitalSwitcher value={hospital} onChange={setHospital} />
      </div>
      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-7">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-stone-500">
          <Link href="/surgical-governance" className="font-medium text-brand hover:underline">
            Surgical Governance
          </Link>
          <span>/</span>
          <span className="font-semibold text-stone-900">OT sheets</span>
        </div>
        <SurgicalCaptureNav current="sheets" />
        <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight">
          OT sheets
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-800">
            Stage 2
          </span>
        </h1>
        <p className="mb-5 mt-1 max-w-3xl text-sm leading-relaxed text-stone-500">
          Extracted OT Tracking Sheets. Antibiotic timing badge and review status. A sheet stays pending until a person
          approves or rejects it. Case link arrives in Stage 3.
        </p>

        {!ocr && (
          <div className="mb-4 rounded-xl border border-dashed border-teal-300 bg-teal-50 px-4 py-3 text-sm leading-relaxed text-teal-900">
            <strong className="text-brand">FEATURE_OT_CAPTURE_OCR is off.</strong> Queued photos are not sent to Vertex.
            Any sheet already extracted can still be reviewed here.
          </div>
        )}

        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {cards.map((card) => (
            <div key={card.label} className="rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-sm">
              <div className="text-[12px] text-stone-500">{card.label}</div>
              <div
                className={
                  "mt-1 text-[1.55rem] font-bold leading-none tracking-tight " +
                  (card.warn ? "text-amber-700" : card.ok ? "text-emerald-700" : "text-stone-900")
                }
              >
                {card.value}
              </div>
              <div className="mt-1 text-[11px] text-stone-500">{card.hint}</div>
            </div>
          ))}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="relative min-w-[220px] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">⌕</span>
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search surgeon, procedure, OT#…"
              className="w-full rounded-full border border-stone-200 bg-white py-2 pl-8 pr-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft"
            />
          </label>
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setReview(item.id)}
              className={
                "rounded-full border px-3 py-1 text-[13px] font-medium " +
                (review === item.id
                  ? "border-brand bg-brand text-white"
                  : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50")
              }
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
            <h2 className="font-mono text-[15px] font-semibold">gov_ot_tracking_sheets</h2>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
              {hospital} · {rows.length} shown
            </span>
          </div>
          {error && <p className="px-4 py-6 text-sm text-red-800">{error}</p>}
          {!error && loading && <p className="px-4 py-6 text-sm text-stone-500">Loading OT sheets…</p>}
          {!error && !loading && rows.length === 0 && (
            <div className="px-6 py-10 text-center">
              <div className="text-base font-semibold">No OT sheets yet</div>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-stone-500">
                Photos stay on the capture queue until OCR extracts an OT tracking sheet. Nothing here is written to a
                surgical case.
              </p>
              <Link href="/surgical-governance/capture-queue" className="mt-4 inline-block text-sm font-semibold text-brand hover:underline">
                Open capture queue
              </Link>
            </div>
          )}
          {!error && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-stone-200 text-[11px] uppercase tracking-wide text-stone-500">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Date</th>
                    <th className="px-3 py-2 font-semibold">OT#</th>
                    <th className="px-3 py-2 font-semibold">Surgeon</th>
                    <th className="px-3 py-2 font-semibold">Procedure</th>
                    <th className="px-3 py-2 font-semibold">Patient</th>
                    <th className="px-3 py-2 font-semibold">Antibiotic</th>
                    <th className="px-3 py-2 font-semibold">Review</th>
                    <th className="px-4 py-2 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-stone-100 last:border-b-0">
                      <td className="whitespace-nowrap px-4 py-3">{row.surgery_date_label}</td>
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-[13px]">{row.ot_no || "—"}</td>
                      <td className="px-3 py-3 font-medium">{row.surgeon_name || "—"}</td>
                      <td className="px-3 py-3">{row.surgery_name || "—"}</td>
                      <td className="px-3 py-3">{row.patient_name || "—"}</td>
                      <td className="px-3 py-3">
                        <AbxChip label={row.abx_label} onTime={row.abx_on_time} />
                      </td>
                      <td className="px-3 py-3">
                        <ReviewChip status={row.review_status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/surgical-governance/ot-sheets/${row.id}`}
                          className="inline-block rounded-lg border border-stone-200 bg-white px-3 py-1 text-[13px] font-semibold text-stone-800 no-underline hover:bg-stone-50"
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
        </div>
        <p className="mt-4 text-xs text-stone-500">
          {ABX_ON_TIME_LABEL} means the antibiotic clock is 0–60 minutes before incision. Unreadable times count as late
          or unclear. Approved sheets are still not linked to a surgical case.
        </p>
      </main>
    </>
  );
}

export function AbxChip({ label, onTime }: { label: string; onTime: boolean }) {
  return (
    <span
      className={
        "inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide " +
        (onTime ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800")
      }
    >
      {label}
    </span>
  );
}

export function ReviewChip({ status }: { status: string }) {
  const tone =
    status === "approved"
      ? "bg-emerald-100 text-emerald-800"
      : status === "rejected"
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-900";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}>
      {status}
    </span>
  );
}
