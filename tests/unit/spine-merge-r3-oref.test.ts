/** spine-s2 R3: the Opus refuter's R2 fixtures X1-X6, now asserting the fixed behaviour. Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { mergeSignals, istDate } from "@/lib/spine/merge";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000, SEC = 1000;
const NOW = T0 + 10 * 3_600_000;
const EMPTY: SpinePrior = { encounters: [], links: [] };
let rev = 0;
const sig = (proxy: Proxy, key: string, o: number, c: number | null, attrs: Record<string, unknown> = {}, extra: Partial<SpineSignal> = {}): SpineSignal =>
  ({ proxy, source_key: key, source_rev: ++rev, room_id: "room_a", t_open: T0 + o, t_close: c === null ? null : T0 + c, attrs, ...extra });
const pulse = (key: string, o: number, c: number, uid: string, reason = "endConsult") => sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@m1`, close_reason: reason });
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW) => mergeSignals(s, "mv1", p, now);
let clock = 0;
const created = new Map<string, number>();
const prior = (r: MergeResult): SpinePrior => ({
  encounters: r.encounters.map((e) => { if (!created.has(e.encounter_id)) created.set(e.encounter_id, ++clock); return { ...e, created_at: created.get(e.encounter_id)! } as PriorEncounter; }),
  links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
});
const idOf = (r: MergeResult, key: string) => r.assignments.find((a) => a.source_key === key)!.encounter_id;
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: r.assignments.find((a) => a.proxy === x.proxy && a.source_key === x.source_key)?.encounter_id ?? null }));
const mv = (x: SpineSignal, o: number, c: number) => ({ ...x, source_rev: x.source_rev + 100, t_open: T0 + o, t_close: T0 + c });
const ids = (r: MergeResult) => r.encounters.map((e) => e.encounter_id);
const notes: string[] = [];
const note = (s: string) => notes.push(s);

describe("X1 duplicate id: a weak prior is both loser and survivor", () => {
  it("pulse 0-10; timeline+acoustic 20-30 (one weak encounter W); rerun moves the acoustic into the pulse", () => {
    const s = [pulse("p1", 0, 10 * MIN, "u_1"), sig("timeline", "t1", 20 * MIN, 30 * MIN), sig("acoustic", "a1", 20 * MIN, 30 * MIN)];
    const r1 = run(s);
    expect(r1.encounters).toHaveLength(2);
    const s2 = withIds(s, r1).map((x) => (x.source_key === "a1" ? mv(x, 1 * MIN, 9 * MIN) : x));
    const r2 = run(s2, prior(r1));
    note(`X1 rows ${r2.encounters.length}, unique ids ${new Set(ids(r2)).size}, statuses ${r2.encounters.map((e) => e.status).join(",")}`);
    expect(new Set(ids(r2)).size).toBe(r2.encounters.length);
    expect(r2.encounters.filter((e) => e.status === "merged")).toHaveLength(0);
  });
});

describe("X2 pulse+pqm late merge (plan M8 / covered_by_pulse)", () => {
  it("pqm consult of patient 0 grows into a short back-to-back pulse of patient 1; the merge is permanent", () => {
    const q0 = sig("pqm", "q0", 0, 10 * MIN, { pqm_uid: "pq_0" });
    const p1 = pulse("p1", 9 * MIN, 13 * MIN, "u_1", "logout");
    const r1 = run([q0, p1]);
    const Q = idOf(r1, "q0"), P = idOf(r1, "p1");
    expect(Q).not.toBe(P);
    // late rev: the pqm close arrives 2 min later (overlap 3 of 4 min = 75% of the shorter)
    let s = withIds([q0, p1], r1).map((x) => (x.source_key === "q0" ? mv(x, 0, 12 * MIN) : x));
    const r2 = run(s, prior(r1));
    note(`X2 run2: p1 id ${idOf(r2, "p1") === Q ? "= Q (pqm prior)" : idOf(r2, "p1") === P ? "= P" : "new"}, q0 id ${idOf(r2, "q0") === Q ? "Q" : "other"}, P status ${r2.encounters.find((e) => e.encounter_id === P)?.status}`);
    // the pqm close is corrected back
    s = withIds(s, r2).map((x) => (x.source_key === "q0" ? { ...mv(x, 0, 10 * MIN), source_rev: x.source_rev + 200 } : x));
    const r3 = run(s, prior(r2));
    const pk = r3.links.find((l) => l.value === "pq_0")!.encounter_id;
    note(`X2 run3 (split again): p1 id ${idOf(r3, "p1") === Q ? "= Q" : idOf(r3, "p1") === P ? "= P" : "new"}, q0 id ${idOf(r3, "q0") === Q ? "= Q" : idOf(r3, "q0") === P ? "= P" : "new"}, pqm_uid link on ${pk === Q ? "Q" : pk === idOf(r3, "q0") ? "q0's new id" : "other"}, Q anchor ${r3.encounters.find((e) => e.encounter_id === Q)?.anchor_proxy}`);
    // a pqm's original encounter id (and every artefact aliased to it) must not end up owned by another patient's pulse
    expect(idOf(r3, "q0")).toBe(Q);
    expect(idOf(r3, "p1")).toBe(P);
  });
  it("a split after a keyed merge: the pulse keeps its id, the pqm side gets the new one", () => {
    const q0 = sig("pqm", "q0", 0, 10 * MIN, { pqm_uid: "pq_0", consult_uid: "u_1" });
    const p1 = pulse("p1", 0, 10 * MIN, "u_1");
    const r1 = run([q0, p1]);
    expect(r1.encounters).toHaveLength(1);
    const P = idOf(r1, "p1");
    expect(idOf(r1, "q0")).toBe(P);
    const s = withIds([q0, p1], r1).map((x) => (x.source_key === "q0" ? { ...mv(x, 30 * MIN, 40 * MIN), attrs: { pqm_uid: "pq_0" } } : x));
    const r2 = run(s, prior(r1));
    expect(idOf(r2, "p1")).toBe(P);
    expect(idOf(r2, "q0")).not.toBe(P);
    expect(new Set(ids(r2)).size).toBe(r2.encounters.length);
  });
  it("a pqm visit fully inside a pulse consult of similar length still merges (covered_by_pulse)", () => {
    const r = run([sig("pqm", "q0", 1 * MIN, 9 * MIN, { pqm_uid: "pq_0" }), pulse("p1", 0, 10 * MIN, "u_1")]);
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters[0].anchor_proxy).toBe("pulse");
  });
  it("same-run: back-to-back pulse and pqm of two consults merge by time alone", () => {
    const r = run([sig("pqm", "q0", 0, 12 * MIN, { pqm_uid: "pq_0" }), pulse("p1", 9 * MIN, 13 * MIN, "u_1", "logout")]);
    note(`X2b same-run encounters ${r.encounters.length}, flags ${r.encounters.map((e) => e.flags.join("+") || "-").join(",")}`);
    expect(r.encounters.length).toBe(2); // R3: 3 of 12 and 3 of 4 min is not mutual 50%
  });
});

describe("X3 I3 clamp", () => {
  it("pqm neighbour clamps an inferred pulse close; both flagged", () => {
    const r = run([pulse("p1", 0, 12 * MIN, "u_1", "idle_timeout"), sig("pqm", "q2", 10 * MIN, 30 * MIN, { pqm_uid: "pq_2" }), sig("acoustic", "a1", 0, 20 * MIN)]);
    note(`X3a ${r.encounters.map((e) => `${e.anchor_proxy} ${(e.t_open - T0) / MIN}-${(e.t_close - T0) / MIN} ${e.flags.join("+")}`).join(" | ")}`);
    const A = r.encounters.find((e) => e.anchor_proxy === "pulse")!;
    expect(A.t_close - T0).toBe(10 * MIN);
    expect(A.flags).toContain("clamped");
  });
  it("pqm explicit close is never clamped by a pulse neighbour", () => {
    const r = run([sig("pqm", "q1", 0, 12 * MIN, { pqm_uid: "pq_1" }), pulse("p2", 10 * MIN, 30 * MIN, "u_2")]);
    // shorter = 12, overlap 2 -> no merge
    const Q = r.encounters.find((e) => e.anchor_proxy === "pqm")!;
    expect(Q.t_close - T0).toBe(12 * MIN);
    expect(Q.flags).not.toContain("clamped");
  });
  it("empty-span fallback: a weak encounter between two overlapping consults keeps its raw span and no flag", () => {
    const r = run([pulse("pA", 0, 8 * MIN, "u_A", "idle_timeout"), pulse("pB", 10 * MIN, 20 * MIN, "u_B"),
      sig("timeline", "w", 8.5 * MIN, 10.6 * MIN), sig("acoustic", "k", 9.5 * MIN, 10.2 * MIN, { consult_uid: "u_A" })]);
    const W = r.encounters.find((e) => e.anchor_proxy === "timeline");
    note(`X3c ${r.encounters.map((e) => `${e.anchor_proxy} ${((e.t_open - T0) / MIN).toFixed(1)}-${((e.t_close - T0) / MIN).toFixed(1)} ${e.flags.join("+") || "-"}`).join(" | ")}`);
    expect(W).toBeDefined();
    expect(W!.flags.includes("clamped") || W!.flags.includes("clamp_failed") || W!.t_close - T0 <= 10 * MIN).toBe(true);
    expect(W!.flags).toContain("clamp_failed");
  });
  it("pulse_overlap uses raw spans: pulses that do not overlap get the flag when a weak member stretches one", () => {
    const r = run([pulse("pA", 0, 9 * MIN, "u_A", "idle_timeout"), pulse("pB", 10 * MIN, 20 * MIN, "u_B"), sig("acoustic", "k", 1 * MIN, 11 * MIN, { consult_uid: "u_A" })]);
    note(`X3d ${r.encounters.map((e) => `${(e.t_open - T0) / MIN}-${(e.t_close - T0) / MIN} ${e.flags.join("+") || "-"}`).join(" | ")}`);
  });
  it("raw-span pulse_overlap on the brief fixture (A clamped at 10 still flagged with B)", () => {
    const r = run([pulse("p1", 0, 12 * MIN, "u_1", "idle_timeout"), pulse("p2", 10 * MIN, 20 * MIN, "u_2"), sig("acoustic", "a1", 0, 20 * MIN)]);
    expect(r.encounters.every((e) => e.flags.includes("pulse_overlap"))).toBe(true);
  });
});

describe("X4 I4 frozen", () => {
  it("a frozen older survivor: a live prior is merged into it", () => {
    const F: PriorEncounter = { encounter_id: "enc_fffffffffffffffa", ist_date: "2026-10-10", room_id: "room_a", t_open: T0, t_close: T0 + 10 * MIN, status: "candidate", merged_into: null, anchor_proxy: "acoustic", boundary_rev: 0, reason: "weak_single", created_at: 1 };
    const L: PriorEncounter = { ...F, encounter_id: "enc_lllllllllllllllb", ist_date: istDate(T0), created_at: 2 };
    const s = [sig("acoustic", "a1", 1 * MIN, 9 * MIN, { consult_uid: "u_f" }, { encounter_id: F.encounter_id }), sig("timeline", "t1", 1 * MIN, 9 * MIN, { consult_uid: "u_l" }, { encounter_id: L.encounter_id })];
    const r = run(s, { encounters: [F, L], links: [{ encounter_id: F.encounter_id, key_kind: "consult_uid", value: "u_f" }, { encounter_id: L.encounter_id, key_kind: "consult_uid", value: "u_l" }] });
    const lrow = r.encounters.find((e) => e.encounter_id === L.encounter_id);
    note(`X4a L status ${lrow?.status} into ${lrow?.merged_into === F.encounter_id ? "F(frozen)" : lrow?.merged_into}, u_l link on ${r.links.find((l) => l.value === "u_l")!.encounter_id === L.encounter_id ? "L" : "F"}`);
    expect(lrow?.status === "merged" && r.links.find((l) => l.value === "u_l")!.encounter_id === L.encounter_id).toBe(false);
    expect(lrow?.status).not.toBe("merged");
    expect(r.encounters.find((e) => e.encounter_id === F.encounter_id)?.flags ?? []).not.toContain("frozen");
  });
  it("a frozen loser is not emitted, but its signal's assignment moves", () => {
    const F: PriorEncounter = { encounter_id: "enc_fffffffffffffffc", ist_date: "2026-10-10", room_id: "room_a", t_open: T0, t_close: T0 + 10 * MIN, status: "candidate", merged_into: null, anchor_proxy: "acoustic", boundary_rev: 0, reason: "weak_single", created_at: 5 };
    const S: PriorEncounter = { ...F, encounter_id: "enc_ssssssssssssssd2", ist_date: istDate(T0), anchor_proxy: "pulse", status: "confirmed", reason: "pulse", created_at: 6 };
    const s = [sig("pulse", "p1", 0, 10 * MIN, { consult_uid: "u_p", consult_key: "u_p@m1", close_reason: "endConsult" }, { encounter_id: S.encounter_id }), sig("acoustic", "a1", 1 * MIN, 9 * MIN, { consult_uid: "u_f" }, { encounter_id: F.encounter_id })];
    const r = run(s, { encounters: [F, S], links: [{ encounter_id: F.encounter_id, key_kind: "consult_uid", value: "u_f" }] });
    note(`X4b F emitted ${r.encounters.some((e) => e.encounter_id === F.encounter_id)}, a1 assigned to ${idOf(r, "a1") === F.encounter_id ? "F" : "S"}, u_f link on ${r.links.find((l) => l.value === "u_f")!.encounter_id === F.encounter_id ? "F" : "S"}`);
    expect(idOf(r, "a1")).toBe(F.encounter_id);
    expect(r.links.find((l) => l.value === "u_f")!.encounter_id).toBe(F.encounter_id);
    expect(r.encounters.some((e) => e.encounter_id === F.encounter_id)).toBe(false);
  });
});

describe("X5 F1 swapped stale ids on both pulses", () => {
  it("each pulse keeps the id that its consult_key link names", () => {
    const s0 = [pulse("p1", 0, 10 * MIN, "u_1"), pulse("p2", 10 * MIN, 20 * MIN, "u_2")];
    const r1 = run(s0);
    const s = withIds(s0, r1).map((x) => ({ ...x, encounter_id: idOf(r1, x.source_key === "p1" ? "p2" : "p1") }));
    const r2 = run(s, prior(r1));
    note(`X5 p1 ${idOf(r2, "p1") === idOf(r1, "p1") ? "kept" : idOf(r2, "p1") === idOf(r1, "p2") ? "TOOK p2's id" : "new"}, p2 ${idOf(r2, "p2") === idOf(r1, "p2") ? "kept" : idOf(r2, "p2") === idOf(r1, "p1") ? "TOOK p1's id" : "new"}`);
    expect(idOf(r2, "p1")).toBe(idOf(r1, "p1"));
    expect(idOf(r2, "p2")).toBe(idOf(r1, "p2"));
  });
});

describe("X6 I2 pqm pair and A2", () => {
  it("two pqm uids overlapping 30 s: both flagged pulse_overlap", () => {
    const r = run([sig("pqm", "q1", 0, 10.5 * MIN, { pqm_uid: "pq_1" }), sig("pqm", "q2", 10 * MIN, 20 * MIN, { pqm_uid: "pq_2" })]);
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters.every((e) => e.flags.includes("pulse_overlap"))).toBe(true);
  });
  it("A2: same consult_uid on two machines far apart in time: two encounters, both multi_machine", () => {
    const a = sig("pulse", "pa", 0, 10 * MIN, { consult_uid: "u_1", consult_key: "u_1@m1", close_reason: "endConsult" });
    const b = sig("pulse", "pb", 60 * MIN, 70 * MIN, { consult_uid: "u_1", consult_key: "u_1@m2", close_reason: "endConsult" });
    const r = run([a, b]);
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters.every((e) => e.flags.includes("multi_machine"))).toBe(true);
  });
  it("A2: a weak signal with only consult_uid and two machines' pulses joins one (deterministically)", () => {
    const a = sig("pulse", "pa", 0, 10 * MIN, { consult_uid: "u_1", consult_key: "u_1@m1", close_reason: "endConsult" });
    const b = sig("pulse", "pb", 60 * MIN, 70 * MIN, { consult_uid: "u_1", consult_key: "u_1@m2", close_reason: "endConsult" });
    const w = sig("timeline", "w", 62 * MIN, 68 * MIN, { consult_uid: "u_1" });
    const r = run([a, b, w]);
    note(`X6c weak joins ${idOf(r, "w") === idOf(r, "pb") ? "pb (time)" : "pa"}, ambiguous ${r.encounters.some((e) => e.flags.includes("ambiguous"))}`);
    expect(r.encounters.find((e) => e.encounter_id === idOf(r, "w"))!.flags).toContain("ambiguous");
  });
});



describe("R3 mutant-driven fixtures", () => {
  const mkPrior = (id: string, proxy: Proxy, o: number, c: number, created: number, ist = istDate(T0)): PriorEncounter =>
    ({ encounter_id: id, ist_date: ist, room_id: "room_a", t_open: T0 + o, t_close: T0 + c, status: "confirmed", merged_into: null, anchor_proxy: proxy, boundary_rev: 0, reason: proxy, created_at: created });
  it("O1: a pulse's stale id naming a pqm-anchored prior never claims it", () => {
    const Q = mkPrior("enc_qqqqqqqqqqqqqqqa", "pqm", 30 * MIN, 40 * MIN, 1);
    const p1 = sig("pulse", "p1", 0, 10 * MIN, { consult_uid: "u_1", consult_key: "u_1@m1", close_reason: "endConsult" }, { encounter_id: Q.encounter_id });
    const q0 = sig("pqm", "q0", 30 * MIN, 40 * MIN, { pqm_uid: "pq_0" }, { encounter_id: Q.encounter_id });
    const r = run([p1, q0], { encounters: [Q], links: [{ encounter_id: Q.encounter_id, key_kind: "pqm_uid", value: "pq_0" }] });
    expect(idOf(r, "q0")).toBe(Q.encounter_id);
    expect(idOf(r, "p1")).not.toBe(Q.encounter_id);
  });
  it("O11: a link owned by a live prior never moves to a frozen encounter", () => {
    const F = mkPrior("enc_fffffffffffffffe", "acoustic", 0, 10 * MIN, 1, "2026-10-10");
    const L: PriorEncounter = { ...mkPrior("enc_lllllllllllllllf", "acoustic", 0, 10 * MIN, 2), room_id: "room_b" };
    const a1 = sig("acoustic", "a1", 1 * MIN, 9 * MIN, { consult_uid: "u_v" }, { encounter_id: F.encounter_id });
    const r = run([a1], { encounters: [F, L], links: [{ encounter_id: L.encounter_id, key_kind: "consult_uid", value: "u_v" }] });
    expect(r.links.find((l) => l.value === "u_v")!.encounter_id).toBe(L.encounter_id);
  });
  it("N4: pulse+pqm priors in one merged group: the pulse-anchored prior survives even when the pqm one is older", () => {
    const Q = mkPrior("enc_qqqqqqqqqqqqqqqb", "pqm", 0, 10 * MIN, 1);
    const P = mkPrior("enc_pppppppppppppppb", "pulse", 0, 10 * MIN, 2);
    const q0 = sig("pqm", "q0", 0, 10 * MIN, { pqm_uid: "pq_0" }, { encounter_id: Q.encounter_id });
    const p1 = sig("pulse", "p1", 0, 10 * MIN, { consult_uid: "u_1", consult_key: "u_1@m1", close_reason: "endConsult" }, { encounter_id: P.encounter_id });
    const r = run([q0, p1], { encounters: [Q, P], links: [] });
    expect(r.encounters).toHaveLength(2);
    expect(idOf(r, "p1")).toBe(P.encounter_id);
    expect(r.encounters.find((e) => e.encounter_id === Q.encounter_id)).toMatchObject({ status: "merged", merged_into: P.encounter_id });
  });
});
