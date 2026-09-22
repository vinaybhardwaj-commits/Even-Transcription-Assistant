"use client";

import * as React from "react";
import type {
  ListenersResp,
  PendingCommandView,
  RoomsLiveResp,
} from "@/components/admin/bench-live/types";

const LISTENER_POLL_MS = 3_000;
const ROLLUP_POLL_MS = 20_000;
const TICK_MS = 1_000;

export function useBenchLivePolling() {
  const [listeners, setListeners] = React.useState<ListenersResp | null>(null);
  const [rollup, setRollup] = React.useState<RoomsLiveResp | null>(null);
  const [pendingCommands, setPendingCommands] = React.useState<PendingCommandView[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastFetchAt, setLastFetchAt] = React.useState<number | null>(null);
  const [, setTick] = React.useState(0);

  const fetchListeners = React.useCallback(async () => {
    try {
      const [listenerRes, commandRes] = await Promise.all([
        fetch("/api/admin/bench/listeners", { cache: "no-store" }),
        fetch("/api/admin/bench/command?status=pending", { cache: "no-store" }),
      ]);
      const listenerJson = (await listenerRes.json()) as ListenersResp & { error?: { message?: string } };
      if (!listenerRes.ok) throw new Error(listenerJson.error?.message ?? `http_${listenerRes.status}`);
      setListeners(listenerJson);

      if (commandRes.ok) {
        const commandJson = (await commandRes.json()) as { commands?: PendingCommandView[] };
        setPendingCommands(commandJson.commands ?? []);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const fetchRollup = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/bench/rooms-live", { cache: "no-store" });
      const json = (await res.json()) as RoomsLiveResp & { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? `http_${res.status}`);
      setRollup(json);
      setLastFetchAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchListeners();
    void fetchRollup();
  }, [fetchListeners, fetchRollup]);

  React.useEffect(() => {
    const id = globalThis.setInterval(() => {
      if (!document.hidden) void fetchListeners();
    }, LISTENER_POLL_MS);
    return () => globalThis.clearInterval(id);
  }, [fetchListeners]);

  React.useEffect(() => {
    const id = globalThis.setInterval(() => {
      if (!document.hidden) void fetchRollup();
    }, ROLLUP_POLL_MS);
    return () => globalThis.clearInterval(id);
  }, [fetchRollup]);

  React.useEffect(() => {
    const id = globalThis.setInterval(() => setTick((tick) => tick + 1), TICK_MS);
    return () => globalThis.clearInterval(id);
  }, []);

  return {
    listeners,
    rollup,
    pendingCommands,
    error,
    busy,
    lastFetchAt,
    fetchListeners,
    fetchRollup,
  };
}
