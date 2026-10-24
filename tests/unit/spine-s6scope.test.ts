/**
 * spine-s6scope.test.ts — per-room scoping of live spine stages (S6 gap G1). Pure: THE ROOM RULE (lib/spine/config.ts) and its two users, the enqueuer's planned status and the claim route's rules.
 * Synthetic ids only.
 */
import { describe, it, expect } from "vitest";
import { claimRules, effectiveRoomMode, modesFrom, parseRoomScope, roomMode, ruleAllows, type Mode, type RoomScope } from "@/lib/spine/config";
import { FREE_STAGES, effectiveModes, planJobs, type EncounterRow } from "@/lib/spine/enqueue";

const row = (key: string, value: unknown) => ({ key, value });
const base = [row("kill_switch", false), row("jobs", "live")];
const scopeOf = (v: unknown, stage = "recut") => modesFrom([...base, row(`mode.${stage}`, v)], [stage]);

describe("parseRoomScope — every config shape", () => {
  it("no rooms key = every room (today's meaning)", () => {
    expect(parseRoomScope("live")).toBeNull();
    expect(parseRoomScope({ mode: "live" })).toBeNull();
    expect(parseRoomScope(undefined)).toBeNull();
    expect(parseRoomScope(null)).toBeNull();
    expect(parseRoomScope([])).toBeNull();   // an array is not an object config
  });
  it("a list of non-empty strings is the list, deduplicated", () => {
    expect(parseRoomScope({ mode: "live", rooms: ["room_a", "room_b", "room_a"] })).toEqual(["room_a", "room_b"]);
    expect(parseRoomScope({ mode: "live", rooms: [] })).toEqual([]);
  });
  it("a malformed rooms value is the EMPTY list (live for no room), never all rooms", () => {
    for (const bad of [null, "room_a", 7, {}, true, [""], [1], ["room_a", null], ["room_a", ["room_b"]]]) expect(parseRoomScope({ mode: "live", rooms: bad }), JSON.stringify(bad)).toEqual([]);
  });
});

describe("roomMode — the rule", () => {
  const L: RoomScope = ["room_a"];
  it("live with a list: listed = live, anything else (also an unknown room) = shadow", () => {
    expect(roomMode("live", L, "room_a")).toBe("live");
    expect(roomMode("live", L, "room_b")).toBe("shadow");
    expect(roomMode("live", L, null)).toBe("shadow");
    expect(roomMode("live", L, undefined)).toBe("shadow");
    expect(roomMode("live", [], "room_a")).toBe("shadow");
  });
  it("shadow with a list: listed = shadow, anything else = off", () => {
    expect(roomMode("shadow", L, "room_a")).toBe("shadow");
    expect(roomMode("shadow", L, "room_b")).toBe("off");
    expect(roomMode("shadow", L, null)).toBe("off");
  });
  it("no list = the declared mode for every room; off stays off", () => {
    for (const r of ["room_a", null]) { expect(roomMode("live", null, r)).toBe("live"); expect(roomMode("shadow", null, r)).toBe("shadow"); }
    expect(roomMode("off", L, "room_a")).toBe("off");
  });
  it("jobs caps it: off => off, shadow => live becomes shadow", () => {
    expect(effectiveRoomMode("off", "live", L, "room_a")).toBe("off");
    expect(effectiveRoomMode("shadow", "live", L, "room_a")).toBe("shadow");
    expect(effectiveRoomMode("shadow", "live", L, "room_b")).toBe("shadow");
    expect(effectiveRoomMode("shadow", "shadow", L, "room_b")).toBe("off");
    expect(effectiveRoomMode("live", "live", L, "room_a")).toBe("live");
  });
});

describe("modesFrom carries the scope; kill_switch, jobs, paid and unknown stages unchanged", () => {
  it("scoped live", () => {
    const m = scopeOf({ mode: "live", rooms: ["room_a"] });
    expect(m.stages.recut).toBe("live");
    expect(m.scopes.recut).toEqual(["room_a"]);
  });
  it("kill switch => everything off, scope none; jobs off => off", () => {
    const k = modesFrom([row("kill_switch", true), row("jobs", "live"), row("mode.recut", { mode: "live", rooms: ["room_a"] })], ["recut"]);
    expect(k).toEqual({ jobs: "off", stages: { recut: "off" }, scopes: { recut: null } });
    expect(modesFrom([row("jobs", "off"), row("mode.recut", { mode: "live", rooms: ["room_a"] })], ["recut"]).stages.recut).toBe("off");
  });
  it("a paid stage and an unknown stage stay off whatever the room list says", () => {
    const m = modesFrom([...base, row("mode.sarvam", { mode: "live", rooms: ["room_a"] }), row("mode.bogus", { mode: "live", rooms: ["room_a"] })], ["sarvam", "bogus"]);
    expect(m.stages).toEqual({ sarvam: "off", bogus: "off" });
    expect(claimRules("live", "live", m.stages, m.scopes, ["sarvam", "bogus"])).toEqual([]);
  });
});

