"use client";

/**
 * use-command-poll — the Bench kiosk's operator listener (Operator MCP S2, PRD §8).
 *
 * Polls GET /api/bench/commands every 1.5 s while the tab is visible (5 s when hidden) with a
 * random per-mount tab_id, and runs the kiosk's EXISTING start / pause / resume / end functions
 * for `start_day` / `pause_day` / `resume_day` / `end_day` — no second recorder, no new
 * session logic. Each command is acked exactly once via POST /api/bench/commands/{id}/ack.
 *
 *   start_day  — already recording → ack { ok, session_id } (idempotent, no second tape);
 *                paused → { ok:false, error:"room_paused" } unless args.override_pause (then
 *                the resume path); otherwise the existing start flow, ack the new session_id.
 *   end_day    — the existing end flow (flushes the last chunk, PATCHes ended); ack after.
 *
 * Fail-open for the doctor: 503 bus_down / bus_not_migrated or a network failure only changes
 * the chip ("operator link down") and backs the poll off (5 s → 30 s cap); the buttons keep
 * working. `superseded` (another tab polled this room more recently — D4) stops the poll,
 * says so on the chip, and (remount-resume D3) runs the kiosk's takeover action: stop both
 * streams, flush + upload the current segment, show the message — never PATCH end. Remote
 * actions are surfaced on the chip ("Started from operator" …).
 */

import * as React from "react";
import type { RoomRecorderState } from "@/lib/use-room-recorder";

const POLL_VISIBLE_MS = 1_500;
const POLL_HIDDEN_MS = 5_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 30_000;
const ACK_RETRIES = 3;
const ACTION_BANNER_MS = 60_000;

export type CommandKind = "start_day" | "pause_day" | "resume_day" | "end_day";

export type CommandActions = {
  getSnapshot: () => { state: RoomRecorderState; sessionId: string | null };
  /** existing start-of-day flow; resolves with the new session id */
  start: () => Promise<{ session_id: string }>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** existing end-day flow; resolves once the final chunk is flushed and the session is ended */
  end: () => Promise<void>;
  /**
   * Remount-resume D3: this tab lost the room to a newer tab. Stop both streams, finish the
   * current segment (save to disk, upload it), show the takeover message — and do NOT send
   * PATCH end: the new tab owns the session.
   */
  takeover: () => Promise<void>;
};

export type OperatorLinkState = "connecting" | "listening" | "down" | "not_migrated" | "superseded" | "off";

export type OperatorLink = {
  link: OperatorLinkState;
  tab_id: string;
  last_poll_at: number | null;
  last_error: string | null;
  polls: number;
  failures: number;
  commands_handled: number;
  /** most recent remote action for the chip: "Started from operator" etc. */
  last_action: { kind: CommandKind; at: number; ok: boolean; error?: string; label: string } | null;
};

