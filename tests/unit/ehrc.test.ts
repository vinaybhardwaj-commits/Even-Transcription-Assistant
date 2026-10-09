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
const rec = (uid: string, at: string, o: Row = {}): Row => ({ rec_uid: `rec_${uid}_${at.replace(/[^0-9]/g, "")}`, uploaded_at: at, exam: "", complaints: [{ symptoms: "knee pain", diagnoses: [{ diagnosis_or_impression: "post operative knee", is_differential_diagnosis: false }] }], plan: [], ai_meta: {}, meds: [], investigations: [], refer_to: [], advice: [], ...o });

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
    else if (/JOIN cdmss_discharge_extracts/.test(q)) { if (s.cdmss !== null) rows.push({ stay_uid: id, cdmss_uid: "cdmss_1", procedure_text: "", indication_text: "painful knee, failed conservative care", diagnosis_text: "", course_summary: "uneventful", disposition_text: "home", follow_up_text: "review in two weeks", aftercare_instructions: "", aftercare_warning_signs: "", ...(s.cdmss ?? {}) }); }
    else if (/FROM kx_ip_admissions a\s+WHERE a\.uid IN/.test(q)) rows.push({ stay_uid: id, admitted_at: "2026-09-05T04:00:00Z", admission_type: "elective", department: "orthopaedics", encounter_id: `enc_${id}` });
  }
  return Promise.resolve(rows);
}
const KNEE: Row = { note_uid: "otnote_1", surgery_name: "Total knee replacement", template_name: "OT note", created_at: "2026-09-06T05:00:00Z", note: "uneventful procedure" };
const modelSays = (v: Record<string, unknown>) => LLM.setRubricChatForTests(async () => ({ content: JSON.stringify({ label: "unscored", negative_signals: [], same_problem: [], planned_staging: false, better_or_no_complaint: false, escalate: false, ...v }), model: "fake/model", latency_ms: 1 }));
let calls = 0;
beforeEach(() => { stays = new Map(); sqls.length = 0; calls = 0; REC.setMetabaseForTests(fake); LLM.setRubricChatForTests(null); });

describe("PHI rule and joins (the SQL text)", () => {
  const ids = [uidOf(1), uidOf(2)];
  const all = () => [R.admissionsSql(ids), R.theatreSql(ids), R.dischargeSql(ids), R.cdmssSql(ids), R.followUpSql(ids)];
  it("no name / mobile / telecom / address / kin / birth / policy / payer / MLC column is selected; uhid, kx_uhid and the ipd number appear only inside a JOIN condition", () => {
    const FORBIDDEN = ["name", "patient_name", "first_name", "last_name", "full_name", "mobile", "mobile_number", "phone", "telecom", "address", "kin", "next_of_kin", "birth_date", "birth", "dob", "policy", "policy_number", "payer", "mlc", "mlc_remark", "uhid", "kx_uhid", "identifier", "ipd_no", "member_uid"];
    for (const q of all()) {
      // EVERY select list of the statement (the outer one and the row_number() subquery's)
      const lists = [...q.matchAll(/SELECT([\s\S]*?)\n?\s*FROM /g)].map((m) => m[1]!);
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) for (const f of FORBIDDEN) expect(list.toLowerCase().split(/[^a-z_]+/), `${f} in a SELECT list`).not.toContain(f);
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
    // E3-1: no quote text; a located reference (closed item, source, opaque ref, offsets); the unlocatable one is counted
    const ev = pos.evidence as { refs: Array<Record<string, unknown>>; quote_unlocated: number };
    expect(ev.refs).toEqual([{ item: "other", source: "follow_up", record_ref: E.refOf(`rec_${uidOf(1)}_${day(10).replace(/[^0-9]/g, "")}`), field: "record", start: expect.any(Number), end: expect.any(Number) }]);
    expect(ev.quote_unlocated).toBe(1);
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
    expect(sqls.filter((q) => /PARTITION BY a\.uid ORDER BY d\.discharge_date_time DESC/.test(q))).toHaveLength(1);
    expect(sqls[0]!.match(/'[A-Za-z0-9]{20,40}'/g)).toHaveLength(R.STAY_BATCH_MAX);
    expect(sqls[0]).not.toContain(`'${uids[40]}'`);
    // outside a batch each stay is its own batch of one
    sqls.length = 0;
    await E.evaluateEhrc(rubric, `stay:${uids[0]}`);
    await E.evaluateEhrc(rubric, `stay:${uids[1]}`);
    expect(sqls).toHaveLength(10);
  });
});

