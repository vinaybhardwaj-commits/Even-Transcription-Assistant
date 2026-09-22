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
  roomState,
  ENDED_DISAGREES_TITLE,
  ENDED_DISAGREES_HINT,
  NO_DAY_TITLE,
  NO_DAY_FIX,
  type RoomState,
  type RoomStateView,
} from "@/lib/bench-bus-constants";
// The lane words, the stranded-audio reasons and the measurement warning come from the same
// pure module the server renders them with and the MCP door reports them from (§3.6). Safe in a
// browser bundle: lib/room-facts.ts imports lib/bench-bus-constants and nothing else.
import {
  STRANDED_MEASURE_NOTE,
  STRANDED_WAITING,
  WAITING_PHRASE,
  roomOperationalAlerts,
} from "@/lib/room-facts";
import { BenchAttentionList } from "@/components/admin/bench-live/BenchAttentionList";
import { BenchDangerZone } from "@/components/admin/bench-live/BenchDangerZone";
import { BenchDaySummary } from "@/components/admin/bench-live/BenchDaySummary";
import { RoomCard } from "@/components/admin/bench-live/RoomCard";
import { useBenchLivePolling } from "@/components/admin/bench-live/useBenchLivePolling";
import type {
  Attention,
  LaneView,
  Level,
  Levels,
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

/**
 * A4 — WHY START IS OFF, as a sentence the operator can read without a mouse.
 *
 * iOS Safari never renders a `title`, and this was the only place the rule was written down, so
 * on a tablet a disabled Start button simply looked broken. Each branch names the CAUSE and the
 * FIX, because "not ready" alone sends someone to the wrong room.
 *
 * Returns null when start IS available — the caller renders nothing at all then.
 */
export function startBlockedReason(st: RoomStateView): string | null {
  // D30 SPLIT THIS QUESTION IN TWO. `finished` outranks `ready`, so "is the state ready" is no
  // longer the same question as "would a start work". The view answers the second one directly;
  // asking it here is what keeps the seventh state's own hint — press start to record again —
  // from being contradicted by a greyed-out button two lines below it.
  if (st.start_available) return null;
  switch (st.state) {
    case "ready":
      return null;
    case "finished":
      // The day is over AND no kiosk page is listening. The state stays `finished`, because why
      // the page is quiet stopped being the operator's question when the day was ended on
      // purpose — but the button cannot pretend, so this says what to do before pressing it.
      return "This day is finished. To record again, open the room page on the clinic Mac — no kiosk page is listening in this room right now.";
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

/**
 * §2.2 — THE LEVEL BAR. One per microphone THAT ACTUALLY EXISTS on that rig (D32).
 *
 * TWO MARKS, NOT ONE, because they answer different questions. The filled bar is the AVERAGE
 * since the last report — how much of the interval had sound in it — and the tick is the PEAK,
 * which says somebody spoke at all. A single instantaneous reading would be neither: an analyser
 * sample is about eleven milliseconds of audio, shorter than the pause between two words, so a
 * snapshot reads zero on a room in full conversation.
 *
 * RMS IS LOGARITHMIC TO THE EAR AND LINEAR IN THE DATA. Speech sits between roughly 0.02 and 0.2,
 * so a linear bar would leave every real room in the leftmost tenth and look broken. The square
 * root spreads that range across most of the bar, which is what makes it readable at a glance
 * while walking — the only way this is ever looked at.
 *
 * NULL DRAWS NOTHING AT ALL. Not an empty bar, not a grey placeholder: an unmeasured microphone
 * is not a silent one, and a room with one microphone must say nothing whatsoever about a spare.
 */
function LevelBar({ label, levels }: { label: string; levels: Levels }) {
  if (!levels) return null;
  const scale = (v: number) => Math.max(0, Math.min(1, Math.sqrt(Math.max(0, Math.min(1, v)) / 0.3)));
  const avg = scale(levels.avg);
  const peak = scale(levels.peak);
  // Grey until something is actually heard, then green: GREEN MEANS WORKING on this screen, and
  // a microphone in a silent room is not working, it is waiting.
  const heard = levels.peak > 0.0015;
  return (
    <div className="flex items-center gap-2">
      <span className="text-caption text-even-ink-500 w-[70px] shrink-0">{label}</span>
      <span
        className="relative flex-1 h-2 rounded-full bg-even-ink-100 overflow-hidden"
        role="meter"
        aria-label={`${label} level`}
        aria-valuenow={Math.round(levels.avg * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ${heard ? "bg-success-500" : "bg-even-ink-200"}`}
          style={{ width: `${Math.round(avg * 100)}%` }}
        />
        {/* the peak, as a tick rather than a second fill: it is a moment, not a duration */}
        <span
          className="absolute inset-y-0 w-0.5 bg-even-navy-800/60"
          style={{ left: `calc(${Math.round(peak * 100)}% - 1px)` }}
        />
      </span>
    </div>
  );
}

/** Minutes, never money (R11). There is deliberately no code path here that could render one. */
function fmtMinutes(ms: number): string {
  const m = Math.round((Number(ms) || 0) / 60_000);
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
}

type CommandOutcome = {
  commandId?: string;
  kind: string;
  state: "queued" | "acked" | "timeout" | "failed" | "conflict";
  detail: string;
  at: number;
};

const COMMAND_LABEL: Record<string, string> = {
  start_day: "Start",
  pause_day: "Pause",
  resume_day: "Resume",
  end_day: "Stop",
  close_orphan: "Close abandoned session",
};

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

    const operational = roomOperationalAlerts({
      recording: r.recording,
      kioskListening: listenersKnown ? Boolean(l?.listening) : null,
      stalled: r.stalled,
      stalledAgeMs: r.stalled_age_ms,
      activeMicAlert: r.active_mic_alert ?? null,
      tapeWithoutCues: r.tape_without_cues ?? null,
      pausedDisagrees: listenersKnown && l ? l.paused !== r.paused_session : null,
    });
    for (const alert of operational) {
      out.push({
        roomId: r.room.id,
        room: name,
        severity: alert.severity,
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
        title: "a recording's stored end time is later than its last piece",
        detail: `${n === 1 ? "one recording says" : `${n} recordings say`} they ran on after the last audio arrived. The audio is safe and complete — it is the end time on the record that is wrong.`,
      });
    }
    if (!r.stalled && (r.mic_level === "red" || r.mic_level === "amber")) {
      out.push({
        roomId: r.room.id,
        room: name,
        severity: r.mic_level,
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
        title: `transcript ${WAITING_PHRASE} — the audio is safe`,
        detail: `${bits.join(", ")}. Nothing is lost: the audio is saved and stays until somebody runs it. No pass is scheduled — each one is started by hand.`,
      });
    }
    // D32 — A ROOM WITH ONE MICROPHONE SAYS NOTHING ABOUT A SPARE. The amber "backup mic reads
    // no chunks" row fired on every single-mic room, which is most of them, for the whole of
    // every session. Most rooms have one microphone and that is normal. Removed, not softened:
    // the field is still computed and still on the wire for Build 2, and nothing renders it.
    if (r.marks_not_sent > 0) {
      out.push({ roomId: r.room.id, room: name, severity: "amber", title: `${r.marks_not_sent} mark${r.marks_not_sent === 1 ? "" : "s"} did not reach the brain`, detail: "the kiosk recorded the press but the cue never landed" });
    }
    if (r.last_window_complete === false) {
      out.push({ roomId: r.room.id, room: name, severity: "amber", title: "a transcription window did not finish", detail: `asked ${fmtAge(ageMs(r.last_window_asked_at, nowMs))} ago and rolled back — re-run it` });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export function BenchRoomsLive() {
  const {
    listeners,
    rollup,
    pendingCommands,
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

  React.useEffect(() => {
    if (pendingCommands.length === 0) return;
    setCommandOutcomes((previous) => {
      const next = { ...previous };
      for (const command of pendingCommands) {
        const commandAt = Date.parse(command.created_at);
        const current = next[command.room_id];
        if (current && current.at > commandAt) continue;
        next[command.room_id] = {
          commandId: command.id,
          kind: command.kind,
          state: "queued",
          detail: "Pending on the command bus; waiting for the kiosk to acknowledge it.",
          at: Number.isFinite(commandAt) ? commandAt : Date.now(),
        };
      }
      return next;
    });
  }, [pendingCommands]);

  const chooseRoom = React.useCallback((room: RoomLive["room"]) => {
    selectedRoom.choose(room.id);
    const url = new URL(window.location.href);
    url.searchParams.set("room", room.slug || room.id);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  React.useEffect(() => {
    if (deepLinkApplied.current || rooms.length === 0) return;
    deepLinkApplied.current = true;
    const wanted = new URL(window.location.href).searchParams.get("room");
    if (!wanted) return;
    const room = rooms.find((r) => r.room.id === wanted || r.room.slug === wanted);
    if (!room) return;
    selectedRoom.choose(room.room.id);
    globalThis.setTimeout(() => {
      document.getElementById(`bench-room-${room.room.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
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

      <BenchAttentionList items={attention} hasRooms={rooms.length > 0} />

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
          const st = roomState({
            listenerReadFailed: !listenersKnown,
            listener: l ? { last_poll_at: l.last_poll_at, paused: l.paused } : null,
            pausedSession: r.paused_session,
            recording: r.recording,
            recordingSince: r.session_started_at,
            nowMs,
            // D30 — a day that was ended on purpose is not a kiosk that vanished by accident.
            lastSessionEnded: Boolean(r.last_session_ended),
            recordedMsToday: r.audio_recorded_ms ?? null,
          });
          const operational = roomOperationalAlerts({
            recording: r.recording,
            kioskListening: listenersKnown ? Boolean(l?.listening) : null,
            stalled: r.stalled,
            stalledAgeMs: r.stalled_age_ms,
            activeMicAlert: r.active_mic_alert ?? null,
            tapeWithoutCues: r.tape_without_cues ?? null,
            pausedDisagrees: listenersKnown && l ? l.paused !== r.paused_session : null,
          });
          // The card's edge carries the WORST condition on it. `backup_reads_no_chunks` is no
          // longer one of them (D32): most rooms have one microphone, so it promoted almost
          // every card to amber for the whole of every session and said nothing true about any
          // of them. The doctor clock can only reach amber or red where a genuine cue exists,
          // which since §3.1 it almost never does.
          const worst: Level = operational.some((a) => a.severity === "red") || r.ended_disagrees || r.stalled || st.level === "red" || r.mic_level === "red" || r.doctor_clock_level === "red" || Boolean(r.recording && r.mic_size?.proven_dead_by_size)
            ? "red"
            : operational.some((a) => a.severity === "amber") || st.level === "amber" || r.mic_level === "amber" || r.doctor_clock_level === "amber" || r.ended_at_lies || r.marks_not_sent > 0
              ? "amber"
              : st.level === "unknown" ? "unknown" : "ok";
          // K5 A2 — the deadlock condition, computed from the two facts the page already has.
          // A kiosk "claims" this session only if it is polling FRESH and naming THIS session;
          // null, a different id, or a stale poll all mean the session has been abandoned.
          const kioskClaimsThis = Boolean(l && l.listening && l.recording_session_id === r.session_id);
          const orphaned = listenersKnown && (r.recording || r.paused_session) && !kioskClaimsThis;
          const canReachKiosk = !listenersKnown || Boolean(l?.listening);
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
              level={worst}
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
              {operational.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`${r.room.name} operational alerts`}>
                  {operational.map((alert) => (
                    <Pill key={alert.code} level={alert.severity} title={alert.detail}>
                      {alert.label}
                    </Pill>
                  ))}
                </div>
              ) : null}
              {commandOutcomes[r.room.id] ? (
                <div
                  className={`mt-3 rounded-lg border px-3 py-2 ${
                    commandOutcomes[r.room.id]!.state === "acked"
                      ? "border-success-200 bg-success-100"
                      : commandOutcomes[r.room.id]!.state === "queued"
                        ? "border-even-blue-100 bg-even-blue-50"
                        : "border-warning-200 bg-warning-50"
                  }`}
                  data-testid="command-outcome"
                  aria-live="polite"
                >
                  <p className="text-caption font-semibold text-even-navy-800">
                    Last command · {COMMAND_LABEL[commandOutcomes[r.room.id]!.kind] ?? commandOutcomes[r.room.id]!.kind} ·{" "}
                    {commandOutcomes[r.room.id]!.state === "acked" ? "acknowledged" : commandOutcomes[r.room.id]!.state}
                  </p>
                  <p className="text-caption text-even-ink-600">{commandOutcomes[r.room.id]!.detail}</p>
                </div>
              ) : null}

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
                      Nothing runs on its own. Running starts up to 4 paid transcription calls; the exact cost is reported after each call.
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

              <dl className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  {/* A4 — "on the UPLOAD clock, 0–5 min is healthy" used to live only in the
                      pill's title, which iOS never renders, so the number had no units. */}
                  <dt className="text-caption text-even-ink-500">
                    Main mic{" "}
                    <span className="text-even-ink-400">
                      · newest piece, 0–5 min is healthy
                      {thresholds ? ` · amber at ${Math.round(thresholds.mic_amber_ms / 60_000)} min, red at ${Math.round(thresholds.mic_red_ms / 60_000)}` : ""}
                    </span>
                  </dt>
                  <dd>
                    {/* READY CLAIMS NOTHING ABOUT THE MICROPHONES. Before a session starts there
                        are no chunks, so mic health is unknown by construction — the mockup's
                        "both mics seen" was not buildable and is not built. */}
                    {st.state === "ready" || (!r.recording && r.last_piece_at === null) ? (
                      <span className="text-caption text-even-ink-400">no tape yet</span>
                    ) : (
                      // §3.5 — THE MAIN MICROPHONE'S OWN AGE. Both per-source instants have
                      // been on the wire since this screen shipped and only the NEWER OF THE TWO
                      // was ever shown, so a main mic that had stopped an hour ago read healthy
                      // for as long as the spare kept uploading. The lamp still follows either
                      // mic — that rule is Build 2's and is untouched — but the number beside it
                      // now names which microphone it belongs to.
                      <Pill level={r.mic_level} title="the lamp follows the newest piece on EITHER mic, on the UPLOAD clock — a healthy mic cycles 0–5 min">
                        {r.last_primary_at ? fmtAge(ageMs(r.last_primary_at, nowMs)) : r.recording ? "no piece yet" : "—"}
                      </Pill>
                    )}
                  </dd>
                </div>

                {/* ── §2.2 THE LEVEL BARS ────────────────────────────────────────────────
                    One per microphone THAT EXISTS on this rig. A room with one microphone shows
                    ONE bar and says nothing at all about a spare (D32) — most rooms have one, and
                    a grey "no spare" placeholder would make the normal case look degraded. The
                    spare's bar appears only where a second device has actually recorded. */}
                {l?.mic ? (
                  <div className="pt-1 space-y-1.5">
                    <LevelBar label="Main mic" levels={l.mic} />
                    {r.spare_exists && l.spare ? <LevelBar label="Spare mic" levels={l.spare} /> : null}
                  </div>
                ) : null}

                {/* ── §2.3 THE SIZE VITAL, beside freshness and never instead of it ───────────
                    Freshness says audio is ARRIVING. This says what arrives is actually audio.
                    Cardiology's spare wrote full-length pieces at a sixty-eighth of the main's
                    rate and nothing on this page could show it.

                    RENDERED ONLY WHEN IT HAS SOMETHING TO SAY. `unknown` — too few pieces to have
                    learned a baseline, or pieces carrying no measurements — renders nothing at
                    all, because a vital that cannot be computed must read as absent rather than
                    as healthy. */}
                {r.mic_size && r.mic_size.newest !== "unknown" ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-caption text-even-ink-500">
                      Piece size <span className="text-even-ink-400">· against this room&rsquo;s own recent pieces</span>
                    </dt>
                    <dd>
                      {r.mic_size.newest === "tiny" ? (
                        <Pill level="amber" title="full-length pieces are coming back a fraction of this microphone's usual size">
                          {r.mic_size.tiny_run > 1 ? `${r.mic_size.tiny_run} pieces tiny` : "tiny"}
                        </Pill>
                      ) : (
                        <Pill level="ok" title="pieces are the size this microphone usually produces">normal here</Pill>
                      )}
                    </dd>
                  </div>
                ) : null}
                {r.spare_exists && r.spare_size && r.spare_size.newest === "tiny" ? (
                  <p className="text-caption text-warning-700 leading-snug">
                    The spare microphone is recording pieces a fraction of its usual size. The main
                    microphone is unaffected and is still the source of record.
                  </p>
                ) : null}

                {/* §3.1 — THE ROW RENDERS ONLY WHERE THERE IS A CLOCK TO SHOW.
                    Nothing in production writes a warehouse clock event; the only writer is a
                    script somebody runs by hand. The screen used to fall back to the time
                    RECORDING STARTED when no cue existed, so the number displayed was the length
                    of the recording wearing a clock gap's label — every room amber at fifteen
                    minutes and red at thirty, every day, one of the four alarms that fired on
                    healthy behaviour. The fallback is deleted and the row is gone with it. The
                    vital, its label and its thresholds are untouched: it returns the day
                    something feeds it. */}
                {r.has_doctor_clock ? (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-caption text-even-ink-500" title="Pulse clocks from the LABELLED doctor only. The warehouse holds no room.">
                        This doctor
                        {thresholds ? <span className="text-even-ink-400"> · amber at {Math.round(thresholds.doctor_clock_amber_ms / 60_000)} min</span> : null}
                      </dt>
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
                    {/* A4 — THE MISREADING THIS PREVENTS is the one that turned a busy morning
                        into an apparent six-hour blackout on 19 August. It lived only in a
                        `title`, which is exactly nowhere on the iPad this screen targets. Shown
                        only when the vital is actually complaining, so a healthy card stays
                        short. */}
                    {r.doctor_clock_level === "amber" || r.doctor_clock_level === "red" ? (
                      <p className="text-caption text-even-ink-500 leading-snug">
                        A gap here means the labelled doctor has not clocked — not that the room is
                        empty. Another doctor may be in it seeing patients.
                      </p>
                    ) : null}
                  </>
                ) : null}

                <div className="flex items-center justify-between gap-2">
                  <dt className="text-caption text-even-ink-500">Marks</dt>
                  <dd className="text-caption text-even-navy-800">
                    {r.marks_today}
                    {/* §3.5 — WHEN, not just how many. The instant was already on the wire and
                        thrown away, and "3 marks" without a time cannot answer the only question
                        an operator asks about it: is this room still being marked? */}
                    {r.last_mark_at ? <span className="text-even-ink-400"> · last {fmtAge(ageMs(r.last_mark_at, nowMs))} ago</span> : null}
                    {r.marks_not_sent > 0 ? <span className={`${PILL} ${LEVEL_CLASS.amber} ml-1.5`}>{r.marks_not_sent} not sent</span> : null}
                  </dd>
                </div>

                {/* §3.5 — PIECES FROM A SPARE, AS A NUMBER. Rendered only where a spare has
                    actually recorded something (D32): most rooms have one microphone and a room
                    with one microphone says NOTHING about a spare — no empty lane, no grey
                    placeholder, no amber vital. The old "backup mic reads no chunks" row fired on
                    every single-mic room for the whole of every session. */}
                {r.spare_exists && r.backup_chunks_today > 0 ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-caption text-even-ink-500">Spare mic</dt>
                    <dd className="text-caption text-even-navy-800">
                      {r.backup_chunks_today} piece{r.backup_chunks_today === 1 ? "" : "s"} today
                      {r.last_backup_at ? <span className="text-even-ink-400"> · newest {fmtAge(ageMs(r.last_backup_at, nowMs))} ago</span> : null}
                    </dd>
                  </div>
                ) : null}

                {/* §3.5 — MINUTES TURNED INTO WORDS, PER ROOM. Computed per room since this
                    screen shipped and only ever shown as an all-rooms total. */}
                {r.transcript_counts.words_ms > 0 ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-caption text-even-ink-500">Turned into words</dt>
                    <dd className="text-caption text-even-navy-800">{fmtMinutes(r.transcript_counts.words_ms)}</dd>
                  </div>
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
                  disabled={!st.start_available}
                  title={st.start_available ? "queue start_day" : startBlockedReason(st) ?? undefined}
                  onClick={() => void send(r.room.id, "start_day")}
                  className={CTRL_BTN}
                >
                  start
                </button>
                <button
                  type="button"
                  disabled={!r.recording || !canReachKiosk}
                  title={!canReachKiosk ? "No kiosk is listening; pause would be queued into the dark." : undefined}
                  onClick={() => void send(r.room.id, "pause_day")}
                  className={CTRL_BTN}
                >
                  pause
                </button>
                <button
                  type="button"
                  disabled={st.state !== "paused" || !canReachKiosk}
                  title={!canReachKiosk ? "No kiosk is listening; resume would be queued into the dark." : undefined}
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
                    disabled={!canReachKiosk}
                    onClick={() => void send(r.room.id, "end_day")}
                    className="min-h-11 min-w-11 px-4 py-2 rounded-lg text-label font-semibold bg-danger-500 text-even-white ring-2 ring-danger-700 ring-offset-1 hover:bg-danger-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    confirm stop
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={(!r.recording && !r.paused_session) || !canReachKiosk}
                    title={!canReachKiosk ? "No kiosk is listening; stop would be queued into the dark." : undefined}
                    onClick={() => setConfirmStop(r.room.id)}
                    className={CTRL_BTN}
                  >
                    stop
                  </button>
                )}
              </div>
              {!canReachKiosk && (r.recording || r.paused_session) ? (
                <p className="mt-2 text-caption font-semibold text-warning-700 leading-snug">
                  Kiosk offline — pause, resume, and stop are disabled because they would be queued into the dark.
                </p>
              ) : null}

              {/* A4 — THE LOAD-BEARING SENTENCE. This is the only place that says why Start is
                  disabled, and it used to be a `title`, which iOS Safari never renders: on the
                  iPad this screen now targets, a greyed Start had no explanation anywhere at
                  all. It names the cause and the fix, and it is only rendered when Start is
                  actually off. */}
              {startBlockedReason(st) ? (
                <p className="mt-2 text-caption text-even-ink-600 leading-snug">{startBlockedReason(st)}</p>
              ) : null}
              {/* §3.8 part 3 — THE CONTROL STATES ITS COST BEFORE IT IS USED, not afterwards on
                  the room card. An operator can stop a room from here and, until Build 2's
                  heartbeat is PROVEN on a clinic Mac, may not be able to start it again: stopping
                  is what used to make a room stop listening, and on 24 August that cost one walk
                  downstairs on three rooms out of three. A control that can be used but not undone
                  from the same place is worse than no control, because it looks safe — so the
                  second tap says what it will cost while there is still time not to take it. */}
              {confirmStop === r.room.id ? (
                <p className="mt-2 text-caption text-danger-700 leading-snug">
                  Tap “confirm stop” to end this day. This disarms itself in {CONFIRM_STOP_MS / 1000} seconds.{" "}
                  {l?.listening
                    ? "This room is reporting itself, so start should be available again from here. If it goes quiet after stopping, it has to be restarted at the Mac in the room."
                    : "This room is NOT reporting itself right now, so you will not be able to start it again from this screen — somebody has to open the room page on the Mac in that room."}
                </p>
              ) : null}

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
