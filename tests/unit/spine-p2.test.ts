/** SPINE-P2 pure parts: acoustic is optional in mergeSignals, the enqueue plan, attrs lifting, the merge gate parser. SQL is proven in spine-p2-pg.test.ts. */
import { describe, it, expect } from "vitest";
import { mergeSignals } from "@/lib/spine/merge";
import { liftAttrs } from "@/lib/spine/merge-store";
import { parseMergeMode } from "@/lib/spine/config";
import { CLOSE_GRACE_MS, effectiveModes, planJobs, stagesFor, FREE_STAGES } from "@/lib/spine/enqueue";
import type { SpineSignal } from "@/lib/spine/types";

const T = Date.parse("2026-10-18T04:00:00Z");
const NOW = T + 6 * 3_600_000;
const min = (n: number) => T + n * 60_000;
const s = (proxy: SpineSignal["proxy"], key: string, o: number, c: number, attrs: Record<string, unknown> = {}): SpineSignal =>
  ({ proxy, source_key: key, source_rev: 1, room_id: "room_abcd2345", t_open: min(o), t_close: min(c), attrs });
const empty = { encounters: [], links: [] };
const view = (r: ReturnType<typeof mergeSignals>) => r.encounters.map((e) => ({ id: e.encounter_id, status: e.status, reason: e.reason, flags: e.flags, o: e.t_open, c: e.t_close, rev: e.boundary_rev }));

const base = [
  s("pulse", "ka@m1", 0, 10, { consult_key: "ka@m1", consult_uid: "ka", close_reason: "endConsult" }),
  s("timeline", "ka@m1", 0, 9, { consult_key: "ka@m1", close_reason: "patient_left" }),
  s("pulse", "kb@m1", 30, 45, { consult_key: "kb@m1", consult_uid: "kb", close_reason: "idle_timeout" }),
  s("timeline", "kb@m1", 30, 44, { consult_key: "kb@m1", close_reason: "patient_left" }),
];
const acoustic = [s("acoustic", "rd:a1", 0, 10, { close_reason: "non_speech" }), s("acoustic", "rd:a2", 30, 45, { close_reason: "non_speech" })];

describe("acoustic is optional (fable ruling 22 Oct)", () => {
  it("pulse + timeline merged with and without acoustic: identical encounters, ids, statuses, flags", () => {
    const without = mergeSignals(base, "t", empty, NOW);
    const withA = mergeSignals([...base, ...acoustic], "t", empty, NOW);
    expect(view(withA)).toEqual(view(without));
    expect(without.encounters.every((e) => e.status === "confirmed")).toBe(true);
    expect(without.encounters.every((e) => e.flags.length === 0)).toBe(true);
  });
  it("acoustic added later only adds evidence: a timeline-only confirmed_single_proxy gets confirmed, never the reverse", () => {
    const tl = [s("timeline", "kc@m1", 60, 70, { consult_key: "kc@m1" })];
    const before = mergeSignals(tl, "t", empty, NOW);
    expect(before.encounters[0].status).toBe("confirmed_single_proxy");   // RULING B (22 Oct): timeline-only is its own status, never `confirmed`
    const after = mergeSignals([...tl, s("acoustic", "rd:a3", 60, 70)], "t", { encounters: [], links: [] }, NOW);
    expect(after.encounters[0].status).toBe("confirmed");
    expect(after.encounters[0].reason).toBe("weak_agree");
  });
  it("a strong-anchored day never depends on acoustic: pulse alone, pulse+acoustic and pulse+timeline+acoustic are all confirmed", () => {
    for (const extra of [[], [acoustic[0]], [base[1], acoustic[0]]]) {
      const r = mergeSignals([base[0], ...extra], "t", empty, NOW);
      expect(r.encounters.map((e) => e.status)).toEqual(["confirmed"]);
    }
  });
});

