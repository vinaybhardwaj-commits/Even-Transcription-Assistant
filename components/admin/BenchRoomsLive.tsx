"use client";

/**
 * BenchRoomsLive — the live operator monitor, above the Bench session table.
 *
 * Built to be watched for a whole OPD day on 24 August, so the shape follows
 * AdminDashboardOverview: visibility-guarded polling, cache:"no-store", the same refresh chrome,
 * and an attention list at the top. The badge classes are BenchClient's, character for character,
 * so this screen does not invent a second visual language two rows below the first.
 *
 * TWO POLLS AND A TICK, which is the whole performance design:
 *
 *   3 s   /api/admin/bench/listeners   one small table — is a page open, is it paused
 *   20 s  /api/admin/bench/rooms-live  the aggregates over cue and bench_chunk
 *   1 s   NOTHING IS FETCHED. A single interval bumps a counter, and every age on screen is
 *         recomputed from the INSTANTS the server already sent. Ages tick smoothly at one
 *         request per twenty seconds rather than one per tick.
 *
 * Both polls skip while document.hidden, so a tab left open overnight is free.
 *
 * THE NAMING RULE, and it is the reason this screen exists. The doctor-clock vital is labelled
 * "this doctor" and never "warehouse". even_hospitals.doctor_opd_rooms is null on every hospital,
 * so the warehouse holds no room: a gap means the LABELLED doctor has not clocked, not that the
 * room is empty and not that Pulse is down. Another doctor may be in the room seeing patients the
 * whole time, and the copy says so. Reading it the other way is what turned a busy morning into
 * an apparent six-hour blackout on 19 August.
 */

import * as React from "react";
// From the PURE constants module, NOT lib/admin/rooms-live: that file imports lib/db and
// lib/brain/db, and importing it here would pull a Postgres driver into the browser bundle.
import { roomState, type RoomState } from "@/lib/bench-bus-constants";

// ---------------------------------------------------------------------------
// The selected room — shared with BenchClient, which renders that room's sessions
// ---------------------------------------------------------------------------
//
// A module-level store rather than lifted state, because the two components are SIBLINGS under a
// server component (app/admin/bench/page.tsx) that cannot hold client state. This is the smallest
// thing that works without a context provider in the page.
//
// The `source` field is the part that matters. A selection made by a PERSON is never overwritten;
// a `default` one may be replaced when better information arrives — the recording room outranks
// "most recent session", and the two components learn those facts from different polls. Without
// it, either the default would fight the user's click, or the first component to load would win.

export type Selection = { roomId: string; source: "default" | "user" } | null;

let selection: Selection = null;
const storeSubs = new Set<() => void>();
const emit = () => { for (const l of storeSubs) l(); };

export const selectedRoom = {
  get: (): Selection => selection,
  subscribe: (fn: () => void) => { storeSubs.add(fn); return () => { storeSubs.delete(fn); }; },
  /** A person clicked. This wins over anything, for ever. */
  choose: (roomId: string) => { selection = { roomId, source: "user" }; emit(); },
  /** A component worked out a default. Never overrides a person, never overrides itself pointlessly. */
  suggest: (roomId: string) => {
    if (selection?.source === "user") return;
    if (selection?.roomId === roomId) return;
    selection = { roomId, source: "default" };
    emit();
  },
  /** Tests only — the store outlives a component, which is the point of it. */
  reset: () => { selection = null; emit(); },
};

export function useSelectedRoom(): Selection {
  return React.useSyncExternalStore(selectedRoom.subscribe, selectedRoom.get, () => null);
}

// ---------------------------------------------------------------------------
// Wire shapes (mirrors of the two routes)
// ---------------------------------------------------------------------------

type Level = "ok" | "amber" | "red" | "unknown";

type ListenerRowView = {
  room_id: string;
  room_slug: string;
  room_name: string;
  listening: boolean;
  age_ms: number;
  paused: boolean;
  recording_session_id: string | null;
  tab_id: string;
  last_poll_at: string;
};

type ListenersResp = { now: string; freshness_window_ms: number; listeners: ListenerRowView[]; degraded?: string[] };

type RoomLive = {
  room: { id: string; slug: string; name: string };
  recording: boolean;
  paused_session: boolean;
  session_id: string | null;
  session_started_at: string | null;
  last_primary_at: string | null;
  last_backup_at: string | null;
  last_piece_at: string | null;
  mic_level: Level;
  backup_chunks_today: number;
  backup_reads_no_chunks: boolean;
  stalled: boolean;
  stalled_age_ms: number | null;
  last_warehouse_at: string | null;
  doctor_clock_silent_ms: number | null;
  doctor_clock_level: Level;
  marks_today: number;
  last_mark_at: string | null;
  marks_not_sent: number;
  last_window_asked_at: string | null;
  last_window_complete: boolean | null;
  degraded: string[];
};

