"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { NoteView } from "@/components/encounter/NoteView";
import { NativeAnalysisCard } from "@/components/encounter/NativeAnalysisCard";
import type { NativeAnalysis } from "@/lib/stt/indic-comprehension";
import { NoteEditor } from "@/components/encounter/NoteEditor";
import { CdmssCard } from "@/components/encounter/CdmssCard";
import { SendPanel, type SendEventLite } from "@/components/encounter/SendPanel";
import type { AnyNote } from "@/lib/note-generation";
import type { CdmssOutput } from "@/lib/cdmss-stub";

// Sprint 6.3 (27 May 2026): 'draft_partial' added — encounter state after the
// doctor cancels mid-process. Note/CDMSS may be partially populated; the UI
// renders an inviting banner with Re-process or Use-as-is. See PRD §8.1.6.
type Status = "draft" | "processing" | "complete" | "failed" | "deleted" | "draft_partial";
type SendStatus = "pending" | "sent" | "failed";

type Speaker = { idx: number; label?: string; type?: string; source?: string; total_speech_sec?: number; confidence?: number };
type TaggedTurn = { text: string; speaker_idx: number | null; name: string; type?: string };

type InitialState = {
  id: string;
  status: Status;
  note: AnyNote | null;
  noteType?: string;
  cdmss: CdmssOutput | null;
  transcript: string | null;
  transcriptOriginal: string | null;
  detectedLanguage: string | null;
  nativeAnalysis: NativeAnalysis | null;
  nativeAnalysisLang: string | null;
  speakers: unknown[] | null;
  taggedTranscript: unknown[] | null;
  diarizeStatus: string | null;
  sendStatus: SendStatus;
  sentAt: string | null;
  sendEvents: SendEventLite[];
};

type Props = {
  slug: string;
  doctorEmail: string;
  doctorName: string;
  initial: InitialState;
};

type LiveState = {
  status: Status;
  note: AnyNote | null;
  cdmss: CdmssOutput | null;
  error: string | null;
  processing: boolean;
  sendStatus: SendStatus;
  sendEvents: SendEventLite[];
  editing: boolean;
};

