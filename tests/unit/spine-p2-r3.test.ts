/** SPINE-P2 R3 (fable RULING B, 22 Oct): `confirmed_single_proxy` — pure merge shapes and the enqueue plan. SQL is proven in spine-p2-r3-pg.test.ts. Synthetic ids only. */
import { describe, it, expect } from "vitest";
import { mergeSignals } from "@/lib/spine/merge";
import { CLOSE_GRACE_MS, SP_PREFIX, effectiveModes, inputKey, planJobs, stagesFor, FREE_STAGES } from "@/lib/spine/enqueue";
import type { Mode } from "@/lib/spine/config";
import type { SpineSignal } from "@/lib/spine/types";

const T = Date.parse("2026-10-18T04:00:00Z");
const NOW = T + 6 * 3_600_000;
const min = (n: number) => T + n * 60_000;
const s = (proxy: SpineSignal["proxy"], key: string, o: number, c: number, attrs: Record<string, unknown> = {}): SpineSignal =>
  ({ proxy, source_key: key, source_rev: 1, room_id: "room_abcd2345", t_open: min(o), t_close: min(c), attrs });
const empty = { encounters: [], links: [] };
const one = (sigs: SpineSignal[]) => { const r = mergeSignals(sigs, "t", empty, NOW); return r.encounters.map((e) => `${e.status}/${e.reason}`); };

describe("mergeSignals: the timeline-only shape is confirmed_single_proxy; every other shape keeps its status", () => {
  const TL = s("timeline", "ka@m1", 0, 10, { consult_key: "ka@m1" });
  it("timeline alone -> confirmed_single_proxy / single_proxy_timeline (also under 120 s)", () => {
    expect(one([TL])).toEqual(["confirmed_single_proxy/single_proxy_timeline"]);
    expect(one([s("timeline", "kb@m1", 0, 1, { consult_key: "kb@m1" })])).toEqual(["confirmed_single_proxy/single_proxy_timeline"]);
  });
  it("shapes table (unchanged by R3)", () => {
    expect(one([s("acoustic", "a1", 0, 10)])).toEqual(["candidate/weak_single"]);
    expect(one([s("doctor_activity", "d1", 0, 10)])).toEqual(["candidate/weak_single"]);
    expect(one([s("nemotron_window", "n1", 0, 10)])).toEqual(["candidate/weak_single"]);
    expect(one([s("pulse", "ka@m1", 0, 10, { consult_key: "ka@m1" })])).toEqual(["confirmed/pulse"]);
    expect(one([s("pqm", "q1", 0, 10, { pqm_uid: "q1" })])).toEqual(["confirmed/pqm"]);
    expect(one([s("pulse", "ka@m1", 0, 10, { consult_key: "ka@m1" }), s("timeline", "ka@m1", 0, 9, { consult_key: "ka@m1" })])).toEqual(["confirmed/pulse"]);
    expect(one([TL, s("acoustic", "a1", 0, 10)])).toEqual(["confirmed/weak_agree"]);
    expect(one([TL, s("doctor_activity", "d1", 0, 10)])).toEqual(["confirmed/weak_agree"]);
    expect(one([s("timeline", "kc@m1", 0, 1, { consult_key: "kc@m1" }), s("acoustic", "a2", 0, 1)])).toEqual(["candidate/weak_short"]);
  });
  it("timeline + a cutter final_reason: silent_audio stays confirmed/silent, blind_room_day stays rejected", () => {
    expect(one([TL, s("cutter", "kc", 0, 10, { consult_key: "ka@m1", final_reason: "silent_audio" })])).toEqual(["confirmed/silent"]);
    expect(one([TL, s("cutter", "kc", 0, 10, { consult_key: "ka@m1", final_reason: "blind_room_day" })])).toEqual(["rejected/blind_room_day"]);
  });
  it("promotion: a later pulse or a second weak proxy makes it confirmed (same id; boundary rev bumps only if the span moved)", () => {
    const r0 = mergeSignals([TL], "t", empty, NOW);
    const e0 = r0.encounters[0];
    const prior = { encounters: [{ encounter_id: e0.encounter_id, ist_date: e0.ist_date, room_id: e0.room_id, t_open: e0.t_open, t_close: e0.t_close, status: e0.status, merged_into: null, anchor_proxy: e0.anchor_proxy, boundary_rev: e0.boundary_rev, reason: e0.reason, created_at: 1 }], links: r0.links.map((l) => ({ encounter_id: l.encounter_id, key_kind: l.key_kind, value: l.value })) };
    const withTl = { ...TL, encounter_id: e0.encounter_id };
    const a = mergeSignals([withTl, s("pulse", "ka@m1", 0, 10, { consult_key: "ka@m1" })], "t", prior, NOW).encounters.filter((e) => e.status !== "merged");
    expect(a.map((e) => `${e.status}/${e.reason}`)).toEqual(["confirmed/pulse"]);
    expect(a[0].encounter_id).toBe(e0.encounter_id);
    const b = mergeSignals([withTl, s("acoustic", "a1", 0, 10)], "t", prior, NOW).encounters;
    expect(b.map((e) => `${e.status}/${e.reason}`)).toEqual(["confirmed/weak_agree"]);
    expect(b[0].encounter_id).toBe(e0.encounter_id);
    expect(b[0].boundary_rev).toBe(0);
  });
});

describe("enqueue plan: confirmed_single_proxy is shadow only, sp: keyed", () => {
  const row = (status: string, flags: string[] = []) => ({ encounter_id: "enc_testaaaaaaaaaaaa", status, boundary_rev: 0, flags, t_close: 0 });
  const ALL: Array<[Mode, Mode]> = (["off", "shadow", "live"] as Mode[]).flatMap((j) => (["off", "shadow", "live"] as Mode[]).map((m) => [j, m] as [Mode, Mode]));
  it("stages: the confirmed set; no freescript when ambiguous; frozen none; nothing inside the close grace", () => {
    expect(stagesFor(row("confirmed_single_proxy"), CLOSE_GRACE_MS)).toEqual(["recut", "acoustics", "nemotron", "collector", "freescript"]);
    expect(stagesFor(row("confirmed_single_proxy", ["ambiguous"]), CLOSE_GRACE_MS)).toEqual(["recut", "acoustics", "nemotron", "collector"]);
    expect(stagesFor(row("confirmed_single_proxy", ["frozen"]), CLOSE_GRACE_MS)).toEqual([]);
    expect(stagesFor(row("confirmed_single_proxy"), CLOSE_GRACE_MS - 1)).toEqual([]);
  });
  it("every jobs x mode.<stage> config (including live): status shadow, input_key sp:<hash>; confirmed keeps queued under live", () => {
    for (const [jobs, mode] of ALL) {
      const modes = effectiveModes(jobs, Object.fromEntries(FREE_STAGES.map((st) => [st, mode])));
      const sp = planJobs([row("confirmed_single_proxy")], modes, CLOSE_GRACE_MS);
      for (const p of sp) { expect(p.status).toBe("shadow"); expect(p.input_key).toBe(SP_PREFIX + inputKey(p.stage)); }
      expect(sp.length).toBe(jobs === "off" || mode === "off" ? 0 : 5);
      const c = planJobs([row("confirmed")], modes, CLOSE_GRACE_MS);
      for (const p of c) { expect(p.input_key).toBe(inputKey(p.stage)); expect(p.status).toBe(jobs === "live" && mode === "live" ? "queued" : "shadow"); }
    }
  });
});
