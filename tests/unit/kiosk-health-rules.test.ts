/**
 * lib/kiosk-health-rules.ts (R11–R17) and lib/kiosk-health-read.ts — behaviour tests.
 *
 * Fixtures use the payload shapes sampled from Neon on 6 Oct 2026 (heartbeat, display.state, audio.devices/system_profiler, drift, drift.summary,
 * recorder.status, recorder.log). Kinds not yet seen in production (power.*, watchdog.action, ladder.rung, chrome.profile/alert) use the shapes the
 * daemon source emits. The rules are PURE and run on plain objects; the read half runs against a fake `sql` that records statement text and the
 * real-postgres proof is tests/unit/kiosk-health-read-sql.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { computeAttention, isClinicHours, type RoomAttentionInputs } from "@/lib/fleet-attention";
import { KIND_LABEL } from "@/lib/fleet-attention-format";
import type { ExtHealthRow, ExtStatus } from "@/lib/encounter-windows/ext-health";
import { kioskHealthItems, summarizeKioskHealth, KIOSK_HEALTH_KINDS } from "@/lib/kiosk-health-rules";
import { readKioskHealth, type KioskHealthSnapshot, type KhPowerEvent } from "@/lib/kiosk-health-read";

/** An IST wall-clock string ("2026-10-06 11:00:00") as epoch ms. */
const ist = (s: string): number => Date.parse(`${s.replace(" ", "T")}+05:30`);
const iso = (ms: number): string => new Date(ms).toISOString();

// Tuesday 6 Oct 2026 11:00 IST — inside clinic hours; 22:00 IST — outside.
const CLINIC_NOW = ist("2026-10-06 11:00:00");
const NIGHT_NOW = ist("2026-10-06 22:00:00");
const MACHINE = "EHRC-OPD6s-Mac-mini";
const ago = (now: number, s: number): string => iso(now - s * 1000);

const snap = (now: number, over: Partial<KioskHealthSnapshot> = {}): KioskHealthSnapshot => ({
  machine: MACHINE,
  room_id: "room_opd6",
  enrolled: true,
  last_seen_received_at: ago(now, 30),
  last_heartbeat_received_at: ago(now, 30),
  last_power: null,
  power_events: [],
  last_display_state: { ts: ago(now, 600), received_at: ago(now, 600), state: "on", origin: "ioreg" },
  last_audio_devices: { ts: ago(now, 900), received_at: ago(now, 900), default_input_present: true, default_input_name: "TONOR TM20 Microphone" },
  audio_start_failures_10m: 0,
  audio_start_failure_newest_ts: null,
  last_drift_by_field: {},
  last_drift_summary: null,
  last_watchdog: null,
  last_ladder: null,
  last_chrome_profile: null,
  last_chrome_alert: null,
  recorder_update_failures_24h: { count: 0, newest_line: null, newest_ts: null },
  last_recorder_status: { ts: ago(now, 120), received_at: ago(now, 120), state: "recording", session_open: "yes", pending_piece_count: 0 },
  ...over,
});

const power = (now: number, kind: string, tsAgoS: number, recvAgoS = tsAgoS, extra: Partial<KhPowerEvent> = {}): KhPowerEvent => ({
  kind,
  ts: ago(now, tsAgoS),
  received_at: ago(now, recvAgoS),
  reason: null,
  kAESleep: null,
  ...extra,
});

const ext = (status: ExtStatus, over: Partial<ExtHealthRow> = {}): ExtHealthRow => ({
  machine: MACHINE,
  room_id: "room_opd6",
  room_name: "OPD 6",
  last_ext_ts: null,
  ext_age_s: null,
  ext_version: "0.1.1.39",
  version_state: "current",
  poller: { ok: true, chrome_running: true, console_user: "ehrc", age_s: 30, idle_s: 10 },
  status,
  behind_since: null,
  behind_at_floor: false,
  chrome_down_since: null,
  rebooted_recently: false,
  rebooted_at: null,
  guard_last_reason: null,
  guard_last_at: null,
  guard_first_at: null,
  guard_events_24h: 0,
  guard_relaunches_24h: 0,
  guard_reasons_24h: {},
  ...over,
});

const run = (now: number, s: KioskHealthSnapshot, e: ExtHealthRow | null = ext("ok")) =>
  kioskHealthItems(new Map([[MACHINE, s]]), new Map(e ? [[MACHINE, e]] : []), iso(now), isClinicHours(now));
const kinds = (items: ReturnType<typeof run>) => items.map((i) => i.kind).sort();

describe("kiosk-health rules — shared behaviour", () => {
  it("a healthy, enrolled machine raises nothing", () => {
    expect(run(CLINIC_NOW, snap(CLINIC_NOW))).toEqual([]);
  });

  it("an unenrolled machine produces nothing, whatever else is in the snapshot", () => {
    const s = snap(CLINIC_NOW, { enrolled: false, last_heartbeat_received_at: null, audio_start_failures_10m: 3, power_events: [power(CLINIC_NOW, "power.sleep", 600)] });
    expect(run(CLINIC_NOW, s)).toEqual([]);
  });

  it("an empty map (read failed) produces nothing", () => {
    expect(kioskHealthItems(new Map(), new Map(), iso(CLINIC_NOW), true)).toEqual([]);
  });

  it("every kiosk kind has a staff-facing label", () => {
    for (const k of KIOSK_HEALTH_KINDS) expect(KIND_LABEL[k].length).toBeGreaterThan(3);
  });

  it("items carry room, machine, kind, severity, since, detail and action", () => {
    const [it] = run(CLINIC_NOW, snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, 700), power_events: [power(CLINIC_NOW, "power.sleep", 600)] }));
    expect(it).toMatchObject({ room_id: "room_opd6", room_name: "OPD 6", machine: MACHINE, kind: "kiosk_asleep", severity: "red" });
    expect(Date.parse(it!.since)).toBe(CLINIC_NOW - 600_000);
    expect(it!.detail.length).toBeGreaterThan(10);
    expect(it!.action.length).toBeGreaterThan(10);
  });
});

