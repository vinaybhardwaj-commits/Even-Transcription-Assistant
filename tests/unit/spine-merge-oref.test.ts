/** Refuter adversarial tests for spine-s2 R1 (throwaway; lives in .bc/ after the run). Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mergeSignals, istDate } from "@/lib/spine/merge";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000, SEC = 1000;
const NOW = T0 + 10 * 3_600_000;
const EMPTY: SpinePrior = { encounters: [], links: [] };
const R = "room_a";
let rev = 0;
const sig = (proxy: Proxy, key: string, o: number, c: number | null, attrs: Record<string, unknown> = {}, extra: Partial<SpineSignal> = {}): SpineSignal =>
  ({ proxy, source_key: key, source_rev: ++rev, room_id: R, t_open: T0 + o, t_close: c === null ? null : T0 + c, attrs, ...extra });
const pulse = (key: string, o: number, c: number | null, uid: string, reason = "endConsult", m = "m1", extra: Partial<SpineSignal> = {}) =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@${m}`, close_reason: reason }, extra);
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW) => mergeSignals(s, "mv1", p, now);
const sha = (r: MergeResult) => createHash("sha256").update(JSON.stringify(r)).digest("hex");
const live = (r: MergeResult) => r.encounters.filter((e) => e.status !== "merged");
const prior = (r: MergeResult): SpinePrior => ({
  encounters: r.encounters.map((e) => ({ ...e, created_at: 1 } as PriorEncounter)),
  links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
});
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: r.assignments.find((a) => a.proxy === x.proxy && a.source_key === x.source_key)?.encounter_id ?? null }));
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }
function shuffle<T>(xs: T[], seed: number): T[] { const r = rng(seed), a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

describe("R1 back-to-back consults never merge", () => {
  it("pads overlapping by 30 s: two encounters, no merge", () => {
    const r = run([pulse("p1", 0, 10 * MIN + 30 * SEC, "uid_t_01"), pulse("p2", 10 * MIN, 20 * MIN, "uid_t_02")]);
    expect(live(r)).toHaveLength(2);
  });
  it("url_clear then a new open within 60 s, one acoustic blob over both: two encounters, ambiguous, boundaries kept", () => {
    const r = run([pulse("p1", 0, 10 * MIN, "uid_t_01", "url_clear"), pulse("p2", 10 * MIN + 40 * SEC, 20 * MIN, "uid_t_02"), sig("acoustic", "a1", 0, 20 * MIN)]);
    expect(live(r)).toHaveLength(2);
    expect(r.encounters.some((e) => e.flags.includes("ambiguous"))).toBe(true);
    expect(r.encounters.map((e) => [e.t_open - T0, e.t_close - T0])).toEqual([[0, 10 * MIN], [10 * MIN + 40 * SEC, 20 * MIN]]);
  });
  it("idle_timeout inferred close next to an explicit close, acoustic over both: still two encounters", () => {
    const r = run([pulse("p1", 0, 12 * MIN, "uid_t_01", "idle_timeout"), pulse("p2", 10 * MIN, 20 * MIN, "uid_t_02", "endConsult"), sig("acoustic", "a1", 0, 20 * MIN)]);
    expect(live(r)).toHaveLength(2);
  });
  it("cap_90m open pulse next to an explicit close: two encounters", () => {
    const r = run([pulse("p1", 0, null, "uid_t_01", "cap_90m"), pulse("p2", 30 * MIN, 40 * MIN, "uid_t_02")], EMPTY, T0 + 100 * MIN);
    expect(live(r)).toHaveLength(2);
    expect(r.encounters.every((e) => e.flags.includes("pulse_overlap"))).toBe(true);
  });
  it("the same Pulse enc on two machines, overlapping in time: two encounters, both multi_machine", () => {
    const r = run([pulse("pa", 0, 10 * MIN, "uid_t_01", "endConsult", "m1"), pulse("pb", 1 * MIN, 9 * MIN, "uid_t_01", "endConsult", "m2")]);
    expect(live(r)).toHaveLength(2);
    expect(r.encounters.every((e) => e.flags.includes("multi_machine"))).toBe(true);
  });
  it("a weak signal carrying both consults' keys cannot bridge them", () => {
    const r = run([pulse("p1", 0, 10 * MIN, "uid_t_01"), pulse("p2", 11 * MIN, 20 * MIN, "uid_t_02"), sig("pqm", "q1", 0, 20 * MIN, { pqm_uid: "pq_1", consult_uid: "uid_t_01" }), sig("timeline", "t1", 0, 20 * MIN, { consult_uid: "uid_t_02" })]);
    expect(live(r)).toHaveLength(2);
  });
  it("RERUN: a weak signal that moves from consult B to consult A must not merge B into A", () => {
    const s1 = [pulse("p1", 0, 10 * MIN, "uid_t_01"), pulse("p2", 10 * MIN, 20 * MIN, "uid_t_02"), sig("acoustic", "a1", 11 * MIN, 19 * MIN)];
    const r1 = run(s1);
    const a1 = r1.assignments.find((a) => a.proxy === "acoustic")!.encounter_id;
    const p2id = r1.assignments.find((a) => a.source_key === "p2")!.encounter_id;
    expect(a1).toBe(p2id);
    // late rev of a1: now sits mostly in A
    const s2 = withIds(s1, r1).map((x) => (x.source_key === "a1" ? { ...x, source_rev: 99, t_open: T0 + 1 * MIN, t_close: T0 + 9 * MIN } : x));
    const r2 = run(s2, prior(r1));
    expect(r2.encounters.filter((e) => e.status === "merged")).toHaveLength(0);
    expect(new Set(r2.encounters.map((e) => e.encounter_id)).size).toBe(r2.encounters.length); // no id twice
    for (const k of ["p1", "p2"]) expect(r2.assignments.find((a) => a.source_key === k)!.encounter_id).toBe(r1.assignments.find((a) => a.source_key === k)!.encounter_id);
  });
  it("RERUN: same, when consult B is older (created_at) than A: ids must not swap", () => {
    const s1 = [pulse("p1", 0, 10 * MIN, "uid_t_01"), pulse("p2", 10 * MIN, 20 * MIN, "uid_t_02"), sig("acoustic", "a1", 11 * MIN, 19 * MIN)];
    const r1 = run(s1);
    const p2id = r1.assignments.find((a) => a.source_key === "p2")!.encounter_id;
    const pr = prior(r1);
    pr.encounters = pr.encounters.map((e) => ({ ...e, created_at: e.encounter_id === p2id ? 1 : 2 }));
    const s2 = withIds(s1, r1).map((x) => (x.source_key === "a1" ? { ...x, source_rev: 99, t_open: T0 + 1 * MIN, t_close: T0 + 9 * MIN } : x));
    const r2 = run(s2, pr);
    for (const k of ["p1", "p2"]) expect(r2.assignments.find((a) => a.source_key === k)!.encounter_id).toBe(r1.assignments.find((a) => a.source_key === k)!.encounter_id);
  });
});

describe("determinism", () => {
  const fx = () => [
    pulse("p1", 0, 10 * MIN, "uid_t_01", "url_clear"), pulse("p2", 10 * MIN + 30 * SEC, 22 * MIN, "uid_t_02", "idle_timeout"),
    pulse("p3", 21 * MIN, 30 * MIN, "uid_t_03"), pulse("p4", 21 * MIN, 30 * MIN, "uid_t_03", "endConsult", "m2"),
    sig("pqm", "q1", 1 * MIN, 9 * MIN, { pqm_uid: "pq_1" }), sig("pqm", "q2", 12 * MIN, 21 * MIN, { pqm_uid: "pq_2" }),
    sig("acoustic", "a1", 0, 30 * MIN), sig("acoustic", "a2", 5 * MIN, 15 * MIN), sig("timeline", "t1", 40 * MIN, 50 * MIN), sig("acoustic", "a3", 41 * MIN, 49 * MIN),
    sig("doctor_activity", "d1", 42 * MIN, 52 * MIN), sig("timeline", "t2", 44 * MIN, 47 * MIN), sig("nemotron_window", "bw_x", 0, 15 * MIN),
    sig("cutter", "c1", 0, 10 * MIN, { consult_uid: "uid_t_01", final_reason: "silent_audio" }), sig("caa", "caa_1", 0, 5 * MIN, { consult_uid: "uid_t_02" }),
    sig("acoustic", "b1", 0, 10 * MIN, {}, { room_id: "room_b" }), sig("timeline", "b2", 0, 10 * MIN, {}, { room_id: "room_b" }),
  ];
  it("50 random shuffles give a byte-identical result", () => {
    const f = fx(), base = sha(run(f));
    for (let s = 1; s <= 50; s++) expect(sha(run(shuffle(f, s)))).toBe(base);
  });
  it("shuffled rerun with prior is byte-identical too", () => {
    const f = fx(), r1 = run(f), pr = prior(r1), s2 = withIds(f, r1), base = sha(run(s2, pr));
    for (let s = 1; s <= 20; s++) expect(sha(run(shuffle(s2, s), { encounters: shuffle(pr.encounters, s), links: shuffle(pr.links, s + 1) }))).toBe(base);
  });
  it("ids: format, unique, no 8-digit run across 2,000 minted encounters", () => {
    const s: SpineSignal[] = [];
    for (let i = 0; i < 2000; i++) s.push(sig("acoustic", `a${i}`, i * 20 * MIN, i * 20 * MIN + 5 * MIN));
    const ids = run(s, EMPTY, T0 + 2000 * 20 * MIN).encounters.map((e) => e.encounter_id);
    expect(new Set(ids).size).toBe(2000);
    for (const id of ids) { expect(id).toMatch(/^enc_[a-z2-7]{16}$/); expect(id).not.toMatch(/\d{8}/); }
  });
  it("rerun with own output as prior is a fixed point (ids, revs, links)", () => {
    const f = fx(), r1 = run(f), r2 = run(withIds(f, r1), prior(r1));
    expect(r2.encounters.map((e) => [e.encounter_id, e.boundary_rev, e.status])).toEqual(r1.encounters.map((e) => [e.encounter_id, e.boundary_rev, e.status]));
    expect(r2.links).toEqual(r1.links);
  });
});

describe("rules, edge", () => {
  it("M3: overlap exactly 50% of the shorter joins; 49.9% does not", () => {
    expect(run([pulse("p1", 0, 10 * MIN, "u1"), sig("pqm", "q", 5 * MIN, 30 * MIN, { pqm_uid: "x" })]).encounters).toHaveLength(1);
    expect(run([pulse("p1", 0, 10 * MIN, "u1"), sig("pqm", "q", 5 * MIN + 600, 30 * MIN, { pqm_uid: "x" })]).encounters).toHaveLength(2);
  });
  it("M6: cap_90m inferred close loses to an acoustic close", () => {
    const e = run([pulse("p1", 0, 30 * MIN, "u1", "cap_90m"), sig("acoustic", "a", 1 * MIN, 25 * MIN)]).encounters[0];
    expect(e.t_close).toBe(T0 + 25 * MIN);
  });
  it("M6: doctor_activity close loses to a pulse inferred close", () => {
    const e = run([pulse("p1", 0, 30 * MIN, "u1", "logout"), sig("doctor_activity", "d", 1 * MIN, 25 * MIN)]).encounters[0];
    expect(e.t_close).toBe(T0 + 30 * MIN);
  });
  it("M6: open from pqm beats timeline open", () => {
    const e = run([sig("pqm", "q", 2 * MIN, 20 * MIN, { pqm_uid: "x" }), sig("timeline", "t", 0, 20 * MIN)]).encounters[0];
    expect(e.t_open).toBe(T0 + 2 * MIN);
  });
  it("M5: same weak proxy twice is not two distinct proxies", () => {
    const e = run([sig("acoustic", "a1", 0, 10 * MIN), sig("acoustic", "a2", 0, 10 * MIN)]).encounters[0];
    expect(e.status).toBe("candidate");
  });
  it("M5: caa alone with no key match is unattached, never an encounter", () => {
    const r = run([sig("caa", "caa_1", 0, 10 * MIN)]);
    expect(r.encounters).toHaveLength(0);
    expect(r.unattached).toEqual(["caa:caa_1"]);
  });
  it("M8: a frozen encounter is never a loser and keeps its row", () => {
    const pe: PriorEncounter = { encounter_id: "enc_aaaaaaaaaaaaaaaa", ist_date: istDate(T0), room_id: R, t_open: T0, t_close: T0 + 10 * MIN, status: "confirmed", merged_into: null, anchor_proxy: "pulse", boundary_rev: 1, reason: "pulse", created_at: 1 };
    const r = run([pulse("p1", 0, 15 * MIN, "u1", "endConsult", "m1", { encounter_id: pe.encounter_id })], { encounters: [pe], links: [] }, T0 + 80 * 3_600_000);
    expect(r.encounters[0]).toMatchObject({ t_close: T0 + 10 * MIN, boundary_rev: 1, boundary_moved: false });
  });
});