const key1 = () => `stay:${uidOf(1)}`;
const NAME = "Zorbel Quintaglio"; // a stand-in patient name and a number shaped like a hospital id: they appear in the theatre note and are echoed by the model
const HOSPITAL_ID = "ZQ-48152-93";
describe("E3-1 PHI: stay evidence carries NO note text", () => {
  const spyLogs = () => ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m as "log").mockImplementation(() => undefined));
  const everything = (out: unknown, spies: Array<{ mock: { calls: unknown[][] } }>) => JSON.stringify([out, spies.map((s) => s.mock.calls)]);
  it("the refuter's case: a theatre note holding a name and an id-shaped number, a model that echoes both in `item` and in `quote`: neither string is in the evidence, the score, the findings or the logs; the refs are located by offsets", async () => {
    const note = `Patient ${NAME} (${HOSPITAL_ID}) underwent total knee replacement. Wound dry.`;
    stays.set(uidOf(1), { ot: [{ ...KNEE, note }], followups: [rec(uidOf(1), day(10))] });
    const spies = spyLogs();
    LLM.setRubricChatForTests(async () => ({ content: JSON.stringify({ label: "positive", negative_signals: [], same_problem: [true], planned_staging: false, better_or_no_complaint: true, escalate: false,
      evidence: [{ item: `${NAME} ${HOSPITAL_ID}`, quote: `${NAME} (${HOSPITAL_ID})` }, { item: "fever", quote: "Wound dry" }, { item: "indication", quote: "failed conservative care" }, { item: "x", quote: "text that is not in the record" }] }), model: "fake/model", latency_ms: 1 }));
    const out = await E.evaluateEhrc(rubric, key1());
    const all = everything(out, spies);
    expect(all).not.toContain(NAME);
    expect(all).not.toContain(HOSPITAL_ID);
    expect(all).not.toMatch(/Wound dry|failed conservative|Zorbel/i);
    const ev = out.evidence as { refs: Array<{ item: string; source: string; record_ref: string; field: string; start: number; end: number }>; quote_unlocated: number };
    // the name+id quote IS in the note, so it is located (offsets only); its item was free text, so it is stored as "other"
    expect(ev.refs[0]).toEqual({ item: "other", source: "theatre", record_ref: E.refOf("otnote_1"), field: "note", start: note.toLowerCase().indexOf(NAME.toLowerCase()), end: note.toLowerCase().indexOf(NAME.toLowerCase()) + `${NAME} (${HOSPITAL_ID})`.length });
    expect(ev.refs[1]).toMatchObject({ item: "fever", source: "theatre", field: "note" });
    expect(ev.refs[2]).toMatchObject({ item: "indication", source: "cdmss", record_ref: E.refOf("cdmss_1"), field: "indication" });
    expect(ev.refs).toHaveLength(3);
    expect(ev.quote_unlocated).toBe(1);
    for (const r of ev.refs) expect(Object.keys(r).sort()).toEqual(["end", "field", "item", "record_ref", "source", "start"]);
    spies.forEach((s) => (s as unknown as { mockRestore: () => void }).mockRestore());
  });
  it("item is a closed enum (anything else = other); a record whose row uid is not a clean id cannot be referred to, so its quote is unlocated", () => {
    for (const ok of E.EVIDENCE_ITEMS) expect(E.normItem(ok)).toBe(ok);
    for (const bad of ["Zorbel", "", null, undefined, 5, "FEVER", "knee pain"]) expect(E.normItem(bad)).toBe("other");
    const secs = [{ source: "theatre" as const, ref: null, field: "note", text: "wound dry" }, { source: "follow_up" as const, ref: "rec_1", field: "record", text: "knee pain better" }];
    expect(E.locateQuote("x", "wound dry", secs)).toBeNull(); // null ref
    expect(E.locateQuote("follow_up_better", "KNEE PAIN", secs)).toEqual({ item: "follow_up_better", source: "follow_up", record_ref: E.refOf("rec_1"), field: "record", start: 0, end: 9 });
    expect(E.locateQuote("x", "ab", secs)).toBeNull(); // too short
    expect(E.locateQuote("x", 42, secs)).toBeNull();
  });
  it("safeStayEvidence (what results include_text returns) is a whitelist: legacy text fields, quotes and unknown keys are dropped", () => {
    const view = E.safeStayEvidence({ model: "m", prompt_version: "0.2.1", attempts: 1, quotes: [{ item: NAME, quote: HOSPITAL_ID }], note: NAME, refs: [{ item: NAME, source: "theatre", record_ref: E.refOf("otnote_1"), field: "note", start: 1, end: 5, quote: NAME }, { item: "fever", source: "elsewhere", record_ref: `bad ref ${NAME}`, field: NAME, start: 1.5, end: "x" }] });
    const s = JSON.stringify(view);
    expect(s).not.toContain(NAME);
    expect(s).not.toContain(HOSPITAL_ID);
    expect(view).toMatchObject({ refs: [{ item: "other", source: "theatre", record_ref: E.refOf("otnote_1"), field: "note", start: 1, end: 5 }, { item: "fever", source: "other", record_ref: null, field: null, start: null, end: null }] });
    expect(E.safeStayEvidence(null)).toBeNull();
  });
});

