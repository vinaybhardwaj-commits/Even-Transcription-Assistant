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
const LEVEL_CLASS: Record<Level, string> = {
  ok: "bg-success-100 text-success-700",
  amber: "bg-warning-100 text-warning-700",
  red: "bg-danger-100 text-danger-700",
  unknown: "bg-even-ink-100 text-even-ink-500",
};

function Pill({ level, children, title }: { level: Level; children: React.ReactNode; title?: string }) {
  return <span className={`${PILL} ${LEVEL_CLASS[level]}`} title={title}>{children}</span>;
}

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

  const nowMs = Date.now();
  const listenerMap = React.useMemo(() => {
    const m = new Map<string, ListenerRowView>();
    for (const l of listeners?.listeners ?? []) m.set(l.room_id, l);
    return m;
  }, [listeners]);
  const listenersKnown = Boolean(listeners) && !(listeners?.degraded?.length);
  const rooms = rollup?.rooms ?? [];
  const attention = React.useMemo(() => attentionItems(rooms, listenerMap, listenersKnown, nowMs), [rooms, listenerMap, listenersKnown, nowMs]);

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
            className="px-2 py-0.5 rounded-md text-caption bg-even-ink-100 hover:bg-even-ink-200"
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

      <div className="overflow-x-auto rounded-lg border border-even-ink-200">
        <table className="w-full text-body">
          <thead className="bg-even-ink-50 text-caption uppercase tracking-wide text-even-ink-500">
            <tr>
              <th className="text-left py-2 px-2.5">Room</th>
              <th className="text-left py-2 px-2.5">Kiosk</th>
              <th className="text-left py-2 px-2.5">Tape</th>
              <th className="text-left py-2 px-2.5">Mic</th>
              <th className="text-left py-2 px-2.5" title="Pulse clocks from the LABELLED doctor only. The warehouse holds no room.">This doctor</th>
              <th className="text-left py-2 px-2.5">Marks</th>
              <th className="text-left py-2 px-2.5">Transcription</th>
              <th className="text-left py-2 px-2.5">Controls</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-even-ink-100">
            {rooms.map((r) => {
              const l = listenerMap.get(r.room.id);
              const state = !listenersKnown ? "unknown" : !l ? "never" : l.listening ? "listening" : "stale";
              const pausedDisagrees = Boolean(l) && l!.paused !== r.paused_session;
              return (
                <tr key={r.room.id} className="align-top">
                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    <p className="font-semibold text-even-navy-800">{r.room.name}</p>
                    <p className="text-caption text-even-ink-400">{r.room.slug}</p>
                  </td>

                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    {state === "listening" ? <Pill level="ok" title={`polled ${fmtAge(l!.age_ms)} ago`}>page open</Pill>
                      : state === "stale" ? <Pill level="red" title={`last poll ${fmtAge(l!.age_ms)} ago`}>page stale · {fmtAge(l!.age_ms)}</Pill>
                      : state === "never" ? <Pill level="red" title="no kiosk tab has ever polled this room">no page</Pill>
                      : <Pill level="unknown" title="the bus read failed — this is not the same as no kiosk">kiosk unknown</Pill>}
                    {l?.paused ? <span className={`${PILL} ${LEVEL_CLASS.amber} ml-1.5`}>kiosk paused</span> : null}
                  </td>

                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    {r.stalled ? (
                      <span className={`${PILL} ${LEVEL_CLASS.red}`} title={`no piece from either mic for ${fmtAge(r.stalled_age_ms)} — the hourly reaper ends it after 30 min`}>
                        stalled · {fmtAge(r.stalled_age_ms)}
                      </span>
                    ) : r.recording ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-caption font-semibold bg-even-pink-50 text-even-pink-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-even-pink-600 animate-pulse" />
                        recording
                      </span>
                    ) : r.paused_session ? (
                      <span className={`${PILL} ${LEVEL_CLASS.amber}`}>paused</span>
                    ) : (
                      <span className={`${PILL} ${LEVEL_CLASS.unknown}`}>idle</span>
                    )}
                    {/* Pause has no paused_at, so this is a STATE and never a duration. */}
                    {pausedDisagrees ? (
                      <p className="text-caption text-warning-700 mt-1" title="bench_listener.paused and bench_session.status disagree">
                        pause disagrees: kiosk {l!.paused ? "paused" : "not paused"} · tape {r.paused_session ? "paused" : "not paused"}
                      </p>
                    ) : null}
                  </td>

                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    <Pill level={r.mic_level} title="freshness of the newest piece on either mic, on the UPLOAD clock — a healthy mic cycles 0–5 min">
                      {r.last_piece_at ? fmtAge(ageMs(r.last_piece_at, nowMs)) : r.recording ? "no piece yet" : "—"}
                    </Pill>
                    {r.backup_reads_no_chunks ? (
                      <span className={`${PILL} ${LEVEL_CLASS.amber} ml-1.5`} title="the backup microphone has recorded nothing at all this session">
                        backup reads no chunks
                      </span>
                    ) : r.backup_chunks_today > 0 ? (
                      <span className="text-caption text-even-ink-400 ml-1.5">{r.backup_chunks_today} backup</span>
                    ) : null}
                  </td>

                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    {r.doctor_clock_silent_ms === null ? (
                      <span className="text-caption text-even-ink-400" title="counted only while recording and not paused">—</span>
                    ) : (
                      <Pill
                        level={r.doctor_clock_level}
                        title="Pulse clocks from the LABELLED doctor only. Another doctor may be in this room seeing patients — the warehouse holds no room, so this cannot tell you the room is empty."
                      >
                        {fmtAge(r.doctor_clock_silent_ms)}
                      </Pill>
                    )}
                  </td>

                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    <span className="text-body text-even-navy-800">{r.marks_today}</span>
                    {r.last_mark_at ? <span className="text-caption text-even-ink-400 ml-1.5">last {fmtAge(ageMs(r.last_mark_at, nowMs))}</span> : null}
                    {r.marks_not_sent > 0 ? (
                      <span className={`${PILL} ${LEVEL_CLASS.amber} ml-1.5`} title="the kiosk recorded the press but the cue never reached the brain">
                        {r.marks_not_sent} not sent
                      </span>
                    ) : null}
                  </td>

                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    {r.last_window_asked_at === null ? (
                      <span className="text-caption text-even-ink-400">not asked</span>
                    ) : r.last_window_complete === true ? (
                      <Pill level="ok" title={`window finished, asked ${fmtAge(ageMs(r.last_window_asked_at, nowMs))} ago`}>finished</Pill>
                    ) : r.last_window_complete === false ? (
                      <Pill level="amber" title="the turns were rolled back — re-run this window">did not finish</Pill>
                    ) : (
                      // A marker that never says `complete` is UNKNOWN. Reading that silence as
                      // false would invent a failure nothing reported.
                      <Pill level="unknown" title="a marker exists but does not say whether the window finished">unknown</Pill>
                    )}
                  </td>

                  <td className="py-2.5 px-2.5 whitespace-nowrap">
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        disabled={state !== "listening" || r.recording}
                        title={state !== "listening" ? "no kiosk page is open in this room — a queued start would expire unseen" : r.recording ? "already recording" : "queue start_day"}
                        onClick={() => void send(r.room.id, "start_day")}
                        className="px-2 py-0.5 rounded-md text-caption bg-even-ink-100 hover:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        start
                      </button>
                      <button
                        type="button"
                        disabled={!r.recording}
                        onClick={() => void send(r.room.id, "pause_day")}
                        className="px-2 py-0.5 rounded-md text-caption bg-even-ink-100 hover:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        pause
                      </button>
                      <button
                        type="button"
                        disabled={!r.paused_session}
                        onClick={() => void send(r.room.id, "resume_day")}
                        className="px-2 py-0.5 rounded-md text-caption bg-even-ink-100 hover:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        resume
                      </button>
                      {/* TWO CLICKS. Ending a day is not undoable from here. */}
                      {confirmStop === r.room.id ? (
                        <button
                          type="button"
                          onClick={() => void send(r.room.id, "end_day")}
                          className="px-2 py-0.5 rounded-md text-caption font-semibold bg-danger-100 text-danger-700 hover:bg-danger-200"
                        >
                          confirm stop
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!r.recording && !r.paused_session}
                          onClick={() => setConfirmStop(r.room.id)}
                          className="px-2 py-0.5 rounded-md text-caption bg-even-ink-100 hover:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          stop
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rooms.length === 0 ? (
              <tr><td colSpan={8} className="py-4 px-2.5 text-caption text-even-ink-400">{rollup ? "no enabled rooms" : "loading…"}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-caption text-even-ink-400">
        “This doctor” counts Pulse clocks from the labelled doctor only. The warehouse holds no room, so a gap there
        never means the room is empty — another doctor may be in it and seeing patients.
      </p>
    </section>
  );
}