/** A snapshot whose daemon last heartbeated `hbAgo` seconds ago (use a value older than the sleep to model a Mac that really is asleep). */
const sleeper = (now: number, hbAgo: number, events: KhPowerEvent[]) => snap(now, { last_heartbeat_received_at: ago(now, hbAgo), power_events: events });

describe("R11 kiosk_asleep", () => {
  it("fires red when the newest power event is power.sleep with no later wake and no heartbeat since", () => {
    const s = sleeper(CLINIC_NOW, 3700, [power(CLINIC_NOW, "power.wake", 7200), power(CLINIC_NOW, "power.sleep", 3600, 3600, { reason: "Idle Sleep", kAESleep: "0x1" })]);
    const items = run(CLINIC_NOW, s);
    expect(items.find((i) => i.kind === "kiosk_asleep")).toMatchObject({ severity: "red" });
    const d = items.find((i) => i.kind === "kiosk_asleep")!.detail;
    expect(d).toContain("power.sleep");
    expect(d).toContain("Idle Sleep");
    expect(d).toContain("kAESleep 0x1");
  });

  it("fires on power.darkwake with no later wake and no heartbeat since", () => {
    expect(kinds(run(CLINIC_NOW, sleeper(CLINIC_NOW, 2000, [power(CLINIC_NOW, "power.darkwake", 1800)])))).toContain("kiosk_asleep");
  });

  it("does not fire when a later power.wake exists", () => {
    const s = sleeper(CLINIC_NOW, 4000, [power(CLINIC_NOW, "power.sleep", 3600), power(CLINIC_NOW, "power.wake", 1800)]);
    expect(kinds(run(CLINIC_NOW, s))).not.toContain("kiosk_asleep");
  });

  it("a backfilled pmset pair (ts 15 h / 14 h old, received now) does not raise when the later wake exists", () => {
    const s = sleeper(CLINIC_NOW, 16 * 3600, [power(CLINIC_NOW, "power.sleep", 15 * 3600, 5), power(CLINIC_NOW, "power.wake", 14 * 3600, 5)]);
    expect(kinds(run(CLINIC_NOW, s))).not.toContain("kiosk_asleep");
  });

  it("F1(b) a backfilled sleep (ts 15 h ago, received now) does not fire: it is history, not news", () => {
    expect(kinds(run(CLINIC_NOW, sleeper(CLINIC_NOW, 16 * 3600, [power(CLINIC_NOW, "power.sleep", 15 * 3600, 5)])))).not.toContain("kiosk_asleep");
    // 13 h old by ts, received long ago or just now: the same
    expect(kinds(run(CLINIC_NOW, sleeper(CLINIC_NOW, 16 * 3600, [power(CLINIC_NOW, "power.sleep", 13 * 3600, 13 * 3600)])))).not.toContain("kiosk_asleep");
    // 11 h old by ts still fires
    expect(kinds(run(CLINIC_NOW, sleeper(CLINIC_NOW, 12 * 3600, [power(CLINIC_NOW, "power.sleep", 11 * 3600)])))).toContain("kiosk_asleep");
  });

  it("orders by event time, not arrival: a backfilled WAKE older than a live sleep does not hide it", () => {
    const s = sleeper(CLINIC_NOW, 700, [power(CLINIC_NOW, "power.wake", 15 * 3600, 5), power(CLINIC_NOW, "power.sleep", 600, 600)]);
    expect(kinds(run(CLINIC_NOW, s))).toContain("kiosk_asleep");
  });

  it("F1(c) sleep 10 min ago with a heartbeat 30 s ago does not fire (the Mac is heartbeating)", () => {
    const s = snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, 30), power_events: [power(CLINIC_NOW, "power.sleep", 600)] });
    expect(kinds(run(CLINIC_NOW, s))).not.toContain("kiosk_asleep");
  });

  it("F1(c) sleep 10 min ago with the last heartbeat 11 min ago fires", () => {
    const s = snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, 660), power_events: [power(CLINIC_NOW, "power.sleep", 600)] });
    expect(kinds(run(CLINIC_NOW, s))).toContain("kiosk_asleep");
  });

  it("F1(c) the 180 s grace: a heartbeat 100 s after the sleep still fires, 200 s after does not", () => {
    const at = (hbAgo: number) => snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, hbAgo), power_events: [power(CLINIC_NOW, "power.sleep", 600)] });
    expect(kinds(run(CLINIC_NOW, at(500)))).toContain("kiosk_asleep");
    expect(kinds(run(CLINIC_NOW, at(400)))).not.toContain("kiosk_asleep");
  });

  it("a machine with no heartbeat on record and a fresh sleep fires", () => {
    const s = snap(CLINIC_NOW, { last_heartbeat_received_at: null, power_events: [power(CLINIC_NOW, "power.sleep", 600)] });
    expect(kinds(run(CLINIC_NOW, s))).toContain("kiosk_asleep");
  });

  it("other power events (sleep_refused, reason) do not mask or raise it", () => {
    const s = sleeper(CLINIC_NOW, 3700, [power(CLINIC_NOW, "power.sleep", 3600), power(CLINIC_NOW, "power.reason", 3500)]);
    expect(kinds(run(CLINIC_NOW, s))).toContain("kiosk_asleep");
    const t = snap(CLINIC_NOW, { power_events: [power(CLINIC_NOW, "power.sleep_refused", 100)] });
    expect(kinds(run(CLINIC_NOW, t))).not.toContain("kiosk_asleep");
  });
});