describe("liftAttrs", () => {
  it("lifts ids.consult_key / consult_uid to the top level (stored attrs keep them under ids); pulse_enc_id stays in ids", () => {
    const a = liftAttrs({ ids: { consult_key: "ka@m1", consult_uid: "ka", pulse_enc_id: "p1" }, close_reason: "endConsult" });
    expect(a).toMatchObject({ consult_key: "ka@m1", consult_uid: "ka", close_reason: "endConsult", ids: { pulse_enc_id: "p1" } });
  });
  it("with lifted attrs a pulse and its timeline share the consult_key", () => {
    const stored = (proxy: SpineSignal["proxy"], o: number, c: number) => ({ ...s(proxy, "ka@m1", o, c), attrs: liftAttrs({ ids: { consult_key: "ka@m1" } }) });
    const r = mergeSignals([stored("pulse", 0, 10), stored("timeline", 1, 9)], "t", empty, NOW);
    expect(r.links.filter((l) => l.key_kind === "consult_key")).toHaveLength(1);
  });
});

describe("parseMergeMode", () => {
  it("missing, malformed, unknown -> off; kill_switch wins", () => {
    expect(parseMergeMode([])).toBe("off");
    expect(parseMergeMode([{ key: "merge", value: "on" }])).toBe("off");
    expect(parseMergeMode([{ key: "merge", value: '"shadow"' }])).toBe("shadow");
    expect(parseMergeMode([{ key: "merge", value: { mode: "live" } }])).toBe("live");
    expect(parseMergeMode([{ key: "merge", value: "shadow" }, { key: "kill_switch", value: "true" }])).toBe("off");
  });
});

describe("enqueue plan", () => {
  const e = (status: string, flags: string[] = [], close: number | null = T) => ({ encounter_id: "enc_aaaaaaaaaaaaaaaa", status, boundary_rev: 0, flags, t_close: close });
  const after = T + CLOSE_GRACE_MS;
  it("candidate: free engines only; confirmed adds collector + freescript; ambiguous never freescript", () => {
    expect(stagesFor(e("candidate"), after)).toEqual(["recut", "acoustics", "nemotron"]);
    expect(stagesFor(e("confirmed"), after)).toEqual(["recut", "acoustics", "nemotron", "collector", "freescript"]);
    expect(stagesFor(e("confirmed", ["ambiguous"]), after)).toEqual(["recut", "acoustics", "nemotron", "collector"]);
  });
  it("nothing for rejected, merged, frozen, open, or inside the 15 min grace", () => {
    for (const x of [e("rejected"), e("merged"), e("confirmed", ["frozen"]), e("confirmed", [], null)]) expect(stagesFor(x, after)).toEqual([]);
    expect(stagesFor(e("confirmed"), after - 1)).toEqual([]);
  });
  it("no paid stage is ever planned, whatever the modes say; jobs=shadow caps live at shadow; a missing mode is off", () => {
    const all = Object.fromEntries(["recut", "acoustics", "nemotron", "collector", "freescript", "sarvam", "gapfill", "role", "llm-roles", "parts"].map((k) => [k, "live" as const]));
    const m = effectiveModes("shadow", all);
    expect(Object.keys(m).sort()).toEqual([...FREE_STAGES].sort());
    expect(Object.values(m).every((x) => x === "shadow")).toBe(true);
    const jobs = planJobs([e("confirmed")], effectiveModes("live", all), after);
    expect(jobs.map((j) => j.stage)).toEqual(["recut", "acoustics", "nemotron", "collector", "freescript"]);
    expect(jobs.every((j) => j.status === "queued")).toBe(true);
    expect(planJobs([e("confirmed")], effectiveModes("shadow", {}), after)).toEqual([]);
    expect(effectiveModes("off", all).recut).toBe("off");
  });
  it("job keys are stable and carry cut_version r<boundary_rev>", () => {
    const a = planJobs([e("confirmed")], effectiveModes("shadow", { recut: "shadow" }), after);
    const b = planJobs([{ ...e("confirmed"), boundary_rev: 2 }], effectiveModes("shadow", { recut: "shadow" }), after);
    expect(a[0]).toMatchObject({ stage: "recut", cut_version: "r0", status: "shadow" });
    expect(a[0].input_key).toBe(b[0].input_key);
    expect(b[0].cut_version).toBe("r2");
  });
});
