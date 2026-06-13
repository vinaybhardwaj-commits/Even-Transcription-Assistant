"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

type Status = "draft" | "processing" | "complete" | "failed";
type SendStatus = "pending" | "sent" | "failed";

type Row = {
  id: string;
  recorded_at: string;
  duration_seconds: number | null;
  patient_label: string | null;
  status: Status;
  send_status: SendStatus;
  note_type: string | null;
  chief_complaint: string | null;
};

type Props = { slug: string };

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: Row[] };

export function Library({ slug }: Props) {
  const router = useRouter();
  const [state, setState] = React.useState<ListState>({ kind: "loading" });

  const load = React.useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/${slug}/api/encounters`, { cache: "no-store" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(j.error?.message ?? `http_${res.status}`);
      }
      const j = (await res.json()) as { encounters: Row[] };
      setState({ kind: "ready", rows: j.encounters });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message: msg });
    }
  }, [slug]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // B11 Part B: refetch when the tab becomes visible again (user came back
  // from another app or another browser tab), on window focus, and on
  // bfcache restore (iOS Safari swipe-back). Without these listeners the
  // doctor sees a stale list every time they record + send and then return
  // to the Library without a full page reload.
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onPageshow = (e: PageTransitionEvent) => {
      if (e.persisted) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onPageshow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onPageshow);
    };
  }, [load]);

  if (state.kind === "loading") {
    return (
      <p className="text-body text-even-ink-500 text-center mt-12">
        Loading your encounters…
      </p>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="text-center mt-12 space-y-2">
        <p className="text-body text-danger-700">Could not load: {state.message}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="text-label text-even-blue-600 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.rows.length === 0) {
    return (
      <div className="text-center mt-12 space-y-3">
        <p className="text-body text-even-ink-500">
          No encounters yet. Tap Record to begin.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="text-caption text-even-blue-600 hover:underline"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        {(() => {
          const ready = state.rows.filter((r) => r.status === "complete" && r.send_status !== "sent").length;
          const processing = state.rows.filter((r) => r.status === "processing").length;
          return (
            <span className="text-caption text-even-ink-500">
              {ready > 0 ? <span className="font-medium text-even-navy-800">{ready} ready to review</span> : <span>Up to date</span>}
              {processing > 0 ? <span className="text-even-ink-400"> · {processing} processing</span> : null}
            </span>
          );
        })()}
        <button
          type="button"
          onClick={() => void load()}
          className="text-caption text-even-blue-600 hover:underline"
          aria-label="Refresh encounter list"
        >
          Refresh
        </button>
      </div>
      <ul className="space-y-2.5">
        {state.rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => router.push(`/${slug}/encounter/${r.id}`)}
              className="w-full text-left rounded-2xl border border-even-ink-100 bg-even-white p-4 shadow-card hover:shadow-card-hover hover:border-even-ink-200 focus:outline-none focus:ring-2 focus:ring-even-blue-200 transition"
            >
              <div className="flex items-start justify-between gap-3 mb-1">
                <p className="text-body text-even-navy-800 truncate">
                  <LibNoteTypePill noteType={r.note_type} />
                  {r.chief_complaint || r.patient_label || "Untitled encounter"}
                </p>
                <StatusPill status={r.status} sendStatus={r.send_status} />
              </div>
              <p className="text-caption text-even-ink-500 flex items-center gap-2">
                <span>{formatDate(r.recorded_at)}</span>
                {r.duration_seconds ? (
                  <>
                    <span>·</span>
                    <span>{formatDuration(r.duration_seconds)}</span>
                  </>
                ) : null}
                {r.patient_label && r.chief_complaint ? (
                  <>
                    <span>·</span>
                    <span className="truncate">{r.patient_label}</span>
                  </>
                ) : null}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LibNoteTypePill({ noteType }: { noteType: string | null }) {
  if (!noteType || noteType === "clinic_encounter") return null;
  const label: Record<string, string> = {
    general_medical: "General",
    operative_procedure: "Operative",
    dietetic_consult: "Dietetic",
    physiotherapy: "Physio",
  };
  return (
    <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-even-blue-50 text-even-blue-700 align-middle">
      {label[noteType] ?? noteType}
    </span>
  );
}

function StatusPill({ status, sendStatus }: { status: Status; sendStatus: SendStatus }) {
  // Composite indicator: if sent, show "Sent". Else show status.
  if (status === "complete" && sendStatus === "sent") {
    return (
      <span className="text-caption rounded-full px-2 py-0.5 bg-success-100 text-success-700 shrink-0">
        Sent
      </span>
    );
  }
  if (status === "complete") {
    return (
      <span className="text-caption rounded-full px-2 py-0.5 bg-even-ink-100 text-even-ink-700 shrink-0">
        Ready to send
      </span>
    );
  }
  if (status === "processing") {
    return (
      <span className="text-caption rounded-full px-2 py-0.5 bg-even-blue-100 text-even-blue-700 shrink-0">
        Processing
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-caption rounded-full px-2 py-0.5 bg-danger-100 text-danger-700 shrink-0">
        Failed
      </span>
    );
  }
  return (
    <span className="text-caption rounded-full px-2 py-0.5 bg-warning-100 text-warning-700 shrink-0">
      Draft
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const sameYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (sameYesterday) return `Yesterday ${time}`;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}