describe("R12 kiosk_health_silent", () => {
  it("fires amber when the heartbeat is older than 180 s and the poller can still see the Mac", () => {
    const items = run(CLINIC_NOW, snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, 200) }), ext("ok"));
    const it = items.find((i) => i.kind === "kiosk_health_silent");
    expect(it).toMatchObject({ severity: "amber" });
    expect(it!.detail).toContain("silent 200 s");
    expect(Date.parse(it!.since)).toBe(CLINIC_NOW - 200_000);
  });

  it("does not fire at 170 s", () => {
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, 170) })))).toEqual([]);
  });

  it("does not fire when the poller cannot see the Mac (offline / no_chrome / no ext row)", () => {
    const s = snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, 900) });
    expect(kinds(run(CLINIC_NOW, s, ext("offline")))).toEqual([]);
    expect(kinds(run(CLINIC_NOW, s, ext("no_chrome")))).toEqual([]);
    expect(kinds(run(CLINIC_NOW, s, null))).toEqual([]);
  });

  it("F3 beyond 60 min the wording changes to 'daemon stopped (last seen T)' and it stays raised", () => {
    const at = (secs: number) => run(CLINIC_NOW, snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, secs) })).find((i) => i.kind === "kiosk_health_silent")!;
    expect(at(3599).detail).toContain("silent 3599 s");
    expect(at(3700).detail).toContain("stopped (last seen");
    expect(at(3700).detail).not.toContain("silent 3700");
    expect(at(5 * 3600).severity).toBe("amber");
  });

  it("F3 a daemon whose last row left the 24 h window (no heartbeat in 24 h, seen 3 days ago) is 'stopped', not forgotten", () => {
    const s = snap(CLINIC_NOW, { last_heartbeat_received_at: null, last_seen_received_at: ago(CLINIC_NOW, 3 * 86400) });
    const it = run(CLINIC_NOW, s).find((i) => i.kind === "kiosk_health_silent")!;
    expect(it.detail).toContain("stopped (last seen");
    expect(Date.parse(it.since)).toBe(CLINIC_NOW - 3 * 86_400_000);
  });

  it("F3 not enrolled (nothing seen in 7 days) raises nothing", () => {
    expect(run(CLINIC_NOW, snap(CLINIC_NOW, { enrolled: false, last_heartbeat_received_at: null, last_seen_received_at: null }))).toEqual([]);
  });

  it("R11 takes precedence: an asleep machine raises R11 and not R12", () => {
    const s = snap(CLINIC_NOW, { last_heartbeat_received_at: ago(CLINIC_NOW, 1800), power_events: [power(CLINIC_NOW, "power.sleep", 1900)] });
    expect(kinds(run(CLINIC_NOW, s, ext("ok")))).toEqual(["kiosk_asleep"]);
  });
});

describe("R13 audio_dead", () => {
  const noInput = (now: number) => ({ last_audio_devices: { ts: ago(now, 300), received_at: ago(now, 300), default_input_present: false, default_input_name: null } });

  it("fires red in clinic hours and amber outside them when there is no default input", () => {
    expect(run(CLINIC_NOW, snap(CLINIC_NOW, noInput(CLINIC_NOW))).find((i) => i.kind === "audio_dead")).toMatchObject({ severity: "red" });
    expect(run(NIGHT_NOW, snap(NIGHT_NOW, noInput(NIGHT_NOW))).find((i) => i.kind === "audio_dead")).toMatchObject({ severity: "amber" });
  });

  it("detail names the default input (or none) and the failure count", () => {
    const d = run(CLINIC_NOW, snap(CLINIC_NOW, { ...noInput(CLINIC_NOW), audio_start_failures_10m: 2, audio_start_failure_newest_ts: ago(CLINIC_NOW, 60) })).find((i) => i.kind === "audio_dead")!.detail;
    expect(d).toContain("default input none");
    expect(d).toContain("2 recorder start failures");
  });

  it("fires on start failures in the last 10 min even when the default input is present", () => {
    const items = run(CLINIC_NOW, snap(CLINIC_NOW, { audio_start_failures_10m: 1, audio_start_failure_newest_ts: ago(CLINIC_NOW, 120) }));
    const it = items.find((i) => i.kind === "audio_dead")!;
    expect(it.detail).toContain("TONOR TM20 Microphone");
    expect(it.detail).toContain("1 recorder start failure ");
    expect(Date.parse(it.since)).toBe(CLINIC_NOW - 120_000);
  });

  it("does not fire with a default input and no start failures", () => {
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW)))).toEqual([]);
  });

  it("F6 only a snapshot received within 2 h counts: a stale 'no input' row does not fire, start failures still do", () => {
    const stale = { last_audio_devices: { ts: ago(CLINIC_NOW, 3 * 3600), received_at: ago(CLINIC_NOW, 3 * 3600), default_input_present: false, default_input_name: null } };
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, stale)))).toEqual([]);
    const fresh = { last_audio_devices: { ts: ago(CLINIC_NOW, 3600), received_at: ago(CLINIC_NOW, 3600), default_input_present: false, default_input_name: null } };
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, fresh)))).toEqual(["audio_dead"]);
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { ...stale, audio_start_failures_10m: 1, audio_start_failure_newest_ts: ago(CLINIC_NOW, 60) })))).toEqual(["audio_dead"]);
  });
});

