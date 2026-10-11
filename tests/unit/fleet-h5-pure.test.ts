/**
 * TS-H5/H6/H9 (server): the power verbs, the poll-field cleaner for what the app reports about its helper, and the two attention rules (app_missing, helper_missing) as fixtures. Pure; every clock explicit.
 */
import { describe, it, expect } from "vitest";
import { CATALOGUE, FLEET_VERBS, CEILINGS, SESSION_GATED_VERBS, paramsValid } from "@/lib/fleet/verbs";
import { HELPER_FRESH_MS, hasReportedHelper, healthFromRow, helperAttention, isMissingSchema, type HelperSignals } from "@/lib/fleet/helper-health";
import { cleanPmsetDrift, cleanPollFields } from "@/lib/room-install";

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

describe("what the app reports on its bench poll: cleaned field by field (cleanPollFields), absent stays absent", () => {
  const base = { install_id: "inst_x" };
  const clean = (over: Record<string, unknown>) => cleanPollFields({ ...base, ...over } as never);
  it("an app that sends none of them (below 0.1.35) yields all nulls", () => {
    expect(clean({})).toMatchObject({ helper_version: null, helper_registration: null, helper_xpc_ok: null, helper_state: null, console_user: null, power_schedule: null, pmset_drift: null });
  });
  it("good values pass; each bad one is dropped on its own without touching the others", () => {
    const out = clean({ helper_version: "0.2.0-h3", helper_registration: "enabled", helper_xpc_ok: true, helper_state: "ok", console_user: false, power_schedule: "MTWRFSU 07:05", pmset_drift: "sleep,womp" });
    expect(out).toMatchObject({ helper_version: "0.2.0-h3", helper_registration: "enabled", helper_xpc_ok: true, helper_state: "ok", console_user: false, power_schedule: "MTWRFSU 07:05", pmset_drift: '["sleep","womp"]' });
    const bad = clean({ helper_version: "x y", helper_registration: "yes", helper_xpc_ok: "true", helper_state: "Not OK!", console_user: "1", power_schedule: "a\nb", pmset_drift: "SLEEP;rm" });
    expect(bad).toMatchObject({ helper_version: null, helper_registration: null, helper_xpc_ok: null, helper_state: null, console_user: null, power_schedule: null, pmset_drift: null });
    expect(clean({ helper_state: "xpc_down", helper_version: "x".repeat(40) })).toMatchObject({ helper_state: "xpc_down", helper_version: null });
    expect(clean({ helper_state: "x".repeat(33) }).helper_state).toBeNull();
  });
  it("pmset_drift: empty string = none drifted; at most 20 short tokens; any junk token = not reported (never a partial list)", () => {
    expect(cleanPmsetDrift("")).toBe("[]");
    expect(cleanPmsetDrift("a, b ,a")).toBe('["a","b"]');
    expect(cleanPmsetDrift(Array.from({ length: 20 }, (_, i) => `k${i}`).join(","))).not.toBeNull();
    expect(cleanPmsetDrift(Array.from({ length: 21 }, (_, i) => `k${i}`).join(","))).toBeNull();
    for (const junk of ["a,,b", "a,B", "x".repeat(49), "a;b", 5, null, undefined]) expect(cleanPmsetDrift(junk), String(junk)).toBeNull();
  });
  it("healthFromRow bounds what it reads back; hasReportedHelper tells an old app from a new one", () => {
    expect(hasReportedHelper(healthFromRow({}))).toBe(false);
    const h = healthFromRow({ helper_version: "0.2.0", helper_state: "ok", helper_xpc_ok: true, power_schedule: "MTWRFSU 07:05", pmset_drift: ["sleep", 5, "x".repeat(49)], console_user: true, helper_registration: "enabled" });
    expect(h).toMatchObject({ helper_state: "ok", pmset_drift: ["sleep"], console_user: true });
    expect(hasReportedHelper(h)).toBe(true);
    expect(healthFromRow({ pmset_drift: { a: 1 } }).pmset_drift).toEqual([]);
  });
});