function makeTabId(): string {
  try {
    return `tab_${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `tab_${Math.random().toString(36).slice(2, 10)}`;
  }
}

const ACTION_LABEL: Record<CommandKind, string> = {
  start_day: "Started from operator",
  pause_day: "Paused from operator",
  resume_day: "Resumed from operator",
  end_day: "Stopped from operator",
};

function log(event: string, data: Record<string, unknown>) {
  try {
    console.info(`[operator-link] ${event}`, JSON.stringify(data));
  } catch {
    console.info(`[operator-link] ${event}`);
  }
}

export function useCommandPoll(opts: { enabled: boolean; actions: CommandActions }): OperatorLink {
  const { enabled } = opts;
  const actionsRef = React.useRef(opts.actions);
  actionsRef.current = opts.actions;

  const tabIdRef = React.useRef<string>("");
  if (!tabIdRef.current) tabIdRef.current = makeTabId();

  const [state, setState] = React.useState<OperatorLink>({
    link: enabled ? "connecting" : "off",
    tab_id: tabIdRef.current,
    last_poll_at: null,
    last_error: null,
    polls: 0,
    failures: 0,
    commands_handled: 0,
    last_action: null,
  });

  React.useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, link: "off" }));
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = BACKOFF_MIN_MS;
    let prevPollAt: string | null = null; // server `now` from the last successful poll (D4)
    let busy = false;
    let chain: Promise<void> = Promise.resolve(); // commands run serially, off the poll loop
    const handled = new Set<string>();
    const tabId = tabIdRef.current;

    const patch = (p: Partial<OperatorLink>) => {
      if (!cancelled) setState((s) => ({ ...s, ...p }));
    };

    const schedule = (ms: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), ms);
    };

    const ack = async (id: string, body: { ok: boolean; session_id?: string | null; error?: string | null }) => {
      for (let attempt = 0; attempt < ACK_RETRIES; attempt++) {
        try {
          const res = await fetch(`/api/bench/commands/${encodeURIComponent(id)}/ack`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8_000),
          });
          if (res.ok || res.status === 404) return; // 404 = no longer pending (expired/acked) — nothing to do
        } catch {
          /* retry */
        }
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
      }
      log("ack_failed", { id });
    };

    const run = async (cmd: { id: string; kind: CommandKind; args: unknown }) => {
      const a = actionsRef.current;
      const args = (typeof cmd.args === "object" && cmd.args !== null ? cmd.args : {}) as Record<string, unknown>;
      const snap = a.getSnapshot();
      let result: { ok: boolean; session_id?: string | null; error?: string | null };
      try {
        switch (cmd.kind) {
          case "start_day": {
            if (snap.state === "recording") {
              result = { ok: true, session_id: snap.sessionId };
            } else if (snap.state === "paused") {
              if (args.override_pause === true) {
                await a.resume();
                result = { ok: true, session_id: a.getSnapshot().sessionId };
              } else {
                result = { ok: false, error: "room_paused" };
              }
            } else if (snap.state === "ending") {
              result = { ok: false, error: "ending_in_progress" };
            } else {
              const r = await a.start();
              result = { ok: true, session_id: r.session_id };
            }
            break;
          }
          case "pause_day": {
            if (snap.state !== "recording") result = { ok: false, error: "not_recording" };
            else {
              await a.pause();
              result = { ok: true, session_id: snap.sessionId };
            }
            break;
          }
          case "resume_day": {
            if (snap.state !== "paused") result = { ok: false, error: "not_paused" };
            else {
              await a.resume();
              result = { ok: true, session_id: snap.sessionId };
            }
            break;
          }
          case "end_day": {
            if (snap.state !== "recording" && snap.state !== "paused") result = { ok: false, error: "no_active_session" };
            else {
              await a.end(); // existing flow: flush last chunk → PATCH end → ended
              result = { ok: true, session_id: snap.sessionId };
            }
            break;
          }
          default:
            result = { ok: false, error: "unknown_kind" };
        }
      } catch (e) {
        result = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160) };
      }
      log("command", { id: cmd.id, kind: cmd.kind, ok: result.ok, error: result.error ?? null });
      const label = result.ok ? ACTION_LABEL[cmd.kind] ?? cmd.kind : `Operator ${cmd.kind.replace("_day", "")} refused: ${result.error}`;
      patch({ last_action: { kind: cmd.kind, at: Date.now(), ok: result.ok, error: result.error ?? undefined, label } });
      setState((s) => ({ ...s, commands_handled: s.commands_handled + 1 }));
      await ack(cmd.id, result);
    };

    const tick = async () => {
      if (cancelled) return;
      if (busy) {
        schedule(POLL_VISIBLE_MS);
        return;
      }
      busy = true;
      const snap = actionsRef.current.getSnapshot();
      const qs = new URLSearchParams({ tab_id: tabId });
      if (prevPollAt) qs.set("prev_poll_at", prevPollAt);
      if (snap.sessionId && (snap.state === "recording" || snap.state === "paused")) qs.set("recording_session_id", snap.sessionId);
      qs.set("paused", snap.state === "paused" ? "true" : "false");
      try {
        const res = await fetch(`/api/bench/commands?${qs.toString()}`, { signal: AbortSignal.timeout(6_000), cache: "no-store" });
        const j = (await res.json().catch(() => null)) as
          | { ok?: boolean; superseded?: boolean; now?: string; commands?: Array<{ id: string; kind: CommandKind; args: unknown }>; error?: string }
          | null;
        if (res.status === 503 && j?.error === "bus_not_migrated") {
          setState((s) => ({ ...s, link: "not_migrated", last_error: "bus_not_migrated", failures: s.failures + 1 }));
          busy = false;
          schedule(BACKOFF_MAX_MS);
          return;
        }
        if (!res.ok || !j) throw new Error(j?.error ?? `poll_${res.status}`);
        if (j.superseded) {
          log("superseded", { tab_id: tabId });
          patch({ link: "superseded", last_poll_at: Date.now() });
          busy = false;
          // D3: stop recording too — flush the segment to disk + upload, never PATCH end.
          // Queued after any in-flight command; its failure must not resurrect the poll.
          chain = chain.then(() => actionsRef.current.takeover()).catch(() => undefined);
          return; // stop polling for good — the other tab owns the room
        }
        prevPollAt = j.now ?? new Date().toISOString();
        backoff = BACKOFF_MIN_MS;
        setState((s) => ({ ...s, link: "listening", last_poll_at: Date.now(), last_error: null, polls: s.polls + 1 }));
        for (const cmd of j.commands ?? []) {
          if (cancelled) break;
          if (handled.has(cmd.id)) continue;
          handled.add(cmd.id);
          // Do not block the poll on a long action (end_day flushes the last chunk): queue it.
          chain = chain.then(() => run(cmd)).catch(() => undefined);
        }
        busy = false;
        schedule(typeof document !== "undefined" && document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 120);
        setState((s) => ({ ...s, link: "down", last_error: msg, failures: s.failures + 1 }));
        log("poll_failed", { error: msg, backoff_ms: backoff });
        busy = false;
        schedule(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    };

    const onVis = () => {
      if (!document.hidden && !busy) schedule(200);
    };
    document.addEventListener("visibilitychange", onVis);
    log("mount", { tab_id: tabId });
    schedule(200);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled]);

  // Let the action banner fade after a minute (chip falls back to link status).
  React.useEffect(() => {
    if (!state.last_action) return;
    const t = setTimeout(() => setState((s) => (s.last_action && Date.now() - s.last_action.at >= ACTION_BANNER_MS ? { ...s, last_action: null } : s)), ACTION_BANNER_MS + 50);
    return () => clearTimeout(t);
  }, [state.last_action]);

  return state;
}
