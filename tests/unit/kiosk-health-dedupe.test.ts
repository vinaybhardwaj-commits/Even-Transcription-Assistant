/** TS-H10 #47: cross-source twin detection, pure. ONE-TO-ONE pairing (nearest first), daemon/helper pair only. */
import { describe, it, expect } from "vitest";
import { DEDUPE_WINDOW_MS, splitTwins, type LedgerRef, type StoredRef } from "@/lib/kiosk-health-dedupe";
import type { KioskHealthRow } from "@/lib/kiosk-health-ingest";

const T0 = Date.parse("2026-10-11T10:00:00.000Z");
const off = (ms: number) => new Date(T0 + ms).toISOString();
const row = (o: Partial<KioskHealthRow> = {}): KioskHealthRow => ({ machine: "EHRC-OPD1s-Mac-mini", room_id: null, install_id: null, boot_id: "b", seq: 1, source: "helper", kind: "heartbeat", ts: off(0), payload: {}, ...o });
const ref = (o: Partial<StoredRef> = {}): StoredRef => ({ machine: "EHRC-OPD1s-Mac-mini", kind: "heartbeat", source: "daemon", ts: off(0), ...o });
const led = (o: Partial<LedgerRef> = {}): LedgerRef => ({ machine: "EHRC-OPD1s-Mac-mini", kind: "heartbeat", source: "helper", ts: off(0), twin_source: "daemon", twin_ts: off(0), ...o });
const seqs = (rs: KioskHealthRow[]) => rs.map((r) => r.seq);

describe("splitTwins: what is a twin", () => {
  it("a daemon/helper event of the same Mac and kind within 2 s is a twin (inclusive at the edge), in either direction", () => {
    expect(DEDUPE_WINDOW_MS).toBe(2000);
    for (const d of [0, 1, -1, 1999, -1999, 2000, -2000]) expect(splitTwins([row()], [ref({ ts: off(d) })]).dropped, String(d)).toHaveLength(1);
    expect(splitTwins([row({ source: "daemon" })], [ref({ source: "helper" })]).dropped).toHaveLength(1);
  });
  it("2001 ms apart is NOT a twin", () => {
    expect(splitTwins([row()], [ref({ ts: off(2001) })]).keep).toHaveLength(1);
    expect(splitTwins([row()], [ref({ ts: off(-2001) })]).keep).toHaveLength(1);
  });
  it("the SAME source is never a twin; a different kind or Mac is not; the same Mac under another spelling is", () => {
    expect(splitTwins([row({ source: "daemon" })], [ref({ source: "daemon" })]).keep).toHaveLength(1);
    expect(splitTwins([row()], [ref({ source: "helper" })]).keep).toHaveLength(1);
    expect(splitTwins([row()], [ref({ kind: "power.sleep" })]).keep).toHaveLength(1);
    expect(splitTwins([row()], [ref({ machine: "EHRC-OPD2s-Mac-mini" })]).keep).toHaveLength(1);
    expect(splitTwins([row()], [ref({ machine: "EHRC-OPD1’s Mac mini" })]).dropped).toHaveLength(1);
    expect(splitTwins([row({ machine: "ehrc-opd1s-mac-mini.local" })], [ref()]).dropped).toHaveLength(1);
  });
  it("C1: ONLY the daemon/helper pair — guard, steward and any other source are never deduped, against anyone", () => {
    for (const other of ["guard", "steward", "ext", "poller", ""]) {
      expect(splitTwins([row({ source: other })], [ref()]).keep, `${other} incoming`).toHaveLength(1);
      expect(splitTwins([row({ source: "daemon" })], [ref({ source: other })]).keep, `${other} stored`).toHaveLength(1);
      expect(splitTwins([row({ source: other })], [ref({ source: "daemon" })]).dropped).toHaveLength(0);
    }
  });
  it("reports whose copy stood and its ts; keeps the order of the survivors; a bad stored ts is ignored", () => {
    const rows = [row({ seq: 1 }), row({ seq: 2, kind: "x" }), row({ seq: 3, ts: off(60_000) })];
    const out = splitTwins(rows, [ref(), ref({ ts: "not a date" })]);
    expect(out.dropped.map((d) => [d.row.seq, d.twin_source, d.twin_ts])).toEqual([[1, "daemon", off(0)]]);
    expect(seqs(out.keep)).toEqual([2, 3]);
    expect(splitTwins([], [ref()])).toEqual({ keep: [], dropped: [] });
  });
});