// ---- enqueue / claim parity over every combination
const JOBS: Mode[] = ["off", "shadow", "live"];
const MODES: Mode[] = ["off", "shadow", "live"];
const SCOPES: RoomScope[] = [null, [], ["room_a"], ["room_a", "room_b"], ["room_z"]];
const ROOMS: Array<string | null> = ["room_a", "room_b", "room_c", null];
const enc = (room: string | null): EncounterRow => ({ encounter_id: "enc_testaaaaaaaaaaaa", status: "confirmed", boundary_rev: 1, flags: [], t_close: 0, room_id: room });
const NOW = 10 * 3_600_000;

describe("enqueue/claim parity", () => {
  it("planned status `queued` <=> a live claim's rule lets that room through; every combination", () => {
    for (const jobs of JOBS) for (const mode of MODES) for (const scope of SCOPES) for (const room of ROOMS) {
      const tag = JSON.stringify({ jobs, mode, scope, room });
      const plan = planJobs([enc(room)], { recut: mode }, NOW, { recut: scope }, jobs).find((p) => p.stage === "recut");
      const live = claimRules("live", jobs, { recut: mode }, { recut: scope }, ["recut"]).some((r) => ruleAllows(r, room));
      expect(plan?.status === "queued", tag).toBe(live);
      expect(live, tag).toBe(effectiveRoomMode(jobs, mode, scope, room) === "live");
    }
  });
  it("a would_run claim takes a room only if the rule calls it shadow (and, with jobs live, exactly then)", () => {
    for (const jobs of JOBS) for (const mode of MODES) for (const scope of SCOPES) for (const room of ROOMS) {
      const tag = JSON.stringify({ jobs, mode, scope, room });
      const shadow = claimRules("shadow", jobs, { recut: mode }, { recut: scope }, ["recut"]).some((r) => ruleAllows(r, room));
      const eff = effectiveRoomMode(jobs, mode, scope, room);
      if (shadow) expect(eff, tag).toBe("shadow");
      if (jobs === "live") expect(shadow, tag).toBe(eff === "shadow" && !(mode === "live" && scope === null));   // an unscoped live stage is never taken by a would_run claim (as before S6)
      // a room is never claimable by both kinds of claim
      const live = claimRules("live", jobs, { recut: mode }, { recut: scope }, ["recut"]).some((r) => ruleAllows(r, room));
      expect(live && shadow, tag).toBe(false);
    }
  });
  it("the plain string 'live' keeps today's meaning: every room, and unknown room", () => {
    const m = scopeOf("live");
    const r = claimRules("live", "live", m.stages, m.scopes, ["recut"]);
    for (const room of ROOMS) expect(r.some((x) => ruleAllows(x, room))).toBe(true);
  });
  it("a malformed or empty list: live for no room, and the plan is shadow for every room", () => {
    for (const bad of [{ mode: "live", rooms: "room_a" }, { mode: "live", rooms: null }, { mode: "live", rooms: [] }, { mode: "live", rooms: [3] }]) {
      const m = scopeOf(bad);
      const rules = claimRules("live", "live", m.stages, m.scopes, ["recut"]);
      for (const room of ROOMS) {
        expect(rules.some((x) => ruleAllows(x, room))).toBe(false);
        expect(planJobs([enc(room)], m.stages, NOW, m.scopes, "live").find((p) => p.stage === "recut")?.status).toBe("shadow");
      }
    }
  });
  it("the legacy call (capped modes, no scopes) plans as before", () => {
    const capped = effectiveModes("shadow", { recut: "live", acoustics: "shadow" });
    const p = planJobs([enc("room_a")], capped, NOW);
    expect(p.map((x) => [x.stage, x.status])).toEqual([["recut", "shadow"], ["acoustics", "shadow"]]);
    expect(FREE_STAGES).toContain("recut");
  });
  it("a paid stage is never planned or claimed", () => {
    expect(planJobs([enc("room_a")], { sarvam: "live" }, NOW, { sarvam: ["room_a"] }, "live")).toEqual([]);
  });
});
