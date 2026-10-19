/** Spine S1 R2 (mocked driver): Date-typed priors keep the rev rule, the lost-race retry, readIngestMode on error, the kill_switch string. Synthetic ids only. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const D = vi.hoisted(() => ({ handler: null as null | ((text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>), calls: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: async (text: string, params: unknown[]) => { D.calls.push(text); return D.handler!(text, params); } }));

import { storeSignals, readIngestMode } from "@/lib/spine/ingest-store";
import { parseIngestMode } from "@/lib/spine/config";
import { signalHash, toSignals } from "@/lib/spine/ingest";

const s = (over: Record<string, unknown> = {}) => ({ proxy: "pqm" as const, source_key: "pqm_a1b2c3d4e5f6a7b8c9d0e1", room_id: null, t_open: "2026-10-18T04:00:00.250Z", t_close: "2026-10-18T04:10:00.750Z", observed_at: "2026-10-18T04:20:00.000Z", attrs: {}, ...over });
const isPrior = (t: string) => /FROM spine_signal WHERE proxy/.test(t);
const isInsert = (t: string) => /INSERT INTO spine_signal/.test(t);
const echo = (params: unknown[]) => (JSON.parse(params[0] as string) as Array<Record<string, unknown>>).map((r) => ({ proxy: r.proxy, source_key: r.source_key, source_rev: r.source_rev }));
const prior = (rev: number, t_open: unknown, t_close: unknown) => [{ source_key: "pqm_a1b2c3d4e5f6a7b8c9d0e1", source_rev: rev, room_id: null, t_open, t_close, close_reason: null }];

beforeEach(() => { D.calls.length = 0; });

describe("rev rule with the Neon driver's Date timestamps", () => {
  for (const [label, mk] of [["Date", (v: string) => new Date(v)], ["ISO string", (v: string) => v], ["pg text", (v: string) => v.replace("T", " ").replace("Z", "+00")]] as const) {
    it(`an unchanged re-post is a duplicate with ${label} priors (milliseconds kept)`, async () => {
      D.handler = async (t, p) => (isPrior(t) ? prior(1, mk("2026-10-18T04:00:00.250Z"), mk("2026-10-18T04:10:00.750Z")) : isInsert(t) ? echo(p) : []);
      expect(await storeSignals([s()])).toEqual({ inserted: 0, duplicate: 1, conflict: 0 });
    });
    it(`a changed re-post is rev 2 with ${label} priors`, async () => {
      let sent: Array<Record<string, unknown>> = [];
      D.handler = async (t, p) => (isPrior(t) ? prior(1, mk("2026-10-18T04:00:00.250Z"), mk("2026-10-18T04:10:00.750Z")) : isInsert(t) ? ((sent = JSON.parse(p[0] as string)), echo(p)) : []);
      expect(await storeSignals([s({ t_close: "2026-10-18T04:11:00.000Z" })])).toEqual({ inserted: 1, duplicate: 0, conflict: 0 });
      expect(sent[0].source_rev).toBe(2);
    });
  }
  it("signalHash is the same for a Date and its ISO string", () => {
    const o = { t_close: null, room_id: "r", close_reason: "a" };
    expect(signalHash({ ...o, t_open: new Date("2026-10-18T04:00:00.123Z") })).toBe(signalHash({ ...o, t_open: "2026-10-18T04:00:00.123Z" }));
  });
});

describe("lost race on the rev", () => {
  it("re-reads the newest rev and retries with rev+1", async () => {
    let inserts = 0;
    const revs: number[] = [];
    D.handler = async (t, p) => {
      if (isPrior(t)) return inserts === 0 ? prior(1, "2026-10-18T04:00:00.250Z", "2026-10-18T04:10:00.750Z") : prior(2, "2026-10-18T04:00:00.250Z", "2026-10-18T04:12:00.000Z");   // someone else stored rev 2 meanwhile
      if (isInsert(t)) { inserts += 1; const rows = JSON.parse(p[0] as string); revs.push(rows[0].source_rev); return inserts === 1 ? [] : echo(p); }
      return [];
    };
    expect(await storeSignals([s({ t_close: "2026-10-18T04:11:00.000Z" })])).toEqual({ inserted: 1, duplicate: 0, conflict: 0 });
    expect(revs).toEqual([2, 3]);
  });
  it("the competitor stored identical content: a duplicate, not an insert", async () => {
    let inserts = 0;
    D.handler = async (t, p) => {
      if (isPrior(t)) return inserts === 0 ? prior(1, "2026-10-18T04:00:00.250Z", "2026-10-18T04:10:00.750Z") : prior(2, "2026-10-18T04:00:00.250Z", "2026-10-18T04:11:00.000Z");
      if (isInsert(t)) { inserts += 1; return []; }
      return [];
    };
    expect(await storeSignals([s({ t_close: "2026-10-18T04:11:00.000Z" })])).toEqual({ inserted: 0, duplicate: 1, conflict: 0 });
  });
  it("still losing after 3 tries is a conflict, never a duplicate", async () => {
    let n = 0;
    D.handler = async (t) => {
      if (isPrior(t)) { n += 1; return prior(n, "2026-10-18T04:00:00.250Z", `2026-10-18T04:${String(10 + n).padStart(2, "0")}:00.000Z`); }
      return [];
    };
    expect(await storeSignals([s({ t_close: "2026-10-18T05:00:00.000Z" })])).toEqual({ inserted: 0, duplicate: 0, conflict: 1 });
    expect(D.calls.filter(isInsert).length).toBe(3);
  });
  it("an explicit rev that already exists is a duplicate", async () => {
    D.handler = async (t) => (isInsert(t) ? [] : []);
    expect(await storeSignals([{ ...s(), source_rev: 1 }])).toEqual({ inserted: 0, duplicate: 1, conflict: 0 });
  });
});

describe("config gate", () => {
  it("a failed config read means off", async () => {
    D.handler = async () => { throw new Error("db down"); };
    expect(await readIngestMode()).toBe("off");
  });
  it("a jsonb STRING kill_switch is malformed, i.e. killed", () => {
    for (const k of ["false", "true", '"false"', "no"]) expect(parseIngestMode([{ key: "ingest", value: "shadow" }, { key: "kill_switch", value: k }]), k).toBe("off");
    expect(parseIngestMode([{ key: "ingest", value: "shadow" }, { key: "kill_switch", value: false }])).toBe("shadow");
    expect(parseIngestMode([{ key: "ingest", value: "shadow" }, { key: "kill_switch", value: { on: false } }])).toBe("shadow");
  });
});

describe("toSignals carries run_id for acoustic", () => {
  it("attrs.ids has hypothesis_id and run_id", () => {
    const [a] = toSignals([{ id: "eh_abcdefghjkmn", run_id: "run_test_01", room_day_id: "rd_abcd2345", room_id: "r", start_ms: 1760760000000, end_ms: 1760760600000, closed_by: "non_speech", created_at: "2026-10-18T05:00:00Z" }], "acoustic");
    expect(a.attrs.ids).toEqual({ hypothesis_id: "eh_abcdefghjkmn", room_day_id: "rd_abcd2345", run_id: "run_test_01" });
  });
});
