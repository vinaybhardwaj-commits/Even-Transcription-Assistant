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

  const runProcess = React.useCallback(
    async (force: boolean) => {
      setS((prev) => ({ ...prev, processing: true, error: null }));
      try {
        const res = await fetch(
          `/${slug}/api/encounters/${initial.id}/process`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(j.error?.message ?? `http_${res.status}`);
        }
        const j = (await res.json()) as {
          encounter: { status: Status };
          note: EncounterNote;
          cdmss: CdmssOutput;
          cdmss_error?: string;
        };
        setS((prev) => ({
          ...prev,
          status: j.encounter.status,
          note: j.note,
          cdmss: j.cdmss,
          error: j.cdmss_error ?? null,
          processing: false,
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setS((prev) => ({ ...prev, processing: false, error: msg }));
      }
    },
    [slug, initial.id],
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
          <div className="rounded-xl border border-even-blue-100 bg-even-blue-50 p-6 text-center">
            <p className="text-label text-even-navy-800 mb-1">
              Generating your note + clinical decision support
            </p>
            <p className="text-caption text-even-ink-500 mb-4">
              This usually takes 30-60 seconds. Don&apos;t close this page.
            </p>
            <div className="inline-block">
              <div className="h-1.5 w-48 rounded-full bg-even-ink-100 overflow-hidden">
                <div className="h-full w-1/2 bg-even-blue-600 animate-pulse" />
              </div>
            </div>
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
