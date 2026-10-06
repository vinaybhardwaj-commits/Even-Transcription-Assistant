/**
 * lib/steward/rules.ts + lib/steward/config.ts — the rule table, one fixture-driven scenario per row. The rules are PURE: a RoomSense, a Config, a clock and the room's
 * recent decisions go in; Decisions come out. Every clock here is an explicit IST instant on 6 Oct 2026 (a Tuesday), never Date.now().
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, buildRoster, parseConfig, windowAt, type Config } from "@/lib/steward/config";
import { EMPTY_RECENT, chromeGate, decideRoom, failingClass, fleetDecisions, hashFacts, type RecentAction, type RecentContext } from "@/lib/steward/rules";
import type { RoomSense } from "@/lib/steward/sense";
import { ago, healthy, idle, ist, type DeepPartial } from "../support/steward-fixtures";

const row = (A: number, secAgo: number, action: string, over: Partial<RecentAction> = {}): RecentAction => ({
  ts: ago(A, secAgo),
  rule: "r",
  action,
  params: {},
  outcome: "shadow",
  ...over,
});
const recent = (rows: RecentAction[], fleet: RecentContext["fleet"] = { failing: {}, hold: {} }): RecentContext => ({ room: rows, fleet });
const T = ist("10:00");
const first = (s: RoomSense, A: number, r: RecentContext = EMPTY_RECENT, cfg: Config = DEFAULT_CONFIG) => decideRoom(s, cfg, A, r)[0]!;

// ---------------------------------------------------------------------------
describe("config: parse, roster, windows", () => {
  it("the seed parses with no invalid key; a malformed key falls back to the default and is named; the kill switch falls back ON", () => {
    const seed = [
      { key: "kill_switch", value: { on: false } },
      { key: "shadow", value: { global: true, actions: { scribe_start: false } } },
      { key: "schedule", value: DEFAULT_CONFIG.schedule },
      { key: "days", value: { mode: "every_day", closed: ["2026-10-02"] } },
      { key: "caps", value: DEFAULT_CONFIG.caps },
      { key: "priority", value: { order: ["ot", "opd", "clinic"] } },
      { key: "rooms", value: { room_x: { class: "ot", flags: ["x"], machine: "M" } } },
    ];
    const ok = parseConfig(seed);
    expect(ok.invalid).toEqual([]);
    expect(ok.config.kill_switch).toBe(false);
    expect(ok.config.shadow.actions).toEqual({ scribe_start: false });
    expect(ok.config.days.closed).toEqual(["2026-10-02"]);
    expect(ok.config.rooms.room_x).toEqual({ class: "ot", flags: ["x"], machine: "M" });

    const bad = parseConfig([{ key: "kill_switch", value: "yes" }, { key: "schedule", value: { clinic: { start: "7:30", end: "21:30" }, ot: {} } }, { key: "caps", value: { actions_per_room_per_hour: 0 } }]);
    expect(bad.config.kill_switch).toBe(true);
    expect(bad.invalid).toEqual(expect.arrayContaining(["kill_switch", "schedule", "caps", "shadow", "days", "priority", "rooms"]));
    expect(bad.config.schedule.clinic.start).toBe("07:30");
    // jsonb arrives as a string from some drivers
    expect(parseConfig([{ key: "kill_switch", value: '{"on":false}' }]).config.kill_switch).toBe(false);
  });

  it("roster: test/dev rooms are excluded, class comes from the override (default clinic), machine from the override else the install hostname, ot sorts first", () => {
    const cfg = parseConfig([
      { key: "kill_switch", value: { on: true } },
      { key: "rooms", value: { room_orb3: { flags: ["dev", "test"], machine: "ORBOX3" }, room_orb2: { class: "ot", flags: [], machine: "vinay-orb2" } } },
    ]).config;
    const r = buildRoster(
      [
        { room_id: "room_opd1", room_name: "OPD 1", hostname: "EHRC-CONSUL1’s Mac mini (2)" },
        { room_id: "room_orb3", room_name: "ORB3", hostname: "ORBOX3" },
        { room_id: "room_orb2", room_name: "ORB2", hostname: null },
        { room_id: "room_nohost", room_name: "Dietary", hostname: null },
      ],
      cfg,
    );
    expect(r.map((x) => x.room_id)).toEqual(["room_orb2", "room_nohost", "room_opd1"]);
    expect(r[0]).toMatchObject({ klass: "ot", kind: "ot", machine: "vinay-orb2" });
    expect(r[1]).toMatchObject({ klass: "clinic", machine: null });
    expect(r[2]!.machine).toBe("EHRC-CONSUL1s-Mac-mini-2");
  });

  it("clinic window: 07:29 IST is out, 07:30 is in; 21:29 in, 21:30 out", () => {
    expect(windowAt(DEFAULT_CONFIG, "clinic", ist("07:29", "2026-10-06", "59")).in_window).toBe(false);
    expect(windowAt(DEFAULT_CONFIG, "clinic", ist("07:30")).in_window).toBe(true);
    expect(windowAt(DEFAULT_CONFIG, "clinic", ist("21:29", "2026-10-06", "59")).in_window).toBe(true);
    expect(windowAt(DEFAULT_CONFIG, "clinic", ist("21:30")).in_window).toBe(false);
  });

  it("ot window crosses midnight: 03:59 next day is in, 04:00 and 04:01 are out, 05:59 out, 06:00 in", () => {
    expect(windowAt(DEFAULT_CONFIG, "ot", ist("03:59", "2026-10-07", "59")).in_window).toBe(true);
    expect(windowAt(DEFAULT_CONFIG, "ot", ist("04:00", "2026-10-07")).in_window).toBe(false);
    expect(windowAt(DEFAULT_CONFIG, "ot", ist("04:01", "2026-10-07")).in_window).toBe(false);
    expect(windowAt(DEFAULT_CONFIG, "ot", ist("05:59", "2026-10-07", "59")).in_window).toBe(false);
    expect(windowAt(DEFAULT_CONFIG, "ot", ist("06:00", "2026-10-07")).in_window).toBe(true);
    expect(windowAt(DEFAULT_CONFIG, "ot", ist("01:00", "2026-10-07")).in_window).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("windows and the end of the day", () => {
  it("07:29 IST with no session: outside the window, nothing to do; 07:30: scribe_start", () => {
    const early = ist("07:29", "2026-10-06", "59");
    expect(first(idle(early), early)).toMatchObject({ rule: "outside_window", action: "none" });
    const on = ist("07:30");
    expect(first(idle(on), on)).toMatchObject({ rule: "not_recording", action: "scribe_start", window_kind: "clinic" });
  });

  it("OT room: 03:59 next day is still inside (healthy), 04:01 with a session and no consult is scribe_stop; 05:59 outside, 06:00 scribe_start", () => {
    const a = ist("03:59", "2026-10-07", "59");
    expect(first(healthy(a, { klass: "ot", kind: "ot" }), a)).toMatchObject({ rule: "ok", window_kind: "ot" });
    const b = ist("04:01", "2026-10-07");
    expect(first(healthy(b, { klass: "ot", kind: "ot" }), b)).toMatchObject({ rule: "end_of_window", action: "scribe_stop", window_kind: "ot" });
    const c = ist("05:59", "2026-10-07", "59");
    expect(first(idle(c, { klass: "ot", kind: "ot" }), c)).toMatchObject({ rule: "outside_window", action: "none" });
    const d = ist("06:00", "2026-10-07");
    expect(first(idle(d, { klass: "ot", kind: "ot" }), d)).toMatchObject({ rule: "not_recording", action: "scribe_start" });
  });

  it("a closed day: no start; an open session is stopped by end_of_window (F10: end_of_window is evaluated before closed_day)", () => {
    const cfg = parseConfig([{ key: "kill_switch", value: { on: true } }, { key: "days", value: { mode: "every_day", closed: ["2026-10-06"] } }]).config;
    expect(first(idle(T), T, EMPTY_RECENT, cfg)).toMatchObject({ rule: "closed_day", action: "none" });
    const late = ist("22:30");
    expect(first(idle(late), late, EMPTY_RECENT, cfg)).toMatchObject({ rule: "closed_day", action: "none" });
    expect(first(healthy(late), late, EMPTY_RECENT, cfg)).toMatchObject({ rule: "end_of_window", action: "scribe_stop" });
    expect(first(healthy(late), late)).toMatchObject({ rule: "end_of_window", action: "scribe_stop" });
  });

  it("F10: an OT session that ran past midnight into a closed day still gets end_of_window (the 6 Oct OT window ends 04:00 on 7 Oct, which is closed)", () => {
    const cfg = parseConfig([{ key: "kill_switch", value: { on: true } }, { key: "days", value: { mode: "every_day", closed: ["2026-10-07"] } }]).config;
    const a = ist("04:20", "2026-10-07");
    const ot = { klass: "ot", kind: "ot" } as const;
    expect(first(healthy(a, ot), a, EMPTY_RECENT, cfg)).toMatchObject({ rule: "end_of_window", action: "scribe_stop", window_kind: "ot" });
    // no session on that closed day: closed_day, nothing to do
    expect(first(idle(a, ot), a, EMPTY_RECENT, cfg)).toMatchObject({ rule: "closed_day", action: "none" });
  });

  it("end of window, no consult: scribe_stop at once", () => {
    const A = ist("21:35");
    expect(first(healthy(A), A)).toMatchObject({ rule: "end_of_window", action: "scribe_stop", params: {}, why_not: null });
  });

  it("end of window with a consult open: waits up to 30 min (why_not names the consult), then scribe_stop + a 'late stop' message", () => {
    const wait = ist("21:59", "2026-10-06", "59");
    const d = first(healthy(wait, { consult_open: true, consult_started_at: ago(wait, 600) }), wait);
    expect(d).toMatchObject({ rule: "end_of_window", action: "none" });
    expect(d.why_not).toContain("consult open");
    const cut = ist("22:00");
    const ds = decideRoom(healthy(cut, { consult_open: true, consult_started_at: ago(cut, 600) }), DEFAULT_CONFIG, cut, EMPTY_RECENT);
    expect(ds.map((x) => x.action)).toEqual(["scribe_stop", "message"]);
    expect(ds[0]!.params).toEqual({ late: true });
    expect(String(ds[1]!.params.text)).toContain("late stop");
  });

  it("end of window with the consult state unknown waits like an open consult", () => {
    const A = ist("21:45");
    const d = first(healthy(A, { consult_open: null }), A);
    expect(d.action).toBe("none");
    expect(d.why_not).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
describe("not recording: start, backoff, max tries", () => {
  it("inside the window, no session, reachable: scribe_start", () => {
    expect(first(idle(T), T)).toMatchObject({ rule: "not_recording", action: "scribe_start", severity: "warn", why_not: null });
  });

  it("room_failing backoff (2 failed starts in the hour) holds the start and says why", () => {
    const d = first(idle(T, { start_backoff: { failed_attempts: 2, retry_after_s: 1800 } }), T);
    expect(d).toMatchObject({ rule: "not_recording", action: "log_only", params: {}, failing_class: "not_recording" });
    expect(d.inputs).toMatchObject({ retry_after_s: 1800, failing_class: "not_recording" });
    expect(d.why_not).toContain("room_failing");
  });

  it("3 recorded start tries in the hour -> one message with needs_hands; 2 tries still start; old or ok tries do not count", () => {
    const three = recent([row(T, 100, "scribe_start"), row(T, 1000, "scribe_start"), row(T, 2000, "scribe_start")]);
    const d = first(idle(T), T, three);
    expect(d).toMatchObject({ rule: "not_recording", action: "message", severity: "error" });
    expect(d.params).toMatchObject({ needs_hands: true, kind: "start_exhausted" });
    expect(d.params).not.toHaveProperty("tries");
    expect(d.inputs).toMatchObject({ tries: 3 });
    expect(d.failing_class).toBe("not_recording");
    expect(first(idle(T), T, recent([row(T, 100, "scribe_start"), row(T, 1000, "scribe_start")])).action).toBe("scribe_start");
    expect(first(idle(T), T, recent([row(T, 100, "scribe_start"), row(T, 1000, "scribe_start"), row(T, 4000, "scribe_start")])).action).toBe("scribe_start");
    expect(first(idle(T), T, recent([row(T, 100, "scribe_start", { outcome: "ok" }), row(T, 1000, "scribe_start", { outcome: "ok" }), row(T, 2000, "scribe_start", { outcome: "ok" })])).action).toBe("scribe_start");
  });

  it("a paused (consent) room is never started; unreadable start history holds the start", () => {
    const d = first(idle(T, { listener: { listening: true, paused: true } }), T);
    expect(d).toMatchObject({ action: "log_only" });
    expect(d.why_not).toContain("paused");
    const e = first(idle(T, { start_backoff: null }), T);
    expect(e).toMatchObject({ action: "log_only" });
    expect(e.why_not).toContain("start_attempts");
  });

  it("an unreachable Mac (poller and kiosk-health both stale > 3 min) is the asleep rule, not a start", () => {
    const d = first(idle(T, { reachable: { poller_ok_at: ago(T, 240), kh_heartbeat_at: ago(T, 240) } }), T);
    expect(d).toMatchObject({ rule: "kiosk_asleep", action: "ticket:wake" });
  });
});

// ---------------------------------------------------------------------------
describe("session died vs upload lag", () => {
  const died = (over: DeepPartial<RoomSense> = {}) =>
    healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 300) } }, ...over });

  it("no chunk for 12 min and recorder.status stale 5 min -> scribe_restart", () => {
    expect(first(died(), T)).toMatchObject({ rule: "session_died", action: "scribe_restart", severity: "error" });
  });

  it("no chunk for 12 min but the recorder is fresh and says a session is open = upload lag, not a death", () => {
    const s = healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 20) } } });
    expect(first(s, T)).toMatchObject({ rule: "ok", action: "none" });
  });

  it("recorder says session_open=false with a fresh status and no chunk for 12 min -> scribe_restart", () => {
    const s = healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "idle", session_open: false, received_at: ago(T, 20) } } });
    expect(first(s, T).action).toBe("scribe_restart");
  });

  it("a session that started 2 min ago has no chunk yet and is not dead; a paused session is not dead", () => {
    const young = healthy(T, { recording: { last_chunk_at: null, session_started_at: ago(T, 120), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 300) } } });
    expect(first(young, T).rule).toBe("ok");
    const paused = healthy(T, { recording: { session_status: "paused", last_chunk_at: ago(T, 3000), recorder_status: { state: "paused", session_open: true, received_at: ago(T, 300) } } });
    expect(first(paused, T).rule).toBe("ok");
  });

  it("ladder: restart sent 2 min ago -> wait; 7 min ago and the recorder says no session -> ticket restart_recorder_app", () => {
    const wait = first(died(), T, recent([row(T, 120, "scribe_restart")]));
    expect(wait).toMatchObject({ rule: "session_died", action: "log_only" });
    expect(wait.why_not).toContain("restart");
    const closed = healthy(T, { recording: { last_chunk_at: ago(T, 900), recorder_status: { state: "idle", session_open: false, received_at: ago(T, 20) } } });
    expect(first(closed, T, recent([row(T, 420, "scribe_restart")]))).toMatchObject({ rule: "session_died", action: "ticket:restart_recorder_app", params: {} });
  });

  it("ladder: no ticket while a session is not confirmed closed; then the message; and after the app restart the message", () => {
    const m = first(died(), T, recent([row(T, 420, "scribe_restart")]));
    expect(m).toMatchObject({ rule: "session_died", action: "message" });
    expect(m.params.needs_hands).toBe(true);
    expect(m.why_not).toContain("not confirmed");
    const closed = healthy(T, { recording: { last_chunk_at: ago(T, 900), recorder_status: { state: "idle", session_open: false, received_at: ago(T, 20) } } });
    const m2 = first(closed, T, recent([row(T, 800, "scribe_restart"), row(T, 420, "ticket:restart_recorder_app")]));
    expect(m2).toMatchObject({ action: "message" });
    expect(m2.why_not).toContain("already tried");
  });

  it("F5: with kiosk-health down (heartbeat 8 min old) and no chunk for 12 min the session is still dead: scribe_restart with inputs.recorder_stale = 'unknown' (not forced false)", () => {
    const s = died({ reachable: { kh_heartbeat_at: ago(T, 480) } });
    const d = first(s, T);
    expect(d).toMatchObject({ rule: "session_died", action: "scribe_restart", failing_class: "session_died" });
    expect(d.inputs.recorder_stale).toBe("unknown");
  });

  it("F5: a room with no kiosk-health at all (not enrolled / no snapshot) and a session open with no chunk for 12 min -> session_died; with a fresh chunk it is fine", () => {
    const noKh = (chunk: number) => healthy(T, { recording: { last_chunk_at: ago(T, chunk), recorder_status: null }, reachable: { kh_heartbeat_at: null, kh_enrolled: false } });
    const d = first(noKh(720), T);
    expect(d).toMatchObject({ rule: "session_died", action: "scribe_restart" });
    expect(d.inputs.recorder_stale).toBe("unknown");
    expect(first(noKh(60), T).rule).toBe("ok");
    // a known-fresh recorder keeps recorder_stale false
    expect(first(died(), T).inputs.recorder_stale).toBe(true);
  });

  it("with the kiosk-health daemon down (heartbeat 8 min old) but the tape fresh: restart_kiosk_health, no session death", () => {
    const s = healthy(T, { reachable: { kh_heartbeat_at: ago(T, 480) } });
    expect(first(s, T)).toMatchObject({ rule: "kiosk_health_down", action: "ticket:restart_kiosk_health", failing_class: "kiosk_health_down" });
  });
});

// ---------------------------------------------------------------------------
describe("kiosk-health down", () => {
  it("no heartbeat for 6 min while the poller is ok -> ticket only; 11 min -> ticket + message", () => {
    const a = decideRoom(healthy(T, { reachable: { kh_heartbeat_at: ago(T, 360) } }), DEFAULT_CONFIG, T, EMPTY_RECENT);
    expect(a.map((d) => d.action)).toEqual(["ticket:restart_kiosk_health"]);
    const b = decideRoom(healthy(T, { reachable: { kh_heartbeat_at: ago(T, 660) } }), DEFAULT_CONFIG, T, EMPTY_RECENT);
    expect(b.map((d) => d.action)).toEqual(["ticket:restart_kiosk_health", "message"]);
    expect(b[1]!.params.needs_hands).toBe(true);
  });

  it("a daemon that never enrolled is not 'down'", () => {
    expect(first(healthy(T, { reachable: { kh_heartbeat_at: null, kh_enrolled: false } }), T).rule).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
describe("asleep", () => {
  it("both stale at 4 min -> ticket wake only; both stale at 11 min -> wake + message; one source fresh -> not asleep", () => {
    const a = decideRoom(idle(T, { reachable: { poller_ok_at: ago(T, 240), kh_heartbeat_at: ago(T, 240) } }), DEFAULT_CONFIG, T, EMPTY_RECENT);
    expect(a.map((d) => d.action)).toEqual(["ticket:wake"]);
    const b = decideRoom(idle(T, { reachable: { poller_ok_at: ago(T, 660), kh_heartbeat_at: ago(T, 700) } }), DEFAULT_CONFIG, T, EMPTY_RECENT);
    expect(b.map((d) => d.action)).toEqual(["ticket:wake", "message"]);
    expect(first(idle(T, { reachable: { poller_ok_at: ago(T, 600), kh_heartbeat_at: ago(T, 30) } }), T).rule).not.toBe("kiosk_asleep");
  });

  it("F4: a room that is recording is never asleep, even with poller and kiosk-health both stale; a fresh chunk (< 10 min) is proof of life", () => {
    const stale = { poller_ok_at: ago(T, 900), kh_heartbeat_at: ago(T, 900) };
    expect(first(healthy(T, { reachable: stale }), T).rule).not.toBe("kiosk_asleep");
    expect(first(healthy(T, { reachable: stale, recording: { session_status: "paused", last_chunk_at: ago(T, 300) } }), T).rule).not.toBe("kiosk_asleep");
    // no session, no chunk: asleep
    expect(first(idle(T, { reachable: stale }), T)).toMatchObject({ rule: "kiosk_asleep", action: "ticket:wake" });
  });

  it("F4: neither poller nor kiosk-health data in the last 2 h -> sense_degraded with inputs.missing, NEVER asleep (a room like ORB2 with no source)", () => {
    for (const reachable of [{ poller_ok_at: null, kh_heartbeat_at: null }, { poller_ok_at: ago(T, 3 * 3600), kh_heartbeat_at: ago(T, 5 * 3600) }]) {
      const d = first(idle(T, { reachable }), T);
      expect(d).toMatchObject({ rule: "sense_degraded", action: "log_only" });
      expect(d.inputs.missing).toContain("reachability_2h");
      expect(d.failing_class ?? null).toBeNull();
    }
    // one source inside 2 h is data: asleep again
    expect(first(idle(T, { reachable: { poller_ok_at: ago(T, 3 * 3600), kh_heartbeat_at: ago(T, 3600) } }), T).rule).toBe("kiosk_asleep");
  });

  it("F1: kiosk_asleep is a positive fleet signal (the machine spoke today, inside the 2 h data rule); a machine last heard yesterday is sense_degraded and never counts", () => {
    const awake = first(idle(T, { reachable: { poller_ok_at: ago(T, 1800), kh_heartbeat_at: ago(T, 1800) } }), T);
    expect(awake).toMatchObject({ rule: "kiosk_asleep", failing_class: "kiosk_asleep" });
    expect(awake.inputs.awake_today).toBe(true);
    // OT room at 00:20 on 7 Oct (inside the window that began 6 Oct 06:00): heard 50 min ago = 23:30 on 6 Oct is still "today" for the window
    const a = ist("00:20", "2026-10-07");
    const ot = { klass: "ot", kind: "ot" } as const;
    expect(first(idle(a, { ...ot, reachable: { poller_ok_at: ago(a, 3000), kh_heartbeat_at: ago(a, 3000) } }), a)).toMatchObject({ rule: "kiosk_asleep", failing_class: "kiosk_asleep" });
    // 07:31, last heard 23:00 yesterday (8.5 h): no data in 2 h -> degraded, not asleep, no class
    const b = ist("07:31");
    const stale = first(idle(b, { reachable: { poller_ok_at: ago(b, 8.5 * 3600), kh_heartbeat_at: null } }), b);
    expect(stale.rule).toBe("sense_degraded");
    expect(failingClass([stale])).toBeNull();
  });

  it("F1: kiosk_health_down is a positive fleet signal only after kiosk-health reported today", () => {
    const d = first(healthy(T, { reachable: { kh_heartbeat_at: ago(T, 480) } }), T);
    expect(d).toMatchObject({ rule: "kiosk_health_down", failing_class: "kiosk_health_down" });
    const never = first(healthy(T, { reachable: { kh_heartbeat_at: null, kh_enrolled: true } }), T);
    expect(never).toMatchObject({ rule: "kiosk_health_down" });
    expect(never.failing_class ?? null).toBeNull();
  });

  it("an unreadable reachability source is 'degraded', not 'asleep'", () => {
    const d = first(healthy(T, { reachable: { poller_ok_at: null }, missing: ["presence_poller"] }), T);
    expect(d).toMatchObject({ rule: "sense_degraded", action: "log_only" });
    expect(d.why_not).toContain("presence_poller");
  });
});

// ---------------------------------------------------------------------------
describe("silence and the microphone", () => {
  const consult = (secOpen: number, over: DeepPartial<RoomSense> = {}) => healthy(T, { consult_open: true, consult_started_at: ago(T, secOpen), ...over });

  it("tape silent with NO open consult -> log_only; with an open consult -> the mic message", () => {
    expect(first(healthy(T, { audio: { silent_while_recording_since: ago(T, 200) } }), T)).toMatchObject({ rule: "silent_no_consult", action: "log_only" });
    const d = first(consult(300, { audio: { silent_while_recording_since: ago(T, 200) } }), T);
    expect(d).toMatchObject({ rule: "mic_fault", action: "message" });
    expect(d.params.text).toBe("no sound from the mic — check mute or cable");
  });

  it("unplugged / missing input -> the cable message (default_input_present=false, usb removed, or the DEVICE_MISSING flag); never a restart", () => {
    for (const audio of [{ default_input_present: false }, { usb_removed_recent: true }, { device_missing_flag: true }]) {
      const d = first(consult(300, { audio }), T);
      expect(d).toMatchObject({ rule: "mic_fault", action: "message" });
      expect(d.params.text).toBe("mic unplugged/missing — check cable");
      expect(d.action).not.toBe("scribe_restart");
    }
  });

  it("mute and unplug read differently: missing input wins over silence in the wording", () => {
    const both = first(consult(300, { audio: { default_input_present: false, silent_while_recording_since: ago(T, 200) } }), T);
    expect(both.params.text).toBe("mic unplugged/missing — check cable");
  });

  it("a consult that opened 30 s ago waits (60 s rule), a silent tape under 60 s too", () => {
    expect(first(consult(30, { audio: { default_input_present: false } }), T)).toMatchObject({ rule: "mic_check_pending", action: "none" });
    expect(first(consult(300, { audio: { silent_while_recording_since: ago(T, 30) } }), T).rule).not.toBe("mic_fault");
  });
});

// ---------------------------------------------------------------------------
describe("doctor away and identity fault do nothing", () => {
  const unloaded = { chrome: { active: ["Default"] }, ext: { last_event_at: ago(T, 900) } } as DeepPartial<RoomSense>;

  it("no_tab -> nothing, even where an unloaded profile would otherwise open Pulse", () => {
    expect(first(healthy(T, { ...unloaded, ext: { last_event_at: ago(T, 900), no_tab: true, status: "no_tab" } }), T)).toMatchObject({ rule: "doctor_away", action: "none" });
  });

  it("identity fault -> nothing (the row is the log)", () => {
    expect(first(healthy(T, { occupancy: { identity_fault: true } }), T)).toMatchObject({ rule: "identity_fault", action: "none" });
    // doctor away is evaluated first
    expect(first(healthy(T, { occupancy: { identity_fault: true }, ext: { no_tab: true } }), T).rule).toBe("doctor_away");
  });
});

// ---------------------------------------------------------------------------
describe("Chrome-touching tickets: the four gates", () => {
  const unloaded = (over: DeepPartial<RoomSense> = {}) => healthy(T, { chrome: { active: ["Default"] }, ext: { last_event_at: ago(T, 900) }, ...over });

  it("all four clear -> ticket open_pulse for the profile in use", () => {
    expect(first(unloaded(), T)).toMatchObject({ rule: "profile_unloaded", action: "ticket:open_pulse", params: { profile: "Profile 1" }, why_not: null });
  });

  it("someone present at the Mac blocks it, named in why_not", () => {
    const d = first(unloaded({ occupancy: { state: "present" } }), T);
    expect(d).toMatchObject({ rule: "profile_unloaded", action: "log_only" });
    expect(d.why_not).toContain("occupancy");
  });

  it("a pending login blocks it", () => {
    expect(first(unloaded({ occupancy: { state: "pending" } }), T).why_not).toContain("login pending");
  });

  it("poller idle under 600 s blocks it", () => {
    const d = first(unloaded({ occupancy: { idle_s: 300 } }), T);
    expect(d.action).toBe("log_only");
    expect(d.why_not).toContain("idle 300 s < 600 s");
    expect(first(unloaded({ occupancy: { idle_s: 600 } }), T).action).toBe("ticket:open_pulse");
  });

  it("an open consult blocks it", () => {
    const d = first(unloaded({ consult_open: true, consult_started_at: ago(T, 300) }), T);
    expect(d.action).toBe("log_only");
    expect(d.why_not).toContain("consult open");
  });

  it("chromeGate reports the FIRST blocker in the spec order", () => {
    expect(chromeGate(healthy(T, { occupancy: { state: "present", idle_s: 10 }, consult_open: true }))).toContain("occupancy");
    expect(chromeGate(healthy(T, { occupancy: null }))).toContain("unknown");
    expect(chromeGate(healthy(T))).toBeNull();
  });

  it("a recently heard extension, or a loaded profile, is not 'unloaded'", () => {
    expect(first(healthy(T, { chrome: { active: ["Default"] }, ext: { last_event_at: ago(T, 300) } }), T).rule).toBe("ok");
    expect(first(healthy(T), T).rule).toBe("ok");
  });

  it("a profile name a ticket cannot carry is logged, not ticketed", () => {
    const d = first(unloaded({ chrome: { last_used: "P".repeat(65), active: ["Default"] } }), T);
    expect(d.action).toBe("log_only");
    expect(d.why_not).toContain("schema");
  });
});

// ---------------------------------------------------------------------------
describe("extension missing: relaunch, then policy_cycle at most once per profile per day", () => {
  const alert = (over: DeepPartial<RoomSense> = {}) =>
    healthy(T, { chrome: { last_alert_reason: "ext_missing:Profile 1", last_alert_at: ago(T, 300) }, ext: { last_event_at: ago(T, 900) }, ...over });
  const pc = (secAgo: number, profile = "Profile 1") => row(T, secAgo, "ticket:policy_cycle", { params: { profile } });
  const rl = (secAgo: number, profile = "Profile 1") => row(T, secAgo, "ticket:relaunch_chrome", { params: { profile } });

  it("first sight -> relaunch_chrome", () => {
    expect(first(alert(), T)).toMatchObject({ rule: "extension_missing", action: "ticket:relaunch_chrome", params: { profile: "Profile 1" } });
  });

  it("relaunch 5 min ago -> wait; relaunch 20 min ago -> policy_cycle", () => {
    expect(first(alert(), T, recent([rl(300)]))).toMatchObject({ action: "log_only" });
    expect(first(alert(), T, recent([rl(1200)]))).toMatchObject({ action: "ticket:policy_cycle", params: { profile: "Profile 1" } });
  });

  it("the daily cap: a policy_cycle already today for this profile -> message + needs_hands (why_not names the cap); another profile or yesterday does not count", () => {
    const d = first(alert(), T, recent([rl(1200), pc(3600)]));
    expect(d).toMatchObject({ action: "message" });
    expect(d.params.needs_hands).toBe(true);
    expect(d.why_not).toContain("policy_cycle held");
    expect(first(alert(), T, recent([rl(1200), pc(3600, "Profile 2")])).action).toBe("ticket:policy_cycle");
    expect(first(alert(), T, recent([rl(1200), pc(30 * 3600)])).action).toBe("ticket:policy_cycle");
  });

  it("the extension speaking after the alert resolves it; an old alert is ignored; the ticket is gated like any Chrome touch", () => {
    expect(first(alert({ ext: { last_event_at: ago(T, 60) } }), T).rule).toBe("ok");
    expect(first(alert({ chrome: { last_alert_at: ago(T, 3600) } }), T).rule).toBe("ok");
    const d = first(alert({ occupancy: { state: "present" } }), T);
    expect(d).toMatchObject({ rule: "extension_missing", action: "log_only" });
    expect(d.why_not).toContain("chrome-touch blocked");
  });

  it("machines with no extension (Home Office, ORB2, ORB3) never raise Chrome rules", () => {
    expect(first(alert({ ext: { applicable: false } }), T).rule).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
describe("fleet incident, caps and repeated failure", () => {
  it("3 rooms failing the same way -> the per-room action is held (log_only fleet_hold), a hold row keeps it held, 2 rooms do not", () => {
    const d = first(idle(T), T, recent([], { failing: { not_recording: 3 }, hold: {} }));
    expect(d).toMatchObject({ rule: "fleet_hold", action: "log_only", params: { class: "not_recording", wanted: "scribe_start" } });
    expect(first(idle(T), T, recent([], { failing: {}, hold: { not_recording: true } })).rule).toBe("fleet_hold");
    expect(first(idle(T), T, recent([], { failing: { not_recording: 2 }, hold: {} })).action).toBe("scribe_start");
    // a healthy room under the same hold is untouched; another class is untouched
    expect(first(healthy(T), T, recent([], { failing: { not_recording: 5 }, hold: { not_recording: true } })).rule).toBe("ok");
    expect(first(idle(T, { reachable: { poller_ok_at: ago(T, 300), kh_heartbeat_at: ago(T, 300) } }), T, recent([], { failing: { not_recording: 5 }, hold: {} })).action).toBe("ticket:wake");
  });

  it("F1: failingClass needs a POSITIVE failure signal: a room that simply has not started yet today and a consent-paused room never count; a failed start does", () => {
    expect(failingClass(decideRoom(idle(T), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBeNull();
    expect(failingClass(decideRoom(idle(T, { listener: { listening: true, paused: true } }), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBeNull();
    expect(failingClass(decideRoom(idle(T, { start_backoff: { failed_attempts: 2, retry_after_s: 600 } }), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBe("not_recording");
    const three = recent([row(T, 100, "scribe_start"), row(T, 1000, "scribe_start"), row(T, 2000, "scribe_start")]);
    expect(failingClass(decideRoom(idle(T), DEFAULT_CONFIG, T, three))).toBe("not_recording");
  });

  it("failingClass keeps a held or gated room in its class", () => {
    const failedStart = idle(T, { start_backoff: { failed_attempts: 2, retry_after_s: 600 } });
    expect(failingClass(decideRoom(healthy(T), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBeNull();
    // a held unstarted room (hold row, no signal of its own) does not count; a held signalled room does
    expect(failingClass(decideRoom(idle(T), DEFAULT_CONFIG, T, recent([], { failing: {}, hold: { not_recording: true } })))).toBeNull();
    expect(failingClass(decideRoom(failedStart, DEFAULT_CONFIG, T, recent([], { failing: { not_recording: 3 }, hold: {} })))).toBe("not_recording");
    expect(failingClass(decideRoom(healthy(T, { chrome: { active: ["Default"] }, ext: { last_event_at: ago(T, 900) }, occupancy: { state: "present" } }), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBe("profile_unloaded");
  });

  it("fleetDecisions: one decision per class with >= 3 distinct rooms; none for 2", () => {
    const ds = fleetDecisions({ session_died: ["a", "b", "c", "c"], kiosk_asleep: ["a", "b"] });
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ room_id: null, window_kind: "fleet", rule: "fleet_incident", action: "message" });
    expect(ds[0]!.params).toMatchObject({ class: "session_died", count: 3, rooms: ["a", "b", "c"], hold_min: 15 });
    expect(fleetDecisions({ x: ["a", "b"] })).toEqual([]);
  });

  it("actions_per_room_per_hour: the 4th action in the hour is logged, not taken", () => {
    const asleep = idle(T, { reachable: { poller_ok_at: ago(T, 240), kh_heartbeat_at: ago(T, 240) } });
    const four = recent([row(T, 100, "ticket:wake"), row(T, 700, "scribe_restart"), row(T, 1400, "ticket:wake"), row(T, 2100, "ticket:wake")]);
    const d = first(asleep, T, four);
    expect(d).toMatchObject({ rule: "cap_reached", action: "log_only", params: { wanted: "ticket:wake" } });
    expect(d.why_not).toContain("actions_per_room_per_hour=4");
    expect(first(asleep, T, recent([row(T, 100, "ticket:wake"), row(T, 700, "scribe_restart"), row(T, 1400, "ticket:wake")])).action).toBe("ticket:wake");
    // messages do not count against the cap
    expect(first(asleep, T, recent([row(T, 100, "message"), row(T, 200, "message"), row(T, 300, "message"), row(T, 400, "message")])).action).toBe("ticket:wake");
  });

  it("the same action failing 3 times in an hour -> stop, one message, needs_hands (2 failures still try)", () => {
    const asleep = idle(T, { reachable: { poller_ok_at: ago(T, 240), kh_heartbeat_at: ago(T, 240) } });
    const f = (s: number) => row(T, s, "ticket:wake", { outcome: "failed" });
    const d = first(asleep, T, recent([f(100), f(900), f(1800)]));
    expect(d).toMatchObject({ rule: "action_failing", action: "message" });
    expect(d.params).toMatchObject({ needs_hands: true, action: "ticket:wake" });
    expect(d.params).not.toHaveProperty("failures");
    expect(d.inputs).toMatchObject({ failures: 3 });
    expect(first(asleep, T, recent([f(100), f(900)])).action).toBe("ticket:wake");
    expect(first(asleep, T, recent([f(100), f(900), f(4000)])).action).toBe("ticket:wake");
  });
});

// ---------------------------------------------------------------------------
describe("degraded inputs and determinism", () => {
  it("no bound machine -> none; session state unreadable -> log_only naming the missing source", () => {
    expect(first(healthy(T, { machine: null }), T)).toMatchObject({ rule: "no_machine", action: "none" });
    const d = first(healthy(T, { recording: { session_open: null }, missing: ["bench_session"] }), T);
    expect(d).toMatchObject({ rule: "sense_degraded", action: "log_only" });
    expect(d.why_not).toContain("bench_session");
  });

  it("nulls in the other inputs never throw: a sense with every optional input null still decides", () => {
    const bare = healthy(T, {
      recording: { recorder_status: null },
      listener: { listening: null, paused: null },
      chrome: { running: null, active: null, last_used: null, presence_ok: null },
      ext: { status: null, last_event_at: null, no_tab: null },
      consult_open: null,
      occupancy: null,
      audio: { default_input_present: null, usb_removed_recent: null, device_missing_flag: null },
      missing: ["recorder_status", "consult", "occupancy"],
    });
    expect(() => decideRoom(bare, DEFAULT_CONFIG, T, EMPTY_RECENT)).not.toThrow();
    expect(first(bare, T).action).toBe("none");
  });

  it("every Decision carries the contract fields; the same input hashes the same, a changed fact changes the hash, an age does not", () => {
    const d = first(idle(T), T);
    expect(Object.keys(d).sort()).toEqual(["action", "inputs", "inputs_hash", "machine", "params", "room_id", "rule", "severity", "why", "why_not", "window_kind"]);
    expect(d.inputs_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(first(idle(T), T).inputs_hash).toBe(d.inputs_hash);
    expect(first(idle(T, { reachable: { poller_ok_at: ago(T, 90) } }), T).inputs_hash).toBe(d.inputs_hash);
    expect(first(idle(T, { consult_open: true }), T).inputs_hash).not.toBe(d.inputs_hash);
    expect(hashFacts({ a: 1, b: 2 })).toBe(hashFacts({ b: 2, a: 1 }));
  });

  it("inputs carry ids, booleans and counts only: no room name, no doctor name", () => {
    const d = first(idle(T), T);
    const text = JSON.stringify(d.inputs);
    expect(text).not.toContain("OPD A");
  });
});

// ---------------------------------------------------------------------------
describe("F2: params are stable across minutes (the dedupe key is (room, rule, action, params))", () => {
  const p = (ds: ReturnType<typeof decideRoom>) => JSON.stringify(ds.map((d) => [d.rule, d.action, d.params]));

  it("a room_failing backoff counting down 1800 s -> 1740 s has identical params; the countdown is in inputs", () => {
    const a = decideRoom(idle(T, { start_backoff: { failed_attempts: 2, retry_after_s: 1800 } }), DEFAULT_CONFIG, T, EMPTY_RECENT);
    const b = decideRoom(idle(T + 60_000, { start_backoff: { failed_attempts: 2, retry_after_s: 1740 } }), DEFAULT_CONFIG, T + 60_000, EMPTY_RECENT);
    expect(p(a)).toBe(p(b));
    expect(a[0]!.inputs.retry_after_s).toBe(1800);
    expect(b[0]!.inputs.retry_after_s).toBe(1740);
  });

  it("a late stop one minute later has identical params (no elapsed minutes in the message text); the elapsed minutes are in inputs", () => {
    const at = (t: number) => healthy(t, { consult_open: true, consult_started_at: ago(t, 600) });
    const a = decideRoom(at(ist("22:00")), DEFAULT_CONFIG, ist("22:00"), EMPTY_RECENT);
    const b = decideRoom(at(ist("22:01")), DEFAULT_CONFIG, ist("22:01"), EMPTY_RECENT);
    expect(a.map((d) => d.action)).toEqual(["scribe_stop", "message"]);
    expect(p(a)).toBe(p(b));
    expect(a[1]!.inputs.since_end_min).toBe(30);
    expect(b[1]!.inputs.since_end_min).toBe(31);
  });

  it("start_exhausted with 3 vs 4 tries in the hour, and action_failing with 3 vs 4 failures, have identical params", () => {
    const rows3 = recent([row(T, 100, "scribe_start"), row(T, 1000, "scribe_start"), row(T, 2000, "scribe_start")]);
    const rows4 = recent([row(T, 100, "scribe_start"), row(T, 1000, "scribe_start"), row(T, 2000, "scribe_start"), row(T, 2500, "scribe_start")]);
    expect(p(decideRoom(idle(T), DEFAULT_CONFIG, T, rows3))).toBe(p(decideRoom(idle(T), DEFAULT_CONFIG, T, rows4)));
    const asleep = idle(T, { reachable: { poller_ok_at: ago(T, 240), kh_heartbeat_at: ago(T, 240) } });
    const f = (s: number) => row(T, s, "ticket:wake", { outcome: "failed" });
    expect(p(decideRoom(asleep, DEFAULT_CONFIG, T, recent([f(100), f(900), f(1800)])))).toBe(p(decideRoom(asleep, DEFAULT_CONFIG, T, recent([f(100), f(900), f(1200), f(1800)]))));
  });

  it("no decision any rule emits carries a number-bearing countdown in params: every params value is a string, boolean or a fixed enum", () => {
    const scenarios: Array<[RoomSense, RecentContext]> = [
      [idle(T, { start_backoff: { failed_attempts: 2, retry_after_s: 1800 } }), EMPTY_RECENT],
      [idle(T), recent([row(T, 100, "scribe_start"), row(T, 1000, "scribe_start"), row(T, 2000, "scribe_start")])],
      [idle(T, { reachable: { poller_ok_at: ago(T, 700), kh_heartbeat_at: ago(T, 700) } }), EMPTY_RECENT],
      [healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 300) } } }), recent([row(T, 420, "scribe_restart")])],
      [healthy(T, { reachable: { kh_heartbeat_at: ago(T, 660) } }), EMPTY_RECENT],
      [healthy(T, { consult_open: true, consult_started_at: ago(T, 300), audio: { default_input_present: false } }), EMPTY_RECENT],
    ];
    for (const [s, r] of scenarios) {
      for (const d of decideRoom(s, DEFAULT_CONFIG, T, r)) {
        for (const [k, v] of Object.entries(d.params)) expect(typeof v === "number" ? `${d.rule}.${k} is a number` : "ok").toBe("ok");
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("F1: only a POSITIVE failure signal puts a room in a fleet class", () => {
  it("nine rooms that have not started yet: no class, no hold (every decision is a scribe_start)", () => {
    for (let i = 0; i < 9; i++) {
      const ds = decideRoom(idle(T, { room_id: `r${i}` }), DEFAULT_CONFIG, T, recent([], { failing: {}, hold: {} }));
      expect(ds[0]).toMatchObject({ rule: "not_recording", action: "scribe_start" });
      expect(failingClass(ds)).toBeNull();
    }
  });

  it("session_died and a live mic fault are positive signals; a healthy and a consent-paused room are not", () => {
    const died = healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 300) } } });
    expect(failingClass(decideRoom(died, DEFAULT_CONFIG, T, EMPTY_RECENT))).toBe("session_died");
    const mic = healthy(T, { consult_open: true, consult_started_at: ago(T, 300), audio: { default_input_present: false } });
    expect(failingClass(decideRoom(mic, DEFAULT_CONFIG, T, EMPTY_RECENT))).toBe("mic_fault");
    expect(failingClass(decideRoom(healthy(T), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBeNull();
    expect(failingClass(decideRoom(idle(T, { listener: { listening: true, paused: true } }), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBeNull();
  });

  it("a cap-reached or action_failing replacement keeps the class of the decision it replaced; the class is also written to inputs.failing_class", () => {
    const died = healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 300) } } });
    const four = recent([row(T, 100, "ticket:wake"), row(T, 700, "ticket:wake"), row(T, 1400, "ticket:wake"), row(T, 2100, "ticket:wake")]);
    const d = decideRoom(died, DEFAULT_CONFIG, T, four)[0]!;
    expect(d.rule).toBe("cap_reached");
    expect(failingClass([d])).toBe("session_died");
    expect(d.inputs.failing_class).toBe("session_died");
  });
});

// ---------------------------------------------------------------------------
describe("F8 / F3 config: rooms and schedule have no fallback; source_timeout_ms is optional", () => {
  const seed = (over: Array<{ key: string; value: unknown }> = [], drop: string[] = []) =>
    [
      { key: "kill_switch", value: { on: true } },
      { key: "shadow", value: { global: true, actions: {} } },
      { key: "schedule", value: DEFAULT_CONFIG.schedule },
      { key: "days", value: { mode: "every_day", closed: [] } },
      { key: "caps", value: DEFAULT_CONFIG.caps },
      { key: "priority", value: { order: ["ot", "opd", "clinic"] } },
      { key: "rooms", value: { room_x: { flags: [] } } },
      ...over,
    ].filter((r) => !drop.includes(r.key));

  it("a complete config has no fatal key; no `rooms` row, a malformed rooms, or a bad schedule is fatal; a bad `caps` is not (it falls back)", () => {
    expect(parseConfig(seed()).fatal).toEqual([]);
    expect(parseConfig(seed([], ["rooms"])).fatal).toEqual(["rooms"]);
    expect(parseConfig(seed([{ key: "rooms", value: "nope" }], [])).fatal).toEqual(["rooms"]);
    expect(parseConfig([...seed([], ["rooms"]), { key: "rooms", value: [1] }]).fatal).toEqual(["rooms"]);
    expect(parseConfig(seed([], ["schedule"])).fatal).toEqual(["schedule"]);
    expect(parseConfig([...seed([], ["schedule"]), { key: "schedule", value: { clinic: { start: "7:30", end: "21:30" }, ot: {} } }]).fatal).toEqual(["schedule"]);
    expect(parseConfig([...seed([], ["caps"]), { key: "caps", value: { actions_per_room_per_hour: 0 } }])).toMatchObject({ fatal: [], invalid: ["caps"] });
    expect(parseConfig([]).fatal.sort()).toEqual(["rooms", "schedule"]);
  });

  it("source_timeout_ms: absent = default 6000 and not invalid; a number or {ms} within 500..15000 is taken; anything else is invalid and defaults", () => {
    expect(parseConfig(seed())).toMatchObject({ invalid: [], config: { source_timeout_ms: 6000 } });
    expect(parseConfig(seed([{ key: "source_timeout_ms", value: 2500 }])).config.source_timeout_ms).toBe(2500);
    expect(parseConfig(seed([{ key: "source_timeout_ms", value: { ms: 4000 } }])).config.source_timeout_ms).toBe(4000);
    for (const bad of [100, 99_999, "x", null, { ms: "1" }]) {
      const r = parseConfig(seed([{ key: "source_timeout_ms", value: bad }]));
      expect(r.invalid).toEqual(["source_timeout_ms"]);
      expect(r.config.source_timeout_ms).toBe(6000);
    }
  });
});
