"use client";

/**
 * EncountersListClient — Sprint 8 admin Encounters list.
 *
 * KPI strip + window selector + filter chips (V's Q1 lock: All/Sent/Failed/
 * Draft/Processing) + date-grouped table (V's Q3) + per-row 4-item action
 * menu (V's Q2: View/Resend/View trace/Delete) + page-based pagination
 * (V's Q4: 25/page).
 *
 * Row actions other than Delete navigate to /admin/encounters/[id] (with
 * ?action=resend or #pipeline anchor where relevant). Delete is inline —
 * confirm modal calls DELETE then refreshes.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";

type Bucket = "all" | "sent" | "failed" | "draft" | "processing";
type Window = "today" | "week" | "month" | "all";

type EncounterStatus =
  | "draft" | "processing" | "complete" | "failed" | "deleted" | "draft_partial";

type EncounterRow = {
  id: string;
  status: EncounterStatus;
  send_status: "pending" | "sent" | "failed";
  patient_label_raw: string | null;
  note_type: string | null;
  chief_complaint: string | null;
  recorded_at: string;
  duration_seconds: number | null;
  sent_at: string | null;
  doctor: { id: string; full_name: string; email: string; url_slug: string } | null;
  has_note: boolean;
  has_cdmss: boolean;
  delivered_count: number;
};
type Counts = {
  all: number; sent: number; failed: number; draft: number; processing: number;
  today: number; week: number; month: number;
};
type ListResp = {
  rows: EncounterRow[];
  total: number;
  counts: Counts;
  filter: { bucket: Bucket; window: Window; limit: number; offset: number };
};

const PAGE_SIZE = 25;

type DoctorOption = { id: string; full_name: string };

export function EncountersListClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Read ?doctor_id= from URL once at mount. We deliberately don't watch
  // searchParams across renders because we own the param and write to it
  // via router.replace below.
  const initialDoctorId = React.useMemo<string | null>(() => {
    const raw = searchParams?.get("doctor_id") ?? null;
    return raw && raw.startsWith("doc_") ? raw : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [bucket, setBucket] = React.useState<Bucket>("all");
  const [window, setWindow] = React.useState<Window>("month");
  const [offset, setOffset] = React.useState(0);
  const [noteTypeFilter, setNoteTypeFilter] = React.useState<string | null>(null);
  const [doctorId, setDoctorId] = React.useState<string | null>(initialDoctorId);
  const [doctors, setDoctors] = React.useState<DoctorOption[] | null>(null);
  const [data, setData] = React.useState<ListResp | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [actionMsg, setActionMsg] = React.useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<EncounterRow | null>(null);
  const [actionInflight, setActionInflight] = React.useState(false);

  // Fetch the doctor roster once for the filter dropdown. Cheap query
  // (small table), fire-and-forget. Soft-fails to "All doctors only".
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/doctors", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { doctors?: Array<{ id: string; full_name: string }> };
        if (cancelled) return;
        const list = (j.doctors ?? [])
          .map((d) => ({ id: String(d.id), full_name: String(d.full_name) }))
          .sort((a, b) => a.full_name.localeCompare(b.full_name));
        setDoctors(list);
      } catch { /* soft-fail */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Mirror doctorId into the URL (?doctor_id=) so the filter is shareable +
  // back/forward survivable. Replace, don't push, to avoid history pollution
  // as the user clicks chips.
  React.useEffect(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (doctorId) params.set("doctor_id", doctorId); else params.delete("doctor_id");
    const qs = params.toString();
    router.replace(qs ? `/admin/encounters?${qs}` : `/admin/encounters`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId]);

  const fetchOnce = React.useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("bucket", bucket);
      qs.set("window", window);
      qs.set("limit",  String(PAGE_SIZE));
      qs.set("offset", String(offset));
      if (doctorId) qs.set("doctor_id", doctorId);
      if (noteTypeFilter) qs.set("note_type", noteTypeFilter);
      const res = await fetch(`/api/admin/encounters?${qs.toString()}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setData(j as ListResp);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [bucket, window, offset, doctorId, noteTypeFilter]);

  React.useEffect(() => { void fetchOnce(); }, [fetchOnce]);

  // Close any open row menu when clicking elsewhere
  React.useEffect(() => {
    if (!openMenuId) return;
    const onClick = () => setOpenMenuId(null);
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [openMenuId]);

  const onChipChange = (b: Bucket) => { setBucket(b); setOffset(0); };
  const onWindowChange = (w: Window) => { setWindow(w); setOffset(0); };
  const onDoctorChange = (id: string | null) => { setDoctorId(id); setOffset(0); };
  const onNoteTypeChange = (nt: string | null) => { setNoteTypeFilter(nt); setOffset(0); };

  const selectedDoctor = React.useMemo<DoctorOption | null>(
    () => (doctorId && doctors ? doctors.find((d) => d.id === doctorId) ?? null : null),
    [doctorId, doctors],
  );

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setActionInflight(true);
    try {
      const res = await fetch(`/api/admin/encounters/${deleteTarget.id}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setActionMsg(`Encounter ${deleteTarget.id.slice(0, 14)}… soft-deleted.`);
      setDeleteTarget(null);
      await fetchOnce();
    } catch (e) {
      setActionMsg(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionInflight(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="text-body text-even-ink-700">
        {data ? (
          <>
            <span className="text-even-navy-800 font-semibold">{data.counts.today}</span> today ·{" "}
            <span className="text-even-navy-800 font-semibold">{data.counts.week}</span> this week ·{" "}
            <span className="text-even-navy-800 font-semibold">{data.counts.month}</span> this month
          </>
        ) : (
          <span className="text-even-ink-400">Loading counts…</span>
        )}
      </div>

      {actionMsg ? (
        <div className="rounded-md border border-even-blue-300 bg-even-blue-50 p-3 text-body text-even-navy-800 flex items-center justify-between">
          <span>{actionMsg}</span>
          <button type="button" onClick={() => setActionMsg(null)} className="text-caption text-even-ink-500 hover:underline">Dismiss</button>
        </div>
      ) : null}

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Window picker */}
        <div className="flex items-center gap-1 mr-2">
          {(["today","week","month","all"] as Window[]).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onWindowChange(w)}
              className={`px-2.5 py-1 rounded-md text-caption transition-colors ${
                window === w ? "bg-even-navy-800 text-even-white" : "bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
              }`}
            >
              {w === "today" ? "Today" : w === "week" ? "This week" : w === "month" ? "This month" : "All"}
            </button>
          ))}
        </div>

        {/* Bucket chips */}
        {(["all","sent","failed","draft","processing"] as Bucket[]).map((b) => {
          const n = data?.counts[b] ?? 0;
          return (
            <Chip key={b} active={bucket === b} onClick={() => onChipChange(b)}>
              {b === "all" ? "All" : b[0]!.toUpperCase() + b.slice(1)} · {n}
            </Chip>
          );
        })}

        {/* Note-type filter */}
        <div className="flex items-center gap-1 ml-2">
          <select
            value={noteTypeFilter ?? ""}
            onChange={(e) => onNoteTypeChange(e.target.value || null)}
            aria-label="Filter by note type"
            className="px-2.5 py-1 rounded-md text-caption bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200 border border-transparent focus:border-even-blue-400 focus:outline-none"
          >
            <option value="">All note types</option>
            <option value="clinic_encounter">Clinic</option>
            <option value="general_medical">General Medical</option>
            <option value="operative_procedure">Operative</option>
            <option value="dietetic_consult">Dietetic</option>
            <option value="physiotherapy">Physiotherapy</option>
          </select>
        </div>

        {/* Doctor filter */}
        <div className="flex items-center gap-1 ml-2">
          {selectedDoctor ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-caption bg-even-blue-100 text-even-blue-700">
              <span>Doctor: {selectedDoctor.full_name}</span>
              <button
                type="button"
                onClick={() => onDoctorChange(null)}
                aria-label="Clear doctor filter"
                className="text-even-blue-700 hover:text-danger-700"
              >
                ×
              </button>
            </span>
          ) : (
            <select
              value={doctorId ?? ""}
              onChange={(e) => onDoctorChange(e.target.value || null)}
              className="px-2.5 py-1 rounded-md text-caption bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200 border border-transparent focus:border-even-blue-400 focus:outline-none"
              disabled={!doctors}
            >
              <option value="">{doctors ? "All doctors" : "Loading doctors…"}</option>
              {(doctors ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.full_name}</option>
              ))}
            </select>
          )}
        </div>

        <button
          type="button"
          onClick={() => void fetchOnce()}
          className="ml-auto px-2.5 py-1 rounded-md text-caption bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
        >
          ↻ Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">
          Could not load encounters: {error}
        </div>
      ) : null}

      {/* Table */}
      <div className="rounded-xl border border-even-ink-100 bg-even-white overflow-hidden">
        <table className="w-full text-left">
          <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 bg-even-ink-50/40 border-b border-even-ink-100">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Patient</th>
              <th className="px-4 py-2.5 font-semibold">Doctor</th>
              <th className="px-4 py-2.5 font-semibold">Time</th>
              <th className="px-4 py-2.5 font-semibold text-right">Duration</th>
              <th className="px-4 py-2.5 font-semibold">Pipeline</th>
              <th className="px-4 py-2.5 font-semibold">Send</th>
              <th className="px-4 py-2.5 font-semibold w-12"></th>
            </tr>
          </thead>
          <tbody className="text-body">
            {loading && !data ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-even-ink-400">Loading…</td></tr>
            ) : data && data.rows.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-even-ink-400">No encounters in this window. Adjust filters to widen.</td></tr>
            ) : (
              groupByDate(data?.rows ?? []).flatMap((group) => [
                <tr key={`g-${group.key}`} className="bg-even-ink-50/60">
                  <td colSpan={7} className="px-4 py-1.5 text-[10px] uppercase tracking-[0.14em] text-even-ink-500 font-semibold">
                    {group.label} <span className="text-even-ink-400">· {group.rows.length} encounter{group.rows.length === 1 ? "" : "s"}</span>
                  </td>
                </tr>,
                ...group.rows.map((r) => (
                  <Row
                    key={r.id}
                    row={r}
                    isMenuOpen={openMenuId === r.id}
                    onMenuToggle={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === r.id ? null : r.id); }}
                    onRequestDelete={() => { setOpenMenuId(null); setDeleteTarget(r); }}
                  />
                )),
              ])
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.total > 0 ? (
        <div className="flex items-center justify-between text-caption text-even-ink-500">
          <span>
            Showing {offset + 1}–{Math.min(offset + data.rows.length, data.total)} of {data.total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-2.5 py-1 rounded-md bg-even-ink-100 hover:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >‹ Prev</button>
            <button
              type="button"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= data.total}
              className="px-2.5 py-1 rounded-md bg-even-ink-100 hover:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >Next ›</button>
          </div>
        </div>
      ) : null}

      {/* Delete confirm modal */}
      {deleteTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-even-navy-800/40" onClick={() => !actionInflight && setDeleteTarget(null)} role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-even-white p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-heading text-even-navy-800">Delete this encounter?</p>
            <p className="text-body text-even-ink-700">
              {deleteTarget.patient_label_raw ?? "(no patient label)"} ·{" "}
              <code className="font-mono">{deleteTarget.id}</code>
            </p>
            <p className="text-caption text-even-ink-500">
              Soft-delete clears note + transcript + CDMSS. Audio kept in R2 (PRD §4.17).
              Send history + audit log retained.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setDeleteTarget(null)} disabled={actionInflight}>Cancel</Button>
              <Button variant="destructive" onClick={() => void confirmDelete()} disabled={actionInflight}>
                {actionInflight ? "Deleting…" : "Yes, delete"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------- helpers ----------

function Row({
  row,
  isMenuOpen,
  onMenuToggle,
  onRequestDelete,
}: {
  row: EncounterRow;
  isMenuOpen: boolean;
  onMenuToggle: (e: React.MouseEvent) => void;
  onRequestDelete: () => void;
}) {
  const fmtTime = (iso: string) => {
    try { return new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" }); }
    catch { return iso; }
  };
  const fmtDur = (sec: number | null) => {
    if (sec == null) return "—";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  return (
    <tr className="border-t border-even-ink-100 hover:bg-even-ink-50/40 group">
      <td className="px-4 py-2">
        <Link href={`/admin/encounters/${row.id}`} className="block min-w-0">
          <NoteTypePill noteType={row.note_type} />
          {row.patient_label_raw ? (
            <>
              <p className="text-even-navy-800 truncate">{row.patient_label_raw}</p>
              {row.chief_complaint ? (
                <p className="text-caption text-even-ink-500 truncate">{row.chief_complaint}</p>
              ) : null}
            </>
          ) : row.chief_complaint ? (
            <p className="text-even-navy-800 truncate">{row.chief_complaint}</p>
          ) : (
            <p className="text-even-navy-800 truncate"><span className="text-even-ink-400">(no label)</span></p>
          )}
        </Link>
      </td>
      <td className="px-4 py-2 text-body text-even-ink-700">
        {row.doctor?.full_name ?? <span className="text-even-ink-400">(deleted)</span>}
      </td>
      <td className="px-4 py-2 text-caption text-even-ink-500 whitespace-nowrap" suppressHydrationWarning>
        {fmtTime(row.recorded_at)}
      </td>
      <td className="px-4 py-2 text-right font-mono text-caption text-even-ink-700">
        {fmtDur(row.duration_seconds)}
      </td>
      <td className="px-4 py-2">
        <PipelineBadge status={row.status} hasNote={row.has_note} hasCdmss={row.has_cdmss} />
      </td>
      <td className="px-4 py-2">
        <SendBadge status={row.send_status} count={row.delivered_count} />
      </td>
      <td className="px-4 py-2 relative">
        <button
          type="button"
          onClick={onMenuToggle}
          aria-label="Encounter actions"
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-even-ink-100 text-even-ink-500"
        >
          ⋯
        </button>
        {isMenuOpen ? (
          <div
            className="absolute right-2 top-9 z-20 min-w-[180px] rounded-md bg-even-white border border-even-ink-200 shadow-card overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <Link href={`/admin/encounters/${row.id}`} className="block px-3 py-2 text-body text-even-navy-800 hover:bg-even-ink-50">
              ◐ View encounter
            </Link>
            <Link
              href={`/admin/encounters/${row.id}?action=resend`}
              className="block px-3 py-2 text-body text-even-navy-800 hover:bg-even-ink-50"
              aria-disabled={row.status !== "complete" && row.status !== "draft_partial"}
              tabIndex={(row.status === "complete" || row.status === "draft_partial") ? 0 : -1}
            >
              ✉ Resend email
            </Link>
            <Link
              href={`/admin/traces?surface=&window=all&encounter_id=${row.id}#pipeline`}
              className="block px-3 py-2 text-body text-even-navy-800 hover:bg-even-ink-50"
            >
              ◈ View LLM trace
            </Link>
            <button
              type="button"
              onClick={onRequestDelete}
              className="block w-full text-left px-3 py-2 text-body text-danger-700 hover:bg-danger-100/40"
            >
              ⊗ Delete encounter
            </button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function PipelineBadge({ status, hasNote, hasCdmss }: { status: EncounterStatus; hasNote: boolean; hasCdmss: boolean }) {
  if (status === "processing") {
    return <span className="text-caption text-even-blue-700">Processing…</span>;
  }
  if (status === "draft_partial") {
    return <span className="text-caption text-amber-800">Partial · {hasNote ? "Note" : "—"} {hasCdmss ? "+ CDS" : ""}</span>;
  }
  if (status === "failed") {
    return <span className="text-caption text-danger-700">Failed</span>;
  }
  if (status === "draft") {
    return <span className="text-caption text-even-ink-500">Draft</span>;
  }
  if (status === "deleted") {
    return <span className="text-caption text-even-ink-400">Deleted</span>;
  }
  // complete
  const parts: string[] = [];
  if (hasNote) parts.push("Note");
  if (hasCdmss) parts.push("CDS");
  return <span className="text-caption text-even-ink-700">{parts.join(" + ") || "—"}</span>;
}

function SendBadge({ status, count }: { status: "pending" | "sent" | "failed"; count: number }) {
  if (status === "sent") {
    return <span className="text-caption text-success-700">◉ Sent · {count}</span>;
  }
  if (status === "failed") {
    return <span className="text-caption text-danger-700">⚠ Failed</span>;
  }
  return <span className="text-caption text-even-ink-500">○ Pending</span>;
}

function NoteTypePill({ noteType }: { noteType: string | null }) {
  if (!noteType || noteType === "clinic_encounter") return null;
  const label: Record<string, string> = {
    general_medical: "General Medical",
    operative_procedure: "Operative",
    dietetic_consult: "Dietetic",
    physiotherapy: "Physiotherapy",
  };
  return (
    <span className="inline-block mb-0.5 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-even-blue-50 text-even-blue-700">
      {label[noteType] ?? noteType}
    </span>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-caption transition-colors ${
        active ? "bg-even-navy-800 text-even-white" : "bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
      }`}
    >
      {children}
    </button>
  );
}

// Group rows into Today / Yesterday / Earlier this week / Earlier this month / Older
function groupByDate(rows: EncounterRow[]): Array<{ key: string; label: string; rows: EncounterRow[] }> {
  if (rows.length === 0) return [];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);

  const groups = [
    { key: "today",   label: "Today",                 rows: [] as EncounterRow[] },
    { key: "yest",    label: "Yesterday",             rows: [] as EncounterRow[] },
    { key: "week",    label: "Earlier this week",     rows: [] as EncounterRow[] },
    { key: "month",   label: "Earlier this month",    rows: [] as EncounterRow[] },
    { key: "older",   label: "Older",                 rows: [] as EncounterRow[] },
  ];

  for (const r of rows) {
    const d = new Date(r.recorded_at);
    if (d >= todayStart) groups[0]!.rows.push(r);
    else if (d >= yesterdayStart) groups[1]!.rows.push(r);
    else if (d >= weekAgo) groups[2]!.rows.push(r);
    else if (d >= monthAgo) groups[3]!.rows.push(r);
    else groups[4]!.rows.push(r);
  }

  return groups.filter((g) => g.rows.length > 0);
}