describe("attention rules app_missing / helper_missing (fixtures)", () => {
  // 11 Oct 2026 is a Sunday; the rules do not care. 10:00 IST is inside clinic hours (07:30-21:30), 22:00 IST is outside.
  const DAY = Date.parse("2026-10-11T10:00:00+05:30");
  const NIGHT = Date.parse("2026-10-11T22:00:00+05:30");
  const iso = (now: number, s: number) => new Date(now - s * 1000).toISOString();
  const sig = (now: number, over: Partial<HelperSignals> = {}): HelperSignals => ({ bench_at: iso(now, 1), helper_state: "ok", helper_xpc_ok: true, helper_bad_since: null, console_user: true, ...over });
  const att = (s: HelperSignals, now = DAY) => helperAttention(s, now, "OPD 9");

  it("a healthy room raises nothing, by day or by night", () => {
    expect(att(sig(DAY))).toBeNull();
    expect(att(sig(NIGHT), NIGHT)).toBeNull();
  });

  describe("helper_missing: the app is polling and has reported the helper not ok for 3 min", () => {
    const bad = (now: number, over: Partial<HelperSignals> = {}) => sig(now, { helper_state: "xpc_down", helper_bad_since: iso(now, 240), ...over });
    it("state not ok for over 3 min with a fresh bench poll = AMBER, since the moment it went bad", () => {
      expect(att(bad(DAY))).toMatchObject({ kind: "helper_missing", severity: "amber", since_ms: DAY - 240_000 });
      expect(att(bad(DAY))!.detail).toContain("OPD 9");
    });
    it("xpc false alone counts, even with state ok", () => {
      expect(att(sig(DAY, { helper_state: "ok", helper_xpc_ok: false, helper_bad_since: iso(DAY, 240) }))).toMatchObject({ kind: "helper_missing" });
      expect(att(sig(DAY, { helper_state: null, helper_xpc_ok: false, helper_bad_since: iso(DAY, 240) }))).toMatchObject({ kind: "helper_missing" });
    });
    it("boundary: bad for 180 s is not yet, 181 s is", () => {
      expect(HELPER_FRESH_MS).toBe(180_000);
      expect(att(bad(DAY, { helper_bad_since: iso(DAY, 180) }))).toBeNull();
      expect(att(bad(DAY, { helper_bad_since: iso(DAY, 181) }))).toMatchObject({ kind: "helper_missing" });
    });
    it("a healthy reading wins over a stale helper_bad_since (the column can never raise on a room that now reads ok)", () => {
      expect(att(sig(DAY, { helper_state: "ok", helper_xpc_ok: true, helper_bad_since: iso(DAY, 900) }))).toBeNull();
    });
    it("never reported (an app below 0.1.35: no state, no xpc, no bad_since) raises nothing — not reported is not 'not ok'", () => {
      expect(att(sig(DAY, { helper_state: null, helper_xpc_ok: null, helper_bad_since: null }))).toBeNull();
      expect(att(sig(DAY, { helper_state: "xpc_down", helper_bad_since: null }))).toBeNull(); // bad but the server has not yet seen it for any time
    });
    it("needs the app polling: with the bench poll stale this is not 'helper missing' (it is the app's problem)", () => {
      const r = att(bad(DAY, { bench_at: iso(DAY, 600) }));
      expect(r === null || r.kind === "app_missing").toBe(true);
      expect(att(bad(DAY, { bench_at: iso(DAY, 181), console_user: false }))).toBeNull();
    });
    it("also raised at night: the control channel is down whatever the hour", () => {
      expect(att(bad(NIGHT), NIGHT)).toMatchObject({ kind: "helper_missing" });
    });
  });

  describe("app_missing: no bench poll for 3 min, during clinic hours, when the last report had a console user", () => {
    const gone = (over: Partial<HelperSignals> = {}) => sig(DAY, { bench_at: iso(DAY, 240), ...over });
    it("RED, since the last bench poll", () => {
      expect(att(gone())).toMatchObject({ kind: "app_missing", severity: "red", since_ms: DAY - 240_000 });
    });
    it("boundary: a poll 180 s old is fresh, 181 s is missing", () => {
      expect(att(sig(DAY, { bench_at: iso(DAY, 180) }))).toBeNull();
      expect(att(sig(DAY, { bench_at: iso(DAY, 181) }))).toMatchObject({ kind: "app_missing" });
    });
    it("needs the last report to have had a console user: false or unknown = nothing (the login window is not an outage)", () => {
      expect(att(gone({ console_user: false }))).toBeNull();
      expect(att(gone({ console_user: null }))).toBeNull();
    });
    it("only 07:30-21:30 IST: an evening shutdown is normal. Edges: 07:29 no, 07:30 yes, 21:29 yes, 21:30 no", () => {
      const at = (hhmm: string) => Date.parse(`2026-10-11T${hhmm}:00+05:30`);
      const at2 = (hhmm: string) => helperAttention(sig(at(hhmm), { bench_at: iso(at(hhmm), 240) }), at(hhmm), "OPD 9");
      expect(at2("07:29")).toBeNull();
      expect(at2("07:30")).toMatchObject({ kind: "app_missing" });
      expect(at2("21:29")).toMatchObject({ kind: "app_missing" });
      expect(at2("21:30")).toBeNull();
      expect(att(sig(NIGHT, { bench_at: iso(NIGHT, 7200) }), NIGHT)).toBeNull();
    });
    it("an install that never polled raises nothing", () => {
      expect(att(gone({ bench_at: null }))).toBeNull();
    });
  });

  it("the two rules are mutually exclusive across a grid of bench ages and bad durations", () => {
    for (const b of [1, 100, 179, 181, 400, null]) for (const bad of [null, 100, 181, 900]) {
      const r = att(sig(DAY, { bench_at: b === null ? null : iso(DAY, b), helper_state: bad === null ? "ok" : "xpc_down", helper_bad_since: bad === null ? null : iso(DAY, bad) }));
      if (r?.kind === "helper_missing") expect(b !== null && b <= 180).toBe(true);
      if (r?.kind === "app_missing") expect(b === null || b > 180).toBe(true);
    }
  });

  it("isMissingSchema is by Postgres code only (undefined_column 42703, undefined_table 42P01)", () => {
    expect(isMissingSchema({ code: "42703" })).toBe(true);
    expect(isMissingSchema({ code: "42P01" })).toBe(true);
    expect(isMissingSchema({ code: "23505" })).toBe(false);
    expect(isMissingSchema(new Error('column "helper_state" does not exist'))).toBe(false);
    expect(isMissingSchema(null)).toBe(false);
  });
});
