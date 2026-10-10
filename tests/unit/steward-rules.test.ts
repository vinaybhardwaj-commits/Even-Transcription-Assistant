/**
 * lib/steward/rules.ts + lib/steward/config.ts — the rule table, one fixture-driven scenario per row. The rules are PURE: a RoomSense, a Config, a clock and the room's
 * recent decisions go in; Decisions come out. Every clock here is an explicit IST instant on 6 Oct 2026 (a Tuesday), never Date.now().
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, NEVER_LIVE_ROOM_IDS, NEVER_ROSTER_ROOM_IDS, actionMode, isNeverLiveRoom, buildRoster, parseConfig, windowAt, type Config } from "@/lib/steward/config";
import { EMPTY_RECENT, chromeGate, decideRoom, failingClass, fleetDecisions, hashFacts, type RecentAction, type RecentContext } from "@/lib/steward/rules";
import { sessionOpenOf, type RoomSense } from "@/lib/steward/sense";
import { ago, failedAttempt, healthy, idle, ist, okAttempt, pendingAttempt, readyRecorder, type DeepPartial } from "../support/steward-fixtures";

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
/** S5: session_died fires on the 2nd consecutive tick: the 1st tick left this "confirming" row 60 s ago (recent() adds more rows after it) */
const confirming = (extra: RecentAction[] = []): RecentContext => recent([row(T, 60, "log_only", { rule: "session_died", params: { state: "confirming" } }), ...extra]);
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

  it("(c) rooms whose id starts with room_scratch_ are dev/test and never join the roster", () => {
    const cfg = parseConfig([{ key: "rooms", value: {} }]).config;
    const r = buildRoster(
      [
        { room_id: "room_scratch_ab12cd", room_name: "Scratch 1", hostname: "scratch-mac" },
        { room_id: "room_scratch_", room_name: "Scratch 2", hostname: null },
        { room_id: "room_real", room_name: "OPD 9", hostname: "HOST-9" },
        { room_id: "room_scratchy", room_name: "Not scratch", hostname: "HOST-S" },
      ],
      cfg,
    );
    expect(r.map((x) => x.room_id).sort()).toEqual(["room_real", "room_scratchy"]);
  });

  it("(d) actionMode: kill switch -> kill_switch; global true -> shadow; a per-action true -> shadow; unknown or not-live-capable names -> shadow; only the rest is live", () => {
    const cfgOf = (kill: boolean, global: boolean, actions: Record<string, boolean>, startLive = true) => ({ ...DEFAULT_CONFIG, kill_switch: kill, start_day_live: startLive, shadow: { global, actions } });
    expect(actionMode(cfgOf(true, false, {}), "scribe_start")).toBe("kill_switch");
    expect(actionMode(cfgOf(false, true, { scribe_start: false }), "scribe_start")).toBe("shadow");
    expect(actionMode(cfgOf(false, false, { scribe_start: true }), "scribe_start")).toBe("shadow");
    expect(actionMode(cfgOf(false, false, { "ticket:wake": true, message: true, scribe_start: false }), "scribe_start")).toBe("live");
    expect(actionMode(cfgOf(false, false, { scribe_start: false }, false), "scribe_start")).toBe("shadow"); // start_day_live off (the default): fail-closed
    expect(actionMode({ ...DEFAULT_CONFIG, kill_switch: false, shadow: { global: false, actions: {} } }, "scribe_start")).toBe("shadow"); // start_day_live defaults off
    expect(DEFAULT_CONFIG.start_day_live).toBe(false);
    expect(actionMode(cfgOf(true, false, {}), "scribe_start")).toBe("kill_switch");
    expect(actionMode(cfgOf(false, false, { "ticket:wake": true }), "ticket:wake")).toBe("shadow");
    expect(actionMode(cfgOf(false, false, {}), "ticket:wake")).toBe("live");
    expect(actionMode(cfgOf(false, false, {}), "ticket:made_up")).toBe("shadow");
    expect(actionMode(cfgOf(false, false, { bogus: false }), "bogus")).toBe("shadow");
    expect(actionMode(cfgOf(false, false, {}), "scribe_stop")).toBe("shadow");
    expect(actionMode(cfgOf(false, false, {}), "scribe_restart")).toBe("shadow");
    // a malformed per-action value parses as shadow (true), never as a lift
    const parsed = parseConfig([{ key: "shadow", value: { global: false, actions: { scribe_start: "no" } } }]);
    expect(parsed.config.shadow.actions.scribe_start).toBe(true);
    expect(parsed.invalid).toContain("shadow");
  });

  it("live_call_timeout_ms: default 5000; a number or {ms} within 1000..8000; malformed = default and named", () => {
    expect(DEFAULT_CONFIG.live_call_timeout_ms).toBe(5000);
    expect(parseConfig([{ key: "live_call_timeout_ms", value: 3000 }]).config.live_call_timeout_ms).toBe(3000);
    expect(parseConfig([{ key: "live_call_timeout_ms", value: { ms: 7000 } }]).config.live_call_timeout_ms).toBe(7000);
    for (const bad of [999, 8001, "5", null, { ms: "x" }]) {
      const r = parseConfig([{ key: "live_call_timeout_ms", value: bad }]);
      expect(r.config.live_call_timeout_ms).toBe(5000);
      expect(r.invalid).toContain("live_call_timeout_ms");
    }
    expect(parseConfig([]).invalid).not.toContain("live_call_timeout_ms");
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

  it("backoff after a FAILED start: 5 min after the 1st, 15 after the 2nd; the countdown lives in inputs, params stay {}", () => {
    const d = first(idle(T, { start_attempts: [failedAttempt(T, 120)] }), T);
    expect(d).toMatchObject({ rule: "not_recording", action: "log_only", params: {}, failing_class: "not_recording" });
    expect(d.inputs).toMatchObject({ retry_after_s: 180, attempts: 1, failing_class: "not_recording" });
    expect(d.why_not).toContain("backoff");
    // 4 min 59 s: still held; 5 min 00 s: go
    expect(first(idle(T, { start_attempts: [failedAttempt(T, 299)] }), T).action).toBe("log_only");
    expect(first(idle(T, { start_attempts: [failedAttempt(T, 300)] }), T).action).toBe("scribe_start");
    // 2nd failed attempt: 15 min
    const two = (sec: number) => idle(T, { start_attempts: [failedAttempt(T, 4000), failedAttempt(T, sec)] });
    expect(first(two(899), T)).toMatchObject({ action: "log_only" });
    expect(first(two(899), T).inputs).toMatchObject({ retry_after_s: 1, attempts: 2 });
    expect(first(two(900), T).action).toBe("scribe_start");
  });

  it("a 4th start is never issued in an IST day: 3 attempts -> start_exhausted (log_only) + a needs-hands message; the old 'tries in the decision log' rule is gone", () => {
    const ds = decideRoom(idle(T, { start_attempts: [failedAttempt(T, 9000), failedAttempt(T, 5000), failedAttempt(T, 3000)] }), DEFAULT_CONFIG, T, EMPTY_RECENT);
    expect(ds.map((d) => [d.rule, d.action])).toEqual([["start_exhausted", "log_only"], ["start_exhausted", "message"]]);
    expect(ds[1]!.params).toMatchObject({ needs_hands: true, kind: "start_exhausted" });
    expect(ds[0]!.failing_class).toBe("not_recording");
    expect(ds[0]!.inputs).toMatchObject({ attempts: 3 });
    // three failed scribe_start ROWS in the decision log no longer matter by themselves
    expect(first(idle(T), T, recent([row(T, 100, "scribe_start", { outcome: "failed" }), row(T, 1000, "scribe_start", { outcome: "failed" }), row(T, 2000, "scribe_start", { outcome: "failed" })])).action).toBe("scribe_start");
    // 2 attempts (the 2nd long past its 15 min wait) still start
    expect(first(idle(T, { start_attempts: [failedAttempt(T, 9000), failedAttempt(T, 3000)] }), T).action).toBe("scribe_start");
  });

  it("a pending / young-acked last attempt holds the next one; a successful attempt (session appeared) does not start a backoff; the start of the day has no history", () => {
    expect(first(idle(T, { start_attempts: [pendingAttempt(T, 60)] }), T)).toMatchObject({ rule: "not_recording", action: "log_only" });
    expect(first(idle(T, { start_attempts: [pendingAttempt(T, 60)] }), T).why_not).toContain("pending");
    expect(first(idle(T, { start_attempts: [okAttempt(T, 60)] }), T).action).toBe("scribe_start");
    expect(first(idle(T, { start_attempts: [] }), T).action).toBe("scribe_start");
  });

  it("device missing (G1): never an attempt, not even the first; ONE alert naming the room and the device per IST day, a waiting_for_mic row every tick; the cap and backoff do not matter", () => {
    const missing = (over: DeepPartial<RoomSense> = {}) =>
      idle(T, { room_name: "Cardiology", audio: { default_input_present: false, devices_at: ago(T, 600), configured_device: "TONOR TM20 Audio Device" }, ...over });
    for (const attempts of [[], [failedAttempt(T, 3000)], [failedAttempt(T, 9000), failedAttempt(T, 5000), failedAttempt(T, 3000)], [failedAttempt(T, 30)]]) {
      const ds = decideRoom(missing({ start_attempts: attempts }), DEFAULT_CONFIG, T, EMPTY_RECENT);
      expect(ds[0], `${attempts.length} attempts`).toMatchObject({ rule: "waiting_for_mic", action: "log_only", params: { mic_ticks: 0 } });
      expect(ds.some((x) => x.action === "scribe_start")).toBe(false);
      expect(ds[1]).toMatchObject({ rule: "device_missing", action: "alert", severity: "error" });
      expect(ds[1]!.params).toEqual({ room_id: "room_a", room: "Cardiology", device: "TONOR TM20 Audio Device" });
      expect(ds[1]!.why).toContain("TONOR TM20 Audio Device");
    }
    // the alert is once per IST day: with today's alert row in memory only the waiting row is written
    const alertRow: RecentAction = { ts: new Date(T - 3600_000).toISOString(), rule: "device_missing", action: "alert", params: {}, outcome: "shadow" };
    expect(decideRoom(missing(), DEFAULT_CONFIG, T, recent([alertRow])).map((x) => x.rule)).toEqual(["waiting_for_mic"]);
    // yesterday's alert does not count
    const yesterday: RecentAction = { ...alertRow, ts: new Date(T - 26 * 3600_000).toISOString() };
    expect(decideRoom(missing(), DEFAULT_CONFIG, T, recent([yesterday])).some((x) => x.action === "alert")).toBe(true);
    // the two EVIDENCE signals: a default-input-absent audio.devices row <= 6 h old, a USB removal with no usb_added since
    for (const audio of [{ default_input_present: true, usb_removed_recent: true }, { default_input_present: false, devices_at: ago(T, 6 * 3600) }]) {
      const ds = decideRoom(idle(T, { audio: { ...audio, configured_device: null, default_input_name: "USB Mic" }, start_attempts: [failedAttempt(T, 3000)] }), DEFAULT_CONFIG, T, EMPTY_RECENT);
      expect(ds[1]!.params).toMatchObject({ device: "USB Mic" });
    }
    expect(decideRoom(idle(T, { audio: { default_input_present: false, devices_at: ago(T, 60) }, start_attempts: [failedAttempt(T, 3000)] }), DEFAULT_CONFIG, T, EMPTY_RECENT)[1]!.params).toMatchObject({ device: "input device (name not reported)" });
    // no episode in memory and the device present: a normal start (nothing to wait for)
    expect(first(idle(T, { start_attempts: [failedAttempt(T, 3000)] }), T).action).toBe("scribe_start");
  });

  it("G1 evidence (10 Oct): for the START gate an 'absent' audio row counts at ANY age (14 h, no devices_at), as does the install DEVICE_MISSING flag; a later present row or no signal does not hold", () => {
    const tried = [failedAttempt(T, 3000)];
    const hold = (a: DeepPartial<RoomSense["audio"]>) => first(idle(T, { audio: a, start_attempts: tried }), T);
    // absent row 14 h old, nothing newer (the newest audio.devices row IS the newest word): waiting_for_mic, never a start
    expect(hold({ default_input_present: false, devices_at: ago(T, 14 * 3600) })).toMatchObject({ rule: "waiting_for_mic", action: "log_only", params: { mic_ticks: 0 } });
    expect(hold({ default_input_present: false, devices_at: ago(T, 6 * 3600 + 1) })).toMatchObject({ rule: "waiting_for_mic" });
    expect(hold({ default_input_present: false })).toMatchObject({ rule: "waiting_for_mic" });
    // the absent row followed by a later add: the newest row says present -> no hold (the start schedule goes on)
    expect(hold({ default_input_present: true, devices_at: ago(T, 600) })).toMatchObject({ rule: "not_recording", action: "scribe_start" });
    // install DEVICE_MISSING flag (chosen device not enumerated) holds, alone
    expect(hold({ default_input_present: true, device_missing_flag: true })).toMatchObject({ rule: "waiting_for_mic", action: "log_only" });
    expect(hold({ default_input_present: null, device_missing_flag: true })).toMatchObject({ rule: "waiting_for_mic" });
    // a USB removal with no usb_added since is evidence as before
    expect(hold({ usb_removed_recent: true })).toMatchObject({ rule: "waiting_for_mic" });
    // no signal at all (no row, no flag): nothing to hold on
    expect(hold({ default_input_present: null, device_missing_flag: false })).toMatchObject({ action: "scribe_start" });
    // and the flag clears: present row, no flag -> the 2-tick return starts
    const A = T + 60_000;
    const mem = recent([{ ts: new Date(T).toISOString(), rule: "waiting_for_mic", action: "log_only", params: { mic_ticks: 0 }, outcome: null }]);
    expect(first(idle(A, { audio: { default_input_present: true, device_missing_flag: false }, start_attempts: tried }), A, mem)).toMatchObject({ rule: "waiting_for_mic", params: { mic_ticks: 1 } });
  });

  it("G1 evidence: recording-path behaviour unchanged — mic_fault and deviceMissing's 6 h rule are not touched (a 14 h old absent row with a consult open is still the same mic_fault; the 6 h limit still applies to the annotation)", () => {
    const mic = healthy(T, { consult_open: true, consult_started_at: ago(T, 300), audio: { default_input_present: false, devices_at: ago(T, 14 * 3600) } });
    expect(decideRoom(mic, DEFAULT_CONFIG, T, EMPTY_RECENT)[0]).toMatchObject({ rule: "mic_fault", action: "message" });
    // a healthy recording room with an old absent row and no consult: no new decision from the G1 evidence
    const quiet = healthy(T, { audio: { default_input_present: false, devices_at: ago(T, 14 * 3600) } });
    expect(decideRoom(quiet, DEFAULT_CONFIG, T, EMPTY_RECENT).map((d) => d.rule)).not.toContain("waiting_for_mic");
  });

  it("F18: recorder.status session_open is the daemon's \"yes\" / \"no\" / \"unknown\": no = closed, yes = open, unknown = null (NOT closed); booleans and the legacy true/false strings are accepted too", () => {
    for (const [v, want] of [["no", false], ["yes", true], ["unknown", null], [false, false], [true, true], ["false", false], ["true", true], [null, null], [undefined, null], ["", null], ["maybe", null]] as const) expect(sessionOpenOf(v), String(v)).toBe(want);
  });

  it("F1 (FLEET refuter): the literal live clamp IST [07:30, 21:30) sits on top of the configured window: an OT-class room (window 06:00-04:00) at 06:15 and 02:00 refuses; 07:30:00 and 21:29:59 pass, 21:30:00 refuses", () => {
    const ot = (A: number) => idle(A, { klass: "ot", kind: "ot", reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, 600) } });
    for (const [label, t, fail] of [
      ["06:15", ist("06:15"), "outside_live_clamp"],
      ["02:00", ist("02:00", "2026-10-07"), "outside_live_clamp"],
      ["07:29:59", ist("07:29", "2026-10-06", "59"), "outside_live_clamp"],
      ["07:30:00", ist("07:30"), null],
      ["21:29:59", ist("21:29", "2026-10-06", "59"), null],
      ["21:30:00", ist("21:30"), "outside_live_clamp"],
    ] as const) {
      const d = first(ot(t), t);
      expect(d, label).toMatchObject({ action: "scribe_start", inputs: { live_clamp: "ist_0730_2130", start_gate_fail: fail } });
    }
    expect(first(ot(ist("06:15")), ist("06:15")).inputs).toMatchObject({ start_gates: { in_window: true, in_live_clamp: false } });
    // a clinic room keeps its own window: 07:29:59 never reaches the gates (outside_window, no start decision)
    expect(first(idle(ist("07:29", "2026-10-06", "59")), ist("07:29", "2026-10-06", "59")).action).toBe("none");
  });

  it("F2 (G1): ONE device_missing alert per IST day: alert, then waiting rows only; the device seen again closes the episode row; 2 present ticks before any start; a new disappearance the same day does not alert again", () => {
    const tried = [failedAttempt(T, 3000)];
    const gone = (A: number) => idle(A, { room_name: "Cardiology", audio: { default_input_present: false, devices_at: ago(A, 600), configured_device: "TONOR TM20" }, start_attempts: tried, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, 600) } });
    const back = (A: number) => idle(A, { room_name: "Cardiology", audio: { default_input_present: true, devices_at: ago(A, 30) }, start_attempts: tried, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, 600) } });
    const row = (ts: number, rule: string, action: string, params: Record<string, unknown>): RecentAction => ({ ts: new Date(ts).toISOString(), rule, action, params, outcome: action === "alert" ? "shadow" : null });
    const alertRow = row(T, "device_missing", "alert", {});
    // first tick of the episode: the waiting row and the alert
    const d0 = decideRoom(gone(T), DEFAULT_CONFIG, T, EMPTY_RECENT);
    expect(d0.map((x) => x.rule)).toEqual(["waiting_for_mic", "device_missing"]);
    // later ticks: the waiting row only, never a start
    for (const m of [1, 20, 90, 600]) {
      const A = T + m * 60_000;
      const ds = decideRoom(gone(A), DEFAULT_CONFIG, A, recent([alertRow, row(T, "waiting_for_mic", "log_only", { mic_ticks: 0 })]));
      expect(ds.map((x) => x.rule), `+${m}`).toEqual(["waiting_for_mic"]);
    }
    // tick 1 of the return: only the marker (mic_ticks 1), plus the one closing row
    const A1 = T + 120 * 60_000;
    const mem1 = recent([alertRow, row(T, "waiting_for_mic", "log_only", { mic_ticks: 0 })]);
    const t1 = decideRoom(back(A1), DEFAULT_CONFIG, A1, mem1);
    expect(t1[0]).toMatchObject({ rule: "waiting_for_mic", action: "log_only", params: { mic_ticks: 1 } });
    expect(t1.some((x) => x.action === "scribe_start")).toBe(false);
    expect(t1.find((x) => x.rule === "device_missing")).toMatchObject({ action: "log_only", params: { state: "back" } });
    // tick 2: the normal start decision, tagged as a mic return
    const A2 = A1 + 60_000;
    const mem2 = recent([row(A1, "waiting_for_mic", "log_only", { mic_ticks: 1 }), alertRow, row(T, "waiting_for_mic", "log_only", { mic_ticks: 0 })]);
    const t2 = decideRoom(back(A2), DEFAULT_CONFIG, A2, mem2);
    expect(t2[0]).toMatchObject({ action: "scribe_start" });
    expect(t2[0]!.inputs).toMatchObject({ mic_return: true });
    // a flap between the ticks resets the count: missing again, then present once = marker again, not a start
    const A3 = A2 + 60_000;
    const mem3 = recent([row(A2, "waiting_for_mic", "log_only", { mic_ticks: 0 }), row(A1, "waiting_for_mic", "log_only", { mic_ticks: 1 }), alertRow]);
    expect(decideRoom(back(A3), DEFAULT_CONFIG, A3, mem3)[0]).toMatchObject({ rule: "waiting_for_mic", params: { mic_ticks: 1 } });
    // a second disappearance the same IST day: waiting row, no second alert
    expect(decideRoom(gone(A3), DEFAULT_CONFIG, A3, mem3).map((x) => x.rule)).toEqual(["waiting_for_mic"]);
    // an open episode survives a stale / unknown reading: the device is not "present" unless a row says so
    const unknown = idle(A3, { audio: { default_input_present: null }, start_attempts: tried });
    expect(decideRoom(unknown, DEFAULT_CONFIG, A3, mem1)[0]).toMatchObject({ rule: "waiting_for_mic", params: { mic_ticks: 0 } });
  });

  it("G1 mic return (fix-up 2): NO waiver — with the marker present the normal recorder_ready (5 min, 2 samples) still holds the start; every other gate applies as before", () => {
    const A = T + 5 * 60_000;
    const mem = recent([{ ts: new Date(A - 60_000).toISOString(), rule: "waiting_for_mic", action: "log_only", params: { mic_ticks: 1 }, outcome: null }]);
    const under = { latest_at: ago(A, 20), latest_state: "ready", latest_session_open: "no", ready_since: ago(A, 40), ready_samples: 2 };
    const mk = (over: DeepPartial<RoomSense>) => idle(A, { audio: { default_input_present: true }, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: under }, ...over });
    const held = first(mk({}), A, mem);
    expect(held).toMatchObject({ action: "scribe_start" });
    expect(held.inputs).toMatchObject({ mic_return: true, start_gate_fail: "recorder_ready_under_5m" });
    // a full 5-min streak starts like any other start
    const full = { ...under, ready_since: ago(A, 360), ready_samples: 6 };
    expect(first(mk({ recording: { recorder_history: full } }), A, mem).inputs).toMatchObject({ mic_return: true, start_gate_fail: null });
    // the same state without a waiting episode: the streak applies
    expect(first(mk({}), A).inputs).toMatchObject({ start_gate_fail: "recorder_ready_under_5m" });
    // stale recorder row, stale kiosk-health: still held
    expect(first(mk({ recording: { recorder_history: { ...under, latest_at: ago(A, 600) } } }), A, mem).inputs).toMatchObject({ start_gate_fail: "recorder_ready_under_5m" });
    expect(first(mk({ reachable: { kh_heartbeat_at: ago(A, 600) } }), A, mem).inputs).toMatchObject({ start_gate_fail: "kh_heartbeat_stale" });
    // 21:31 IST: outside the live clamp
    const L = ist("21:31");
    const memL = recent([{ ts: new Date(L - 60_000).toISOString(), rule: "waiting_for_mic", action: "log_only", params: { mic_ticks: 1 }, outcome: null }]);
    const late = decideRoom(idle(L, { audio: { default_input_present: true }, reachable: { kh_heartbeat_at: ago(L, 30) }, recording: { recorder_history: { ...under, latest_at: ago(L, 20) } } }), DEFAULT_CONFIG, L, memL);
    expect(late.some((x) => x.action === "scribe_start" && x.inputs.start_gate_fail === null)).toBe(false);
  });

  it("G2 / G3 / G4: an operator end_day after 20:00 IST closes the day; no start from 20:30 IST once the room had a session; an unreadable day state holds; a quiet room may still start", () => {
    const run = (hhmm: string, day: RoomSense["day"]) => {
      const A = ist(hhmm);
      return decideRoom({ ...idle(A, { reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, 600) } }), day }, DEFAULT_CONFIG, A, EMPTY_RECENT)[0]!;
    };
    const ended = { operator_end_at: new Date(ist("21:09")).toISOString(), session_today: true };
    expect(run("21:14", ended)).toMatchObject({ rule: "start_gate_hold", action: "log_only", params: { reason: "day_ended_by_operator" } });
    expect(run("20:10", { operator_end_at: new Date(ist("20:05")).toISOString(), session_today: true })).toMatchObject({ params: { reason: "day_ended_by_operator" } });
    expect(run("20:31", { operator_end_at: null, session_today: true })).toMatchObject({ params: { reason: "late_start_blocked" } });
    expect(run("20:29", { operator_end_at: null, session_today: true })).toMatchObject({ action: "scribe_start" });
    expect(run("20:31", { operator_end_at: null, session_today: false })).toMatchObject({ action: "scribe_start" });
    expect(run("20:31", { operator_end_at: new Date(ist("20:20")).toISOString(), session_today: false })).toMatchObject({ params: { reason: "day_ended_by_operator" } });
    expect(run("20:31", null)).toMatchObject({ rule: "start_gate_hold", params: { reason: "day_state_unreadable" } });
    expect(run("20:05", undefined)).toMatchObject({ params: { reason: "day_state_unreadable" } });
    // before 20:00 the day state is not needed and an operator end_day of the afternoon is not a gate
    expect(run("19:59", undefined)).toMatchObject({ action: "scribe_start" });
    expect(run("14:00", { operator_end_at: new Date(ist("13:50")).toISOString(), session_today: true })).toMatchObject({ action: "scribe_start" });
  });

  it("F20: the hard never-live list: ORB2, ORB3, Home Office and room_scratch_* fail the room_eligible gate whatever the data (every other gate green)", () => {
    const green = (room_id: string) => idle(T, { room_id, reachable: { kh_heartbeat_at: ago(T, 30) }, recording: { recorder_history: readyRecorder(T, 600) } });
    expect(NEVER_LIVE_ROOM_IDS).toEqual(["room_mah3aspr", "room_jwyrr4dc", "room_2qe955hy"]);
    for (const id of ["room_mah3aspr", "room_jwyrr4dc", "room_2qe955hy", "room_scratch_x1"]) {
      expect(isNeverLiveRoom(id), id).toBe(true);
      expect(first(green(id), T).inputs, id).toMatchObject({ start_gate_fail: "never_live_room", start_gates: { room_eligible: false } });
    }
    expect(isNeverLiveRoom("room_scratchy")).toBe(false);
    expect(isNeverLiveRoom(null)).toBe(false);
    expect(first(green("room_real"), T).inputs).toMatchObject({ start_gate_fail: null, start_gates: { room_eligible: true } });
    // ORB2 with no kiosk-health keeps the more specific reason
    expect(first(idle(T, { room_id: "room_mah3aspr", reachable: { kh_heartbeat_at: null, kh_enrolled: false }, recording: { recorder_history: null } }), T).inputs).toMatchObject({ start_gate_fail: "no_kiosk_health" });
  });

  it("the live-start gates are recorded in inputs on every scribe_start: heartbeat <= 180 s, recorder ready + no session held >= 300 s from the history; the first failing gate is named", () => {
    const ready = (sec: number) => idle(T, { reachable: { kh_heartbeat_at: ago(T, 60) }, recording: { recorder_history: readyRecorder(T, sec) } });
    const pass = first(ready(400), T);
    expect(pass.inputs).toMatchObject({ start_gate_fail: null, recorder_ready_for_s: 400, kh_heartbeat_s: 60, start_gates: { in_window: true, room_eligible: true, no_open_session: true, kiosk_health_fresh: true, recorder_ready: true } });
    // recorder ready for 4:59 no, 5:00 yes
    expect(first(ready(299), T).inputs).toMatchObject({ start_gate_fail: "recorder_ready_under_5m", start_gates: { recorder_ready: false } });
    expect(first(ready(300), T).inputs).toMatchObject({ start_gate_fail: null });
    // heartbeat: 180 s ok, 181 s stale
    const hb = (sec: number) => idle(T, { reachable: { poller_ok_at: ago(T, 30), kh_heartbeat_at: ago(T, sec) }, recording: { recorder_history: readyRecorder(T, 400) } });
    expect(first(hb(170), T).inputs).toMatchObject({ start_gate_fail: null, kh_heartbeat_s: 170 });
    expect(first(hb(181), T).inputs).toMatchObject({ start_gate_fail: "kh_heartbeat_stale", start_gates: { kiosk_health_fresh: false } });
    // the ready streak needs >= 2 rows and a newest row <= 7 min old
    const one = idle(T, { recording: { recorder_history: { ...readyRecorder(T, 400), ready_samples: 1 } } });
    expect(first(one, T).inputs).toMatchObject({ start_gate_fail: "recorder_ready_under_5m", recorder_ready_for_s: null });
    const stale = idle(T, { recording: { recorder_history: { ...readyRecorder(T, 900), latest_at: ago(T, 421) } } });
    expect(first(stale, T).inputs).toMatchObject({ start_gate_fail: "recorder_ready_under_5m", recorder_ready_for_s: null });
    // the newest row is not ready (recording / session open): recorder_not_ready
    const notReady = idle(T, { recording: { recorder_history: { latest_at: ago(T, 20), latest_state: "recording", latest_session_open: "yes", ready_since: null, ready_samples: 0 } } });
    expect(first(notReady, T).inputs).toMatchObject({ start_gate_fail: "recorder_not_ready" });
  });

  it("a room with no kiosk-health at all (ORB2) can never pass the gates: no_kiosk_health", () => {
    const orb2 = idle(T, { reachable: { kh_heartbeat_at: null, kh_enrolled: false }, recording: { recorder_history: null } });
    const d = first(orb2, T);
    expect(d).toMatchObject({ action: "scribe_start" });
    expect(d.inputs).toMatchObject({ start_gate_fail: "no_kiosk_health", start_gates: { kiosk_health_fresh: false, recorder_ready: false } });
  });

  // ---- adopted from FLEET's withdrawn builder (BUILDER-REPORT-STARTDAY.md) ----
  it("[FLEET] hard never-start list: ORB3 (room_jwyrr4dc) and Home Office (room_2qe955hy) never join the roster, whatever their hostname", () => {
    expect(NEVER_ROSTER_ROOM_IDS).toEqual(["room_jwyrr4dc", "room_2qe955hy"]);
    const cfg = parseConfig([{ key: "rooms", value: {} }]).config;
    const r = buildRoster([{ room_id: "room_jwyrr4dc", room_name: "ORB3", hostname: "ORBOX3" }, { room_id: "room_2qe955hy", room_name: "Home Office", hostname: "Vinays-Mac-mini" }, { room_id: "room_ok", room_name: "OPD 1", hostname: "H1" }], cfg);
    expect(r.map((x) => x.room_id)).toEqual(["room_ok"]);
  });

  it("[FLEET] window edges through decideRoom with every gate otherwise green: 07:29:59 and 21:30:00 are outside (no start), 07:30:00 and 21:29:59 start", () => {
    const green = (A: number) => idle(A, { reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, 600) } });
    for (const [t, expectStart] of [[ist("07:29", "2026-10-06", "59"), false], [ist("07:30"), true], [ist("21:29", "2026-10-06", "59"), true], [ist("21:30"), false]] as const) {
      const d = first(green(t), t);
      if (expectStart) expect(d).toMatchObject({ action: "scribe_start", inputs: { start_gate_fail: null, start_gates: { in_window: true } } });
      else expect(d.action).not.toBe("scribe_start");
    }
  });

  it("[FLEET] the heartbeat boundary is inclusive (exactly 180 s passes), and the newest recorder.status row may be exactly 7 min old (420 s passes, 421 s does not)", () => {
    const hb = idle(T, { reachable: { poller_ok_at: ago(T, 30), kh_heartbeat_at: ago(T, 180) }, recording: { recorder_history: readyRecorder(T, 600) } });
    expect(first(hb, T).inputs).toMatchObject({ start_gate_fail: null, kh_heartbeat_s: 180 });
    const edge = idle(T, { recording: { recorder_history: { ...readyRecorder(T, 900), latest_at: ago(T, 420) } } });
    expect(first(edge, T).inputs).toMatchObject({ start_gate_fail: null });
  });

  it("[FLEET] a gated start row does not suppress the attempt: the same (rule, action, params) is produced every tick; the gate result lives in inputs only (the loop test covers the dedupe bypass)", () => {
    const a = first(idle(T, { reachable: { kh_heartbeat_at: ago(T, 300) } }), T);
    const b = first(idle(T + 60_000, { reachable: { kh_heartbeat_at: ago(T + 60_000, 30) }, recording: { recorder_history: readyRecorder(T + 60_000, 600) } }), T + 60_000);
    expect([a.rule, a.action, a.params]).toEqual([b.rule, b.action, b.params]);
    expect(a.inputs).toMatchObject({ start_gate_fail: expect.any(String) });
    expect(b.inputs).toMatchObject({ start_gate_fail: null });
  });

  it("a paused (consent) room is never started; unreadable start history holds the start", () => {
    const d = first(idle(T, { listener: { listening: true, paused: true } }), T);
    expect(d).toMatchObject({ action: "log_only" });
    expect(d.why_not).toContain("paused");
    const e = first(idle(T, { start_attempts: null }), T);
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
    expect(first(died(), T, confirming())).toMatchObject({ rule: "session_died", action: "scribe_restart", severity: "error" });
  });

  it("no chunk for 12 min but the recorder is fresh and says a session is open = upload lag, not a death", () => {
    const s = healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 20) } } });
    expect(first(s, T)).toMatchObject({ rule: "ok", action: "none" });
  });

  it("recorder says session_open=false with a fresh status and no chunk for 12 min -> scribe_restart", () => {
    const s = healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "idle", session_open: false, received_at: ago(T, 20) } } });
    expect(first(s, T, confirming()).action).toBe("scribe_restart");
  });

  it("a session that started 2 min ago has no chunk yet and is not dead; a paused session is not dead", () => {
    const young = healthy(T, { recording: { last_chunk_at: null, session_started_at: ago(T, 120), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 300) } } });
    expect(first(young, T).rule).toBe("ok");
    const paused = healthy(T, { recording: { session_status: "paused", last_chunk_at: ago(T, 3000), recorder_status: { state: "paused", session_open: true, received_at: ago(T, 300) } } });
    expect(first(paused, T).rule).toBe("ok");
  });

  it("ladder: restart sent 2 min ago -> wait; 7 min ago and the recorder says no session -> ticket restart_recorder_app", () => {
    const wait = first(died(), T, confirming([row(T, 120, "scribe_restart")]));
    expect(wait).toMatchObject({ rule: "session_died", action: "log_only" });
    expect(wait.why_not).toContain("restart");
    const closed = healthy(T, { recording: { last_chunk_at: ago(T, 900), recorder_status: { state: "idle", session_open: false, received_at: ago(T, 20) } } });
    expect(first(closed, T, confirming([row(T, 420, "scribe_restart")]))).toMatchObject({ rule: "session_died", action: "ticket:restart_recorder_app", params: {} });
  });

  it("ladder: no ticket while a session is not confirmed closed; then the message; and after the app restart the message", () => {
    const m = first(died(), T, confirming([row(T, 420, "scribe_restart")]));
    expect(m).toMatchObject({ rule: "session_died", action: "message" });
    expect(m.params.needs_hands).toBe(true);
    expect(m.why_not).toContain("not confirmed");
    const closed = healthy(T, { recording: { last_chunk_at: ago(T, 900), recorder_status: { state: "idle", session_open: false, received_at: ago(T, 20) } } });
    const m2 = first(closed, T, confirming([row(T, 800, "scribe_restart"), row(T, 420, "ticket:restart_recorder_app")]));
    expect(m2).toMatchObject({ action: "message" });
    expect(m2.why_not).toContain("already tried");
  });

  it("F5: with kiosk-health down (heartbeat 8 min old) and no chunk for 12 min the session is still dead: scribe_restart with inputs.recorder_stale = 'unknown' (not forced false)", () => {
    const s = died({ reachable: { kh_heartbeat_at: ago(T, 480) } });
    const d = first(s, T, confirming());
    expect(d).toMatchObject({ rule: "session_died", action: "scribe_restart", failing_class: "session_died" });
    expect(d.inputs.recorder_stale).toBe("unknown");
  });

  it("F5: a room with no kiosk-health at all (not enrolled / no snapshot) and a session open with no chunk for 12 min -> session_died; with a fresh chunk it is fine", () => {
    const noKh = (chunk: number) => healthy(T, { recording: { last_chunk_at: ago(T, chunk), recorder_status: null }, reachable: { kh_heartbeat_at: null, kh_enrolled: false } });
    const d = first(noKh(720), T, confirming());
    expect(d).toMatchObject({ rule: "session_died", action: "scribe_restart" });
    expect(d.inputs.recorder_stale).toBe("unknown");
    expect(first(noKh(60), T).rule).toBe("ok");
    // a known-fresh recorder keeps recorder_stale false
    expect(first(died(), T, confirming()).inputs.recorder_stale).toBe(true);
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

  it("overnight sleep: the machine slept at 23:10, nothing since, tick at 07:31 -> ticket:wake (not sense_degraded); the 2 h rule still holds for a room with no sleep marker", () => {
    const b = ist("07:31");
    const slept = ist("23:10", "2026-10-05");
    const quiet = { poller_ok_at: ago(b, (b - slept) / 1000), kh_heartbeat_at: ago(b, (b - slept) / 1000), kh_enrolled: true };
    const d = first(idle(b, { reachable: { ...quiet, sleep_at: new Date(slept).toISOString() } }), b);
    expect(d).toMatchObject({ rule: "kiosk_asleep", action: "ticket:wake" });
    expect(d.inputs.sleep_marker_at).toBe(new Date(slept).toISOString());
    expect(d.failing_class ?? null).toBeNull(); // slept overnight, not awake today: never a fleet signal
    // the same silence without a marker is still sense_degraded
    expect(first(idle(b, { reachable: { ...quiet, sleep_at: null } }), b)).toMatchObject({ rule: "sense_degraded", action: "log_only" });
    // a sleep marker never overrides a poller that sees the Mac, nor a recording room
    expect(first(idle(b, { reachable: { ...quiet, poller_ok_at: ago(b, 30), sleep_at: new Date(slept).toISOString() } }), b).rule).not.toBe("kiosk_asleep");
    expect(first(healthy(b, { reachable: { ...quiet, sleep_at: new Date(slept).toISOString() } }), b).rule).not.toBe("kiosk_asleep");
    // sleeping more than 10 min with nothing heard: wake + message
    expect(decideRoom(idle(b, { reachable: { ...quiet, sleep_at: new Date(slept).toISOString() } }), DEFAULT_CONFIG, b, EMPTY_RECENT).map((x) => x.action)).toEqual(["ticket:wake", "message"]);
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
describe("audio.devices is event-driven", () => {
  it("a room with no audio.devices rows in 24 h and everything else healthy -> rule ok; audio_devices is never in inputs.missing; the age is null", () => {
    const d = first(healthy(T, { audio: { default_input_present: null, devices_at: null } }), T);
    expect(d).toMatchObject({ rule: "ok", action: "none" });
    expect(d.inputs.missing).not.toContain("audio_devices");
    expect(d.inputs.audio_devices_age_s).toBeNull();
  });

  it("the age of the latest audio.devices row is recorded for visibility and never degrades the room, however old", () => {
    const d = first(healthy(T, { audio: { default_input_present: true, devices_at: ago(T, 20 * 3600) } }), T);
    expect(d).toMatchObject({ rule: "ok", action: "none" });
    expect(d.inputs.audio_devices_age_s).toBe(20 * 3600);
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
    expect(failingClass(decideRoom(idle(T, { start_attempts: [failedAttempt(T, 120)] }), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBe("not_recording");
    expect(failingClass(decideRoom(idle(T, { start_attempts: [failedAttempt(T, 9000), failedAttempt(T, 5000), failedAttempt(T, 3000)] }), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBe("not_recording");
  });

  it("failingClass keeps a held or gated room in its class", () => {
    const failedStart = idle(T, { start_attempts: [failedAttempt(T, 120)] });
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

  it("actions_per_room_per_hour: the 4th EXECUTED action in the hour is logged, not taken; shadow / kill_switch / skipped rows never count", () => {
    const asleep = idle(T, { reachable: { poller_ok_at: ago(T, 240), kh_heartbeat_at: ago(T, 240) } });
    const ex = { outcome: "ok" as const };
    const four = recent([row(T, 100, "ticket:wake", ex), row(T, 700, "scribe_restart", { outcome: "failed" }), row(T, 1400, "ticket:wake", ex), row(T, 2100, "ticket:wake", ex)]);
    const shadowFour = recent([row(T, 100, "ticket:wake"), row(T, 700, "scribe_restart"), row(T, 1400, "ticket:wake", { outcome: null }), row(T, 2100, "ticket:wake")]);
    expect(first(asleep, T, shadowFour).action).toBe("ticket:wake");
    const d = first(asleep, T, four);
    expect(d).toMatchObject({ rule: "cap_reached", action: "log_only", params: { wanted: "ticket:wake" } });
    expect(d.why_not).toContain("actions_per_room_per_hour=4");
    expect(first(asleep, T, recent([row(T, 100, "ticket:wake", ex), row(T, 700, "scribe_restart", ex), row(T, 1400, "ticket:wake", ex)])).action).toBe("ticket:wake");
    // messages do not count against the cap
    expect(first(asleep, T, recent([row(T, 100, "message", ex), row(T, 200, "message", ex), row(T, 300, "message", ex), row(T, 400, "message", ex)])).action).toBe("ticket:wake");
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

  it("a start backoff counting down 240 s -> 180 s has identical params; the countdown is in inputs", () => {
    const att = [failedAttempt(T, 60)];
    const a = decideRoom(idle(T, { start_attempts: att }), DEFAULT_CONFIG, T, EMPTY_RECENT);
    const b = decideRoom(idle(T + 60_000, { start_attempts: att }), DEFAULT_CONFIG, T + 60_000, EMPTY_RECENT);
    expect(p(a)).toBe(p(b));
    expect(a[0]!.inputs.retry_after_s).toBe(240);
    expect(b[0]!.inputs.retry_after_s).toBe(180);
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

  it("start_exhausted with 3 vs 4 attempts today, and action_failing with 3 vs 4 failures, have identical params", () => {
    const f3 = [failedAttempt(T, 9000), failedAttempt(T, 5000), failedAttempt(T, 3000)];
    const f4 = [...f3, failedAttempt(T, 2500)];
    expect(p(decideRoom(idle(T, { start_attempts: f3 }), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBe(p(decideRoom(idle(T, { start_attempts: f4 }), DEFAULT_CONFIG, T, EMPTY_RECENT)));
    const asleep = idle(T, { reachable: { poller_ok_at: ago(T, 240), kh_heartbeat_at: ago(T, 240) } });
    const f = (s: number) => row(T, s, "ticket:wake", { outcome: "failed" });
    expect(p(decideRoom(asleep, DEFAULT_CONFIG, T, recent([f(100), f(900), f(1800)])))).toBe(p(decideRoom(asleep, DEFAULT_CONFIG, T, recent([f(100), f(900), f(1200), f(1800)]))));
  });

  it("no decision any rule emits carries a number-bearing countdown in params: every params value is a string, boolean or a fixed enum", () => {
    const scenarios: Array<[RoomSense, RecentContext]> = [
      [idle(T, { start_attempts: [failedAttempt(T, 120)] }), EMPTY_RECENT],
      [idle(T, { start_attempts: [failedAttempt(T, 9000), failedAttempt(T, 5000), failedAttempt(T, 3000)] }), EMPTY_RECENT],
      [idle(T, { audio: { default_input_present: false, configured_device: "Mic" }, start_attempts: [failedAttempt(T, 3000)] }), EMPTY_RECENT],
      [idle(T, { reachable: { poller_ok_at: ago(T, 700), kh_heartbeat_at: ago(T, 700) } }), EMPTY_RECENT],
      [healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 300) } } }), recent([row(T, 420, "scribe_restart")])],
      [healthy(T, { reachable: { kh_heartbeat_at: ago(T, 660) } }), EMPTY_RECENT],
      [healthy(T, { consult_open: true, consult_started_at: ago(T, 300), audio: { default_input_present: false } }), EMPTY_RECENT],
    ];
    for (const [s, r] of scenarios) {
      for (const d of decideRoom(s, DEFAULT_CONFIG, T, r)) {
        // waiting_for_mic.mic_ticks is the episode marker (0 = missing, 1 = back), a fixed enum that cannot count up
        for (const [k, v] of Object.entries(d.params)) expect(typeof v === "number" && !(d.rule === "waiting_for_mic" && k === "mic_ticks") ? `${d.rule}.${k} is a number` : "ok").toBe("ok");
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
    expect(failingClass(decideRoom(died, DEFAULT_CONFIG, T, confirming()))).toBe("session_died");
    const mic = healthy(T, { consult_open: true, consult_started_at: ago(T, 300), audio: { default_input_present: false } });
    expect(failingClass(decideRoom(mic, DEFAULT_CONFIG, T, EMPTY_RECENT))).toBe("mic_fault");
    expect(failingClass(decideRoom(healthy(T), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBeNull();
    expect(failingClass(decideRoom(idle(T, { listener: { listening: true, paused: true } }), DEFAULT_CONFIG, T, EMPTY_RECENT))).toBeNull();
  });

  it("a cap-reached or action_failing replacement keeps the class of the decision it replaced; the class is also written to inputs.failing_class", () => {
    const died = healthy(T, { recording: { last_chunk_at: ago(T, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(T, 300) } } });
    const four = confirming([row(T, 100, "ticket:wake", { outcome: "ok" }), row(T, 700, "ticket:wake", { outcome: "ok" }), row(T, 1400, "ticket:wake", { outcome: "ok" }), row(T, 2100, "ticket:wake", { outcome: "ok" })]);
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

describe("(b) one inputs builder: every row of every rule carries the reachability evidence", () => {
  it("a scribe_start decision for a kiosk-enrolled room carries numeric kh_heartbeat_s and poller_ok_s (and last_chunk_s, ext_status, occupancy, sleep_marker)", () => {
    const s = idle(T);
    s.recording.last_chunk_24h_at = ago(T, 3000);
    const d = first(s, T);
    expect(d).toMatchObject({ action: "scribe_start" });
    expect(d.inputs).toMatchObject({ kh_heartbeat_s: 30, poller_ok_s: 30, last_chunk_s: 3000, ext_status: "ok", occupancy: "nobody", sleep_marker: false });
    expect(typeof d.inputs.kh_heartbeat_s).toBe("number");
    expect(typeof d.inputs.poller_ok_s).toBe("number");
  });

  it("the keys are present on EVERY decision of a spread of rules and guards; sleep_marker is a bool; last_chunk_s is null only with no chunk at all", () => {
    const sleeping = idle(T, { reachable: { poller_ok_at: ago(T, 400), kh_heartbeat_at: ago(T, 400), sleep_at: ago(T, 500) } });
    const cases: Array<ReturnType<typeof decideRoom>> = [
      decideRoom(sleeping, DEFAULT_CONFIG, T),
      decideRoom(healthy(T), DEFAULT_CONFIG, T),
      decideRoom(idle(T, { listener: { paused: true } }), DEFAULT_CONFIG, T),
      decideRoom(idle(T, { start_attempts: [failedAttempt(T, 120)] }), DEFAULT_CONFIG, T),
      decideRoom(healthy(T, { recording: { last_chunk_at: ago(T, 900), recorder_status: { state: "recording", session_open: false, received_at: ago(T, 300) } } }), DEFAULT_CONFIG, T),
      decideRoom(sleeping, DEFAULT_CONFIG, T, recent([row(T, 10, "ticket:wake", { outcome: "ok" }), row(T, 20, "ticket:wake", { outcome: "ok" }), row(T, 30, "ticket:wake", { outcome: "ok" }), row(T, 40, "ticket:wake", { outcome: "ok" })])),
      decideRoom(idle(T), DEFAULT_CONFIG, T, recent([], { failing: { not_recording: 3 }, hold: {} })),
    ];
    const all = cases.flat();
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(all.map((d) => d.rule)).toEqual(expect.arrayContaining(["kiosk_asleep", "ok", "not_recording", "cap_reached", "fleet_hold"]));
    for (const d of all) {
      for (const k of ["last_chunk_s", "kh_heartbeat_s", "poller_ok_s", "ext_status", "occupancy", "sleep_marker"]) expect(d.inputs, `${d.rule}/${d.action} lacks ${k}`).toHaveProperty(k);
      expect(typeof d.inputs.sleep_marker).toBe("boolean");
    }
    expect(decideRoom(sleeping, DEFAULT_CONFIG, T)[0]!.inputs).toMatchObject({ sleep_marker: true, last_chunk_s: null, kh_heartbeat_s: 400 });
  });
});

// ---------------------------------------------------------------------------
describe("fix-up 10 Oct: mic-return episode, mic_returned_but_silent", () => {
  const rowAt = (ts: number, rule: string, action: string, params: Record<string, unknown>): RecentAction => ({ ts: new Date(ts).toISOString(), rule, action, params, outcome: null });
  const tried = [failedAttempt(T, 3000)];
  const back = (A: number, over: DeepPartial<RoomSense> = {}) => idle(A, { audio: { default_input_present: true, devices_at: ago(A, 30) }, start_attempts: tried, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: { latest_at: ago(A, 20), latest_state: "ready", latest_session_open: "no", ready_since: ago(A, 40), ready_samples: 2 } }, ...over });
  const marker = (ts: number) => rowAt(ts, "waiting_for_mic", "log_only", { mic_ticks: 1 });
  const missing = (ts: number) => rowAt(ts, "waiting_for_mic", "log_only", { mic_ticks: 0 });

  it("ruling 1: ANY session start after the episode closes it (Kiosk Bot or operator); a session before it does not", () => {
    const A = T + 4 * 60_000;
    const mem = recent([missing(T), marker(T + 60_000)]);
    // still in the episode: the waiver applies
    expect(first(back(A), A, mem).inputs).toMatchObject({ mic_return: true, start_gate_fail: "recorder_ready_under_5m" });
    // a session (not a steward attempt) started after the marker: the episode is closed, the normal 5-min streak applies
    const withSession = back(A, { session_start_today_at: new Date(T + 2 * 60_000).toISOString() });
    const closed = first(withSession, A, mem);
    expect(closed.inputs.mic_return).toBeUndefined();
    expect(closed.inputs).toMatchObject({ start_gate_fail: "recorder_ready_under_5m" });
    // a session that started BEFORE the missing row does not close it
    const older = back(A, { session_start_today_at: new Date(T - 60 * 60_000).toISOString() });
    expect(first(older, A, mem).inputs).toMatchObject({ mic_return: true });
  });

  it("ruling 1: in shadow (no start ever follows) the episode closes after 5 min of present ticks: no all-day waiver", () => {
    const m = T + 60_000;
    const mem = recent([missing(T), marker(m)]);
    const at = (min: number) => m + min * 60_000;
    expect(first(back(at(4)), at(4), mem).inputs).toMatchObject({ mic_return: true });
    const late = first(back(at(5)), at(5), mem);
    expect(late.inputs.mic_return).toBeUndefined();
    expect(late.inputs).toMatchObject({ start_gate_fail: "recorder_ready_under_5m" });
    expect(first(back(at(300)), at(300), mem).inputs.mic_return).toBeUndefined();
    // a flap after that is a NEW episode: waiting again, then the marker again
    const f = at(301);
    const flapMem = recent([missing(T), marker(m), missing(f)]);
    expect(first(back(at(302)), at(302), flapMem)).toMatchObject({ rule: "waiting_for_mic", params: { mic_ticks: 1 } });
  });

  describe("ruling 5: mic_returned_but_silent", () => {
    const S0 = T + 30 * 60_000;
    const live = (A: number, startedAgoS: number, silentAgoS: number | null, over: DeepPartial<RoomSense> = {}) =>
      healthy(A, { recording: { session_open: true, session_status: "recording", session_started_at: ago(A, startedAgoS) }, audio: { silent_while_recording_since: silentAgoS === null ? null : ago(A, silentAgoS) }, ...over });
    const alertsOf = (ds: ReturnType<typeof decideRoom>) => ds.filter((d) => d.rule === "mic_returned_but_silent");
    const mem = (extra: RecentAction[] = []) => recent([missing(T), marker(T + 60_000), ...extra]);

    it("fires once when the first 2 min of the session that followed a mic return are digital zero", () => {
      const A = S0 + 130_000; // session began at S0
      const ds = decideRoom(live(A, 130, 130), DEFAULT_CONFIG, A, mem());
      expect(alertsOf(ds)).toHaveLength(1);
      expect(alertsOf(ds)[0]).toMatchObject({ action: "alert", params: { room_id: expect.any(String) } });
      // the alert row is in memory: the next tick adds nothing
      expect(alertsOf(decideRoom(live(A + 60_000, 190, 190), DEFAULT_CONFIG, A + 60_000, mem([rowAt(A, "mic_returned_but_silent", "alert", {})])))).toHaveLength(0);
    });
    it("D1: a zero run that began only later in the session (the first minutes had sound) does not fire", () => {
      const A = S0 + 600_000;
      expect(alertsOf(decideRoom(live(A, 600, 130), DEFAULT_CONFIG, A, mem()))).toHaveLength(0);
    });
    it("not before 2 min of session and zero; not without a mic-return episode; not when the mic flapped away again before the session", () => {
      const early = S0 + 100_000;
      expect(alertsOf(decideRoom(live(early, 100, 100), DEFAULT_CONFIG, early, mem()))).toHaveLength(0);
      const A = S0 + 130_000;
      expect(alertsOf(decideRoom(live(A, 130, 130), DEFAULT_CONFIG, A, EMPTY_RECENT))).toHaveLength(0);
      expect(alertsOf(decideRoom(live(A, 130, 130), DEFAULT_CONFIG, A, mem([missing(T + 20 * 60_000)])))).toHaveLength(0);
      // a marker newer than the session start belongs to a later return, not to this session
      expect(alertsOf(decideRoom(live(A, 130, 130), DEFAULT_CONFIG, A, recent([missing(T), marker(S0 + 60_000)])))).toHaveLength(0);
    });
    it("a second mic-return episode the same day can alert again", () => {
      const A = S0 + 130_000;
      const m2 = [rowAt(T + 10 * 60_000, "mic_returned_but_silent", "alert", {}), missing(T + 20 * 60_000), marker(T + 21 * 60_000)];
      expect(alertsOf(decideRoom(live(A, 130, 130), DEFAULT_CONFIG, A, recent([missing(T), marker(T + 60_000), ...m2])))).toHaveLength(1);
    });
  });
});
