/**
 * TS-H5/H6/H9 (server): the power verbs, the heartbeat sanitiser and the two attention rules (app_missing, helper_missing) as fixtures. Pure; every clock explicit.
 */
import { describe, it, expect } from "vitest";
import { CATALOGUE, FLEET_VERBS, CEILINGS, SESSION_GATED_VERBS, paramsValid } from "@/lib/fleet/verbs";
import { HELPER_FRESH_MS, helperAttention, isMissingTable, parseHelperHeartbeat, signalsFor, type HelperSignals } from "@/lib/fleet/helper-health";

describe("power verbs (#43) and gates constants (#42)", () => {
  it("pmset_enforce takes no params; schedule_poweron takes an optional zero-padded 24-hour HH:MM and nothing else", () => {
    expect(paramsValid("pmset_enforce", {})).toBe(true);
    expect(paramsValid("pmset_enforce", { sleep: 0 })).toBe(false);
    for (const ok of [{}, { time: "07:05" }, { time: "00:00" }, { time: "23:59" }]) expect(paramsValid("schedule_poweron", ok), JSON.stringify(ok)).toBe(true);
    for (const bad of [{ time: "7:05" }, { time: "24:00" }, { time: "07:60" }, { time: "07:05:00" }, { time: 705 }, { time: "07-05" }, { time: "07:05 " }, { when: "07:05" }, { time: "07:05", days: "MTWRFSU" }, null]) {
      expect(paramsValid("schedule_poweron", bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it("both are helper verbs in the power group, unprivileged; `wake` stays a helper verb", () => {
    for (const v of ["pmset_enforce", "schedule_poweron"] as const) expect(CATALOGUE[v]).toMatchObject({ group: "power", runs: "helper", privileged: false, readOnly: false });
    expect(CATALOGUE.wake).toMatchObject({ group: "helper", privileged: false });
    expect(FLEET_VERBS).toHaveLength(15);
  });
  it("the session-gated set is the four privileged reset/restart verbs; the ceilings are 1 reset per 30 min and 10 privileged per hour", () => {
    expect([...SESSION_GATED_VERBS].sort()).toEqual(["coreaudiod_reset", "reload_launchagent", "restart_recorder", "usb_reseat"]);
    expect(SESSION_GATED_VERBS.every((v) => CATALOGUE[v].privileged)).toBe(true);
    expect(CEILINGS).toEqual({ coreaudiod_reset: { max: 1, windowS: 1800 }, privileged: { max: 10, windowS: 3600 } });
  });
});

describe("parseHelperHeartbeat: only sanitised, typed fields get through", () => {
  const good = { helper_version: "0.2.0", app_version: "0.1.30", registration: "enabled", xpc_ok: true, app_state: "running", console_user: true, session_open: false, power_schedule: "MTWRFSU 07:05", pmset_drift: ["sleep"], chrome_policy: "ok", poll_last_ok_s: 3, safe_mode: false };
  it("passes a good payload through unchanged", () => expect(parseHelperHeartbeat(good)).toEqual(good));
  it("drops unknown keys (no free text, no secrets) and turns wrong types, unknown enums and control characters into null", () => {
    const out = parseHelperHeartbeat({ ...good, token: "SECRETMARK", breakglass: { what: "sshd" }, registration: "yes", app_state: "exploded", xpc_ok: "true", power_schedule: "a\nb", helper_version: "x".repeat(33), poll_last_ok_s: -1, chrome_policy: " " });
    expect(JSON.stringify(out)).not.toContain("SECRETMARK");
    expect(out).toMatchObject({ registration: null, app_state: null, xpc_ok: null, power_schedule: null, helper_version: null, poll_last_ok_s: null, chrome_policy: null });
    expect(Object.keys(out).sort()).toEqual(Object.keys(parseHelperHeartbeat(good)).sort());
  });
  it("pmset_drift: at most 20 short clean tokens; junk entries are dropped; a non-array is empty", () => {
    expect(parseHelperHeartbeat({ pmset_drift: Array.from({ length: 30 }, (_, i) => `k${i}`) }).pmset_drift).toHaveLength(20);
    expect(parseHelperHeartbeat({ pmset_drift: ["ok", 5, "x".repeat(49), "bad\u0000", ""] }).pmset_drift).toEqual(["ok"]);
    expect(parseHelperHeartbeat({ pmset_drift: "sleep" }).pmset_drift).toEqual([]);
    for (const junk of [null, undefined, 5, "x", [], [1]]) expect(parseHelperHeartbeat(junk).pmset_drift).toEqual([]);
  });
});

describe("attention rules app_missing / helper_missing (fixtures)", () => {
  const NOW = Date.parse("2026-10-11T10:00:00.000Z");
  const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
  const hb = (over: Record<string, unknown> = {}) => parseHelperHeartbeat({ app_state: "running", console_user: true, ...over });
  const sig = (over: Partial<HelperSignals> = {}): HelperSignals => ({ registered: true, registered_at: ago(86_400), helper_poll_at: ago(10), heartbeat_at: ago(20), heartbeat: hb(), bench_at: ago(1), ...over });
  const att = (s: HelperSignals) => helperAttention(s, NOW, "OPD 9");

  it("a healthy room raises nothing", () => expect(att(sig())).toBeNull());

  describe("app_missing", () => {
    const missing = (over: Partial<HelperSignals> = {}) => sig({ bench_at: ago(240), ...over });
    it("helper heartbeat fresh + console user + no bench poll for over 3 min = RED, since the last bench poll", () => {
      expect(att(missing())).toMatchObject({ kind: "app_missing", severity: "red", since_ms: NOW - 240_000 });
      expect(att(missing())!.detail).toContain("OPD 9");
    });
    it("never polled at all: raised, since the heartbeat", () => expect(att(missing({ bench_at: null }))).toMatchObject({ kind: "app_missing", since_ms: NOW - 20_000 }));
    it("boundary: a bench poll 180 s old is fresh, 181 s is not", () => {
      expect(HELPER_FRESH_MS).toBe(180_000);
      expect(att(sig({ bench_at: ago(180) }))).toBeNull();
      expect(att(sig({ bench_at: ago(181) }))).toMatchObject({ kind: "app_missing" });
    });
    it("boundary: the helper heartbeat must itself be fresh (180 s ok, 181 s not)", () => {
      expect(att(missing({ heartbeat_at: ago(180) }))).toMatchObject({ kind: "app_missing" });
      expect(att(missing({ heartbeat_at: ago(181), helper_poll_at: ago(181) }))).toBeNull();
    });
    it("needs a console user: false, unknown, or no heartbeat content = no alert", () => {
      expect(att(missing({ heartbeat: hb({ console_user: false }) }))).toBeNull();
      expect(att(missing({ heartbeat: hb({ console_user: undefined }) }))).toBeNull();
      expect(att(missing({ heartbeat: null }))).toBeNull();
    });
    it("deliberate or unattended states are not alerts: needs_enrol, retired, no_console_user (no relaunch spam at the login window)", () => {
      for (const st of ["needs_enrol", "retired", "no_console_user"]) expect(att(missing({ heartbeat: hb({ app_state: st }) })), st).toBeNull();
      for (const st of ["running", "missing", undefined]) expect(att(missing({ heartbeat: hb({ app_state: st }) })), String(st)).toMatchObject({ kind: "app_missing" });
    });
  });

  describe("helper_missing", () => {
    const silent = (over: Partial<HelperSignals> = {}) => sig({ heartbeat_at: ago(240), helper_poll_at: ago(250), ...over });
    it("registered, the app polling, the helper silent for over 3 min = AMBER, since its last sign of life", () => {
      expect(att(silent())).toMatchObject({ kind: "helper_missing", severity: "amber", since_ms: NOW - 240_000 });
    });
    it("a fresh long-poll OR a fresh heartbeat is enough to be 'reporting'", () => {
      expect(att(silent({ helper_poll_at: ago(30) }))).toBeNull();
      expect(att(silent({ heartbeat_at: ago(30) }))).toBeNull();
    });
    it("boundary: 180 s of silence is fine, 181 s raises", () => {
      expect(att(sig({ heartbeat_at: ago(180), helper_poll_at: ago(180) }))).toBeNull();
      expect(att(sig({ heartbeat_at: ago(181), helper_poll_at: ago(181) }))).toMatchObject({ kind: "helper_missing" });
    });
    it("registered but never heard from: measured from the registration", () => {
      expect(att(silent({ heartbeat_at: null, heartbeat: null, helper_poll_at: null, registered_at: ago(600) }))).toMatchObject({ kind: "helper_missing", since_ms: NOW - 600_000 });
      expect(att(silent({ heartbeat_at: null, heartbeat: null, helper_poll_at: null, registered_at: ago(60) }))).toBeNull();
    });
    it("an UNREGISTERED room (no active device) never raises it, however silent", () => {
      expect(att(silent({ registered: false }))).toBeNull();
    });
    it("needs the app polling: with the bench poll stale this is the app's problem or the Mac's, not 'helper missing'", () => {
      expect(att(silent({ bench_at: ago(600) }))).toBeNull();
      expect(att(silent({ bench_at: null }))).toBeNull();
    });
  });

  it("the two rules are mutually exclusive across a grid of ages", () => {
    const ages = [1, 100, 179, 181, 400, null] as const;
    for (const b of ages) for (const h of ages) for (const p of ages) {
      const r = att(sig({ bench_at: b === null ? null : ago(b), heartbeat_at: h === null ? null : ago(h), helper_poll_at: p === null ? null : ago(p), heartbeat: h === null ? null : hb() }));
      expect(r === null || r.kind === "app_missing" || r.kind === "helper_missing").toBe(true);
    }
    // app_missing needs bench stale; helper_missing needs bench fresh: so whichever fires, the other's precondition is false
    expect(att(sig({ bench_at: ago(400), heartbeat_at: ago(400), helper_poll_at: ago(400) }))).toBeNull();
  });

  it("signalsFor: no device = unregistered; a revoked device is not registered; heartbeats are matched by machine spelling", () => {
    const beats = new Map([["ehrc-opd9s-mac-mini", { received_at: ago(5), health: hb() }]]);
    expect(signalsFor(undefined, "EHRC-OPD9s-Mac-mini", beats, ago(1)).registered).toBe(false);
    expect(signalsFor({ status: "revoked", registered_at: ago(9), last_poll_at: null }, null, beats, null).registered).toBe(false);
    expect(signalsFor({ status: "active", registered_at: ago(9), last_poll_at: ago(2) }, "EHRC-OPD9s-Mac-mini", beats, ago(1))).toMatchObject({ registered: true, heartbeat_at: ago(5), helper_poll_at: ago(2) });
    expect(signalsFor({ status: "active", registered_at: ago(9), last_poll_at: null }, "OTHER", beats, null).heartbeat_at).toBeNull();
  });

  it("isMissingTable is by Postgres code only", () => {
    expect(isMissingTable({ code: "42P01" })).toBe(true);
    expect(isMissingTable({ code: "42703" })).toBe(false);
    expect(isMissingTable(new Error('relation "fleet_devices" does not exist'))).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});
