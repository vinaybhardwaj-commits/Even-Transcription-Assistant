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
import {
  ENDED_DISAGREES_TITLE,
  ENDED_DISAGREES_HINT,
  NO_DAY_TITLE,
  NO_DAY_FIX,
  type RoomState,
} from "@/lib/bench-bus-constants";
// The lane words, the stranded-audio reasons and the measurement warning come from the same
// pure module the server renders them with and the MCP door reports them from (§3.6). Safe in a
// browser bundle: lib/room-facts.ts imports lib/bench-bus-constants and nothing else.
import {
  STRANDED_MEASURE_NOTE,
  STRANDED_WAITING,
  WAITING_PHRASE,
} from "@/lib/room-facts";
import { BenchAttentionList } from "@/components/admin/bench-live/BenchAttentionList";
import { BenchCommandTransport } from "@/components/admin/bench-live/BenchCommandTransport";
import { BenchDangerZone } from "@/components/admin/bench-live/BenchDangerZone";
import { BenchDaySummary } from "@/components/admin/bench-live/BenchDaySummary";
import { BenchRoomFocus } from "@/components/admin/bench-live/BenchRoomFocus";
import {
  ageMs,
  BenchRoomVitals,
  BenchRoomStatusChips,
  fmtAge,
  fmtMinutes,
} from "@/components/admin/bench-live/BenchRoomVitals";
import { RoomCard } from "@/components/admin/bench-live/RoomCard";
import { roomPresentation } from "@/components/admin/bench-live/roomPresentation";
import {
  resolveRoomQuery,
  roomSelectionUrl,
} from "@/components/admin/bench-live/roomSelection";
import { useBenchLivePolling } from "@/components/admin/bench-live/useBenchLivePolling";
import type {
  Attention,
  CommandOutcome,
  LaneLevel,
  LaneView,
  Level,
  ListenerRowView,
  RoomLive,
} from "@/components/admin/bench-live/types";

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

/** §3.10 — one window's line in a run-waiting-audio report: what engine ran it, characters out,
 *  seconds taken, and what it cost. `step` names why a window did not run (flag_off, no_chunks…). */
type RunOutcome = {
  window_id: string;
  ok: boolean;
  step: string;
  engine?: string | null;
  transcript_chars?: number | null;
  cost_usd?: number | null;
  sarvam_ms?: number | null;
  audio_seconds?: number | null;
};

/**
 * B4 — how long an armed Stop stays armed.
 *
 * Stop is two taps because ending a day is not undoable from here. Until K3 the first tap armed
 * it FOR EVER: an operator who tapped once, got distracted and pocketed the tablet was carrying
 * a live clinic day one stray tap from ending. Ten seconds is longer than a deliberate second
 * tap and far shorter than a walk down a corridor.
 */
const CONFIRM_STOP_MS = 10_000;

// ---------------------------------------------------------------------------
// Presentation helpers — pure
// ---------------------------------------------------------------------------

/** BenchClient's classes, reused verbatim so the two tables read as one surface. */
const PILL = "inline-block px-2 py-0.5 rounded-full text-caption font-semibold";

const LEVEL_CLASS: Record<Level, string> = {
  ok: "bg-success-100 text-success-700",
  amber: "bg-warning-100 text-warning-700",
  red: "bg-danger-100 text-danger-700",
  unknown: "bg-even-ink-100 text-even-ink-500",
};

function Pill({ level, children, title }: { level: Level; children: React.ReactNode; title?: string }) {
  return <span className={`${PILL} ${LEVEL_CLASS[level]}`} title={title}>{children}</span>;
}

/** The chip word for each state. The full sentence is roomState()'s `label`. */
const STATE_WORD: Record<RoomState, string> = {
  cant_tell: "can't tell",
  paused: "paused",
  recording: "recording",
  finished: "finished",
  ready: "ready",
  dropped: "dropped",
  offline: "offline",
};

/**
 * D30 — FINISHED WEARS GREY, not green and never amber.
 *
 * Its level is `ok`, which is right for the card edge and for the worst-condition rollup: a
 * finished day is not a problem. But GREEN MEANS WORKING on this screen, and a day that is over
 * is not working — the same argument that makes a switched-on lane with nothing to do grey. Both
 * shades are defined in tailwind.config.ts; an undefined one would render as nothing at all and
 * has three times before.
 */
const FINISHED_PILL = "bg-even-ink-100 text-even-ink-600";

// ---------------------------------------------------------------------------
// The three lanes — Tape, Transcript, Visits (PRD R4)
// ---------------------------------------------------------------------------
//
// THE INTERFACE NEVER SAYS DRAIN, FUSE, WINDOW OR SUBJECT. Those are our words. A clinic manager
// reads this while walking between rooms, and the three words on this card are the ones that will
// end up in every conversation about this system from now on.

const LED: Record<LaneLevel, string> = {
  ok: "bg-success-500",
  amber: "bg-warning-500",
  red: "bg-danger-500",
  off: "bg-even-ink-200",
};

/**
 * The switch. 52x30 as drawn in the approved mockup, inside a 44-point-tall tap target — the
 * visual and the target are different things, and only one of them is a design decision. This is
 * operated on a tablet by somebody walking.
 */
function LaneSwitch({ on, busy, label, onToggle }: { on: boolean; busy: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="flex items-center justify-center h-11 min-w-11 px-0 shrink-0 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-even-blue-400 rounded-lg"
    >
      <span className={`relative block w-[52px] h-[30px] rounded-full transition-colors ${on ? "bg-success-500" : "bg-even-ink-200"}`}>
        <span className={`absolute top-[3px] w-6 h-6 rounded-full bg-even-white shadow transition-all ${on ? "left-[25px]" : "left-[3px]"}`} />
      </span>
    </button>
  );
}

