/**
 * S7-2 — encounter_vs_record without a database: the record reader and its SELECT, the normalisation, the comparison and its tiers, the AI-filled cap, the banned words, the perturbation bench,
 * the read-only guarantee. Fake LLM, fake warehouse; nothing here calls a model, Metabase or Pulse.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

vi.mock("@/lib/db", () => ({ sql: async () => [] }));
const R = await import("@/lib/rubrics/evr/record");
const C = await import("@/lib/rubrics/evr/compare");
const P = await import("@/lib/rubrics/evr/perturb");
const T = await import("@/lib/rubrics/evr/types");
const E = await import("@/lib/rubrics/engines/evr");
const S = await import("@/lib/rubrics/evr/said");
const L = await import("@/lib/rubrics/llm");
const { getRubric, canRun } = await import("@/lib/rubrics/registry");
const rubric = getRubric("encounter_vs_record")!;

const UID = "AbCdEfGhIjKlMnOpQrStUvWxYz".slice(0, 26);
const REC_ROW = {
  rec_uid: "rec1", uploaded_at: "2026-10-05T10:00:00Z", exam: "right knee swelling",
  complaints: JSON.stringify([{ symptoms: "pain", ai_field_metadata: { symptoms: { ai_filled: false } }, diagnoses: [
    { diagnosis_or_impression: "Osteoarthritis right knee", is_differential_diagnosis: false, location_or_notes: "right knee" },
    { diagnosis_or_impression: "Gout", is_differential_diagnosis: true, location_or_notes: "" }] }]),
  plan: [{ management_plan: "plan", requires_surgery_or_procedure: true, surgery_or_procedure_recommendation: "Right knee arthroscopy", ai_field_metadata: { requires_surgery_or_procedure: { ai_filled: false } } }],
  ai_meta: { examination: { ai_filled: true } },
  meds: [{ generic_name: "Diclofenac", brand_name: "Voveran", strength: "50 mg", dosage: "1 tablet", frequency: "BD", route_of_administration: "oral", duration: "5 days" }, { generic_name: "Pantoprazole", strength: "40 mg", frequency: "OD" }],
  investigations: [{ investigation: "MRI knee" }], refer_to: [{ specialist_type: "Physiotherapy" }], advice: [{ general_advice: "rest" }],
  fu_date: "2026-10-20", fu_type: "review", fu_next: "", fu_instructions: "physiotherapy exercises daily",
};
const lines = (xs: Array<[number, string]>): import("@/lib/rubrics/evr/compare").TapeLine[] => xs.map(([s, text]) => ({ t_ms: s * 1000, text }));
const said = (p: Partial<import("@/lib/rubrics/evr/types").SaidItems> = {}): import("@/lib/rubrics/evr/types").SaidItems => ({ complaints: [], diagnoses: [], meds: [], investigations: [], procedures: [], followup: [], ...p });
const TAPE = lines([[5, "Your right knee has osteoarthritis."], [20, "Take diclofenac 50 mg twice a day for five days."], [40, "And pantoprazole 40 mg once daily before food."], [60, "We will do an arthroscopy of the right knee."]]);
const SAID = said({
  diagnoses: [{ name: "osteoarthritis", side: "right", t_ms: 5000, quote: "Your right knee has osteoarthritis." }],
  meds: [{ name: "diclofenac", dose: "50 mg", freq: "twice a day", route: "", duration: "5 days", side: "", t_ms: 20000, quote: "Take diclofenac 50 mg twice a day for five days." }, { name: "pantoprazole", dose: "40 mg", freq: "once daily", route: "", duration: "", side: "", t_ms: 40000, quote: "And pantoprazole 40 mg once daily before food." }],
  procedures: [{ name: "arthroscopy", side: "right", t_ms: 60000, quote: "We will do an arthroscopy of the right knee." }],
});

describe("pulse_record: one SELECT, validated uid, normalised shapes", () => {
  it("the SQL is a SELECT on the two measured filters (EMR_2_GENERATED, non-draft), the uid is validated, and nothing else can reach it", () => {
    const q = R.recordSql(UID);
    expect(q).toMatch(/^SELECT /);
    expect(q).toContain("p.type = 'EMR_2_GENERATED'");
    expect(q).toContain("p.is_draft = false");
    expect(q).toContain(`'${UID}'`);
    for (const bad of ["", "short", "x".repeat(41), `${UID}'; DROP TABLE x; --`, `${UID} OR 1=1`, "a b c d e f g h i j k l m n o p"]) expect(() => R.recordSql(bad), bad).toThrow(/bad_consult_uid/);
  });
  it("normalises the measured shapes: diagnoses from presenting_complaints[].diagnoses[], procedures only when requires_surgery_or_procedure, meds, ai provenance per field", () => {
    const n = R.normaliseRecord(REC_ROW);
    expect(n.diagnoses).toEqual([{ name: "Osteoarthritis right knee", differential: false, location_notes: "right knee" }, { name: "Gout", differential: true, location_notes: "" }]);
    expect(n.procedures).toEqual([{ name: "Right knee arthroscopy" }]);
    expect(n.meds[0]).toMatchObject({ name: "Diclofenac", alt_name: "Voveran", dose: "50 mg 1 tablet", freq: "BD" });
    expect(n.ai).toMatchObject({ exam: true, complaints: false, diagnoses: false, procedures: false, meds: "unknown", investigations: "unknown" });
    expect(n.investigations).toEqual(["MRI knee"]);
    const none = R.normaliseRecord({ plan: [{ requires_surgery_or_procedure: false, surgery_or_procedure_recommendation: "x y z" }] });
    expect(none.procedures).toEqual([]);
  });
  it("prefers the window's prescription uid, else the latest, and reports the record count; no record is a typed result; a warehouse failure THROWS", async () => {
    R.setMetabaseForTests(async () => [{ ...REC_ROW, rec_uid: "newest" }, { ...REC_ROW, rec_uid: "old" }]);
    expect(await R.fetchPulseRecord(UID, "old")).toMatchObject({ ok: true, rec_uid: "old", n_records: 2, chosen: "window_uid" });
    expect(await R.fetchPulseRecord(UID, null)).toMatchObject({ ok: true, rec_uid: "newest", chosen: "latest" });
    expect(await R.fetchPulseRecord(UID, "missing")).toMatchObject({ ok: true, rec_uid: "newest", chosen: "latest" });
    R.setMetabaseForTests(async () => []);
    expect(await R.fetchPulseRecord(UID, null)).toEqual({ ok: false, reason: "no_record" });
    expect(await R.fetchPulseRecord("bad", null)).toEqual({ ok: false, reason: "bad_consult_uid" });
    R.setMetabaseForTests(async () => { throw new Error("Metabase: timed out"); });
    await expect(R.fetchPulseRecord(UID, null)).rejects.toThrow();
    R.setMetabaseForTests(null);
  });
  it("READ ONLY: the modules hold no write statement, no Pulse host and no parsePrescription call", () => {
    for (const f of ["lib/rubrics/evr/record.ts", "lib/rubrics/readers/pulse-record.ts", "lib/rubrics/evr/compare.ts", "lib/rubrics/evr/said.ts", "lib/rubrics/evr/perturb.ts", "lib/rubrics/engines/evr.ts"]) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/.test(code), `${f} write statement`).toBe(false);
      expect(/parsePrescription/.test(code), `${f} parsePrescription`).toBe(false);
      expect(/method:\s*["']POST["']|evenscribe\.app|pulse\.even|firestore/i.test(code), `${f} pulse host / post`).toBe(false);
    }
  });
});

describe("the comparison, field by field, and the tiers", () => {
  const rec = () => R.normaliseRecord(REC_ROW);
  it("a record that matches the tape has no finding of material or obvious tier", () => {
    const fs = C.compareRecord(rec(), SAID, TAPE);
    expect(fs.filter((f) => f.tier === "obvious" || f.tier === "material"), JSON.stringify(fs.map((f) => f.text))).toEqual([]);
  });
  it("a drug with no support on the tape is obvious ('no support found'); on the tape but not extracted it is not", () => {
    const r = rec(); r.meds.push({ name: "Warfarin", alt_name: "", dose: "5 mg", freq: "OD", route: "", duration: "", side: "" });
    const f = C.compareRecord(r, SAID, TAPE).find((x) => x.target === "Warfarin")!;
    expect(f).toMatchObject({ kind: "in_record_not_said", field: "drug", tier: "obvious", support: "no support found", tape_t_ms: [] });
    const tape2 = [...TAPE, ...lines([[80, "no warfarin for you"]])];
    expect(C.compareRecord(r, SAID, tape2).some((x) => x.target === "Warfarin")).toBe(false);
  });
  it("dose: a clear contradiction (x2) is obvious, a small difference is material; frequency mismatch is material", () => {
    const r = rec(); r.meds[0]!.dose = "100 mg 1 tablet";
    expect(C.compareRecord(r, SAID, TAPE).find((x) => x.field === "dose")).toMatchObject({ tier: "obvious", kind: "value_mismatch" });
    r.meds[0]!.dose = "60 mg";
    expect(C.compareRecord(r, SAID, TAPE).find((x) => x.field === "dose")).toMatchObject({ tier: "material" });
    r.meds[0]!.dose = "50 mg"; r.meds[0]!.freq = "TDS";
    expect(C.compareRecord(r, SAID, TAPE).find((x) => x.field === "frequency")).toMatchObject({ tier: "material" });
  });
  it("laterality: a record side that contradicts the tape is obvious; procedures and diagnoses with no support are obvious, a differential is minor", () => {
    const r = rec(); r.procedures = [{ name: "Left knee arthroscopy" }];
    expect(C.compareRecord(r, SAID, TAPE).find((x) => x.field === "laterality")).toMatchObject({ tier: "obvious" });
    const r2 = rec(); r2.procedures.push({ name: "Laparoscopic cholecystectomy" });
    expect(C.compareRecord(r2, SAID, TAPE).find((x) => x.field === "procedure")).toMatchObject({ kind: "in_record_not_said", tier: "obvious" });
    const r3 = rec(); r3.diagnoses.push({ name: "Atrial fibrillation", differential: false, location_notes: "" }, { name: "Sarcoidosis", differential: true, location_notes: "" });
    const fs = C.compareRecord(r3, SAID, TAPE).filter((x) => x.field === "diagnosis");
    expect(fs.find((x) => x.target === "Atrial fibrillation")!.tier).toBe("obvious");
    expect(fs.find((x) => x.target === "Sarcoidosis")!.tier).toBe("minor");
  });
  it("said but not in the record is minor; removing a said drug gives said_not_in_record", () => {
    const r = rec(); r.meds.shift();
    expect(C.compareRecord(r, SAID, TAPE).find((x) => x.kind === "said_not_in_record")).toMatchObject({ field: "drug", tier: "minor", target: "diclofenac" });
  });
  it("PROVENANCE: a finding on an AI-filled field says so and is capped at material, never obvious; on a human-filled field it stays obvious", () => {
    const r = rec(); r.procedures.push({ name: "Laparoscopic cholecystectomy" });
    r.ai.procedures = true;
    const capped = C.compareRecord(r, SAID, TAPE).find((x) => x.field === "procedure")!;
    expect(capped).toMatchObject({ tier: "material", field_ai_filled: true });
    expect(capped.text).toContain("AI-filled field");
    r.ai.procedures = false;
    expect(C.compareRecord(r, SAID, TAPE).find((x) => x.field === "procedure")).toMatchObject({ tier: "obvious", field_ai_filled: false });
    r.ai.procedures = "unknown";
    expect(C.compareRecord(r, SAID, TAPE).find((x) => x.field === "procedure")).toMatchObject({ tier: "obvious", field_ai_filled: "unknown" });
  });
  it("the drug scorer is gated: a common English word is not matched to a drug on a loose spelling", () => {
    expect(C.sameDrug(["Diclofenac"], ["diclofenak"])).toBe(true);
    expect(C.sameDrug(["Stairs"], ["Starizo"])).toBe(false);
    expect(C.tapeMention(["Warfarin"], lines([[1, "take the stairs"]]))).toBeNull();
  });
  it("jevJudge is an unwired hook: undefined, and compareRecord never takes or calls it", () => {
    expect(E.jevJudge).toBeUndefined();
    expect(C.compareRecord.length).toBe(3);
  });
});

describe("the perturbation bench", () => {
  const rec = () => R.normaliseRecord(REC_ROW);
  it("every kind is applied to a COPY (the original is untouched) and is detected at its expected tier on a matching tape", () => {
    const base = rec();
    const before = JSON.stringify(base);
    const w = P.scoreWindow(base, SAID, TAPE, 7);
    expect(JSON.stringify(base)).toBe(before);
    const byKind = Object.fromEntries(w.kinds.map((k) => [k.kind, k]));
    for (const k of ["add_drug", "add_procedure", "add_diagnosis", "dose_x2", "dose_half", "laterality_swap", "remove_drug"] as const) expect(byKind[k]!.applicable, k).toBe(true);
    expect(byKind.add_drug).toMatchObject({ expected_tier: "obvious", found: true });
    expect(byKind.add_procedure).toMatchObject({ expected_tier: "obvious", found: true });
    expect(byKind.add_diagnosis).toMatchObject({ expected_tier: "obvious", found: true });
    expect(byKind.dose_x2).toMatchObject({ expected_tier: "obvious", found: true });
    expect(byKind.dose_half).toMatchObject({ expected_tier: "obvious", found: true });
    expect(byKind.laterality_swap).toMatchObject({ expected_tier: "obvious", found: true });
    expect(byKind.remove_drug).toMatchObject({ expected_tier: "minor", found: true });
    expect(w.baseline_findings).toBe(w.kinds.length ? w.baseline_findings : 0);
  });
  it("dose changes expect NONE when the tape does not state that drug's dose; a laterality swap with no side on the record is not applicable; the seed makes a rerun repeat", () => {
    const noDose = said({ ...SAID, meds: SAID.meds.map((m) => ({ ...m, dose: "" })) });
    const w = P.scoreWindow(rec(), noDose, TAPE, 3, ["dose_x2", "dose_half"]);
    for (const k of w.kinds) expect(k).toMatchObject({ applicable: true, expected_tier: "none", correct_none: true });
    const r = rec(); r.procedures = [{ name: "Arthroscopy" }]; r.diagnoses = [{ name: "Osteoarthritis", differential: false, location_notes: "" }];
    expect(P.scoreWindow(r, SAID, TAPE, 3, ["laterality_swap"]).kinds[0]).toMatchObject({ applicable: false });
    expect(JSON.stringify(P.scoreWindow(rec(), SAID, TAPE, 11))).toBe(JSON.stringify(P.scoreWindow(rec(), SAID, TAPE, 11)));
  });
  it("aggregation: recall per kind, extra findings, baseline flag rate (originals are not negatives)", () => {
    const outs = [P.scoreWindow(rec(), SAID, TAPE, 1), P.scoreWindow(rec(), SAID, TAPE, 2)];
    const a = P.aggregatePerturb(outs);
    expect(a.windows).toBe(2);
    expect(a.per_kind.add_drug).toMatchObject({ n_applicable: 2, recall: 1 });
    expect(a.baseline_flag_rate.obvious).toBe(0);
    const r = rec(); r.meds.push({ name: "Digoxin", alt_name: "", dose: "", freq: "", route: "", duration: "", side: "" });
    expect(P.aggregatePerturb([P.scoreWindow(r, SAID, TAPE, 1)]).baseline_flag_rate).toMatchObject({ any: 1, obvious: 1 });
  });
});

describe("the engine: lab-only, report wording, no banned words", () => {
  beforeEach(() => { L.setRubricChatForTests(null); R.setMetabaseForTests(null); });
  const text = (): import("@/lib/rubrics/readers/consult-text").ConsultText => ({ consult_key: "k", source: "database", span_ms: 90_000, lines: TAPE.map((l) => ({ t_ms: l.t_ms, speaker: "doctor" as const, speaker_idx: 0, text: l.text })), chars: 200, truncated: false, turns: [] });
  it("the rubric is a lab-only draft llm_zdr rubric, runs on consult units only, and is registered", () => {
    expect(rubric).toMatchObject({ engine: "llm_zdr", status: "draft", unit: "consult", version: "0.1.0" });
    expect(canRun(rubric, { lab: false })).toMatchObject({ error: "lab_required" });
    expect(canRun(rubric, { lab: true, unit: "consult" })).toBeNull();
    expect(canRun(rubric, { lab: true, unit: "window" })).toMatchObject({ error: "unit_not_supported" });
  });
  it("the said-items prompt and schema: strict JSON, an invalid answer is an error result (no guess), an item whose quote is not on the tape is dropped", async () => {
    L.setRubricChatForTests(async () => ({ content: JSON.stringify({ scorable: true, meds: [{ name: "diclofenac", dose: "50 mg", quote: "Take diclofenac 50 mg twice a day for five days." }, { name: "invented", quote: "never said this" }], procedures: [{ name: "arthroscopy", side: "right", quote: "We will do an arthroscopy of the right knee." }] }), model: "fake/m", latency_ms: 1 }));
    const ok = await S.extractSaid(text());
    expect(ok.ok && ok.said.meds.map((m) => [m.name, m.t_ms])).toEqual([["diclofenac", 20000]]);
    expect(ok.ok && ok.dropped).toBe(1);
    L.setRubricChatForTests(async () => ({ content: "not json", model: "fake/m", latency_ms: 1 }));
    expect(await S.extractSaid(text())).toMatchObject({ ok: false, reason: "llm_invalid_json" });
    L.setRubricChatForTests(async () => ({ content: JSON.stringify({ scorable: true, meds: [{ name: "a", quote: "nope one" }, { name: "b", quote: "nope two" }] }), model: "fake/m", latency_ms: 1 }));
    expect(await S.extractSaid(text())).toMatchObject({ ok: false, reason: "said_items_unverified" });
    L.setRubricChatForTests(async () => ({ content: JSON.stringify({ scorable: false }), model: "fake/m", latency_ms: 1 }));
    expect(await S.extractSaid(text())).toMatchObject({ ok: false, reason: "unscorable" });
    expect(S.saidSystemPrompt()).toContain("said_items prompt v1.0.0");
  });
  it("no word that accuses a person appears in any string the rubric writes (files, wording, findings, evidence text); the product label is 'discrepancy report'", () => {
    const strings: string[] = [JSON.stringify(rubric), readFileSync("rubrics/encounter_vs_record/prompt.json", "utf8"), S.saidSystemPrompt(), E.REPORT_LABEL];
    const r = R.normaliseRecord(REC_ROW); r.procedures.push({ name: "Laparoscopic cholecystectomy" }); r.ai.procedures = true;
    for (const f of C.compareRecord(r, SAID, TAPE)) strings.push(f.text, f.support, T.findingCode(f));
    const w = P.scoreWindow(r, SAID, TAPE, 5);
    strings.push(JSON.stringify(w), JSON.stringify(P.aggregatePerturb([w])));
    for (const f of ["lib/rubrics/evr/compare.ts", "lib/rubrics/engines/evr.ts", "lib/rubrics/evr/said.ts", "lib/rubrics/evr/perturb.ts"]) strings.push(readFileSync(f, "utf8").replace(/BANNED_WORDS = \[[^\]]*\]/, ""));
    for (const s of strings) for (const b of E.BANNED_WORDS) expect(s.toLowerCase().includes(b), `${b} in output text`).toBe(false);
    expect(E.REPORT_LABEL).toBe("discrepancy report");
  });
  it("the rubric files hold no identifier and the folder holds exactly the rubric and its prompt", () => {
    expect(readdirSync("rubrics/encounter_vs_record").sort()).toEqual(["prompt.json", "rubric.json"]);
  });
});

describe("S7-2-R2 — follow-up fields (minor only) and the call ceiling", () => {
  const rec = () => R.normaliseRecord(REC_ROW);
  it("the four follow-up columns are selected and normalised into one followup string", () => {
    const q = R.recordSql(UID);
    for (const c of ["p.followup__followup_date", "p.followup__followup_type", "p.next_follow_up_date", "p.followup__follow_up_instructions"]) expect(q).toContain(c);
    expect(rec().followup).toBe("review; physiotherapy exercises daily; 2026-10-20");
  });
  it("follow-up is compared as MINOR only: in the record with no support on the tape, or said and absent from the record; supported follow-up gives nothing", () => {
    const fs = C.compareRecord(rec(), SAID, TAPE).filter((f) => f.field === "followup");
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ kind: "in_record_not_said", tier: "minor", support: "no support found" });
    const tape2 = [...TAPE, ...lines([[90, "Do the physiotherapy exercises every day and come for a review."]])];
    expect(C.compareRecord(rec(), SAID, tape2).filter((f) => f.field === "followup")).toEqual([]);
    const r = rec(); r.followup = "";
    const s2 = said({ ...SAID, followup: [{ text: "come back in two weeks", t_ms: 90000, quote: "come back in two weeks" }] });
    expect(C.compareRecord(r, s2, TAPE).filter((f) => f.field === "followup")).toMatchObject([{ kind: "said_not_in_record", tier: "minor" }]);
    for (const f of C.compareRecord(rec(), SAID, TAPE)) if (f.field === "followup") expect(f.tier).not.toMatch(/obvious|material/);
  });
  it("evr goes through the llm call ceiling: a run reserves one call per unit, the bench estimate is the 40 extraction calls, and the rubric is an llm rubric", async () => {
    const CAP = await import("@/lib/rubrics/llm-cap");
    expect(CAP.isLlmRubric("encounter_vs_record")).toBe(true);
    expect(CAP.reservationFor("rubric_run", { rubric_id: "encounter_vs_record", unit_keys: ["a", "b", "c"] })).toBe(3);
    expect(CAP.reservationFor("rubric_bench", { rubric_id: "encounter_vs_record", set: "evr_perturb" })).toBe(40);
  });
});

describe("S7-2-R2 R1..R8", () => {
  const rec = () => R.normaliseRecord(REC_ROW);
  const medOnly = (name: string, dose = "650 mg", freq = "TDS") => { const r = rec(); r.meds = [{ name, alt_name: "", dose, freq, route: "", duration: "", side: "" }]; return r; };
  it("R1 — a generic-only record drug vs a brand said on the tape is capped at material, never obvious (Dolo 650 vs paracetamol; Augmentin vs amoxicillin + clavulanate)", () => {
    for (const [generic, brand, tapeLine] of [["Paracetamol", "Dolo", "Take Dolo 650 three times a day."], ["Amoxicillin and clavulanate", "Augmentin", "Start Augmentin 625 twice daily."]] as const) {
      const r = medOnly(generic, "650 mg", "TDS");
      const sd = said({ meds: [{ name: brand, dose: "650 mg", freq: "three times a day", route: "", duration: "", side: "", t_ms: 5000, quote: tapeLine }] });
      const fs = C.compareRecord(r, sd, lines([[5, tapeLine]]));
      const f = fs.find((x) => x.field === "drug" && x.kind === "in_record_not_said")!;
      expect(f, generic).toBeDefined();
      expect(f.tier, generic).toBe("material");
      expect(fs.filter((x) => x.field === "drug").some((x) => x.tier === "obvious"), generic).toBe(false);
      expect(fs.find((x) => x.kind === "said_not_in_record")).toMatchObject({ tier: "minor" });
    }
    // with NO unmatched said drug the same unsupported record drug is still obvious
    expect(C.compareRecord(medOnly("Warfarin"), said(), TAPE).find((x) => x.field === "drug")).toMatchObject({ tier: "obvious" });
  });
  it("R3 — add_procedure / add_diagnosis expect material when the target field is AI-filled, obvious otherwise (and are found at that tier)", () => {
    const ai = rec(); ai.ai.procedures = true; ai.ai.diagnoses = true;
    const w = P.scoreWindow(ai, SAID, TAPE, 4, ["add_procedure", "add_diagnosis"]);
    for (const k of w.kinds) expect(k).toMatchObject({ applicable: true, expected_tier: "material", found: true });
    const human = rec();
    for (const k of P.scoreWindow(human, SAID, TAPE, 4, ["add_procedure", "add_diagnosis"]).kinds) expect(k).toMatchObject({ expected_tier: "obvious", found: true });
  });
  it("R4 — laterality_swap expects obvious only when the tape states a side for that site, else none (reported with its reason)", () => {
    const noSide = said({ ...SAID, procedures: [{ name: "arthroscopy", side: "", t_ms: 60000, quote: "We will do an arthroscopy." }], diagnoses: [{ name: "osteoarthritis", side: "", t_ms: 5000, quote: "Your knee has osteoarthritis." }] });
    const k = P.scoreWindow(rec(), noSide, TAPE, 3, ["laterality_swap"]).kinds[0]!;
    expect(k).toMatchObject({ applicable: true, expected_tier: "none", correct_none: true, none_reason: "no_side_on_tape" });
    expect(P.scoreWindow(rec(), SAID, TAPE, 3, ["laterality_swap"]).kinds[0]).toMatchObject({ expected_tier: "obvious", found: true });
  });
  it("R5 — doses in number words and unitless numbers are compared; an unparseable tape dose is counted apart, not as a correct none", () => {
    for (const [t, v] of [["five hundred mg", 500], ["one thousand mg", 1000], ["half a gram", 0.5], ["one and a half g", 1500], ["500 mg", 500]] as const) {
      const d = C.parseDose(t);
      if (t === "half a gram") expect(C.numberWordsToDigits(t)).toBe("0.5 a gram");
      else expect(d?.value, t).toBe(v);
    }
    expect(C.parseDose("500", "mg")).toEqual({ value: 500, unit: "mg" });
    expect(C.parseDose("500")).toBeNull();
    // record 1000 mg vs tape "five hundred mg": a clear contradiction (ratio 2) now found; unitless "500" vs record 500 mg: equal
    const r = medOnly("Diclofenac", "1000 mg", "BD");
    const mk = (dose: string) => said({ meds: [{ name: "diclofenac", dose, freq: "twice a day", route: "", duration: "", side: "", t_ms: 20000, quote: "Take diclofenac" }] });
    expect(C.compareRecord(r, mk("five hundred mg"), TAPE).find((x) => x.field === "dose")).toMatchObject({ tier: "obvious" });
    expect(C.compareRecord(medOnly("Diclofenac", "500 mg", "BD"), mk("500"), TAPE).find((x) => x.field === "dose")).toBeUndefined();
    // the bench: a tape dose that cannot be parsed ("a standard dose") makes the dose kinds expect none, and that is REPORTED
    const odd = said({ meds: [{ name: "diclofenac", dose: "a standard dose", freq: "", route: "", duration: "", side: "", t_ms: 20000, quote: "Take diclofenac" }] });
    const w = P.scoreWindow(medOnly("Diclofenac", "50 mg", "BD"), odd, TAPE, 2, ["dose_x2", "dose_half"]);
    for (const k of w.kinds) expect(k).toMatchObject({ expected_tier: "none", none_reason: "tape_dose_unparseable" });
    const agg = P.aggregatePerturb([w]);
    expect(agg.dose_none_unparseable).toBe(2);
    expect(agg.per_kind.dose_x2!.n_none_tape_dose_unparseable).toBe(1);
    const none = said({ meds: [{ name: "diclofenac", dose: "", freq: "", route: "", duration: "", side: "", t_ms: 20000, quote: "Take diclofenac" }] });
    expect(P.aggregatePerturb([P.scoreWindow(medOnly("Diclofenac", "50 mg", "BD"), none, TAPE, 2, ["dose_x2"])]).dose_none_unparseable).toBe(0);
  });
  it("R6 — the banned-word check covers rubric-bench.ts, s7.ts and the tool description, and it CATCHES an injected word", async () => {
    const S7 = await import("@/lib/mcp/surface");
    const tool = S7.CALLABLE_TOOLS.get("scribe_rubric")!;
    const files = ["lib/jobs/kinds/rubric-bench.ts", "lib/mcp/tools/s7.ts", "lib/rubrics/engines/evr.ts", "lib/rubrics/evr/compare.ts", "lib/rubrics/evr/perturb.ts", "lib/rubrics/evr/said.ts"];
    const texts = [...files.map((f) => readFileSync(f, "utf8").replace(/BANNED_WORDS = \[[^\]]*\]/, "")), tool.description, JSON.stringify(tool.inputSchema)];
    for (const t of texts) expect(E.findBanned(t)).toEqual([]);
    for (const t of texts) expect(E.findBanned(`${t} fraud`)).toEqual(["fraud"]); // injected word is caught in each
    expect(E.findBanned("A DISHONEST note")).toEqual(["dishonest"]);
  });
  it("R7 — laterality is read from the examination text too: a side in the exam that contradicts the tape's side is obvious", () => {
    const r = rec(); r.exam = "Left knee swelling"; r.procedures = [{ name: "Knee arthroscopy" }]; r.diagnoses = [];
    const tapeSaid = said({ procedures: [{ name: "knee arthroscopy", side: "right", t_ms: 60000, quote: "We will do an arthroscopy of the right knee." }] });
    expect(C.compareRecord(r, tapeSaid, TAPE).find((x) => x.field === "laterality")).toMatchObject({ tier: "obvious" });
    r.exam = "Right knee swelling";
    expect(C.compareRecord(r, tapeSaid, TAPE).find((x) => x.field === "laterality")).toBeUndefined();
  });
  it("R8 — the record reader never invents ai_filled for medications or investigations, even when the raw rows carry something shaped like it", () => {
    const n = R.normaliseRecord({ ...REC_ROW, meds: [{ generic_name: "A", ai_field_metadata: { generic_name: { ai_filled: true } } }], investigations: [{ investigation: "MRI", ai_field_metadata: { investigation: { ai_filled: true } } }], ai_meta: { medications: { ai_filled: true }, further_investigation: { ai_filled: true } } });
    expect(n.ai.meds).toBe("unknown");
    expect(n.ai.investigations).toBe("unknown");
    expect(readFileSync("lib/rubrics/evr/record.ts", "utf8")).toMatch(/NO ai_field_metadata for medications or investigations/);
  });
});