describe("R14 config_drift", () => {
  const drift = (now: number, field: string, over: Record<string, unknown> = {}) => ({
    ts: ago(now, 3600),
    received_at: ago(now, 3600),
    field,
    expected: "0",
    actual: "10",
    change: "initial" as string | null,
    resolved: false,
    ...over,
  });
  const summary = (now: number, items: Array<{ field: string; expected: string | null; actual: string | null }>, agoS = 7200) => ({ ts: ago(now, agoS), received_at: ago(now, agoS), drift_count: items.length, items });

  it("fires amber for a field whose latest drift row is unresolved, naming 'field: expected → actual'", () => {
    const s = snap(CLINIC_NOW, { last_drift_by_field: { "pmset.sleep": drift(CLINIC_NOW, "pmset.sleep") } });
    const it = run(CLINIC_NOW, s).find((i) => i.kind === "config_drift")!;
    expect(it.severity).toBe("amber");
    expect(it.detail).toContain("pmset.sleep: 0 → 10");
  });

  it("does not fire when the latest row per field is resolved", () => {
    const s = snap(CLINIC_NOW, {
      last_drift_by_field: { a: drift(CLINIC_NOW, "a", { change: "resolved" }), b: drift(CLINIC_NOW, "b", { change: "changed", resolved: true }) },
    });
    expect(kinds(run(CLINIC_NOW, s))).toEqual([]);
  });

  it("lists at most 4 fields", () => {
    const f = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((n, i) => [n, drift(CLINIC_NOW, n, { ts: ago(CLINIC_NOW, 3600 - i) })]));
    const d = run(CLINIC_NOW, snap(CLINIC_NOW, { last_drift_by_field: f })).find((i) => i.kind === "config_drift")!.detail;
    expect((d.match(/→/g) ?? []).length).toBe(4);
    expect(d).toContain("+2 more");
  });

  it("F5 a summary-only field fires when the field has no drift row", () => {
    const only = run(CLINIC_NOW, snap(CLINIC_NOW, { last_drift_summary: summary(CLINIC_NOW, [{ field: "hostname", expected: "OPD6", actual: "opd-6" }]) })).find((i) => i.kind === "config_drift")!;
    expect(only.detail).toContain("hostname: OPD6 → opd-6");
  });

  it("F5 field A resolved today, summary lists field B → fires for B only", () => {
    const s = snap(CLINIC_NOW, {
      last_drift_by_field: { A: drift(CLINIC_NOW, "A", { change: "resolved", resolved: true }) },
      last_drift_summary: summary(CLINIC_NOW, [{ field: "A", expected: "1", actual: "2" }, { field: "B", expected: "x", actual: "y" }]),
    });
    const d = run(CLINIC_NOW, s).find((i) => i.kind === "config_drift")!.detail;
    expect(d).toContain("B: x → y");
    expect(d).not.toContain("A: 1");
    expect(summarizeKioskHealth(new Map([[MACHINE, s]]), CLINIC_NOW)[MACHINE]!.drift_fields).toEqual(["B"]);
  });

  it("F5 a summary received more than 24 h ago, or one with no items, raises nothing", () => {
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { last_drift_summary: summary(CLINIC_NOW, [{ field: "hostname", expected: "a", actual: "b" }], 25 * 3600) })))).toEqual([]);
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { last_drift_summary: summary(CLINIC_NOW, []) })))).toEqual([]);
  });
});

