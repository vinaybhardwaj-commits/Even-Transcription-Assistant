"use client";

import * as React from "react";
import { Button } from "@/components/ui/Button";
import { probeIdbWritable } from "@/lib/chunk-store";

type Probe = {
  ok: boolean;
  latency_ms: number;
  error?: string;
};
type HealthResp = {
  ok: boolean;
  services: {
    db?: Probe;
    llm?: Probe;
    whisper?: Probe;
    resend?: Probe;
    r2?: Probe;
    kb?: Probe;
  };
};

type State =
  | { kind: "checking" }
  | { kind: "ok" }
  | { kind: "degraded"; failed: string[] }
  | { kind: "error"; message: string };

type Props = {
  onProceed: () => void;
  onCancel: () => void;
};

const FRIENDLY: Record<string, string> = {
  db: "Database",
  llm: "Local LLM (Mac Mini)",
  whisper: "Whisper (Mac Mini)",
  resend: "Email service",
  r2: "Audio storage",
  kb: "Knowledge base",
};

/**
 * Probes /api/health before recording starts. Per PRD §8.1.11 — warn
 * the doctor if any upstream is degraded but still let them record
 * (audio chunks always land in IndexedDB regardless of online state).
 */
export function PreflightCheck({ onProceed, onCancel }: Props) {
  const [state, setState] = React.useState<State>({ kind: "checking" });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/health", {
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: "error", message: `http_${res.status}` });
          return;
        }
        const json = (await res.json()) as HealthResp;
        // Things that block live capture: llm (cleanup), whisper (rolling), db.
        // r2 needed at submit time, not record time, but flag if down.
        const failed: string[] = [];
        for (const [name, probe] of Object.entries(json.services)) {
          if (probe && probe.ok === false) failed.push(FRIENDLY[name] ?? name);
        }
        // Verify local audio storage is actually writable. iOS Safari Private
        // Browsing blocks IndexedDB — recording still works (in-memory failsafe)
        // but the audio can't be recovered if the tab reloads.
        const idbWritable = await probeIdbWritable();
        if (cancelled) return;
        if (!idbWritable) {
          failed.push("Local audio backup is blocked — likely Private Browsing. Recording works, but it won't survive a tab reload; a normal Safari tab is recommended.");
        }
        setState(failed.length === 0 ? { kind: "ok" } : { kind: "degraded", failed });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-proceed on OK after a brief beat so the user sees the check happened.
  React.useEffect(() => {
    if (state.kind !== "ok") return;
    const t = window.setTimeout(onProceed, 250);
    return () => window.clearTimeout(t);
  }, [state.kind, onProceed]);

  if (state.kind === "checking" || state.kind === "ok") {
    return (
      <div className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-center justify-center p-6">
        <div className="rounded-xl bg-even-white border border-even-ink-100 p-6 max-w-sm w-full text-center shadow-card-hover">
          <p className="text-label text-even-navy-800 mb-1">
            {state.kind === "ok" ? "All systems ready" : "Checking connectivity…"}
          </p>
          <p className="text-caption text-even-ink-500">
            Verifying transcription and storage services.
          </p>
        </div>
      </div>
    );
  }

  // Error or degraded
  const isError = state.kind === "error";
  return (
    <div className="fixed inset-0 z-40 bg-even-ink-800/40 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
      <div className="rounded-xl bg-even-white border border-warning-500 p-5 max-w-md w-full shadow-card-hover space-y-4">
        <div>
          <p className="text-label text-warning-700 mb-1">
            {isError ? "Connectivity check failed" : "Some services are degraded"}
          </p>
          <p className="text-caption text-even-ink-500">
            {isError
              ? "Couldn't reach the health endpoint. You can still record — audio is captured locally."
              : "You can still record. Audio is captured locally and uploaded once everything is back online."}
          </p>
        </div>
        {!isError && state.kind === "degraded" ? (
          <ul className="text-body text-even-ink-800 list-disc pl-5 space-y-0.5">
            {state.failed.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
        {isError ? (
          <p className="text-caption text-even-ink-500 break-all">{state.message}</p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onProceed}>Record anyway</Button>
        </div>
      </div>
    </div>
  );
}
