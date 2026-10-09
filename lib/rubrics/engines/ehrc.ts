/**
 * lib/rubrics/engines/ehrc.ts — S7-3: ehrc_surgical_outcome (llm_zdr, DRAFT, lab only). One surgical STAY -> a label (positive | negative | neutral_protocol | unscored).
 *
 * THE MODEL PROPOSES, CODE DECIDES. Before any model call, CODE: the stay must have a theatre note (else skipped not_surgical, 0 calls); the procedure's window class comes from a keyword table over the
 * theatre note's surgery name and the cdmss procedure (unknown class: label unscored, reason window_unknown, 0 calls); a stay with no discharge date has no window (unscored, 0 calls). Only outpatient
 * records inside the class window after the discharge count. The model (askJson, the existing ZDR door, the same call ceilings) reads, in the rubric's read_order, the indication, the theatre note, the
 * discharge and the numbered follow-up records, and returns a proposed label, closed negative-signal codes, a same-problem flag per record, planned_staging, better_or_no_complaint, escalate and quotes.
 * AFTER the model, CODE (applyOutcomeRules): silence or no same-problem record in the window is never positive (unscored); the care-manager questions are not read, so positive needs a same-problem record
 * in the window that documents no complaint or better; a negative code makes the label negative unless planned staging is stated (then neutral_protocol); a negative label with no code is unscored.
 * rubric_result gets the label, the codes, the window class and counts (no text); every quote and the record values go only to the R2 evidence, and a quote not found in the stay record is dropped.
 */
import type { Rubric } from "../types";
import { askJson } from "../llm";
import { promptVersion, systemPrompt } from "./consult-llm";
import { readStayRecord, type StayRecord } from "../readers/stay-record";
import type { EngineResult } from "./types";

export const NEGATIVE_CODES = ["ssi_pus", "fever", "spreading_redness", "return_to_theatre", "complication_documented"] as const;
export type NegativeCode = (typeof NEGATIVE_CODES)[number];
export type OutcomeLabel = "positive" | "negative" | "neutral_protocol" | "unscored";

/** Window class table, in order: the FIRST class whose pattern matches the procedure text wins. Days are counted from the discharge. */
export const WINDOW_CLASSES: ReadonlyArray<{ id: string; days: number; re: RegExp }> = [
  { id: "tonsil", days: 14, re: /tonsil|adenoid/i },
  { id: "general_day_case", days: 14, re: /hernia|fistul|fissure|pilonidal|h(a)?emorrhoid|\bpiles\b|cholecyst|append(i)?(c)?ectomy|lipoma|circumcision|hydrocele|abscess/i },
  { id: "stones", days: 28, re: /lithotrip|litholapax|ureteroscop|pcnl|\brirs\b|calcul|\bstones?\b|\bstent\b|cystolitho/i },
  { id: "joint_ligament_flap_fusion", days: 28, re: /arthroplast|\bknee\b|\bhip\b|replacement|\bacl\b|\bpcl\b|ligament|reconstruct|arthroscop|\bflap\b|fusion|\bspine\b|spinal|discectomy|laminectomy|fixation|nailing|plating|osteotomy|meniscus|\bsco?pe\b/i },
];
export type WindowClass = { id: string; days: number } | null;
/** PURE — the class of a procedure, from the theatre surgery names and the cdmss procedure text; null = window_unknown. */
export function windowClassOf(texts: ReadonlyArray<string | null | undefined>): WindowClass {
  const t = texts.filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" \n ");
  if (!t) return null;
  for (const c of WINDOW_CLASSES) if (c.re.test(t)) return { id: c.id, days: c.days };
  return null;
}

export type Proposal = { label: OutcomeLabel; negative_signals: string[]; same_problem: boolean[]; planned_staging: boolean; better_or_no_complaint: boolean; escalate: boolean };
export type Decision = { label: OutcomeLabel; codes: NegativeCode[]; n_same_problem: number; reason: string | null; escalate: boolean };