describe("splitTwins: ONE-TO-ONE — distinct events are never lost", () => {
  it("THE REFUTER'S PROBE: one stored daemon event, three DISTINCT helper events at -1.5 s, 0, +1.5 s -> exactly ONE is absorbed (the nearest, the one at 0); two are kept", () => {
    const out = splitTwins([row({ seq: 1, ts: off(-1500) }), row({ seq: 2, ts: off(0) }), row({ seq: 3, ts: off(1500) })], [ref()]);
    expect(out.dropped.map((d) => d.row.seq)).toEqual([2]);
    expect(seqs(out.keep)).toEqual([1, 3]);
  });
  it("THE REVERSE: one stored helper event, two daemon events within 1 s -> one absorbed (the nearer), one kept", () => {
    const out = splitTwins([row({ source: "daemon", seq: 1, ts: off(-900) }), row({ source: "daemon", seq: 2, ts: off(300) })], [ref({ source: "helper" })]);
    expect(out.dropped.map((d) => d.row.seq)).toEqual([2]);
    expect(seqs(out.keep)).toEqual([1]);
  });
  it("repeats on BOTH sides pair off one for one: two stored daemon events and three incoming helper events -> two absorbed, one kept", () => {
    const out = splitTwins(
      [row({ seq: 1, ts: off(0) }), row({ seq: 2, ts: off(1000) }), row({ seq: 3, ts: off(500) })],
      [ref({ ts: off(0) }), ref({ ts: off(1000) })],
    );
    expect(out.dropped.map((d) => [d.row.seq, d.twin_ts]).sort()).toEqual([[1, off(0)], [2, off(1000)]]);
    expect(seqs(out.keep)).toEqual([3]);
  });
  it("NEAREST first, not first-come: the helper event at +100 ms takes the daemon event at 0, the one at -1.9 s is left", () => {
    const out = splitTwins([row({ seq: 1, ts: off(-1900) }), row({ seq: 2, ts: off(100) })], [ref()]);
    expect(out.dropped.map((d) => d.row.seq)).toEqual([2]);
  });
  it("two stored events with the SAME ts are two slots (capacity 2): two incoming are absorbed, a third is kept", () => {
    const out = splitTwins([row({ seq: 1 }), row({ seq: 2 }), row({ seq: 3 })], [ref(), ref()]);
    expect(out.dropped).toHaveLength(2);
    expect(out.keep).toHaveLength(1);
  });
  it("a twin ALREADY CONSUMED by an earlier batch (read from the ledger) is not available: the next incoming event is kept; a second twin still is", () => {
    const next = row({ seq: 9, ts: off(300) }); // a different event from the one the ledger says was skipped (ts 0)
    expect(splitTwins([next], [ref()], [led()]).keep).toHaveLength(1);
    expect(splitTwins([next], [ref(), ref({ ts: off(500) })], [led()]).dropped.map((d) => d.twin_ts)).toEqual([off(500)]);
    // the ledger names the twin by (machine, kind, twin_source, twin_ts): consumption of a different twin changes nothing here
    expect(splitTwins([next], [ref()], [led({ twin_ts: off(5000) })]).dropped).toHaveLength(1);
    expect(splitTwins([next], [ref()], [led({ kind: "other" })]).dropped).toHaveLength(1);
  });
  it("a REPLAY of an already-skipped event (same identity) is skipped again and uses no further twin", () => {
    const out = splitTwins([row({ seq: 1, ts: off(0) }), row({ seq: 2, ts: off(700) })], [ref(), ref({ ts: off(700) })], [led({ ts: off(0), twin_ts: off(0) })]);
    expect(out.dropped.map((d) => d.row.seq).sort()).toEqual([1, 2]);
    expect(out.dropped.find((d) => d.row.seq === 1)).toMatchObject({ twin_source: "daemon", twin_ts: off(0) });
  });
  it("events of one batch from the same source never absorb each other", () => {
    expect(splitTwins([row({ seq: 1 }), row({ seq: 2, source: "helper", ts: off(100) })], []).dropped).toHaveLength(0);
  });
});

