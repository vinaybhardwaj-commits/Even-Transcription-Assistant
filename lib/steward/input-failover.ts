/**
 * lib/steward/input-failover.ts — Room Steward: webcam-first input with automatic TONOR failover (V decision 9 Oct 2026; a second live action beside start_day).
 *
 * Behind steward_config `input_failover_live` ({"on": bool}, default false) and the global kill switch. Off = the same rules still run and write SHADOW rows
 * ("shadow: would set_audio_input"); kill switch on = rows with result "kill_switch". Only on = a real set_audio_input through lib/bench-commands.ts insertCommand
 * (source "steward"; the path scribe_set_audio_input uses, validator included). Never stops, pauses or restarts the recorder or Chrome.
 *
 * ROOMS      OPD 1, 3, 4, 5, 6, 7, Cardiology, Dietary. Never ORB2, ORB3, Home Office, Audiometry, any dev/test-flagged room.
 * DEVICES    preference order by name: webcam /C270|webcam/i, then TONOR /tonor/i. No other device is ever selected.
 * RULES      3  session start (first 15 min of the session, once): webcam enumerated and the recorder not on it -> set_audio_input webcam.
 *            4  session open and the current device's level samples are digital zero (zero_ratio >= 0.98) for >= 90 s with the newest sample <= 30 s old, OR the
 *               current device is no longer enumerated -> the other preferred device IF enumerated. One command. Nothing enumerated to go to -> one alert.
 *            5  60 s after the switch (30 s ack grace) the tape must not still be zero: if it is, ONE alert (input_failover_alert) and no more switching for the
 *               room until the enumeration changes or the next session.
 *            6  on the TONOR backup: back to the webcam only if the webcam was re-enumerated (absent in a later tick, then present) after the failover; else at the
 *               next session start (rule 3). A dead webcam is never probed mid-consult.
 *            7  max 4 switches per room per IST day; >= 10 min between switches unless the current device vanished.
 *            8  every switch/hold/alert is a decision row (input_failover / input_failover_hold / input_failover_alert).
 * MEMORY     the room's own decision rows (no new table). Enumeration changes are input_failover_enum rows (written when the device-uid set differs from the newest one).
 * INFERRED   against 0079 (room_install.input_devices jsonb [{name, uid, is_default}], input_device_name, app_version) and bench_level_sample (room_id, sampled_at, zero_ratio).
 */
import { istMidnightOf } from "./config";
import type { Config } from "./config";
import { raceTimeout } from "./timeout";
import type { Decision, RecentAction } from "./rules";
import type { StewardSql } from "./tickets";
import { createHash } from "node:crypto";

export const INPUT_FAILOVER_KEY = "input_failover_live";
export const SWITCH_RULE = "input_failover";
export const HOLD_RULE = "input_failover_hold";
export const ALERT_RULE_INPUT = "input_failover_alert";
export const ENUM_RULE = "input_failover_enum";

/** clinic kiosk rooms the rule applies to (V: OPD 1,3,4,5,6,7, Cardiology, Dietary) */
export const FAILOVER_ROOM_RE = /^\s*(opd\s*(1|3|4|5|6|7)|cardiology|dietary)\b/i;
export const NEVER_FAILOVER_RE = /orb\s*2|orb\s*3|home\s*office|audiometry/i;
export const WEBCAM_RE = /c270|webcam/i;
export const TONOR_RE = /tonor/i;

export const ZERO_RATIO = 0.98;
export const ZERO_SECONDS = 90;
export const NEWEST_SAMPLE_MAX_MS = 30_000;
export const VERIFY_MS = 60_000;
export const ACK_GRACE_MS = 30_000;
export const SESSION_START_WINDOW_MS = 15 * 60_000;
export const MAX_SWITCHES_PER_DAY = 4;
export const MIN_BETWEEN_SWITCHES_MS = 10 * 60_000;
export const HOLD_REFRESH_MS = 15 * 60_000;
export const LEVELS_LOOKBACK_MIN = 5;

export type InputDevice = { name: string; uid: string; is_default: boolean };
export type InputState = { app_version: string | null; current_name: string | null; devices: InputDevice[] };
export type LevelSample = { t: number; z: number | null };

export const classify = (name: string | null | undefined): "webcam" | "tonor" | null => {
  if (!name) return null;
  if (WEBCAM_RE.test(name)) return "webcam";
  if (TONOR_RE.test(name)) return "tonor";
  return null;
};

