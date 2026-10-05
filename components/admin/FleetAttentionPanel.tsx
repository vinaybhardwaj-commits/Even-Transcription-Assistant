"use client";

/**
 * FleetAttentionPanel — what needs a human right now, from GET /api/admin/fleet-attention (lib/fleet-attention.ts).
 *
 * It replaces the bare "Nothing needs attention." line on the Bench page. That line was computed from the browser's own view of the room
 * rollup and said it with OPD 4 silent for four days and OPD 3's microphone dead. This panel polls a server-side, state-based evaluation every
 * 30 s, and says "Nothing needs attention" ONLY when the server answered, read every source, and found nothing. A failed or partial read says so.
 *
 * `useFleetAttention` is a hook (not state inside the panel) because the room cards need the same items for their badges, and BenchRoomsLive owns
 * both. Polling skips while the tab is hidden, like the other polls on this page.
 */
import * as React from "react";
import type { AttentionItem, FleetAttentionResponse } from "@/lib/fleet-attention-format";
import { KIND_LABEL, fmtFor } from "@/lib/fleet-attention-format";

export const FLEET_ATTENTION_POLL_MS = 30_000;

export type FleetAttentionState = {
  data: FleetAttentionResponse | null;
  /** The last call failed (the previous data, if any, is kept but marked stale). */
  error: string | null;
  loaded: boolean;
};

export function useFleetAttention(): FleetAttentionState {
  const [data, setData] = React.useState<FleetAttentionResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/fleet-attention", { cache: "no-store" });
      const j = (await res.json()) as FleetAttentionResponse & { error?: { message?: string } };
      if (!res.ok) throw new Error(j.error?.message ?? `http_${res.status}`);
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const i = globalThis.setInterval(() => { if (!document.hidden) void load(); }, FLEET_ATTENTION_POLL_MS);
    return () => globalThis.clearInterval(i);
  }, [load]);

  return { data, error, loaded };
}

/** The same two classes BenchRoomsLive's pills use, so the panel reads as part of that surface. */
const PILL = "inline-block px-2 py-0.5 rounded-full text-caption font-semibold";
const SEV_CLASS = { red: "bg-danger-100 text-danger-700", amber: "bg-warning-100 text-warning-700" } as const;

/** Worst severity and count for one room, for the card badge. null when the room has no items. */
export function roomAttentionBadge(items: readonly AttentionItem[] | undefined, roomId: string): { severity: "red" | "amber"; count: number } | null {
  const mine = (items ?? []).filter((i) => i.room_id === roomId);
  if (mine.length === 0) return null;
  return { severity: mine.some((i) => i.severity === "red") ? "red" : "amber", count: mine.length };
}

export function FleetAttentionBadge({ items, roomId }: { items: readonly AttentionItem[] | undefined; roomId: string }) {
  const b = roomAttentionBadge(items, roomId);
  if (!b) return null;
  return (
    <span
      className={`${PILL} ${SEV_CLASS[b.severity]}`}
      data-testid={`fleet-attention-badge-${roomId}`}
      title={(items ?? []).filter((i) => i.room_id === roomId).map((i) => KIND_LABEL[i.kind]).join(", ")}
    >
      {b.severity === "red" ? "act now" : "watch"}{b.count > 1 ? ` · ${b.count}` : ""}
    </span>
  );
}

export function FleetAttentionPanel({
  state,
  legacyCount,
  nowMs,
}: {
  state: FleetAttentionState;
  /** Items in the page's older, browser-computed "Needs your attention" list. While it has any, this panel never claims all-clear. */
  legacyCount: number;
  nowMs: number;
}) {
  const { data, error, loaded } = state;
  const items = data?.items ?? [];
  const degraded = data?.degraded ?? [];

  if (!loaded) return <p className="text-caption text-even-ink-500">Checking the fleet…</p>;

  return (
    <div data-testid="fleet-attention-panel" className="space-y-2">
      {error ? (
        <p className="text-caption font-semibold text-danger-700" role="alert">
          The fleet check failed ({error}) — do not read the list below as all clear.
        </p>
      ) : null}
      {degraded.length > 0 ? (
        <p className="text-caption font-semibold text-warning-700" role="alert">
          Some checks could not run this time ({degraded.join(", ")}) — this list may be incomplete.
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="rounded-lg border border-even-ink-200 divide-y divide-even-ink-100">
          <p className="px-3 py-2 text-caption uppercase tracking-wide text-even-ink-500">
            Fleet attention ({items.length})
          </p>
          {items.map((a) => (
            <div key={`${a.room_id}-${a.kind}`} className="px-3 py-2 flex items-start gap-3" data-testid="fleet-attention-row">
              <span className={`${PILL} ${SEV_CLASS[a.severity]}`}>{a.severity === "red" ? "act now" : "watch"}</span>
              <div className="min-w-0">
                <p className="text-body text-even-navy-800">
                  <span className="font-semibold">{a.room_name}</span> — {KIND_LABEL[a.kind]}{" "}
                  <span className="text-caption text-even-ink-500">{fmtFor(a.since, nowMs)}</span>
                </p>
                <p className="text-caption text-even-ink-500">{a.detail}</p>
                <p className="text-caption text-even-navy-800">{a.action}</p>
              </div>
            </div>
          ))}
        </div>
      ) : data && !error && degraded.length === 0 && legacyCount === 0 && data.rooms_checked > 0 ? (
        <p className="text-caption text-success-700">Nothing needs attention.</p>
      ) : null}
    </div>
  );
}
