/**
 * S7-3 — ehrc_surgical_outcome: the stay_record reader and the engine. A fake warehouse (every SQL string recorded) and a fake model; no network, no key, no database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: Object.assign(async () => [], { transaction: async () => [] }) }));
const R = await import("@/lib/rubrics/readers/stay-record");
const REC = await import("@/lib/rubrics/evr/record");
const E = await import("@/lib/rubrics/engines/ehrc");
const LLM = await import("@/lib/rubrics/llm");
const { getRubric } = await import("@/lib/rubrics/registry");
const rubric = getRubric("ehrc_surgical_outcome")!;

type Row = Record<string, unknown>;
const uidOf = (n: number) => `Stay${String(n).padStart(3, "0")}AaaaaaaaaaaaaaaaaZ`; // 20+ letters/digits
const DISCHARGE = "2026-09-10T10:00:00Z";
const day = (n: number) => new Date(Date.parse(DISCHARGE) + n * 86_400_000).toISOString();

type Stay = { ot?: Row[]; discharge?: Row | null; cdmss?: Row | null; followups?: Row[]; missing?: boolean };
let stays = new Map<string, Stay>();
const sqls: string[] = [];
const rec = (uid: string, at: string, o: Row = {}): Row => ({ rec_uid: `rec_${uid}_${at}`, uploaded_at: at, exam: "", complaints: [{ symptoms: "knee pain", diagnoses: [{ diagnosis_or_impression: "post operative knee", is_differential_diagnosis: false }] }], plan: [], ai_meta: {}, meds: [], investigations: [], refer_to: [], advice: [], ...o });

function fake(q: string): Promise<Row[]> {
  sqls.push(q);
  const ids = [...q.matchAll(/'([A-Za-z0-9]{20,40})'/g)].map((m) => m[1]!);
  const rows: Row[] = [];
  for (const id of ids) {
    const s = stays.get(id);
    if (!s || s.missing) continue;
    if (/FROM kx_ip_admissions a\s+JOIN kx_discharge_summary_records d[\s\S]*individuals-prescriptions/.test(q)) for (const f of s.followups ?? []) rows.push({ stay_uid: id, ...f });
    else if (/JOIN kx_clinical_template_ot_notes/.test(q)) for (const o of s.ot ?? []) rows.push({ stay_uid: id, ...o });
    else if (/JOIN kx_discharge_summary_records d ON d\.ipd_no/.test(q)) { if (s.discharge !== null) rows.push({ stay_uid: id, ...(s.discharge ?? { discharged_at: DISCHARGE, discharge_type: "home" }) }); }
    else if (/JOIN cdmss_discharge_extracts/.test(q)) { if (s.cdmss !== null) rows.push({ stay_uid: id, procedure_text: "", indication_text: "painful knee, failed conservative care", diagnosis_text: "", course_summary: "uneventful", disposition_text: "home", follow_up_text: "review in two weeks", aftercare_instructions: "", aftercare_warning_signs: "", ...(s.cdmss ?? {}) }); }
    else if (/FROM kx_ip_admissions a\s+WHERE a\.uid IN/.test(q)) rows.push({ stay_uid: id, admitted_at: "2026-09-05T04:00:00Z", admission_type: "elective", department: "orthopaedics", encounter_id: `enc_${id}` });
  }
  return Promise.resolve(rows);
}
const KNEE: Row = { surgery_name: "Total knee replacement", template_name: "OT note", created_at: "2026-09-06T05:00:00Z", note: "uneventful procedure" };
const modelSays = (v: Record<string, unknown>) => LLM.setRubricChatForTests(async () => ({ content: JSON.stringify({ label: "unscored", negative_signals: [], same_problem: [], planned_staging: false, better_or_no_complaint: false, escalate: false, ...v }), model: "fake/model", latency_ms: 1 }));
let calls = 0;
beforeEach(() => { stays = new Map(); sqls.length = 0; calls = 0; REC.setMetabaseForTests(fake); LLM.setRubricChatForTests(null); });

describe("PHI rule and joins (the SQL text)", () => {
  const ids = [uidOf(1), uidOf(2)];
  const all = () => [R.admissionsSql(ids), R.theatreSql(ids), R.dischargeSql(ids), R.cdmssSql(ids), R.followUpSql(ids)];
  it("no name / mobile / telecom / address / kin / birth / policy / payer / MLC column is selected; uhid, kx_uhid and the ipd number appear only inside a JOIN condition", () => {
    const FORBIDDEN = ["name", "patient_name", "first_name", "last_name", "full_name", "mobile", "mobile_number", "phone", "telecom", "address", "kin", "next_of_kin", "birth_date", "birth", "dob", "policy", "policy_number", "payer", "mlc", "mlc_remark", "uhid", "kx_uhid", "identifier", "ipd_no", "member_uid"];
    for (const q of all()) {
      const list = q.slice(q.indexOf("SELECT") + 6, q.search(/\n\s*FROM /));
      const cols = [...list.matchAll(/(?:[a-z]\.)?([a-z_]+)(?:\s+AS\s+[a-z_]+)?\s*(?:,|$)/gi)].map((m) => m[1]!.toLowerCase());
      for (const f of FORBIDDEN) expect(list.toLowerCase().split(/[^a-z_]+/), `${f} in a SELECT list`).not.toContain(f);
      expect(cols.length).toBeGreaterThan(0);
      for (const line of q.split("\n")) if (/uhid|a\.identifier|ipd_no/.test(line)) expect(line, "identifier outside a JOIN").toMatch(/^\s*JOIN /);
      expect(q).not.toMatch(/member_uid/);
    }
  });
  it("the patient bridge is a.uhid = individuals.kx_uhid -> individuals.uid = prescriptions._parent_doc_id (never member_uid); discharge by ipd_no = a.identifier; OT notes and cdmss by encounter_id; EMR_2_GENERATED non-draft; the 60-day bound", () => {
    expect(R.followUpSql(ids)).toMatch(/JOIN individuals i ON i\.kx_uhid = a\.uhid\s+JOIN "individuals-prescriptions" p ON p\._parent_doc_id = i\.uid/);
    expect(R.followUpSql(ids)).toMatch(/p\.type = 'EMR_2_GENERATED' AND p\.is_draft = false/);
    expect(R.followUpSql(ids)).toMatch(/p\.uploaded_at > d\.discharge_date_time AND p\.uploaded_at <= d\.discharge_date_time \+ interval '60 days'/);
    expect(R.dischargeSql(ids)).toMatch(/d\.ipd_no = a\.identifier/);
    expect(R.theatreSql(ids)).toMatch(/o\.encounter_id = a\.encounter_id/);
    expect(R.cdmssSql(ids)).toMatch(/c\.encounter_id = a\.encounter_id/);
  });
  it("a uid is validated before it is inlined", () => {
    expect(() => R.admissionsSql(["x'; DROP TABLE y; --"])).toThrow();
    expect(R.parseStayKey("stay:abc")).toBeNull();
    expect(R.parseStayKey(`stay:${uidOf(1)}`)).toBe(uidOf(1));
  });
  it("no output field carries a person's name, a number or an identifier: the reader's object and the engine's score / findings / evidence", async () => {
    stays.set(uidOf(1), { ot: [KNEE], followups: [rec(uidOf(1), day(10))] });
    modelSays({ label: "positive", same_problem: [true], better_or_no_complaint: true, evidence: [{ item: "better", quote: "knee pain" }] });
    const got = await R.readStayRecord(`stay:${uidOf(1)}`);
    expect(got.ok).toBe(true);
    const out = await E.evaluateEhrc(rubric, `stay:${uidOf(1)}`);
    const keys = (v: unknown, acc: string[] = []): string[] => { if (Array.isArray(v)) v.forEach((x) => keys(x, acc)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.push(k); keys(x, acc); } return acc; };
    for (const k of [...keys(got.ok ? got.data : {}), ...keys(out.score), ...keys(out.evidence)]) expect(k, k).not.toMatch(/uhid|identifier|ipd_no|mobile|phone|telecom|address|birth|policy|payer|mlc|member|^kin$/i);
    expect(JSON.stringify(out)).not.toMatch(/enc_Stay/); // the encounter id is not returned either
  });
});

describe("the window class table (CODE)", () => {
  it("joints / ligament / flap / fusion 28 d; tonsil 14 d; hernia / fistula / day-case 14 d; stones 28 d; anything else null", () => {
    const c = (t: string) => E.windowClassOf([t]);
    expect(c("Total knee replacement")).toEqual({ id: "joint_ligament_flap_fusion", days: 28 });
    expect(c("ACL reconstruction")).toEqual({ id: "joint_ligament_flap_fusion", days: 28 });
    expect(c("Lumbar spinal fusion")).toEqual({ id: "joint_ligament_flap_fusion", days: 28 });
    expect(c("Free flap cover")).toEqual({ id: "joint_ligament_flap_fusion", days: 28 });
    expect(c("Tonsillectomy")).toEqual({ id: "tonsil", days: 14 });
    expect(c("Inguinal hernia repair")).toEqual({ id: "general_day_case", days: 14 });
    expect(c("Fistulectomy")).toEqual({ id: "general_day_case", days: 14 });
    expect(c("Laparoscopic cholecystectomy")).toEqual({ id: "general_day_case", days: 14 }); // a gallbladder STONE is general surgery, not the urinary class
    expect(c("Ureteroscopic lithotripsy with stent")).toEqual({ id: "stones", days: 28 });
    expect(c("Cataract surgery")).toBeNull();
    expect(c("")).toBeNull();
    expect(E.windowClassOf([null, undefined])).toBeNull();
    expect(E.windowClassOf(["OT note", "Total hip replacement"])).toEqual({ id: "joint_ligament_flap_fusion", days: 28 }); // any of the texts
  });
});

describe("the rules CODE applies after the model", () => {
  const P = (o: Partial<import("@/lib/rubrics/engines/ehrc").Proposal> = {}) => ({ label: "unscored" as const, negative_signals: [], same_problem: [], planned_staging: false, better_or_no_complaint: false, escalate: false, ...o });
  it("silence, or no same-problem record, is never positive; positive needs a same-problem record that is better / without complaint", () => {
    expect(E.applyOutcomeRules(P({ label: "positive" }), 0)).toMatchObject({ label: "unscored", reason: "no_same_problem_record_in_window" });
    expect(E.applyOutcomeRules(P({ label: "positive", same_problem: [false, false], better_or_no_complaint: true }), 2)).toMatchObject({ label: "unscored", reason: "no_same_problem_record_in_window" });
    expect(E.applyOutcomeRules(P({ label: "positive", same_problem: [true], better_or_no_complaint: false }), 1)).toMatchObject({ label: "unscored", reason: "not_better_or_complaint" });
    expect(E.applyOutcomeRules(P({ label: "positive", same_problem: [true], better_or_no_complaint: true }), 1)).toMatchObject({ label: "positive", reason: null, n_same_problem: 1 });
    // flags beyond the number of records are ignored
    expect(E.applyOutcomeRules(P({ label: "positive", same_problem: [false, true], better_or_no_complaint: true }), 1)).toMatchObject({ label: "unscored" });
  });
  it("a negative code is negative (even if the model said positive); planned staging makes it neutral_protocol; a negative label without a code is unscored; unknown codes are dropped", () => {
    for (const code of E.NEGATIVE_CODES) expect(E.applyOutcomeRules(P({ label: "positive", negative_signals: [code], same_problem: [true], better_or_no_complaint: true }), 1)).toMatchObject({ label: "negative", codes: [code] });
    expect(E.applyOutcomeRules(P({ label: "negative", negative_signals: ["ssi_pus"], planned_staging: true }), 1)).toMatchObject({ label: "neutral_protocol", reason: "planned_staging" });
    expect(E.applyOutcomeRules(P({ label: "negative" }), 1)).toMatchObject({ label: "unscored", reason: "negative_without_code" });
    expect(E.applyOutcomeRules(P({ label: "positive", negative_signals: ["made_up"], same_problem: [true], better_or_no_complaint: true }), 1)).toMatchObject({ label: "positive", codes: [] });
    expect(E.applyOutcomeRules(P({ label: "neutral_protocol" }), 0)).toMatchObject({ label: "neutral_protocol" });
    expect(E.applyOutcomeRules(P({ escalate: true }), 0)).toMatchObject({ escalate: true });
  });
});

describe("the engine on a fake warehouse and a fake model", () => {
  const key = (n: number) => `stay:${uidOf(n)}`;
  const count = () => { let n = 0; LLM.setRubricChatForTests(async (a) => { n++; void a; return { content: JSON.stringify({ label: "positive", negative_signals: [], same_problem: [true], planned_staging: false, better_or_no_complaint: true, escalate: false }), model: "fake/model", latency_ms: 1 }; }); return () => n; };
  it("a stay with no theatre note is skipped not_surgical with ZERO model calls", async () => {
    stays.set(uidOf(1), { ot: [], followups: [rec(uidOf(1), day(5))] });
    const n = count();
    expect(await E.evaluateEhrc(rubric, key(1))).toMatchObject({ status: "skipped", reason: "not_surgical", calls: 0 });
    expect(n()).toBe(0);
  });
  it("an unknown procedure is label unscored (window_unknown) with ZERO model calls; so is a stay with no discharge date; an unknown stay is not_found", async () => {
    stays.set(uidOf(1), { ot: [{ ...KNEE, surgery_name: "Cataract surgery" }], followups: [rec(uidOf(1), day(5))] });
    stays.set(uidOf(2), { ot: [KNEE], discharge: { discharged_at: null, discharge_type: null } });
    stays.set(uidOf(3), { missing: true });
    const n = count();
    expect(await E.evaluateEhrc(rubric, key(1))).toMatchObject({ status: "ok", score: { label: "unscored", reason: "window_unknown", window_class: "unknown" }, calls: 0 });
    expect(await E.evaluateEhrc(rubric, key(2))).toMatchObject({ status: "ok", score: { label: "unscored", reason: "no_discharge_date" }, calls: 0 });
    expect(await E.evaluateEhrc(rubric, key(3))).toMatchObject({ status: "skipped", reason: "not_found" });
    expect(n()).toBe(0);
  });
  it("only follow-up records inside the class window count: an out-of-window record is never shown to the model and cannot make a positive", async () => {
    stays.set(uidOf(1), { ot: [KNEE], followups: [rec(uidOf(1), day(40))] }); // knee: 28 d; the only record is on day 40
    const seen: string[] = [];
    LLM.setRubricChatForTests(async (a) => { seen.push(String((a as { user?: string }).user ?? "")); return { content: JSON.stringify({ label: "positive", negative_signals: [], same_problem: [], planned_staging: false, better_or_no_complaint: true, escalate: false }), model: "fake/model", latency_ms: 1 }; });
    const out = await E.evaluateEhrc(rubric, key(1));
    expect(out).toMatchObject({ status: "ok", score: { label: "unscored", reason: "no_same_problem_record_in_window", n_followups_in_window: 0, window_class: "joint_ligament_flap_fusion", window_days: 28 } });
    expect(seen[0]).toContain("INSIDE THE WINDOW (0)");
    expect(seen[0]).not.toContain("R1 (");
    // a 14-day class drops a day-20 record that a 28-day class keeps
    stays.set(uidOf(2), { ot: [{ ...KNEE, surgery_name: "Inguinal hernia repair" }], followups: [rec(uidOf(2), day(20))] });
    stays.set(uidOf(3), { ot: [KNEE], followups: [rec(uidOf(3), day(20))] });
    expect(await E.evaluateEhrc(rubric, key(2))).toMatchObject({ score: { n_followups_in_window: 0, window_days: 14 } });
    modelSays({ label: "positive", same_problem: [true], better_or_no_complaint: true });
    expect(await E.evaluateEhrc(rubric, key(3))).toMatchObject({ score: { n_followups_in_window: 1, window_days: 28 } });
  });
  it("silence never positive; a same-problem clean record is positive; negative codes are negative; planned staging is neutral; escalate passes through; the score and findings are codes (no text)", async () => {
    stays.set(uidOf(1), { ot: [KNEE], followups: [rec(uidOf(1), day(10))] });
    modelSays({ label: "positive", same_problem: [true], better_or_no_complaint: false });
    expect(await E.evaluateEhrc(rubric, key(1))).toMatchObject({ score: { label: "unscored", reason: "not_better_or_complaint" } });
    modelSays({ label: "positive", same_problem: [false], better_or_no_complaint: true });
    expect(await E.evaluateEhrc(rubric, key(1))).toMatchObject({ score: { label: "unscored", reason: "no_same_problem_record_in_window" } });
    modelSays({ label: "positive", same_problem: [true], better_or_no_complaint: true, evidence: [{ item: "better", quote: "knee pain" }, { item: "x", quote: "this is not in the record" }] });
    const pos = await E.evaluateEhrc(rubric, key(1));
    expect(pos).toMatchObject({ status: "ok", score: { label: "positive", n_same_problem: 1, cm_questions: "not_read" }, findings: ["label:positive"], calls: 1 });
    expect((pos.evidence as { quotes: unknown[]; quotes_dropped_not_in_record: number }).quotes).toEqual([{ item: "better", quote: "knee pain" }]);
    expect((pos.evidence as { quotes_dropped_not_in_record: number }).quotes_dropped_not_in_record).toBe(1);
    modelSays({ label: "positive", negative_signals: ["ssi_pus", "fever"], same_problem: [true], better_or_no_complaint: true, escalate: true });
    expect(await E.evaluateEhrc(rubric, key(1))).toMatchObject({ score: { label: "negative", negative_signals: ["ssi_pus", "fever"], escalate: true }, findings: ["label:negative", "neg:ssi_pus", "neg:fever", "escalate"] });
    modelSays({ label: "negative", negative_signals: ["return_to_theatre"], planned_staging: true, same_problem: [true] });
    expect(await E.evaluateEhrc(rubric, key(1))).toMatchObject({ score: { label: "neutral_protocol", planned_staging: true } });
    expect(JSON.stringify((await E.evaluateEhrc(rubric, key(1))).score)).not.toMatch(/knee|uneventful/);
  });
  it("the model must return one same_problem flag per follow-up record; a wrong count is retried once, then the unit fails (closed reason)", async () => {
    stays.set(uidOf(1), { ot: [KNEE], followups: [rec(uidOf(1), day(10)), rec(uidOf(1), day(12))] });
    let n = 0;
    LLM.setRubricChatForTests(async () => { n++; return { content: JSON.stringify({ label: "positive", negative_signals: [], same_problem: [true], planned_staging: false, better_or_no_complaint: true, escalate: false }), model: "m", latency_ms: 1 }; });
    expect(await E.evaluateEhrc(rubric, key(1))).toMatchObject({ status: "failed", reason: "llm_schema_invalid", calls: 2 });
    expect(n).toBe(2);
  });
});

describe("batching: one SELECT per table per batch of at most 40 stays", () => {
  it("40 stays read through withStayBatch = 5 SELECTs (admissions, theatre, discharge, cdmss, follow-up), not 200; a 41st uid is not in the batch", async () => {
    const uids = Array.from({ length: 41 }, (_, i) => uidOf(i + 1));
    for (const u of uids) stays.set(u, { ot: [KNEE], followups: [rec(u, day(10))] });
    modelSays({ label: "unscored" });
    await R.withStayBatch(uids, async () => { for (const u of uids.slice(0, 40)) await E.evaluateEhrc(rubric, `stay:${u}`); });
    expect(sqls).toHaveLength(5);
    expect(sqls.filter((q) => /kx_clinical_template_ot_notes/.test(q))).toHaveLength(1);
    expect(sqls.filter((q) => /individuals-prescriptions/.test(q))).toHaveLength(1);
    expect(sqls.filter((q) => /cdmss_discharge_extracts/.test(q))).toHaveLength(1);
    expect(sqls.filter((q) => /kx_discharge_summary_records d ON d\.ipd_no = a\.identifier\n WHERE/.test(q))).toHaveLength(1);
    expect(sqls[0]!.match(/'[A-Za-z0-9]{20,40}'/g)).toHaveLength(R.STAY_BATCH_MAX);
    expect(sqls[0]).not.toContain(`'${uids[40]}'`);
    // outside a batch each stay is its own batch of one
    sqls.length = 0;
    await E.evaluateEhrc(rubric, `stay:${uids[0]}`);
    await E.evaluateEhrc(rubric, `stay:${uids[1]}`);
    expect(sqls).toHaveLength(10);
  });
});