export function failoverEligible(room: { room_name: string; flags: readonly string[] }, cfg: Config, roomId: string): boolean {
  if (NEVER_FAILOVER_RE.test(room.room_name) || !FAILOVER_ROOM_RE.test(room.room_name)) return false;
  const flags = [...room.flags, ...(cfg.rooms[roomId]?.flags ?? [])].map((f) => f.toLowerCase());
  return !flags.some((f) => f === "dev" || f === "test");
}

/** steward_config.input_failover_live on AND the kill switch off */
export const shouldArmFailover = (cfg: Config): boolean => cfg.input_failover_live === true && cfg.kill_switch === false;

/** PURE. Start of the trailing run of digital-zero samples, only if the newest sample is <= 30 s old; else null. */
export function zeroRunSince(samples: readonly LevelSample[], A: number): number | null {
  const s = [...samples].filter((x) => Number.isFinite(x.t) && x.t <= A).sort((a, b) => a.t - b.t);
  if (s.length === 0 || A - s[s.length - 1]!.t > NEWEST_SAMPLE_MAX_MS) return null;
  let i = s.length - 1;
  while (i >= 0 && s[i]!.z !== null && (s[i]!.z as number) >= ZERO_RATIO) i--;
  return i < s.length - 1 ? s[i + 1]!.t : null;
}

const uidsKey = (devices: readonly InputDevice[]): string => devices.map((d) => d.uid).sort().join("|");

/** PURE. The params of an input_failover_enum row to write now, or null when the newest enum row already says the same. */
export function enumChange(input: InputState | null, recent: readonly RecentAction[]): { uids: string; webcam: boolean; tonor: boolean; n: number } | null {
  if (!input) return null;
  const uids = uidsKey(input.devices);
  const newest = recent.filter((r) => r.rule === ENUM_RULE).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  if (newest && newest.params.uids === uids) return null;
  return { uids, webcam: input.devices.some((d) => classify(d.name) === "webcam"), tonor: input.devices.some((d) => classify(d.name) === "tonor"), n: input.devices.length };
}

export type FailoverInput = {
  roomId: string;
  roomName: string;
  A: number;
  /** the loop's own sense of the room */
  session: { open: boolean | null; status: "recording" | "paused" | null; started_at: string | null };
  input: InputState | null;
  /** raw start of the trailing digital-zero run (zeroRunSince), null = none */
  zeroSince: number | null;
  /** the room's decisions of the last 24 h, any order */
  recent: readonly RecentAction[];
  /** audioInputRefusal(app_version) from lib/bench-commands, passed in so this file stays pure */
  appTooOld?: boolean;
};

export type FailoverVerdict =
  | { kind: "none"; facts: Record<string, unknown> }
  | { kind: "switch"; reason: "session_start_webcam" | "failover_zero" | "failover_vanished" | "webcam_reenumerated"; to: InputDevice; from: string | null; zero_s: number | null; facts: Record<string, unknown> }
  | { kind: "hold"; reason: "daily_cap" | "spacing" | "held_after_alert" | "app_too_old" | "not_listening"; facts: Record<string, unknown> }
  | { kind: "alert"; reason: "no_alternate" | "still_zero_after_switch"; devices: string[]; facts: Record<string, unknown> };

const isSwitchRow = (r: RecentAction): boolean => r.rule === SWITCH_RULE;
/** a switch that really went out (outcome ok, or failed on insert): a shadow / kill_switch row changed nothing on the Mac and counts toward neither the cap nor the spacing */
const isLiveSwitchRow = (r: RecentAction): boolean => isSwitchRow(r) && (r.outcome === "ok" || r.outcome === "failed");