function Lane({ name, view, sw }: { name: string; view: LaneView; sw?: React.ReactNode }) {
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-2.5">
        <i className={`w-2.5 h-2.5 rounded-full shrink-0 ${LED[view.level]}`} aria-hidden />
        <span className="text-caption font-semibold text-even-navy-800 w-[74px] shrink-0">{name}</span>
        <span className="text-caption text-even-ink-600 leading-snug flex-1 min-w-0">{view.state}</span>
        {sw}
      </div>
      {/* WHAT TO DO, under the state that needs it. A lane only carries a note when there is an
          action, so a healthy card stays as short as it was. */}
      {view.note ? (
        <p className="mt-1 ml-[22px] mr-[62px] text-caption font-semibold text-warning-700 leading-snug">
          {view.note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * While a switch write is in flight the lamp must not keep claiming the old truth. An optimistic
 * ON has nothing to show yet, so it reads "On, nothing to do" in grey — never green. Green means
 * working, and nothing has worked yet.
 */
function laneWithPending(view: LaneView, pendingOn: boolean | undefined): LaneView {
  if (pendingOn === undefined || pendingOn === view.enabled) return view;
  return pendingOn ? { level: "off", state: "On, nothing to do", enabled: true } : { level: "off", state: "Off", enabled: false };
}

// ---------------------------------------------------------------------------
// The attention list — pure, and tested
// ---------------------------------------------------------------------------

export type { Attention } from "@/components/admin/bench-live/types";

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

    const operational = roomPresentation(r, l, listenersKnown, nowMs).operational;
    for (const alert of operational) {
      out.push({
        roomId: r.room.id,
        room: name,
        severity: alert.severity,
        rank: alert.severity === "red" ? 0 : 1,
        title: alert.label,
        detail: alert.code === "kiosk_not_listening" && l
          ? `${alert.detail} The room page last polled ${fmtAge(l.age_ms)} ago.`
          : alert.detail,
      });
    }
    // ENDED DISAGREES — beside "recording with no kiosk page open" because it is the same
    // family of fault: the room and the record do not agree about whether a tape is running.
    // RED, and it says the audio is safe first, because that is the operator's first question and
    // an alarm that does not answer it gets read as data loss. bs_g3dwud4p lost nothing.
    if (r.ended_disagrees) {
      out.push({
        roomId: r.room.id,
        room: name,
        severity: "red",
        rank: 0,
        title: ENDED_DISAGREES_TITLE,
        detail: `${r.ended_disagrees_chunks} piece${r.ended_disagrees_chunks === 1 ? "" : "s"} stored since it was marked ended ${fmtAge(ageMs(r.ended_disagrees_ended_at, nowMs))} ago, newest ${fmtAge(ageMs(r.ended_disagrees_last_piece_at, nowMs))} ago — ${ENDED_DISAGREES_HINT}`,
      });
    }
    // §2.3 — A MICROPHONE PRODUCING PIECES THAT ARE NOT AUDIO.
    //
    // D36 IS THE GUARD, and without it this is the fifth false alarm. `proven_dead_by_size` is
    // true only when two consecutive FULL-LENGTH pieces came back tiny AND THE METER HEARD SOUND
    // through both — a quiet room making small pieces is quiet, not broken, and a slow afternoon
    // must not raise anything. A piece carrying no level reading can never satisfy it.
    if (r.recording && r.mic_size?.proven_dead_by_size) {
      out.push({
        roomId: r.room.id,
        room: name,
        severity: "red",
        rank: 0,
        title: "the main microphone is producing pieces that are not audio",
        detail: "two full-length pieces in a row came back a fraction of this microphone's usual size while the meter could hear the room. Go to the room and check the microphone.",
      });
    }
    // §3.6 — THE MIRROR IMAGE, which the DOOR has raised since it was written and the screen
    // could not. `ended_disagrees` above is the tape running on after the row said stop; this is
    // the row claiming to have run on after the tape stopped — a stored end time later than the
    // last piece by more than the stall window. Two different faults, and until this build each
    // surface carried exactly one of them, so an operator and a watcher looking at one room saw
    // two different pictures. AMBER, not red: nothing is being lost, the record is simply wrong.
    if (r.ended_at_lies) {
      const n = r.ended_at_lies_sessions?.length ?? 0;
      out.push({
        roomId: r.room.id,
        room: name,
        severity: "amber",
        rank: 1,
        title: "a recording's stored end time is later than its last piece",
        detail: `${n === 1 ? "one recording says" : `${n} recordings say`} they ran on after the last audio arrived. The audio is safe and complete — it is the end time on the record that is wrong.`,
      });
    }
    if (!r.stalled && (r.mic_level === "red" || r.mic_level === "amber")) {
      out.push({
        roomId: r.room.id,
        room: name,
        severity: r.mic_level,
        rank: 0,
        title: r.mic_level === "red" ? "no audio uploading" : "audio slowing down",
        detail: `last piece ${fmtAge(ageMs(r.last_piece_at, nowMs))} ago`,
      });
    }
    // §3.1 — GUARDED ON A GENUINE CUE EXISTING. The level is already `unknown` without one, so
    // this is belt to that braces: nothing in production writes a warehouse clock event, and
    // until this build the missing cue was silently replaced by the session's own start time,
    // which turned every room red thirty minutes in.
    if (r.has_doctor_clock && (r.doctor_clock_level === "red" || r.doctor_clock_level === "amber")) {
      out.push({
        roomId: r.room.id,
        room: name,
        severity: r.doctor_clock_level,
        rank: 2,
        title: `no clock from this doctor for ${fmtAge(r.doctor_clock_silent_ms)}`,
        // NEVER "warehouse silent". This vital cannot see the room.
        detail: "another doctor may be in this room and seeing patients — the warehouse holds no room, so this cannot tell you the room is empty",
      });
    }
    // RECORDED AND UNABLE TO BE TRANSCRIBED. Ranked ABOVE "behind" because behind clears itself
    // and this does not: without a room_day the drain refuses before it claims, so the window
    // never becomes `failed` and never leaves `closed`. One press fixes it, so the row says which.
    if (r.transcript_enabled && r.transcript_counts.no_day > 0 && r.has_room_day_today === false) {
      const n = r.transcript_counts.no_day;
      out.push({
        roomId: r.room.id,
        room: name,
        severity: "amber",
        rank: 2,
        title: NO_DAY_TITLE,
        detail: `${n} piece${n === 1 ? "" : "s"} of audio recorded and safe, but this room has no day record for today, so none of it can be turned into words yet. ${NO_DAY_FIX}`,
      });
    }
    // NOBODY HAS RUN IT. Not "behind", and there is nothing to tell to stop (§3.4).
    //
    // This row used to read "transcript behind — the audio is safe … Turn Transcript off if you
    // want it to stop trying". Nothing was trying. There is no scheduled pass anywhere in this
    // system; a person runs each one by hand. Offering to stop something that is not running
    // teaches an operator that the words on this screen are decorative — and on 24 August that
    // was the row sitting on top of the one true alarm on the page.
    if (r.transcript_enabled && (r.transcript_counts.waiting > 0 || r.transcript_counts.failed > 0)) {
      const bits: string[] = [];
      if (r.transcript_counts.waiting > 0) bits.push(`${r.transcript_counts.waiting} piece${r.transcript_counts.waiting === 1 ? "" : "s"} of audio ${WAITING_PHRASE}`);
      if (r.transcript_counts.failed > 0) bits.push(`${r.transcript_counts.failed} gave up`);
      out.push({
        roomId: r.room.id,
        room: name,
        severity: "amber",
        rank: 3,
        title: `transcript ${WAITING_PHRASE} — the audio is safe`,
        detail: `${bits.join(", ")}. Nothing is lost: the audio is saved and stays until somebody runs it. No pass is scheduled — each one is started by hand.`,
      });
    }
    // D32 — A ROOM WITH ONE MICROPHONE SAYS NOTHING ABOUT A SPARE. The amber "backup mic reads
    // no chunks" row fired on every single-mic room, which is most of them, for the whole of
    // every session. Most rooms have one microphone and that is normal. Removed, not softened:
    // the field is still computed and still on the wire for Build 2, and nothing renders it.
    if (r.marks_not_sent > 0) {
      out.push({ roomId: r.room.id, room: name, severity: "amber", rank: 2, title: `${r.marks_not_sent} mark${r.marks_not_sent === 1 ? "" : "s"} did not reach the brain`, detail: "the kiosk recorded the press but the cue never landed" });
    }
    if (r.last_window_complete === false) {
      out.push({ roomId: r.room.id, room: name, severity: "amber", rank: 2, title: "a transcription request did not finish", detail: `asked ${fmtAge(ageMs(r.last_window_asked_at, nowMs))} ago and rolled back — re-run it` });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export function BenchRoomsLive() {
  const {
    listeners,
    rollup,
    busCommands,
    error,
    busy,
    lastFetchAt,
    fetchListeners,
    fetchRollup,
  } = useBenchLivePolling();
  /** Stop is two clicks: the first arms this, the second sends. */
  const [confirmStop, setConfirmStop] = React.useState<string | null>(null);
  /**
   * Switch state that is NOT the server's answer yet.
   *
   * `pending` is the optimistic position (PRD §6) — the switch may show its new place at once.
   * `switchError` is what happens when the write fails: the switch goes BACK to its true position
   * and says so. A switch that lies about the state of a clinical system is worse than a slow
   * one, so the correction is not optional and it is not silent.
   */
  const [pending, setPending] = React.useState<Record<string, boolean>>({});
  const [switchError, setSwitchError] = React.useState<{ key: string; message: string } | null>(null);
  /** Turning Visits ON is the only thing on this screen that asks twice (R7). */
  const [confirmVisits, setConfirmVisits] = React.useState<{ roomId: string; roomName: string } | null>(null);
  const [confirmStopAll, setConfirmStopAll] = React.useState(false);
  const [stopAllNote, setStopAllNote] = React.useState<string | null>(null);
  /**
   * K5 A2 — the orphan repair's own arm, deliberately NOT shared with confirmStop. They look
   * similar and mean opposite things: stop ends a live tape, this closes a dead one. A shared
   * arming flag would let a mis-tap on one become a confirm on the other.
   */
  const [confirmOrphan, setConfirmOrphan] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [commandOutcomes, setCommandOutcomes] = React.useState<Record<string, CommandOutcome>>({});
  const [severityFilter, setSeverityFilter] = React.useState<"all" | "attention">("all");
  // §3.10 (Build 3 §2.1) — RUN THIS ROOM'S WAITING AUDIO. Armed per room, because every window in
  // the batch is a paid call and a one-tap money-spender on a tablet in a pocket is exactly the
  // trap this build's other confirms guard against. `running` disables the button while a batch is
  // in flight; `result` holds the per-window cost report the run came back with.
  const [confirmRun, setConfirmRun] = React.useState<string | null>(null);
  const [runningWaiting, setRunningWaiting] = React.useState<string | null>(null);
  const [runResult, setRunResult] = React.useState<Record<string, { drained: RunOutcome[]; remaining: number }>>({});
  const [invalidRoom, setInvalidRoom] = React.useState<string | null>(null);

  // B4 — an armed Stop disarms itself. Re-armed by a second tap; cleared on unmount.
  React.useEffect(() => {
    if (!confirmStop) return;
    const t = globalThis.setTimeout(() => setConfirmStop(null), CONFIRM_STOP_MS);
    return () => globalThis.clearTimeout(t);
  }, [confirmStop]);

  // …and so does the repair. Same reason, same window.
  React.useEffect(() => {
    if (!confirmOrphan) return;
    const t = globalThis.setTimeout(() => setConfirmOrphan(null), CONFIRM_STOP_MS);
    return () => globalThis.clearTimeout(t);
  }, [confirmOrphan]);

  const nowMs = Date.now();
  const listenerMap = React.useMemo(() => {
    const m = new Map<string, ListenerRowView>();
    for (const l of listeners?.listeners ?? []) m.set(l.room_id, l);
    return m;
  }, [listeners]);
  const listenersKnown = Boolean(listeners) && !(listeners?.degraded?.length);
  const rooms = React.useMemo(() => rollup?.rooms ?? [], [rollup?.rooms]);
  /** §3.5 — THE THRESHOLDS THEMSELVES, so a person can see that amber means seven minutes.
   *  They have been computed and sent on every poll since this screen shipped and rendered
   *  nowhere; a colour whose rule is invisible is a colour an operator has to learn by folklore. */
  const thresholds = rollup?.thresholds ?? null;
  const attention = React.useMemo(() => attentionItems(rooms, listenerMap, listenersKnown, nowMs), [rooms, listenerMap, listenersKnown, nowMs]);
  const attentionRoomIds = React.useMemo(() => new Set(attention.map((item) => item.roomId)), [attention]);
  const visibleRooms = severityFilter === "attention"
    ? rooms.filter((room) => attentionRoomIds.has(room.room.id))
    : rooms;
  const selectedId = useSelectedRoom()?.roomId ?? null;
  const deepLinkApplied = React.useRef(false);
  const selectedRoomData = rooms.find((room) => room.room.id === selectedId) ?? null;
  const selectedListener = selectedRoomData
    ? listenerMap.get(selectedRoomData.room.id)
    : undefined;
  const selectedPresentation = selectedRoomData
    ? roomPresentation(
        selectedRoomData,
        selectedListener,
        listenersKnown,
        nowMs,
      )
    : null;

  React.useEffect(() => {
    if (busCommands.length === 0) return;
    setCommandOutcomes((previous) => {
      const next = { ...previous };
      const seenRooms = new Set<string>();
      for (const command of busCommands) {
        if (seenRooms.has(command.room_id)) continue;
        seenRooms.add(command.room_id);
        const commandAt = Date.parse(command.created_at);
        const current = next[command.room_id];
        if (current && current.at > commandAt) continue;
        const state: CommandOutcome["state"] =
          command.status === "pending"
            ? "queued"
            : command.status === "acked"
              ? "acked"
              : command.status === "expired"
                ? "timeout"
                : "failed";
        next[command.room_id] = {
          commandId: command.id,
          kind: command.kind,
          state,
          detail:
            command.status === "pending"
              ? "Pending on the command bus; waiting for the kiosk to acknowledge it."
              : command.status === "acked"
                ? "Kiosk acknowledged this command."
                : command.status === "expired"
                  ? "No kiosk picked up this command before it expired."
                  : `Kiosk refused this command${command.error ? `: ${command.error}` : "."}`,
          at: Number.isFinite(commandAt) ? commandAt : Date.now(),
        };
      }
      return next;
    });
  }, [busCommands]);

  const chooseRoom = React.useCallback((room: RoomLive["room"]) => {
    selectedRoom.choose(room.id);
    setInvalidRoom(null);
    window.history.replaceState(
      window.history.state,
      "",
      roomSelectionUrl(window.location.href, room),
    );
  }, []);

  React.useEffect(() => {
    if (deepLinkApplied.current || rooms.length === 0) return;
    deepLinkApplied.current = true;
    const result = resolveRoomQuery(rooms, window.location.search);
    if (result.kind === "none") return;
    if (result.kind === "invalid") {
      setInvalidRoom(result.value);
      return;
    }
    selectedRoom.choose(result.room.room.id);
    globalThis.setTimeout(() => {
      document.getElementById(`bench-room-${result.room.room.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }, [rooms]);

  // DEFAULT SELECTION, first rule: the room that is RECORDING. `suggest` never overrides a click,
  // so this cannot fight the operator, and it outranks BenchClient's "most recent session" default
  // because the two components learn their facts from different polls and this one is better.
  React.useEffect(() => {
    const rec = rooms.find((r) => r.recording);
    if (rec) selectedRoom.suggest(rec.room.id);
  }, [rooms]);

  /**
   * Set one lane on one room.
   *
   * OPTIMISTIC, WITH A CORRECTION THAT IS LOUD. The switch moves at once because a clinic
   * operator should see their tap land. If the write fails, the switch goes back to the position
   * the database actually holds — taken from the route's own RETURNING, not from what we asked
   * for — and the failure is stated in words. The dangerous outcome here is not slowness, it is a
   * switch that shows "off" over a room that is still processing.
   */
  const setLane = React.useCallback(async (roomId: string, lane: "transcript" | "visits", enabled: boolean) => {
    const key = `${roomId}:${lane}`;
    setSwitchError(null);
    setPending((p) => ({ ...p, [key]: enabled }));
    try {
      const res = await fetch("/api/admin/bench/processing", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ room_id: roomId, lane, enabled }),
      });
      const j = (await res.json()) as { transcript_enabled?: boolean; visits_enabled?: boolean; error?: { message?: string; code?: string } };
      if (!res.ok) throw new Error(j?.error?.message || j?.error?.code || `failed_${res.status}`);
      // Believe the row, not the request.
      const truth = lane === "transcript" ? Boolean(j.transcript_enabled) : Boolean(j.visits_enabled);
      setPending((p) => ({ ...p, [key]: truth }));
      void fetchRollup();
    } catch (e) {
      // Back to the true position, and say so.
      setPending((p) => { const n = { ...p }; delete n[key]; return n; });
      setSwitchError({
        key,
        message: `${lane === "transcript" ? "Transcript" : "Visits"} could not be changed — it is still ${enabled ? "off" : "on"}. ${String((e as Error)?.message ?? e).slice(0, 90)}`,
      });
      void fetchRollup();
    }
  }, [fetchRollup]);

  const stopAllProcessing = React.useCallback(async () => {
    setStopAllNote(null);
    setSwitchError(null);
    try {
      const res = await fetch("/api/admin/bench/processing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ action: "stop_all" }),
      });
      const j = (await res.json()) as { stopped?: number; error?: { message?: string } };
      if (!res.ok) throw new Error(j?.error?.message || `failed_${res.status}`);
      setPending({});
      setStopAllNote(`Processing stopped in ${j.stopped ?? 0} room${j.stopped === 1 ? "" : "s"}. Every recording is still running.`);
      void fetchRollup();
    } catch (e) {
      setStopAllNote(`Could not stop processing — nothing changed. ${String((e as Error)?.message ?? e).slice(0, 90)}`);
      void fetchRollup();
    } finally {
      setConfirmStopAll(false);
    }
  }, [fetchRollup]);

  const watchCommand = React.useCallback(async (roomId: string, commandId: string, kind: string) => {
    const started = Date.now();
    for (;;) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 600));
      try {
        const res = await fetch(`/api/admin/bench/command?id=${encodeURIComponent(commandId)}`, { cache: "no-store" });
        const j = (await res.json()) as {
          command?: { status?: "pending" | "acked" | "failed" | "expired"; error?: string | null };
        };
        const status = j.command?.status;
        if (res.ok && status && status !== "pending") {
          setCommandOutcomes((prev) => {
            if (prev[roomId]?.commandId !== commandId) return prev;
            return {
              ...prev,
              [roomId]: {
                commandId,
                kind,
                state: status === "acked" ? "acked" : status === "expired" ? "timeout" : "failed",
                detail: status === "acked"
                  ? "Kiosk acknowledged this command."
                  : status === "expired"
                    ? "No kiosk picked up this command before it expired."
                    : `Kiosk refused this command${j.command?.error ? `: ${j.command.error}` : "."}`,
                at: Date.now(),
              },
            };
          });
          void fetchListeners();
          void fetchRollup();
          return;
        }
      } catch {
        // Keep polling until the honest timeout below; one failed status read is not an outcome.
      }
      if (Date.now() - started >= 10_000) {
        setCommandOutcomes((prev) => {
          if (prev[roomId]?.commandId !== commandId) return prev;
          return {
            ...prev,
            [roomId]: {
              commandId,
              kind,
              state: "timeout",
              detail: "No acknowledgment arrived within 10 seconds. Check the kiosk before assuming it changed.",
              at: Date.now(),
            },
          };
        });
        return;
      }
    }
  }, [fetchListeners, fetchRollup]);

  /**
   * K5 A2 — the repair. Its own sender, not `send`, because the answer shape is different: it
   * returns the closed session and the chunk counts either side, and those are what the
   * operator needs to see. A refusal is reported by NAME, never as a generic failure.
   */
  const closeOrphan = React.useCallback(async (roomId: string) => {
    setNote(null);
    setCommandOutcomes((prev) => ({
      ...prev,
      [roomId]: { kind: "close_orphan", state: "queued", detail: "Closing the abandoned session on the server…", at: Date.now() },
    }));
    try {
      const res = await fetch("/api/admin/bench/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ room_id: roomId, kind: "close_orphan" }),
      });
      const j = (await res.json()) as Record<string, unknown>;
      if (!res.ok || j.ok !== true) {
        setNote(`close abandoned session: ${String(j.error ?? `http_${res.status}`)}${j.hint ? ` — ${String(j.hint)}` : ""}`);
        setCommandOutcomes((prev) => ({
          ...prev,
          [roomId]: { kind: "close_orphan", state: "conflict", detail: String(j.hint ?? j.error ?? `http_${res.status}`), at: Date.now() },
        }));
      } else {
        const kept = j.chunks_before === j.chunks_after;
        setNote(
          `closed ${String(j.session_id)} — ${String(j.chunks_before)} chunk${j.chunks_before === 1 ? "" : "s"} ${kept ? "kept, untouched" : "CHANGED — investigate"}. The room can record again.`,
        );
        setCommandOutcomes((prev) => ({
          ...prev,
          [roomId]: { kind: "close_orphan", state: "acked", detail: "Abandoned session closed; stored audio was kept.", at: Date.now() },
        }));
      }
    } catch (e) {
      setNote(`close abandoned session: ${e instanceof Error ? e.message : String(e)}`);
      setCommandOutcomes((prev) => ({
        ...prev,
        [roomId]: { kind: "close_orphan", state: "failed", detail: e instanceof Error ? e.message : String(e), at: Date.now() },
      }));
    } finally {
      setConfirmOrphan(null);
      void fetchListeners();
      void fetchRollup();
    }
  }, [fetchListeners, fetchRollup]);

  const send = React.useCallback(async (roomId: string, kind: string, overridePause = false) => {
    setNote(null);
    const requestId = `sending_${Date.now()}`;
    setCommandOutcomes((prev) => ({
      ...prev,
      [roomId]: {
        commandId: requestId,
        kind,
        state: "queued",
        detail: "Sending to the server; no previous command outcome applies.",
        at: Date.now(),
      },
    }));
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
        setCommandOutcomes((prev) => ({
          ...prev,
          [roomId]: {
            commandId: requestId,
            kind,
            state: "conflict",
            detail: String(j.hint ?? j.error ?? `http_${res.status}`),
            at: Date.now(),
          },
        }));
      } else if (j.already_recording) {
        setNote(`${kind}: already recording (${String(j.session_id)})`);
        setCommandOutcomes((prev) => ({
          ...prev,
          [roomId]: { commandId: requestId, kind, state: "acked", detail: "Already recording; no duplicate tape was started.", at: Date.now() },
        }));
      } else {
        setNote(`${kind}: queued for the kiosk`);
        setCommandOutcomes((prev) => ({
          ...prev,
          [roomId]: {
            commandId: typeof j.command_id === "string" ? j.command_id : requestId,
            kind,
            state: "queued",
            detail: "Queued for the kiosk; waiting for acknowledgment.",
            at: Date.now(),
          },
        }));
        if (typeof j.command_id === "string") void watchCommand(roomId, j.command_id, kind);
      }
    } catch (e) {
      setNote(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
      setCommandOutcomes((prev) => ({
        ...prev,
        [roomId]: { commandId: requestId, kind, state: "failed", detail: e instanceof Error ? e.message : String(e), at: Date.now() },
      }));
    } finally {
      setConfirmStop(null);
      void fetchListeners();
      void fetchRollup();
    }
  }, [fetchListeners, fetchRollup, watchCommand]);

  /**
   * §3.10 (Build 3 §2.1) — run one bounded batch of a room's waiting audio. EVERY WINDOW IS A PAID
   * CALL, so the batch is small and the answer says what each window cost. Not `send`: this reaches
   * the drain route, not the command bus, and its answer is a per-window cost report the operator
   * reads before running any more.
   */
  const runWaiting = React.useCallback(async (roomId: string) => {
    setNote(null);
    setConfirmRun(null);
    setRunningWaiting(roomId);
    try {
      const res = await fetch("/api/admin/bench/run-waiting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ room_id: roomId, limit: 4 }),
      });
      const j = (await res.json()) as { data?: { drained?: RunOutcome[]; remaining?: number }; drained?: RunOutcome[]; remaining?: number; error?: { message?: string; code?: string } };
      if (!res.ok) throw new Error(j?.error?.message || j?.error?.code || `failed_${res.status}`);
      const d = j.data ?? j;
      setRunResult((p) => ({ ...p, [roomId]: { drained: d.drained ?? [], remaining: Number(d.remaining) || 0 } }));
      void fetchRollup();
    } catch (e) {
      setRunResult((p) => ({ ...p, [roomId]: { drained: [], remaining: -1 } }));
      setNote(`run waiting audio: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunningWaiting(null);
    }
  }, [fetchRollup]);

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
          <a
            href={`/admin/bench/archive${selectedId ? `?room=${encodeURIComponent(rooms.find((room) => room.room.id === selectedId)?.room.slug ?? selectedId)}` : ""}`}
            className="min-h-11 inline-flex items-center px-3 rounded-lg font-semibold text-even-blue-700 hover:bg-even-ink-50"
          >
            Archive &amp; room setup
          </a>
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

      <BenchAttentionList
        items={attention}
        hasRooms={rooms.length > 0}
        onSelect={(roomId) => {
          const room = rooms.find((candidate) => candidate.room.id === roomId);
          if (room) chooseRoom(room.room);
        }}
      />

      <BenchRoomFocus
        room={selectedRoomData}
        listener={selectedListener}
        presentation={selectedPresentation}
        outcome={selectedRoomData ? commandOutcomes[selectedRoomData.room.id] : undefined}
        confirmingStop={Boolean(selectedRoomData && confirmStop === selectedRoomData.room.id)}
        invalidRoom={invalidRoom}
        nowMs={nowMs}
        thresholds={thresholds}
        confirmWindowSeconds={CONFIRM_STOP_MS / 1000}
        onArmStop={() => {
          if (selectedRoomData) setConfirmStop(selectedRoomData.room.id);
        }}
        onSend={(kind) => {
          if (selectedRoomData) void send(selectedRoomData.room.id, kind);
        }}
      />

      <div className="flex flex-wrap items-center gap-2" aria-label="Fleet filters">
        <span className="text-caption font-semibold text-even-ink-500">Show</span>
        {(["all", "attention"] as const).map((filter) => (
          <button
            key={filter}
            type="button"
            aria-pressed={severityFilter === filter}
            onClick={() => setSeverityFilter(filter)}
            className={`min-h-11 px-4 rounded-lg text-label font-semibold ${
              severityFilter === filter
                ? "bg-even-navy-800 text-even-white"
                : "bg-even-ink-100 text-even-ink-600 hover:bg-even-ink-200"
            }`}
          >
            {filter === "all" ? `All rooms (${rooms.length})` : `Needs attention (${attentionRoomIds.size})`}
          </button>
        ))}
      </div>

      {/* CARDS, not rows (E1). A table is for comparing rooms; the operator is not comparing,
          they are scanning for trouble — so the worst condition promotes the whole card and finds
          the eye without being read. Selecting a card reveals that room's recordings below. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visibleRooms.map((r) => {
          const l = listenerMap.get(r.room.id);
          const presentation = roomPresentation(r, l, listenersKnown, nowMs);
          const st = presentation.state;
          const operational = presentation.operational;
          const orphaned = presentation.orphaned;
          const canReachKiosk = presentation.canReachKiosk;
          const isSelected = selectedId === r.room.id;
          return (
            // B3 — this WAS a <button> with five more <button>s inside it, which is invalid
            // HTML: browsers reparent nested interactive content, so the controls were living
            // outside the card in the real DOM and only a stopPropagation on a wrapping div was
            // holding the behaviour together. It is a div now, with an explicit role, a tab
            // stop and Enter/Space, so selection is still fully keyboard-reachable.
            <RoomCard
              key={r.room.id}
              id={r.room.id}
              name={r.room.name}
              level={presentation.worst}
              selected={isSelected}
              onSelect={() => chooseRoom(r.room)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-even-navy-800 truncate">{r.room.name}</p>
                  <p className="text-caption text-even-ink-400 truncate">{r.room.slug}</p>
                </div>
                {st.state === "finished" ? (
                  <span className={`${PILL} ${FINISHED_PILL}`} title={st.hint ?? undefined}>{STATE_WORD.finished}</span>
                ) : (
                  <Pill level={st.level} title={st.hint ?? undefined}>{STATE_WORD[st.state]}</Pill>
                )}
              </div>

              <p className="mt-2 text-body text-even-navy-800">{st.label}</p>
              {st.hint ? <p className="text-caption text-even-ink-500">{st.hint}</p> : null}
              <BenchRoomStatusChips
                roomName={r.room.name}
                operational={operational}
                syncUnknown={presentation.hostCloudDesync === null}
                listener={l}
              />

              {/* THE THREE LANES (PRD R4/R5/R6). Tape has no switch — recording is started and
                  stopped by the buttons below, as it always was. Only the two processing lanes
                  are switchable, because only those can be turned off without losing anything. */}
              <div className="mt-3 border-t border-even-ink-100 pt-2" onClick={(e) => e.stopPropagation()}>
                <Lane name="Tape" view={r.lanes.tape} />
                <Lane
                  name="Transcript"
                  view={laneWithPending(r.lanes.transcript, pending[`${r.room.id}:transcript`])}
                  sw={
                    <LaneSwitch
                      on={pending[`${r.room.id}:transcript`] ?? r.transcript_enabled}
                      busy={false}
                      label={`Transcript for ${r.room.name}`}
                      onToggle={() => void setLane(r.room.id, "transcript", !(pending[`${r.room.id}:transcript`] ?? r.transcript_enabled))}
                    />
                  }
                />
                <Lane
                  name="Visits"
                  view={laneWithPending(r.lanes.visits, pending[`${r.room.id}:visits`])}
                  sw={
                    <LaneSwitch
                      on={pending[`${r.room.id}:visits`] ?? r.visits_enabled}
                      busy={false}
                      label={`Visits for ${r.room.name}`}
                      onToggle={() => {
                        const now = pending[`${r.room.id}:visits`] ?? r.visits_enabled;
                        // R7 — friction on the dangerous direction ONLY. Turning it OFF is
                        // immediate; stopping must never take two taps in a clinic.
                        if (now) void setLane(r.room.id, "visits", false);
                        else setConfirmVisits({ roomId: r.room.id, roomName: r.room.name });
                      }}
                    />
                  }
                />
                {switchError && switchError.key.startsWith(`${r.room.id}:`) ? (
                  <p className="mt-1 text-caption font-semibold text-danger-700 leading-snug">{switchError.message}</p>
                ) : null}
              </div>

              {/* §3.10 (Build 3 §2.1) — RUN THIS ROOM'S WAITING AUDIO. On 24 August Cardiology's
                  finished audio had no job row and no control anywhere would run it; the card said
                  "17 waiting" over a queue that did not exist. This is the control that runs it.
                  Shown only when Transcript is on and something is actually waiting with no worker.
                  EVERY ONE IS A PAID CALL, so it arms with a first tap and spends on the second,
                  runs a bounded batch, and reports engine, characters, seconds and cost per piece.
                  The interface never says "window" — the operator vocabulary is pieces of audio. */}
              {(() => {
                const waitingReason = r.stranded?.reasons.find((x) => x.reason === STRANDED_WAITING);
                const waiting = waitingReason?.slots ?? 0;
                if (!r.transcript_enabled || waiting < 1) return null;
                const run = runResult[r.room.id];
                const isRunning = runningWaiting === r.room.id;
                const armed = confirmRun === r.room.id;
                return (
                  <div className="mt-3 rounded-lg border border-even-navy-200 bg-even-navy-50 p-3" onClick={(e) => e.stopPropagation()}>
                    <p className="text-caption text-even-navy-800 leading-snug">
                      <span className="font-semibold">
                        Waiting: {waiting} piece{waiting === 1 ? "" : "s"} · {fmtMinutes(waitingReason?.ms ?? 0)} of 15-minute slot time.
                      </span>{" "}
                      Nothing runs on its own. Running starts up to 4 paid transcription calls. Each one is a paid call; the exact cost is reported after each call.
                    </p>
                    {armed ? (
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => void runWaiting(r.room.id)}
                        className="mt-2 min-h-11 min-w-11 px-4 py-2 rounded-lg text-label font-semibold bg-even-navy-800 text-even-white ring-2 ring-even-navy-900 ring-offset-1 hover:bg-even-navy-900 disabled:opacity-50"
                      >
                        {isRunning ? "running…" : `confirm — run ${Math.min(4, waiting)} now (paid)`}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => setConfirmRun(r.room.id)}
                        className="mt-2 min-h-11 min-w-11 px-4 py-2 rounded-lg text-label font-semibold bg-even-navy-800 text-even-white hover:bg-even-navy-900 disabled:opacity-50"
                      >
                        Run this room’s waiting audio
                      </button>
                    )}
                    {armed ? (
                      <p className="mt-1 text-caption text-even-ink-500 leading-snug">
                        Paid batch: {Math.min(4, waiting)} piece{Math.min(4, waiting) === 1 ? "" : "s"} maximum. Exact cost appears per piece before you run another batch.
                      </p>
                    ) : null}
                    {run ? (
                      <div className="mt-2 border-t border-even-navy-100 pt-2" data-testid="run-waiting-report">
                        {run.drained.length === 0 ? (
                          <p className="text-caption text-even-ink-500 leading-snug">
                            Nothing ran{run.remaining < 0 ? " — the run failed; see the note above." : "."}
                          </p>
                        ) : (
                          <ul className="space-y-0.5">
                            {run.drained.map((w) => (
                              <li key={w.window_id} className="text-caption text-even-navy-800 leading-snug">
                                {w.ok ? (
                                  <>
                                    ✓ {w.engine ?? "engine"} · {w.transcript_chars ?? 0} chars ·{" "}
                                    {w.sarvam_ms != null ? `${(w.sarvam_ms / 1000).toFixed(1)} s` : "—"} ·{" "}
                                    {w.cost_usd != null ? `$${w.cost_usd.toFixed(4)}` : "no cost reported"}
                                  </>
                                ) : (
                                  <span className="text-warning-700">✗ did not run — {w.step}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        {run.remaining > 0 ? (
                          <p className="mt-1 text-caption text-even-ink-500 leading-snug">
                            {run.remaining} still waiting — press again to run the next {Math.min(4, run.remaining)}.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })()}

              {/* ── STRANDED AUDIO (D7) ────────────────────────────────────────────────────
                  MINUTES, NOT PIECES. The card counted pieces and never said how much TIME
                  could not be turned into words. On 24 August that figure was over eight hours
                  across the estate and it was nowhere on this screen — while the one count that
                  WAS shown, "17 waiting", described a queue that did not exist: all seventeen
                  were finished slots with no job row at all, so nothing had ever been enqueued.

                  NOT RED. Every minute counted here is audio that is safely stored; what is
                  missing is the words, and the instinct on seeing red is to stop the recording,
                  which would be exactly wrong. */}
              {r.stranded && r.stranded.total_ms > 0 ? (
                <div className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3" data-testid="stranded-audio" onClick={(e) => e.stopPropagation()}>
                  <p className="text-caption text-even-navy-800 leading-snug">
                    <span className="font-semibold">{fmtMinutes(r.stranded.total_ms)}</span> of audio cannot
                    currently be turned into words. It is recorded and safe.
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {r.stranded.reasons.map((x) => (
                      <li key={x.reason} className="text-caption text-even-ink-600 leading-snug">
                        {fmtMinutes(x.ms)} — {x.reason}
                      </li>
                    ))}
                  </ul>
                  {/* THE TWO NUMBERS ARE MEASURED DIFFERENTLY AND THEY DO NOT SUBTRACT. Said
                      out loud rather than left to be discovered by someone doing the arithmetic
                      on a clinic floor. */}
                  <p className="mt-1 text-caption text-even-ink-400 leading-snug">{STRANDED_MEASURE_NOTE}</p>
                </div>
              ) : null}

              <BenchRoomVitals
                room={r}
                listener={l}
                state={st}
                operational={operational}
                syncUnknown={presentation.hostCloudDesync === null}
                nowMs={nowMs}
                thresholds={thresholds}
                showStatus={false}
              />

              <BenchCommandTransport
                room={r}
                listener={l}
                state={st}
                canReachKiosk={canReachKiosk}
                outcome={commandOutcomes[r.room.id]}
                confirmingStop={confirmStop === r.room.id}
                confirmWindowSeconds={CONFIRM_STOP_MS / 1000}
                onArmStop={() => setConfirmStop(r.room.id)}
                onSend={(kind) => void send(r.room.id, kind)}
              />

              {/* ENDED DISAGREES — on the card as well as in the attention list, because the card
                  is what somebody is looking at when they click a room. No control: there is
                  nothing safe for the monitor to DO here. The session is already ended, the audio
                  is already stored, and the kiosk has already been told to stop on its next chunk.
                  What is needed is a person in the room pressing start, which is what it says. */}
              {r.ended_disagrees ? (
                <div className="mt-3 rounded-lg border border-danger-200 bg-danger-100 p-3" data-testid="ended-disagrees">
                  <p className="text-caption text-danger-700 leading-snug">
                    <span className="font-semibold">{ENDED_DISAGREES_TITLE}.</span>{" "}
                    {r.ended_disagrees_chunks} piece{r.ended_disagrees_chunks === 1 ? "" : "s"} stored since it was
                    marked ended {fmtAge(ageMs(r.ended_disagrees_ended_at, nowMs))} ago
                    {r.ended_disagrees_last_piece_at ? `, newest ${fmtAge(ageMs(r.ended_disagrees_last_piece_at, nowMs))} ago` : ""}.
                  </p>
                  <p className="text-caption text-even-ink-500 leading-snug mt-1">{ENDED_DISAGREES_HINT}.</p>
                </div>
              ) : null}

              {/* §3.5 — WHAT THIS CARD COULD NOT READ. Assembled per room on every poll since
                  this screen shipped and never rendered anywhere, so a card quietly missing a
                  whole section looked identical to a card with nothing to report. Grey, because
                  it is not a fault in the room — it is a gap in what we can currently see of it. */}
              {r.degraded?.length ? (
                <p className="mt-2 text-caption text-even-ink-500 leading-snug">
                  Some of this room’s picture could not be read: {r.degraded.join(" · ")}
                </p>
              ) : null}

              {/* K5 A2 — THE REPAIR. Shown ONLY on a room whose session is open while no kiosk
                  claims it: the room is deadlocked, because end_day has no kiosk to act on and
                  start_day is refused by the open session. On a healthy room this control is
                  not rendered at all, and the server refuses it as well (A4) — the UI decides
                  what to OFFER, the server decides what is allowed. */}
              {orphaned ? (
                <div className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3" onClick={(e) => e.stopPropagation()}>
                  <p className="text-caption text-even-navy-800 leading-snug">
                    <span className="font-semibold">This room is stuck.</span> Its session is still open but no
                    kiosk page is recording it, so stop has nothing to act on and start is refused. Closing the
                    abandoned session lets the room record again.
                  </p>
                  <p className="text-caption text-even-ink-500 leading-snug mt-1">
                    Every chunk already uploaded is kept — this only ends the session row.
                    {l ? ` The room page last polled ${fmtAge(l.age_ms)} ago.` : " No kiosk page has ever polled this room."}
                  </p>
                  {confirmOrphan === r.room.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void closeOrphan(r.room.id)}
                        className="mt-2 min-h-11 min-w-11 px-4 py-2 rounded-lg text-label font-semibold bg-warning-500 text-even-navy-800 ring-2 ring-warning-700 ring-offset-1 hover:bg-warning-700 hover:text-even-white"
                      >
                        confirm — close abandoned session
                      </button>
                      <p className="mt-1 text-caption text-warning-700">
                        Disarms itself in {CONFIRM_STOP_MS / 1000} seconds.
                      </p>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmOrphan(r.room.id)}
                      className="mt-2 min-h-11 min-w-11 px-4 py-2 rounded-lg text-label bg-even-white border border-warning-200 hover:bg-warning-100"
                    >
                      Close abandoned session
                    </button>
                  )}
                </div>
              ) : null}
            </RoomCard>
          );
        })}
        {rooms.length === 0 ? (
          <p className="text-caption text-even-ink-400">{rollup ? "no enabled rooms" : "loading…"}</p>
        ) : visibleRooms.length === 0 ? (
          <p className="text-caption text-even-ink-400">No rooms match this filter.</p>
        ) : null}
      </div>

      {rollup?.day ? <BenchDaySummary day={rollup.day} /> : null}

      {/* Global writes are deliberately separated from the live scan. The destructive colour
          appears only after the operator opens this processing danger zone. */}
      <BenchDangerZone
        confirming={confirmStopAll}
        note={stopAllNote}
        onArm={() => setConfirmStopAll(true)}
        onCancel={() => setConfirmStopAll(false)}
        onConfirm={() => void stopAllProcessing()}
      />

      {/* ── TURNING VISITS ON (PRD §6, mockup tab C) ────────────────────────────────────────
          The one dialog on this screen. Turning Transcript on only costs money and load, both
          recoverable. Turning Visits on starts writing to a room's PERMANENT RECORD of who was
          seen, and the copy says that in plain terms rather than "enables the live fuse".
          Turning it OFF has no dialog at all. */}
      {confirmVisits ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-even-navy-800/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-even-white p-5 shadow-xl">
            <h4 className="text-body font-bold text-even-navy-800 mb-2">Turn Visits on for {confirmVisits.roomName}?</h4>
            <p className="text-caption text-even-ink-600 leading-snug mb-2">
              From now on, this room will build its own record of who was seen and when, and that record is kept.
              Transcript and Tape are not affected.
            </p>
            <p className="text-caption text-even-ink-500 leading-snug mb-4">
              You can turn it off again at any time and it takes effect within seconds. Anything already written stays.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmVisits(null)}
                className="flex-1 min-h-11 px-4 py-2 rounded-lg text-label bg-even-white border border-even-ink-200 hover:bg-even-ink-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { const c = confirmVisits; setConfirmVisits(null); if (c) void setLane(c.roomId, "visits", true); }}
                className="flex-1 min-h-11 px-4 py-2 rounded-lg text-label font-semibold bg-even-blue-600 text-even-white hover:bg-even-blue-700"
              >
                Turn it on
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* §3.1 — THE FOOTNOTE FOLLOWS THE VITAL. It explains a row that, with no warehouse-typed
          cue anywhere today, no card is rendering — and a paragraph about a number nobody can
          see is the kind of leftover that teaches an operator to skim this screen. It returns
          with the row. The wording is unchanged and still normative: never "warehouse silent". */}
      {rooms.some((r) => r.has_doctor_clock) ? (
        <p className="text-caption text-even-ink-400">
          “This doctor” counts Pulse clocks from the labelled doctor only. The warehouse holds no room, so a gap there
          never means the room is empty — another doctor may be in it and seeing patients.
        </p>
      ) : null}
    </section>
  );
}
