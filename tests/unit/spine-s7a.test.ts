/**
 * spine-s7a.test.ts — SPINE S7a pure logic and the O4 guard: the window outcomes, the ready / wait / fail decision, the assembly, the event shape, which encounters get the stage, and that no paid or Sarvam call is reachable.
 * Synthetic ids; placeholder words only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { assemble, buildEvent, decide, eligibleAt, MAX_OFFERS_PER_PASS, MAX_WAIT_MS, outcomeOf, pickWindows, type CoveringWindow, type RunText } from "@/lib/spine/transcript-final";
import { ineligible } from "@/lib/spine/transcript-final-store";
import { CLOSE_GRACE_MS, FREE_STAGES, effectiveModes, planJobs, stagesFor, type EncounterRow } from "@/lib/spine/enqueue";
import { KNOWN_STAGES, PAID_STAGES, SERVER_STAGES, modesFrom } from "@/lib/spine/config";

const MIN = 60_000;
const T0 = Date.parse("2026-10-18T04:00:00Z");
const T_CLOSE = T0 + 20 * MIN;
const w = (o: Partial<CoveringWindow> & { id: string }): CoveringWindow => ({
  start_ms: T0, end_ms: T0 + 15 * MIN, source_mic: "primary", state: "transcribed", run_id: `run_${o.id}`, run_at_ms: T0 + 60 * MIN, closed_at_ms: T0, refused_at_ms: null, refused_reason: null, job_open: false, ...o,
});
const NOW = eligibleAt(T_CLOSE) + MIN;
const dec = (windows: CoveringWindow[], o: Partial<Parameters<typeof decide>[0]> = {}) => decide({ windows, blindExcluded: 0, now: NOW, tCloseMs: T_CLOSE, drainOn: true, cooldownMs: 3_600_000, ...o });

describe("outcomeOf", () => {
  it("transcribed needs the state AND a stored run; silent; failed = refused; permanent refusal = refused; the rest pending", () => {
    expect(outcomeOf(w({ id: "a" }))).toBe("transcribed");
    expect(outcomeOf(w({ id: "a", run_id: null }))).toBe("pending");            // 'transcribed' with no run: we never looked
    expect(outcomeOf(w({ id: "a", state: "silent", run_id: null }))).toBe("silent");
    expect(outcomeOf(w({ id: "a", state: "failed", run_id: null }))).toBe("refused");
    for (const s of ["closed", "open", "transcribing"]) expect(outcomeOf(w({ id: "a", state: s, run_id: null }))).toBe("pending");
    expect(outcomeOf(w({ id: "a", state: "closed", run_id: null, refused_reason: "too_long#2" }))).toBe("refused");
    expect(outcomeOf(w({ id: "a", state: "closed", run_id: null, refused_reason: "flag_off" }))).toBe("pending");
  });
});

describe("pickWindows", () => {
  it("one window per span (primary mic wins), ordered by start", () => {
    const p = pickWindows([w({ id: "b2", start_ms: T0 + 15 * MIN, end_ms: T0 + 30 * MIN }), w({ id: "a2", source_mic: "backup" }), w({ id: "a1" }), w({ id: "b1", start_ms: T0 + 15 * MIN, end_ms: T0 + 30 * MIN, source_mic: "backup" })]);
    expect(p.map((x) => x.id)).toEqual(["a1", "b2"]);
  });
});

describe("decide", () => {
  it("ready when every covering window is terminal; counts and the ready stamp (clamped to now)", () => {
    const r = dec([w({ id: "a", run_at_ms: T0 + 30 * MIN }), w({ id: "b", start_ms: T0 + 15 * MIN, end_ms: T0 + 30 * MIN, state: "silent", run_id: null, run_at_ms: null, closed_at_ms: T0 + 33 * MIN }), w({ id: "c", start_ms: T0 + 30 * MIN, end_ms: T0 + 45 * MIN, state: "failed", run_id: null, run_at_ms: null, closed_at_ms: T0 + 10 * MIN })]);
    expect(r).toMatchObject({ kind: "ready", counts: { covering: 3, transcribed: 1, silent: 1, refused: 1, pending: 0 }, windows_ready_at: T0 + 33 * MIN, run_ids: ["run_a"], window_ids: ["a", "b", "c"] });
    const future = dec([w({ id: "a", run_at_ms: NOW + 10 * MIN })]);
    expect(future).toMatchObject({ kind: "ready", windows_ready_at: NOW });
  });
  it("waits while any window is pending, and offers only closed, idle, not-recently-refused windows, capped", () => {
    const ws = [w({ id: "a" }), ...[1, 2, 3, 4, 5].map((i) => w({ id: `p${i}`, start_ms: T0 + i * 15 * MIN, end_ms: T0 + (i + 1) * 15 * MIN, state: "closed", run_id: null }))];
    ws[2] = { ...ws[2], job_open: true }; ws[1] = { ...ws[1], refused_at_ms: NOW - MIN, refused_reason: "flag_off" }; ws[3] = { ...ws[3], state: "transcribing" };
    const r = dec(ws);
    expect(r.kind).toBe("wait");
    expect((r as { offers: string[] }).offers).toEqual(["p4", "p5"]);
    expect(MAX_OFFERS_PER_PASS).toBe(2);
    expect((r as { counts: { pending: number } }).counts.pending).toBe(5);
    // an old refusal (outside the cooldown) may be offered again
    expect((dec([w({ id: "p", state: "closed", run_id: null, refused_at_ms: NOW - 2 * 3_600_000, refused_reason: "flag_off" })]) as { offers: string[] }).offers).toEqual(["p"]);
  });
  it("drain off: waits and offers nothing", () => {
    expect(dec([w({ id: "p", state: "closed", run_id: null })], { drainOn: false })).toMatchObject({ kind: "wait", offers: [] });
  });
  it("fails past eligibleAt + MAX_WAIT (windows_not_ready / no_covering_windows), and not one ms earlier", () => {
    const deadline = eligibleAt(T_CLOSE) + MAX_WAIT_MS;
    const pend = [w({ id: "p", state: "closed", run_id: null })];
    expect(dec(pend, { now: deadline - 1 }).kind).toBe("wait");
    expect(dec(pend, { now: deadline })).toMatchObject({ kind: "fail", reason: "windows_not_ready" });
    expect(dec([], { now: deadline - 1 }).kind).toBe("wait");
    expect(dec([], { now: deadline })).toMatchObject({ kind: "fail", reason: "no_covering_windows" });
    expect(eligibleAt(T_CLOSE)).toBe(T_CLOSE + CLOSE_GRACE_MS);
  });
  it("blind windows are only counted", () => {
    expect(dec([w({ id: "a" })], { blindExcluded: 3 })).toMatchObject({ kind: "ready", counts: { blind_excluded: 3, covering: 1 } });
  });
});

describe("assemble and buildEvent", () => {
  const run = (id: string, o: Partial<RunText> = {}): RunText => ({ run_id: id, window_id: id, engine: "route", original: `native ${id}`, english: `english ${id}`, ...o });
  it("orders by the window order given, joins native and English, and the sha moves with any text", () => {
    const a = assemble(["r2", "r1"], [run("r1"), run("r2")]);
    expect(a.native).toBe("native r2\nnative r1");
    expect(a.english).toBe("english r2\nenglish r1");
    expect(a.run_ids).toEqual(["r2", "r1"]);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(assemble(["r2", "r1"], [run("r1", { original: "changed" }), run("r2")]).sha256).not.toBe(a.sha256);
    expect(assemble(["r1"], [run("r1", { english: null })])).toMatchObject({ english: null, english_chars: 0, has_english: false });
  });
  it("O4: a run of Sarvam or any engine but route throws; a missing run throws", () => {
    for (const engine of ["sarvam", "sarvam-saaras", "whisper", "gemini"]) expect(() => assemble(["r1"], [run("r1", { engine })])).toThrow("o4_non_route_run");
    expect(() => assemble(["r1"], [])).toThrow("run_text_missing");
  });
  it("the event carries stamps, counts, ids and a sha; never the text", () => {
    const ready = dec([w({ id: "a" })]) as Extract<ReturnType<typeof decide>, { kind: "ready" }>;
    const ev = buildEvent({ mode: "live", encounter_id: "enc_aaaaaaaaaaaaaaaa", boundary_rev: 3, room_id: "room_abcd2345", ist_date: "2026-10-18", tCloseMs: T_CLOSE, enqueuedAtMs: T_CLOSE + 16 * MIN, now: NOW, ready, text: assemble(["run_a"], [run("run_a")]) });
    expect(ev).toMatchObject({ event: "encounter.transcript_final", cut_version: "r3", engine: "route", stamps: { t_close: new Date(T_CLOSE).toISOString(), final_at: new Date(NOW).toISOString() }, text: { ref: "transcription_run:run_a" } });
    expect(JSON.stringify(ev)).not.toContain("native run_a");
  });
});

describe("which encounters get the stage", () => {
  const e = (status: string, flags: string[] = [], t_close: number | null = T_CLOSE): EncounterRow => ({ encounter_id: "enc_aaaaaaaaaaaaaaaa", status, boundary_rev: 2, flags, t_close });
  const after = T_CLOSE + CLOSE_GRACE_MS;
  it("confirmed only (an ambiguous confirmed still gets it); never candidate, single_proxy, merged, rejected, frozen; not inside the grace", () => {
    expect(stagesFor(e("confirmed"), after)).toContain("transcript_final");
    expect(stagesFor(e("confirmed", ["ambiguous"]), after)).toContain("transcript_final");
    for (const s of ["candidate", "confirmed_single_proxy", "merged", "rejected"]) expect(stagesFor(e(s), after)).not.toContain("transcript_final");
    expect(stagesFor(e("confirmed", ["frozen"]), after)).toEqual([]);
    expect(stagesFor(e("confirmed"), after - 1)).toEqual([]);
    expect(stagesFor(e("confirmed", [], null), after)).toEqual([]);
  });
  it("job key: cut_version r<boundary_rev>, free stage, never paid", () => {
    const modes = effectiveModes("live", { transcript_final: "live" });
    const j = planJobs([e("confirmed")], modes, after);
    expect(j).toMatchObject([{ stage: "transcript_final", cut_version: "r2", status: "queued" }]);
    expect(FREE_STAGES).toContain("transcript_final");
    expect(PAID_STAGES).not.toContain("transcript_final");
    expect(KNOWN_STAGES).toContain("transcript_final");
    expect(planJobs([e("confirmed_single_proxy")], modes, after)).toEqual([]);
  });
  it("a missing or malformed mode is off", () => {
    expect(modesFrom([{ key: "jobs", value: "live" }], ["transcript_final"]).stages.transcript_final).toBe("off");
    expect(modesFrom([{ key: "jobs", value: "live" }, { key: "mode.transcript_final", value: "yes" }], ["transcript_final"]).stages.transcript_final).toBe("off");
    expect(modesFrom([{ key: "jobs", value: "live" }, { key: "mode.transcript_final", value: "live" }, { key: "kill_switch", value: { on: true } }], ["transcript_final"]).stages.transcript_final).toBe("off");
  });
  it("the box never runs it: SERVER_STAGES", () => { expect(SERVER_STAGES).toEqual(["transcript_final"]); });
});

describe("ineligible (checked again at execution)", () => {
  const e = (o: Partial<Parameters<typeof ineligible>[0]> = {}) => ({ encounter_id: "enc_aaaaaaaaaaaaaaaa", status: "confirmed", boundary_rev: 1, cut_version: "r1", flags: [], room_id: "room_abcd2345", ist_date: "2026-10-18", t_open: T0, t_close: T_CLOSE, enqueued_at: T0, ...o });
  it("only a confirmed, current, unfrozen, closed encounter", () => {
    expect(ineligible(e())).toBeNull();
    expect(ineligible(e({ status: "candidate" }))).toBe("not_confirmed");
    expect(ineligible(e({ status: "confirmed_single_proxy" }))).toBe("not_confirmed");
    expect(ineligible(e({ cut_version: "r0" }))).toBe("stale_cut");
    expect(ineligible(e({ flags: ["frozen"] }))).toBe("frozen");
    expect(ineligible(e({ t_close: null }))).toBe("not_closed");
  });
});

describe("O4: no Sarvam or paid call is reachable from the S7a modules", () => {
  const files = ["lib/spine/transcript-final.ts", "lib/spine/transcript-final-store.ts", "lib/spine/transcript-final-read.ts", "lib/room-access/readers/spine-transcript.ts", "app/api/spine/transcript-final/route.ts"];
  const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  it("imports no engine adapter, Sarvam, llm-roles or CLEF module; the only transcription entry is drainRoomWindow", () => {
    for (const f of files) {
      const imports = [...code(f).matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/sarvam|llm-roles|clef|adapters|gemini|bedrock|openrouter|stt\/engines|stt\/transcribe/i);
    }
    const store = code("lib/spine/transcript-final-store.ts");
    expect(store).toContain("drainRoomWindow");
    expect(store).not.toMatch(/submitJob|transcribe\(|fetch\(/);
  });
  it("the room reader takes only route runs", () => {
    const r = readFileSync("lib/room-access/readers/spine-transcript.ts", "utf8");
    expect(r).toContain("engine = ${FINAL_ENGINE}");
  });
});
