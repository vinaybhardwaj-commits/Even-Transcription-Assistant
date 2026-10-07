/** lib/rooms-live/roster.ts — v1.1 F29: the room list comes from the room table + steward_config key rooms_live_rooms; default = the eight. */
import { describe, it, expect, beforeEach } from "vitest";
import { ROOMS } from "@/lib/rooms-live/rooms";
import { loadRoster, parseRosterIds, readRoster, resetRosterForTests, ROSTER_KEY } from "@/lib/rooms-live/roster";
import type { Db } from "@/lib/rooms-live/read";

const IDS = ROOMS.map((r) => r.room_id);
type Opt = { cfg?: unknown; cfgFails?: boolean; roomsFails?: boolean; roomRows?: Array<{ room_id: string; name: string }>; calls?: string[] };
const fake = (o: Opt = {}): Db =>
  (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const t = strings.join("?");
    o.calls?.push(t.includes("steward_config") ? "cfg" : "room");
    if (t.includes("FROM steward_config")) {
      expect(v[0]).toBe(ROSTER_KEY);
      if (o.cfgFails) throw new Error("no table");
      return o.cfg === undefined ? [] : [{ value: o.cfg }];
    }
    if (o.roomsFails) throw new Error("boom");
    const asked = v[0] as string[];
    return (o.roomRows ?? IDS.map((id) => ({ room_id: id, name: id }))).filter((r) => asked.includes(r.room_id));
  }) as unknown as Db;

beforeEach(() => resetRosterForTests());

describe("F29 roster", () => {
  it("no key -> the same eight, same order, same labels", async () => {
    expect(await readRoster(fake())).toEqual([...ROOMS]);
  });
  it("a failed config read or a failed room read -> the default eight", async () => {
    expect(await readRoster(fake({ cfgFails: true }))).toEqual([...ROOMS]);
    expect(await readRoster(fake({ roomsFails: true }))).toEqual([...ROOMS]);
  });
  it("a malformed value is ignored", async () => {
    for (const cfg of [42, "nope", { ids: "x" }, [], [1, 2], null]) expect(await readRoster(fake({ cfg })), JSON.stringify(cfg)).toEqual([...ROOMS]);
  });
  it("the list can add a room (labelled by room.name) and drop one; order follows the list", async () => {
    const roomRows = [...IDS.map((id) => ({ room_id: id, name: id })), { room_id: "room_newopd99", name: "OPD 9" }];
    const r = await readRoster(fake({ cfg: ["room_newopd99", IDS[1]!, IDS[0]!], roomRows }));
    expect(r.map((x) => x.room_id)).toEqual(["room_newopd99", IDS[1], IDS[0]]);
    expect(r.map((x) => x.label)).toEqual(["OPD 9", "OPD 3", "OPD 1"]);
    expect(r.map((x) => x.order)).toEqual([1, 2, 3]);
    expect((await readRoster(fake({ cfg: { ids: [IDS[2]!] } }))).map((x) => x.label)).toEqual(["OPD 4 Ortho"]);
  });
  it("Audiometry, ORB2, ORB3, Home Office and scratch rooms never join, whatever the list says", () => {
    const ids = parseRosterIds(["room_d74hhmc4", "room_mah3aspr", "room_jwyrr4dc", "room_2qe955hy", "room_scratch_ab12", IDS[0]]);
    expect(ids).toEqual([IDS[0]]);
    expect(parseRosterIds(["room_d74hhmc4"])).toBeNull();
  });
  it("a room that is missing from the room table (or disabled: the query filters it) is dropped", async () => {
    const roomRows = IDS.filter((id) => id !== IDS[3]).map((id) => ({ room_id: id, name: id }));
    const r = await readRoster(fake({ roomRows }));
    expect(r).toHaveLength(7);
    expect(r.map((x) => x.room_id)).not.toContain(IDS[3]);
    expect(r.map((x) => x.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("an empty room table result -> the default eight (fail-safe)", async () => {
    expect(await readRoster(fake({ roomRows: [{ room_id: "room_other", name: "x" }] }))).toEqual([...ROOMS]);
  });
  it("loadRoster is memoised for 60 s", async () => {
    const calls: string[] = [];
    const db = fake({ calls });
    await loadRoster(db, 1_000_000);
    await loadRoster(db, 1_059_000);
    expect(calls).toEqual(["cfg", "room"]);
    await loadRoster(db, 1_061_000);
    expect(calls).toHaveLength(4);
  });
});
