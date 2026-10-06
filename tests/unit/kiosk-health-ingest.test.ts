/** validateKioskHealthBatch — every rule of the W1 kiosk-health sink envelope. */
import { describe, it, expect } from "vitest";
import { validateKioskHealthBatch, MAX_SEQ } from "@/lib/kiosk-health-ingest";

const NOW = Date.parse("2026-10-06T10:00:00.000Z");
const ev = (o: Record<string, unknown> = {}) => ({
  machine: "ehrc-opd-4", room_id: "opd4", install_id: "inst-1", boot_id: "boot-a", seq: 1, source: "daemon",
  kind: "power.sleep", ts: "2026-10-06T09:59:59.123Z", payload: { why: "idle" }, ...o,
});
const run = (events: unknown[]) => validateKioskHealthBatch({ events }, NOW);
const reason = (o: Record<string, unknown>) => {
  const r = run([ev(o)]);
  expect(r.error).toBeUndefined();
  expect(r.rows).toHaveLength(0);
  return r.rejected[0]?.reason;
};

describe("validateKioskHealthBatch batch level", () => {
  it("accepts a normal event and normalises ts", () => {
    const r = run([ev({ ts: "2026-10-06T15:30:00.000+05:30" })]);
    expect(r.rejected).toEqual([]);
    expect(r.rows[0]).toMatchObject({ machine: "ehrc-opd-4", seq: 1, kind: "power.sleep", ts: "2026-10-06T10:00:00.000Z", payload: { why: "idle" } });
  });
  it("0 items is empty_batch, 501 is too_many_events, 500 is fine", () => {
    expect(run([]).error).toBe("empty_batch");
    expect(run(Array.from({ length: 501 }, (_, i) => ev({ seq: i }))).error).toBe("too_many_events");
    const r = run(Array.from({ length: 500 }, (_, i) => ev({ seq: i })));
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(500);
  });
  it("body must be { events: [] }", () => {
    for (const b of [null, "x", [], {}, { events: "x" }, { events: {} }]) expect(validateKioskHealthBatch(b, NOW).error, JSON.stringify(b)).toBe("bad_body");
  });
  it("one bad item never fails the batch and keeps its index", () => {
    const r = run([ev({ seq: 1 }), ev({ seq: -1 }), ev({ seq: 2 }), "junk"]);
    expect(r.rows.map((x) => x.seq)).toEqual([1, 2]);
    expect(r.rejected).toEqual([{ index: 1, reason: "bad_seq" }, { index: 3, reason: "not_object" }]);
  });
});

