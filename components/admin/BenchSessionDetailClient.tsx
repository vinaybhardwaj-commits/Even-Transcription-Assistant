"use client";

/**
 * BenchSessionDetailClient — admin session detail (Room-Bench PRD §3.5;
 * mockup screen 5): info card with the permanent-archive statement, chunk
 * timeline strip (verified green / pending grey / gap amber), manifest.json
 * + day-download buttons (D7), per-chunk presigned links via the manifest.
 */

import * as React from "react";

type Chunk = {
  id: string;
  idx: number;
  source?: "primary" | "backup";
  r2_key: string;
  content_type: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  size_bytes: number | null;
  upload_state: string;
  gap_before_ms: number;
};

type Detail = {
  session: {
    id: string;
    room_name: string;
    room_slug: string;
    label: string | null;
    mic_label: string | null;
    started_at: string;
    ended_at: string | null;
    status: string;
    notes: string | null;
  };
  totals: {
    chunk_count: number;
    verified_count: number;
    total_bytes: number;
    gap_ms: number;
    backup_chunk_count?: number;
    backup_verified_count?: number;
    primary_lost_count?: number;
    primary_restored_count?: number;
  };
  chunks: Chunk[];
  /** K-B: second-mic stream + mic story */
  backup_chunks?: Chunk[];
  events?: Array<{ id: string; kind: string; at: string; brain_status: string; payload: unknown }>;
};

const GAP_VISIBLE_MS = 2000; // seams are <500ms; ≥2s is a real gap/pause

function fmtMb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

type TimelineSeg =
  | { kind: "chunk"; chunk: Chunk }
  | { kind: "gap"; beforeIdx: number; gapMs: number };

