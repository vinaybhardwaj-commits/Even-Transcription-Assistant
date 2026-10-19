/** spine-merge-r2.test.ts: round-2 fixes F1, I2-I5, A2 (see the header of lib/spine/merge.ts). Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { mergeSignals, istDate, assertUniqueIds } from "@/lib/spine/merge";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000, SEC = 1000;
const NOW = T0 + 10 * 3_600_000;
const EMPTY: SpinePrior = { encounters: [], links: [] };
let rev = 0;
const sig = (proxy: Proxy, key: string, o: number, c: number | null, attrs: Record<string, unknown> = {}, extra: Partial<SpineSignal> = {}): SpineSignal =>
  ({ proxy, source_key: key, source_rev: ++rev, room_id: "room_a", t_open: T0 + o, t_close: c === null ? null : T0 + c, attrs, ...extra });
const pulse = (key: string, o: number, c: number | null, uid: string, reason = "endConsult", m = "m1") =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@${m}`, close_reason: reason });
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW) => mergeSignals(s, "mv1", p, now);
const prior = (r: MergeResult): SpinePrior => ({
  encounters: r.encounters.map((e) => ({ ...e, created_at: 1 } as PriorEncounter)),
  links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
});
const idOf = (r: MergeResult, key: string) => r.assignments.find((a) => a.source_key === key)!.encounter_id;
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: r.assignments.find((a) => a.proxy === x.proxy && a.source_key === x.source_key)?.encounter_id ?? null }));
const unique = (r: MergeResult) => expect(new Set(r.encounters.map((e) => e.encounter_id)).size).toBe(r.encounters.length);

describe("F1: strong-anchored priors stay with their anchor across reruns", () => {
  it("3-consult chain, a weak signal hops twice: ids and links stay with their pulses", () => {
    const base = [pulse("p1", 0, 10 * MIN, "u_1"), pulse("p2", 10 * MIN, 20 * MIN, "u_2"), pulse("p3", 20 * MIN, 30 * MIN, "u_3")];
    const hop = (a: SpineSignal, o: number, c: number) => ({ ...a, source_rev: a.source_rev + 100, t_open: T0 + o * MIN, t_close: T0 + c * MIN });
    const a1 = sig("acoustic", "a1", 21 * MIN, 29 * MIN, { consult_uid: "u_3" });
    let s = [...base, a1];
    let r = run(s);
    const ids = ["p1", "p2", "p3"].map((k) => idOf(r, k));
    expect(new Set(ids).size).toBe(3);
    expect(idOf(r, "a1")).toBe(ids[2]);
    for (const [o, c, who] of [[11, 19, 1], [1, 9, 0]] as const) {
      s = withIds(s, r).map((x) => (x.source_key === "a1" ? { ...hop(x, o, c), attrs: {} } : x));
      r = run(s, prior(r));
      expect(r.encounters.filter((e) => e.status === "merged")).toHaveLength(0);
      unique(r);
      ["p1", "p2", "p3"].forEach((k, i) => expect(idOf(r, k)).toBe(ids[i]));
      expect(idOf(r, "a1")).toBe(ids[who]);
      const link = r.links.filter((l) => l.key_kind === "consult_key");
      ["u_1", "u_2", "u_3"].forEach((u, i) => expect(link.find((l) => l.value === `${u}@m1`)!.encounter_id).toBe(ids[i]));
    }
  });
  it("two strong-anchored priors are never survivor and loser of each other (stale ids on both pulses)", () => {
    const s0 = [pulse("p1", 0, 10 * MIN, "u_1"), pulse("p2", 10 * MIN, 20 * MIN, "u_2")];
    const r1 = run(s0);
    const s = withIds(s0, r1).map((x) => ({ ...x, encounter_id: idOf(r1, x.source_key === "p1" ? "p2" : "p1") })); // ids swapped
    const r2 = run(s, prior(r1));
    unique(r2);
    expect(r2.encounters.filter((e) => e.status === "merged")).toHaveLength(0);
  });
});

describe("F1 backstop", () => {
  it("assertUniqueIds throws on a duplicate id and passes on unique ids", () => {
    expect(() => assertUniqueIds([{ encounter_id: "enc_a" }, { encounter_id: "enc_b" }])).not.toThrow();
    expect(() => assertUniqueIds([{ encounter_id: "enc_a" }, { encounter_id: "enc_a" }])).toThrow(/duplicate/);
  });
});

describe("I2: any positive overlap of same-kind strong anchors flags both", () => {
  it("pads overlapping 30 s", () => {
    const r = run([pulse("p1", 0, 10 * MIN + 30 * SEC, "u_1"), pulse("p2", 10 * MIN, 20 * MIN, "u_2")]);
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters.every((e) => e.flags.includes("pulse_overlap"))).toBe(true);
  });
  it("touching but not overlapping: no flag", () => {
    const r = run([pulse("p1", 0, 10 * MIN, "u_1"), pulse("p2", 10 * MIN, 20 * MIN, "u_2")]);
    expect(r.encounters.some((e) => e.flags.includes("pulse_overlap"))).toBe(false);
  });
});

describe("I3: weak or inferred boundaries clamp at a neighbouring strong encounter", () => {
  it("idle_timeout 12 min, next open 10 min, acoustic 0-20: A clamped at 10, B untouched, both flagged", () => {
    const r = run([pulse("p1", 0, 12 * MIN, "u_1", "idle_timeout"), pulse("p2", 10 * MIN, 20 * MIN, "u_2"), sig("acoustic", "a1", 0, 20 * MIN)]);
    const [A, B] = r.encounters;
    expect([A.t_open - T0, A.t_close - T0]).toEqual([0, 10 * MIN]);
    expect([B.t_open - T0, B.t_close - T0]).toEqual([10 * MIN, 20 * MIN]);
    expect(A.flags).toContain("clamped");
    expect(B.flags).not.toContain("clamped");
    expect(A.flags).toContain("pulse_overlap");
    expect(B.flags).toContain("pulse_overlap");
  });
  it("an explicit strong close is never clamped", () => {
    const r = run([pulse("p1", 0, 12 * MIN, "u_1", "endConsult"), pulse("p2", 10 * MIN, 20 * MIN, "u_2")]);
    expect(r.encounters[0].t_close - T0).toBe(12 * MIN);
    expect(r.encounters[0].flags).not.toContain("clamped");
  });
});

describe("I4: a frozen prior keeps its links", () => {
  it("a link owned by a frozen encounter does not move to the live survivor", () => {
    const F: PriorEncounter = { encounter_id: "enc_fffffffffffffff2", ist_date: "2026-10-10", room_id: "room_a", t_open: T0, t_close: T0 + 10 * MIN, status: "candidate", merged_into: null, anchor_proxy: "acoustic", boundary_rev: 0, reason: "weak_single", created_at: 1 };
    const S: PriorEncounter = { ...F, encounter_id: "enc_sssssssssssssss2", ist_date: istDate(T0), anchor_proxy: "pulse", status: "confirmed", reason: "pulse", created_at: 2 };
    const s = [sig("pulse", "p1", 0, 10 * MIN, { consult_uid: "u_p", consult_key: "u_p@m1", close_reason: "endConsult" }, { encounter_id: S.encounter_id }),
      sig("acoustic", "a1", 1 * MIN, 9 * MIN, { consult_uid: "u_f" }, { encounter_id: F.encounter_id })];
    const r = run(s, { encounters: [F, S], links: [{ encounter_id: F.encounter_id, key_kind: "consult_uid", value: "u_f" }] });
    expect(r.links.find((l) => l.value === "u_f")!.encounter_id).toBe(F.encounter_id);
    expect(r.encounters.filter((e) => e.status === "merged")).toHaveLength(0);
  });
});

describe("I5: a keyed weak signal far in time does not count toward weak_agree", () => {
  it("stays a candidate", () => {
    const r = run([sig("acoustic", "a1", 0, 10 * MIN, { consult_uid: "u_k" }), sig("timeline", "t1", 100 * MIN, 110 * MIN, { consult_uid: "u_k" })]);
    expect(r.encounters).toHaveLength(1);
    expect(r.encounters[0].status).toBe("candidate");
  });
});

describe("A2: consult_uid merges only on the same machine", () => {
  it("a weak signal keyed by consult_uid + consult_key joins only its own machine's consult", () => {
    const r = run([pulse("pa", 0, 10 * MIN, "u_1", "endConsult", "m1"), pulse("pb", 0, 10 * MIN, "u_1", "endConsult", "m2"),
      sig("acoustic", "a1", 1 * MIN, 9 * MIN, { consult_uid: "u_1", consult_key: "u_1@m2" })]);
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters.every((e) => e.flags.includes("multi_machine"))).toBe(true);
    expect(idOf(r, "a1")).toBe(idOf(r, "pb"));
  });
  it("a consult_uid with no consult_key on one side still matches", () => {
    const r = run([pulse("pa", 0, 10 * MIN, "u_1"), sig("cutter", "c1", 0, 10 * MIN, { consult_uid: "u_1" })]);
    expect(idOf(r, "c1")).toBe(idOf(r, "pa"));
  });
});