describe("E3-3: no silent truncation (per-stay limits, flagged)", () => {
  it("more than 5 theatre notes or 10 follow-up records: only the first are used and the stay says so (score + finding); within the limits the flags are false", async () => {
    const ot = Array.from({ length: 6 }, (_, i) => ({ ...KNEE, note_uid: `ot_${i}`, created_at: `2026-09-06T0${i}:00:00Z` }));
    const fu = Array.from({ length: 11 }, (_, i) => rec(uidOf(1), day(1 + i)));
    stays.set(uidOf(1), { ot, followups: fu });
    stays.set(uidOf(2), { ot: [KNEE], followups: [rec(uidOf(2), day(3))] });
    modelSays({ label: "unscored", same_problem: Array.from({ length: 10 }, () => false) });
    const big = await E.evaluateEhrc(rubric, key1());
    expect(big).toMatchObject({ score: { theatre_truncated: true, follow_up_truncated: true, n_followups_in_window: 10 }, findings: expect.arrayContaining(["truncated:theatre", "truncated:follow_up"]) });
    const got = await R.readStayRecord(key1());
    expect(got.ok && got.data.theatre).toHaveLength(5);
    expect(got.ok && got.data.follow_up).toHaveLength(10);
    modelSays({ label: "unscored", same_problem: [false] });
    expect(await E.evaluateEhrc(rubric, `stay:${uidOf(2)}`)).toMatchObject({ score: { theatre_truncated: false, follow_up_truncated: false } });
  });
  it("the limits are applied per STAY inside the SQL (row_number() OVER (PARTITION BY stay)), one extra row fetched, with no LIMIT over the whole batch", () => {
    const ids = [uidOf(1), uidOf(2)];
    expect(R.theatreSql(ids)).toMatch(/row_number\(\) OVER \(PARTITION BY a\.uid ORDER BY o\.created_at, o\.uid\)[\s\S]*WHERE t\.rn <= 6\b/);
    expect(R.followUpSql(ids)).toMatch(/row_number\(\) OVER \(PARTITION BY a\.uid ORDER BY p\.uploaded_at, p\.uid\)[\s\S]*WHERE t\.rn <= 11\b/);
    expect(R.dischargeSql(ids)).toMatch(/PARTITION BY a\.uid ORDER BY d\.discharge_date_time DESC[\s\S]*WHERE t\.rn = 1/);
    expect(R.cdmssSql(ids)).toMatch(/PARTITION BY a\.uid[\s\S]*WHERE t\.rn = 1/);
    for (const q of [R.theatreSql(ids), R.dischargeSql(ids), R.cdmssSql(ids), R.followUpSql(ids)]) expect(q).not.toMatch(/\bLIMIT\b/);
  });
});