describe("R15 recovery_failed", () => {
  const wd = (now: number, agoS: number, outcome: string) => ({
    ts: ago(now, agoS),
    received_at: ago(now, agoS),
    trigger: "tape_stalled",
    action: "restart_recorder",
    outcome,
    failure_reasons: ["recorder_not_running", "mic_missing"],
  });

  it("fires red when the watchdog outcome is not_recovered within 60 min", () => {
    const it = run(CLINIC_NOW, snap(CLINIC_NOW, { last_watchdog: wd(CLINIC_NOW, 600, "not_recovered") })).find((i) => i.kind === "recovery_failed")!;
    expect(it.severity).toBe("red");
    expect(it.detail).toContain("tape_stalled");
    expect(it.detail).toContain("recorder_not_running");
  });

  it("fires on a ladder not_recovered, naming the rung", () => {
    const l = { ts: ago(CLINIC_NOW, 300), received_at: ago(CLINIC_NOW, 300), rung: "relaunch_app", trigger: "audio_dead", outcome: "not_recovered", reason: null };
    expect(run(CLINIC_NOW, snap(CLINIC_NOW, { last_ladder: l })).find((i) => i.kind === "recovery_failed")!.detail).toContain("relaunch_app");
  });

  it("does not fire for a recovered outcome, or one older than 60 min", () => {
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { last_watchdog: wd(CLINIC_NOW, 600, "recovered") })))).toEqual([]);
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { last_watchdog: wd(CLINIC_NOW, 61 * 60, "not_recovered") })))).toEqual([]);
  });

  it("does not fire when a later power.wake exists", () => {
    const s = snap(CLINIC_NOW, { last_watchdog: wd(CLINIC_NOW, 1200, "not_recovered"), power_events: [power(CLINIC_NOW, "power.wake", 600)] });
    expect(kinds(run(CLINIC_NOW, s))).toEqual([]);
    // a wake BEFORE the failure does not clear it
    const t = snap(CLINIC_NOW, { last_watchdog: wd(CLINIC_NOW, 600, "not_recovered"), power_events: [power(CLINIC_NOW, "power.wake", 1200)] });
    expect(kinds(run(CLINIC_NOW, t))).toEqual(["recovery_failed"]);
  });
});

describe("R16 presence_cannot_run", () => {
  const alert = (now: number, agoS: number) => ({ ts: ago(now, agoS), received_at: ago(now, agoS), reason: "ext_missing:Default", last_used: "Default", guest: false, presence_ok: false });
  const prof = (now: number, agoS: number, ok: boolean | null) => ({ ts: ago(now, agoS), received_at: ago(now, agoS), running: true, last_used: "Default", guest: false, presence_ok: ok });

  it("fires within 15 min of the alert: red in clinic hours, amber outside, detail has reason / last_used / guest", () => {
    const c = run(CLINIC_NOW, snap(CLINIC_NOW, { last_chrome_alert: alert(CLINIC_NOW, 300) })).find((i) => i.kind === "presence_cannot_run")!;
    expect(c.severity).toBe("red");
    expect(c.detail).toContain("ext_missing:Default");
    expect(c.detail).toContain("Chrome last used Default");
    expect(c.detail).toContain("guest session no");
    expect(run(NIGHT_NOW, snap(NIGHT_NOW, { last_chrome_alert: alert(NIGHT_NOW, 300) })).find((i) => i.kind === "presence_cannot_run")).toMatchObject({ severity: "amber" });
  });

  it("does not fire for an alert older than 15 min", () => {
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { last_chrome_alert: alert(CLINIC_NOW, 16 * 60) })))).toEqual([]);
  });

  it("is cleared by a LATER chrome.profile with presence_ok === true, not by an earlier one or presence_ok null", () => {
    const base = { last_chrome_alert: alert(CLINIC_NOW, 600) };
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { ...base, last_chrome_profile: prof(CLINIC_NOW, 120, true) })))).toEqual([]);
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { ...base, last_chrome_profile: prof(CLINIC_NOW, 900, true) })))).toEqual(["presence_cannot_run"]);
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { ...base, last_chrome_profile: prof(CLINIC_NOW, 120, null) })))).toEqual(["presence_cannot_run"]);
  });

  it("F2 a chrome.profile with presence_ok true at exactly the alert's ts clears it (ts >= alert ts)", () => {
    const a = alert(CLINIC_NOW, 600);
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW, { last_chrome_alert: a, last_chrome_profile: { ts: a.ts, received_at: a.received_at, running: true, last_used: "Default", guest: false, presence_ok: true } })))).toEqual([]);
  });
});

describe("R17 recorder_update_failing", () => {
  const line = "room-recorder: update to 0.1.18 stopped: signature_mismatch: " + "x".repeat(200);

  it("fires amber when signature_mismatch failures exist in 24 h; detail truncates the newest line to 120 chars", () => {
    const it = run(CLINIC_NOW, snap(CLINIC_NOW, { recorder_update_failures_24h: { count: 3, newest_line: line, newest_ts: ago(CLINIC_NOW, 4000) } })).find((i) => i.kind === "recorder_update_failing")!;
    expect(it.severity).toBe("amber");
    expect(it.detail).toContain("3 times");
    expect(it.detail).toContain("update to 0.1.18 stopped: signature_mismatch");
    const shown = it.detail.split("24 h: ")[1]!;
    expect(shown.length).toBe(120);
    expect(Date.parse(it.since)).toBe(CLINIC_NOW - 4_000_000);
  });

  it("does not fire with a zero count", () => {
    expect(kinds(run(CLINIC_NOW, snap(CLINIC_NOW)))).toEqual([]);
  });
});

