/**
 * mcp-timbre.test.ts — scribe_timbre (Timbre T-15, Architecture #85). The SQL is faked; all ids are fake.
 * Covers: every profile lists it (ruling 11 Oct: no lab gate), app connection only (never @/lib/brain/db), each selector and
 * the zero / multiple selector refusals, unscorable windows (reason, null A/V, never neutral), 0-scorable consult (null medians),
 * blind room-days, a response schema with no audio/url/text/name field, withheld cells under 5, no ranking option, raw as the
 * default with calibrated labelled display-only, and the caveats (test 11 included) in help and in every answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ calls: [] as Array<{ text: string; params: unknown[] }>, respond: (_t: string, _p: unknown[]): Row[] => [], blind: new Set<string>() }));
vi.mock("@/lib/db", () => {
  const fn = (strings: TemplateStringsArray | string, ...rest: unknown[]) => {
    const text = typeof strings === "string" ? strings : strings.join("$?");
    const params = typeof strings === "string" ? ((rest[0] as unknown[]) ?? []) : rest;
    H.calls.push({ text, params });
    return Promise.resolve(H.respond(text, params));
  };
  return { sql: fn };
});
vi.mock("@/lib/rubrics/blind-room-days", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), isBlindRoomDay: (d: string, r: string) => H.blind.has(`${d}|${r}`) }));

import { timbreRead, timbreTool, TIMBRE_CAVEATS, parseSelector } from "@/lib/mcp/tools/timbre";
import { listedTool, toolsForProfile } from "@/lib/mcp/profile";
import { CALLABLE_TOOLS, LAB_TOOLS, PUBLISHED_TOOLS } from "@/lib/mcp/surface";

const consult = (over: Row = {}): Row => ({
  run_id: 7, consult_uid: "enc_fake_1", cut_version: "sig:x", encounter_consult_key: "enc_fake_1@m", room_id: "room_fake", room_slug: "opd-fake",
  ist_date: "2026-10-01", doctor_uid8: "docFAKE1", n_windows: 3, n_scorable: 2, scorable_pct: 66.6667,
  arousal_raw_median: 0.41, valence_raw_median: 2.9, arousal_median: 3.2, valence_median: 3.0,
  arousal_raw_open: 0.4, arousal_raw_mid: null, arousal_raw_close: 0.42, valence_raw_open: 2.8, valence_raw_mid: null, valence_raw_close: 3.0,
  arousal_open: 3.1, arousal_mid: null, arousal_close: 3.3, valence_open: 2.9, valence_mid: null, valence_close: 3.1,
  n_no_voiceprint: 1, n_no_patient: 0, n_low_purity: 0, n_short_pure_speech: 0, n_low_patient_cosine: 0, n_overlap: 0, n_too_short: 0,
  n_attender_speaks_for_patient: 0, n_model_error: 0, pipeline_version: "timbre-v1", git_sha: "a".repeat(40), calibration_arousal_id: 1, calibration_valence_id: 2,
  text_lane_on: false, ...over,
});
const windows: Row[] = [
  { start_ms: 1000, end_ms: 6000, abs_start_ms: 1_790_000_001_000, abs_end_ms: 1_790_000_006_000, scorable: true, unscorable_reason: null, arousal_raw: 0.4, valence_raw: 2.8, arousal_calibrated: 3.1, valence_calibrated: 2.9, arousal_calibration_level: "room", valence_calibration_level: "room", arousal_model: "odyssey", purity: 0.9, pure_patient_s: 4 },
  { start_ms: 9000, end_ms: 12000, abs_start_ms: 1_790_000_009_000, abs_end_ms: 1_790_000_012_000, scorable: false, unscorable_reason: "no_voiceprint", arousal_raw: null, valence_raw: null, arousal_calibrated: null, valence_calibrated: null, purity: null, pure_patient_s: null },
];
const cell = (n_scorable: number): Row => ({ month: "2026-10", n_consults: 2, n_windows: 9, n_scorable, arousal_raw_median: 0.4, valence_raw_median: 2.9, arousal_cal_median: 3, valence_cal_median: 3 });

beforeEach(() => {
  H.calls = [];
  H.blind = new Set();
  H.respond = (t) => (/FROM affect_window\s/.test(t) && !/percentile_cont/.test(t) ? windows : /percentile_cont/.test(t) ? [cell(7)] : [consult()]);
});

const keysDeep = (o: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(o)) o.forEach((x) => keysDeep(x, out));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.add(k); keysDeep(v, out); }
  return out;
};

describe("registration", () => {
  it("is published once, read scope, listed for every profile with a short brief", () => {
    expect(PUBLISHED_TOOLS.filter((t) => t.name === "scribe_timbre")).toHaveLength(1);
    expect(PUBLISHED_TOOLS.map((t) => t.name).filter((n) => n === "scribe_timbre")).toHaveLength(1);
    expect(PUBLISHED_TOOLS[PUBLISHED_TOOLS.length - 1]!.name).toBe("scribe_encounter_timeline"); // appended after timbre, never inserted
    expect(CALLABLE_TOOLS.get("scribe_timbre")!.scope).toBe("read");
    expect(LAB_TOOLS.some((t) => t.name === "scribe_timbre")).toBe(true);
    for (const p of ["operator", "lab"] as const) expect(toolsForProfile(p).map((t) => t.name)).toContain("scribe_timbre");
    const listed = listedTool("scribe_timbre")!;
    expect(listed.description.length).toBeLessThanOrEqual(200);
    expect(listed.description).toMatch(/Raw=default for trends; calibrated=display-only 1-5/);
    expect(listed.description).toMatch(/Not a surgery predictor/);
  });
  it("reads through the app connection, never brain_svc", () => {
    const src = readFileSync("lib/mcp/tools/timbre.ts", "utf8");
    expect(src).toMatch(/from "@\/lib\/db"/);
    expect(src).not.toMatch(/^import[^;]*@\/lib\/brain\/db/m);
    expect(src).not.toMatch(/^import[^;]*brain/m);
  });
  it("help carries every caveat, test 11 and the raw/calibrated rule", () => {
    const help = listedTool("scribe_timbre")!.help ?? timbreTool.description;
    for (const c of TIMBRE_CAVEATS) expect(help).toContain(c);
    expect(help).toMatch(/Test 11 \(pre-registered\) found Timbre does NOT predict surgery booking/);
    expect(help).toMatch(/Spearman 0\.50-0\.58/);
    expect(help).toMatch(/display-only 1-5/);
  });
  it("has no ranking / sort option", () => {
    const props = Object.keys((timbreTool.inputSchema.properties ?? {}) as Row);
    for (const bad of ["sort", "order", "order_by", "rank", "top", "bottom", "percentile"]) expect(props).not.toContain(bad);
    expect(timbreTool.inputSchema.additionalProperties).toBe(false);
  });
});

describe("selectors", () => {
  it("refuses zero or multiple selectors", async () => {
    expect(await timbreRead({})).toMatchObject({ ok: false, error: "bad_args" });
    expect(await timbreRead({ encounter_id: "enc_fake_1", room: "opd-fake", date: "2026-10-01" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(await timbreRead({ room: "opd-fake" })).toMatchObject({ ok: false, error: "bad_args" });
    expect(parseSelector({ doctor_uid8: "docFAKE1", date_from: "2026-01-01", date_to: "2026-06-01" })).toMatchObject({ ok: false });
    expect(parseSelector({ doctor_uid8: "docFAKE1", date_from: "2026-02-30", date_to: "2026-03-01" })).toMatchObject({ ok: false });
    expect(H.calls).toHaveLength(0);
  });
  it("encounter_id: consult + windows by default, matched on consult_uid or encounter key", async () => {
    const out = await timbreRead({ encounter_id: "enc_fake_1" });
    expect(out).toMatchObject({ ok: true, selector: "encounter", n_consults: 1 });
    expect(H.calls[0]!.text).toMatch(/FROM affect_consult_latest/);
    expect(H.calls[0]!.text).toMatch(/consult_uid = \$1 OR encounter_consult_key = \$1/);
    const c = (out.consults as Row[])[0]!;
    expect((c.windows as Row[]).length).toBe(2);
  });
  it("room + date: consults without windows by default, plus a room-day cell", async () => {
    const out = await timbreRead({ room: "opd-fake", date: "2026-10-01" });
    expect(out).toMatchObject({ ok: true, selector: "room_day" });
    expect((out.consults as Row[])[0]!.windows).toBeUndefined();
    expect(out.aggregate).toMatchObject({ withheld: false, raw: { arousal_median: 0.4, valence_median: 2.9 } });
  });
  it("doctor_uid8 + range: monthly cells, research-only note, never a ranking", async () => {
    const out = await timbreRead({ doctor_uid8: "docFAKE1", date_from: "2026-09-01", date_to: "2026-10-31" });
    expect(out).toMatchObject({ ok: true, selector: "doctor" });
    expect(out.aggregate_note).toMatch(/never a ranking/);
    expect((out.aggregates_monthly as Row[])[0]).toMatchObject({ doctor_uid8: "docFAKE1", month: "2026-10" });
    for (const c of H.calls) expect(c.text.replace(/WITHIN GROUP \(ORDER BY [^)]*\)/g, "")).not.toMatch(/ORDER BY[^;]*(median|valence|arousal)/i);
  });
});

describe("answers", () => {
  it("an unscorable window has a reason and null A/V, never neutral", async () => {
    const out = await timbreRead({ encounter_id: "enc_fake_1" });
    const w = ((out.consults as Row[])[0]!.windows as Row[])[1]!;
    expect(w).toMatchObject({ scorable: false, reason: "no_voiceprint", arousal_raw: null, valence_raw: null, arousal_calibrated: null, valence_calibrated: null });
    expect(JSON.stringify(out)).not.toMatch(/neutral"/);
  });
  it("a 0-scorable consult is unscorable with null medians", async () => {
    H.respond = (t) => (/FROM affect_window\s/.test(t) ? [] : [consult({ n_scorable: 0, scorable_pct: 0, n_no_voiceprint: 3, arousal_raw_median: null, valence_raw_median: null, arousal_median: null, valence_median: null, arousal_raw_open: null, arousal_raw_close: null, valence_raw_open: null, valence_raw_close: null, arousal_open: null, arousal_close: null, valence_open: null, valence_close: null })]);
    const c = ((await timbreRead({ encounter_id: "enc_fake_1" })).consults as Row[])[0]!;
    expect(c.status).toBe("unscorable");
    expect(c.raw).toMatchObject({ arousal_median: null, valence_median: null });
    expect(c.calibrated_display_only).toMatchObject({ arousal_median: null, valence_median: null });
  });
  it("raw is the default block; calibrated is labelled display-only", async () => {
    const c = ((await timbreRead({ encounter_id: "enc_fake_1" })).consults as Row[])[0]!;
    expect(c.raw).toMatchObject({ arousal_median: 0.41, valence_median: 2.9 });
    expect(c.calibrated_display_only).toMatchObject({ arousal_median: 3.2, valence_median: 3.0 });
    expect(Object.keys(c)).not.toContain("calibrated");
  });
  it("cells under 5 scorable windows are withheld (counted, no scores)", async () => {
    H.respond = (t) => (/percentile_cont/.test(t) ? [cell(4)] : [consult()]);
    const out = await timbreRead({ room: "opd-fake", date: "2026-10-01" });
    expect(out.aggregate).toMatchObject({ withheld: true, n_scorable: 4, raw: null, calibrated_display_only: null });
  });
  it("a blind room-day is refused and never named", async () => {
    H.blind.add("2026-10-01|room_fake");
    const out = await timbreRead({ encounter_id: "enc_fake_1" });
    expect(out).toEqual({ ok: false, error: "blind_room_day" });
    const dr = await timbreRead({ doctor_uid8: "docFAKE1", date_from: "2026-09-01", date_to: "2026-10-31" });
    expect(dr).toMatchObject({ ok: true, withheld_blind_consults: 1, consults: [] });
  });
  it("no audio / url / text / name / identifier field anywhere; caveats in every answer", async () => {
    for (const args of [{ encounter_id: "enc_fake_1" }, { room: "opd-fake", date: "2026-10-01", include_windows: true }, { doctor_uid8: "docFAKE1", date_from: "2026-09-01", date_to: "2026-10-01" }]) {
      const out = await timbreRead(args);
      const keys = [...keysDeep(out)];
      for (const k of keys) expect(k, k).not.toMatch(/audio|url|r2|presign|transcript|^text$|name|patient_id|phone|clinician_id/i);
      expect(out.caveats).toEqual([...TIMBRE_CAVEATS]);
      expect(out.scale_note).toMatch(/raw = default.*calibrated = display-only 1-5/);
    }
  });
  it("a DB error is db_error:<sqlstate>", async () => {
    H.respond = () => { throw Object.assign(new Error("permission denied"), { code: "42501" }); };
    expect(await timbreRead({ encounter_id: "enc_fake_1" })).toEqual({ ok: false, error: "db_error:42501" });
  });
});