type RoomsLiveResp = {
  ist_date: string;
  now: string;
  rooms: RoomLive[];
  thresholds?: { mic_amber_ms: number; mic_red_ms: number; doctor_clock_amber_ms: number; doctor_clock_red_ms: number; listener_fresh_ms: number; stall_minutes: number };
  degraded?: string[];
};

const LISTENER_POLL_MS = 3_000;
const ROLLUP_POLL_MS = 20_000;
const TICK_MS = 1_000;

/**
 * B4 — how long an armed Stop stays armed.
 *
 * Stop is two taps because ending a day is not undoable from here. Until K3 the first tap armed
 * it FOR EVER: an operator who tapped once, got distracted and pocketed the tablet was carrying
 * a live clinic day one stray tap from ending. Ten seconds is longer than a deliberate second
 * tap and far shorter than a walk down a corridor.
 */
const CONFIRM_STOP_MS = 10_000;

/**
 * A4 — WHY START IS OFF, as a sentence the operator can read without a mouse.
 *
 * iOS Safari never renders a `title`, and this was the only place the rule was written down, so
 * on a tablet a disabled Start button simply looked broken. Each branch names the CAUSE and the
 * FIX, because "not ready" alone sends someone to the wrong room.
 *
 * Returns null when start IS available — the caller renders nothing at all then.
 */
