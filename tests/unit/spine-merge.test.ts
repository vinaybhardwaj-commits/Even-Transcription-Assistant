/**
 * spine-merge.test.ts — pure mergeSignals (SPINE-PLAN §3 M1-M9). Synthetic ids only; no text.
 * The pg writer test is round 2 (merge-store.ts does not exist yet).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mergeSignals, encounterIdCandidate, mintEncounterId, istDate, CAP_MS } from "@/lib/spine/merge";
import type { MergeResult, PriorEncounter, Proxy, SpinePrior, SpineSignal } from "@/lib/spine/types";

const T0 = Date.parse("2026-10-19T04:00:00Z");
const MIN = 60_000;
const NOW = T0 + 10 * 3_600_000; // same IST day, after every fixture
const V = "mv1";
const EMPTY: SpinePrior = { encounters: [], links: [] };
const ROOM = "room_a";

let rev = 0;
function sig(proxy: Proxy, key: string, openMin: number, closeMin: number | null, attrs: Record<string, unknown> = {}, extra: Partial<SpineSignal> = {}): SpineSignal {
  return { proxy, source_key: key, source_rev: ++rev, room_id: ROOM, t_open: T0 + openMin * MIN, t_close: closeMin === null ? null : T0 + closeMin * MIN, attrs, ...extra };
}
const pulse = (key: string, o: number, c: number | null, uid: string, reason = "endConsult", extra: Partial<SpineSignal> = {}) =>
  sig("pulse", key, o, c, { consult_uid: uid, consult_key: `${uid}@m1`, close_reason: reason }, extra);
const pqm = (uid: string, o: number, c: number | null, extra: Partial<SpineSignal> = {}) => sig("pqm", `s_${uid}`, o, c, { pqm_uid: uid }, extra);
const run = (s: SpineSignal[], prior: SpinePrior = EMPTY, now = NOW) => mergeSignals(s, V, prior, now);
const sha = (r: MergeResult) => createHash("sha256").update(JSON.stringify(r)).digest("hex");
const byStatus = (r: MergeResult, st: string) => r.encounters.filter((e) => e.status === st);
function priorEnc(id: string, over: Partial<PriorEncounter> = {}): PriorEncounter {
  return { encounter_id: id, ist_date: istDate(T0), room_id: ROOM, t_open: T0, t_close: T0 + 10 * MIN, status: "candidate", merged_into: null, anchor_proxy: "acoustic", boundary_rev: 0, reason: "weak_single", created_at: 1000, ...over };
}

describe("M1 normalise", () => {
  it("a signal with no room is unplaced, counted, never merged", () => {
    const r = run([pulse("p1", 0, 10, "uid_test_01"), pulse("p2", 0, 10, "uid_test_02", "endConsult", { room_id: null })]);
    expect(r.unplaced).toBe(1);
    expect(r.encounters).toHaveLength(1);
  });
  it("an open signal under the 90 min cap is deferred; at the cap it closes there", () => {
    const open = pulse("p1", 0, null, "uid_test_01");
    expect(run([open], EMPTY, T0 + CAP_MS - 1)).toMatchObject({ open_deferred: 1, encounters: [] });
    const r = run([open], EMPTY, T0 + CAP_MS);
    expect(r.open_deferred).toBe(0);
    expect(r.encounters[0].t_close).toBe(T0 + CAP_MS);
  });
  it("only the highest source_rev of a source counts", () => {
    const a = pulse("p1", 0, 10, "uid_test_01", "endConsult", { source_rev: 1 });
    const b = pulse("p1", 0, 12, "uid_test_01", "endConsult", { source_rev: 2 });
    expect(run([a, b]).encounters[0].t_close).toBe(T0 + 12 * MIN);
  });
});

describe("M2 key match first", () => {
  it("the same pqm_uid is one encounter whatever the time", () => {
    const r = run([sig("pqm", "s1", 0, 5, { pqm_uid: "pqm_test_01" }), sig("pqm", "s2", 60, 65, { pqm_uid: "pqm_test_01" })]);
    expect(r.encounters).toHaveLength(1);
  });
  it("a weak signal with a matching consult_key joins though it sits far in time", () => {
    const r = run([pulse("p1", 0, 10, "uid_test_01"), sig("timeline", "t1", 50, 55, { consult_key: "uid_test_01@m1" })]);
    expect(r.encounters).toHaveLength(1);
  });
  it("one Pulse enc id on two machines gives two encounters flagged multi_machine", () => {
    const a = sig("pulse", "pa", 0, 10, { consult_uid: "uid_test_01", consult_key: "uid_test_01@m1", close_reason: "endConsult" });
    const b = sig("pulse", "pb", 20, 30, { consult_uid: "uid_test_01", consult_key: "uid_test_01@m2", close_reason: "endConsult" });
    const r = run([a, b]);
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters.every((e) => e.flags.includes("multi_machine"))).toBe(true);
    expect(new Set(r.links.filter((l) => l.key_kind === "consult_uid").map((l) => l.encounter_id)).size).toBe(1); // one active owner
  });
});

describe("M3 time match", () => {
  it("a pqm window and a pulse window at 50% overlap are one encounter, joined by overlap", () => {
    const r = run([pulse("p1", 0, 10, "uid_test_01"), pqm("pqm_test_01", 5, 15)]);
    expect(r.encounters).toHaveLength(1);
    expect(r.links.find((l) => l.key_kind === "pqm_uid")?.basis).toBe("overlap");
  });
  it("45% overlap does not join", () => {
    expect(run([pulse("p1", 0, 100, "uid_test_01"), pqm("pqm_test_01", 55, 155)]).encounters).toHaveLength(2);
  });
  it("a cutter signal never attaches by time", () => {
    const r = run([pulse("p1", 0, 10, "uid_test_01"), sig("cutter", "c1", 0, 10, { consult_uid: "uid_other" })]);
    expect(r.unattached).toEqual(["cutter:c1"]);
    expect(r.encounters).toHaveLength(1);
  });
  it("different rooms never merge", () => {
    expect(run([pulse("p1", 0, 10, "uid_test_01"), pqm("pqm_test_01", 0, 10, { room_id: "room_b" })]).encounters).toHaveLength(2);
  });
});

describe("M4 two strong anchors never merge", () => {
  it("two pulse ids overlapping 90% stay two encounters, both flagged", () => {
    const r = run([pulse("p1", 0, 100, "uid_test_01"), pulse("p2", 5, 95, "uid_test_02")]);
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters.every((e) => e.flags.includes("pulse_overlap"))).toBe(true);
  });
  it("two pqm uids overlapping stay two encounters", () => {
    expect(run([pqm("pqm_test_01", 0, 100), pqm("pqm_test_02", 5, 95)]).encounters).toHaveLength(2);
  });
  it("a pqm window between two pulses pairs with only one", () => {
    const r = run([pulse("p1", 0, 100, "uid_test_01"), pulse("p2", 10, 90, "uid_test_02"), pqm("pqm_test_01", 10, 90)]);
    expect(r.encounters).toHaveLength(2);
  });
});

describe("M5 status", () => {
  it("one weak proxy alone gives candidate", () => {
    const e = run([sig("acoustic", "a1", 0, 10)]).encounters[0];
    expect([e.status, e.reason]).toEqual(["candidate", "weak_single"]);
  });
  it("two weak proxies that agree, span >= 120 s, give confirmed", () => {
    const e = run([sig("acoustic", "a1", 0, 10), sig("timeline", "t1", 0, 10)]).encounters[0];
    expect([e.status, e.reason]).toEqual(["confirmed", "weak_agree"]);
  });
  it("two weak proxies at 49% overlap give candidate (two encounters)", () => {
    const r = run([sig("acoustic", "a1", 0, 100), sig("timeline", "t1", 51, 151)]);
    expect(r.encounters).toHaveLength(2);
    expect(r.encounters.map((e) => e.status).sort()).toEqual(["candidate", "confirmed_single_proxy"]); // the lone timeline group is single_proxy (RULING B), the lone acoustic one a candidate
  });
  it("a 119 s span gives candidate; 120 s gives confirmed", () => {
    const mk = (s: number) => [sig("acoustic", "a1", 0, 0, {}, { t_close: T0 + s * 1000 }), sig("timeline", "t1", 0, 0, {}, { t_close: T0 + s * 1000 })];
    expect(run(mk(119)).encounters[0]).toMatchObject({ status: "candidate", reason: "weak_short" });
    expect(run(mk(120)).encounters[0].status).toBe("confirmed");
  });
  it("a pulse or a pqm signal alone confirms", () => {
    expect(run([pulse("p1", 0, 10, "uid_test_01")]).encounters[0]).toMatchObject({ status: "confirmed", reason: "pulse" });
    expect(run([pqm("pqm_test_01", 0, 10)]).encounters[0]).toMatchObject({ status: "confirmed", reason: "pqm" });
  });
  it("blind_room_day rejects; no_tape rejects only after t_close + 24 h", () => {
    const base = pulse("p1", 0, 10, "uid_test_01");
    const blind = sig("cutter", "c1", 0, 10, { consult_uid: "uid_test_01", final_reason: "blind_room_day" });
    expect(run([base, blind]).encounters[0]).toMatchObject({ status: "rejected", reason: "blind_room_day" });
    const nt = sig("cutter", "c2", 0, 10, { consult_uid: "uid_test_01", final_reason: "no_tape" });
    expect(run([base, nt], EMPTY, T0 + 10 * MIN + 24 * 3_600_000 - 1).encounters[0].status).toBe("confirmed");
    expect(run([base, nt], EMPTY, T0 + 10 * MIN + 24 * 3_600_000).encounters[0].status).toBe("rejected");
  });
  it("silent_audio stays confirmed with reason silent", () => {
    const e = run([sig("acoustic", "a1", 0, 10), sig("cutter", "c1", 0, 10, { consult_key: "k" }, {})]).encounters[0];
    expect(e.status).toBe("candidate"); // unattached cutter changes nothing
    const r = run([pulse("p1", 0, 10, "uid_test_01"), sig("cutter", "c2", 0, 10, { consult_uid: "uid_test_01", final_reason: "silent_audio" })]);
    expect(r.encounters[0]).toMatchObject({ status: "confirmed", reason: "silent" });
  });
});

describe("M6 boundaries", () => {
  it("pulse endConsult close outranks pqm close", () => {
    const e = run([pulse("p1", 0, 10, "uid_test_01", "endConsult"), pqm("pqm_test_01", 1, 14)]).encounters[0];
    expect([e.t_open, e.t_close]).toEqual([T0, T0 + 10 * MIN]);
  });
  it("pqm close outranks a pulse inferred close; timeline outranks acoustic", () => {
    const e = run([pulse("p1", 0, 10, "uid_test_01", "next_open"), pqm("pqm_test_01", 1, 14)]).encounters[0];
    expect(e.t_close).toBe(T0 + 14 * MIN);
    const w = run([sig("timeline", "t1", 0, 9), sig("acoustic", "a1", 0, 12)]).encounters[0];
    expect(w.t_close).toBe(T0 + 9 * MIN);
  });
  it("ties go to the earlier open and the later close", () => {
    const e = run([sig("acoustic", "a1", 1, 9), sig("acoustic", "a2", 0, 10)]).encounters[0];
    expect([e.t_open, e.t_close]).toEqual([T0, T0 + 10 * MIN]);
  });
});

describe("M7 ambiguous weak signal", () => {
  const two = () => [pulse("p1", 0, 10, "uid_test_01"), pulse("p2", 10, 20, "uid_test_02")];
  it("a weak signal meeting two encounters joins the larger overlap and flags ambiguous", () => {
    const r = run([...two(), sig("acoustic", "a1", 4, 16)]); // 6 min in p1, 6 in p2 -> tie handled below; shift for larger
    expect(r.encounters).toHaveLength(2);
    const r2 = run([...two(), sig("acoustic", "a1", 3, 15)]); // 7 in p1, 5 in p2
    const first = r2.encounters.find((e) => e.t_open === T0)!;
    expect(first.flags).toContain("ambiguous");
    expect(r2.assignments.find((a) => a.proxy === "acoustic")?.encounter_id).toBe(first.encounter_id);
  });
  it("a tie goes to the earlier encounter", () => {
    const r = run([...two(), sig("acoustic", "a1", 5, 15)]); // 5 and 5
    const first = r.encounters.find((e) => e.t_open === T0)!;
    expect(r.assignments.find((a) => a.proxy === "acoustic")?.encounter_id).toBe(first.encounter_id);
    expect(first.flags).toContain("ambiguous");
  });
});

describe("M8 late signals", () => {
  it("a late signal joining two encounters keeps the pulse-anchored survivor's id and marks the loser merged", () => {
    const p1 = priorEnc("enc_aaaaaaaaaaaaaaaa", { anchor_proxy: "pulse", status: "confirmed", created_at: 5000, t_close: T0 + 10 * MIN });
    const p2 = priorEnc("enc_bbbbbbbbbbbbbbbb", { created_at: 1000, t_open: T0 + 12 * MIN, t_close: T0 + 20 * MIN });
    const prior: SpinePrior = { encounters: [p1, p2], links: [{ encounter_id: "enc_bbbbbbbbbbbbbbbb", key_kind: "window_id", value: "bw_old" }] };
    const sigs = [
      pulse("p1", 0, 20, "uid_test_01", "endConsult", { encounter_id: p1.encounter_id }), // a late rev stretches the pulse window over the weak one
      sig("acoustic", "a1", 12, 20, {}, { encounter_id: p2.encounter_id }),
    ];
    const r = run(sigs, prior);
    const survivor = r.encounters.find((e) => e.encounter_id === p1.encounter_id)!;
    const loser = r.encounters.find((e) => e.encounter_id === p2.encounter_id)!;
    expect(survivor.status).not.toBe("merged");
    expect(loser).toMatchObject({ status: "merged", merged_into: p1.encounter_id });
    expect(r.links.find((l) => l.value === "bw_old")).toMatchObject({ encounter_id: p1.encounter_id, basis: "merge" });
  });
  it("with no anchor the older created_at survives", () => {
    const older = priorEnc("enc_cccccccccccccccc", { created_at: 100 });
    const newer = priorEnc("enc_dddddddddddddddd", { created_at: 200, t_open: T0 + 1 * MIN });
    const r = run([sig("acoustic", "a1", 0, 10, {}, { encounter_id: older.encounter_id }), sig("timeline", "t1", 0, 10, {}, { encounter_id: newer.encounter_id })], { encounters: [newer, older], links: [] });
    expect(r.encounters.find((e) => e.status === "merged")?.encounter_id).toBe(newer.encounter_id);
  });
  it("an anchored survivor beats an older unanchored one", () => {
    const old = priorEnc("enc_eeeeeeeeeeeeeeee", { created_at: 100 });
    const anch = priorEnc("enc_ffffffffffffffff", { created_at: 900, anchor_proxy: "pqm", status: "confirmed" });
    const r = run([sig("acoustic", "a1", 0, 10, {}, { encounter_id: old.encounter_id }), pqm("pqm_test_01", 0, 10, { encounter_id: anch.encounter_id })], { encounters: [old, anch], links: [] });
    expect(r.encounters.find((e) => e.status === "merged")?.encounter_id).toBe(old.encounter_id);
  });
  it("a moved boundary bumps boundary_rev and asks for a recut", () => {
    const p = priorEnc("enc_gggggggggggggggg", { anchor_proxy: "pulse", status: "confirmed", boundary_rev: 2 });
    const r = run([pulse("p1", 0, 12, "uid_test_01", "endConsult", { encounter_id: p.encounter_id })], { encounters: [p], links: [] });
    expect(r.encounters[0]).toMatchObject({ encounter_id: p.encounter_id, boundary_rev: 3, boundary_moved: true });
  });
  it("after ist_date + 72 h a boundary move changes no boundary (links only)", () => {
    const p = priorEnc("enc_hhhhhhhhhhhhhhhh", { anchor_proxy: "pulse", status: "confirmed", boundary_rev: 2 });
    const s = [pulse("p1", 0, 12, "uid_test_01", "endConsult", { encounter_id: p.encounter_id })];
    const start = Date.parse(`${p.ist_date}T00:00:00Z`) - 19_800_000;
    const before = run(s, { encounters: [p], links: [] }, start + 72 * 3_600_000 - 1);
    expect(before.encounters[0].boundary_moved).toBe(true);
    const after = run(s, { encounters: [p], links: [] }, start + 72 * 3_600_000);
    expect(after.encounters[0]).toMatchObject({ t_open: p.t_open, t_close: p.t_close, boundary_rev: 2, boundary_moved: false });
    expect(after.encounters[0].flags).toContain("frozen");
    expect(after.links.some((l) => l.key_kind === "consult_uid" && l.encounter_id === p.encounter_id)).toBe(true);
  });
});

describe("M9 stable id", () => {
  const fixture = () => [
    pulse("p1", 0, 30, "uid_test_01"), pulse("p2", 40, 60, "uid_test_02"), pqm("pqm_test_01", 2, 28), pqm("pqm_test_09", 100, 120),
    sig("acoustic", "a1", 1, 29), sig("timeline", "t1", 41, 59), sig("acoustic", "a2", 200, 210), sig("timeline", "t2", 200, 210),
    sig("doctor_activity", "d1", 45, 58), sig("nemotron_window", "bw_room_a_1", 0, 20), sig("cutter", "c1", 0, 30, { consult_uid: "uid_test_01", final_reason: "silent_audio" }),
  ];
  it("ids are enc_ + 16 base32 with no 8-digit run", () => {
    for (const e of run(fixture()).encounters) expect(e.encounter_id).toMatch(/^enc_[a-z2-7]{16}$/);
    for (const e of run(fixture()).encounters) expect(e.encounter_id).not.toMatch(/\d{8}/);
  });
  it("a rerun on shuffled input is byte-identical (deep-equal plus a sha)", () => {
    const f = fixture();
    const base = run(f);
    const shuffled = [...f].reverse();
    const x = [...f];
    for (let i = x.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [x[i], x[j]] = [x[j], x[i]]; }
    const a = run(shuffled), b = run(x);
    expect(a).toEqual(base);
    expect(b).toEqual(base);
    expect(sha(a)).toBe(sha(base));
    expect(sha(b)).toBe(sha(base));
  });
  it("feeding the output back as prior keeps every id and moves nothing", () => {
    const s = fixture();
    const r1 = run(s);
    const prior: SpinePrior = {
      encounters: r1.encounters.map((e) => ({ ...e, reason: e.reason, created_at: 1 })),
      links: r1.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })),
    };
    const withIds = s.map((x) => ({ ...x, encounter_id: r1.assignments.find((a) => a.proxy === x.proxy && a.source_key === x.source_key)!.encounter_id }));
    const r2 = run(withIds, prior);
    expect(r2.encounters.map((e) => e.encounter_id)).toEqual(r1.encounters.map((e) => e.encounter_id));
    expect(r2.encounters.every((e) => !e.boundary_moved)).toBe(true);
  });
  it("an id containing an 8-digit run is rehashed", () => {
    const first = encounterIdCandidate("pulse", "k16412", "room_a", 1000, 0);
    expect(first).toMatch(/\d{8}/); // the fixture is only meaningful while this holds
    const id = mintEncounterId("pulse", "k16412", "room_a", 1000, new Set());
    expect(id).not.toMatch(/\d{8}/);
    expect(id).toBe(encounterIdCandidate("pulse", "k16412", "room_a", 1000, 1));
  });
  it("a collision with a taken id is rehashed", () => {
    const c0 = encounterIdCandidate("pulse", "kx", "room_a", 5, 0);
    expect(mintEncounterId("pulse", "kx", "room_a", 5, new Set([c0]))).not.toBe(c0);
  });
});