/** PURE. At most one verdict per room per tick. */
export function evaluateInputFailover(inp: FailoverInput): FailoverVerdict {
  const { A, recent } = inp;
  const facts: Record<string, unknown> = {};
  const none = (): FailoverVerdict => ({ kind: "none", facts });
  const inp_ = inp.input;
  if (!inp_ || inp.session.open !== true || inp.session.status !== "recording") return none();
  const sessionStart = inp.session.started_at ? Date.parse(inp.session.started_at) : NaN;
  const midnight = istMidnightOf(A);

  const devices = inp_.devices;
  const byName = (n: string | null): InputDevice | undefined => (n ? devices.find((d) => d.name === n) : undefined);
  const cur = byName(inp_.current_name);
  const curKind = classify(inp_.current_name);
  const vanished = inp_.current_name !== null && !cur;
  const webcam = devices.find((d) => classify(d.name) === "webcam");
  const tonor = devices.find((d) => classify(d.name) === "tonor");
  facts.current = inp_.current_name;
  facts.webcam_enumerated = !!webcam;
  facts.tonor_enumerated = !!tonor;

  const switches = recent.filter(isSwitchRow).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  // fable ruling 3: only LIVE outcomes count toward the 4/day cap and the 10-min spacing (shadow rows still say "this session already had its switch")
  const liveSwitches = switches.filter(isLiveSwitchRow);
  const last = liveSwitches[0];
  const lastTs = last ? Date.parse(last.ts) : null;
  // fable ruling 4: a session-start webcam switch is exempt from the spacing (neither blocked by it nor the start of its clock) but counts toward the cap
  const lastSpaced = liveSwitches.find((r) => r.params.reason !== "session_start_webcam");
  const spacedTs = lastSpaced ? Date.parse(lastSpaced.ts) : null;
  const today = liveSwitches.filter((r) => Date.parse(r.ts) >= midnight && Date.parse(r.ts) <= A);
  facts.switches_today = today.length;

  // hold after an alert: until the enumeration changes (a later input_failover_enum row) or the next session
  const alerts = recent.filter((r) => r.rule === ALERT_RULE_INPUT).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const enums = recent.filter((r) => r.rule === ENUM_RULE);
  const alert = alerts[0];
  const alertTs = alert ? Date.parse(alert.ts) : null;
  const sessionAlerted = alertTs !== null && (!Number.isFinite(sessionStart) || alertTs >= sessionStart);
  const held = sessionAlerted && !enums.some((r) => Date.parse(r.ts) > (alertTs as number));

  const gate = (vanishedOk: boolean, spaced = true): FailoverVerdict | null => {
    if (today.length >= MAX_SWITCHES_PER_DAY) return { kind: "hold", reason: "daily_cap", facts };
    if (spaced && spacedTs !== null && A - spacedTs < MIN_BETWEEN_SWITCHES_MS && !vanishedOk) return { kind: "hold", reason: "spacing", facts: { ...facts, since_last_switch_s: Math.round((A - spacedTs) / 1000) } };
    return null;
  };

  // rule 5: verify the last switch (D2: only a switch whose result starts with "ok" was really queued: a shadow row, a held row and a "failed: ..." insert changed nothing on the Mac)
  if (last && last.outcome === "ok" && lastTs !== null && lastTs >= (Number.isFinite(sessionStart) ? sessionStart : 0) && A - lastTs >= VERIFY_MS + ACK_GRACE_MS && inp.zeroSince !== null && inp.zeroSince <= lastTs + ACK_GRACE_MS + 15_000) {
    const alerted = alerts.some((r) => Date.parse(r.ts) >= lastTs);
    if (!alerted) {
      return { kind: "alert", reason: "still_zero_after_switch", devices: [inp_.current_name ?? "unknown", ...(webcam ? [webcam.name] : []), ...(tonor ? [tonor.name] : [])], facts: { ...facts, zero_since_switch_s: Math.round((A - Math.max(inp.zeroSince, lastTs)) / 1000) } };
    }
  }
  if (held) return { kind: "hold", reason: "held_after_alert", facts };
  if (inp.appTooOld) return { kind: "hold", reason: "app_too_old", facts };

  // rule 3: session start
  const sessionSwitch = Number.isFinite(sessionStart) ? switches.some((r) => Date.parse(r.ts) >= sessionStart) : true;
  if (Number.isFinite(sessionStart) && A - sessionStart <= SESSION_START_WINDOW_MS && !sessionSwitch && webcam && curKind !== "webcam" && cur !== webcam) {
    const g = gate(vanished, false);
    if (g) return g;
    return { kind: "switch", reason: "session_start_webcam", to: webcam, from: inp_.current_name, zero_s: null, facts };
  }

  // rule 6: back to the webcam after a re-enumeration
  if (curKind === "tonor" && webcam && lastTs !== null) {
    const failedOverToTonor = last!.params.reason === "failover_zero" || last!.params.reason === "failover_vanished";
    if (failedOverToTonor) {
      const after = enums.filter((r) => Date.parse(r.ts) > lastTs).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      const absentAt = after.findIndex((r) => r.params.webcam === false);
      const reenum = absentAt >= 0 && after.slice(absentAt + 1).some((r) => r.params.webcam === true);
      if (reenum) {
        const g = gate(false);
        if (g) return g;
        return { kind: "switch", reason: "webcam_reenumerated", to: webcam, from: inp_.current_name, zero_s: null, facts };
      }
    }
  }

  // rule 4: failover
  const effSince = inp.zeroSince === null ? null : Math.max(inp.zeroSince, lastTs !== null ? lastTs + ACK_GRACE_MS : 0);
  const zeroS = effSince === null ? null : Math.round((A - effSince) / 1000);
  facts.zero_s = zeroS;
  const zeroLong = zeroS !== null && zeroS >= ZERO_SECONDS;
  if (!vanished && !zeroLong) return none();
  const preferred = [webcam, tonor].filter((d): d is InputDevice => !!d && d !== cur);
  const to = preferred[0];
  if (!to) {
    return { kind: "alert", reason: "no_alternate", devices: [inp_.current_name ?? "unknown"], facts };
  }
  const g = gate(vanished);
  if (g) return g;
  return { kind: "switch", reason: vanished ? "failover_vanished" : "failover_zero", to, from: inp_.current_name, zero_s: zeroS, facts };
}

