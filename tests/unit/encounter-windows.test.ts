/**
 * Encounter windows — the resolver reproduces the reference run (2-4 Oct 2026) and handles the pairing edges.
 *
 * The fixture (tests/fixtures/encounter-windows) is the reference's raw event export with encounter ids, refs and
 * names pseudonymised, and expected.json is the reference's 114 consults reduced to comparable facts. The reference
 * is V's ~/pulse-watch/gate-p1 (consults.mjs on top of occupancy.mjs), which queried Neon live; these tests run the
 * TypeScript port over the same events in memory.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import {
  computeWindows,
  computeWindowsDetailed,
  refreshWindows,
  RESOLVER_VERSION,
  type PresenceEvent,
  type RoomRef,
  type WindowsDb,
} from "@/lib/encounter-windows";

// ---------------------------------------------------------------- reference fixture
const FIX = join(process.cwd(), "tests/fixtures/encounter-windows");
type Tuple = [number, string, string, string, string, string | null, string | null, string | null, string | null, number];
const events: PresenceEvent[] = (JSON.parse(gunzipSync(readFileSync(join(FIX, "events.json.gz"))).toString("utf8")) as Tuple[]).map(
  ([id, source, machine, event, ts, uid, dn, enc, rx, focus]) => ({ id, source, machine, event, ts, uid, dn, enc, rx, focus: focus === 1 }),
);
type Expected = {
  xwalk: Record<string, { room_id: string; slug: string } | null>;
  unpaired_refs_total: number;
  consults: Array<{
    machine: string; room_id: string | null; slug: string | null; ist_date: string; open_ms: number; close_ms: number;
    close_by: string; unclosed: boolean; reopens: number; uid: string | null; attrib: string; multi_doc: boolean; n_present_open: number;
  }>;
};
const expected = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8")) as Expected;
const crosswalk = new Map<string, RoomRef>();
for (const [m, r] of Object.entries(expected.xwalk)) if (r) crosswalk.set(m, { room_id: r.room_id, slug: r.slug });

const IST = 19_800_000;
const istDate = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const FROM = "2026-10-01T18:30:00Z"; // 2 Oct 00:00 IST
const TO = "2026-10-04T18:30:00Z"; //   5 Oct 00:00 IST
const CLOSE_MAP: Record<string, string> = { enc_close: "endConsult", ref_close: "url_clear", "idle_logout:idle": "idle_timeout", cap90: "cap_90m" };

describe("computeWindows reproduces the reference run (2-4 Oct 2026)", () => {
  // asOf = end of the range: "now" is well past every consult's 90-minute cap, as it was for the reference run
  // (which had no clock). The export ends 2 minutes after the last consult opened; see the open-at-export-end test.
  const { rows, summary } = computeWindowsDetailed(events, { from: FROM, to: TO, asOf: TO, crosswalk });
  const ms = (s: string | null) => (s === null ? NaN : new Date(s).getTime());

  it("finds the same 114 consults, same machine, open and close within 1 s", () => {
    expect(rows).toHaveLength(114);
    expect(expected.consults).toHaveLength(114);
    const taken = new Set<string>();
    for (const x of expected.consults) {
      const hit = rows.filter((r) => r.machine === x.machine && Math.abs(ms(r.t_open) - x.open_ms) <= 1000 && !taken.has(r.consult_key));
      expect(hit, `consult ${x.machine} @${x.open_ms}`).toHaveLength(1);
      const r = hit[0]!;
      taken.add(r.consult_key);
      expect(Math.abs(ms(r.t_close) - x.close_ms), `close of ${x.machine} @${x.open_ms}`).toBeLessThanOrEqual(1000);
      expect(r.close_reason).toBe(CLOSE_MAP[x.close_by]);
      expect(r.reopen_count).toBe(x.reopens);
      expect(r.room_id).toBe(x.room_id);
      expect(r.room_slug).toBe(x.slug);
      expect(istDate(ms(r.t_open))).toBe(x.ist_date);
    }
    expect(taken.size).toBe(114);
    expect(new Set(rows.map((r) => r.consult_key)).size).toBe(114);
  });

  it("attributes like the reference: 85 from rows, 15 from the occupant, 14 none (all at OPD 5)", () => {
    expect(summary.by_attribution).toEqual({ rows: 85, occupant: 15, none: 14 });
    for (const x of expected.consults) {
      const r = rows.find((q) => q.machine === x.machine && Math.abs(ms(q.t_open) - x.open_ms) <= 1000)!;
      expect(r.doctor_uid, `uid of ${x.machine} @${x.open_ms}`).toBe(x.uid);
      const want = x.attrib === "row" ? "rows" : x.attrib.startsWith("occupancy") ? "occupant" : "none";
      expect(r.attribution).toBe(want);
    }
    const none = rows.filter((r) => r.attribution === "none");
    expect(none).toHaveLength(14);
    expect(new Set(none.map((r) => r.room_slug))).toEqual(new Set(["opd-5-wxmp"]));
  });

  it("flags 21 multi_doctor at OPD 4 Ortho, matching the reference's multi-doc set", () => {
    const multi = rows.filter((r) => r.quality === "multi_doctor");
    expect(multi).toHaveLength(21);
    expect(new Set(multi.map((r) => r.room_slug))).toEqual(new Set(["opd-4-ortho-778q"]));
    expect(expected.consults.filter((x) => x.multi_doc)).toHaveLength(21);
  });

  it("flags exactly 2 unclosed: the 90-minute cap and the idle close", () => {
    const un = rows.filter((r) => r.quality === "unclosed");
    expect(un).toHaveLength(2);
    expect(un.map((r) => r.close_reason).sort()).toEqual(["cap_90m", "idle_timeout"]);
    expect(summary.by_quality.unclosed).toBe(2);
    // the idle-closed one is also attribution none, so quality shows 13 unattributed + that one unclosed
    expect(summary.by_quality.unattributed).toBe(13);
    expect(summary.by_quality.ambiguous).toBe(0);
    expect(summary.by_quality.clean).toBe(114 - 21 - 2 - 13);
  });

  it("has no overlapping windows on one machine", () => {
    const by = new Map<string, Array<[number, number]>>();
    for (const r of rows) {
      const a = by.get(r.machine) ?? [];
      a.push([ms(r.t_open), ms(r.t_close)]);
      by.set(r.machine, a);
    }
    for (const [m, iv] of by) {
      iv.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < iv.length; i++) expect(iv[i]![0] - iv[i - 1]![1], `overlap on ${m}`).toBeGreaterThanOrEqual(-1000);
    }
  });

  it("counts 62 unpaired prescription_ref opens over the whole export, and none become consults", () => {
    const wide = computeWindowsDetailed(events, { from: "2026-10-01T12:00:00Z", to: "2026-10-05T00:00:00Z", crosswalk });
    expect(wide.summary.unpaired_refs).toBe(62);
    expect(expected.unpaired_refs_total).toBe(62);
    expect(summary.consults).toBe(114);
  });

  it("is deterministic: recomputing gives identical rows", () => {
    expect(computeWindows(events, { from: FROM, to: TO, asOf: TO, crosswalk })).toEqual(rows);
  });

  it("respects the half-open range on t_open", () => {
    const first = rows[0]!;
    expect(computeWindows(events, { from: first.t_open, to: TO, asOf: TO, crosswalk })).toHaveLength(114);
    expect(computeWindows(events, { from: new Date(ms(first.t_open) + 1).toISOString(), to: TO, asOf: TO, crosswalk })).toHaveLength(113);
    expect(computeWindows(events, { from: FROM, to: first.t_open, asOf: TO, crosswalk })).toHaveLength(0);
  });

  it("at the export's own end the last OPD 6 consult is still `open` (t_close null), not capped", () => {
    const live = computeWindows(events, { from: FROM, to: TO, crosswalk });
    const still = live.filter((r) => r.close_reason === "open");
    expect(still).toHaveLength(1);
    expect(still[0]!.t_close).toBeNull();
    expect(still[0]!.quality).toBe("unclosed");
    expect(live).toHaveLength(114);
  });
});

// ---------------------------------------------------------------- synthetic edge cases
const M = "EHRC-TEST1s-Mac-mini";
const T0 = Date.parse("2026-10-03T06:00:00Z"); // 11:30 IST
const at = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000).toISOString();
let seq = 1000;
const ev = (event: string, ts: string, x: Partial<PresenceEvent> = {}): PresenceEvent => ({ id: seq++, source: "ext", machine: M, event, ts, ...x });
const open = (ts: string, enc: string, uid: string | null = null) => ev("encounter_open", ts, { enc, uid });
const refOpen = (ts: string, rx: string, uid: string | null = null) => ev("encounter_open", ts, { rx, uid });
const close = (ts: string, x: { enc?: string; rx?: string; uid?: string | null }) => ev("encounter_close", ts, x);
const run = (es: PresenceEvent[], asOf?: string | number) => computeWindowsDetailed(es, asOf === undefined ? {} : { asOf });

describe("pairing edge cases", () => {
  it("pairs an encounter_id open with a prescription_ref open BEFORE it; opens at the earlier of the two", () => {
    const { rows } = run([refOpen(at(0), "R1"), open(at(0, 20), "E1"), close(at(5), { rx: "R1" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.t_open).toBe(at(0));
    expect(rows[0]!.prescription_ref).toBe("R1");
    expect(rows[0]!.consult_key).toBe("E1");
    expect(rows[0]!.close_reason).toBe("url_clear");
    expect(rows[0]!.t_close).toBe(at(5));
  });

  it("pairs a ref open AFTER the encounter open and takes the nearest of two candidates", () => {
    const { rows, summary } = run([open(at(0), "E1"), refOpen(at(0, 40), "FAR"), refOpen(at(0, 10), "NEAR"), close(at(3), { rx: "NEAR" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prescription_ref).toBe("NEAR");
    expect(rows[0]!.t_open).toBe(at(0));
    expect(summary.unpaired_refs).toBe(1); // FAR has no partner
  });

  it("does not pair opens more than 60 s apart, and a ref-only open is NOT a consult", () => {
    const { rows, summary } = run([refOpen(at(0), "R1"), open(at(2), "E1"), close(at(4), { enc: "E1" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prescription_ref).toBeNull();
    expect(rows[0]!.t_open).toBe(at(2));
    expect(summary.unpaired_refs).toBe(1);
    expect(run([refOpen(at(0), "R9")]).rows).toHaveLength(0);
  });

  it("merges reopens of the same encounter_id (reopen_count) and closes after the last open", () => {
    const { rows } = run([open(at(0), "E1"), open(at(6), "E1"), close(at(9), { enc: "E1" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reopen_count).toBe(1);
    expect(rows[0]!.t_open).toBe(at(0));
    expect(rows[0]!.t_close).toBe(at(9));
    expect(rows[0]!.close_reason).toBe("endConsult");
  });

  it("prefers the encounter_id close (endConsult) over a prescription_ref close, and takes the LATEST ref close", () => {
    const both = run([refOpen(at(0), "R1"), open(at(0, 5), "E1"), close(at(4), { rx: "R1" }), close(at(5), { enc: "E1" })]).rows[0]!;
    expect(both.close_reason).toBe("endConsult");
    expect(both.t_close).toBe(at(5));
    const refs = run([refOpen(at(0), "R1"), open(at(0, 5), "E1"), close(at(4), { rx: "R1" }), close(at(7), { rx: "R1" })]).rows[0]!;
    expect(refs.close_reason).toBe("url_clear");
    expect(refs.t_close).toBe(at(7));
  });

  it("closes at the next different consult's open when nothing else closes it (next_open, flagged unclosed)", () => {
    const { rows } = run([open(at(0), "E1"), open(at(12), "E2"), close(at(15), { enc: "E2" })]);
    const e1 = rows.find((r) => r.consult_uid === "E1")!;
    expect(e1.close_reason).toBe("next_open");
    expect(e1.t_close).toBe(at(12));
    expect(e1.quality).toBe("unclosed");
    expect(rows.find((r) => r.consult_uid === "E2")!.close_reason).toBe("endConsult");
  });

  it("does not let a later consult's close steal the earlier consult's window", () => {
    const { rows } = run([open(at(0), "E1"), open(at(12), "E2"), close(at(15), { enc: "E1" })]);
    // E1's close arrives after E2 opened: outside E1's bound, so E1 falls back to next_open
    expect(rows.find((r) => r.consult_uid === "E1")!.close_reason).toBe("next_open");
  });

  it("closes on idle and logout events (idle_timeout / logout)", () => {
    const idle = run([open(at(0), "E1"), ev("idle", at(8))]).rows[0]!;
    expect(idle.close_reason).toBe("idle_timeout");
    expect(idle.t_close).toBe(at(8));
    const locked = run([open(at(0), "E1"), ev("locked", at(8))]).rows[0]!;
    expect(locked.close_reason).toBe("idle_timeout");
    const out = run([open(at(0), "E1"), ev("logout", at(9), { uid: "U1" })]).rows[0]!;
    expect(out.close_reason).toBe("logout");
    expect(out.quality).toBe("unclosed");
  });

  it("caps at 90 minutes: a fallback later than 90 minutes is cut to open + 90 min", () => {
    const { rows } = run([open(at(0), "E1"), ev("idle", at(150))]);
    expect(rows[0]!.close_reason).toBe("cap_90m");
    expect(rows[0]!.t_close).toBe(at(90));
    expect(rows[0]!.quality).toBe("unclosed");
  });

  it("with nothing after it: cap_90m once 90 minutes have passed, `open` (t_close null) before that", () => {
    const es = [open(at(0), "E1")];
    const capped = run(es, at(100)).rows[0]!;
    expect(capped.close_reason).toBe("cap_90m");
    expect(capped.t_close).toBe(at(90));
    const stillOpen = run(es, at(10)).rows[0]!;
    expect(stillOpen.close_reason).toBe("open");
    expect(stillOpen.t_close).toBeNull();
    expect(stillOpen.quality).toBe("unclosed");
  });

  it("keeps the same consult_key and one row per consult across machines and runs", () => {
    const other = { machine: "EHRC-TEST2s-Mac-mini" };
    const es = [open(at(0), "E1"), close(at(3), { enc: "E1" }), ev("encounter_open", at(1), { enc: "E1", ...other }), ev("encounter_close", at(4), { enc: "E1", ...other })];
    const { rows } = run(es);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.consult_key)).size).toBe(2);
  });
});

describe("attribution and quality", () => {
  const login = (min: number, uid: string, dn = "Dr X") => ev("login", at(min), { uid, dn });
  const hb = (min: number, uid: string, focus: boolean) => ev("heartbeat", at(min), { uid, focus });

  it("takes the doctor from the consult's own rows (rows), counting the close rows too", () => {
    const own = run([open(at(0), "E1", "UB"), close(at(4), { enc: "E1", uid: "UB" })]).rows[0]!;
    expect(own.attribution).toBe("rows");
    expect(own.doctor_uid).toBe("UB");
    expect(own.quality).toBe("clean");
    // open row has no uid, the close row does
    const viaClose = run([open(at(0), "E1"), close(at(4), { enc: "E1", uid: "UB" })]).rows[0]!;
    expect(viaClose.attribution).toBe("rows");
    expect(viaClose.doctor_uid).toBe("UB");
  });

  it("rows win over the occupant, but a second doctor present still marks the window multi_doctor", () => {
    const r = run([login(-5, "UA"), open(at(0), "E1", "UB"), close(at(4), { enc: "E1", uid: "UB" })]).rows[0]!;
    expect(r.attribution).toBe("rows");
    expect(r.doctor_uid).toBe("UB");
    expect(r.quality).toBe("multi_doctor");
  });

  it("falls back to the occupant at open time (occupant) when the rows carry no uid", () => {
    const { rows } = run([login(-5, "UA", "Dr A"), open(at(0), "E1"), close(at(4), { enc: "E1" })]);
    expect(rows[0]!.attribution).toBe("occupant");
    expect(rows[0]!.doctor_uid).toBe("UA");
    expect(rows[0]!.display_name).toBe("Dr A");
    expect(rows[0]!.quality).toBe("clean");
  });

  it("is none / unattributed when nobody is present and the rows carry no uid", () => {
    const { rows } = run([open(at(0), "E1"), close(at(4), { enc: "E1" })]);
    expect(rows[0]!.attribution).toBe("none");
    expect(rows[0]!.doctor_uid).toBeNull();
    expect(rows[0]!.quality).toBe("unattributed");
  });

  it("does not count a stream with no genuine activity in 45 minutes, nor one logged out, nor an idle machine", () => {
    expect(run([login(-60, "UA"), open(at(0), "E1"), close(at(4), { enc: "E1" })]).rows[0]!.attribution).toBe("none"); // 45-minute rule
    expect(run([login(-5, "UA"), ev("logout", at(-2), { uid: "UA" }), open(at(0), "E1"), close(at(4), { enc: "E1" })]).rows[0]!.attribution).toBe("none");
    expect(run([login(-5, "UA"), ev("idle", at(-1)), open(at(0), "E1"), close(at(4), { enc: "E1" })]).rows[0]!.attribution).toBe("none");
  });

  it("does not count a stream whose last activity predates the 00:00 IST cutoff", () => {
    const t = (s: string) => s;
    const evs = [
      ev("login", t("2026-10-03T18:20:00Z"), { uid: "UA" }), // 23:50 IST on 3 Oct
      ev("encounter_open", t("2026-10-03T18:35:00Z"), { enc: "E1" }), // 00:05 IST on 4 Oct, 15 min later
      ev("encounter_close", t("2026-10-03T18:40:00Z"), { enc: "E1" }),
    ];
    expect(computeWindows(evs)[0]!.attribution).toBe("none");
  });

  it("flags multi_doctor when two doctors are present at open, and picks the focused tab as occupant", () => {
    const { rows } = run([login(-6, "UA"), login(-5, "UB"), hb(-1, "UA", false), hb(-1, "UB", true), open(at(0), "E1"), close(at(4), { enc: "E1" })]);
    expect(rows[0]!.quality).toBe("multi_doctor");
    expect(rows[0]!.attribution).toBe("occupant");
    expect(rows[0]!.doctor_uid).toBe("UB");
  });

  it("flags ambiguous when two focused profiles cannot be separated and the rows carry no uid", () => {
    const { rows } = run([login(-8, "UA"), login(-8, "UB"), hb(-1, "UA", true), hb(-1, "UB", true), open(at(0), "E1"), close(at(4), { enc: "E1" })]);
    expect(rows[0]!.attribution).toBe("none");
    expect(rows[0]!.quality).toBe("ambiguous");
  });

  it("attaches the room through the hostname crosswalk and stamps the resolver version", () => {
    const cw = new Map<string, RoomRef>([["EHRC-TEST1s-Mac-mini", { room_id: "room_x", slug: "opd-x" }]]);
    const r = computeWindows([open(at(0), "E1"), close(at(4), { enc: "E1" })], { crosswalk: cw })[0]!;
    expect(r.room_id).toBe("room_x");
    expect(r.room_slug).toBe("opd-x");
    expect(r.resolver_version).toBe(RESOLVER_VERSION);
    expect(computeWindows([open(at(0), "E1")], { asOf: at(200) })[0]!.room_id).toBeNull();
  });
});

// ---------------------------------------------------------------- refreshWindows (fake Neon tag)
type Q = { text: string; vals: unknown[] };
function fakeDb(responder: (q: Q) => unknown) {
  const issued: Q[] = [];
  const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q: Q = { text: strings.join("?"), vals };
    issued.push(q);
    return Object.assign(q, { then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(responder(q)).then(res, rej) });
  }) as unknown as WindowsDb & { transaction: unknown };
  const txns: Q[][] = [];
  (tag as unknown as { transaction: (qs: Q[]) => Promise<unknown[]> }).transaction = async (qs: Q[]) => {
    txns.push(qs);
    return qs.map((q) => (/DELETE/.test(q.text) ? [1, 1] : /INSERT/.test(q.text) ? [1] : []));
  };
  return { db: tag as WindowsDb, issued, txns };
}

describe("refreshWindows", () => {
  const now = Date.parse("2026-10-03T08:00:00Z");
  const evs: PresenceEvent[] = [open(new Date(now - 3_600_000).toISOString(), "E1", "UA"), close(new Date(now - 3_000_000).toISOString(), { enc: "E1", uid: "UA" })];
  const responder = (q: Q) => (/room_install/.test(q.text) ? [{ hostname: "EHRC-TEST1’s Mac mini", room_id: "room_x", slug: "opd-x" }] : /pulse_presence_events/.test(q.text) ? evs : []);

  it("deletes the range and inserts the fresh rows in ONE transaction, with bound parameters only", async () => {
    const { db, txns } = fakeDb(responder);
    const r = await refreshWindows(db, { from: now - 48 * 3_600_000, to: now }, { asOf: now });
    expect(txns).toHaveLength(1);
    expect(txns[0]).toHaveLength(2);
    expect(txns[0]![0]!.text).toMatch(/DELETE FROM eta_encounter_windows/);
    expect(txns[0]![1]!.text).toMatch(/INSERT INTO eta_encounter_windows/);
    expect(txns[0]![1]!.text).toMatch(/ON CONFLICT \(consult_key\) DO UPDATE/);
    const sent = JSON.parse(txns[0]![1]!.vals[0] as string) as Array<{ consult_key: string; room_id: string; doctor_uid: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ consult_key: "E1", room_id: "room_x", doctor_uid: "UA" });
    expect(r.summary.consults).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.events).toBe(2);
  });

  it("is idempotent: the same input produces byte-identical transactions", async () => {
    const a = fakeDb(responder);
    const b = fakeDb(responder);
    await refreshWindows(a.db, { from: now - 48 * 3_600_000, to: now }, { asOf: now });
    await refreshWindows(b.db, { from: now - 48 * 3_600_000, to: now }, { asOf: now });
    expect(JSON.stringify(a.txns)).toBe(JSON.stringify(b.txns));
  });

  it("with no consults it only deletes the range, and rejects a bad range", async () => {
    const { db, txns } = fakeDb(() => []);
    const r = await refreshWindows(db, { from: now - 3_600_000, to: now }, { asOf: now });
    expect(txns[0]).toHaveLength(1);
    expect(r.inserted).toBe(0);
    await expect(refreshWindows(db, { from: now, to: now - 1 })).rejects.toThrow(/bad range/);
  });
});
