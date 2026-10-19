/** Spine S2 R4: pulse_enc_id key (M2), idle_timeout cap (M6), variant D, covered_by_pulse, M13. Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { mergeSignals } from "@/lib/spine/merge";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000;
const NOW = T0 + 12 * 3_600_000;
const EMPTY: SpinePrior = { encounters: [], links: [] };
let rev = 0;
const sig = (proxy: Proxy, key: string, o: number, c: number, attrs: Record<string, unknown> = {}, room = "room_a"): SpineSignal =>
  ({ proxy, source_key: key, source_rev: ++rev, room_id: room, t_open: T0 + o * MIN, t_close: T0 + c * MIN, attrs });
const pulse = (key: string, o: number, c: number, uid: string, reason = "endConsult", machine = "m1", extra: Record<string, unknown> = {}) =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@${machine}`, close_reason: reason, ...extra });
const enc = (id: string) => ({ ids: { pulse_enc_id: id } });
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW): MergeResult => mergeSignals(s, "mv1", p, now);
const idOf = (r: MergeResult, key: string) => r.assignments.find((a) => a.source_key === key)!.encounter_id;
const toPrior = (r: MergeResult): SpinePrior => ({
  encounters: r.encounters.map((e, i) => ({ ...e, created_at: i + 1 }) as PriorEncounter),
  links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
});
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: idOf(r, x.source_key) }));
const live = (r: MergeResult) => r.encounters.filter((e) => e.status !== "merged");

describe("M2 pulse_enc_id is the cross-machine identity key", () => {
  it("two machines, one pulse_enc_id, far apart in time: ONE encounter, multi_machine", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_test_01")), pulse("pb", 60, 70, "u_2", "endConsult", "m2", enc("pe_test_01"))]);
    expect(live(r)).toHaveLength(1);
    expect(live(r)[0].flags).toContain("multi_machine");
    expect(idOf(r, "pa")).toBe(idOf(r, "pb"));
  });
  it("a different pulse_enc_id on the same two machines stays two encounters", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_test_01")), pulse("pb", 0, 10, "u_2", "endConsult", "m2", enc("pe_test_02"))]);
    expect(live(r)).toHaveLength(2);
  });
  it("the same consult_uid on two machines without a pulse_enc_id is still two encounters (never a cross-machine key)", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1"), pulse("pb", 60, 70, "u_1", "endConsult", "m2")]);
    expect(live(r)).toHaveLength(2);
    expect(live(r).every((e) => e.flags.includes("multi_machine"))).toBe(true);
  });
  it("a pqm carrying the pulse's pulse_enc_id merges by KEY even when the times are far apart", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_test_01")), sig("pqm", "q1", 50, 58, { pqm_uid: "pq_1", ...enc("pe_test_01") })]);
    expect(live(r)).toHaveLength(1);
    expect(r.links.find((l) => l.key_kind === "pulse_enc_id")?.value).toBe("pe_test_01");
  });
  it("the key merge holds on a rerun when the pqm already had its own prior (pulse survives, pqm prior merged)", () => {
    const p = pulse("pa", 0, 10, "u_1", "endConsult", "m1"), q = sig("pqm", "q1", 50, 58, { pqm_uid: "pq_1" });
    const r1 = run([p, q]);
    expect(live(r1)).toHaveLength(2);
    const q2 = { ...q, source_rev: q.source_rev + 100, attrs: { ...q.attrs, ...enc("pe_test_01") } };
    const p2 = { ...p, source_rev: p.source_rev + 100, attrs: { ...p.attrs, ...enc("pe_test_01") } };
    const r2 = run(withIds([p2, q2], r1), toPrior(r1));
    expect(live(r2)).toHaveLength(1);
    expect(live(r2)[0].encounter_id).toBe(idOf(r1, "pa"));
    expect(r2.encounters.find((e) => e.encounter_id === idOf(r1, "q1"))?.merged_into).toBe(idOf(r1, "pa"));
  });
});

describe("M6 no stretch: an idle_timeout close is capped at the next strong open", () => {
  it("pulse idle_timeout 0-30 min, next pulse opens at 12: the first is clamped to 12", () => {
    const r = run([pulse("pa", 0, 30, "u_1", "idle_timeout"), pulse("pb", 12, 20, "u_2")]);
    const a = r.encounters.find((e) => e.encounter_id === idOf(r, "pa"))!;
    expect(a.t_close).toBe(T0 + 12 * MIN);
    expect(a.flags).toContain("clamped");
  });
  it("an explicit endConsult close is never clamped", () => {
    const r = run([pulse("pa", 0, 30, "u_1", "endConsult"), pulse("pb", 12, 20, "u_2")]);
    expect(r.encounters.find((e) => e.encounter_id === idOf(r, "pa"))!.t_close).toBe(T0 + 30 * MIN);
  });
});

describe("variant D and covered_by_pulse", () => {
  it("first run: a pulse and a pqm overlapping >= 50% of both still merge by time (no prior owned)", () => {
    const r = run([pulse("pa", 0, 10, "u_1"), sig("pqm", "q1", 1, 9, { pqm_uid: "pq_1" })]);
    expect(live(r)).toHaveLength(1);
  });
  it("both own a prior and a late rev makes them overlap mutually: no time merge, no cross-consult capture", () => {
    const pA = pulse("pA", 5, 10, "u_A", "idle_timeout"), qB = sig("pqm", "qB", 9, 17, { pqm_uid: "pq_B" });
    const r1 = run([pA, qB]);
    const s2 = withIds([pA, qB], r1).map((x) => (x.source_key === "pA" ? { ...x, source_rev: x.source_rev + 100, t_close: T0 + 16 * MIN } : x));
    const r2 = run(s2, toPrior(r1));
    expect(idOf(r2, "qB")).toBe(idOf(r1, "qB"));
    expect(idOf(r2, "pA")).toBe(idOf(r1, "pA"));
    expect(r2.encounters.some((e) => e.status === "merged")).toBe(false);
  });
  it("R3-E: a 5 min pqm inside a 20 min explicitly closed pulse: two encounters, the pqm one covered_by_pulse", () => {
    const r = run([pulse("p1", 0, 20, "u_1"), sig("pqm", "q1", 8, 13, { pqm_uid: "pq_1" })]);
    expect(live(r)).toHaveLength(2);
    expect(r.encounters.find((e) => e.encounter_id === idOf(r, "q1"))!.flags).toContain("covered_by_pulse");
    expect(r.encounters.find((e) => e.encounter_id === idOf(r, "p1"))!.flags).not.toContain("covered_by_pulse");
  });
  it("not covered when the pulse close is inferred, when under 90% inside, or in another room", () => {
    const q = (o: number, c: number, room = "room_a") => sig("pqm", `q${o}${room}`, o, c, { pqm_uid: `pq_${o}${room}` }, room);
    const flagged = (r: MergeResult, id: string) => r.encounters.find((e) => e.encounter_id === id)!.flags.includes("covered_by_pulse");
    const a = run([pulse("p1", 0, 20, "u_1", "idle_timeout"), q(8, 13)]);
    expect(flagged(a, idOf(a, "q8room_a"))).toBe(false);
    const b = run([pulse("p1", 0, 20, "u_1"), q(16, 22)]); // 4 of 6 min inside
    expect(flagged(b, idOf(b, "q16room_a"))).toBe(false);
    const c = run([pulse("p1", 0, 20, "u_1"), q(8, 13, "room_b")]);
    expect(flagged(c, idOf(c, "q8room_b"))).toBe(false);
  });
});

describe("M13 two pulse rows sharing a consult_key", () => {
  it("one group, one emitted encounter; neither same-kind strong prior is ever marked merged", () => {
    const p1 = pulse("p1", 0, 10, "u_1"), p2 = pulse("p2", 1, 9, "u_1");
    const r1 = run([p1]);
    const r1b = run([p2]);
    const prior: SpinePrior = {
      encounters: [...r1.encounters, ...r1b.encounters].map((e, i) => ({ ...e, created_at: i + 1 }) as PriorEncounter),
      links: r1.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
    };
    const s = [{ ...p1, encounter_id: idOf(r1, "p1") }, { ...p2, encounter_id: idOf(r1b, "p2") }];
    const r2 = run(s, prior);
    expect(r2.encounters.some((e) => e.status === "merged")).toBe(false);
    expect(live(r2)).toHaveLength(1);
    expect(idOf(r2, "p1")).toBe(idOf(r2, "p2"));
  });
});

describe("R4 mutant killers", () => {
  it("M13: two pulses merged by one pulse_enc_id that each own a prior: the older survives, the other pulse prior is never marked merged", () => {
    const pa = pulse("pa", 0, 10, "u_1", "endConsult", "m1"), pb = pulse("pb", 1, 9, "u_2", "endConsult", "m2");
    const r1 = run([pa, pb]);
    expect(live(r1)).toHaveLength(2);
    const rs = (x: SpineSignal) => ({ ...x, source_rev: x.source_rev + 100, attrs: { ...x.attrs, ...enc("pe_test_01") } });
    const r2 = run(withIds([rs(pa), rs(pb)], r1), toPrior(r1));
    expect(r2.encounters.some((e) => e.status === "merged")).toBe(false);
    expect(live(r2)).toHaveLength(1);
    expect(idOf(r2, "pa")).toBe(idOf(r2, "pb"));
  });
  it("N3b: after the horizon a pqm whose link names its frozen pulse encounter stays on it when a late rev regroups it with another pulse", () => {
    const FROZEN = Date.parse("2026-10-22T00:00:00Z");
    const p0 = pulse("p0", 0, 10, "u_0"), p1 = pulse("p1", 12, 30, "u_1"), q = sig("pqm", "q1", 2, 9, { pqm_uid: "pq_1" });
    const r1 = run([p0, p1, q]);
    const E0 = idOf(r1, "p0");
    expect(idOf(r1, "q1")).toBe(E0);
    const q2 = { ...q, source_rev: q.source_rev + 100, t_open: T0 + 13 * MIN, t_close: T0 + 29 * MIN };
    const r2 = run(withIds([p0, p1, q2], r1), toPrior(r1), FROZEN);
    expect(idOf(r2, "q1")).toBe(E0);
    expect(r2.links.find((l) => l.key_kind === "pqm_uid")!.encounter_id).toBe(E0);
  });
  it("N6: a pulse without an identity key whose stale id names another room's pulse prior does not take that prior's ownership", () => {
    const pa = sig("pulse", "pa", 0, 10, { consult_uid: "u_a", close_reason: "endConsult" }, "room_a");
    const pb = pulse("pb", 0, 10, "u_b", "endConsult", "m1");
    const pbB = { ...pb, room_id: "room_b" };
    const r1 = run([pa, pbB]);
    const PB = idOf(r1, "pb");
    const r2 = run(withIds([pa, pbB], r1).map((x) => (x.source_key === "pa" ? { ...x, encounter_id: PB } : x)), toPrior(r1));
    expect(idOf(r2, "pb")).toBe(PB);
    expect(live(r2)).toHaveLength(2);
  });
  it("M16: a dual-merged pqm's stale id naming a same-room pqm prior never takes it (identity link is final)", () => {
    const pa = pulse("pa", 0, 10, "u_a"), qa = sig("pqm", "qa", 1, 9, { pqm_uid: "pq_a" }), qb = sig("pqm", "qb", 20, 30, { pqm_uid: "pq_b" });
    const r1 = run([pa, qa, qb]);
    const QB = idOf(r1, "qb");
    expect(idOf(r1, "qa")).toBe(idOf(r1, "pa"));
    const r2 = run(withIds([pa, qa, qb], r1).map((x) => (x.source_key === "qa" ? { ...x, encounter_id: QB } : x)), toPrior(r1));
    expect(idOf(r2, "qb")).toBe(QB);
    expect(idOf(r2, "qa")).toBe(idOf(r1, "pa"));
    expect(live(r2)).toHaveLength(2);
  });
});