describe("C1: a replay is keyed on (machine, source, boot_id, seq), not on ts (refuter probe R8)", () => {
  const idLed = (o: Partial<LedgerRef> = {}): LedgerRef => led({ boot_id: "b1", seq: 1, ...o });
  it("R8: a NEW event with the SAME ts as an absorbed one but another seq / boot_id is NOT a replay: it is kept (its twin is already used)", () => {
    // the daemon event at 0 has absorbed helper (b1, 1); a different helper event at the same ts arrives
    const ledger = [idLed({ ts: off(0), twin_ts: off(0) })];
    for (const fresh of [{ boot_id: "b1", seq: 2 }, { boot_id: "b2", seq: 1 }, { boot_id: "b2", seq: 9 }]) {
      const out = splitTwins([row({ ...fresh, ts: off(0) })], [ref()], ledger);
      expect(out.dropped, JSON.stringify(fresh)).toHaveLength(0);
      expect(out.keep, JSON.stringify(fresh)).toHaveLength(1);
    }
  });
  it("a TRUE replay (same machine, source, boot_id, seq) is skipped again with the original twin, and uses no further twin", () => {
    const out = splitTwins([row({ boot_id: "b1", seq: 1, ts: off(0) }), row({ boot_id: "b1", seq: 5, ts: off(700) })], [ref(), ref({ ts: off(700) })], [idLed({ ts: off(0), twin_ts: off(0) })]);
    expect(out.dropped.map((d) => d.row.seq).sort()).toEqual([1, 5]);
    expect(out.dropped.find((d) => d.row.seq === 1)).toMatchObject({ twin_source: "daemon", twin_ts: off(0) });
    // the replay did not consume the twin at 700: the new event (seq 5) took it as its OWN twin, and a further new event at 700 finds nothing left
    expect(splitTwins([row({ boot_id: "b1", seq: 6, ts: off(700) })], [ref(), ref({ ts: off(700) })], [idLed({ ts: off(0), twin_ts: off(0) }), idLed({ seq: 5, ts: off(700), twin_ts: off(700) })]).keep).toHaveLength(1);
  });
  it("the replay identity includes the SOURCE and the MACHINE: the same boot_id/seq from the other source, or another Mac, is a different event", () => {
    const ledger = [idLed({ ts: off(0), twin_ts: off(0) })];
    expect(splitTwins([row({ source: "daemon", boot_id: "b1", seq: 1, ts: off(0) })], [ref({ source: "helper" })], ledger).dropped).toHaveLength(1); // twin of a stored helper event, NOT a replay: its twin is found fresh
    expect(splitTwins([row({ machine: "EHRC-OPD2s-Mac-mini", boot_id: "b1", seq: 1, ts: off(0) })], [ref({ machine: "EHRC-OPD2s-Mac-mini" })], ledger).dropped).toHaveLength(1);
  });
  it("FALLBACK to ts: a ledger row from before 0155 (no boot_id/seq) still recognises a replay by (machine, kind, source, ts); an event that carries no ids is matched by ts against any ledger row", () => {
    const legacy = [led({ ts: off(0), twin_ts: off(0) })];
    expect(splitTwins([row({ boot_id: "b9", seq: 9, ts: off(0) })], [ref()], legacy).dropped).toHaveLength(1);
    const noIds = { boot_id: "", seq: Number.NaN } as Partial<KioskHealthRow>;
    expect(splitTwins([row({ ...noIds, ts: off(0) })], [ref()], [idLed({ ts: off(0), twin_ts: off(0) })]).dropped).toHaveLength(1);
    expect(splitTwins([row({ ...noIds, ts: off(0) })], [ref()], [led({ ts: off(100), twin_ts: off(0) })]).keep).toHaveLength(1); // not a replay (other ts), and the stored twin is already used by the ledger row: kept
  });
  it("an id'd ledger row is NOT matched by ts alone for an id'd incoming event (that was the bug)", () => {
    const out = splitTwins([row({ boot_id: "b2", seq: 7, ts: off(0) })], [], [idLed({ ts: off(0), twin_ts: off(0) })]);
    expect(out.keep).toHaveLength(1);
    expect(out.dropped).toHaveLength(0);
  });
});
