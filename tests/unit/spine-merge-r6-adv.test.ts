/** spine-s2 R6: refuter adv5 fixtures (G1, F1 now pass). Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mergeSignals } from "@/lib/spine/merge";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000;
const NOW = T0 + 12 * 3_600_000;
const FROZEN = Date.parse("2026-10-22T00:00:00Z");
const EMPTY: SpinePrior = { encounters: [], links: [] };
let rev = 0;
const sig = (proxy: Proxy, key: string, o: number, c: number, attrs: Record<string, unknown> = {}, room = "room_a"): SpineSignal =>
  ({ proxy, source_key: key, source_rev: ++rev, room_id: room, t_open: T0 + o * MIN, t_close: T0 + c * MIN, attrs });
const enc = (id: string) => ({ ids: { pulse_enc_id: id } });
const pulse = (key: string, o: number, c: number, uid: string, machine = "m1", extra: Record<string, unknown> = {}, room = "room_a") =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@${machine}`, close_reason: "endConsult", ...extra }, room);
const pqm = (key: string, o: number, c: number, uid: string, extra: Record<string, unknown> = {}, room = "room_a") => sig("pqm", key, o, c, { pqm_uid: uid, ...extra }, room);
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW): MergeResult => mergeSignals(s, "mv1", p, now);
const idOf = (r: MergeResult, key: string) => r.assignments.find((a) => a.source_key === key)?.encounter_id;
const live = (r: MergeResult) => r.encounters.filter((e) => e.status !== "merged");
const flagsOf = (r: MergeResult, key: string) => r.encounters.find((e) => e.encounter_id === idOf(r, key))?.flags ?? [];
const toPrior = (r: MergeResult): SpinePrior => ({
  encounters: r.encounters.map((e, i) => ({ ...e, created_at: i + 1 }) as PriorEncounter),
  links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
});
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: idOf(r, x.source_key) }));
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const rev_ = (xs: SpineSignal[]) => [...xs].reverse();

describe("oref5 guard", () => {
  it("DEFECT G1: three pulses share one enc: m1, m3 and a second m1 pulse; the two m1 pulses never share an encounter", () => {
    const r = run([pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pulse("b", 1, 10, "v_1", "m3", enc("pe_x")), pulse("c", 9, 18, "u_2", "m1", enc("pe_x"))]);
    expect(idOf(r, "a")).not.toBe(idOf(r, "c"));
    expect(live(r).every((e) => e.flags.includes("enc_conflict"))).toBe(true);
  });
  it("G2 pulse+pqm on one enc: a 1 min gap joins (enc_conflict, time alone would not), a 3 min gap stays apart (both enc_conflict)", () => {
    const j = run([pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pqm("q", 11, 15, "pq_1", enc("pe_x"))]);
    expect(idOf(j, "q")).toBe(idOf(j, "a"));
    expect(flagsOf(j, "a")).toContain("enc_conflict");
    const s = run([pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pqm("q", 13, 15, "pq_1", enc("pe_x"))]);
    expect(idOf(s, "q")).not.toBe(idOf(s, "a"));
    expect(flagsOf(s, "a")).toContain("enc_conflict");
    expect(flagsOf(s, "q")).toContain("enc_conflict");
  });
  it("G3 a pulse+pqm pair of one room never joins a pulse of another room on the same enc, even when machines differ", () => {
    const r = run([pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pqm("q", 1, 9, "pq_1"), pulse("b", 0, 10, "v_1", "m3", enc("pe_x"), "room_b")]);
    expect(idOf(r, "a")).not.toBe(idOf(r, "b"));
    expect(flagsOf(r, "a")).toContain("enc_conflict");
    expect(flagsOf(r, "b")).toContain("enc_conflict");
  });
  it("G4 machine is the text after the LAST @ (an @ inside the uid does not make a second machine)", () => {
    const r = run([pulse("a", 0, 10, "u@1", "m1", enc("pe_x")), pulse("b", 2, 10, "u@2", "m1", enc("pe_x"))]);
    expect(idOf(r, "a")).not.toBe(idOf(r, "b"));
  });
  it("G5 a trailing @ (empty machine) cannot prove a second machine", () => {
    const a = sig("pulse", "a", 0, 10, { consult_uid: "u_1", consult_key: "u_1@", close_reason: "endConsult", ...enc("pe_x") });
    const r = run([a, pulse("b", 2, 10, "v_1", "m3", enc("pe_x"))]);
    expect(idOf(r, "a")).not.toBe(idOf(r, "b"));
  });
  it("G6 genuine 2-machine join is multi_machine and a fixed point; shuffle-invariant", () => {
    const s = [pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pulse("b", 1, 11, "v_1", "m3", enc("pe_x")), pqm("q", 2, 9, "pq_1", enc("pe_x"))];
    const r = run(s);
    expect(live(r)).toHaveLength(1);
    expect(live(r)[0].flags).toContain("multi_machine");
    expect(live(r)[0].flags).not.toContain("enc_conflict");
    expect(sha(run(rev_(s)))).toBe(sha(r));
    const fp = run(withIds(s, r), toPrior(r));
    expect(sha(fp.encounters.map((e) => [e.encounter_id, e.flags, e.t_open, e.t_close]))).toBe(sha(r.encounters.map((e) => [e.encounter_id, e.flags, e.t_open, e.t_close])));
  });
  it("G7 a conflict pair is a fixed point (enc_conflict survives output-as-prior) and shuffle-invariant", () => {
    const s = [pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pulse("b", 30, 40, "v_1", "m3", enc("pe_x"))];
    const r = run(s);
    expect(sha(run(rev_(s)))).toBe(sha(r));
    const fp = run(withIds(s, r), toPrior(r));
    expect(live(fp).map((e) => [e.encounter_id, e.flags])).toEqual(live(r).map((e) => [e.encounter_id, e.flags]));
    expect(live(fp).every((e) => e.flags.includes("enc_conflict"))).toBe(true);
  });
});

describe("oref5 defect A", () => {
  it("A1 three machines learn a shared enc on the rerun: two priors retired merged_into the survivor, all links move", () => {
    const s = [pulse("a", 0, 10, "u_1", "m1"), pulse("b", 1, 10, "v_1", "m3"), pulse("c", 0, 9, "w_1", "m4")];
    const r1 = run(s);
    expect(live(r1)).toHaveLength(3);
    const s2 = withIds(s, r1).map((x) => ({ ...x, source_rev: x.source_rev + 100, attrs: { ...x.attrs, ...enc("pe_x") } }));
    const r2 = run(s2, toPrior(r1));
    const sv = idOf(r2, "a")!;
    expect([idOf(r2, "b"), idOf(r2, "c")]).toEqual([sv, sv]);
    expect(live(r2)).toHaveLength(1);
    expect(r2.encounters.filter((e) => e.status === "merged").every((e) => e.merged_into === sv)).toBe(true);
    expect(r2.encounters.filter((e) => e.status === "merged")).toHaveLength(2);
    expect(r2.links.filter((l) => l.key_kind === "consult_key").every((l) => l.encounter_id === sv)).toBe(true);
  });
  it("A2 a same-consult pulse rerun (one consult_key) never retires its own prior or a pulse prior of another consult", () => {
    const s = [pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pulse("b", 12, 20, "u_2", "m1", enc("pe_y"))];
    const r1 = run(s);
    const r2 = run(withIds(s, r1).map((x) => ({ ...x, source_rev: x.source_rev + 100 })), toPrior(r1));
    expect(r2.encounters.filter((e) => e.status === "merged")).toHaveLength(0);
    expect(live(r2).map((e) => e.encounter_id).sort()).toEqual(live(r1).map((e) => e.encounter_id).sort());
  });
});

describe("oref5 frozen hold", () => {
  it("H1 a new pulse AND a new pqm on a frozen day: both held, counted 2, nothing minted, prior rows unchanged", () => {
    const p0 = pulse("p0", 0, 10, "u_0");
    const r1 = run([p0]);
    const r2 = run([...withIds([p0], r1), pulse("pn", 30, 40, "u_n"), pqm("qn", 60, 70, "pq_n")], toPrior(r1), FROZEN);
    expect(r2.held_frozen).toBe(2);
    expect(idOf(r2, "pn")).toBeUndefined();
    expect(idOf(r2, "qn")).toBeUndefined();
    expect(r2.encounters.map((e) => e.encounter_id)).toEqual(r1.encounters.map((e) => e.encounter_id));
  });
  it("H2 the same input one ms before the horizon mints (boundary)", () => {
    const q = pqm("qn", 0, 10, "pq_n");
    const hz = Date.parse("2026-10-21T18:30:00Z");
    expect(run([q], EMPTY, hz - 1).held_frozen).toBe(0);
    expect(run([q], EMPTY, hz).held_frozen).toBe(1);
  });
  it("H3 the held count is stable on rerun (fixed point) and order-independent", () => {
    const s = [pulse("pn", 30, 40, "u_n"), pqm("qn", 60, 70, "pq_n"), sig("acoustic", "w", 31, 39)];
    const r = run(s, EMPTY, FROZEN);
    expect(sha(run(rev_(s), EMPTY, FROZEN))).toBe(sha(r));
    expect(run(withIds(s, r), toPrior(r), FROZEN).held_frozen).toBe(r.held_frozen);
  });
  it("F1 (pre-existing, ruled hold not reached): a new pulse overlapping ANOTHER consult's pqm on a frozen day is held, not put on that consult's frozen encounter", () => {
    const p1 = pulse("p1", 0, 10, "u_1"), q2 = pqm("q2", 20, 30, "pq_2");
    const r1 = run([p1, q2]);
    const r2 = run([...withIds([p1, q2], r1), pulse("pn", 19, 31, "u_n")], toPrior(r1), FROZEN);
    expect(idOf(r2, "pn")).toBeUndefined();
    expect(r2.held_frozen).toBe(1);
  });
});
