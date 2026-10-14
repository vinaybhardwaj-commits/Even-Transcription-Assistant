/**
 * guardian/consult-alert (FR1-A) — recorder stopped during an OPEN consult window. Pure planner and composer, clock injected, mocked database. Fake ids only.
 */
import { describe, it, expect, vi } from "vitest";

const calls: string[] = [];
let responses: unknown[] = [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray) => {
    calls.push(strings.join("?").replace(/\s+/g, " ").trim());
    const next = responses.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  };
  return { sql, db: {} };
});

const A = await import("@/lib/alerts/ops-alert");
const S = await import("@/lib/alerts/ops-sweep");
const H = await import("@/lib/alerts/clinic-hours");
const at = (iso: string) => new Date(iso).getTime();
const NOW = at("2026-10-13T10:00:00+05:30");
const MIN = 60_000;
const OPD4 = "room_ux92qpws";
const liveAll = new Map<string, { mic_state: string | null }>();
const base = { now_ms: NOW, live_installs: null } as const;
const consultOnly = (plan: ReturnType<typeof S.planOpsAlerts>) => plan.filter((p) => p.consult_open);
// Other roster rooms have no chunk in these fixtures, so the plain rule fires for them in clinic hours; the assertions look at the consult alerts only.

describe("consult rule", () => {
  it("window open 10 min, last chunk 6 min ago -> one consult alert, window_open_min 10", () => {
    const plan = consultOnly(S.planOpsAlerts({ ...base, last_chunk_ms: new Map([[OPD4, NOW - 6 * MIN]]), open_windows: new Map([[OPD4, NOW - 10 * MIN]]) }));
    expect(plan).toEqual([{ kind: "recorder_off", room_id: OPD4, room_slug: OPD4, room_name: undefined, minutes: 6, consult_open: { window_open_min: 10 } }]);
  });
  it("window open 10 min, last chunk 4 min ago -> none (under the 5 min threshold)", () => {
    expect(S.planOpsAlerts({ ...base, last_chunk_ms: new Map([[OPD4, NOW - 4 * MIN]]), open_windows: new Map([[OPD4, NOW - 10 * MIN]]) }).filter((p) => p.room_id === OPD4)).toEqual([]);
  });
  it("window open 10 min, chunk 1 min ago -> none", () => {
    expect(S.planOpsAlerts({ ...base, last_chunk_ms: new Map([[OPD4, NOW - 1 * MIN]]), open_windows: new Map([[OPD4, NOW - 10 * MIN]]) }).filter((p) => p.room_id === OPD4)).toEqual([]);
  });
  it("window open 2 min -> none; window older than 90 min -> none", () => {
    expect(consultOnly(S.planOpsAlerts({ ...base, last_chunk_ms: new Map(), open_windows: new Map([[OPD4, NOW - 2 * MIN]]) }))).toEqual([]);
    expect(consultOnly(S.planOpsAlerts({ ...base, last_chunk_ms: new Map(), open_windows: new Map([[OPD4, NOW - 91 * MIN]]) }))).toEqual([]);
  });
  it("recorder already off before the window opened: the clock starts at t_open", () => {
    const plan = S.planOpsAlerts({ ...base, last_chunk_ms: new Map([[OPD4, NOW - 60 * MIN]]), open_windows: new Map([[OPD4, NOW - 5 * MIN]]) });
    expect(consultOnly(plan)).toHaveLength(1);
    expect(consultOnly(plan)[0]).toMatchObject({ minutes: 5, consult_open: { window_open_min: 5 } });
    // no chunk at all in the lookback: same
    expect(consultOnly(S.planOpsAlerts({ ...base, last_chunk_ms: new Map(), open_windows: new Map([[OPD4, NOW - 6 * MIN]]) }))).toHaveLength(1);
  });
  it("a closed window is not in the open map -> none; a room outside the roster -> none", () => {
    expect(consultOnly(S.planOpsAlerts({ ...base, last_chunk_ms: new Map(), open_windows: new Map() }))).toEqual([]);
    expect(consultOnly(S.planOpsAlerts({ ...base, last_chunk_ms: new Map(), open_windows: new Map([["room_not_in_roster", NOW - 10 * MIN]]) }))).toEqual([]);
  });
  it("fires at any hour (outside clinic hours too)", () => {
    const night = at("2026-10-13T23:30:00+05:30");
    const plan = S.planOpsAlerts({ now_ms: night, live_installs: null, last_chunk_ms: new Map(), open_windows: new Map([[OPD4, night - 10 * MIN]]) });
    expect(consultOnly(plan)).toHaveLength(1);
    expect(consultOnly(plan)[0]!.consult_open).toEqual({ window_open_min: 10 });
    expect(plan.some((p) => p.kind === "recorder_off" && !p.consult_open)).toBe(false); // the plain rule stays clinic-hours only
  });
  it("windows source null -> rule skipped, other rules still run", () => {
    const plan = S.planOpsAlerts({ now_ms: NOW, last_chunk_ms: new Map(), live_installs: liveAll, open_windows: null });
    expect(plan.some((p) => p.consult_open)).toBe(false);
    expect(plan.some((p) => p.kind === "no_machine")).toBe(true);
    expect(plan.some((p) => p.kind === "recorder_off")).toBe(true);
  });
  it("both rules on one room -> two alerts, two keys", () => {
    const plan = S.planOpsAlerts({ ...base, last_chunk_ms: new Map([[OPD4, NOW - 20 * MIN]]), open_windows: new Map([[OPD4, NOW - 30 * MIN]]) });
    const mine = plan.filter((p) => p.room_id === OPD4);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((p) => A.composeOpsAlert(p).dedupe_key))).toEqual(new Set(["recorder_off", "recorder_off_consult"]));
  });
  it("two open windows (30 and 2 min), recorder dead 20 min -> alert now: the map carries the OLDEST t_open", () => {
    const plan = consultOnly(S.planOpsAlerts({ ...base, last_chunk_ms: new Map([[OPD4, NOW - 20 * MIN]]), open_windows: new Map([[OPD4, NOW - 30 * MIN]]) }));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ minutes: 20, consult_open: { window_open_min: 30 } });
  });
  it("a future-dated window: the SQL drops it (t_open <= now()); if one ever reached the planner it would not page (negative open age)", () => {
    expect(consultOnly(S.planOpsAlerts({ ...base, last_chunk_ms: new Map(), open_windows: new Map([[OPD4, NOW + 10 * MIN]]) }))).toEqual([]);
  });
  it("the constant is 5", () => {
    expect(H.CONSULT_RECORDER_OFF_MINUTES).toBe(5);
  });
});