// ---------------------------------------------------------------------------
// reads (two statements per tick, only for eligible rooms)
// ---------------------------------------------------------------------------

export async function readInputStates(sql: StewardSql, roomIds: string[], timeoutMs: number): Promise<Map<string, InputState> | null> {
  if (roomIds.length === 0) return new Map();
  try {
    const rows = await raceTimeout(
      async () =>
        (await sql`
          SELECT room_id, input_device_name, input_devices, app_version
            FROM room_install
           WHERE room_id = ANY(${roomIds}::text[]) AND retired_at IS NULL AND enrolled_at IS NOT NULL
        `) as unknown as Array<{ room_id: string; input_device_name: unknown; input_devices: unknown; app_version: unknown }>,
      timeoutMs,
    );
    const out = new Map<string, InputState>();
    for (const r of rows) {
      let list: unknown = r.input_devices;
      if (typeof list === "string") {
        try {
          list = JSON.parse(list);
        } catch {
          list = null;
        }
      }
      if (!Array.isArray(list)) continue; // device list not reported: no judgement
      const devices: InputDevice[] = [];
      for (const d of list) {
        const o = d as Record<string, unknown>;
        if (typeof o?.name === "string" && typeof o?.uid === "string") devices.push({ name: o.name.slice(0, 120), uid: o.uid.slice(0, 256), is_default: o.is_default === true });
      }
      out.set(r.room_id, { app_version: typeof r.app_version === "string" ? r.app_version : null, current_name: typeof r.input_device_name === "string" ? r.input_device_name : null, devices });
    }
    return out;
  } catch {
    return null;
  }
}

