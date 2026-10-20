/** spine-s2 R4 refuter fixtures (throwaway; .bc/oref-r4). Synthetic ids only. "DEFECT" cases assert the behaviour the refuter expects. */
import { describe, it, expect } from "vitest";
import { mergeSignals } from "@/lib/spine/merge";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000;
const NOW = T0 + 12 * 3_600_000;
const FROZEN = Date.parse("2026-10-22T00:00:00Z");
const EMPTY: SpinePrior = { encounters: [], links: [] };
let rev = 0;
const sig = (proxy: Proxy, key: string, o: number, c: number | null, attrs: Record<string, unknown> = {}, room = "room_a"): SpineSignal =>
  ({ proxy, source_key: key, source_rev: ++rev, room_id: room, t_open: T0 + o * MIN, t_close: c === null ? null : T0 + c * MIN, attrs });
const pulse = (key: string, o: number, c: number | null, uid: string, reason = "endConsult", machine = "m1", extra: Record<string, unknown> = {}, room = "room_a") =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@${machine}`, close_reason: reason, ...extra }, room);
const enc = (id: string) => ({ ids: { pulse_enc_id: id } });
const run = (s: SpineSignal[], p: SpinePrior = EMPTY, now = NOW): MergeResult => mergeSignals(s, "mv1", p, now);
const idOf = (r: MergeResult, key: string) => r.assignments.find((a) => a.source_key === key)!.encounter_id;
const toPrior = (r: MergeResult, old: SpinePrior = EMPTY): SpinePrior => {
  const rows = new Map(old.encounters.map((e) => [e.encounter_id, e]));
  r.encounters.forEach((e, i) => rows.set(e.encounter_id, { ...e, created_at: rows.get(e.encounter_id)?.created_at ?? 100 + i } as PriorEncounter));
  return { encounters: [...rows.values()], links: r.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })) };
};
const withIds = (s: SpineSignal[], r: MergeResult) => s.map((x) => ({ ...x, encounter_id: idOf(r, x.source_key) }));
const live = (r: MergeResult) => r.encounters.filter((e) => e.status !== "merged");
const bump = (x: SpineSignal, a: Record<string, unknown>) => ({ ...x, source_rev: x.source_rev + 1000, attrs: { ...x.attrs, ...a } });

describe("R4 oref: open risk (6), two pulse priors joined by one pulse_enc_id", () => {
  it("DEFECT O1: the second pulse prior must not stay a live, unemitted, unresolvable row", () => {
    const pa = pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_t_01")), pb = pulse("pb", 1, 9, "v_1", "endConsult", "m3");
    const r1 = run([pa, pb]);
    expect(live(r1)).toHaveLength(2);
    const r2 = run(withIds([pa, bump(pb, enc("pe_t_01"))], r1), toPrior(r1));
    const p2 = toPrior(r2, toPrior(r1));
    const orphans = p2.encounters.filter((e) => e.status !== "merged" && e.anchor_proxy === "pulse" && !r2.assignments.some((a) => a.encounter_id === e.encounter_id));
    expect(orphans.map((e) => e.encounter_id)).toEqual([]);
  });
});

describe("R4 oref: R1 risk, a reused or mislabelled pulse_enc_id", () => {
  it("DEFECT R1a: same room, same machine, back-to-back consults sharing one enc id stay two encounters", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_t_09")), pulse("pb", 11, 20, "u_2", "endConsult", "m1", enc("pe_t_09"))]);
    expect(live(r)).toHaveLength(2);
  });
  it("DEFECT R1b: same room, two machines, non-overlapping consults 40 min apart sharing an enc id stay two encounters", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_t_09")), pulse("pb", 50, 60, "u_2", "endConsult", "m3", enc("pe_t_09"))]);
    expect(live(r)).toHaveLength(2);
  });
  it("R1c: different rooms never merge on a shared enc id", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_t_09")), pulse("pb", 0, 10, "u_2", "endConsult", "m3", enc("pe_t_09"), "room_b")]);
    expect(live(r)).toHaveLength(2);
  });
  it("R1d (R5 guard): a pqm with a mislabelled enc id 30 min from another consult's pulse stays apart, both enc_conflict", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_t_09")), sig("pqm", "qb", 30, 40, { pqm_uid: "pq_2", ...enc("pe_t_09") })]);
    expect(live(r)).toHaveLength(2);
    expect(live(r).every((e) => e.flags.includes("enc_conflict"))).toBe(true);
  });
});

describe("R4 oref: M6 cap explicit for idle_timeout", () => {
  for (const reason of ["idle_timeout", "logout", "next_open"]) it(`a ${reason} close is capped at the next pqm open (strong-anchored)`, () => {
    const r = run([pulse("pa", 0, 30, "u_1", reason), sig("pqm", "qb", 12, 20, { pqm_uid: "pq_2" })]);
    const a = r.encounters.find((e) => e.encounter_id === idOf(r, "pa"))!;
    expect(a.t_close).toBe(T0 + 12 * MIN);
    expect(a.flags).toContain("clamped");
  });
  it("a never-closed pulse (90 min cap) is capped at the next pulse open", () => {
    const r = run([pulse("pa", 0, null, "u_1"), pulse("pb", 40, 50, "u_2")]);
    expect(r.encounters.find((e) => e.encounter_id === idOf(r, "pa"))!.t_close).toBe(T0 + 40 * MIN);
  });
  it("an idle_timeout close is NOT stretched to the next open when it ends earlier", () => {
    const r = run([pulse("pa", 0, 8, "u_1", "idle_timeout"), pulse("pb", 12, 20, "u_2")]);
    expect(r.encounters.find((e) => e.encounter_id === idOf(r, "pa"))!.t_close).toBe(T0 + 8 * MIN);
  });
});

describe("R4 oref: covered_by_pulse edges", () => {
  const q = (o: number, c: number) => sig("pqm", `q${o}`, o, c, { pqm_uid: `pq_${o}` });
  const fl = (r: MergeResult, k: string) => r.encounters.find((e) => e.encounter_id === idOf(r, k))!.flags;
  it("exactly 90% inside is covered; 88% is not", () => {
    expect(fl(run([pulse("p1", 0, 30, "u_1", "url_clear"), q(21, 31)]), "q21")).toContain("covered_by_pulse"); // 9 of 10 min
    expect(fl(run([pulse("p1", 0, 30, "u_1", "url_clear"), q(21.2, 31.2)]), "q21.2")).not.toContain("covered_by_pulse"); // 8.8 of 10
  });
  it("a pqm merged into its pulse by key is never covered_by_pulse", () => {
    const r = run([pulse("p1", 0, 20, "u_1", "endConsult", "m1", enc("pe_t_03")), sig("pqm", "q1", 8, 13, { pqm_uid: "pq_1", ...enc("pe_t_03") })]);
    expect(live(r)).toHaveLength(1);
    expect(live(r)[0].flags).not.toContain("covered_by_pulse");
  });
});

describe("R4 oref: R3-B frozen day", () => {
  it("LETTER R3-B: a brand-new pulse arriving for a past-horizon day mints nothing", () => {
    const p0 = pulse("p0", 0, 10, "u_0");
    const r1 = run([p0]);
    const r2 = run([...withIds([p0], r1), pulse("pn", 30, 40, "u_n")], toPrior(r1), FROZEN);
    expect(r2.encounters.filter((e) => !toPrior(r1).encounters.some((x) => x.encounter_id === e.encounter_id))).toEqual([]);
  });
  it("a frozen pulse whose close moves keeps its frozen boundary and id", () => {
    const p0 = pulse("p0", 0, 10, "u_0");
    const r1 = run([p0]);
    const r2 = run(withIds([{ ...p0, source_rev: p0.source_rev + 5, t_close: T0 + 25 * MIN }], r1), toPrior(r1), FROZEN);
    expect(idOf(r2, "p0")).toBe(idOf(r1, "p0"));
    expect(r2.encounters.find((e) => e.encounter_id === idOf(r1, "p0"))?.t_close ?? T0 + 10 * MIN).toBe(T0 + 10 * MIN);
  });
});

describe("R4 oref: M2 three machines, one enc id", () => {
  it("three machines' pulses with one enc id give one encounter, multi_machine, all consult_key links on it", () => {
    const r = run([pulse("pa", 0, 10, "u_1", "endConsult", "m1", enc("pe_t_05")), pulse("pb", 0, 11, "v_1", "idle_timeout", "m3", enc("pe_t_05")), pulse("pc", 1, 9, "w_1", "endConsult", "m4", enc("pe_t_05"))]);
    expect(live(r)).toHaveLength(1);
    expect(live(r)[0].flags).toContain("multi_machine");
    expect(new Set(r.links.filter((l) => l.key_kind === "consult_key").map((l) => l.encounter_id)).size).toBe(1);
  });
});
