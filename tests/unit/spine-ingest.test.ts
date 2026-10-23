/** Spine S1 pure logic: the rev rule in toSignals, the config gate, and the key refusal. Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { toSignals, signalHash, type Prior } from "@/lib/spine/ingest";
import { parseIngestMode } from "@/lib/spine/config";
import { refuseKeys, validateSignals } from "@/lib/spine/signal-validate";

const win = (over: Record<string, unknown> = {}) => ({
  consult_key: "uidtestaaaaaaaaaaaaaaaaaaa@mach_test", consult_uid: "uidtestaaaaaaaaaaaaaaaaaaa", room_id: "room_abcd2345", t_open: "2026-10-18T04:00:00.000Z", t_close: "2026-10-18T04:10:00.000Z",
  close_reason: "endConsult", quality: "clean", computed_at: "2026-10-18T04:11:00.000Z", ...over,
});
const prior = (rows: ReturnType<typeof toSignals>): Prior => new Map(rows.map((s) => [s.source_key, { rev: s.source_rev, hash: signalHash({ ...s, close_reason: s.attrs.close_reason }) }]));

describe("toSignals rev rule", () => {
  it("a new key is rev 1 and maps ids / quality / close_reason only", () => {
    const [s] = toSignals([win()], "pulse");
    expect(s).toMatchObject({ proxy: "pulse", source_key: "uidtestaaaaaaaaaaaaaaaaaaa@mach_test", source_rev: 1, room_id: "room_abcd2345", t_close: "2026-10-18T04:10:00.000Z" });
    expect(Object.keys(s.attrs).sort()).toEqual(["close_reason", "ids", "quality"]);
  });
  it("an unchanged row keeps its rev, whatever else moved (computed_at, quality, ISO spelling)", () => {
    const p = prior(toSignals([win()], "pulse"));
    const [s] = toSignals([win({ computed_at: "2026-10-18T05:00:00Z", quality: "ambiguous", t_open: new Date("2026-10-18T04:00:00Z") })], "pulse", p);
    expect(s.source_rev).toBe(1);
  });
  it("a moved t_close gives rev+1; so do a moved t_open, room_id and close reason", () => {
    const p = prior(toSignals([win()], "pulse"));
    for (const over of [{ t_close: "2026-10-18T04:12:00.000Z" }, { t_open: "2026-10-18T03:59:00.000Z" }, { room_id: "room_bcde2345" }, { close_reason: "cap_90m" }])
      expect(toSignals([win(over)], "pulse", p)[0].source_rev, JSON.stringify(over)).toBe(2);
  });
  it("an open window that closes is a new rev, and the next rev continues from the stored one", () => {
    const open = toSignals([win({ t_close: null, close_reason: "open" })], "pulse");
    expect(open[0].t_close).toBeNull();
    const p = new Map([["uidtestaaaaaaaaaaaaaaaaaaa@mach_test", { rev: 4, hash: open[0] ? signalHash({ ...open[0], close_reason: "open" }) : "" }]]);
    expect(toSignals([win()], "pulse", p)[0].source_rev).toBe(5);
  });
  it("acoustic and timeline map ms spans and closed_by", () => {
    const a = toSignals([{ id: "eh_abcdefghjkmn", room_day_id: "rd_abcd2345", room_id: "room_abcd2345", start_ms: "1760760000000", end_ms: 1760760600000, closed_by: "non_speech", created_at: "2026-10-18T05:00:00Z" }], "acoustic");
    expect(a[0]).toMatchObject({ proxy: "acoustic", source_key: `rd_abcd2345:${Math.floor(1760760000000 / 60000).toString(36)}`, t_open: "2025-10-18T04:00:00.000Z", attrs: { close_reason: "non_speech" } });
    const t = toSignals([{ consult_key: "uidtestaaaaaaaaaaaaaaaaaaa@mach_test", id: "tl_test_01", run_id: "run_test_01", room_id: null, start_ms: 1760760000000, end_ms: 1760760600000, closed_by: "patient_left", created_at: "2026-10-18T05:00:00Z" }], "timeline");
    expect(t[0]).toMatchObject({ proxy: "timeline", source_key: "uidtestaaaaaaaaaaaaaaaaaaa@mach_test", room_id: null });
  });
  it("a row with no key or no open time is skipped", () => {
    expect(toSignals([win({ consult_key: null }), win({ t_open: null })], "pulse")).toEqual([]);
  });
});

describe("parseIngestMode", () => {
  const r = (key: string, value: unknown) => ({ key, value });
  it("missing, off and malformed mean off", () => {
    for (const rows of [[], [r("ingest", "off")], [r("ingest", "yes")], [r("ingest", 1)], [r("ingest", { mode: "on" })], [r("ingest", null)]]) expect(parseIngestMode(rows)).toBe("off");
  });
  it("shadow and live run, as a string or {mode}", () => {
    expect(parseIngestMode([r("ingest", "shadow")])).toBe("shadow");
    expect(parseIngestMode([r("ingest", { mode: "live" })])).toBe("live");
    expect(parseIngestMode([r("ingest", '"shadow"')])).toBe("shadow");
  });
  it("the kill switch wins, and a malformed one counts as on", () => {
    for (const k of [true, { on: true }, "garbage", { on: "no" }, 1]) expect(parseIngestMode([r("ingest", "shadow"), r("kill_switch", k)]), JSON.stringify(k)).toBe("off");
    expect(parseIngestMode([r("ingest", "shadow"), r("kill_switch", { on: false })])).toBe("shadow");
  });
});

describe("key refusal and validation", () => {
  it("refuses a text-like key at depth 0, 1 and 3, in any case, and inside arrays", () => {
    expect(refuseKeys({ Name: 1 })).toBe("text_key");
    expect(refuseKeys({ a: { phone_no: 1 } })).toBe("text_key");
    expect(refuseKeys({ a: { b: { c: { PATIENT: 1 } } } })).toBe("text_key");
    expect(refuseKeys([{ a: [{ transcript_en: 1 }] }])).toBe("text_key");
    expect(refuseKeys({ ids: { consult_uid: "uidtestaaaaaaaaaaaaaaaaaaa" }, quality: "clean" })).toBeNull();
  });
  it("refuses a pathologically deep body", () => {
    let o: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) o = { k: o };
    expect(refuseKeys(o)).toBe("too_deep");
  });
  const good = { proxy: "pqm", source_key: "pqm_a1b2c3d4e5f6a7b8c9d0e1", t_open: "2026-10-18T04:00:00Z", observed_at: "2026-10-18T04:20:00Z", attrs: { ids: { consult_uid: "pqm_a1b2c3d4e5f6a7b8c9d0e1" }, close_reason: "pqm" } };
  it("accepts a good signal and normalises times", () => {
    const v = validateSignals([good]);
    expect(v.ok && v.rows[0]).toMatchObject({ proxy: "pqm", t_open: "2026-10-18T04:00:00.000Z", t_close: null, room_id: null });
  });
  it("400s every shape failure", () => {
    const bad = (o: unknown) => { const v = validateSignals(o); return v.ok ? "ok" : v.error; };
    expect(bad({})).toBe("body_not_array");
    expect(bad([])).toBe("empty");
    expect(bad([{ ...good, proxy: "nope" }])).toBe("proxy");
    expect(bad([{ ...good, attrs: { extra: 1 } }])).toBe("attrs_key");
    expect(bad([{ ...good, encounter_id: "uidtestaaaaaaaaaaaaaaaaaaa" }])).toBe("signal_key");
    expect(bad([{ ...good, source_rev: 0 }])).toBe("source_rev");
    expect(bad([{ ...good, t_open: "x" }])).toBe("t_open");
  });
});
