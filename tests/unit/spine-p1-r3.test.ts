/** SPINE-P1 R3: hourly acoustic (F2), tick rotation (F4), the stable acoustic key (F1), no shadow-v3 (F3). Pure logic, synthetic ids only. */
import { describe, it, expect, vi } from "vitest";
import { acousticDue, rotateByTick, runProducers, TICK_MS, type RoomDayRef } from "@/lib/spine/producers";
import { acousticKey, signalHash, toSignals } from "@/lib/spine/ingest";

const ist = (hhmm: string) => Date.parse(`2026-10-22T${hhmm}:00+05:30`);
const day = (n: number): RoomDayRef => ({ id: `rd_test${n}`, room_id: `room_test${n}`, ist_date: "2026-10-22" });
const deps = (now: () => number) => ({ now, isBlind: async () => false, acoustic: vi.fn(async () => ({ ok: true })), leave: vi.fn(async (_i: { room_day_id: string }) => ({ ok: true })), timelineEnabled: () => true, gateDiar: () => false });

describe("F2: acoustic only on the first tick of each IST hour", () => {
  it.each([["12:00", true], ["12:14", true], ["12:15", false], ["12:45", false], ["12:30", false], ["00:00", true], ["23:59", false]])("IST %s -> due %s", (t, due) => {
    expect(acousticDue(ist(t))).toBe(due);
  });
  it("of the 4 ticks in an hour exactly one qualifies", () => {
    const base = ist("12:00");
    expect([0, 1, 2, 3].map((k) => acousticDue(base + k * TICK_MS))).toEqual([true, false, false, false]);
    expect(Array.from({ length: 96 }, (_, k) => acousticDue(base + k * TICK_MS)).filter(Boolean)).toHaveLength(24);
  });
  it("a not-due tick skips acoustic but leave still runs for every day", async () => {
    const d = deps(() => ist("12:45"));
    const c = await runProducers([day(1), day(2)], 12, d);
    expect(d.acoustic).not.toHaveBeenCalled();
    expect(d.leave).toHaveBeenCalledTimes(2);
    expect(c).toMatchObject({ acoustic_due: false, acoustic_ok: 0, acoustic_err: 0, leave_ok: 2 });
  });
  it("a due tick runs acoustic then leave", async () => {
    const d = deps(() => ist("12:00"));
    const c = await runProducers([day(1), day(2)], 12, d);
    expect(d.acoustic).toHaveBeenCalledTimes(2);
    expect(c).toMatchObject({ acoustic_due: true, acoustic_ok: 2, leave_ok: 2 });
  });
});

describe("F4: the room-day list is rotated by the tick index", () => {
  it("rotateByTick: floor(now / 15 min) mod n", () => {
    expect(rotateByTick([1, 2, 3, 4], 0)).toEqual([1, 2, 3, 4]);
    expect(rotateByTick([1, 2, 3, 4], TICK_MS - 1)).toEqual([1, 2, 3, 4]);
    expect(rotateByTick([1, 2, 3, 4], TICK_MS)).toEqual([2, 3, 4, 1]);
    expect(rotateByTick([1, 2, 3, 4], 5 * TICK_MS)).toEqual([2, 3, 4, 1]);
    expect(rotateByTick([], 7 * TICK_MS)).toEqual([]);
    expect(rotateByTick([1, 2, 3, 4], 3_600_000, 3_600_000)).toEqual([2, 3, 4, 1]);
    expect(rotateByTick([1, 2, 3, 4], 3_600_000 - 1, 3_600_000)).toEqual([1, 2, 3, 4]);
  });
  it("20 room-days, a budget that fits 5: successive ticks serve different rooms and every room is served within a day", async () => {
    const days = Array.from({ length: 20 }, (_, i) => day(i + 1));
    const served = new Set<string>();
    const heads: string[] = [];
    const t0 = ist("12:00");
    for (let k = 0; k < 96; k++) {
      let t = t0 + k * TICK_MS;
      const d = deps(() => t);
      d.leave = vi.fn(async (_i: { room_day_id: string }) => { t += 10_000; return { ok: true }; });   // 10 s per room-day: 45 s fits 5
      const c = await runProducers(days, 12, d);
      expect(c.room_days).toBe(5);
      const ids = d.leave.mock.calls.map((x) => x[0].room_day_id);
      heads.push(ids[0]!);
      ids.forEach((i) => served.add(i));
    }
    expect(new Set(heads).size).toBeGreaterThan(1);
    expect(served.size).toBe(20);
  });
  it("the same 5 tail rooms are not starved: tail rooms are served on some tick", async () => {
    const days = Array.from({ length: 20 }, (_, i) => day(i + 1));
    let t = ist("12:00") + 2 * TICK_MS;   // tick offset 2 mod 20 (the epoch tick index decides; any tick moves the head)
    const d = deps(() => t);
    d.leave = vi.fn(async (_i: { room_day_id: string }) => { t += 10_000; return { ok: true }; });
    await runProducers(days, 12, d);
    const first = d.leave.mock.calls[0]![0].room_day_id;
    expect(first).toBe(`rd_test${(Math.floor((ist("12:00") + 2 * TICK_MS) / TICK_MS) % 20) + 1}`);
  });
});

