"use client";

import * as React from "react";
import type {
  BusCommandView,
  ListenersResp,
  RoomsLiveResp,
} from "@/components/admin/bench-live/types";

const LISTENER_POLL_MS = 3_000;
const ROLLUP_POLL_MS = 20_000;
const TICK_MS = 1_000;

export type PollIssue = {
  source: "listeners" | "rooms";
  kind: "auth" | "network" | "server";
  message: string;
  at: number;
};

function issueFor(source: PollIssue["source"], error: unknown, status?: number): PollIssue {
  return {
    source,
    kind: status === 401 || status === 403
      ? "auth"
      : status === undefined
        ? "network"
        : "server",
    message: error instanceof Error ? error.message : String(error),
    at: Date.now(),
  };
}

export function useBenchLivePolling() {
  const [listeners, setListeners] = React.useState<ListenersResp | null>(null);
  const [rollup, setRollup] = React.useState<RoomsLiveResp | null>(null);
  const [busCommands, setBusCommands] = React.useState<BusCommandView[]>([]);
  const [issues, setIssues] = React.useState<Partial<Record<PollIssue["source"], PollIssue>>>({});
  const [busy, setBusy] = React.useState(false);
  const [lastListenerSuccessAt, setLastListenerSuccessAt] = React.useState<number | null>(null);
  const [lastRollupSuccessAt, setLastRollupSuccessAt] = React.useState<number | null>(null);
  const [, setTick] = React.useState(0);

  const fetchListeners = React.useCallback(async () => {
    let responseStatus: number | undefined;
    try {
      const [listenerRes, commandRes] = await Promise.all([
        fetch("/api/admin/bench/listeners", { cache: "no-store" }),
        fetch("/api/admin/bench/command?status=recent", { cache: "no-store" }),
      ]);
      responseStatus = listenerRes.status;
      const listenerJson = (await listenerRes.json()) as ListenersResp & { error?: { message?: string } };
      if (!listenerRes.ok) throw new Error(listenerJson.error?.message ?? `http_${listenerRes.status}`);
      setListeners(listenerJson);
      setLastListenerSuccessAt(Date.now());
      setIssues((current) => {
        const next = { ...current };
        delete next.listeners;
        return next;
      });

      if (commandRes.ok) {
        const commandJson = (await commandRes.json()) as { commands?: BusCommandView[] };
        setBusCommands(commandJson.commands ?? []);
      }
    } catch (e) {
      setIssues((current) => ({ ...current, listeners: issueFor("listeners", e, responseStatus) }));
    }
  }, []);

  const fetchRollup = React.useCallback(async () => {
    setBusy(true);
    let responseStatus: number | undefined;
    try {
      const res = await fetch("/api/admin/bench/rooms-live", { cache: "no-store" });
      responseStatus = res.status;
      const json = (await res.json()) as RoomsLiveResp & { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? `http_${res.status}`);
      setRollup(json);
      setLastRollupSuccessAt(Date.now());
      setIssues((current) => {
        const next = { ...current };
        delete next.rooms;
        return next;
      });
    } catch (e) {
      setIssues((current) => ({ ...current, rooms: issueFor("rooms", e, responseStatus) }));
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
    busCommands,
    issues: Object.values(issues),
    authFailed: Object.values(issues).some((issue) => issue?.kind === "auth"),
    busy,
    lastListenerSuccessAt,
    lastRollupSuccessAt,
    fetchListeners,
    fetchRollup,
  };
}