export function BenchSessionDetailClient({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const manifestRef = React.useRef<Record<number, string | null> | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/bench/sessions/${sessionId}`);
      if (!res.ok) {
        setError(res.status === 404 ? "Session not found." : "Could not load session.");
        return;
      }
      setDetail((await res.json()) as Detail);
    } catch {
      setError("Could not load session.");
    }
  }, [sessionId]);

  React.useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Per-chunk presigned links come from the manifest endpoint, fetched once
  // on first chunk click.
  const openChunk = React.useCallback(
    async (idx: number) => {
      try {
        if (!manifestRef.current) {
          const res = await fetch(`/api/bench/sessions/${sessionId}/manifest`);
          if (!res.ok) return;
          const j = (await res.json()) as {
            chunks: Array<{ idx: number; presigned_get: string | null }>;
          };
          manifestRef.current = Object.fromEntries(j.chunks.map((c) => [c.idx, c.presigned_get]));
        }
        const url = manifestRef.current?.[idx];
        if (url) window.open(url, "_blank", "noopener");
      } catch {
        /* link degrade — metadata tooltip still works */
      }
    },
    [sessionId],
  );

  if (error) {
    return (
      <p className="text-caption text-danger-700" role="alert">
        {error}
      </p>
    );
  }
  if (!detail) {
    return <p className="text-caption text-even-ink-400">Loading…</p>;
  }

  const { session, totals, chunks } = detail;
  const queued = totals.chunk_count - totals.verified_count;
  const durationMs =
    (session.ended_at ? new Date(session.ended_at).getTime() : Date.now()) -
    new Date(session.started_at).getTime();

  const segs: TimelineSeg[] = [];
  for (const c of chunks) {
    if (c.gap_before_ms >= GAP_VISIBLE_MS) {
      segs.push({ kind: "gap", beforeIdx: c.idx, gapMs: c.gap_before_ms });
    }
    segs.push({ kind: "chunk", chunk: c });
  }

  const visibleGaps = chunks.filter((c) => c.gap_before_ms >= GAP_VISIBLE_MS);
  const dateLine = new Date(session.started_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-caption text-even-ink-400 mb-1">
            Bench / {session.room_name} / {dateLine}
          </p>
          <h2 className="text-heading text-even-navy-800">{session.label ?? session.id}</h2>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/bench/sessions/${session.id}/manifest`}
            className="eta-btn-secondary px-4 py-2 text-label"
          >
            manifest.json
          </a>
          <a
            href={`/api/bench/sessions/${session.id}/timeline`}
            className="eta-btn-secondary px-4 py-2 text-label"
          >
            Download timeline.md
          </a>
          <a
            href={`/api/bench/sessions/${session.id}/download`}
            className="eta-btn-primary px-4 py-2 text-label"
          >
            ⬇&nbsp; Download day (.zip · {fmtMb(totals.total_bytes)})
          </a>
        </div>
      </div>

      <section className="eta-card p-5">
        <dl className="grid grid-cols-[150px,1fr] gap-x-3 gap-y-1.5 text-body">
          <dt className="text-even-ink-400">Room</dt>
          <dd className="text-even-ink-800 font-medium">
            {session.room_name} ({session.room_slug})
          </dd>
          <dt className="text-even-ink-400">Recorded</dt>
          <dd className="text-even-ink-800 font-medium">
            {fmtTime(session.started_at)} –{" "}
            {session.ended_at ? fmtTime(session.ended_at) : "ongoing"} · {fmtDuration(durationMs)}
          </dd>
          <dt className="text-even-ink-400">Microphone</dt>
          <dd className="text-even-ink-800 font-medium">{session.mic_label ?? "—"}</dd>
          <dt className="text-even-ink-400">Chunks</dt>
          <dd className="text-even-ink-800 font-medium">
            {totals.chunk_count} total · {totals.verified_count} verified
            {queued > 0 ? ` · ${queued} queued on device` : ""}
          </dd>
          <dt className="text-even-ink-400">Backup mic</dt>
          <dd className="text-even-ink-800 font-medium">
            {(totals.backup_chunk_count ?? 0) === 0
              ? "no backup stream"
              : `${totals.backup_chunk_count} chunks · ${totals.backup_verified_count ?? 0} verified`}
            {(totals.primary_lost_count ?? 0) > 0 ? (
              <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-caption font-semibold bg-warning-100 text-warning-700">
                main mic lost {totals.primary_lost_count}× · restored {totals.primary_restored_count ?? 0}×
              </span>
            ) : null}
          </dd>
          <dt className="text-even-ink-400">Capture gaps</dt>
          <dd className="text-even-ink-800 font-medium">
            {visibleGaps.length === 0
              ? "—"
              : visibleGaps
                  .map(
                    (c) =>
                      `before chunk ${c.idx} · ${Math.round(c.gap_before_ms / 1000)}s`,
                  )
                  .join(" · ")}
          </dd>
          <dt className="text-even-ink-400">Archive</dt>
          <dd className="text-even-ink-800 font-medium">
            <b>Permanent</b> — bench/ prefix, exempt from retention policy (PRD D6)
          </dd>
          {session.notes ? (
            <>
              <dt className="text-even-ink-400">Notes</dt>
              <dd className="text-even-ink-800">{session.notes}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <section className="eta-card p-5">
        <p className="text-label font-semibold text-even-navy-800 mb-1">
          Chunk timeline · {fmtTime(session.started_at)} →{" "}
          {session.ended_at ? fmtTime(session.ended_at) : "now"}
        </p>
        <div className="flex gap-4 text-caption text-even-ink-500 mb-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-success-500 inline-block" /> verified
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-even-ink-300 inline-block" /> pending
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-warning-500 inline-block" /> gap / pause
          </span>
        </div>
        {chunks.length === 0 ? (
          <p className="text-caption text-even-ink-400">No chunks recorded yet.</p>
        ) : (
          <div className="flex gap-[2px] h-9 items-stretch rounded-lg overflow-hidden">
            {segs.map((s, i) =>
              s.kind === "gap" ? (
                <div
                  key={`g${i}`}
                  className="flex-1 rounded-[2px] bg-warning-500 opacity-85"
                  title={`Gap before chunk ${s.beforeIdx} · ${Math.round(s.gapMs / 1000)}s (pause/dead time)`}
                />
              ) : (
                <button
                  key={s.chunk.id}
                  type="button"
                  onClick={() => void openChunk(s.chunk.idx)}
                  className={`flex-1 rounded-[2px] opacity-85 hover:opacity-100 transition ${
                    s.chunk.upload_state === "verified" ? "bg-success-500" : "bg-even-ink-300"
                  }`}
                  title={`chunk ${s.chunk.idx} · ${fmtTime(s.chunk.started_at)}–${fmtTime(
                    s.chunk.ended_at,
                  )} · ${s.chunk.size_bytes !== null ? fmtMb(s.chunk.size_bytes) : "size unknown"} · ${
                    s.chunk.r2_key
                  } · click to open`}
                />
              ),
            )}
          </div>
        )}
        <p className="mt-1.5 text-caption text-even-ink-400">
          Hover a segment for chunk #, time range, size and R2 key; click to open its presigned
          link.
        </p>
      </section>

      {/* K-B: backup (second mic) stream — its own strip, same idioms */}
      {(detail.backup_chunks?.length ?? 0) > 0 && (
        <section className="eta-card p-5">
          <p className="text-label font-semibold text-even-navy-800 mb-1">
            Backup mic timeline · {detail.backup_chunks!.length} chunk
            {detail.backup_chunks!.length === 1 ? "" : "s"}
          </p>
          <div className="flex gap-[2px] h-6 items-stretch rounded-lg overflow-hidden">
            {detail.backup_chunks!.map((c) => (
              <div
                key={c.id}
                className={`flex-1 rounded-[2px] opacity-85 ${
                  c.upload_state === "verified" ? "bg-even-blue-400" : "bg-even-ink-300"
                }`}
                title={`backup chunk ${c.idx} · ${fmtTime(c.started_at)}–${fmtTime(c.ended_at)} · ${
                  c.size_bytes !== null ? fmtMb(c.size_bytes) : "size unknown"
                } · ${c.r2_key}`}
              />
            ))}
          </div>
          <p className="mt-1.5 text-caption text-even-ink-400">
            Second microphone, recorded in lockstep. Download via the manifest / day zip
            (backup_chunk_*.webm).
          </p>
        </section>
      )}

      {/* K-B: mic story */}
      {(detail.events?.filter((e) => e.kind.startsWith("mic_")).length ?? 0) > 0 && (
        <section className="eta-card p-5">
          <p className="text-label font-semibold text-even-navy-800 mb-2">Mic story</p>
          <ul className="divide-y divide-even-ink-100">
            {detail
              .events!.filter((e) => e.kind.startsWith("mic_"))
              .map((e) => {
                const p = (typeof e.payload === "object" && e.payload !== null ? e.payload : {}) as { reason?: string };
                return (
                  <li key={e.id} className="flex items-baseline gap-4 py-1.5 text-body">
                    <span className="font-mono tabular-nums text-even-ink-800">{fmtTime(e.at)}</span>
                    <span
                      className={
                        e.kind === "mic_primary_lost" || e.kind === "mic_backup_error"
                          ? "text-danger-700"
                          : e.kind === "mic_primary_restored" || e.kind === "mic_backup_restored"
                            ? "text-success-700"
                            : "text-even-ink-500"
                      }
                    >
                      {e.kind.replace(/_/g, " ")}
                      {p.reason ? ` · ${p.reason}` : ""}
                    </span>
                  </li>
                );
              })}
          </ul>
        </section>
      )}
    </div>
  );
}