describe("F3: shadow-v3 is not a producer dep", () => {
  it("runProducers never receives or calls a timeline runner; counts carry no v3 fields", async () => {
    const d = { ...deps(() => ist("12:00")), timeline: vi.fn(async () => ({ ok: true })) };
    const c = await runProducers([day(1)], 12, d as never);
    expect(d.timeline).not.toHaveBeenCalled();
    expect(c).not.toHaveProperty("timeline_ok");
    expect(c).not.toHaveProperty("timeline_err");
  });
});

describe("F1: the stable acoustic source_key", () => {
  const row = (o: Record<string, unknown> = {}) => ({ id: "eh_abcdefghjkmn", run_id: "ehr_abcdefghjkmn", room_day_id: "rd_abcd2345", room_id: "room_abcd2345", start_ms: 1_760_760_000_000, end_ms: 1_760_760_600_000, closed_by: "non_speech", created_at: "2026-10-18T05:00:00Z", ...o });
  it("room_day_id + epoch minute (floor) in base 36; no run of 7+ digits", () => {
    expect(acousticKey(row())).toBe(`rd_abcd2345:${Math.floor(1_760_760_000_000 / 60_000).toString(36)}`);
    expect(acousticKey(row({ start_ms: 1_760_760_059_999 }))).toBe(acousticKey(row()));
    expect(acousticKey(row({ start_ms: 1_760_760_060_000 }))).not.toBe(acousticKey(row()));
    expect(acousticKey(row())).toMatch(/^rd_[a-hjkmnp-z2-9]{8}:[0-9a-z]{4,6}$/);
    expect(acousticKey(row())).not.toMatch(/[0-9]{7}/);
  });
  it("missing room_day_id or start gives no key", () => {
    expect(acousticKey(row({ room_day_id: null }))).toBeNull();
    expect(acousticKey(row({ room_day_id: "" }))).toBeNull();
    expect(acousticKey(row({ start_ms: null }))).toBeNull();
    expect(acousticKey(row({ start_ms: "" }))).toBeNull();
    expect(toSignals([row({ room_day_id: null })], "acoustic")).toEqual([]);
  });
  it("a rerun with NEW hypothesis and run ids maps to the same key; ids stay in attrs.ids", () => {
    const [a] = toSignals([row()], "acoustic");
    const [b] = toSignals([row({ id: "eh_23456789zyxw", run_id: "ehr_23456789zyxw" })], "acoustic");
    expect(b!.source_key).toBe(a!.source_key);
    expect(b!.attrs.ids).toMatchObject({ hypothesis_id: "eh_23456789zyxw", run_id: "ehr_23456789zyxw", room_day_id: "rd_abcd2345" });
  });
  it("rev rule: unchanged keeps the rev, a moved end is rev+1, a new bucket is a new key at rev 1", () => {
    const [a] = toSignals([row()], "acoustic");
    const prior = new Map([[a!.source_key, { rev: 1, hash: "x" }]]);
    expect(toSignals([row({ end_ms: 1_760_760_900_000 })], "acoustic", prior)[0]!.source_rev).toBe(2);
    const [seen] = toSignals([row()], "acoustic", new Map([[a!.source_key, { rev: 3, hash: signalHash({ t_open: a!.t_open, t_close: a!.t_close, room_id: a!.room_id, close_reason: "non_speech" }) }]]));
    expect(seen!.source_rev).toBe(3);
    expect(toSignals([row({ start_ms: 1_760_760_180_000 })], "acoustic", prior)[0]).toMatchObject({ source_rev: 1 });
  });
  it("two intervals of one run in the same bucket collapse to the first (one key, one row)", () => {
    const out = toSignals([row(), row({ id: "eh_23456789zyxw", start_ms: 1_760_760_030_000 })], "acoustic");
    expect(out).toHaveLength(1);
    expect(out[0]!.attrs.ids).toMatchObject({ hypothesis_id: "eh_abcdefghjkmn" });
  });
});
