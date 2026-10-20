/** spine-s2 R6: G1 (enc guard: same-machine / unprovable-machine pulses), held list, F1 (no foreign frozen home), V5 (retired home's pqm). Synthetic ids only. */
import { describe, it, expect } from "vitest";
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
const pulse = (key: string, o: number, c: number, uid: string, machine = "m1", extra: Record<string, unknown> = {}) =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@${machine}`, close_reason: "endConsult", ...extra });
const pqm = (key: string, o: number, c: number, uid: string, extra: Record<string, unknown> = {}) => sig("pqm", key, o, c, { pqm_uid: uid, ...extra });
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW): MergeResult => mergeSignals(s, "mv1", p, now);
const idOf = (r: MergeResult, key: string) => r.assignments.find((a) => a.source_key === key)?.encounter_id;
const live = (r: MergeResult) => r.encounters.filter((e) => e.status !== "merged");
const toPrior = (r: MergeResult): SpinePrior => ({
  encounters: r.encounters.map((e, i) => ({ ...e, created_at: i + 1 }) as PriorEncounter),
  links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
});
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: idOf(r, x.source_key) }));

describe("R6 G1 enc guard", () => {
  it("m1, m3 and a second m1 pulse of another consult on one enc: the two m1 pulses never share an encounter, all enc_conflict", () => {
    const r = run([pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pulse("b", 1, 10, "v_1", "m3", enc("pe_x")), pulse("c", 9, 18, "u_2", "m1", enc("pe_x"))]);
    expect(idOf(r, "a")).not.toBe(idOf(r, "c"));
    expect(live(r).every((e) => e.flags.includes("enc_conflict"))).toBe(true);
  });
  it("a pulse whose machine cannot be proven (either side) never joins a different-consult pulse", () => {
    const noM = sig("pulse", "a", 0, 10, { consult_uid: "u_1", consult_key: "u_1@", close_reason: "endConsult", ...enc("pe_x") });
    const r1 = run([noM, pulse("b", 2, 10, "v_1", "m3", enc("pe_x"))]);
    expect(idOf(r1, "a")).not.toBe(idOf(r1, "b"));
    const r2 = run([pulse("b", 2, 10, "v_1", "m3", enc("pe_x")), noM]);
    expect(idOf(r2, "a")).not.toBe(idOf(r2, "b"));
  });
  it("two pulses with no consult_key (machine unprovable, same null key) sharing an enc never join", () => {
    const x = (k: string, o: number) => sig("pulse", k, o, 10, { consult_uid: `u_${k}`, close_reason: "endConsult", ...enc("pe_x") });
    const r = run([x("a", 0), x("b", 2)]);
    expect(idOf(r, "a")).not.toBe(idOf(r, "b"));
  });
  it("an unprovable machine on the LATER-opening pulse also blocks the join", () => {
    const noM = sig("pulse", "n", 2, 10, { consult_uid: "u_1", consult_key: "u_1@", close_reason: "endConsult", ...enc("pe_x") });
    const r = run([pulse("b", 0, 10, "v_1", "m3", enc("pe_x")), noM]);
    expect(idOf(r, "n")).not.toBe(idOf(r, "b"));
  });
  it("a genuine two-machine join (one consult per machine) still joins and stays multi_machine", () => {
    const r = run([pulse("a", 0, 10, "u_1", "m1", enc("pe_x")), pulse("b", 1, 10, "v_1", "m3", enc("pe_x"))]);
    expect(idOf(r, "a")).toBe(idOf(r, "b"));
    expect(live(r)[0].flags).toContain("multi_machine");
  });
});

describe("R6 held list and F1", () => {
  it("a new pulse and a new pqm on a frozen day are held: held lists their source_keys, held_frozen = held.length", () => {
    const p0 = pulse("p0", 0, 10, "u_0");
    const r1 = run([p0]);
    const r2 = run([...withIds([p0], r1), pulse("pn", 30, 40, "u_n"), pqm("qn", 60, 70, "pq_n")], toPrior(r1), FROZEN);
    expect(r2.held).toEqual([["pn"], ["qn"]]);
    expect(r2.held_frozen).toBe(2);
    expect(idOf(r2, "pn")).toBeUndefined();
  });
  it("a live day holds nothing", () => {
    expect(run([pulse("p0", 0, 10, "u_0")]).held).toEqual([]);
  });
  it("F1: a new pulse time-merged with another consult's pqm on a frozen day is held; the pqm keeps its home; the pulse's keys are not linked to it", () => {
    const p1 = pulse("p1", 0, 10, "u_1"), q2 = pqm("q2", 20, 30, "pq_2");
    const r1 = run([p1, q2]);
    const r2 = run([...withIds([p1, q2], r1), pulse("pn", 19, 31, "u_n")], toPrior(r1), FROZEN);
    expect(idOf(r2, "pn")).toBeUndefined();
    expect(idOf(r2, "q2")).toBe(idOf(r1, "q2"));
    expect(r2.held).toEqual([["pn"]]);
    expect(r2.links.some((l) => l.value === "u_n" || l.value === "u_n@m1")).toBe(false);
  });
  it("F1 (no claim on the frozen home): a new pulse time-merged with a pqm captured on a frozen pulse-anchored home is held; the pqm stays", () => {
    const p1 = pulse("p1", 0, 10, "u_1");
    const r1 = run([p1]);
    const home = idOf(r1, "p1");
    const q = { ...pqm("q", 20, 30, "pq_9"), encounter_id: home };
    const r2 = run([...withIds([p1], r1), q, pulse("pn", 19, 31, "u_n")], toPrior(r1), FROZEN);
    expect(r2.held).toEqual([["pn"]]);
    expect(idOf(r2, "q")).toBe(home);
    expect(idOf(r2, "pn")).toBeUndefined();
  });
  it("F1: a same-consult strong signal that shares a key with the home-bearer keeps the home (pqm + pulse of one consult_uid)", () => {
    const q = pqm("q", 0, 10, "pq_1", { consult_uid: "u_1" });
    const r1 = run([q]);
    const p = pulse("p", 0, 10, "u_1");
    const r2 = run([...withIds([q], r1), p], toPrior(r1), FROZEN);
    expect(r2.held).toEqual([]);
    expect(idOf(r2, "p")).toBe(idOf(r1, "q"));
  });
  it("held is shuffle-invariant", () => {
    const s = [pulse("pn", 30, 40, "u_n"), pqm("qn", 60, 70, "pq_n")];
    expect(run([...s].reverse(), EMPTY, FROZEN).held).toEqual(run(s, EMPTY, FROZEN).held);
  });
});

describe("R6 V5 retired home's pqm", () => {
  for (const swap of [false, true]) it(`a late enc join retires one pulse home; its pqm attaches to the survivor, no new row (${swap ? "b" : "a"} older)`, () => {
    const a = pulse("a", 0, 2, "u_1", "m1"), b = pulse("b", 0, 12, "v_1", "m3"), q = pqm("q", 1, 2, "pq_1");
    const r1 = run(swap ? [b, a, q] : [a, b, q]);
    expect(idOf(r1, "q")).toBe(idOf(r1, "a"));
    const s2 = withIds([sig("pulse", "a", 0, 5, { ...a.attrs, ...enc("pe_x") }), sig("pulse", "b", 0, 12, { ...b.attrs, ...enc("pe_x") }), q], r1);
    const r2 = run(s2, toPrior(r1));
    expect(idOf(r2, "a")).toBe(idOf(r2, "b"));
    expect(idOf(r2, "q")).toBe(idOf(r2, "a"));
    expect(r2.encounters.some((e) => e.flags.includes("covered_by_pulse"))).toBe(false);
    expect(live(r2)).toHaveLength(1);
    const r3 = run(withIds(s2, r2), toPrior(r2)); // fixed point
    expect(JSON.stringify(r3.assignments)).toBe(JSON.stringify(r2.assignments));
    expect(live(r3)).toHaveLength(1);
  });
  it("a pqm that left a SINGLE-consult pulse (no enc join) stays its own covered row (pre-R6 behaviour, not pulled back)", () => {
    const a = pulse("a", 0, 2, "u_1", "m1"), q = pqm("q", 1, 2, "pq_1");
    const r1 = run([a, q]);
    expect(idOf(r1, "q")).toBe(idOf(r1, "a"));
    const r2 = run(withIds([pulse("a", 0, 5, "u_1", "m1"), q], r1), toPrior(r1));
    expect(idOf(r2, "q")).not.toBe(idOf(r2, "a"));
    expect(r2.encounters.find((e) => e.encounter_id === idOf(r2, "q"))?.flags).toContain("covered_by_pulse");
  });
  it("a pqm whose span a different pulse covers as well is NOT pulled into the joined group (ambiguous)", () => {
    const a = pulse("a", 0, 2, "u_1", "m1"), b = pulse("b", 0, 12, "v_1", "m3"), q = pqm("q", 1, 2, "pq_1"), c = pulse("c", 0, 5, "u_9", "m2");
    const r1 = run([a, b, q]);
    const s2 = withIds([sig("pulse", "a", 0, 5, { ...a.attrs, ...enc("pe_x") }), sig("pulse", "b", 0, 12, { ...b.attrs, ...enc("pe_x") }), q], r1);
    const r2 = run([...s2, c], toPrior(r1));
    expect(idOf(r2, "q")).not.toBe(idOf(r2, "a"));
  });
});
