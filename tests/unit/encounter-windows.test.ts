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
  keepFocusFlips,
  istMidnightAtOrBefore,
  refreshWindows,
  refreshWindowsByDay,
  splitByIstDay,
  RESOLVER_VERSION,
  type PresenceEvent,
  type RoomRef,
  type WindowsDb,
} from "@/lib/encounter-windows";
import { normalizeEvent, byTimeThenId, resolveStreams, type NEvent } from "@/lib/encounter-windows/occupancy";

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
    // the key is always <encounter_id>@<machine>; the bare encounter id is its own column
    for (const r of rows) expect(r.consult_key).toBe(`${r.consult_uid}@${r.machine}`);
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
    expect(rows[0]!.consult_key).toBe(`E1@${M}`);
    expect(rows[0]!.consult_uid).toBe("E1");
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

  it("keys every consult `<encounter_id>@<machine>`, independent of run order, range or other machines", () => {
    const other = { machine: "EHRC-TEST2s-Mac-mini" };
    const mine = [open(at(0), "E1"), close(at(3), { enc: "E1" })];
    const theirs = [ev("encounter_open", at(1), { enc: "E1", ...other }), ev("encounter_close", at(4), { enc: "E1", ...other })];
    const both = run([...mine, ...theirs]).rows;
    expect(both.map((r) => r.consult_key).sort()).toEqual(["E1@EHRC-TEST1s-Mac-mini", "E1@EHRC-TEST2s-Mac-mini"]);
    // the same consult gets the same key whether or not the other machine's identical encounter_id is in the run,
    // and whichever order the machines come in (the old suffix-on-collision scheme depended on both)
    expect(run(mine).rows[0]!.consult_key).toBe("E1@EHRC-TEST1s-Mac-mini");
    expect(run([...theirs, ...mine]).rows.map((r) => r.consult_key).sort()).toEqual(both.map((r) => r.consult_key).sort());
    expect(computeWindows([...mine, ...theirs], { from: at(0, 30), asOf: at(30) }).map((r) => r.consult_key)).toEqual(["E1@EHRC-TEST2s-Mac-mini"]);
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

  it("does not count a stream with no genuine activity in 45 minutes, nor one logged out, nor a locked machine", () => {
    expect(run([login(-60, "UA"), open(at(0), "E1"), close(at(4), { enc: "E1" })]).rows[0]!.attribution).toBe("none"); // 45-minute rule
    expect(run([login(-5, "UA"), ev("logout", at(-2), { uid: "UA" }), open(at(0), "E1"), close(at(4), { enc: "E1" })]).rows[0]!.attribution).toBe("none");
    expect(run([login(-5, "UA"), ev("locked", at(-1)), open(at(0), "E1"), close(at(4), { enc: "E1" })]).rows[0]!.attribution).toBe("none");
  });

  // 5 Oct 2026 rule: a plain `idle` (chrome.idle fires after 120 s without keyboard/mouse) is NOT a logout; only `locked`, or an
  // `idle` that began >= 45 min ago with no later genuine activity, takes the stream out.
  const streamsAt = (es: PresenceEvent[], asOfMin: number) =>
    resolveStreams(es.map((e) => normalizeEvent(e)!).filter(Boolean).sort(byTimeThenId) as NEvent[], T0 + asOfMin * 60_000);

  it("idle for 3 minutes inside a session keeps the doctor present (occupant at open, mid-consult too)", () => {
    const es = [login(-5, "UA", "Dr A"), ev("idle", at(-3)), open(at(0), "E1"), close(at(4), { enc: "E1" })];
    const r = run(es).rows[0]!;
    expect(r.attribution).toBe("occupant");
    expect(r.doctor_uid).toBe("UA");
    expect(streamsAt(es, 0)[0]).toMatchObject({ uid: "UA", present: true, out_reason: null });
    // idle began 44 min ago with the last genuine activity before it: the 45-minute activity rule has not fired either
    expect(streamsAt([login(-44, "UA"), ev("idle", at(-43))], 0)[0]).toMatchObject({ present: true, out_reason: null });
  });

  it("idle that began 50 minutes ago with no later genuine activity is out (idle_45m)", () => {
    const es = [login(-55, "UA"), ev("idle", at(-50))];
    expect(streamsAt(es, 0)[0]).toMatchObject({ present: false, out_reason: "idle_45m" });
    expect(run([...es, open(at(0), "E1"), close(at(4), { enc: "E1" })]).rows[0]!.attribution).toBe("none");
    // exactly 45 minutes counts (>=)
    expect(streamsAt([login(-50, "UA"), ev("idle", at(-45))], 0)[0]).toMatchObject({ out_reason: "idle_45m" });
  });

  it("focused heartbeats every 30 s do not reset the idle clock: idle 50 min -> out idle_45m", () => {
    const beats = Array.from({ length: 100 }, (_, i) => hb(-50 + i * 0.5, "UA", true)); // 30 s cadence from the idle to now
    const es = [login(-60, "UA"), ev("idle", at(-50)), ...beats];
    expect(streamsAt(es, 0)[0]).toMatchObject({ present: false, out_reason: "idle_45m" });
    // the same beats with a younger idle (44 min): still present
    const young = [login(-60, "UA"), ev("idle", at(-44)), ...Array.from({ length: 88 }, (_, i) => hb(-44 + i * 0.5, "UA", true))];
    expect(streamsAt(young, 0)[0]).toMatchObject({ present: true, out_reason: null });
  });

  it("idle 50 min then one `active` event: present", () => {
    const es = [login(-60, "UA"), ev("idle", at(-50)), ev("active", at(-1), { uid: "UA" })];
    expect(streamsAt(es, 0)[0]).toMatchObject({ present: true, out_reason: null });
  });

  it("login, encounter_open or encounter_close after a long idle resets the clock (a heartbeat does not)", () => {
    const base = [login(-60, "UA"), ev("idle", at(-50))];
    expect(streamsAt([...base, login(-10, "UA")], 0)[0]).toMatchObject({ present: true, out_reason: null });
    expect(streamsAt([...base, ev("encounter_open", at(-10), { uid: "UA", enc: "E9" })], 0)[0]).toMatchObject({ present: true, out_reason: null });
    expect(streamsAt([...base, ev("encounter_close", at(-10), { uid: "UA", enc: "E9" })], 0)[0]).toMatchObject({ present: true, out_reason: null });
    // heartbeats, focused or not, are not activity for this clause
    expect(streamsAt([...base, hb(-10, "UA", false)], 0)[0]).toMatchObject({ present: false, out_reason: "idle_45m" });
    expect(streamsAt([...base, hb(-10, "UA", true)], 0)[0]).toMatchObject({ present: false, out_reason: "idle_45m" });
  });

  it("locked takes the stream out immediately (locked), until the machine goes active again", () => {
    expect(streamsAt([login(-5, "UA"), ev("locked", at(-1))], 0)[0]).toMatchObject({ present: false, out_reason: "locked" });
    expect(streamsAt([login(-5, "UA"), ev("locked", at(-3)), ev("active", at(-1))], 0)[0]).toMatchObject({ present: true, out_reason: null });
  });

  it("idle then active: present, with the active event counting as genuine activity", () => {
    const es = [login(-60, "UA"), ev("idle", at(-50)), ev("active", at(-2), { uid: "UA" })];
    expect(streamsAt(es, 0)[0]).toMatchObject({ present: true, out_reason: null, last_genuine_ts: T0 - 2 * 60_000 });
    expect(run([...es, open(at(0), "E1"), close(at(4), { enc: "E1" })]).rows[0]!.attribution).toBe("occupant");
  });

  it("logout and resolver stamps still win over a young idle", () => {
    expect(streamsAt([login(-10, "UA"), ev("idle", at(-3)), ev("logout", at(-1), { uid: "UA" })], 0)[0]).toMatchObject({ out_reason: "logout" });
    expect(streamsAt([login(-10, "UA"), ev("idle", at(-3)), ev("logout", at(-1), { uid: "UA", source: "resolver" })], 0)[0]).toMatchObject({ out_reason: "stamped" });
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
    expect(sent[0]).toMatchObject({ consult_key: "E1@EHRC-TEST1s-Mac-mini", consult_uid: "E1", room_id: "room_x", doctor_uid: "UA" });
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

// ---------------------------------------------------------------- focus filter (fetchEvents' rule)
describe("background-heartbeat filter keeps focus flips", () => {
  const hb = (sec: number, uid: string, focus: boolean) => ev("heartbeat", at(0, sec), { uid, focus });
  // Refuter's case: A focused 0-5 min then background to 20 min; B focused 6-20 min; consult at 20.2 min, rows carry no uid.
  const scenario = (): PresenceEvent[] => {
    const es: PresenceEvent[] = [];
    for (let sec = 0; sec <= 5 * 60; sec += 30) es.push(hb(sec, "UA", true));
    for (let sec = 5 * 60 + 30; sec <= 20 * 60; sec += 30) es.push(hb(sec, "UA", false));
    for (let sec = 6 * 60; sec <= 20 * 60; sec += 30) es.push(hb(sec, "UB", true));
    es.push(open(at(20, 12), "E1"), close(at(24), { enc: "E1" }));
    return es;
  };
  const dropAllBackground = (es: PresenceEvent[]) => es.filter((e) => e.event !== "heartbeat" || e.focus === true);

  it("with the fetch-filtered set the occupant is B (A reads backgrounded), quality multi_doctor", () => {
    const all = scenario();
    const kept = keepFocusFlips(all);
    expect(kept.length).toBeLessThan(all.length);
    // A keeps exactly one background heartbeat: the flip at 5.5 min
    expect(kept.filter((e) => e.uid === "UA" && e.focus === false)).toHaveLength(1);
    const r = computeWindows(kept)[0]!;
    expect(r.attribution).toBe("occupant");
    expect(r.doctor_uid).toBe("UB");
    expect(r.quality).toBe("multi_doctor");
    // same answer as the full, unfiltered stream
    expect(computeWindows(all)[0]).toEqual(r);
  });

  it("dropping ALL background heartbeats (the old fetch) makes both profiles look focused: ambiguous", () => {
    const r = computeWindows(dropAllBackground(scenario()))[0]!;
    expect(r.attribution).toBe("none");
    expect(r.quality).toBe("ambiguous");
  });

  it("keeps the first event of a stream, every flip in both directions and non-heartbeats; drops repeats and logout-adjacent repeats", () => {
    const es = [
      hb(0, "UA", false), // first of the stream -> kept
      hb(30, "UA", false), // repeat -> dropped
      hb(60, "UA", true), // focused -> kept
      hb(90, "UA", false), // flip true -> false -> kept
      hb(120, "UA", false), // repeat -> dropped
      ev("logout", at(0, 130), { uid: "UA", focus: false }), // not a heartbeat -> kept
      hb(150, "UA", false), // previous NON-logout event was false -> dropped
      hb(0, "UB", false), // another stream: first -> kept
      hb(30, "UB", false), // repeat -> dropped
    ];
    const kept = keepFocusFlips(es).map((e) => `${e.uid}@${String(e.ts).slice(14, 19)}`);
    expect(kept).toEqual(["UA@00:00", "UB@00:00", "UA@01:00", "UA@01:30", "UA@02:10"]);
  });

  // The SQL flag is (payload->>'tab_focus' = 'true'): NULL when the key is missing, so a missing flag is UNKNOWN, not false.
  // LAG is NULL for "no previous row" AND "previous row had no flag"; NULL IS DISTINCT FROM NULL is false.
  const hbf = (sec: number, uid: string, focus?: boolean | null) => ev("heartbeat", at(0, sec), { uid, focus });
  const label = (e: PresenceEvent) => `${e.uid}@${String(e.ts).slice(14, 19)}`;

  it("treats a missing tab_focus as unknown, exactly like the SQL rule (not as false)", () => {
    const es = [
      hbf(0, "UA"), //   first row, flag NULL        -> NULL vs NULL: not a flip, background: dropped (coercing to false would keep it)
      hbf(30, "UA"), //  NULL -> NULL                -> dropped
      hbf(60, "UA", false), // NULL -> false         -> flip: kept
      hbf(90, "UA", false), // false -> false        -> dropped
      hbf(120, "UA"), //  false -> NULL              -> flip: kept
      hbf(150, "UA"), //  NULL -> NULL               -> dropped
      hbf(180, "UA", true), // NULL -> true          -> kept (focused, and a flip)
      hbf(210, "UA"), //  true -> NULL               -> flip: kept
      ev("active", at(0, 240), { uid: "UA" }), //     not a heartbeat: kept; NULL -> NULL, no flip
      hbf(270, "UA", true), // NULL -> true          -> kept
      hbf(0, "UB"), //    another stream, first row NULL -> dropped
      hbf(30, "UB"), //   NULL -> NULL                   -> dropped
      hbf(0, "UC", null), // explicit JSON null behaves like missing -> dropped
    ];
    expect(keepFocusFlips(es).map(label)).toEqual(["UA@01:00", "UA@02:00", "UA@03:00", "UA@03:30", "UA@04:00", "UA@04:30"]);
  });

  it("a stream's flip to missing keeps the 'no longer focused' signal the resolver needs (full == filtered)", () => {
    const es: PresenceEvent[] = [];
    for (let sec = 0; sec <= 5 * 60; sec += 30) es.push(hbf(sec, "UA", true)); //     A focused 0-5 min
    for (let sec = 5 * 60 + 30; sec <= 20 * 60; sec += 30) es.push(hbf(sec, "UA")); // then heartbeats with NO tab_focus
    for (let sec = 6 * 60; sec <= 20 * 60; sec += 30) es.push(hbf(sec, "UB", true)); // B focused 6-20 min
    es.push(open(at(20, 12), "E1"), close(at(24), { enc: "E1" }));
    const kept = keepFocusFlips(es);
    expect(kept.length).toBeLessThan(es.length);
    expect(kept.filter((e) => e.uid === "UA" && e.focus === undefined)).toHaveLength(1); // the true -> NULL flip only
    const r = computeWindows(kept)[0]!;
    expect(r.doctor_uid).toBe("UB");
    expect(r.quality).toBe("multi_doctor");
    expect(computeWindows(es)[0]).toEqual(r);
  });
});

// ---------------------------------------------------------------- refresh by IST day + bounded lookback
describe("refreshWindowsByDay and the bounded event load", () => {
  const mid = (d: string) => Date.parse(`${d}T00:00:00+05:30`);

  it("splits at IST midnights, oldest first, covering the range exactly", () => {
    const from = mid("2026-10-02") + 5 * 3_600_000;
    const to = mid("2026-10-05") + 3_600_000;
    const chunks = splitByIstDay(from, to);
    expect(chunks).toEqual([
      { from, to: mid("2026-10-03") },
      { from: mid("2026-10-03"), to: mid("2026-10-04") },
      { from: mid("2026-10-04"), to: mid("2026-10-05") },
      { from: mid("2026-10-05"), to },
    ]);
    expect(splitByIstDay(from, from + 1000)).toEqual([{ from, to: from + 1000 }]);
    expect(istMidnightAtOrBefore(from)).toBe(mid("2026-10-02"));
    expect(istMidnightAtOrBefore(mid("2026-10-03"))).toBe(mid("2026-10-03"));
  });

  const responder = (q: Q) => (/room_install/.test(q.text) ? [] : []);

  it("runs one transaction per IST day and reads events from (IST midnight before the day) - 24 h to the end of the whole range + 2 h", async () => {
    const { db, txns, issued } = fakeDb(responder);
    const from = mid("2026-10-02") + 5 * 3_600_000;
    const to = mid("2026-10-04") + 3_600_000;
    const r = await refreshWindowsByDay(db, { from, to }, { asOf: to });
    expect(r.chunks).toBe(3);
    expect(r.complete).toBe(true);
    expect(r.next_from).toBeNull();
    expect(txns).toHaveLength(3);
    const dels = txns.map((t) => t[0]!.vals as string[]);
    expect(dels[0]).toEqual([new Date(from).toISOString(), new Date(mid("2026-10-03")).toISOString()]);
    expect(dels[1]).toEqual([new Date(mid("2026-10-03")).toISOString(), new Date(mid("2026-10-04")).toISOString()]);
    expect(dels[2]).toEqual([new Date(mid("2026-10-04")).toISOString(), new Date(to).toISOString()]);
    const fetches = issued.filter((q) => /pulse_presence_events/.test(q.text));
    expect(fetches).toHaveLength(3);
    // lo = IST midnight at or before the chunk start, minus 24 h; hi = end of the WHOLE range + 2 h, for every day
    const hi = new Date(to + 2 * 3_600_000).toISOString();
    expect(fetches[0]!.vals).toEqual([new Date(mid("2026-10-02") - 86_400_000).toISOString(), hi]);
    expect(fetches[1]!.vals).toEqual([new Date(mid("2026-10-03") - 86_400_000).toISOString(), hi]);
    expect(fetches[2]!.vals).toEqual([new Date(mid("2026-10-04") - 86_400_000).toISOString(), hi]);
  });

  it("stops before a new day once the deadline has passed and says where to resume", async () => {
    const { db, txns } = fakeDb(responder);
    const from = mid("2026-10-02");
    const to = mid("2026-10-05");
    const r = await refreshWindowsByDay(db, { from, to }, { asOf: to, deadlineMs: Date.now() - 1 });
    expect(r.chunks).toBe(1); // always does the first day
    expect(txns).toHaveLength(1);
    expect(r.complete).toBe(false);
    expect(r.next_from).toBe(new Date(mid("2026-10-03")).toISOString());
  });

  it("a consult opened 23:30 IST keeps its explicit close at 02:30 IST next day: one row, endConsult", async () => {
    const d1 = mid("2026-10-03");
    const d2 = mid("2026-10-04");
    const evs: PresenceEvent[] = [
      ev("encounter_open", new Date(d2 - 30 * 60_000).toISOString(), { enc: "N1", uid: "UA" }), //          23:30 IST on 3 Oct
      ev("encounter_close", new Date(d2 + 150 * 60_000).toISOString(), { enc: "N1", uid: "UA" }), //        02:30 IST on 4 Oct
    ];
    // a database that honours the read window the adapter asks for: params are [lo, hi]
    const windowed = (q: Q) => {
      if (/room_install/.test(q.text)) return [];
      if (!/pulse_presence_events/.test(q.text)) return [];
      const [lo, hi] = (q.vals as string[]).map((x) => Date.parse(x));
      return evs.filter((e) => Date.parse(e.ts as string) >= lo! && Date.parse(e.ts as string) <= hi!);
    };
    const asOf = d2 + 24 * 3_600_000;
    const sentRows = (txns: Q[][]) =>
      txns.flatMap((t) => t.filter((q) => /INSERT/.test(q.text))).flatMap((q) => JSON.parse(q.vals[0] as string) as Array<Record<string, unknown>>);

    const { db, txns } = fakeDb(windowed);
    const r = await refreshWindowsByDay(db, { from: d1, to: d2 + 6 * 3_600_000 }, { asOf });
    expect(r.chunks).toBe(2);
    const rows = sentRows(txns);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consult_key: `N1@${M}`,
      t_open: new Date(d2 - 30 * 60_000).toISOString(),
      t_close: new Date(d2 + 150 * 60_000).toISOString(),
      close_reason: "endConsult",
    });
    expect(r.summary.consults).toBe(1);

    // control: day 1 on its own reads only to its own end + 2 h (02:00 IST), misses the 02:30 close, and caps at 90 min
    const lone = fakeDb(windowed);
    await refreshWindows(lone.db, { from: d1, to: d2 }, { asOf });
    expect(sentRows(lone.txns)[0]).toMatchObject({ close_reason: "cap_90m" });
  });

  it("merges the per-day summaries", async () => {
    const day = mid("2026-10-03");
    const evs: PresenceEvent[] = [
      ev("encounter_open", new Date(day + 3_600_000).toISOString(), { enc: "D1", uid: "UA" }),
      ev("encounter_close", new Date(day + 3_900_000).toISOString(), { enc: "D1", uid: "UA" }),
      ev("encounter_open", new Date(day + 86_400_000 + 3_600_000).toISOString(), { enc: "D2", uid: "UA" }),
      ev("encounter_close", new Date(day + 86_400_000 + 3_900_000).toISOString(), { enc: "D2", uid: "UA" }),
    ];
    const { db } = fakeDb((q) => (/pulse_presence_events/.test(q.text) ? evs : []));
    const r = await refreshWindowsByDay(db, { from: day, to: day + 2 * 86_400_000 }, { asOf: day + 3 * 86_400_000 });
    expect(r.chunks).toBe(2);
    expect(r.summary.consults).toBe(2);
    expect(r.summary.by_close_reason).toEqual({ endConsult: 2 });
    expect(r.summary.by_attribution.rows).toBe(2);
  });
});
