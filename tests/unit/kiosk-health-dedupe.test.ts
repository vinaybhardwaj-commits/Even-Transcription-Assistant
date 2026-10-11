/** TS-H10 #47: cross-source twin detection, pure. */
import { describe, it, expect } from "vitest";
import { DEDUPE_WINDOW_MS, splitTwins, type StoredRef } from "@/lib/kiosk-health-dedupe";
import type { KioskHealthRow } from "@/lib/kiosk-health-ingest";

const T0 = Date.parse("2026-10-11T10:00:00.000Z");
const row = (o: Partial<KioskHealthRow> = {}): KioskHealthRow => ({ machine: "EHRC-OPD1s-Mac-mini", room_id: null, install_id: null, boot_id: "b", seq: 1, source: "helper", kind: "heartbeat", ts: new Date(T0).toISOString(), payload: {}, ...o });
const ref = (o: Partial<StoredRef> = {}): StoredRef => ({ machine: "EHRC-OPD1s-Mac-mini", kind: "heartbeat", source: "daemon", ts: new Date(T0).toISOString(), ...o });
const off = (ms: number) => new Date(T0 + ms).toISOString();

describe("splitTwins", () => {
  it("a different-source event of the same Mac and kind within 2 s is a twin (both directions in time, inclusive at the edge)", () => {
    expect(DEDUPE_WINDOW_MS).toBe(2000);
    for (const d of [0, 1, -1, 1999, -1999, 2000, -2000]) expect(splitTwins([row()], [ref({ ts: off(d) })]).dropped, String(d)).toHaveLength(1);
  });
  it("2001 ms apart is NOT a twin", () => {
    expect(splitTwins([row()], [ref({ ts: off(2001) })]).keep).toHaveLength(1);
    expect(splitTwins([row()], [ref({ ts: off(-2001) })]).keep).toHaveLength(1);
  });
  it("the SAME source is never a twin (a sender may repeat a kind inside 2 s)", () => {
    expect(splitTwins([row({ source: "daemon" })], [ref({ source: "daemon" })]).keep).toHaveLength(1);
    expect(splitTwins([row({ source: "helper" })], [ref({ source: "helper" })]).keep).toHaveLength(1);
  });
  it("a different kind or a different Mac is not a twin; the same Mac under another spelling is", () => {
    expect(splitTwins([row()], [ref({ kind: "power.sleep" })]).keep).toHaveLength(1);
    expect(splitTwins([row()], [ref({ machine: "EHRC-OPD2s-Mac-mini" })]).keep).toHaveLength(1);
    expect(splitTwins([row()], [ref({ machine: "EHRC-OPD1’s Mac mini" })]).dropped).toHaveLength(1);
    expect(splitTwins([row({ machine: "ehrc-opd1s-mac-mini.local" })], [ref()]).dropped).toHaveLength(1);
  });
  it("reports which source's copy stood; keeps the order of the survivors; a bad stored ts is ignored", () => {
    const rows = [row({ seq: 1 }), row({ seq: 2, kind: "x" }), row({ seq: 3, ts: off(60_000) })];
    const out = splitTwins(rows, [ref(), ref({ ts: "not a date" })]);
    expect(out.dropped.map((d) => [d.row.seq, d.twin_source])).toEqual([[1, "daemon"]]);
    expect(out.keep.map((r) => r.seq)).toEqual([2, 3]);
    expect(splitTwins([], [ref()])).toEqual({ keep: [], dropped: [] });
  });
});
