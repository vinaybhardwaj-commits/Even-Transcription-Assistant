/**
 * S7-1 — the llm_zdr engine and the two consult rubrics, with a FAKE model client. No network, no key, no database content; nothing here calls a model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: string[] = [];
let consultRows: Array<Record<string, unknown>> = [];
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray) => {
    const q = strings.join("?");
    queries.push(q);
    return /FROM eta_encounter_windows/.test(q) && /AS ist_date/.test(q) ? consultRows : [];
  },
}));
const store = new Map<string, string>();
vi.mock("@/lib/sarvam-lab", async (orig) => ({ ...(await orig<typeof import("@/lib/sarvam-lab")>()), labStore: () => ({ get: async (k: string) => (store.has(k) ? { body: store.get(k)!, etag: null } : null), put: async () => "ok", list: async () => [] }) }));

const L = await import("@/lib/rubrics/llm");
const V = await import("@/lib/rubrics/schema");
const E = await import("@/lib/rubrics/engines/consult-llm");
const { evaluateUnit } = await import("@/lib/rubrics/engines");
const { getRubric, canRun, RUBRIC_PROMPTS } = await import("@/lib/rubrics/registry");
const { OpenRouterError } = await import("@/lib/openrouter");
const { parseBenchSet, compareItem } = await import("@/lib/rubrics/bench");

const affect = getRubric("consult_chair_affect")!;
const pitch = getRubric("consult_surgical_pitch")!;
const text = (lines: Array<[number, "doctor" | "other" | "unknown", string]>) => {
  const ls = lines.map(([t_s, speaker, t]) => ({ t_ms: t_s * 1000, speaker, speaker_idx: speaker === "unknown" ? null : speaker === "doctor" ? 0 : 1, text: t }));
  const turns = ls.map((l, i) => ({ source_ref: `s${i}`, start_ms: l.t_ms, end_ms: l.t_ms + 8000, speaker_idx: l.speaker_idx, role: l.speaker === "doctor" ? "clinician" : null, overlap_ms: null }));
  return { consult_key: "k", source: "bench_text" as const, span_ms: 120_000, lines: ls, chars: ls.reduce((n, l) => n + l.text.length, 0), truncated: false, turns } as never;
};
const T = text([[5, "doctor", "Your scan shows a small stone."], [20, "other", "Will it need an operation?"], [40, "doctor", "I would advise surgery, a laser removal, in two weeks."], [70, "other", "Okay doctor."]]);

const answer = (o: unknown) => ({ content: JSON.stringify(o), model: "fake/model", latency_ms: 1 });
const AFFECT_OK = { scorable: true, distress: "low", confusion: "low", frustration: "low", reassurance: "medium", teach_back: "none",
  recommendations: [{ uptake: ["accept"], resolution_type: "patient_agrees", quote: "Okay doctor.", t_s: 999 }],
  cases_lite: { engagement_process: "present", information_present: true, doctor_effect_proxy: "load_eased", dominant_mix: "mixed" },
  evidence: [{ item: "distress", quote: "Will it need an operation?", t_s: 1 }, { item: "reassurance", quote: "a sentence the doctor never said" }] };

beforeEach(() => { queries.length = 0; store.clear(); consultRows = []; L.setRubricChatForTests(null); });

describe("the schema subset", () => {
  it("type lists, enums, required, extra keys, bounds, items: problems carry a path and never a value", () => {
    const s = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { enum: ["x", "y"] }, n: { type: ["number", "null"], minimum: 0, maximum: 1 }, l: { type: "array", maxItems: 1, items: { type: "string", maxLength: 2 } } } };
    expect(V.validateAgainst(s, { a: "x", n: null, l: ["ab"] })).toEqual([]);
    expect(V.validateAgainst(s, { a: "zzz", n: 2, l: ["abc", "d"], extra: 1 }).join("|")).toMatch(/\$\.a: not in enum.*\$\.n: above maximum.*\$\.l: too many.*too long.*\$\.extra: not allowed/);
    expect(V.validateAgainst(s, {}).join()).toBe("$.a: missing");
    expect(V.validateAgainst(s, { a: "zzz" }).join()).not.toContain("zzz");
  });
});

describe("the llm client path", () => {
  it("uses the existing ZDR client and existing env names: temperature 0, JSON mode, the first model of LLM_FALLBACK_MODELS", async () => {
    const calls: Array<Record<string, unknown>> = [];
    L.setRubricChatForTests(async (a) => { calls.push(a as never); return answer({ scorable: false }); });
    const r = await L.askJson({ system: "s", user: "u", schema: { type: "object" }, env: { LLM_FALLBACK_MODELS: "vendor/one,vendor/two" } });
    expect(r).toMatchObject({ ok: true, attempts: 1 });
    expect(calls[0]).toMatchObject({ model: "vendor/one", temperature: 0, responseJson: true });
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/openrouter.ts", "utf8");
    expect(src).toContain("zdr: true"); // the client every call goes through sends ZDR and data_collection deny on every body
    expect(src).toContain('data_collection: "deny"');
    expect(fs.readFileSync("lib/rubrics/llm.ts", "utf8")).not.toMatch(/process\.env\.[A-Z_]+/); // no env name of its own
  });
  it("invalid JSON or a schema violation gets exactly one retry on the same model, then fails with a closed reason", async () => {
    let n = 0;
    L.setRubricChatForTests(async () => { n++; return { content: "not json {", model: "m", latency_ms: 1 }; });
    expect(await L.askJson({ system: "s", user: "u", schema: { type: "object" } })).toMatchObject({ ok: false, reason: "llm_invalid_json", attempts: 2 });
    expect(n).toBe(2);
    n = 0;
    L.setRubricChatForTests(async () => { n++; return n === 1 ? answer({ a: 1 }) : answer({ a: "ok" }); });
    expect(await L.askJson({ system: "s", user: "u", schema: { type: "object", required: ["a"], properties: { a: { type: "string" } } } })).toMatchObject({ ok: true, attempts: 2 });
    L.setRubricChatForTests(async () => answer([1]));
    expect(await L.askJson({ system: "s", user: "u", schema: { type: "object" } })).toMatchObject({ ok: false, reason: "llm_invalid_json" });
    L.setRubricChatForTests(async () => answer({ a: 1 }));
    expect(await L.askJson({ system: "s", user: "u", schema: { type: "object", required: ["a"], properties: { a: { type: "string" } } } })).toMatchObject({ ok: false, reason: "llm_schema_invalid", attempts: 2 });
  });
  it("a fenced JSON answer is accepted; no key is a failed unit; a timeout / 429 / 5xx THROWS so the runner retries; a 4xx is a refusal", async () => {
    L.setRubricChatForTests(async () => ({ content: "```json\n{\"a\":1}\n```", model: "m", latency_ms: 1 }));
    expect(await L.askJson({ system: "s", user: "u", schema: { type: "object" } })).toMatchObject({ ok: true });
    const boom = (code: string) => L.setRubricChatForTests(async () => { throw new OpenRouterError(code); });
    boom("openrouter_no_key");
    expect(await L.askJson({ system: "s", user: "u", schema: { type: "object" } })).toMatchObject({ ok: false, reason: "llm_not_configured" });
    for (const c of ["openrouter_timeout", "openrouter_http_408", "openrouter_empty", "openrouter_http_429", "openrouter_http_503", "openrouter_unreachable:TypeError"]) { boom(c); await expect(L.askJson({ system: "s", user: "u", schema: { type: "object" } })).rejects.toThrow(/^llm_unavailable/); }
    boom("openrouter_http_400");
    expect(await L.askJson({ system: "s", user: "u", schema: { type: "object" } })).toMatchObject({ ok: false, reason: "llm_refused" });
  });
});

describe("the prompts", () => {
  it("are versioned files rendered from the rubric's own definition, deterministically, with temperature-0 framing and the output schema", () => {
    expect(RUBRIC_PROMPTS.consult_chair_affect!.version).toBe("1.1.0");
    const a = E.systemPrompt(affect);
    expect(a).toBe(E.systemPrompt(affect));
    expect(a).toContain("consult_chair_affect v1.1.0, prompt v1.1.0");
    expect(a).toContain(JSON.stringify(affect.output));
    expect(a).toMatch(/anti/i);
    expect(E.systemPrompt(pitch)).toContain("consult_surgical_pitch v1.1.0");
    expect(a).not.toContain("engine_note"); // the repo-side notes are not sent to the model
  });
  it("carry no example transcripts, quotes or identifiers", () => {
    const blob = JSON.stringify(RUBRIC_PROMPTS) + E.systemPrompt(affect) + E.systemPrompt(pitch);
    expect(blob).not.toMatch(/\bP\d{2}\b|UHID|MEET-|CONSULT-\d|\b\d{10}\b/);
  });
  it("the Jev typed questions are in the rubric files while the engine stays llm_zdr", () => {
    for (const r of [affect, pitch]) { expect(r.engine).toBe("llm_zdr"); expect(r.questions!.length).toBeGreaterThan(5); expect(r.status).toBe("draft"); }
    expect(affect.questions!.map((q) => q.id)).toEqual(expect.arrayContaining(["distress", "uptake", "resolution_type", "engagement_process"]));
  });
});

describe("consult_chair_affect", () => {
  it("scores, keeps codes in score/findings and quotes only in evidence, drops a quote that is not in the transcript, stamps the transcript's own time", async () => {
    L.setRubricChatForTests(async () => answer(AFFECT_OK));
    const r = await E.evaluateConsultAffect(affect, T);
    expect(r.status).toBe("ok");
    expect(r.score).toMatchObject({ distress: "low", reassurance: "medium", teach_back: "none", uptake_codes: ["accept"], n_recommendations: 1, cases_lite: { engagement_process: "present", doctor_effect_proxy: "load_eased" } });
    expect(r.findings).toEqual(expect.arrayContaining(["distress:low", "uptake:accept", "engagement:present"]));
    expect(JSON.stringify({ s: r.score, f: r.findings })).not.toMatch(/Okay doctor|operation|never said/); // no text outside evidence
    const q = (r.evidence as { quotes: Array<{ quote: string; t_ms: number; t: string }>; quotes_dropped_not_in_transcript: number }).quotes;
    expect(q.map((x) => x.quote)).toEqual(["Will it need an operation?", "Okay doctor."]);
    expect(q.find((x) => x.quote === "Okay doctor.")).toMatchObject({ t_ms: 70_000, t: "01:10" }); // not the model's 999
    expect((r.evidence as { quotes_dropped_not_in_transcript: number }).quotes_dropped_not_in_transcript).toBe(1);
  });
  it("CASES-lite stays apart from the four axes: the overlay never changes an axis, and an engagement claim is checked against talk_time", async () => {
    const lecture = text([[5, "doctor", "Let me explain the whole procedure in detail."], [30, "doctor", "Then the next step is a scan and a diet."]]);
    L.setRubricChatForTests(async () => answer({ ...AFFECT_OK, evidence: [] }));
    const r = await E.evaluateConsultAffect(affect, lecture);
    expect(r.score!.cases_lite).toMatchObject({ engagement_process: "absent" });
    expect(r.findings).toContain("engagement_overridden_by_talk_time");
    expect(r.score).toMatchObject({ distress: "low", confusion: "low", frustration: "low", reassurance: "medium" }); // axes as the model gave them
    expect(Object.keys(r.score!)).not.toContain("engagement_process"); // it lives under cases_lite only
  });
  it("unscorable tape is skipped with a scored 'nothing'; a required field missing when scorable fails after the retry", async () => {
    L.setRubricChatForTests(async () => answer({ scorable: false }));
    expect(await E.evaluateConsultAffect(affect, T)).toMatchObject({ status: "skipped", reason: "unscorable", score: { scorable: false } });
    L.setRubricChatForTests(async () => answer({ scorable: true, distress: "low" }));
    expect(await E.evaluateConsultAffect(affect, T)).toMatchObject({ status: "failed", reason: "llm_schema_invalid" });
    L.setRubricChatForTests(async () => answer({ scorable: true, distress: "very high", confusion: "low", frustration: "low", reassurance: "low", teach_back: "none", recommendations: [], cases_lite: AFFECT_OK.cases_lite }));
    expect(await E.evaluateConsultAffect(affect, T)).toMatchObject({ status: "failed", reason: "llm_schema_invalid" });
  });
  it("does not leak the transcript into the failure evidence", async () => {
    L.setRubricChatForTests(async () => ({ content: "garbage", model: "m", latency_ms: 1 }));
    const r = await E.evaluateConsultAffect(affect, T);
    expect(JSON.stringify(r)).not.toMatch(/stone|operation|laser/);
  });
});

describe("consult_surgical_pitch", () => {
  const PITCH = { surgery_recommended: true, recommendation_kind: "surgery", pitch_source: "own", pitch_balance: { benefits_named: true, risks_named: false, alternatives_named: false, timing_named: true },
    doubts: [{ kind: "pain", code: "unheard", quote: "Will it need an operation?" }], uptake_of_surgery: "accept", prompted_yes: true, evidence: [{ item: "timing_named", quote: "in two weeks" }] };
  it("scores the pitch: balance flags, doubt codes, uptake; findings are codes", async () => {
    L.setRubricChatForTests(async () => answer(PITCH));
    const r = await E.evaluateSurgicalPitch(pitch, T);
    expect(r.status).toBe("ok");
    expect(r.score).toMatchObject({ surgery_recommended: true, risks_named: false, timing_named: true, n_doubts: 1, doubts_unheard: 1, uptake_of_surgery: "accept", prompted_yes: true });
    expect(r.findings).toEqual(expect.arrayContaining(["risks_not_named", "alternatives_not_named", "doubt:pain:unheard", "uptake:accept", "prompted_yes"]));
    expect(JSON.stringify({ s: r.score, f: r.findings })).not.toMatch(/two weeks|operation/);
    expect((r.evidence as { quotes: unknown[] }).quotes).toHaveLength(2);
  });
  it("no surgery recommended -> skipped no_surgery_recommendation (the path the order names)", async () => {
    L.setRubricChatForTests(async () => answer({ surgery_recommended: false }));
    expect(await E.evaluateSurgicalPitch(pitch, T)).toMatchObject({ status: "skipped", reason: "no_surgery_recommendation", score: { surgery_recommended: false } });
    L.setRubricChatForTests(async () => answer({ surgery_recommended: true }));
    expect(await E.evaluateSurgicalPitch(pitch, T)).toMatchObject({ status: "failed", reason: "llm_schema_invalid" });
  });
});

describe("gates: lab only, blind room-days, bench wiring", () => {
  it("draft llm rubrics run only with lab:true and only for the consult unit; the other llm rubrics stay unwired", () => {
    expect(canRun(affect, { lab: false })).toMatchObject({ error: "lab_required" });
    expect(canRun(affect, { lab: true, unit: "consult" })).toBeNull();
    expect(canRun(pitch, { lab: true, unit: "window" })).toMatchObject({ error: "unit_not_supported" });
    expect(canRun(getRubric("care_sentiment")!, { lab: true })).toMatchObject({ error: "engine_not_available" });
    expect(canRun(getRubric("ehrc_surgical_outcome")!, { lab: true })).toMatchObject({ error: "engine_not_available" });
  });
  it("a consult in a held-out room-day is skipped blind_room_day BEFORE its text is read or a model is called", async () => {
    let called = 0;
    L.setRubricChatForTests(async () => { called++; return answer(AFFECT_OK); });
    consultRows = [{ room_id: "room_qyzghzaf", ist_date: "2026-09-15" }];
    queries.length = 0;
    const out = await evaluateUnit(affect, "consult", "enc_x");
    expect(out).toMatchObject({ status: "skipped", reason: "blind_room_day", room_id: "room_qyzghzaf" });
    expect(called).toBe(0);
    expect(queries.some((q) => /jev_window_text|stt_turn|cue/.test(q))).toBe(false);
  });
  it("an unknown consult key is skipped in a normal run, but in a bench it reads the Meet text from the lab store (no room, no model call without text)", async () => {
    let called = 0;
    L.setRubricChatForTests(async () => { called++; return answer(AFFECT_OK); });
    expect(await evaluateUnit(affect, "consult", "m001")).toMatchObject({ status: "skipped", reason: "not_found" });
    expect(await evaluateUnit(affect, "consult", "m001", { bench: true })).toMatchObject({ status: "skipped", reason: "not_found" });
    expect(called).toBe(0);
    store.set("rubric/bench/consult_chair_affect/text/m001.json", JSON.stringify({ lines: [{ t_s: 5, speaker: "doctor", text: "Hello." }, { t_s: 20, speaker: "patient", text: "Okay doctor." }] }));
    const out = await evaluateUnit(affect, "consult", "m001", { bench: true });
    expect(out).toMatchObject({ status: "ok", room_id: null, ist_date: null });
    expect(called).toBe(1);
  });
  it("gold: the metric is field_accuracy over the same scorer; a skipped 'nothing' can be right; the report population says Meet teleconsults, no room tape", () => {
    expect(affect.bench).toMatchObject({ location: "rubric/bench/consult_chair_affect/gold.jsonl", metric: "field_accuracy" });
    expect(pitch.bench.location).toBe("rubric/bench/consult_surgical_pitch/gold.jsonl");
    expect((affect.definition as { bench_population: string }).bench_population).toMatch(/Meet teleconsult.*no room tape/);
    expect((pitch.definition as { bench_population: string }).bench_population).toMatch(/Meet.*no room tape/);
    const set = parseBenchSet({ unit: "consult", items: [{ unit_key: "m001", expected: { surgery_recommended: false } }, { unit_key: "m002", expected: { uptake_codes: ["hedge", "accept"], distress: "low" } }] })!;
    expect(compareItem(set.items[0]!, { surgery_recommended: false }).every((c) => c.equal)).toBe(true);
    expect(compareItem(set.items[1]!, { uptake_codes: ["accept", "hedge"], distress: "low" }).every((c) => c.equal)).toBe(true);
  });
});

describe("S71-G62 — an evidence item label is one of the rubric's own item ids, never free text", () => {
  it("the output schema's evidence item is an enum equal to the question ids; a label carrying anything else is a schema failure (after the one retry)", async () => {
    for (const r of [affect, pitch]) {
      const item = (r.output as unknown as { properties: { evidence: { items: { properties: { item: { enum?: string[] } } } } } }).properties.evidence.items.properties.item;
      expect(item.enum).toEqual(r.questions!.map((q) => q.id));
    }
    L.setRubricChatForTests(async () => answer({ ...AFFECT_OK, evidence: [{ item: "Mrs Somebody Name", quote: "Okay doctor." }] }));
    expect(await E.evaluateConsultAffect(affect, T)).toMatchObject({ status: "failed", reason: "llm_schema_invalid" });
    L.setRubricChatForTests(async () => answer({ ...AFFECT_OK, evidence: [{ item: "distress", quote: "Okay doctor." }] }));
    expect(await E.evaluateConsultAffect(affect, T)).toMatchObject({ status: "ok" });
    L.setRubricChatForTests(async () => answer({ surgery_recommended: true, recommendation_kind: "surgery", pitch_source: "own", pitch_balance: { benefits_named: true, risks_named: true, alternatives_named: true, timing_named: true }, uptake_of_surgery: "accept", evidence: [{ item: "a free label", quote: "x" }] }));
    expect(await E.evaluateSurgicalPitch(pitch, T)).toMatchObject({ status: "failed", reason: "llm_schema_invalid" });
  });
});

describe("S71-A — 1.1.0 reconciles the prompts with the GrokBot skills", () => {
  it("the chair prompt carries the anti-defaults, the flat default, the uptake flags and the A-B-C layers; the pitch prompt carries the not-counted rules and the anti-pitch", () => {
    const a = E.systemPrompt(affect), p = E.systemPrompt(pitch);
    for (const re of [/okay or thanks[^\n]*not reassurance medium/, /named fear[^\n]*reassurance high/, /still guarded[^\n]*reassurance low/, /chart keyword alone is not medium distress/, /disease severity is not distress/, /never force medium/, /distress low AND confusion low AND frustration low AND reassurance medium/, /prompted yes is accept/, /logistics block[^\n]*refuse/, /layers are scored in order A/, /separate from the reassurance axis/, /no utterance-share/]) expect(a, String(re)).toMatch(re);
    for (const re of [/'it is needed' is not a benefit/, /small operation[^\n]*not a risk/, /work-up[^\n]*not an alternative/, /no_surgery is an anti-pitch/, /own_contingent/, /outside_surgeon/, /even when the operation is never booked|scored even if the operation is never booked/]) expect(p, String(re)).toMatch(re);
    expect(a).not.toMatch(/utterance share[s]? (are|is) /i);
  });
  it("chair: prompted_yes / logistics_block flags become finding codes and cases_v0 lands under cases_lite (codes and counts only)", async () => {
    L.setRubricChatForTests(async () => answer({ ...AFFECT_OK, recommendations: [{ uptake: ["refuse"], resolution_type: "patient_refuses", logistics_block: true }, { uptake: ["accept"], resolution_type: "patient_agrees", prompted_yes: true }], cases_v0: { n_threads: 2, non_thread: ["wrap_up"], visit_summary: "mixed" }, evidence: [] }));
    const r = await E.evaluateConsultAffect(affect, T);
    expect(r.status).toBe("ok");
    expect(r.findings).toEqual(expect.arrayContaining(["prompted_yes", "logistics_block"]));
    expect(r.score!.cases_lite).toMatchObject({ n_threads: 2, non_thread: ["wrap_up"], visit_summary: "mixed" });
  });
  it("pitch: an audible no_surgery is an anti-pitch and is SCORED (ok), a plain no-recommendation stays skipped", async () => {
    L.setRubricChatForTests(async () => answer({ surgery_recommended: false, recommendation_kind: "no_surgery" }));
    expect(await E.evaluateSurgicalPitch(pitch, T)).toMatchObject({ status: "ok", findings: ["kind:no_surgery"], score: { surgery_recommended: false, recommendation_kind: "no_surgery" } });
    L.setRubricChatForTests(async () => answer({ surgery_recommended: false }));
    expect(await E.evaluateSurgicalPitch(pitch, T)).toMatchObject({ status: "skipped", reason: "no_surgery_recommendation" });
  });
});

describe("S71-E G69 — an excerpt unit is bench-only", () => {
  it("evaluateUnit with excerpt:true and no bench flag is skipped unit_not_supported: no store read, no model call (the guard dies if it is removed)", async () => {
    let called = 0;
    L.setRubricChatForTests(async () => { called++; return answer(AFFECT_OK); });
    store.set("rubric/bench/consult_chair_affect/text/hv-x.json", JSON.stringify({ lines: [{ t_s: 0, speaker: "unknown", text: "He advised for surgery." }] }));
    const reads = vi.spyOn(Map.prototype, "has");
    reads.mockClear();
    const out = await evaluateUnit(affect, "consult", "hv-x", { excerpt: true });
    expect(out).toMatchObject({ status: "skipped", reason: "unit_not_supported", room_id: null });
    expect(reads.mock.calls.some((c) => String(c[0]).includes("hv-x"))).toBe(false); // the lab store was not consulted
    reads.mockRestore();
    expect(called).toBe(0);
    expect(await evaluateUnit(affect, "consult", "hv-x", { excerpt: true, bench: true, room_id: "r1", ist_date: "2026-10-08" })).toMatchObject({ status: "ok" }); // the bench path reads it
    expect(called).toBe(1);
  });
});

describe("S71-R4 G70 — an excerpt is placed and meets the held-out check before any read or model call", () => {
  const BLIND = (() => { const [d, r] = ["2026-09-23", "room_4ggnkg5x"]; return { d, r }; })();
  const spyReads = () => vi.spyOn(Map.prototype, "has");
  it("an excerpt placed on a blind (room, date) is skipped blind_room_day with 0 lab-store reads and 0 model calls", async () => {
    let called = 0;
    L.setRubricChatForTests(async () => { called++; return answer(AFFECT_OK); });
    store.set("rubric/bench/consult_chair_affect/text/hv-b.json", JSON.stringify({ lines: [{ t_s: 0, speaker: "unknown", text: "He advised for surgery." }] }));
    const reads = spyReads();
    reads.mockClear();
    const out = await evaluateUnit(affect, "consult", "hv-b", { excerpt: true, bench: true, room_id: BLIND.r, ist_date: BLIND.d });
    expect(out).toMatchObject({ status: "skipped", reason: "blind_room_day", room_id: BLIND.r, ist_date: BLIND.d });
    expect(reads.mock.calls.some((c) => String(c[0]).includes("hv-b"))).toBe(false);
    reads.mockRestore();
    expect(called).toBe(0);
  });
  it("an excerpt with no room, no date or a malformed one is refused excerpt_unplaced: 0 reads, 0 calls; a placed, not-blind one is scored", async () => {
    let called = 0;
    L.setRubricChatForTests(async () => { called++; return answer(AFFECT_OK); });
    store.set("rubric/bench/consult_chair_affect/text/hv-u.json", JSON.stringify({ lines: [{ t_s: 0, speaker: "unknown", text: "He advised for surgery." }] }));
    const reads = spyReads();
    reads.mockClear();
    for (const o of [{}, { room_id: "r1" }, { ist_date: "2026-10-08" }, { room_id: "r1", ist_date: "08/10/2026" }, { room_id: "bad room!", ist_date: "2026-10-08" }, { room_id: null, ist_date: null }]) {
      expect(await evaluateUnit(affect, "consult", "hv-u", { excerpt: true, bench: true, ...o }), JSON.stringify(o)).toMatchObject({ status: "skipped", reason: "excerpt_unplaced" });
    }
    expect(reads.mock.calls.some((c) => String(c[0]).includes("hv-u"))).toBe(false);
    reads.mockRestore();
    expect(called).toBe(0);
    expect(await evaluateUnit(affect, "consult", "hv-u", { excerpt: true, bench: true, room_id: "r1", ist_date: "2026-10-08" })).toMatchObject({ status: "ok" });
    expect(called).toBe(1);
  });
});