describe("compose", () => {
  it("plain recorder_off is byte for byte what it was", () => {
    expect(A.composeOpsAlert({ kind: "recorder_off", room_id: "room_x", room_slug: "opd-4", minutes: 47.6 })).toEqual({
      subject: "[ops] recorder_off opd-4", body: "room=opd-4 room_id=room_x problem=recorder_off minutes=48", dedupe_key: "recorder_off",
    });
  });
  it("consult variant: key, subject, body exact, and no forbidden fields", () => {
    const m = A.composeOpsAlert({ kind: "recorder_off", room_id: "room_x", room_slug: "opd-4", room_name: "OPD 4", minutes: 4, consult_open: { window_open_min: 10 } });
    expect(m).toEqual({
      subject: "[ops] recorder_off IN CONSULT opd-4",
      body: 'room=opd-4 name="OPD 4" room_id=room_x problem=recorder_off minutes=4 consult_open=1 window_open_min=10',
      dedupe_key: "recorder_off_consult",
    });
    for (const bad of ["doctor", "patient", "consult_key", "uid", "display_name"]) expect(m.body + m.subject).not.toContain(bad);
  });
  it("consult_open on another kind changes nothing", () => {
    const m = A.composeOpsAlert({ kind: "mic_denied", room_id: "r", room_slug: "s", minutes: null, consult_open: { window_open_min: 9 } });
    expect(m).toEqual({ subject: "[ops] mic_denied s", body: "room=s room_id=r problem=mic_denied", dedupe_key: "mic_denied" });
  });
});

describe("runOpsSweep: a failed windows read degrades only that rule", () => {
  it("names encounter_windows in degraded", async () => {
    calls.length = 0;
    // order of reads: lastChunkByRoom, room_install, retired, (windows), room
    responses = [[], [], [], new Error("boom"), []];
    const r = await S.runOpsSweep(NOW);
    expect(r.degraded).toEqual(["encounter_windows"]);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.includes("FROM eta_encounter_windows") && c.includes("t_close IS NULL"))).toBe(true);
  });
});

describe("openEncounterWindowsByRoom SQL shape", () => {
  it("reads the OLDEST open, non-future window within 90 min, no names", async () => {
    calls.length = 0;
    responses = [[]];
    const { openEncounterWindowsByRoom } = await import("@/lib/room-access/tool-reads");
    await openEncounterWindowsByRoom([OPD4]);
    const q = calls[0]!;
    expect(q).toContain("min(w.t_open)");
    expect(q).toContain("w.t_close IS NULL");
    expect(q).toContain("w.t_open > now() - interval '90 minutes'");
    expect(q).toContain("w.t_open <= now()");
    expect(q).not.toMatch(/doctor|display_name|consult_key|consult_uid/);
  });
});