describe("E3-4: the from/to span is at most 31 dates inclusive", () => {
  it("31 dates (to - from = 30 days) is accepted, 32 dates is range_too_long", async () => {
    const { resolveUnits } = await import("@/lib/rubrics/engines");
    REC.setMetabaseForTests(async () => []);
    expect(await resolveUnits(rubric, "stay", { from: "2026-09-01", to: "2026-10-01", limit: 50 })).toMatchObject({ keys: [] }); // 31 dates
    expect(await resolveUnits(rubric, "stay", { from: "2026-09-01", to: "2026-10-02", limit: 50 })).toMatchObject({ error: "range_too_long" }); // 32 dates
    expect(await resolveUnits(rubric, "stay", { from: "2026-09-01", to: "2026-09-01", limit: 50 })).toMatchObject({ keys: [] });
  });
});

describe("E3-5: record_ref is never the warehouse uid", () => {
  const NAMEY = "Zorbel_Quintaglio_4815"; // a uid shaped like a person's name: it passes the old clean-id check
  it("the refuter's case: note, cdmss and follow-up row uids that look like a name never appear in the evidence; refs are 24 hex characters of sha256('ehrc-ref:' + uid)", async () => {
    const note = "Wound dry and clean, knee moving well.";
    stays.set(uidOf(1), { ot: [{ ...KNEE, note_uid: NAMEY, note }], cdmss: { cdmss_uid: `${NAMEY}_c`, indication_text: "painful knee" }, followups: [{ ...rec(uidOf(1), day(10)), rec_uid: `${NAMEY}_r` }] });
    LLM.setRubricChatForTests(async () => ({ content: JSON.stringify({ label: "positive", negative_signals: [], same_problem: [true], planned_staging: false, better_or_no_complaint: true, escalate: false,
      evidence: [{ item: "fever", quote: "Wound dry" }, { item: "indication", quote: "painful knee" }, { item: "follow_up_better", quote: "knee pain" }] }), model: "fake/model", latency_ms: 1 }));
    const out = await E.evaluateEhrc(rubric, key1());
    const s = JSON.stringify(out);
    expect(s).not.toContain("Zorbel");
    expect(s).not.toContain("Quintaglio");
    const refs = (out.evidence as { refs: Array<{ record_ref: string }> }).refs;
    expect(refs.map((r) => r.record_ref)).toEqual([E.refOf(NAMEY), E.refOf(`${NAMEY}_c`), E.refOf(`${NAMEY}_r`)]);
    for (const r of refs) expect(r.record_ref).toMatch(/^[0-9a-f]{24}$/);
    expect(E.refOf(NAMEY)).toBe((await import("node:crypto")).createHash("sha256").update(`ehrc-ref:${NAMEY}`).digest("hex").slice(0, 24));
    expect(E.refOf("a")).not.toBe(E.refOf("b"));
  });
  it("every reader drops a record_ref that is not 24 lowercase hex characters (a legacy name-shaped ref, upper case, a raw uid, 23 / 25 characters); a valid hash passes", () => {
    const mk = (record_ref: unknown) => ((E.safeStayEvidence({ refs: [{ item: "fever", source: "theatre", record_ref, field: "note", start: 1, end: 2 }] }) as { refs: Array<{ record_ref: string | null }> }).refs[0]!.record_ref);
    for (const bad of [NAMEY, "otnote_1", E.refOf("x").toUpperCase(), E.refOf("x").slice(1), `${E.refOf("x")}0`, "", null, 7, "../../etc"]) expect(mk(bad), String(bad)).toBeNull();
    expect(mk(E.refOf("x"))).toBe(E.refOf("x"));
    expect(JSON.stringify(E.safeStayEvidence({ refs: [{ item: "fever", source: "theatre", record_ref: NAMEY, field: "note", start: 1, end: 2 }] }))).not.toContain("Zorbel");
  });
});