describe("validateKioskHealthBatch per-field rules", () => {
  it("machine: non-empty string up to 128", () => {
    expect(run([ev({ machine: "m".repeat(128) })]).rows).toHaveLength(1);
    for (const m of ["", "m".repeat(129), 5, null, undefined]) expect(reason({ machine: m }), String(m)).toBe("bad_machine");
  });
  it("boot_id: non-empty string up to 64", () => {
    expect(run([ev({ boot_id: "b".repeat(64) })]).rows).toHaveLength(1);
    for (const b of ["", "b".repeat(65), 7, undefined]) expect(reason({ boot_id: b })).toBe("bad_boot_id");
  });
  it("seq: integer 0..2^53; string, negative, float, NaN, too large rejected", () => {
    for (const s of [0, 1, 2 ** 31, MAX_SEQ]) expect(run([ev({ seq: s })]).rows, String(s)).toHaveLength(1);
    for (const s of ["5", -1, 1.5, NaN, Infinity, MAX_SEQ * 2, null, undefined]) expect(reason({ seq: s }), String(s)).toBe("bad_seq");
  });
  it("source: non-empty string up to 32, any value", () => {
    expect(run([ev({ source: "other" })]).rows).toHaveLength(1);
    for (const s of ["", "s".repeat(33), 1, undefined]) expect(reason({ source: s })).toBe("bad_source");
  });
  it("kind: lowercase [a-z0-9_.-] up to 64", () => {
    for (const k of ["heartbeat", "power.sleep", "assert.snapshot", "a-b_c.9", "k".repeat(64)]) expect(run([ev({ kind: k })]).rows, k).toHaveLength(1);
    for (const k of ["Power.Sleep", "power sleep", "power/sleep", "", "k".repeat(65), 3, undefined]) expect(reason({ kind: k }), String(k)).toBe("bad_kind");
  });
  it("ts: ISO with offset, real date, 2000..2100; clock skew is stored with _clock_suspect, never rejected", () => {
    const ok = (t: string) => run([ev({ ts: t })]).rows[0];
    expect(ok("2026-10-06T10:59:59.000Z").payload).toEqual({ why: "idle" }); // just under +1 h
    expect(ok("2026-09-06T10:00:01.000Z").payload).toEqual({ why: "idle" }); // just under 30 d old
    expect(ok("2026-10-06T11:00:01.000Z").payload).toEqual({ why: "idle", _clock_suspect: true }); // > 1 h ahead
    expect(ok("2026-09-06T09:59:59.000Z").payload).toEqual({ why: "idle", _clock_suspect: true }); // > 30 d old
    expect(ok("2026-01-01T00:00:00.000Z")).toMatchObject({ ts: "2026-01-01T00:00:00.000Z", payload: { _clock_suspect: true } });
    expect(ok("2030-01-01T00:00:00.000Z").payload).toMatchObject({ _clock_suspect: true });
    expect(ok("2000-01-01T00:00:00.000Z").payload).toMatchObject({ _clock_suspect: true });
    expect(ok("2099-12-31T23:59:59.999Z").payload).toMatchObject({ _clock_suspect: true });
    expect(run([ev({ ts: "2030-01-01T00:00:00.000Z", payload: undefined })]).rows[0].payload).toEqual({ _clock_suspect: true });
    expect(reason({ ts: "1999-12-31T23:59:59.999Z" })).toBe("ts_out_of_range");
    expect(reason({ ts: "2100-01-01T00:00:00.000Z" })).toBe("ts_out_of_range");
    for (const t of ["yesterday", "2026-10-06", "2026-10-06T10:00:00", "2026-02-30T10:00:00Z", 1790000000000, null, undefined]) {
      expect(reason({ ts: t }), String(t)).toBe("bad_ts");
    }
  });
  it("room_id and install_id: optional, null, or string up to 64", () => {
    const r = run([ev({ room_id: undefined, install_id: null })]);
    expect(r.rows[0].room_id).toBeNull();
    expect(r.rows[0].install_id).toBeNull();
    expect(run([ev({ room_id: "r".repeat(64), install_id: "i".repeat(64) })]).rows).toHaveLength(1);
    expect(reason({ room_id: "r".repeat(65) })).toBe("bad_room_id");
    expect(reason({ install_id: "i".repeat(65) })).toBe("bad_install_id");
    expect(reason({ room_id: 4 })).toBe("bad_room_id");
    expect(reason({ install_id: {} })).toBe("bad_install_id");
  });
  it("payload: optional plain object up to 16 KB serialized", () => {
    expect(run([ev({ payload: undefined })]).rows[0].payload).toEqual({});
    expect(run([ev({ payload: null })]).rows[0].payload).toEqual({});
    const fits = { s: "x".repeat(16 * 1024 - 8) }; // {"s":"..."} = 16384 bytes exactly
    expect(JSON.stringify(fits).length).toBe(16 * 1024);
    expect(run([ev({ payload: fits })]).rows).toHaveLength(1);
    expect(reason({ payload: { s: "x".repeat(17 * 1024) } })).toBe("payload_too_large");
    expect(reason({ payload: [1, 2] })).toBe("bad_payload");
    expect(reason({ payload: "str" })).toBe("bad_payload");
    expect(reason({ payload: 5 })).toBe("bad_payload");
  });
  it("rejects NUL and lone surrogates Postgres would refuse; unknown extra keys are ignored", () => {
    expect(reason({ payload: { a: "x\u0000y" } })).toBe("unsafe_string");
    expect(reason({ machine: "m\uD800" })).toBe("unsafe_string");
    const r = run([ev({ extra: "ignored", more: { a: 1 } })]);
    expect(Object.keys(r.rows[0]).sort()).toEqual(["boot_id", "install_id", "kind", "machine", "payload", "room_id", "seq", "source", "ts"]);
  });
});
