/** Spine S2 R5: orphan retirement (defect A), pulse_enc_id guard (defect B), V6 precedence, frozen-day hold. Synthetic ids only. */
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
const pulse = (key: string, o: number, c: number, uid: string, machine = "m1", extra: Record<string, unknown> = {}, room = "room_a") =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@${machine}`, close_reason: "endConsult", ...extra }, room);
const enc = (id: string) => ({ ids: { pulse_enc_id: id } });
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW): MergeResult => mergeSignals(s, "mv1", p, now);
const idOf = (r: MergeResult, key: string) => r.assignments.find((a) => a.source_key === key)?.encounter_id;
const toPrior = (r: MergeResult): SpinePrior => ({
  encounters: r.encounters.map((e, i) => ({ ...e, created_at: i + 1 }) as PriorEncounter),
  links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
});
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: idOf(r, x.source_key) }));
const live = (r: MergeResult) => r.encounters.filter((e) => e.status !== "merged");

describe("R5 defect A: an enc-joined pulse group retires its other pulse priors", () => {
  it("no live pulse prior is left without a signal, and its id resolves through merged_into", () => {
    const pa = pulse("pa", 0, 10, "u_1", "m1", enc("pe_t_01")), pb = pulse("pb", 1, 9, "v_1", "m3");
    const r1 = run([pa, pb]);
    expect(live(r1)).toHaveLength(2);
    const pb2 = { ...pb, source_rev: pb.source_rev + 1000, attrs: { ...pb.attrs, ...enc("pe_t_01") } };
    const r2 = run(withIds([pa, pb2], r1), toPrior(r1));
    const survivor = idOf(r2, "pa")!;
    expect(idOf(r2, "pb")).toBe(survivor);
    const loser = idOf(r1, "pa") === survivor ? idOf(r1, "pb")! : idOf(r1, "pa")!;
    expect(r2.encounters.find((e) => e.encounter_id === loser)).toMatchObject({ status: "merged", merged_into: survivor });
    expect(r2.links.filter((l) => l.key_kind === "consult_key").every((l) => l.encounter_id === survivor)).toBe(true);
  });
});

describe("R5 defect B: the pulse_enc_id guard", () => {
  const two = (g1: SpineSignal, g2: SpineSignal) => run([g1, g2]);
  const conflict = (r: MergeResult) => live(r).every((e) => e.flags.includes("enc_conflict"));
  it("machines differ, spans touch: one encounter, multi_machine, not enc_conflict", () => {
    const r = two(pulse("pa", 0, 10, "u_1", "m1", enc("pe_t_01")), pulse("pb", 5, 15, "v_1", "m3", enc("pe_t_01")));
    expect(live(r)).toHaveLength(1);
    expect(live(r)[0].flags).toContain("multi_machine");
  });
  it("machines differ, gap exactly 2 min joins, 2 min 6 s does not", () => {
    const gap = (g: number) => two(pulse("pa", 0, 10, "u_1", "m1", enc("pe_t_01")), pulse("pb", 10 + g, 20 + g, "v_1", "m3", enc("pe_t_01")));
    expect(live(gap(2))).toHaveLength(1);
    expect(live(gap(2.1))).toHaveLength(2);
    expect(conflict(gap(2.1))).toBe(true);
  });
  it("one machine on both sides never joins on an enc id, even overlapping", () => {
    const r = two(pulse("pa", 0, 10, "u_1", "m1", enc("pe_t_01")), pulse("pb", 5, 15, "u_2", "m1", enc("pe_t_01")));
    expect(live(r)).toHaveLength(2);
    expect(conflict(r)).toBe(true);
  });
  it("a pulse with no machine in its consult_key cannot prove a second machine", () => {
    const a = sig("pulse", "pa", 0, 10, { consult_uid: "u_1", consult_key: "k1", close_reason: "endConsult", ...enc("pe_t_01") });
    const b = sig("pulse", "pb", 5, 15, { consult_uid: "u_2", consult_key: "k2", close_reason: "endConsult", ...enc("pe_t_01") });
    expect(live(two(a, b))).toHaveLength(2);
  });
  it("different rooms never join and both are enc_conflict", () => {
    const r = two(pulse("pa", 0, 10, "u_1", "m1", enc("pe_t_01")), pulse("pb", 0, 10, "v_1", "m3", enc("pe_t_01"), "room_b"));
    expect(live(r)).toHaveLength(2);
    expect(conflict(r)).toBe(true);
  });
  it("two pqm never join on an enc id, not even through a pulse they both share it with", () => {
    const r = run([
      sig("pqm", "q1", 4, 23, { pqm_uid: "pq_1", ...enc("pe_t_01") }),
      pulse("pa", 5, 30, "u_1", "m1", enc("pe_t_01")),
      sig("pqm", "q2", 24, 28, { pqm_uid: "pq_2", ...enc("pe_t_01") }),
    ]);
    expect(idOf(r, "q1")).not.toBe(idOf(r, "q2"));
  });
  it("a pqm joins the pulse that shares its enc id when the spans touch, flagged enc_conflict only when time alone would not join them", () => {
    const near = run([pulse("pa", 0, 10, "u_1", "m1", enc("pe_t_01")), sig("pqm", "q1", 4, 9, { pqm_uid: "pq_1", ...enc("pe_t_01") })]);
    expect(live(near)).toHaveLength(1);
    const adjacent = run([pulse("pa", 0, 10, "u_1", "m1", enc("pe_t_01")), sig("pqm", "q1", 11, 18, { pqm_uid: "pq_1", ...enc("pe_t_01") })]);
    expect(live(adjacent)).toHaveLength(1);
    expect(live(adjacent)[0].flags).toContain("enc_conflict");
  });
  it("different enc ids never set enc_conflict", () => {
    const r = two(pulse("pa", 0, 10, "u_1", "m1", enc("pe_t_01")), pulse("pb", 20, 30, "u_2", "m1", enc("pe_t_02")));
    expect(live(r).some((e) => e.flags.includes("enc_conflict"))).toBe(false);
  });
});

describe("R5 multi_machine is only for a second machine", () => {
  it("a lone pulse, and a pulse with its pqm, carry no multi_machine", () => {
    expect(live(run([pulse("pa", 0, 10, "u_1")]))[0].flags).not.toContain("multi_machine");
    expect(live(run([pulse("pa", 0, 10, "u_1"), sig("pqm", "q1", 1, 9, { pqm_uid: "pq_1" })]))[0].flags).not.toContain("multi_machine");
  });
});

describe("R5 V6: a link supplied by a strong signal beats a weak signal's copy", () => {
  it("the consult_uid on a time-merged pqm stays on its encounter against a weak group's exact copy", () => {
    const p = pulse("p1", 0, 10, "u_1");
    const q = sig("pqm", "q1", 1, 9, { pqm_uid: "pq_1", consult_uid: "u_shared" });
    const w = sig("acoustic", "w1", 0, 5, { consult_uid: "u_shared" }, "room_b");
    const r = run([p, q, w]);
    expect(idOf(r, "q1")).toBe(idOf(r, "p1"));
    expect(idOf(r, "w1")).not.toBe(idOf(r, "p1"));
    expect(r.links.find((l) => l.key_kind === "consult_uid" && l.value === "u_shared")?.encounter_id).toBe(idOf(r, "p1"));
  });
});

describe("R5 frozen day", () => {
  it("a NEW pulse on a past-horizon day is held and counted: no encounter, assignment or link", () => {
    const p0 = pulse("p0", 0, 10, "u_0");
    const r1 = run([p0]);
    const r2 = run([...withIds([p0], r1), pulse("pn", 30, 40, "u_n")], toPrior(r1), FROZEN);
    expect(r2.held_frozen).toBe(1);
    expect(idOf(r2, "pn")).toBeUndefined();
    expect(r2.links.some((l) => l.value === "u_n@m1")).toBe(false);
    expect(r2.encounters.every((e) => toPrior(r1).encounters.some((x) => x.encounter_id === e.encounter_id))).toBe(true);
  });
  it("a new pqm on a past-horizon day is held too; the same signals on a live day mint normally", () => {
    const q = sig("pqm", "q1", 0, 10, { pqm_uid: "pq_1" });
    expect(run([q], EMPTY, FROZEN).held_frozen).toBe(1);
    const live1 = run([q]);
    expect(live1.held_frozen).toBe(0);
    expect(live(live1)).toHaveLength(1);
  });
  it("K8: a stale id naming a frozen encounter of ANOTHER room does not pull a new pulse onto it", () => {
    const p0 = pulse("p0", 0, 10, "u_0");
    const r1 = run([p0]);
    const stale = { ...pulse("pn", 30, 40, "u_n", "m1", {}, "room_b"), encounter_id: idOf(r1, "p0") };
    const r2 = run([...withIds([p0], r1), stale], toPrior(r1), FROZEN);
    expect(idOf(r2, "pn")).toBeUndefined();
    expect(r2.held_frozen).toBe(1);
  });
  it("a pulse already linked to a frozen encounter stays on it and is not counted as held", () => {
    const p0 = pulse("p0", 0, 10, "u_0");
    const r1 = run([p0]);
    const r2 = run(withIds([{ ...p0, source_rev: p0.source_rev + 5, t_close: T0 + 25 * MIN }], r1), toPrior(r1), FROZEN);
    expect(idOf(r2, "p0")).toBe(idOf(r1, "p0"));
    expect(r2.held_frozen).toBe(0);
  });
});