export async function readZeroSince(sql: StewardSql, roomIds: string[], A: number, timeoutMs: number): Promise<Map<string, number | null> | null> {
  const out = new Map<string, number | null>();
  if (roomIds.length === 0) return out;
  const hi = new Date(A).toISOString();
  try {
    const rows = await raceTimeout(
      async () =>
        (await sql`
          SELECT b.room_id, b.sampled_at, b.zero_ratio
            FROM bench_level_sample b
           WHERE b.room_id = ANY(${roomIds}::text[])
             AND b.ist_date >= ((${hi}::timestamptz - make_interval(mins => ${LEVELS_LOOKBACK_MIN}::int)) AT TIME ZONE 'Asia/Kolkata')::date
             AND b.sampled_at > ${hi}::timestamptz - make_interval(mins => ${LEVELS_LOOKBACK_MIN}::int) AND b.sampled_at <= ${hi}::timestamptz
        `) as unknown as Array<{ room_id: string; sampled_at: unknown; zero_ratio: unknown }>,
      timeoutMs,
    );
    const by = new Map<string, LevelSample[]>();
    for (const r of rows) {
      const t = new Date(r.sampled_at as string | number | Date).getTime();
      const z = r.zero_ratio === null || r.zero_ratio === undefined || r.zero_ratio === "" ? null : Number(r.zero_ratio);
      const l = by.get(r.room_id) ?? [];
      l.push({ t, z: z !== null && Number.isFinite(z) ? z : null });
      by.set(r.room_id, l);
    }
    for (const id of roomIds) out.set(id, zeroRunSince(by.get(id) ?? [], A));
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the enqueue path (reused, not re-implemented)
// ---------------------------------------------------------------------------

export interface InputPort {
  /** lib/bench-commands.ts getListener + isListening */
  listening(roomId: string, now: Date): Promise<boolean>;
  /** lib/bench-commands.ts audioInputRefusal(app_version) !== null */
  tooOld(appVersion: string | null): boolean;
  insertCommand(i: { roomId: string; kind: "set_audio_input"; args?: unknown; source?: string }): Promise<string>;
}

export async function defaultInputPort(): Promise<InputPort> {
  const m = await import("@/lib/bench-commands");
  return {
    listening: async (roomId, now) => m.isListening(await m.getListener(roomId), now),
    tooOld: (v) => m.audioInputRefusal(v) !== null,
    insertCommand: m.insertCommand as never,
  };
}

export type SwitchResult = { sent: boolean; result: string };

/** ONE set_audio_input for the room, or the reason there was none. Never throws. */
export async function sendSwitch(port: InputPort, roomId: string, uid: string, A: number): Promise<SwitchResult> {
  try {
    if (!(await port.listening(roomId, new Date(A)))) return { sent: false, result: "held: kiosk_not_listening" };
    const id = await port.insertCommand({ roomId, kind: "set_audio_input", args: { device_uid: uid }, source: "steward" });
    return { sent: true, result: `ok: set_audio_input queued ${id}` };
  } catch (e) {
    return { sent: true, result: `failed: ${(e instanceof Error ? e.message : "error").replace(/\s+/g, " ").slice(0, 120)}` };
  }
}

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

const names = (v: { from: string | null; to: InputDevice }): string => `${v.from ?? "unknown"} -> ${v.to.name}`;

export const switchDecision = (d: Decision, room: { room_id: string; room_name: string }, v: Extract<FailoverVerdict, { kind: "switch" }>): Decision =>
  base(d, SWITCH_RULE, "log_only", { reason: v.reason, to_uid: v.to.uid, to_name: v.to.name, from_name: v.from, zero_s: v.zero_s }, `input failover: room ${room.room_name} (${room.room_id}) ${names(v)} (${v.reason}${v.zero_s !== null ? `, digital zero ${v.zero_s} s` : ""})`, null, "warn", v.facts);

export const holdDecision = (d: Decision, v: Extract<FailoverVerdict, { kind: "hold" }>): Decision =>
  base(d, HOLD_RULE, "log_only", { reason: v.reason }, `input failover held: ${v.reason}`, `set_audio_input held: ${v.reason}`, "info", v.facts);

export const alertInputDecision = (d: Decision, room: { room_id: string; room_name: string }, v: Extract<FailoverVerdict, { kind: "alert" }>): Decision =>
  base(d, ALERT_RULE_INPUT, "log_only", { reason: v.reason, devices: v.devices }, `input failover ALERT: room ${room.room_name} (${room.room_id}) ${v.reason === "no_alternate" ? "has no digital sound and nothing preferred to switch to" : "is still digital zero after the switch"}; devices: ${v.devices.join(", ")}; no further switching until the devices change or the next session`, null, "error", v.facts);

export const enumDecision = (d: Decision, p: { uids: string; webcam: boolean; tonor: boolean; n: number }): Decision =>
  base(d, ENUM_RULE, "log_only", p, `input devices changed: ${p.n} enumerated (webcam ${p.webcam ? "present" : "absent"}, tonor ${p.tonor ? "present" : "absent"})`, null, "info", {});

// ---------------------------------------------------------------------------
// row builder (the same shape rules.ts mk produces; these rows are always log_only and never an executor action)
// ---------------------------------------------------------------------------
const hash16 = (o: unknown): string => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);

function base(d: Decision, rule: string, action: Decision["action"], params: Record<string, unknown>, why: string, why_not: string | null, severity: Decision["severity"], extra: Record<string, unknown>): Decision {
  const inputs = { ...extra, via: "input_failover" };
  return { room_id: d.room_id, machine: d.machine, window_kind: d.window_kind, rule, action, params, why, why_not, severity, inputs_hash: hash16({ rule, action, params, ...extra }), inputs };
}