describe("summarizeKioskHealth", () => {
  it("gives the small per-machine shape", () => {
    const s = snap(CLINIC_NOW, {
      last_power: power(CLINIC_NOW, "power.wake", 100),
      last_chrome_profile: { ts: ago(CLINIC_NOW, 60), received_at: ago(CLINIC_NOW, 60), running: true, last_used: "Default", guest: false, presence_ok: true },
      last_drift_by_field: { f: { ts: ago(CLINIC_NOW, 60), received_at: ago(CLINIC_NOW, 60), field: "f", expected: "1", actual: "2", change: "changed", resolved: false } },
    });
    expect(summarizeKioskHealth(new Map([[MACHINE, s]]))).toEqual({
      [MACHINE]: { enrolled: true, last_heartbeat_received_at: s.last_heartbeat_received_at, last_power_kind: "power.wake", default_input_present: true, drift_fields: ["f"], chrome_presence_ok: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Wiring through computeAttention: merge, R8 suppression, read failure
// ---------------------------------------------------------------------------

const room = (now: number, over: Partial<RoomAttentionInputs> = {}): RoomAttentionInputs => ({
  room_id: "room_opd6",
  room_name: "OPD 6",
  machine: MACHINE,
  ext_events: [],
  poller: null,
  recent_activity: null,
  open_session: null,
  last_session_started_at: null,
  samples: [],
  frozen_since: null,
  last_sample_at: null,
  chunks: [],
  windows: [],
  outbox: null,
  failed_start: null,
  ext: ext("missing", { last_ext_ts: ago(now, 1800), ext_age_s: 1800 }),
  ...over,
});

describe("wiring in computeAttention", () => {
  const alertSnap = (now: number) => snap(now, { last_chrome_alert: { ts: ago(now, 300), received_at: ago(now, 300), reason: "no_profile", last_used: null, guest: true, presence_ok: false } });

  it("R16 suppresses R8 for the same room (R16 is the explanation)", () => {
    const items = computeAttention({ now_ms: CLINIC_NOW, rooms: [room(CLINIC_NOW)], kiosk_health: new Map([[MACHINE, alertSnap(CLINIC_NOW)]]) });
    const ks = items.map((i) => `${i.room_id}:${i.kind}`);
    expect(ks).toContain("room_opd6:presence_cannot_run");
    expect(ks).not.toContain("room_opd6:extension_missing");
  });

  it("R8 still fires when R16 does not, and for other rooms", () => {
    const withoutKiosk = computeAttention({ now_ms: CLINIC_NOW, rooms: [room(CLINIC_NOW)], kiosk_health: new Map([[MACHINE, snap(CLINIC_NOW)]]) });
    expect(withoutKiosk.map((i) => i.kind)).toContain("extension_missing");
    const other = room(CLINIC_NOW, { room_id: "room_opd5", room_name: "OPD 5", machine: "EHRC-OPD5s-Mac-mini", ext: ext("missing", { machine: "EHRC-OPD5s-Mac-mini", room_id: "room_opd5", room_name: "OPD 5", ext_age_s: 1800, last_ext_ts: ago(CLINIC_NOW, 1800) }) });
    const items = computeAttention({ now_ms: CLINIC_NOW, rooms: [room(CLINIC_NOW), other], kiosk_health: new Map([[MACHINE, alertSnap(CLINIC_NOW)]]) });
    const ks = items.map((i) => `${i.room_id}:${i.kind}`);
    expect(ks).toContain("room_opd5:extension_missing");
    expect(ks).not.toContain("room_opd6:extension_missing");
  });

  it("merges kiosk items into the one ordered list (red first, room label from the room list)", () => {
    const s = snap(CLINIC_NOW, {
      last_heartbeat_received_at: ago(CLINIC_NOW, 1300),
      power_events: [power(CLINIC_NOW, "power.sleep", 1200)],
      recorder_update_failures_24h: { count: 1, newest_line: "room-recorder: update to 0.1.18 stopped: signature_mismatch: bad", newest_ts: ago(CLINIC_NOW, 9000) },
    });
    const items = computeAttention({ now_ms: CLINIC_NOW, rooms: [room(CLINIC_NOW, { ext: ext("ok") })], kiosk_health: new Map([[MACHINE, s]]) });
    expect(items.map((i) => i.kind)).toEqual(["kiosk_asleep", "recorder_update_failing"]);
    expect(items[0]).toMatchObject({ room_id: "room_opd6", room_name: "OPD 6", severity: "red" });
  });

  it("clinic-hours severity switch reaches the merged items", () => {
    const s = snap(NIGHT_NOW, { last_audio_devices: { ts: ago(NIGHT_NOW, 60), received_at: ago(NIGHT_NOW, 60), default_input_present: false, default_input_name: null } });
    const items = computeAttention({ now_ms: NIGHT_NOW, rooms: [room(NIGHT_NOW, { ext: ext("ok") })], kiosk_health: new Map([[MACHINE, s]]) });
    expect(items.find((i) => i.kind === "audio_dead")).toMatchObject({ severity: "amber" });
  });

  it("a failed kiosk-health read (empty map) leaves the other items intact and adds none", () => {
    const base = computeAttention({ now_ms: CLINIC_NOW, rooms: [room(CLINIC_NOW)] });
    const failed = computeAttention({ now_ms: CLINIC_NOW, rooms: [room(CLINIC_NOW)], kiosk_health: new Map() });
    expect(base.map((i) => i.kind)).toContain("extension_missing");
    expect(failed).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// readKioskHealth — fake sql
// ---------------------------------------------------------------------------

type Rec = { q: string; v: unknown[] };
function fakeSql(results: unknown[][] | Error, rec: Rec[] = []) {
  let i = 0;
  const fn = (s: TemplateStringsArray, ...v: unknown[]) => {
    let q = "";
    s.forEach((p, k) => { q += p + (k < v.length ? `$${k + 1}` : ""); });
    rec.push({ q, v });
    if (results instanceof Error) return Promise.reject(results);
    return Promise.resolve(results[i++] ?? []);
  };
  return { sql: fn as never, rec };
}

describe("readKioskHealth", () => {
  afterEach(() => vi.restoreAllMocks());
  const AS_OF = iso(CLINIC_NOW);
  const T = (s: number) => ago(CLINIC_NOW, s);

  it("maps the real payload shapes into a snapshot, keyed by the canonical machine, across every spelling", async () => {
    const newest = [
      { machine: MACHINE, room_id: "room_opd6", kind: "heartbeat", ts: T(20), received_at: T(20), payload: { version: "0.1.4", uptime_s: 5000, daemon_uptime_s: 4000, last_post: { at: T(25), http: 200, accepted: 3, rejected: 0 }, last_post_ok: true, spool_depth: 0, spool_dropped: 0, post_enabled: true } },
      { machine: MACHINE, room_id: "room_opd6", kind: "display.state", ts: T(500), received_at: T(500), payload: { state: "on", origin: "ioreg" } },
      { machine: MACHINE, room_id: "room_opd6", kind: "audio.devices", ts: T(900), received_at: T(900), payload: { devices: [{ uid: "u1", name: "TONOR", transport: "usb", input_channels: 1, output_channels: 0, is_default_input: true, is_default_output: false }], default_input: { uid: "u1", name: "TONOR" }, default_input_present: true, trigger: "poll" } },
      { machine: MACHINE, room_id: "room_opd6", kind: "drift.summary", ts: T(3000), received_at: T(3000), payload: { date: "2026-10-06", tz: "Asia/Kolkata", drift_count: 1, items: [{ field: "sleep", expected: 0, actual: 10 }] } },
      { machine: MACHINE, room_id: "room_opd6", kind: "recorder.status", ts: T(100), received_at: T(100), payload: { state: "recording", session_id: "s1", session_open: "yes", pending_piece_count: 2, file_mtime: T(100), updated_at: T(100) } },
      { machine: MACHINE, room_id: "room_opd6", kind: "watchdog.action", ts: T(400), received_at: T(400), payload: { trigger: "tape_stalled", action: "restart", outcome: "not_recovered", evidence: { failure_reasons: ["a", "b"] } } },
      { machine: MACHINE, room_id: "room_opd6", kind: "chrome.alert", ts: T(200), received_at: T(200), payload: { running: true, last_used: "Default", active: [], guest: false, ext: {}, presence_ok: false, reason: "not_running" } },
    ];
    const detail = [
      { part: "power", machine: MACHINE, kind: "power.sleep", ts: T(3000), received_at: T(3000), payload: { reason: "Idle Sleep", kAESleep: null }, n: null },
      { part: "power", machine: "EHRC-OPD6s-Mac-mini", kind: "power.wake", ts: T(2000), received_at: T(5), payload: { reason: null, kAESleep: null }, n: null },
      { part: "drift", machine: MACHINE, kind: "drift", ts: T(4000), received_at: T(4000), payload: { field: "sleep", expected: 0, actual: 10, change: "initial" }, n: null },
      { part: "drift", machine: MACHINE, kind: "drift", ts: T(1000), received_at: T(1000), payload: { field: "sleep", expected: 0, actual: 0, change: "resolved", resolved: true }, n: null },
      { part: "start_failure", machine: MACHINE, kind: "audio.error", ts: T(90), received_at: T(90), payload: null, n: 2 },
    ];
    const recorder = [{ machine: MACHINE, n: 4, line: "room-recorder: update to 0.1.18 stopped: signature_mismatch: sig", ts: T(7000) }];
    const seen = [{ machine: MACHINE, received_at: T(5), kind: "power.wake" }];
    const { sql } = fakeSql([newest, detail, recorder, seen]);
    const r = await readKioskHealth(sql, [MACHINE], AS_OF);
    expect(r.ok).toBe(true);
    const s = r.snapshots.get(MACHINE)!;
    expect(s.enrolled).toBe(true);
    expect(s.last_seen_received_at).toBe(T(5));
    expect(s.room_id).toBe("room_opd6");
    expect(s.last_heartbeat_received_at).toBe(T(20));
    expect(s.last_display_state).toMatchObject({ state: "on", origin: "ioreg" });
    expect(s.last_audio_devices).toMatchObject({ default_input_present: true, default_input_name: "TONOR" });
    expect(s.last_drift_summary).toMatchObject({ drift_count: 1, items: [{ field: "sleep", expected: "0", actual: "10" }] });
    expect(s.last_recorder_status).toMatchObject({ state: "recording", session_open: "yes", pending_piece_count: 2 });
    expect(s.last_watchdog).toMatchObject({ trigger: "tape_stalled", outcome: "not_recovered", failure_reasons: ["a", "b"] });
    expect(s.last_chrome_alert).toMatchObject({ reason: "not_running", guest: false, presence_ok: false });
    expect(s.power_events.map((e) => e.kind)).toEqual(["power.sleep", "power.wake"]);
    expect(s.last_power?.kind).toBe("power.wake");
    expect(s.audio_start_failures_10m).toBe(2);
    expect(s.last_drift_by_field.sleep).toMatchObject({ change: "resolved", resolved: true });
    expect(s.recorder_update_failures_24h).toMatchObject({ count: 4 });
  });

  it("maps legacy / raw spellings back to the canonical machine key and ignores unknown machines", async () => {
    const hb = (machine: string) => ({ machine, room_id: null, kind: "heartbeat", ts: T(10), received_at: T(10), payload: {} });
    const { sql } = fakeSql([[hb("echo"), hb("Stranger-Mac")], [], [], []]);
    const { snapshots } = await readKioskHealth(sql, ["EHRC-ECHOs-Mac-mini", "echo"], AS_OF);
    expect([...snapshots.keys()]).toEqual(["EHRC-ECHOs-Mac-mini"]);
  });

  it("F7 the sampled spellings, a '.local' suffix and different case all map to the canonical machine; the SQL key list carries the variants", async () => {
    const fleet = ["EHRC-AUDIOMETRYs-Mac-mini", "EHRC-ECHOs-Mac-mini", "EHRC-DISCUSSIONs-Mac-mini"];
    const hb = (machine: string) => ({ machine, room_id: null, kind: "heartbeat", ts: T(10), received_at: T(10), payload: {} });
    const rows = [hb("EHRC-AUDIOMETRYs-Mac-mini"), hb("EHRC-ECHOs-Mac-mini.local"), hb("ehrc-discussions-mac-mini.local"), hb("EHRC-AUDIOMETRYs-Mac-mini.local")];
    const rec: Rec[] = [];
    const { sql } = fakeSql([rows, [], [], rows.map((r) => ({ machine: r.machine, received_at: r.received_at, kind: "heartbeat" }))], rec);
    const { snapshots, ok } = await readKioskHealth(sql, fleet, AS_OF);
    expect(ok).toBe(true);
    expect([...snapshots.keys()].sort()).toEqual([...fleet].sort());
    for (const f of fleet) expect(snapshots.get(f)!.last_heartbeat_received_at).toBe(T(10));
    const keys = rec[0]!.v[0] as string[];
    for (const want of ["EHRC-ECHOs-Mac-mini", "EHRC-ECHOs-Mac-mini.local", "ehrc-echos-mac-mini", "ehrc-echos-mac-mini.local", "EHRC-AUDIOMETRYs-Mac-mini.local", "EHRC-DISCUSSIONs-Mac-mini.local"]) {
      expect(keys).toContain(want);
    }
  });

  it("issues four queries, each machine = ANY with a received_at upper bound and a lower bound (24 h; 7 days for the enrolment read), bound params only", async () => {
    const rec: Rec[] = [];
    const { sql } = fakeSql([[], [], [], []], rec);
    await readKioskHealth(sql, [MACHINE, "EHRC-OPD5s-Mac-mini"], AS_OF);
    expect(rec.length).toBe(4);
    for (const { q, v } of rec) {
      expect(q).toMatch(/machine\s*=\s*ANY\(\$\d+::text\[\]\)/);
      expect(q).toMatch(/received_at\s*(<=|BETWEEN)/);
      expect(q).not.toMatch(/unsafe|;\s*DROP|\$\{/i);
      expect(v[0]).toEqual(expect.arrayContaining([MACHINE, "EHRC-OPD5s-Mac-mini"]));
    }
    for (const { q } of rec.slice(0, 3)) {
      expect(q).toMatch(/received_at\s*>=\s*\$\d+::timestamptz\s*-\s*interval '24 hours'/);
      expect(q).toMatch(/received_at\s*<=\s*\$\d+::timestamptz/);
    }
    // the detail query is capped per machine, not an unbounded scan of events
    expect(rec[1]!.q).toMatch(/rn\s*<=\s*50/);
    expect(rec[1]!.q).toMatch(/rn\s*<=\s*100/);
    expect(rec[1]!.q).toMatch(/interval '10 minutes'/);
    expect(rec[1]!.q).toMatch(/interval '12 hours'/);
    expect(rec[1]!.q).toContain("(k.payload->'start_failure') = 'true'::jsonb");
    expect(rec[0]!.q).toMatch(/DISTINCT ON \(k\.machine, k\.kind\)/);
    expect(rec[2]!.q).toMatch(/signature_mismatch/);
    expect(rec[3]!.q).toMatch(/DISTINCT ON \(k\.machine\)/);
    expect(rec[3]!.q).toMatch(/received_at BETWEEN \$\d+::timestamptz - interval '7 days' AND \$\d+::timestamptz/);
    expect(rec[3]!.q).toMatch(/ORDER BY k\.machine, k\.received_at DESC/);
  });

  it("with no machines, issues no query and is ok", async () => {
    const rec: Rec[] = [];
    const { sql } = fakeSql([], rec);
    const r = await readKioskHealth(sql, [], AS_OF);
    expect(r.snapshots.size).toBe(0);
    expect(r.ok).toBe(true);
    expect(rec.length).toBe(0);
  });

  it("F4 a read failure returns { empty snapshots, ok: false } and logs exactly one warning, never row contents", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sql } = fakeSql(new Error("connection terminated"));
    const r = await readKioskHealth(sql, [MACHINE], AS_OF);
    expect(r.snapshots.size).toBe(0);
    expect(r.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("[kiosk-health] read failed");
  });
});
