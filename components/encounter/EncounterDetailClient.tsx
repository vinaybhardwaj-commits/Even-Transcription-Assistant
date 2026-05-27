"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { NoteView } from "@/components/encounter/NoteView";
import { NoteEditor } from "@/components/encounter/NoteEditor";
import { CdmssCard } from "@/components/encounter/CdmssCard";
import { SendPanel, type SendEventLite } from "@/components/encounter/SendPanel";
import type { EncounterNote } from "@/lib/note-generation";
import type { CdmssOutput } from "@/lib/cdmss-stub";

type Status = "draft" | "processing" | "complete" | "failed" | "deleted";
type SendStatus = "pending" | "sent" | "failed";

type InitialState = {
  id: string;
  status: Status;
  note: EncounterNote | null;
  cdmss: CdmssOutput | null;
  transcript: string | null;
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
  note: EncounterNote | null;
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

  const runProcess = React.useCallback(
    async (force: boolean) => {
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
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(j.error?.message ?? `http_${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalEvent: { encounter: { status: Status }; note: EncounterNote; cdmss: CdmssOutput; cdmss_error?: string } | null = null;
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
            const stageId = evt.stage as StageId | undefined;
            const state = evt.state as string | undefined;
            if (stageId === "heartbeat") continue;
            if (stageId === "error") {
              lastError = String(evt.message ?? "unknown_error");
              continue;
            }
            if (stageId === "final") {
              finalEvent = evt as typeof finalEvent;
              continue;
            }
            if (!stageId) continue;
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
        } else {
          setS((prev) => ({ ...prev, processing: false, error: lastError ?? "stream_ended_without_final" }));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setS((prev) => ({ ...prev, processing: false, error: msg }));
      }
    },
    [slug, initial.id, updateStage],
  );

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
    async (note: EncounterNote): Promise<{ ok: boolean; error?: string }> => {
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
        const payload = j as { note: EncounterNote };
        setS((prev) => ({ ...prev, note: payload.note, editing: false }));
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },
    [slug, initial.id],
  );

  return (
    <main className="min-h-screen bg-even-white">
      <header className="sticky top-0 z-10 bg-even-white border-b border-even-ink-100 flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => router.push(`/${slug}`)}
          className="text-label text-even-blue-600 hover:underline"
        >
          ‹ Library
        </button>
        <span className="text-label text-even-navy-800">{initial.id.slice(0, 14)}…</span>
        <span className="text-caption text-even-ink-400">
          {s.status === "processing"
            ? "Processing"
            : s.status === "complete"
            ? "Complete"
            : s.status === "failed"
            ? "Failed"
            : s.status}
        </span>
      </header>

      <div className="px-4 py-6 max-w-2xl mx-auto space-y-6">
        {s.processing ? (
          <div className="rounded-xl border border-even-blue-100 bg-even-blue-50 p-5 space-y-4">
            <div>
              <p className="text-label text-even-navy-800 mb-1">
                Generating your note + clinical decision support
              </p>
              <p className="text-caption text-even-ink-500">
                Live pipeline. ~90&ndash;150s total.
              </p>
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

        {s.error && !s.processing ? (
          <div className="rounded-xl border border-danger-500 bg-danger-100/40 p-4">
            <p className="text-label text-danger-700 mb-2">Processing problem</p>
            <p className="text-body text-even-ink-700 mb-3">{s.error}</p>
            <Button variant="secondary" onClick={() => void runProcess(true)}>
              Retry
            </Button>
          </div>
        ) : null}

        {s.note ? (
          <section className="rounded-xl border border-even-ink-100 bg-even-white p-5 shadow-card">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="text-heading text-even-navy-800">
                Medical Encounter Note
              </h2>
              {!s.editing && s.status === "complete" ? (
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
                onSave={onSaveNote}
                onCancel={() => setS((prev) => ({ ...prev, editing: false }))}
              />
            ) : (
              <NoteView note={s.note} />
            )}
          </section>
        ) : null}

        {s.cdmss ? <CdmssCard cdmss={s.cdmss} /> : null}

        {s.status === "complete" && s.note ? (
          <SendPanel
            slug={slug}
            doctorEmail={doctorEmail}
            doctorName={doctorName}
            sendEvents={s.sendEvents}
            sendStatus={s.sendStatus}
            onSend={onSend}
          />
        ) : null}

        {s.status === "complete" && !s.processing ? (
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => void runProcess(true)}>
              Regenerate
            </Button>
          </div>
        ) : null}

        {initial.transcript ? (
          <details className="rounded-md border border-even-ink-100 bg-even-ink-50/40">
            <summary className="cursor-pointer select-none px-3 py-2 text-caption text-even-ink-500">
              Raw transcript ({(initial.transcript.length / 1024).toFixed(1)} KB)
            </summary>
            <p className="px-3 pb-3 text-body text-even-ink-700 whitespace-pre-wrap leading-relaxed">
              {initial.transcript}
            </p>
          </details>
        ) : null}
      </div>
    </main>
  );
}
