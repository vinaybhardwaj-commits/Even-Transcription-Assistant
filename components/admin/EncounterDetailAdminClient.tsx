"use client";

/**
 * EncounterDetailAdminClient — Sprint 7 admin Encounter detail page.
 *
 * Fetches /api/admin/encounters/{id} on mount, renders:
 *   - Hero (patient label + doctor + recorded time + duration + status + ID)
 *   - Pipeline trace strip (Recording → Note → CDS → Email)
 *   - 5 tabs (Note / Transcript / CDMSS / Send / Audit)
 *   - Right rail (SEND STATUS / AUDIT LOG / DANGER ZONE)
 *   - Resend modal (recipient picker — V's Q3 lock)
 *   - Delete confirm modal (soft tombstone — V's Q4 lock)
 *
 * Reuses NoteView + CdmssCard from the doctor side so the rendered note
 * and CDS card look identical in both contexts.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { NoteView } from "@/components/encounter/NoteView";
import { CdmssCard } from "@/components/encounter/CdmssCard";
import type { EncounterNote } from "@/lib/note-generation";
import type { CdmssOutput } from "@/lib/cdmss-stub";

type TraceStatus = "in_progress" | "completed" | "errored" | "aborted";
type SendStatus = "pending" | "sent" | "failed";
type EncounterStatus =
  | "draft" | "processing" | "complete" | "failed" | "deleted" | "draft_partial";

type TraceEventLog = {
  ts: number;
  stage: string;
  msg: string;
  ms?: number;
  done?: boolean;
  error?: boolean;
};
type ModelCall = {
  model: string;
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
};
type SendEventRow = {
  id: string;
  recipient_email: string;
  status: string;
  subject_rendered: string | null;
  resend_message_id: string | null;
  failure_reason: string | null;
  updated_at: string | null;
  opened_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  created_at: string;
};
type AuditLogRow = {
  id: string;
  actor_type: "admin" | "doctor" | "system";
  actor_id: string | null;
  action: string;
  metadata_json: unknown;
  created_at: string;
};
type LlmTrace = {
  id: string;
  surface: string;
  status: TraceStatus;
  total_ms: number | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  events: TraceEventLog[];
  model_calls: ModelCall[];
};
type EncounterFull = {
  id: string;
  status: EncounterStatus;
  send_status: SendStatus;
  patient_label_raw: string | null;
  recorded_at: string;
  duration_seconds: number | null;
  transcript_raw: string | null;
  transcript_clean: string | null;
  note_json: EncounterNote | null;
  note_json_edited: EncounterNote | null;
  cdmss_json: CdmssOutput | null;
  audio_object_key: string | null;
  audio_bytes: number | null;
  sent_at: string | null;
  deleted_at: string | null;
  doctor: { id: string; full_name: string; email: string; url_slug: string } | null;
  send_events: SendEventRow[];
  audit_log: AuditLogRow[];
  llm_traces: LlmTrace[];
};
type RecipientCandidate = {
  id: string;
  email: string;
  name: string;
  role: string;
};
type FetchResp = {
  encounter: EncounterFull;
  recipient_candidates: {
    per_doctor: RecipientCandidate[];
    global: RecipientCandidate[];
  };
};

type TabKey = "note" | "transcript" | "cdmss" | "send" | "audit";

const TAB_ORDER: TabKey[] = ["note", "transcript", "cdmss", "send", "audit"];
const TAB_LABEL: Record<TabKey, string> = {
  note: "Note",
  transcript: "Transcript",
  cdmss: "CDMSS",
  send: "Send",
  audit: "Audit log",
};

export function EncounterDetailAdminClient({ encounterId }: { encounterId: string }) {
  const router = useRouter();
  const [data, setData] = React.useState<FetchResp | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<TabKey>("note");
  const [showResend, setShowResend] = React.useState(false);
  const [showDelete, setShowDelete] = React.useState(false);
  const [actionInflight, setActionInflight] = React.useState(false);
  const [actionMsg, setActionMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/encounters/${encounterId}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setData(j as FetchResp);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [encounterId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Sprint 8 deep-link support: /admin/encounters/[id]?action=resend
  // auto-opens the ResendModal once data has loaded.
  const searchParams = useSearchParams();
  const autoOpenedRef = React.useRef(false);
  React.useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!data) return;
    if (searchParams?.get("action") === "resend") {
      const enc = data.encounter;
      if (enc.status === "complete" || enc.status === "draft_partial") {
        autoOpenedRef.current = true;
        setShowResend(true);
      }
    }
  }, [data, searchParams]);

  const enc = data?.encounter ?? null;
  const noteFinal = enc?.note_json_edited ?? enc?.note_json ?? null;

  // Format helpers
  const fmtMs = (ms: number | null | undefined) => {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  const fmtDur = (sec: number | null) => {
    if (sec == null) return "—";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const fmtBytes = (b: number | null) => {
    if (b == null) return "—";
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  };
  const fmtDate = (iso: string | null) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const onConfirmDelete = React.useCallback(async () => {
    setActionInflight(true);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/admin/encounters/${encounterId}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setActionMsg("Encounter soft-deleted. Note + transcript cleared; audio retained in R2.");
      setShowDelete(false);
      await load();
    } catch (e) {
      setActionMsg(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionInflight(false);
    }
  }, [encounterId, load]);

  if (loading && !data) return <p className="text-body text-even-ink-500">Loading…</p>;
  if (error) return <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">Could not load encounter: {error}</div>;
  if (!enc) return null;

  // ---------- Render ----------
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin" className="text-caption text-even-blue-600 hover:underline">‹ Back to admin</Link>
      </div>

      {actionMsg ? (
        <div className="rounded-md border border-even-blue-300 bg-even-blue-50 p-3 text-body text-even-navy-800">
          {actionMsg}
          <button
            type="button"
            onClick={() => setActionMsg(null)}
            className="ml-3 text-caption text-even-ink-500 hover:underline"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Hero */}
      <div className="rounded-xl border border-even-ink-100 bg-even-white p-5 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-heading text-even-navy-800">
              {enc.patient_label_raw ?? "(no patient label)"}
            </h2>
            <StatusBadge status={enc.status} />
          </div>
          <p className="text-caption text-even-ink-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5" suppressHydrationWarning>
            {enc.doctor ? (
              <span><strong className="text-even-ink-700">{enc.doctor.full_name}</strong></span>
            ) : null}
            <span>{fmtDate(enc.recorded_at)}</span>
            <span>{fmtDur(enc.duration_seconds)} duration</span>
            <code className="font-mono">{enc.id}</code>
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <span className={`text-caption ${
            enc.send_status === "sent" ? "text-success-700" :
            enc.send_status === "failed" ? "text-danger-700" :
            "text-even-ink-500"
          }`}>
            ● {enc.send_status === "sent" ? `Sent · ${enc.send_events.filter(s=>s.status==='sent'||s.status==='delivered'||s.status==='opened').length} recipients` :
                enc.send_status === "failed" ? "Send failed" : "Not sent"}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowResend(true)}
            disabled={enc.status !== "complete" && enc.status !== "draft_partial"}
          >
            ⟳ Resend
          </Button>
        </div>
      </div>

      {/* Pipeline trace strip */}
      <PipelineStrip enc={enc} fmtMs={fmtMs} />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-6">
        {/* Tabs column */}
        <div className="space-y-4">
          <div className="flex gap-1 border-b border-even-ink-100">
            {TAB_ORDER.map((t) => {
              const count = (() => {
                if (t === "send") return enc.send_events.length;
                if (t === "audit") return enc.audit_log.length;
                if (t === "cdmss") {
                  const ddx = (enc.cdmss_json as { differentials_to_consider?: unknown[] } | null)?.differentials_to_consider ?? [];
                  return Array.isArray(ddx) ? ddx.length : 0;
                }
                return 0;
              })();
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setActiveTab(t)}
                  className={`px-3 py-2 text-label transition-colors border-b-2 -mb-px ${
                    activeTab === t
                      ? "border-even-blue-600 text-even-navy-800 font-semibold"
                      : "border-transparent text-even-ink-500 hover:text-even-ink-800"
                  }`}
                >
                  {TAB_LABEL[t]}
                  {count > 0 ? <span className="ml-1.5 text-caption text-even-ink-400">{count}</span> : null}
                </button>
              );
            })}
          </div>

          {/* Tab body */}
          {activeTab === "note" ? (
            noteFinal ? (
              <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
                {enc.note_json_edited ? (
                  <p className="text-caption text-even-ink-500 mb-3">
                    ✎ Doctor-edited version shown. Original on file.
                  </p>
                ) : null}
                <NoteView note={noteFinal} />
              </section>
            ) : (
              <p className="text-body text-even-ink-400">No note generated yet.</p>
            )
          ) : null}

          {activeTab === "transcript" ? (
            enc.transcript_clean || enc.transcript_raw ? (
              <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
                <p className="text-caption text-even-ink-500 mb-3">
                  {enc.transcript_clean ? "Cleaned transcript shown. Raw available below." : "Raw transcript (no cleaned version)."}
                </p>
                <pre className="whitespace-pre-wrap text-body text-even-ink-800 leading-relaxed font-sans">
                  {enc.transcript_clean ?? enc.transcript_raw}
                </pre>
                {enc.transcript_clean && enc.transcript_raw && enc.transcript_clean !== enc.transcript_raw ? (
                  <details className="mt-4 rounded-md border border-even-ink-100 bg-even-ink-50/40">
                    <summary className="cursor-pointer select-none px-3 py-2 text-caption text-even-ink-500">
                      Raw (pre-cleanup)
                    </summary>
                    <pre className="px-3 pb-3 text-caption text-even-ink-700 whitespace-pre-wrap font-sans">
                      {enc.transcript_raw}
                    </pre>
                  </details>
                ) : null}
              </section>
            ) : (
              <p className="text-body text-even-ink-400">No transcript captured (encounter may be deleted or processing failed).</p>
            )
          ) : null}

          {activeTab === "cdmss" ? (
            enc.cdmss_json ? (
              <CdmssCard cdmss={enc.cdmss_json} />
            ) : (
              <p className="text-body text-even-ink-400">No CDMSS output (encounter may have been cancelled before this phase).</p>
            )
          ) : null}

          {activeTab === "send" ? (
            <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
              {enc.send_events.length === 0 ? (
                <p className="text-body text-even-ink-400">No send events yet.</p>
              ) : (
                <ul className="space-y-3">
                  {enc.send_events.map((s) => (
                    <li key={s.id} className="flex flex-col gap-1 border-b border-even-ink-100 pb-3 last:border-b-0 last:pb-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-even-navy-800">{s.recipient_email}</span>
                        <SendEventBadge status={s.status} />
                      </div>
                      <p className="text-caption text-even-ink-500 truncate" title={s.subject_rendered ?? ""}>
                        {s.subject_rendered ?? "(no subject)"}
                      </p>
                      <div className="text-caption text-even-ink-500 flex flex-wrap gap-x-3" suppressHydrationWarning>
                        <span>Queued: {fmtDate(s.created_at)}</span>
                        {(s.status === "sent" || s.status === "delivered" || s.status === "opened") && s.updated_at ?
                          <span>Sent: {fmtDate(s.updated_at)}</span> : null}
                        {(s.status === "delivered" || s.status === "opened") && s.updated_at ?
                          <span>Delivered: {fmtDate(s.updated_at)}</span> : null}
                        {s.opened_at    ? <span>Opened: {fmtDate(s.opened_at)}</span> : null}
                        {s.bounced_at   ? <span>Bounced: {fmtDate(s.bounced_at)}</span> : null}
                      </div>
                      {s.failure_reason ? (
                        <p className="text-caption text-danger-700 font-mono">{s.failure_reason}</p>
                      ) : null}
                      {s.resend_message_id ? (
                        <p className="text-caption text-even-ink-400 font-mono">resend: {s.resend_message_id}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {activeTab === "audit" ? (
            <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
              {enc.audit_log.length === 0 ? (
                <p className="text-body text-even-ink-400">No audit entries.</p>
              ) : (
                <ul className="space-y-2">
                  {enc.audit_log.map((a) => (
                    <li key={a.id} className="flex flex-col border-b border-even-ink-100 pb-2 last:border-b-0 last:pb-0">
                      <div className="flex items-center gap-2 text-body" suppressHydrationWarning>
                        <span className="font-mono text-caption text-even-ink-400">{fmtDate(a.created_at)}</span>
                        <span className="text-caption text-even-ink-500">{a.actor_type}</span>
                        <code className="font-mono text-caption text-even-navy-800">{a.action}</code>
                      </div>
                      {a.metadata_json ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-caption text-even-ink-500 hover:underline">metadata</summary>
                          <pre className="mt-1 px-3 py-2 text-caption text-even-ink-700 bg-even-ink-50/40 rounded-md font-mono whitespace-pre-wrap overflow-x-auto">
                            {JSON.stringify(a.metadata_json, null, 2)}
                          </pre>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>

        {/* Right rail */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">Send status</p>
            {enc.send_events.length === 0 ? (
              <p className="text-caption text-even-ink-400">Not sent yet.</p>
            ) : (
              <ul className="space-y-2">
                {enc.send_events.slice(0, 5).map((s) => (
                  <li key={s.id} className="text-caption">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-even-navy-800">{s.recipient_email}</span>
                      <SendEventBadge status={s.status} />
                    </div>
                  </li>
                ))}
                {enc.send_events.length > 5 ? (
                  <li className="text-caption text-even-ink-400">+{enc.send_events.length - 5} more in Send tab</li>
                ) : null}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">Audit log</p>
            {enc.audit_log.length === 0 ? (
              <p className="text-caption text-even-ink-400">No entries.</p>
            ) : (
              <ul className="space-y-1.5 text-caption">
                {enc.audit_log.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex flex-col">
                    <span className="font-mono text-even-navy-800">{a.action}</span>
                    <span className="text-even-ink-400" suppressHydrationWarning>{fmtDate(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Audio metadata */}
          <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-2">Audio</p>
            <p className="text-caption text-even-ink-700">
              {enc.audio_object_key ? (
                <>
                  {fmtBytes(enc.audio_bytes)} · R2 key:
                  <code className="font-mono ml-1 break-all">{enc.audio_object_key}</code>
                </>
              ) : "No audio stored."}
            </p>
          </div>

          {/* Danger zone */}
          {enc.status !== "deleted" ? (
            <div className="rounded-xl border border-danger-500/40 bg-danger-100/30 p-4">
              <p className="text-label text-danger-700 mb-2">Danger zone</p>
              <p className="text-caption text-even-ink-700 mb-3">
                Soft-delete clears note + transcript + CDMSS. Audio kept in R2.
              </p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDelete(true)}
              >
                Delete encounter
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-even-ink-200 bg-even-ink-50 p-4">
              <p className="text-label text-even-ink-700 mb-1">Deleted</p>
              <p className="text-caption text-even-ink-500" suppressHydrationWarning>
                Soft-deleted on {fmtDate(enc.deleted_at)}.
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* Resend modal */}
      {showResend && data ? (
        <ResendModal
          encounter={enc}
          candidates={data.recipient_candidates}
          onClose={() => setShowResend(false)}
          onDone={(result) => {
            setShowResend(false);
            const msg = result.ok
              ? `Resent · ${result.sentCount} delivered${result.failedCount > 0 ? `, ${result.failedCount} failed` : ""}`
              : `Resend failed (${result.failedCount} recipients failed).`;
            setActionMsg(msg);
            void load();
          }}
        />
      ) : null}

      {/* Delete confirm modal */}
      {showDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-even-navy-800/40" onClick={() => !actionInflight && setShowDelete(false)} role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-even-white p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-heading text-even-navy-800">Delete this encounter?</p>
            <p className="text-body text-even-ink-700">
              The note, transcript, and CDMSS output will be cleared. Audio is
              retained in R2 (PRD §4.17). Send history and audit log are kept
              for the trail.
            </p>
            <p className="text-caption text-even-ink-500">
              This is reversible only by manual SQL restore.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setShowDelete(false)} disabled={actionInflight}>Cancel</Button>
              <Button variant="destructive" onClick={onConfirmDelete} disabled={actionInflight}>
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

function StatusBadge({ status }: { status: EncounterStatus }) {
  const cls = (() => {
    switch (status) {
      case "complete":      return "bg-success-100/60 text-success-700 border-success-500/40";
      case "processing":    return "bg-even-blue-100 text-even-blue-700 border-even-blue-300";
      case "failed":        return "bg-danger-100/60 text-danger-700 border-danger-500/40";
      case "draft_partial": return "bg-amber-100 text-amber-800 border-amber-300";
      case "deleted":       return "bg-even-ink-100 text-even-ink-500 border-even-ink-200";
      default:              return "bg-even-ink-100 text-even-ink-700 border-even-ink-200";
    }
  })();
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-medium ${cls}`}>{status}</span>;
}

function SendEventBadge({ status }: { status: string }) {
  const cls = (() => {
    switch (status) {
      case "delivered":
      case "opened":
      case "sent":         return "bg-success-100/60 text-success-700 border-success-500/40";
      case "bounced":
      case "complained":
      case "failed":       return "bg-danger-100/60 text-danger-700 border-danger-500/40";
      case "queued":       return "bg-even-blue-100 text-even-blue-700 border-even-blue-300";
      default:             return "bg-even-ink-100 text-even-ink-700 border-even-ink-200";
    }
  })();
  return <span className={`inline-block px-1.5 py-0.5 rounded-full border text-[10px] ${cls}`}>{status}</span>;
}

function PipelineStrip({
  enc,
  fmtMs,
}: {
  enc: EncounterFull;
  fmtMs: (ms: number | null | undefined) => string;
}) {
  const noteTrace = enc.llm_traces.find((t) => t.surface === "note-pipeline");
  const cdmssTrace = enc.llm_traces.find((t) => t.surface === "cdmss-analysis");
  const recDurMs = enc.duration_seconds != null ? enc.duration_seconds * 1000 : null;
  const sendCount = enc.send_events.filter((s) => s.status === "sent" || s.status === "delivered" || s.status === "opened").length;
  const sendStatusOverall =
    enc.send_status === "sent" ? "completed" :
    enc.send_status === "failed" ? "errored" :
    enc.send_events.length > 0 ? "in_progress" : "pending";

  const stages: Array<{
    label: string;
    state: "completed" | "errored" | "aborted" | "in_progress" | "pending";
    detail: string;
    model?: string;
  }> = [
    {
      label: "Recording",
      state: enc.duration_seconds ? "completed" : "pending",
      detail: enc.duration_seconds ? `${fmtMs(recDurMs)} audio` : "—",
    },
    {
      label: "Note",
      state: (noteTrace?.status as typeof stages[0]["state"]) ?? (enc.note_json ? "completed" : "pending"),
      detail: noteTrace ? fmtMs(noteTrace.total_ms) : enc.note_json ? "ok" : "—",
      model: noteTrace?.model_calls[0]?.model,
    },
    {
      label: "CDS",
      state: (cdmssTrace?.status as typeof stages[0]["state"]) ?? (enc.cdmss_json ? "completed" : "pending"),
      detail: cdmssTrace ? fmtMs(cdmssTrace.total_ms) : enc.cdmss_json ? "ok" : "—",
      model: cdmssTrace?.model_calls[0]?.model,
    },
    {
      label: "Email",
      state: sendStatusOverall as typeof stages[0]["state"],
      detail: sendCount > 0 ? `${sendCount} sent` : enc.send_status === "failed" ? "failed" : "—",
    },
  ];

  const dotColor = (s: typeof stages[0]["state"]) => {
    switch (s) {
      case "completed":   return "bg-success-500";
      case "errored":     return "bg-danger-500";
      case "aborted":     return "bg-amber-500";
      case "in_progress": return "bg-even-blue-500 animate-pulse";
      default:            return "bg-even-ink-200";
    }
  };

  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500">Pipeline</p>
        {enc.llm_traces.length > 0 ? (
          <Link
            href={`/admin/traces/${enc.llm_traces[0]!.id}`}
            className="text-caption text-even-blue-600 hover:underline"
          >
            View full trace →
          </Link>
        ) : null}
      </div>
      <ol className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stages.map((s, i) => (
          <li key={i} className="flex flex-col gap-1 border border-even-ink-100 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${dotColor(s.state)}`} aria-hidden="true" />
              <span className="text-label text-even-navy-800">{s.label}</span>
            </div>
            <span className="text-caption font-mono text-even-ink-700">{s.detail}</span>
            {s.model ? <span className="text-[10px] font-mono text-even-ink-400">{s.model}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ResendModal({
  encounter,
  candidates,
  onClose,
  onDone,
}: {
  encounter: EncounterFull;
  candidates: { per_doctor: RecipientCandidate[]; global: RecipientCandidate[] };
  onClose: () => void;
  onDone: (result: { ok: boolean; sentCount: number; failedCount: number }) => void;
}) {
  // Default selection: prior recipients of this encounter, falling back to
  // the doctor's email + all global CCs if there were no prior sends.
  const initialSet = React.useMemo(() => {
    const prior = encounter.send_events
      .filter((s) => s.status === "sent" || s.status === "delivered" || s.status === "opened")
      .map((s) => s.recipient_email.toLowerCase());
    if (prior.length > 0) return new Set(prior);
    const def = new Set<string>();
    if (encounter.doctor?.email) def.add(encounter.doctor.email.toLowerCase());
    for (const g of candidates.global) def.add(g.email.toLowerCase());
    return def;
  }, [encounter, candidates]);

  const [selected, setSelected] = React.useState<Set<string>>(initialSet);
  const [adhocEmail, setAdhocEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = (email: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email.toLowerCase())) next.delete(email.toLowerCase());
      else next.add(email.toLowerCase());
      return next;
    });
  };
  const addAdhoc = () => {
    const e = adhocEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      setError("Not a valid email.");
      return;
    }
    setSelected((prev) => new Set(prev).add(e));
    setAdhocEmail("");
    setError(null);
  };

  const onSend = async () => {
    if (selected.size === 0) {
      setError("Pick at least one recipient.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/encounters/${encounter.id}/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: Array.from(selected) }),
      });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      const payload = j as { ok: boolean; sent: unknown[]; failed: unknown[] };
      onDone({
        ok: payload.ok,
        sentCount: payload.sent.length,
        failedCount: payload.failed.length,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  const allCandidates = [
    ...candidates.per_doctor.map((r) => ({ ...r, kind: "per_doctor" as const })),
    ...candidates.global.map((r)    => ({ ...r, kind: "global" as const })),
  ];
  // Also surface prior recipients that AREN'T in the candidate list (e.g. ad-hoc sends)
  const allInSets = new Set(allCandidates.map((c) => c.email.toLowerCase()));
  const priorOnly = encounter.send_events
    .map((s) => s.recipient_email.toLowerCase())
    .filter((e, i, arr) => arr.indexOf(e) === i && !allInSets.has(e));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-even-navy-800/40"
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-even-white p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-heading text-even-navy-800">Resend encounter</p>
        <p className="text-caption text-even-ink-500">Pick recipients. Admin resends are tagged in audit_log.</p>

        {encounter.doctor ? (
          <CheckboxRow
            checked={selected.has(encounter.doctor.email.toLowerCase())}
            onChange={() => toggle(encounter.doctor!.email)}
            label={encounter.doctor.full_name}
            sub={`${encounter.doctor.email} · doctor`}
          />
        ) : null}

        {candidates.global.length > 0 ? (
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1.5">Global CCs</p>
            <div className="space-y-1">
              {candidates.global.map((r) => (
                <CheckboxRow
                  key={r.id}
                  checked={selected.has(r.email.toLowerCase())}
                  onChange={() => toggle(r.email)}
                  label={r.name}
                  sub={`${r.email} · ${r.role}`}
                />
              ))}
            </div>
          </div>
        ) : null}

        {candidates.per_doctor.length > 0 ? (
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1.5">Per-doctor recipients</p>
            <div className="space-y-1">
              {candidates.per_doctor.map((r) => (
                <CheckboxRow
                  key={r.id}
                  checked={selected.has(r.email.toLowerCase())}
                  onChange={() => toggle(r.email)}
                  label={r.name}
                  sub={`${r.email} · ${r.role}`}
                />
              ))}
            </div>
          </div>
        ) : null}

        {priorOnly.length > 0 ? (
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1.5">Previously sent (ad-hoc)</p>
            <div className="space-y-1">
              {priorOnly.map((email) => (
                <CheckboxRow
                  key={email}
                  checked={selected.has(email)}
                  onChange={() => toggle(email)}
                  label={email}
                  sub="prior recipient"
                />
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1.5">Add recipient</p>
          <div className="flex gap-2">
            <input
              type="email"
              value={adhocEmail}
              onChange={(e) => setAdhocEmail(e.target.value)}
              placeholder="someone@hospital.in"
              className="flex-1 rounded-md border border-even-ink-200 px-3 py-1.5 text-body focus:outline-none focus:ring-2 focus:ring-even-blue-300"
            />
            <Button variant="secondary" size="sm" onClick={addAdhoc} type="button">+ Add</Button>
          </div>
        </div>

        {error ? <p className="text-caption text-danger-700">{error}</p> : null}

        <div className="flex items-center justify-between pt-2 border-t border-even-ink-100">
          <p className="text-caption text-even-ink-500">{selected.size} selected</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button variant="primary" size="md" onClick={() => void onSend()} disabled={submitting || selected.size === 0}>
              {submitting ? "Sending…" : `Send to ${selected.size}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CheckboxRow({
  checked,
  onChange,
  label,
  sub,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  sub: string;
}) {
  return (
    <label className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-even-ink-50 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onChange} className="w-4 h-4 rounded border-even-ink-300 text-even-blue-600 focus:ring-even-blue-300" />
      <span className="flex-1">
        <span className="text-body text-even-navy-800">{label}</span>
        <span className="text-caption text-even-ink-500 block">{sub}</span>
      </span>
    </label>
  );
}
