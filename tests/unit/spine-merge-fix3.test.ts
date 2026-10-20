/** spine-s2 R3 refuter: minimised counterexamples from prop3 (throwaway; .bc/oref-r3). Synthetic ids only.
 * Each `it` asserts the behaviour the brief/readings require; a failing `it` is a finding. */
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
const pulse = (key: string, o: number, c: number, uid: string, reason = "endConsult", room = "room_a") =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@m1`, close_reason: reason }, room);
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW) => mergeSignals(s, "mv1", p, now);
let clock = 0;
const created = new Map<string, number>();
const prior = (r: MergeResult, old: SpinePrior = EMPTY): SpinePrior => {
  const rows = new Map(old.encounters.map((e) => [e.encounter_id, e]));
  for (const e of r.encounters) { if (!created.has(e.encounter_id)) created.set(e.encounter_id, ++clock); rows.set(e.encounter_id, { ...e, created_at: created.get(e.encounter_id)! } as PriorEncounter); }
  return { encounters: [...rows.values()], links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })) };
};
const idOf = (r: MergeResult, key: string) => r.assignments.find((a) => a.source_key === key)!.encounter_id;
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: r.assignments.find((a) => a.proxy === x.proxy && a.source_key === x.source_key)?.encounter_id ?? null }));
const late = (x: SpineSignal, o: number, c: number, attrs?: Record<string, unknown>) => ({ ...x, source_rev: x.source_rev + 100, t_open: T0 + o * MIN, t_close: T0 + c * MIN, attrs: attrs ?? x.attrs });

describe("R3-A cross-consult capture survives the mutual rule (V3)", () => {
  it("pulse A's inferred close overruns into consult B's pqm: B's own prior must not be merged into A", () => {
    const pA = pulse("pA", 5, 10, "u_A", "idle_timeout"), qB = sig("pqm", "qB", 9, 17, { pqm_uid: "pq_B" });
    const r1 = run([pA, qB]);
    const QB = idOf(r1, "qB"), PA = idOf(r1, "pA");
    expect(QB).not.toBe(PA);
    const s2 = withIds([pA, qB], r1).map((x) => (x.source_key === "pA" ? late(x, 5, 16) : x)); // 7 of 11 and 7 of 8 min: mutual
    const p1 = prior(r1);
    const r2 = run(s2, p1);
    expect(r2.encounters.find((e) => e.encounter_id === QB)?.status).not.toBe("merged");
    expect(idOf(r2, "qB")).toBe(QB);
  });
});

describe("R3-B frozen day: a late rev splits a frozen dual merge", () => {
  it("after the horizon the pqm stays on its frozen encounter and no new encounter is minted", () => {
    const p = pulse("p1", 0, 10, "u_1"), q = sig("pqm", "q1", 1, 9, { pqm_uid: "pq_1" });
    const r1 = run([p, q]);
    expect(r1.encounters).toHaveLength(1);
    const E = idOf(r1, "p1");
    const s2 = withIds([p, q], r1).map((x) => (x.source_key === "q1" ? late(x, 1, 25) : x));
    const r2 = run(s2, prior(r1), FROZEN);
    expect(idOf(r2, "q1")).toBe(E);
    expect(r2.encounters.filter((e) => e.status !== "merged" && !e.flags.includes("frozen"))).toHaveLength(0);
  });
});

describe("R3-C frozen day: X4b keep rule beats the identity link for a strong signal", () => {
  it("a pulse whose stale id names a frozen weak encounter stays assigned to its own pulse encounter", () => {
    const p = pulse("p1", 0, 10, "u_1"), a = sig("acoustic", "a1", 30, 40);
    const r1 = run([p, a]);
    const P = idOf(r1, "p1"), W = idOf(r1, "a1");
    const s2 = withIds([p, a], r1).map((x) => (x.source_key === "p1" ? { ...x, encounter_id: W } : x)); // corrupt stale id
    const r2 = run(s2, prior(r1), FROZEN);
    expect(idOf(r2, "p1")).toBe(P);
    expect(r2.links.find((l) => l.key_kind === "consult_key")!.encounter_id).toBe(idOf(r2, "p1"));
  });
});

describe("R3-D X5 gap: a dual-merged pqm's stale id from another room orphans that room's pqm prior", () => {
  it("room_b's pqm keeps its prior although room_a's merged pqm carries that id as a stale id", () => {
    const pa = pulse("pa", 0, 10, "u_a"), qa = sig("pqm", "qa", 1, 9, { pqm_uid: "pq_a" }), qb = sig("pqm", "qb", 0, 10, { pqm_uid: "pq_b" }, "room_b");
    const r1 = run([pa, qa, qb]);
    const QB = idOf(r1, "qb");
    expect(idOf(r1, "qa")).toBe(idOf(r1, "pa"));
    const s2 = withIds([pa, qa, qb], r1).map((x) => (x.source_key === "qa" ? { ...x, encounter_id: QB } : x));
    const r2 = run(s2, prior(r1));
    expect(idOf(r2, "qb")).toBe(QB);
  });
});

describe("R3-E side effect of mutual 50% (documented, not a defect under the interim rule)", () => {
  it("a 5 min pqm inside a 20 min pulse of the same consult gives two confirmed encounters", () => {
    const r = run([pulse("p1", 0, 20, "u_1"), sig("pqm", "q1", 8, 13, { pqm_uid: "pq_1" })]);
    expect(r.encounters.filter((e) => e.status === "confirmed")).toHaveLength(2);
  });
});

describe("R3 mutant killers (pass on a813683b)", () => {
  it("M15: a clamp that leaves exactly zero length is clamp_failed, not clamped", () => {
    const r = run([pulse("pA", 0, 8, "u_A", "idle_timeout"), pulse("pB", 10, 20, "u_B"),
      sig("timeline", "w", 8.5, 10.6), sig("acoustic", "k", 9.5, 10, { consult_uid: "u_A" })]);
    const W = r.encounters.find((e) => e.anchor_proxy === "timeline")!;
    expect(W.flags).toContain("clamp_failed");
    expect(W.flags).not.toContain("clamped");
    expect(W.t_close).toBeGreaterThan(W.t_open);
  });
  it("M14: a uid-only weak signal whose uid is on ONE machine is not ambiguous", () => {
    const r = run([pulse("pa", 0, 10, "u_1"), sig("timeline", "w", 2, 8, { consult_uid: "u_1" })]);
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters[0].flags).not.toContain("ambiguous");
  });
});