export function EncounterDetailClient({ slug, doctorEmail, doctorName, initial }: Props) {
  const router = useRouter();
  const [s, setS] = React.useState<LiveState>({
    status: initial.status,
    note: initial.note,
    cdmss: initial.cdmss,
    error: null,
    processing: false,
    sendStatus: initial.sendStatus,
    sendEvents: initial.sendEvents,
    editing: false,
  });

  // Sprint 6.3 cancel: AbortController for the in-flight /process fetch,
  // plus a confirm-modal flag (PRD §8.1.6 — destructive copy locked).
  const abortRef = React.useRef<AbortController | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = React.useState(false);
  // B22 follow-up: a dropped /process stream on a weak mobile connection is the
  // common failure for clinicians. /process is idempotent (returns the persisted
  // note if the server already finished), so we auto-retry ONCE per user attempt
  // before surfacing anything. runProcessRef avoids a self-reference cycle.
  const netRetriedRef = React.useRef(false);
  const runProcessRef = React.useRef<((force: boolean, isAutoRetry?: boolean) => Promise<void>) | null>(null);

  const autoTriggeredRef = React.useRef(false);
  React.useEffect(() => {
    if (autoTriggeredRef.current) return;
    if (initial.status === "processing" && initial.note === null) {
      autoTriggeredRef.current = true;
      void runProcess(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stage tracking for streaming progress
  type StageId = "note" | "hyde" | "retrieve" | "draft" | "critique" | "revise" | "fallback" | "final";
  type StageRow = {
    id: StageId;
    label: string;
    state: "pending" | "running" | "done" | "skipped" | "error";
    started_at?: number;
    ended_at?: number;
    detail?: string;
  };
  const STAGE_ORDER: StageId[] = ["note", "hyde", "retrieve", "draft", "critique", "revise"];
  const STAGE_LABELS: Record<StageId, string> = {
    note: "Generating note",
    hyde: "Expanding query",
    retrieve: "Searching knowledge base",
    draft: "Drafting decision support",
    critique: "Auditing claims",
    revise: "Revising for citation support",
    fallback: "Falling back",
    final: "Done",
  };
  // Approximate weight per stage (sum ≈ 1.0). Tuned from Sprint 3.A.3 smoke
  // (~150s total: note ~15s, hyde ~8s, retrieve ~1.5s, draft ~51s, critique
  // ~29s, revise ~60s). Numbers don't need to be precise — just need to
  // make the bar move sensibly.
  const STAGE_WEIGHTS: Record<StageId, number> = {
    note: 0.10, hyde: 0.05, retrieve: 0.02, draft: 0.30, critique: 0.18, revise: 0.35, fallback: 0, final: 0,
  };
  const [stages, setStages] = React.useState<StageRow[]>(() =>
    STAGE_ORDER.map((id) => ({ id, label: STAGE_LABELS[id], state: "pending" })),
  );
  const [tick, setTick] = React.useState(0);

  // Re-render every 500ms while processing so elapsed counters move
  React.useEffect(() => {
    if (!s.processing) return;
    const i = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(i);
  }, [s.processing]);

  const progressFraction = React.useMemo(() => {
    let done = 0;
    let runningPartial = 0;
    for (const st of stages) {
      const w = STAGE_WEIGHTS[st.id] ?? 0;
      if (st.state === "done" || st.state === "skipped") done += w;
      else if (st.state === "running") {
        // Time-interp within the stage band
        const elapsed = st.started_at ? Date.now() - st.started_at : 0;
        const bandMs = (() => {
          switch (st.id) {
            case "note": return 20_000;
            case "hyde": return 10_000;
            case "retrieve": return 3_000;
            case "draft": return 55_000;
            case "critique": return 32_000;
            case "revise": return 65_000;
            default: return 10_000;
          }
        })();
        runningPartial = w * Math.min(0.9, elapsed / bandMs);
      }
    }
    return Math.min(0.97, done + runningPartial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stages, tick]);

  const updateStage = React.useCallback(
    (id: StageId, patch: Partial<StageRow>) => {
      setStages((prev) =>
        prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  // Detect whether an error came from us calling abort() on the controller.
  // Native fetch throws DOMException name='AbortError'; reader.read() too.
  const isClientAbort = (e: unknown): boolean => {
    if (!e || typeof e !== "object") return false;
    const err = e as { name?: unknown; code?: unknown };
    return err.name === "AbortError" || err.code === 20;
  };

  const runProcess = React.useCallback(
    async (force: boolean, isAutoRetry = false) => {
      // Sprint 6.3: bind a fresh AbortController so the Cancel button can
      // abort this fetch (which propagates through req.signal to upstream
      // LLM calls on the server, which then throws AbortError → server
      // flips status to 'draft_partial'.)
      const ac = new AbortController();
      abortRef.current = ac;
      // A user-initiated run (auto-trigger / Retry / Re-process) refreshes the
      // one-shot auto-retry budget; the auto-retry itself does not.
      if (!isAutoRetry) netRetriedRef.current = false;

      setS((prev) => ({ ...prev, processing: true, error: null }));
      setStages(STAGE_ORDER.map((id) => ({ id, label: STAGE_LABELS[id], state: "pending" })));
      try {
        const res = await fetch(`/${slug}/api/encounters/${initial.id}/process`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify({ force }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(j.error?.message ?? `http_${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        type FinalEvent = { encounter: { status: Status }; note: AnyNote; cdmss: CdmssOutput; cdmss_error?: string };
        let finalEvent: FinalEvent | null = null;
        let lastError: string | null = null;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
            if (!line) continue;
            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            const rawStage = typeof evt.stage === "string" ? evt.stage : "";
            const state = typeof evt.state === "string" ? evt.state : undefined;
            if (rawStage === "heartbeat") continue;
            if (rawStage === "error") {
              lastError = String(evt.message ?? "unknown_error");
              continue;
            }
            if (rawStage === "final") {
              finalEvent = evt as unknown as FinalEvent;
              continue;
            }
            const stageId = rawStage as StageId;
            if (!STAGE_LABELS[stageId]) continue;
            if (state === "start") {
              updateStage(stageId, { state: "running", started_at: Date.now(), detail: undefined });
            } else if (state === "done") {
              const ms = typeof evt.ms === "number" ? evt.ms : undefined;
              const detailBits: string[] = [];
              if (stageId === "note" && typeof evt.chief_complaint === "string") detailBits.push(evt.chief_complaint.slice(0, 60));
              if (stageId === "retrieve") {
                const hits = typeof evt.hits === "number" ? evt.hits : 0;
                const topBook = typeof evt.top_book === "string" ? evt.top_book : null;
                detailBits.push(`${hits} hits${topBook ? ` · ${topBook}` : ""}`);
              }
              if (stageId === "critique" && typeof evt.needs_revision === "boolean") {
                detailBits.push(evt.needs_revision ? `needs revision (${evt.unsupported ?? 0})` : "passed");
              }
              updateStage(stageId, {
                state: "done",
                ended_at: Date.now(),
                detail: [ms ? `${(ms / 1000).toFixed(1)}s` : null, ...detailBits].filter(Boolean).join(" · "),
              });
            } else if (state === "skipped") {
              updateStage(stageId, { state: "skipped", ended_at: Date.now(), detail: String(evt.reason ?? evt.message ?? "skipped") });
            } else if (state === "error") {
              updateStage(stageId, { state: "error", ended_at: Date.now(), detail: String(evt.message ?? "error") });
              lastError = String(evt.message ?? "error");
            }
          }
        }

        if (finalEvent) {
          setS((prev) => ({
            ...prev,
            status: finalEvent.encounter.status,
            note: finalEvent.note,
            cdmss: finalEvent.cdmss,
            error: finalEvent.cdmss_error ?? lastError,
            processing: false,
          }));
          // Diarization + batch translation are persisted AFTER the 'final'
          // event (the server awaits diarizeStore before closing the stream,
          // so by the time this read loop ends they're written). Refresh the
          // server props so the speaker summary + tagged conversation +
          // English/vernacular transcript boxes appear without a manual reload.
          router.refresh();
        } else {
          setS((prev) => ({ ...prev, processing: false, error: lastError ?? "stream_ended_without_final" }));
        }
      } catch (e) {
        if (isClientAbort(e)) {
          // S6.3 cancel: server has flipped status='draft_partial' + audit log.
          // We optimistically mirror that in client state (the server route
          // races our request — by the time we get here it's already written.)
          setS((prev) => ({
            ...prev,
            status: "draft_partial",
            processing: false,
            error: null,
          }));
          // Server may have populated note/cdmss before the abort — re-fetch
          // the encounter from server to pull the latest persisted view.
          // (Cheaper than tracking partial state across the stream events.)
          router.refresh();
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          // Distinguish a network/stream drop (weak signal) from a real
          // server-side processing error. /process is idempotent, so on a
          // network drop auto-retry once; if it drops again, show a calm,
          // accurate message (the server may have finished — Retry re-checks).
          const isNetwork = /load failed|failed to fetch|networkerror|network error|respondwith|network connection was lost|the request timed out/i.test(msg);
          if (isNetwork && !netRetriedRef.current) {
            netRetriedRef.current = true;
            setS((prev) => ({ ...prev, processing: false, error: null }));
            window.setTimeout(() => { void runProcessRef.current?.(force, true); }, 1500);
          } else {
            setS((prev) => ({
              ...prev,
              processing: false,
              error: isNetwork
                ? "Connection interrupted — your note may still be processing. Tap Retry to check."
                : msg,
            }));
          }
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [slug, initial.id, updateStage, router],
  );
  // Keep a ref to the latest runProcess so the in-flight catch can schedule a
  // one-shot auto-retry without a self-reference cycle in the useCallback.
  React.useEffect(() => { runProcessRef.current = runProcess; }, [runProcess]);

  // S6.3: user-initiated cancel from the Cancel button on the processing card.
  // Opens the confirm modal. Confirm → abortRef.current?.abort().
  const onCancelClick = React.useCallback(() => {
    if (!abortRef.current) return;
    setShowCancelConfirm(true);
  }, []);
  const onCancelConfirm = React.useCallback(() => {
    abortRef.current?.abort();
    setShowCancelConfirm(false);
  }, []);
  const onCancelDismiss = React.useCallback(() => {
    setShowCancelConfirm(false);
  }, []);

  const onSend = React.useCallback(
    async (recipients: string[]): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch(
          `/${slug}/api/encounters/${initial.id}/send`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipients }),
          },
        );
        const j = await res.json();
        if (!res.ok) {
          const err = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
          return { ok: false, error: err };
        }
        const payload = j as {
          ok: boolean;
          sent: { email: string; send_event_id: string; resend_message_id: string }[];
          failed: { email: string; error: string }[];
          subject: string;
        };
        // Optimistically update send events list with the new rows
        const newEvents: SendEventLite[] = [
          ...payload.sent.map((s) => ({
            id: s.send_event_id,
            recipient_email: s.email,
            status: "sent",
            subject: payload.subject,
            created_at: new Date().toISOString(),
          })),
          ...payload.failed.map((f) => ({
            id: `local_${Math.random().toString(36).slice(2, 8)}`,
            recipient_email: f.email,
            status: "failed",
            subject: payload.subject,
            created_at: new Date().toISOString(),
          })),
        ];
        setS((prev) => ({
          ...prev,
          sendStatus: payload.sent.length > 0 ? "sent" : "failed",
          sendEvents: [...newEvents, ...prev.sendEvents],
        }));
        return { ok: payload.sent.length > 0 };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
    [slug, initial.id],
  );

  const onSaveNote = React.useCallback(
    async (note: AnyNote): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch(
          `/${slug}/api/encounters/${initial.id}/note`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(note),
          },
        );
        const j = await res.json();
        if (!res.ok) {
          const err = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
          return { ok: false, error: err };
        }
        const payload = j as { note: AnyNote };
        setS((prev) => ({ ...prev, note: payload.note, editing: false }));
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
    [slug, initial.id],
  );

  const statusLabel = (() => {
    switch (s.status) {
      case "processing":     return "Processing";
      case "complete":       return "Complete";
      case "failed":         return "Failed";
      case "draft_partial":  return "Saved (partial)";
      default:               return s.status;
    }
  })();

  return (
    <main className="min-h-screen bg-even-ink-50">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-even-ink-100 bg-even-white/90 px-4 py-3 backdrop-blur">
        <button
          type="button"
          onClick={() => router.push(`/${slug}`)}
          className="text-label text-even-blue-600 hover:underline"
        >
          ‹ Library
        </button>
        <span className="text-label text-even-navy-800">{initial.id.slice(0, 14)}…</span>
        <span className="text-caption rounded-full bg-even-ink-100 px-2.5 py-0.5 text-even-ink-600">{statusLabel}</span>
      </header>

      <div className="px-4 py-6 max-w-2xl mx-auto space-y-6">
        {s.processing ? (
          <div className="rounded-2xl border border-even-blue-100 bg-even-blue-50 p-5 space-y-4 shadow-soft">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-label text-even-navy-800 mb-1">
                  Generating your note + clinical decision support
                </p>
                <p className="text-caption text-even-ink-500">
                  Live pipeline. ~90&ndash;150s total.
                </p>
              </div>
              {/* S6.3 cancel button — opens confirm modal. PRD §8.1.6. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={onCancelClick}
                className="shrink-0"
              >
                Cancel
              </Button>
            </div>
            <div
              className="h-1.5 w-full rounded-full bg-even-ink-100 overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progressFraction * 100)}
            >
              <div
                className="h-full bg-even-blue-600 transition-all"
                style={{ width: `${Math.round(progressFraction * 100)}%` }}
              />
            </div>
            <ul className="space-y-1.5">
              {stages.map((st) => {
                const elapsed =
                  st.state === "running" && st.started_at
                    ? `${((Date.now() - st.started_at) / 1000).toFixed(0)}s`
                    : undefined;
                const dot =
                  st.state === "done"
                    ? "bg-success-500"
                    : st.state === "running"
                    ? "bg-even-blue-500 animate-pulse"
                    : st.state === "skipped"
                    ? "bg-even-ink-300"
                    : st.state === "error"
                    ? "bg-danger-500"
                    : "bg-even-ink-200";
                return (
                  <li key={st.id} className="flex items-center gap-3 text-body">
                    <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
                    <span className={`flex-1 ${st.state === "pending" ? "text-even-ink-400" : "text-even-ink-800"}`}>
                      {st.label}
                    </span>
                    {st.detail ? (
                      <span className="text-caption text-even-ink-500">{st.detail}</span>
                    ) : elapsed ? (
                      <span className="text-caption font-mono text-even-ink-500">{elapsed}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {/* S6.3: banner shown on encounters left in 'draft_partial' state by
            the cancel flow. Offers Re-process (re-runs the full pipeline) or
            Use-as-is and send (skips straight to the SendPanel). */}
        {s.status === "draft_partial" && !s.processing ? (
          <div className="rounded-2xl border border-warning-500 bg-warning-100/40 p-5 space-y-3 shadow-soft">
            <p className="text-label text-amber-900">
              This note was not fully reviewed against your final transcript.
            </p>
            <p className="text-body text-even-ink-700">
              You can re-process to generate a fresh note, or send as-is.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" size="sm" onClick={() => void runProcess(true)}>
                Re-process
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const el = document.getElementById("send-panel-anchor");
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                Use as-is and send
              </Button>
            </div>
          </div>
        ) : null}

        {s.error && !s.processing ? (
          <div className="rounded-2xl border border-danger-500 bg-danger-100/40 p-4 shadow-soft">
            <p className="text-label text-danger-700 mb-2">Processing problem</p>
            <p className="text-body text-even-ink-700 mb-3">{s.error}</p>
            <Button variant="secondary" onClick={() => void runProcess(true)}>
              Retry
            </Button>
          </div>
        ) : null}

        {s.note ? (
          <section className="rounded-2xl border border-even-ink-100 bg-even-white p-5 shadow-soft">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="text-heading text-even-navy-800">
                Medical Encounter Note
              </h2>
              {!s.editing && (s.status === "complete" || s.status === "draft_partial") ? (
                <button
                  type="button"
                  onClick={() => setS((prev) => ({ ...prev, editing: true }))}
                  className="text-label text-even-blue-600 hover:underline shrink-0"
                >
                  Edit
                </button>
              ) : null}
            </div>
            {s.editing && s.note ? (
              <NoteEditor
                initial={s.note}
                noteType={initial.noteType}
                onSave={onSaveNote}
                onCancel={() => setS((prev) => ({ ...prev, editing: false }))}
              />
            ) : (
              <NoteView note={s.note} noteType={initial.noteType} />
            )}
          </section>
        ) : null}

        {s.cdmss ? <CdmssCard cdmss={s.cdmss} /> : null}

        {/* SendPanel is reachable from both 'complete' AND 'draft_partial'
            (per V's Q2 lock: doctor can send as-is on a partial). The anchor
            below lets the banner's 'Use as-is and send' button scroll here. */}
        {(s.status === "complete" || s.status === "draft_partial") && s.note ? (
          <div id="send-panel-anchor">
            <SendPanel
              slug={slug}
              doctorEmail={doctorEmail}
              doctorName={doctorName}
              sendEvents={s.sendEvents}
              sendStatus={s.sendStatus}
              onSend={onSend}
            />
          </div>
        ) : null}

        {s.status === "complete" && !s.processing ? (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => void runProcess(true)}>
              Regenerate
            </Button>
          </div>
        ) : null}

        {initial.diarizeStatus === "complete" && initial.speakers && initial.speakers.length > 0 ? (() => {
          const COLORS = ["#2563EB", "#10B981", "#F59E0B", "#8B5CF6", "#EF4444", "#0EA5E9"];
          const sps = initial.speakers as Speaker[];
          const clinician = sps.find((sp) => sp.source === "auto");
          const turns = (initial.taggedTranscript ?? []) as TaggedTurn[];
          const names = Array.from(new Set(turns.map((t) => t.name)));
          const colorOf = (n: string) => COLORS[Math.max(0, names.indexOf(n)) % COLORS.length];
          return (
            <div className="rounded-2xl border border-even-ink-100 bg-even-white overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5">
                <span className="text-caption font-medium text-even-navy-800">{sps.length} speaker{sps.length > 1 ? "s" : ""} detected</span>
                {clinician ? <span className="text-caption text-success-700">· {clinician.label} identified</span> : null}
                <span className="ml-auto flex items-center gap-1">
                  {sps.slice(0, 6).map((sp, i) => (
                    <span key={sp.idx} className="h-2 w-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} title={sp.label} />
                  ))}
                </span>
              </div>
              {turns.length > 0 ? (
                <details className="border-t border-even-ink-100">
                  <summary className="cursor-pointer select-none px-3 py-2 text-caption text-even-ink-500">Conversation by speaker ({turns.length} turns)</summary>
                  <div className="px-3 pb-3 space-y-1.5">
                    {turns.map((t, i) => (
                      <div key={i} className="flex gap-2.5">
                        <span className="w-24 shrink-0 text-caption font-medium truncate" style={{ color: colorOf(t.name) }}>{t.name}</span>
                        <span className="flex-1 text-body text-even-ink-800 leading-relaxed">{t.text}</span>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          );
        })() : null}

        {initial.nativeAnalysis ? (
          <NativeAnalysisCard analysis={initial.nativeAnalysis} lang={initial.nativeAnalysisLang} />
        ) : null}

        {initial.transcriptOriginal ? (
          <details className="rounded-2xl border border-even-ink-100 bg-even-white">
            <summary className="cursor-pointer select-none px-3 py-2 text-caption text-even-ink-500">
              Original transcript{initial.detectedLanguage ? ` · ${initial.detectedLanguage}` : ""} ({(initial.transcriptOriginal.length / 1024).toFixed(1)} KB)
            </summary>
            <p className="px-3 pb-3 text-body text-even-ink-700 whitespace-pre-wrap leading-relaxed">
              {initial.transcriptOriginal}
            </p>
          </details>
        ) : null}

        {initial.transcript ? (
          <details className="rounded-2xl border border-even-ink-100 bg-even-white">
            <summary className="cursor-pointer select-none px-3 py-2 text-caption text-even-ink-500">
              {initial.transcriptOriginal ? "English translation" : "Transcript"} ({(initial.transcript.length / 1024).toFixed(1)} KB)
            </summary>
            <p className="px-3 pb-3 text-body text-even-ink-700 whitespace-pre-wrap leading-relaxed">
              {initial.transcript}
            </p>
          </details>
        ) : null}
      </div>

      {/* S6.3 cancel confirm modal — PRD §8.1.6 copy locked verbatim.
          Renders only when the user has tapped Cancel during processing. */}
      {showCancelConfirm ? (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-even-navy-800/40"
          onClick={onCancelDismiss}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-confirm-title"
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-even-white shadow-card p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p id="cancel-confirm-title" className="text-heading text-even-navy-800">
              Cancel processing?
            </p>
            <p className="text-body text-even-ink-700">
              Your transcript will return to the review screen for editing. The
              pipelines will not run.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
              <Button variant="secondary" size="md" onClick={onCancelDismiss}>
                Keep processing
              </Button>
              <Button variant="destructive" size="md" onClick={onCancelConfirm}>
                Yes, cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
