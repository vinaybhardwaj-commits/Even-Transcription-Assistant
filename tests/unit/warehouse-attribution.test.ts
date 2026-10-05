/**
 * Warehouse attribution — the pure rules (pick, precedence, mismatch), the Metabase query shape, the queue SELECT, the
 * UPDATE, and the summary. The DB is a recording fake and Metabase is an injected function: no network, no Postgres here.
 * The same code against a REAL Postgres (and the refresh-preservation proof) is tests/unit/warehouse-attribution-pg.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  attributeFromWarehouse,
  decideAttribution,
  pickWarehouseRow,
  warehouseQuerySql,
  toWarehouseRow,
  type Candidate,
  type WarehouseRow,
} from "@/lib/encounter-windows/warehouse-attribution";
import type { WindowsDb } from "@/lib/encounter-windows/db";
import { makeFakeClinician } from "../support/fake-identity";

const NA = makeFakeClinician(1).full_name;
const NB = makeFakeClinician(2).full_name;
const NX = makeFakeClinician(3).full_name;
const NY = makeFakeClinician(4).full_name;
const NZ = makeFakeClinician(5).full_name;
const NW = makeFakeClinician(6).full_name;
const PADDED = `  ${NA}  `;
const NWH = makeFakeClinician(7).full_name;
const NEXT = makeFakeClinician(8).full_name;

const wh = (o: Partial<WarehouseRow>): WarehouseRow => ({ consult_uid: "C1", prescription_uid: "RX1", doctor_uid: "WDOC1", doctor_name: NWH, created_at: "2026-10-05T04:00:00.000Z", ...o });
const cand = (o: Partial<Candidate> = {}): Candidate => ({
  consult_key: "C1@m", consult_uid: "C1", prescription_ref: "RX1", machine: "m", room_slug: "opd-6", doctor_uid: "EDOC1", display_name: NEXT, ...o,
});

describe("decideAttribution — warehouse > extension > none", () => {
  it("warehouse wins when it names a doctor; the extension doctor is only compared", () => {
    expect(decideAttribution(cand(), wh({}))).toEqual({
      warehouse_doctor_uid: "WDOC1", warehouse_doctor_name: NWH, warehouse_prescription_uid: "RX1",
      consulting_doctor_uid: "WDOC1", consulting_doctor_name: NWH, attribution_source: "warehouse", doctor_mismatch: true,
    });
  });

  it("agreement is not a mismatch; with no warehouse name the extension's display name is used only for the SAME doctor", () => {
    const same = decideAttribution(cand({ doctor_uid: "WDOC1" }), wh({ doctor_name: null }));
    expect(same).toMatchObject({ consulting_doctor_uid: "WDOC1", consulting_doctor_name: NEXT, attribution_source: "warehouse", doctor_mismatch: false });
    const other = decideAttribution(cand(), wh({ doctor_name: null }));
    expect(other).toMatchObject({ consulting_doctor_uid: "WDOC1", consulting_doctor_name: null, attribution_source: "warehouse", doctor_mismatch: true });
  });

  it("warehouse doctor with no extension doctor: warehouse, and NOT a mismatch (nothing to disagree with)", () => {
    expect(decideAttribution(cand({ doctor_uid: null, display_name: null }), wh({}))).toMatchObject({
      attribution_source: "warehouse", consulting_doctor_uid: "WDOC1", doctor_mismatch: false,
    });
  });

  it("extension when the warehouse has nothing (no row, or a row with no doctor)", () => {
    const expected = { consulting_doctor_uid: "EDOC1", consulting_doctor_name: NEXT, attribution_source: "extension", doctor_mismatch: false, warehouse_doctor_uid: null };
    expect(decideAttribution(cand(), null)).toMatchObject(expected);
    const noDoctor = decideAttribution(cand(), wh({ doctor_uid: null }));
    expect(noDoctor).toMatchObject(expected);
    expect(noDoctor.warehouse_prescription_uid).toBe("RX1"); // the matched prescription is still recorded
  });

  it("none when neither source names a doctor", () => {
    expect(decideAttribution(cand({ doctor_uid: null, display_name: null }), null)).toEqual({
      warehouse_doctor_uid: null, warehouse_doctor_name: null, warehouse_prescription_uid: null,
      consulting_doctor_uid: null, consulting_doctor_name: null, attribution_source: "none", doctor_mismatch: false,
    });
  });

  it("an unsafe warehouse doctor uid is treated as no doctor (never stored)", () => {
    expect(decideAttribution(cand(), wh({ doctor_uid: "x'; DROP TABLE y;--" }))).toMatchObject({ warehouse_doctor_uid: null, attribution_source: "extension" });
  });
});

describe("pickWarehouseRow", () => {
  it("takes the EARLIEST _create_time row per consult_uid when there are two", () => {
    const rows = [wh({ doctor_uid: "LATE", created_at: "2026-10-05T04:00:40.000Z" }), wh({ doctor_uid: "EARLY", created_at: "2026-10-05T04:00:05.000Z" })];
    expect(pickWarehouseRow(cand(), rows)!.doctor_uid).toBe("EARLY");
  });

  it("ignores other consults' rows", () => {
    expect(pickWarehouseRow(cand(), [wh({ consult_uid: "OTHER", prescription_uid: "RXO" })])).toBeNull();
  });

  it("falls back to uid = prescription_ref when the consult has no consult_uid, and when its consult_uid matches nothing", () => {
    const row = wh({ consult_uid: "CX", prescription_uid: "RX9", doctor_uid: "BYRX" });
    expect(pickWarehouseRow(cand({ consult_uid: null, prescription_ref: "RX9" }), [row])!.doctor_uid).toBe("BYRX");
    expect(pickWarehouseRow(cand({ consult_uid: "NOPE", prescription_ref: "RX9" }), [row])!.doctor_uid).toBe("BYRX");
    expect(pickWarehouseRow(cand({ consult_uid: null, prescription_ref: null }), [row])).toBeNull();
  });

  it("the consult_uid match outranks a prescription_ref match", () => {
    const byConsult = wh({ doctor_uid: "BYCONSULT", created_at: "2026-10-05T05:00:00.000Z" });
    const byRx = wh({ consult_uid: "CX", prescription_uid: "RX1", doctor_uid: "BYRX", created_at: "2026-10-05T01:00:00.000Z" });
    expect(pickWarehouseRow(cand(), [byRx, byConsult])!.doctor_uid).toBe("BYCONSULT");
  });

  it("among the matches the earliest one that NAMES a doctor wins over an earlier row with none", () => {
    const rows = [wh({ doctor_uid: null, created_at: "2026-10-05T04:00:01.000Z" }), wh({ doctor_uid: "NAMED", created_at: "2026-10-05T04:00:09.000Z" })];
    expect(pickWarehouseRow(cand(), rows)!.doctor_uid).toBe("NAMED");
  });
});

describe("toWarehouseRow", () => {
  it("maps Metabase columns, trims the name and turns empties into null", () => {
    expect(toWarehouseRow({ consult_uid: "c", prescription_uid: "", doctor_uid: "d", doctor_name: PADDED, created_at: "2026-10-05T04:00:00Z" })).toEqual({
      consult_uid: "c", prescription_uid: null, doctor_uid: "d", doctor_name: NA, created_at: "2026-10-05T04:00:00Z",
    });
  });
});

describe("warehouseQuerySql — one read-only SELECT", () => {
  it("joins doctors, filters on both uid lists, orders by _create_time, caps the rows", () => {
    const q = warehouseQuerySql(["C1", "C2"], ["RX1"]);
    expect(q).toContain('FROM "individuals-prescriptions" p LEFT JOIN doctors d ON d.uid = p.doctor_uid');
    expect(q).toContain("p.consult_uid IN ('C1','C2')");
    expect(q).toContain("p.uid IN ('RX1')");
    expect(q).toMatch(/ORDER BY p\._create_time ASC LIMIT 2000$/);
    expect(q).toContain("d.name_with_prefix AS doctor_name");
    expect(q).not.toMatch(/\b(insert|update|delete|drop|alter|truncate)\b/i);
  });

  it("omits an empty list's condition, and refuses an unsafe uid or nothing to look up", () => {
    expect(warehouseQuerySql(["C1"], [])).not.toContain("p.uid IN");
    expect(warehouseQuerySql([], ["RX1"])).not.toContain("p.consult_uid IN");
    expect(() => warehouseQuerySql(["a'b"], [])).toThrow(/unsafe uid/);
    expect(() => warehouseQuerySql([], [])).toThrow(/nothing to look up/);
  });
});

// ------------------------------------------------------------------ the DB side, with a recording fake
type Q = { text: string; vals: unknown[] };
function fakeDb(queue: Candidate[], opts: { updateReturns?: (payload: Array<Record<string, unknown>>) => Array<Record<string, unknown>> } = {}) {
  const issued: Q[] = [];
  const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q: Q = { text: strings.join("?"), vals };
    issued.push(q);
    let out: unknown[] = [];
    if (/^\s*SELECT/.test(q.text)) out = queue;
    else if (/^\s*UPDATE/.test(q.text)) {
      const payload = JSON.parse(q.vals[0] as string) as Array<Record<string, unknown>>;
      out = opts.updateReturns
        ? opts.updateReturns(payload)
        : payload.map((p) => {
            const c = queue.find((x) => x.consult_key === p.consult_key)!;
            return { consult_key: c.consult_key, machine: c.machine, room_slug: c.room_slug, consult_uid: c.consult_uid, doctor_uid: c.doctor_uid, display_name: c.display_name,
              warehouse_doctor_uid: p.warehouse_doctor_uid, warehouse_doctor_name: p.warehouse_doctor_name, doctor_mismatch: p.doctor_mismatch,
              warehouse_attempts: p.warehouse_doctor_uid == null ? 1 : 0 };
          });
    }
    return Object.assign(q, { then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(out).then(res, rej) });
  }) as unknown as WindowsDb;
  return { db: tag, issued };
}

afterEach(() => vi.restoreAllMocks());

describe("attributeFromWarehouse", () => {
  it("reads the queue with bound params, asks Metabase once, writes once, and never assigns the extension's columns", async () => {
    const queue = [cand(), cand({ consult_key: "C2@m", consult_uid: "C2", prescription_ref: null, doctor_uid: null, display_name: null })];
    const { db, issued } = fakeDb(queue);
    const query = vi.fn().mockResolvedValue([
      { consult_uid: "C1", prescription_uid: "RX1", doctor_uid: "WDOC1", doctor_name: NW, created_at: "2026-10-05T04:00:00Z" },
    ]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await attributeFromWarehouse(db, { hours: 36, limit: 500, query });

    expect(r).toEqual({ candidates: 2, checked: 2, resolved: 1, unresolved: 1, mismatches: 1, raced: 0, deferred: 0, gave_up: 0 });
    // queue SELECT: bound values only, the three gates in the WHERE
    const select = issued[0]!;
    expect(select.vals).toEqual([36, 12, 10, 500]); // hours, MAX_UNRESOLVED_CHECKS, recheck minutes, limit
    expect(select.text).toMatch(/consult_uid IS NOT NULL OR prescription_ref IS NOT NULL/);
    expect(select.text).toMatch(/warehouse_checked_at IS NULL/);
    expect(select.text).toMatch(/warehouse_doctor_uid IS NULL AND warehouse_attempts < \?::int\s+AND warehouse_checked_at < now\(\)/);
    // one Metabase call with both uid kinds inlined only through the escaper
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain("p.consult_uid IN ('C1','C2')");
    expect(query.mock.calls[0]![0]).toContain("p.uid IN ('RX1')");
    // the UPDATE: bound JSON, and its SET list assigns warehouse_*/consulting_*/attribution_source/doctor_mismatch only
    const update = issued[1]!;
    expect(issued).toHaveLength(2);
    const setList = /SET([\s\S]*?)\sFROM\s/.exec(update.text)![1]!;
    expect(setList).not.toMatch(/(^|[\s,])(doctor_uid|display_name|attribution)\s*=/);
    for (const col of ["warehouse_doctor_uid", "warehouse_doctor_name", "warehouse_prescription_uid", "warehouse_checked_at", "warehouse_attempts", "consulting_doctor_uid", "consulting_doctor_name", "attribution_source", "doctor_mismatch"]) {
      expect(setList).toContain(col);
    }
    const payload = JSON.parse(update.vals[0] as string) as Array<Record<string, unknown>>;
    expect(payload.map((p) => [p.consult_key, p.attribution_source, p.consulting_doctor_uid, p.doctor_mismatch])).toEqual([
      ["C1@m", "warehouse", "WDOC1", true],
      ["C2@m", "none", null, false],
    ]);
    expect(update.text).toMatch(/w\.doctor_uid IS NOT DISTINCT FROM r\.ext_uid/);
    // the mismatch is logged at info with room, consult_uid, both uids and names
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toBe(`[warehouse-attribution] mismatch room=opd-6 consult_uid=C1 extension=EDOC1(${NEXT}) warehouse=WDOC1(${NW})`);
  });

  it("an empty queue makes no Metabase call and no write", async () => {
    const { db, issued } = fakeDb([]);
    const query = vi.fn();
    expect(await attributeFromWarehouse(db, { query })).toEqual({ candidates: 0, checked: 0, resolved: 0, unresolved: 0, mismatches: 0, raced: 0, deferred: 0, gave_up: 0 });
    expect(query).not.toHaveBeenCalled();
    expect(issued).toHaveLength(1);
  });

  it("an unsafe uid never reaches Metabase; the row is still stamped (unresolved)", async () => {
    const evil = cand({ consult_key: "x@m", consult_uid: "x'; DROP TABLE doctors;--", prescription_ref: null });
    const { db, issued } = fakeDb([evil]);
    const query = vi.fn();
    const r = await attributeFromWarehouse(db, { query });
    expect(query).not.toHaveBeenCalled();
    expect(r).toMatchObject({ candidates: 1, checked: 1, resolved: 0, unresolved: 1 });
    expect(issued.every((q) => !q.text.includes("DROP"))).toBe(true);
  });

  it("EVERY chunk is gated on the deadline, the first included: an expired deadline calls Metabase zero times and defers the queue", async () => {
    const queue = ["A", "B", "C"].map((n) => cand({ consult_key: `${n}@m`, consult_uid: `${n}1`, prescription_ref: null }));
    const { db, issued } = fakeDb(queue);
    const query = vi.fn().mockResolvedValue([]);
    const r = await attributeFromWarehouse(db, { query, chunkSize: 1, deadlineMs: Date.now() - 1 });
    expect(query).not.toHaveBeenCalled();
    expect(issued.filter((q) => /UPDATE/.test(q.text))).toHaveLength(0);
    expect(r).toMatchObject({ candidates: 3, checked: 0, deferred: 3 });
  });

  it("a deadline that passes DURING a chunk defers the following chunks (they stay queued)", async () => {
    const queue = ["A", "B", "C"].map((n) => cand({ consult_key: `${n}@m`, consult_uid: `${n}1`, prescription_ref: null }));
    const { db } = fakeDb(queue);
    const query = vi.fn(async () => { await new Promise((res) => setTimeout(res, 60)); return []; });
    const r = await attributeFromWarehouse(db, { query, chunkSize: 1, deadlineMs: Date.now() + 30 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ candidates: 3, checked: 1, deferred: 2 });
    const { db: db2 } = fakeDb(queue);
    const q2 = vi.fn().mockResolvedValue([]);
    const all = await attributeFromWarehouse(db2, { query: q2, chunkSize: 1 });
    expect(q2).toHaveBeenCalledTimes(3);
    expect(all).toMatchObject({ checked: 3, deferred: 0 });
  });

  it("rows the UPDATE skipped (extension doctor moved since the read) are counted as raced, not checked", async () => {
    const { db } = fakeDb([cand()], { updateReturns: () => [] });
    const r = await attributeFromWarehouse(db, { query: vi.fn().mockResolvedValue([]) });
    expect(r).toMatchObject({ candidates: 1, checked: 0, raced: 1 });
  });

  it("a Metabase failure propagates and nothing is written", async () => {
    const { db, issued } = fakeDb([cand()]);
    await expect(attributeFromWarehouse(db, { query: vi.fn().mockRejectedValue(new Error("Metabase: timed out after 25000 ms")) })).rejects.toThrow(/timed out/);
    expect(issued.filter((q) => /UPDATE/.test(q.text))).toHaveLength(0);
  });

  it("clamps hours to 1..720 and limit to 1..2000", async () => {
    const a = fakeDb([]);
    await attributeFromWarehouse(a.db, { hours: 100000, limit: 999999 });
    expect(a.issued[0]!.vals).toEqual([720, 12, 10, 2000]);
    const b = fakeDb([]);
    await attributeFromWarehouse(b.db, { hours: 0, limit: 0 });
    expect(b.issued[0]!.vals).toEqual([1, 12, 10, 1]);
  });

  it("RETRY CAP: the write bumps warehouse_attempts only for an unresolved lookup, and the 12th unresolved one is reported as gave_up", async () => {
    const { db, issued } = fakeDb([cand(), cand({ consult_key: "C2@m", consult_uid: "C2", prescription_ref: null })], {
      updateReturns: (payload) => payload.map((p) => ({
        consult_key: p.consult_key, machine: "m", room_slug: "opd-6", consult_uid: p.consult_key === "C1@m" ? "C1" : "C2", doctor_uid: "EDOC1", display_name: "x",
        warehouse_doctor_uid: p.warehouse_doctor_uid, warehouse_doctor_name: null, doctor_mismatch: p.doctor_mismatch,
        warehouse_attempts: p.consult_key === "C1@m" ? 0 : 12, // C1 resolved; C2 just used its 12th unresolved check
      })),
    });
    const r = await attributeFromWarehouse(db, { query: vi.fn().mockResolvedValue([wh({ doctor_uid: "WDOC1" })]) });
    expect(r).toMatchObject({ resolved: 1, unresolved: 1, gave_up: 1 });
    expect(issued[1]!.text).toMatch(/warehouse_attempts\s+= w\.warehouse_attempts \+ CASE WHEN r\.warehouse_doctor_uid IS NULL THEN 1 ELSE 0 END/);
  });
});