export function startBlockedReason(state: RoomState): string | null {
  switch (state) {
    case "ready":
      return null;
    case "recording":
      return "Start is off because this room is already recording. Use stop to end the day first.";
    case "paused":
      return "Start is off because this room is paused for consent. Use resume, not start.";
    case "dropped":
      return "Start is off because the kiosk page stopped responding. Reopen the room page on the clinic Mac.";
    case "offline":
      return "Start is off because no kiosk page is open in this room. Open the room page on the clinic Mac.";
    case "cant_tell":
      return "Start is off because the kiosk state could not be read just now. It will offer itself when the next poll succeeds.";
    default:
      return "Start is off until the kiosk is listening and the room is neither recording nor paused.";
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers — pure
// ---------------------------------------------------------------------------

/** m:ss up to an hour, then h:mm. Ages are read at a glance, never parsed. */
export function fmtAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const ageMs = (iso: string | null, nowMs: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
};

/** BenchClient's classes, reused verbatim so the two tables read as one surface. */
const PILL = "inline-block px-2 py-0.5 rounded-full text-caption font-semibold";

/**
 * A3 — one class for every room-card control, so a sixth button cannot be added at 20px.
 * min-h-11/min-w-11 is 2.75rem = 44px, the iOS/WCAG touch minimum, in BOTH directions.
 */
const CTRL_BTN =
  "min-h-11 min-w-11 px-4 py-2 rounded-lg text-label bg-even-ink-100 hover:bg-even-ink-200 active:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed";
const LEVEL_CLASS: Record<Level, string> = {
  ok: "bg-success-100 text-success-700",
  amber: "bg-warning-100 text-warning-700",
  red: "bg-danger-100 text-danger-700",
  unknown: "bg-even-ink-100 text-even-ink-500",
};

function Pill({ level, children, title }: { level: Level; children: React.ReactNode; title?: string }) {
  return <span className={`${PILL} ${LEVEL_CLASS[level]}`} title={title}>{children}</span>;
}

/** The card's edge carries the WORST condition on it, so trouble is found before it is read. */
const CARD_EDGE: Record<Level, string> = {
  ok: "border-even-ink-200 bg-even-white",
  amber: "border-warning-200 bg-warning-50",
  red: "border-danger-200 bg-danger-50",
  unknown: "border-even-ink-200 bg-even-ink-50",
};

/** The chip word for each state. The full sentence is roomState()'s `label`. */
const STATE_WORD: Record<RoomState, string> = {
  cant_tell: "can't tell",
  paused: "paused",
  recording: "recording",
  ready: "ready",
  dropped: "dropped",
  offline: "offline",
};

// ---------------------------------------------------------------------------
// The attention list — pure, and tested
// ---------------------------------------------------------------------------

export type Attention = { room: string; severity: "red" | "amber"; title: string; detail: string };

/**
 * PURE — what an operator should walk over to, worst first.
 *
 * Every string here is the operator's whole context. The doctor-clock item in particular never
 * says "warehouse": it names the doctor and says out loud that somebody else may be in the room,
 * because the alternative reading is the one that has already cost a day.
 */
export function attentionItems(rooms: readonly RoomLive[], listeners: ReadonlyMap<string, ListenerRowView>, listenersKnown: boolean, nowMs: number): Attention[] {
  const out: Attention[] = [];
  for (const r of rooms) {
    const name = r.room.name;
    const l = listeners.get(r.room.id);

    if (r.recording && listenersKnown && (!l || !l.listening)) {
      out.push({
        room: name,
        severity: "red",
        title: "recording with no kiosk page open",
        detail: l ? `the room page last polled ${fmtAge(l.age_ms)} ago` : "no kiosk tab has ever polled this room",
      });
    }
    if (r.stalled) {
      out.push({ room: name, severity: "red", title: "stalled", detail: `recording, but no piece from either mic for ${fmtAge(r.stalled_age_ms)}` });
    } else if (r.mic_level === "red" || r.mic_level === "amber") {
      out.push({
        room: name,
        severity: r.mic_level,
        title: r.mic_level === "red" ? "no audio uploading" : "audio slowing down",
        detail: `last piece ${fmtAge(ageMs(r.last_piece_at, nowMs))} ago`,
      });
    }
    if (r.doctor_clock_level === "red" || r.doctor_clock_level === "amber") {
      out.push({
        room: name,
        severity: r.doctor_clock_level,
        title: `no clock from this doctor for ${fmtAge(r.doctor_clock_silent_ms)}`,
        // NEVER "warehouse silent". This vital cannot see the room.
        detail: "another doctor may be in this room and seeing patients — the warehouse holds no room, so this cannot tell you the room is empty",
      });
    }
    if (r.backup_reads_no_chunks) {
      out.push({ room: name, severity: "amber", title: "backup mic reads no chunks", detail: "the second microphone has recorded nothing at all this session" });
    }
    if (r.marks_not_sent > 0) {
      out.push({ room: name, severity: "amber", title: `${r.marks_not_sent} mark${r.marks_not_sent === 1 ? "" : "s"} did not reach the brain`, detail: "the kiosk recorded the press but the cue never landed" });
    }
    if (r.last_window_complete === false) {
      out.push({ room: name, severity: "amber", title: "a transcription window did not finish", detail: `asked ${fmtAge(ageMs(r.last_window_asked_at, nowMs))} ago and rolled back — re-run it` });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export function BenchRoomsLive() {
  const [listeners, setListeners] = React.useState<ListenersResp | null>(null);
  const [rollup, setRollup] = React.useState<RoomsLiveResp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [lastFetchAt, setLastFetchAt] = React.useState<number | null>(null);
  const [, setTick] = React.useState(0);
  /** Stop is two clicks: the first arms this, the second sends. */
  const [confirmStop, setConfirmStop] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const fetchListeners = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/bench/listeners", { cache: "no-store" });
      const j = (await res.json()) as ListenersResp & { error?: { message?: string } };
      if (!res.ok) throw new Error(j.error?.message ?? `http_${res.status}`);
      setListeners(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const fetchRollup = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/bench/rooms-live", { cache: "no-store" });
      const j = (await res.json()) as RoomsLiveResp & { error?: { message?: string } };
      if (!res.ok) throw new Error(j.error?.message ?? `http_${res.status}`);
      setRollup(j);
      setLastFetchAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => { void fetchListeners(); void fetchRollup(); }, [fetchListeners, fetchRollup]);

  React.useEffect(() => {
    const i = globalThis.setInterval(() => { if (!document.hidden) void fetchListeners(); }, LISTENER_POLL_MS);
    return () => globalThis.clearInterval(i);
  }, [fetchListeners]);

  React.useEffect(() => {
    const i = globalThis.setInterval(() => { if (!document.hidden) void fetchRollup(); }, ROLLUP_POLL_MS);
    return () => globalThis.clearInterval(i);
  }, [fetchRollup]);

  // The tick fetches NOTHING. It only forces a re-render so every age below is recomputed from
  // the instants already in state.
  React.useEffect(() => {
    const i = globalThis.setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => globalThis.clearInterval(i);
  }, []);

  // B4 — an armed Stop disarms itself. Re-armed by a second tap; cleared on unmount.
  React.useEffect(() => {
    if (!confirmStop) return;
    const t = globalThis.setTimeout(() => setConfirmStop(null), CONFIRM_STOP_MS);
    return () => globalThis.clearTimeout(t);
  }, [confirmStop]);

  const nowMs = Date.now();
  const listenerMap = React.useMemo(() => {
    const m = new Map<string, ListenerRowView>();
    for (const l of listeners?.listeners ?? []) m.set(l.room_id, l);
    return m;
  }, [listeners]);
  const listenersKnown = Boolean(listeners) && !(listeners?.degraded?.length);
  const rooms = rollup?.rooms ?? [];
  const attention = React.useMemo(() => attentionItems(rooms, listenerMap, listenersKnown, nowMs), [rooms, listenerMap, listenersKnown, nowMs]);
  const selectedId = useSelectedRoom()?.roomId ?? null;

  // DEFAULT SELECTION, first rule: the room that is RECORDING. `suggest` never overrides a click,
  // so this cannot fight the operator, and it outranks BenchClient's "most recent session" default
  // because the two components learn their facts from different polls and this one is better.
  React.useEffect(() => {
    const rec = rooms.find((r) => r.recording);
    if (rec) selectedRoom.suggest(rec.room.id);
  }, [rooms]);

  const send = React.useCallback(async (roomId: string, kind: string, overridePause = false) => {
    setNote(null);
    try {
      const res = await fetch("/api/admin/bench/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ room_id: roomId, kind, ...(overridePause ? { override_pause: true } : {}) }),
      });
      const j = (await res.json()) as Record<string, unknown>;
      if (!res.ok || j.ok !== true) {
        setNote(`${kind}: ${String(j.error ?? `http_${res.status}`)}${j.hint ? ` — ${String(j.hint)}` : ""}`);
      } else if (j.already_recording) {
        setNote(`${kind}: already recording (${String(j.session_id)})`);
      } else {
        setNote(`${kind}: queued for the kiosk`);
      }
    } catch (e) {
      setNote(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConfirmStop(null);
      void fetchListeners();
      void fetchRollup();
    }
  }, [fetchListeners, fetchRollup]);

  return (
    <section className="space-y-4 mb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500">
            LIVE MONITOR{rollup?.ist_date ? ` · ${rollup.ist_date} IST` : ""}
          </p>
          <h2 className="text-heading text-even-navy-800">Rooms, right now</h2>
        </div>
        <div className="flex items-center gap-2 text-caption text-even-ink-400">
          {busy ? <span>Refreshing…</span> : null}
          {lastFetchAt ? <span suppressHydrationWarning>updated {new Date(lastFetchAt).toLocaleTimeString()}</span> : null}
          <button
            type="button"
            onClick={() => { void fetchListeners(); void fetchRollup(); }}
            aria-label="Refresh now"
            className="h-11 w-11 inline-flex items-center justify-center rounded-lg text-heading bg-even-ink-100 hover:bg-even-ink-200 active:bg-even-ink-200"
          >
            ↻
          </button>
        </div>
      </div>

      {error ? <p className="text-caption text-danger-700">monitor read failed: {error} — showing the last good picture</p> : null}
      {note ? <p className="text-caption text-even-ink-600">{note}</p> : null}
      {rollup?.degraded?.length ? <p className="text-caption text-warning-700">degraded: {rollup.degraded.join(" · ")}</p> : null}
      {listeners?.degraded?.length ? <p className="text-caption text-warning-700">kiosk state unknown: {listeners.degraded.join(" · ")}</p> : null}

      {attention.length > 0 ? (
        <div className="rounded-lg border border-even-ink-200 divide-y divide-even-ink-100">
          <p className="px-3 py-2 text-caption uppercase tracking-wide text-even-ink-500">Needs your attention</p>
          {attention.map((a, i) => (
            <div key={`${a.room}-${i}`} className="px-3 py-2 flex items-start gap-3">
              <Pill level={a.severity}>{a.severity === "red" ? "act now" : "watch"}</Pill>
              <div className="min-w-0">
                <p className="text-body text-even-navy-800"><span className="font-semibold">{a.room}</span> — {a.title}</p>
                <p className="text-caption text-even-ink-500">{a.detail}</p>
              </div>
            </div>
          ))}
        </div>
      ) : rooms.length > 0 ? (
        <p className="text-caption text-success-700">Nothing needs attention.</p>
      ) : null}

      {/* CARDS, not rows (E1). A table is for comparing rooms; the operator is not comparing,
          they are scanning for trouble — so the worst condition promotes the whole card and finds
          the eye without being read. Selecting a card reveals that room's recordings below. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rooms.map((r) => {
          const l = listenerMap.get(r.room.id);
          const st = roomState({
            listenerReadFailed: !listenersKnown,
            listener: l ? { last_poll_at: l.last_poll_at, paused: l.paused } : null,
            pausedSession: r.paused_session,
            recording: r.recording,
            recordingSince: r.session_started_at,
            nowMs,
          });
          const worst: Level = r.stalled || st.level === "red" || r.mic_level === "red" || r.doctor_clock_level === "red"
            ? "red"
            : st.level === "amber" || r.mic_level === "amber" || r.doctor_clock_level === "amber" || r.backup_reads_no_chunks || r.marks_not_sent > 0
              ? "amber"
              : st.level === "unknown" ? "unknown" : "ok";
          const isSelected = selectedId === r.room.id;
          return (
            // B3 — this WAS a <button> with five more <button>s inside it, which is invalid
            // HTML: browsers reparent nested interactive content, so the controls were living
            // outside the card in the real DOM and only a stopPropagation on a wrapping div was
            // holding the behaviour together. It is a div now, with an explicit role, a tab
            // stop and Enter/Space, so selection is still fully keyboard-reachable.
            <div
              key={r.room.id}
              role="button"
              tabIndex={0}
              onClick={() => selectedRoom.choose(r.room.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectedRoom.choose(r.room.id);
                }
              }}
              aria-pressed={isSelected}
              aria-label={`Select ${r.room.name}`}
              className={`text-left rounded-xl border p-4 transition cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-even-blue-400 ${CARD_EDGE[worst]} ${isSelected ? "ring-2 ring-even-blue-400" : "hover:bg-even-ink-50"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-even-navy-800 truncate">{r.room.name}</p>
                  <p className="text-caption text-even-ink-400 truncate">{r.room.slug}</p>
                </div>
                <Pill level={st.level} title={st.hint ?? undefined}>{STATE_WORD[st.state]}</Pill>
              </div>

              <p className="mt-2 text-body text-even-navy-800">{st.label}</p>
              {st.hint ? <p className="text-caption text-even-ink-500">{st.hint}</p> : null}

              <dl className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  {/* A4 — "on the UPLOAD clock, 0–5 min is healthy" used to live only in the
                      pill's title, which iOS never renders, so the number had no units. */}
                  <dt className="text-caption text-even-ink-500">Mic <span className="text-even-ink-400">· newest piece, 0–5 min is healthy</span></dt>
                  <dd>
                    {/* READY CLAIMS NOTHING ABOUT THE MICROPHONES. Before a session starts there
                        are no chunks, so mic health is unknown by construction — the mockup's
                        "both mics seen" was not buildable and is not built. */}
                    {st.state === "ready" || (!r.recording && r.last_piece_at === null) ? (
                      <span className="text-caption text-even-ink-400">no tape yet</span>
                    ) : (
                      <Pill level={r.mic_level} title="newest piece on either mic, on the UPLOAD clock — a healthy mic cycles 0–5 min">
                        {r.last_piece_at ? fmtAge(ageMs(r.last_piece_at, nowMs)) : r.recording ? "no piece yet" : "—"}
                      </Pill>
                    )}
                  </dd>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <dt className="text-caption text-even-ink-500" title="Pulse clocks from the LABELLED doctor only. The warehouse holds no room.">This doctor</dt>
                  <dd>
                    {r.doctor_clock_silent_ms === null ? (
                      <span className="text-caption text-even-ink-400">—</span>
                    ) : (
                      <Pill
                        level={r.doctor_clock_level}
                        title="Pulse clocks from the LABELLED doctor only. Another doctor may be in this room and seeing patients — the warehouse holds no room, so this cannot tell you the room is empty."
                      >
                        {fmtAge(r.doctor_clock_silent_ms)}
                      </Pill>
                    )}
                  </dd>
                </div>
                {/* A4 — THE MISREADING THIS PREVENTS is the one that turned a busy morning into
                    an apparent six-hour blackout on 19 August. It lived only in a `title`, which
                    is exactly nowhere on the iPad this screen is now built for. Shown only when
                    the vital is actually complaining, so a healthy card stays short. */}
                {r.doctor_clock_level === "amber" || r.doctor_clock_level === "red" ? (
                  <p className="text-caption text-even-ink-500 leading-snug">
                    A gap here means the labelled doctor has not clocked — not that the room is
                    empty. Another doctor may be in it seeing patients.
                  </p>
                ) : null}

                <div className="flex items-center justify-between gap-2">
                  <dt className="text-caption text-even-ink-500">Marks</dt>
                  <dd className="text-caption text-even-navy-800">
                    {r.marks_today}
                    {r.marks_not_sent > 0 ? <span className={`${PILL} ${LEVEL_CLASS.amber} ml-1.5`}>{r.marks_not_sent} not sent</span> : null}
                  </dd>
                </div>

                {r.backup_reads_no_chunks ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-caption text-even-ink-500">Backup mic</dt>
                    <dd><Pill level="amber" title="the second microphone has recorded nothing at all this session">reads no chunks</Pill></dd>
                  </div>
                ) : null}
                {r.backup_reads_no_chunks ? (
                  <p className="text-caption text-even-ink-500 leading-snug">
                    The second microphone has recorded nothing at all this session.
                  </p>
                ) : null}

                {r.last_window_complete === false ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-caption text-even-ink-500">Transcription</dt>
                    <dd><Pill level="amber" title="the turns were rolled back — re-run this window">window did not finish</Pill></dd>
                  </div>
                ) : null}
                {r.last_window_complete === false ? (
                  <p className="text-caption text-even-ink-500 leading-snug">
                    The turns were rolled back, so that window holds nothing. Re-run it.
                  </p>
                ) : null}
              </dl>

              {/* Controls live inside the card but are not part of its click target.
                  A3 — every one of these was `px-2 py-0.5 text-caption`, about 20px tall, which
                  is under half the 44pt minimum and unhittable while walking. The TEXT grew from
                  caption to label and the PADDING carries the rest; nothing was shrunk. */}
              <div className="mt-3 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  disabled={st.state !== "ready"}
                  title={st.state === "ready" ? "queue start_day" : startBlockedReason(st.state) ?? undefined}
                  onClick={() => void send(r.room.id, "start_day")}
                  className={CTRL_BTN}
                >
                  start
                </button>
                <button
                  type="button"
                  disabled={!r.recording}
                  onClick={() => void send(r.room.id, "pause_day")}
                  className={CTRL_BTN}
                >
                  pause
                </button>
                <button
                  type="button"
                  disabled={st.state !== "paused"}
                  onClick={() => void send(r.room.id, "resume_day")}
                  className={CTRL_BTN}
                >
                  resume
                </button>
                {/* TWO TAPS. Ending a day is not undoable from here — and since K3 the armed
                    state also EXPIRES (B4), so a tablet in a pocket is not one stray tap from
                    ending a clinic. Armed is solid danger, not a tint, so it is unmistakable. */}
                {confirmStop === r.room.id ? (
                  <button
                    type="button"
                    onClick={() => void send(r.room.id, "end_day")}
                    className="min-h-11 min-w-11 px-4 py-2 rounded-lg text-label font-semibold bg-danger-500 text-even-white ring-2 ring-danger-700 ring-offset-1 hover:bg-danger-700"
                  >
                    confirm stop
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!r.recording && !r.paused_session}
                    onClick={() => setConfirmStop(r.room.id)}
                    className={CTRL_BTN}
                  >
                    stop
                  </button>
                )}
              </div>

              {/* A4 — THE LOAD-BEARING SENTENCE. This is the only place that says why Start is
                  disabled, and it used to be a `title`, which iOS Safari never renders: on the
                  iPad this screen now targets, a greyed Start had no explanation anywhere at
                  all. It names the cause and the fix, and it is only rendered when Start is
                  actually off. */}
              {startBlockedReason(st.state) ? (
                <p className="mt-2 text-caption text-even-ink-600 leading-snug">{startBlockedReason(st.state)}</p>
              ) : null}
              {confirmStop === r.room.id ? (
                <p className="mt-2 text-caption text-danger-700 leading-snug">
                  Tap “confirm stop” to end this day. This disarms itself in {CONFIRM_STOP_MS / 1000} seconds.
                </p>
              ) : null}
            </div>
          );
        })}
        {rooms.length === 0 ? (
          <p className="text-caption text-even-ink-400">{rollup ? "no enabled rooms" : "loading…"}</p>
        ) : null}
      </div>

      <p className="text-caption text-even-ink-400">
        “This doctor” counts Pulse clocks from the labelled doctor only. The warehouse holds no room, so a gap there
        never means the room is empty — another doctor may be in it and seeing patients.
      </p>
    </section>
  );
}