/** PURE — the rules CODE applies after the model. */
export function applyOutcomeRules(m: Proposal, nRecords: number): Decision {
  const codes = [...new Set(m.negative_signals.filter((c): c is NegativeCode => (NEGATIVE_CODES as readonly string[]).includes(c)))];
  const nSame = m.same_problem.slice(0, nRecords).filter((x) => x === true).length;
  const base = { codes, n_same_problem: nSame, escalate: m.escalate === true };
  if (codes.length > 0) return m.planned_staging === true ? { ...base, label: "neutral_protocol", reason: "planned_staging" } : { ...base, label: "negative", reason: null };
  if (m.label === "negative") return { ...base, label: "unscored", reason: "negative_without_code" };
  if (m.label === "positive") {
    // silence, or no same-problem record inside the window, is never positive; the care-manager questions are not read, so a same-problem record with no complaint (or better) is required
    if (nSame === 0) return { ...base, label: "unscored", reason: "no_same_problem_record_in_window" };
    if (m.better_or_no_complaint !== true) return { ...base, label: "unscored", reason: "not_better_or_complaint" };
    return { ...base, label: "positive", reason: null };
  }
  return { ...base, label: m.label === "neutral_protocol" ? "neutral_protocol" : "unscored", reason: null };
}

const dayOffset = (iso: string | null, from: string | null): number | null => {
  const a = iso ? Date.parse(iso) : NaN, b = from ? Date.parse(from) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 86_400_000) : null;
};
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} [cut]` : s);

type InWindow = StayRecord["follow_up"];
/** PURE — only the outpatient records inside (discharge, discharge + class days]. */
export function recordsInWindow(stay: StayRecord, days: number): InWindow {
  const d = stay.discharge?.discharged_at ?? null;
  if (!d) return [];
  const lo = Date.parse(d), hi = lo + days * 86_400_000;
  return stay.follow_up.filter((f) => { const t = Date.parse(f.uploaded_at); return Number.isFinite(t) && t > lo && t <= hi; });
}

function renderRecord(r: InWindow[number], i: number, discharge: string | null): string {
  const n = r.record;
  const off = dayOffset(r.uploaded_at, discharge);
  return [`R${i + 1} (day ${off ?? "?"} after discharge)`, `complaints: ${n.complaints.join("; ") || "-"}`, `diagnoses: ${n.diagnoses.map((x) => x.name).join("; ") || "-"}`, `examination: ${n.exam || "-"}`,
    `plan/procedures: ${n.procedures.map((x) => x.name).join("; ") || "-"}`, `medications: ${n.meds.map((m) => m.name).join("; ") || "-"}`, `advice: ${n.advice || "-"}`, `follow-up: ${n.followup || "-"}`].join("\n");
}

/** The user message, in the rubric's read order: indication, theatre record, discharge, follow-up records. Deterministic. */
export function renderStay(stay: StayRecord, records: InWindow): string {
  const adm = stay.admission;
  const c = stay.cdmss;
  const parts = [
    "PRE-OPERATIVE INDICATION", `admission: ${adm.admission_type ?? "-"}, ${adm.department ?? "-"}`, clip(c?.indication || c?.diagnosis || "-", 3000), "",
    "THEATRE RECORD", ...stay.theatre.map((o) => `${o.surgery_name || o.template_name || "-"} (day ${dayOffset(o.created_at, adm.admitted_at) ?? "?"} after admission)\n${clip(o.note || "-", 4000)}`), "",
    "DISCHARGE", `type: ${stay.discharge?.discharge_type ?? "-"}`, `procedure: ${clip(c?.procedure || "-", 800)}`, `course: ${clip(c?.course_summary || "-", 3000)}`, `disposition: ${clip(c?.disposition || "-", 600)}`,
    `follow-up advised: ${clip(c?.follow_up || "-", 800)}`, `aftercare: ${clip(c?.aftercare_instructions || "-", 1000)}`, `warning signs: ${clip(c?.aftercare_warning_signs || "-", 800)}`, "",
    "POST-DISCHARGE QUESTIONS", "not read in this slice", "",
    `OUTPATIENT FOLLOW-UP RECORDS INSIDE THE WINDOW (${records.length})`, ...(records.length === 0 ? ["none"] : records.map((r, i) => renderRecord(r, i, stay.discharge?.discharged_at ?? null))),
  ];
  return parts.join("\n");
}

const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function evaluateEhrc(r: Rubric, stayKey: string): Promise<EngineResult & { ist_date?: string | null }> {
  const got = await readStayRecord(stayKey);
  if (!got.ok) return { status: "skipped", findings: [], reason: got.reason };
  const stay = got.data;
  const ist = stay.admission.ist_date;
  const withDate = <T extends EngineResult>(x: T): T & { ist_date: string | null } => ({ ...x, ist_date: ist });
  if (stay.theatre.length === 0) return withDate({ status: "skipped", findings: [], reason: "not_surgical", calls: 0 });
  const cls = windowClassOf([...stay.theatre.map((o) => o.surgery_name), stay.cdmss?.procedure]);
  const base = { cm_questions: "not_read" as const, prompt_version: promptVersion(r) };
  const unscored = (reason: string, extra: Record<string, unknown> = {}): EngineResult => ({
    status: "ok", score: { label: "unscored", negative_signals: [], reason, window_class: cls?.id ?? "unknown", ...extra, ...base }, findings: ["label:unscored", `reason:${reason}`], calls: 0,
  });
  if (!cls) return withDate(unscored("window_unknown"));
  if (!stay.discharge?.discharged_at) return withDate(unscored("no_discharge_date"));
  const recs = recordsInWindow(stay, cls.days);
  const user = renderStay(stay, recs);
  const out = await askJson({
    system: systemPrompt(r), user, schema: r.output as Record<string, unknown>,
    extraValidate: (v) => (Array.isArray(v.same_problem) && v.same_problem.length !== recs.length ? [`$.same_problem: needs ${recs.length} entries, one per follow-up record`] : []),
  });
  if (!out.ok) return withDate({ status: "failed", findings: [], reason: out.reason, evidence: { prompt_version: promptVersion(r), model: out.model, attempts: out.attempts }, calls: out.attempts });
  const v = out.value;
  const prop: Proposal = { label: v.label as OutcomeLabel, negative_signals: (v.negative_signals as string[]) ?? [], same_problem: (v.same_problem as boolean[]) ?? [], planned_staging: v.planned_staging === true, better_or_no_complaint: v.better_or_no_complaint === true, escalate: v.escalate === true };
  const dec = applyOutcomeRules(prop, recs.length);
  const source = norm(user);
  const quotes = ((v.evidence as Array<{ item: string; quote: string }> | undefined) ?? []);
  const kept = quotes.filter((q) => norm(q.quote).length >= 3 && source.includes(norm(q.quote)));
  const findings = [`label:${dec.label}`, ...dec.codes.map((c) => `neg:${c}`), ...(dec.reason ? [`reason:${dec.reason}`] : []), ...(dec.escalate ? ["escalate"] : [])];
  return withDate({
    status: "ok",
    score: { label: dec.label, negative_signals: dec.codes, window_class: cls.id, window_days: cls.days, n_followups_in_window: recs.length, n_same_problem: dec.n_same_problem, planned_staging: prop.planned_staging, escalate: dec.escalate, ...(dec.reason ? { reason: dec.reason } : {}), model_label: prop.label, attempts: out.attempts, ...base },
    findings,
    evidence: { model: out.model, prompt_version: promptVersion(r), attempts: out.attempts, window_class: cls.id, window_days: cls.days, n_theatre_notes: stay.theatre.length, n_followups_in_window: recs.length, quotes: kept, quotes_dropped_not_in_record: quotes.length - kept.length },
    calls: out.attempts,
  });
}
