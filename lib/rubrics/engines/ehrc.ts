/**
 * lib/rubrics/engines/ehrc.ts — S7-3: ehrc_surgical_outcome (llm_zdr, DRAFT, lab only). One surgical STAY -> a label (positive | negative | neutral_protocol | unscored).
 *
 * THE MODEL PROPOSES, CODE DECIDES. Before any model call, CODE: the stay must have a theatre note (else skipped not_surgical, 0 calls); the procedure's window class comes from a keyword table over the
 * theatre note's surgery name and the cdmss procedure (unknown class: label unscored, reason window_unknown, 0 calls); a stay with no discharge date has no window (unscored, 0 calls). Only outpatient
 * records inside the class window after the discharge count. The model (askJson, the existing ZDR door, the same call ceilings) reads, in the rubric's read_order, the indication, the theatre note, the
 * discharge and the numbered follow-up records, and returns a proposed label, closed negative-signal codes, a same-problem flag per record, planned_staging, better_or_no_complaint, escalate and quotes.
 * AFTER the model, CODE (applyOutcomeRules): silence or no same-problem record in the window is never positive (unscored); the care-manager questions are not read, so positive needs a same-problem record
 * in the window that documents no complaint or better; a negative code makes the label negative unless planned staging is stated (then neutral_protocol); a negative label with no code is unscored.
 * rubric_result gets the label, the codes, the window class and counts (no text). E3-1 (PHI): NO note text is stored anywhere. The model's short quote is LOCATED in the source text it was shown; only {item (a closed
 * enum), source, record_ref (an opaque, validated row uid), field, start, end} (character offsets into that source text) are kept. The quote string itself never reaches R2, the table, a log or the tool output; a quote
 * that cannot be located is dropped and counted (quote_unlocated).
 */
import { createHash } from "node:crypto";
import type { Rubric } from "../types";
import { askJson } from "../llm";
import { promptVersion, systemPrompt } from "./consult-llm";
import { cleanRef, readStayRecord, type StayRecord } from "../readers/stay-record";
import type { EngineResult } from "./types";

export const NEGATIVE_CODES = ["ssi_pus", "fever", "spreading_redness", "return_to_theatre", "complication_documented"] as const;
export type NegativeCode = (typeof NEGATIVE_CODES)[number];
/** E3-1: the only values an evidence `item` may take. Anything else the model writes is stored as "other". */
export const EVIDENCE_ITEMS = [...NEGATIVE_CODES, "indication", "procedure", "discharge_course", "follow_up_better", "follow_up_complaint", "planned_staging", "other"] as const;
export type EvidenceItem = (typeof EVIDENCE_ITEMS)[number];
export const normItem = (v: unknown): EvidenceItem => (typeof v === "string" && (EVIDENCE_ITEMS as readonly string[]).includes(v) ? (v as EvidenceItem) : "other");
export const EVIDENCE_SOURCES = ["theatre", "discharge_summary", "cdmss", "follow_up"] as const;
export type Section = { source: (typeof EVIDENCE_SOURCES)[number]; ref: string | null; field: string; text: string };
export type EvidenceRef = { item: EvidenceItem; source: Section["source"]; record_ref: string; field: string; start: number; end: number };
/**
 * E3-5: a stored record_ref is NEVER the warehouse uid (a uid can be name-shaped): it is the first 24 hex of sha256("ehrc-ref:" + uid). To relocate a ref, re-hash the candidate uids you already hold and compare.
 * Every reader (safeStayEvidence, so results include_text) drops a record_ref that is not exactly 24 lowercase hex characters, legacy objects included.
 */
export const REF_HASH_RE = /^[0-9a-f]{24}$/;
export const refOf = (uid: string): string => createHash("sha256").update(`ehrc-ref:${uid}`, "utf8").digest("hex").slice(0, 24);
/** PURE — where a quote sits in the sections the model was shown (case-insensitive, first hit); null = cannot be located. Returns offsets and an opaque ref, never the text. */
export function locateQuote(item: unknown, quote: unknown, sections: readonly Section[]): EvidenceRef | null {
  const q = typeof quote === "string" ? quote.trim().toLowerCase() : "";
  if (q.length < 3) return null;
  for (const sec of sections) {
    if (!sec.ref) continue; // a section without a validated row uid cannot be referred to
    const at = sec.text.toLowerCase().indexOf(q);
    if (at >= 0) return { item: normItem(item), source: sec.source, record_ref: refOf(sec.ref), field: sec.field, start: at, end: at + q.length };
  }
  return null;
}
/** PURE — the only shape of stay evidence that may be shown or returned: every other key (and any legacy text field) is dropped. */
export function safeStayEvidence(ev: unknown): Record<string, unknown> | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as Record<string, unknown>;
  const refs = Array.isArray(e.refs) ? (e.refs as Array<Record<string, unknown>>).map((r) => ({ item: normItem(r?.item), source: (EVIDENCE_SOURCES as readonly string[]).includes(String(r?.source)) ? r.source : "other", record_ref: typeof r?.record_ref === "string" && REF_HASH_RE.test(r.record_ref) ? r.record_ref : null, field: typeof r?.field === "string" && /^[a-z_]{1,40}$/.test(r.field) ? r.field : null, start: Number.isInteger(r?.start) ? r.start : null, end: Number.isInteger(r?.end) ? r.end : null })) : [];
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { model: typeof e.model === "string" ? e.model.slice(0, 80) : null, prompt_version: typeof e.prompt_version === "string" ? e.prompt_version.slice(0, 20) : null, attempts: num(e.attempts), window_class: typeof e.window_class === "string" ? e.window_class.slice(0, 40) : null, window_days: num(e.window_days),
    n_theatre_notes: num(e.n_theatre_notes), n_followups_in_window: num(e.n_followups_in_window), theatre_truncated: e.theatre_truncated === true, follow_up_truncated: e.follow_up_truncated === true, refs, quote_unlocated: num(e.quote_unlocated) };
}

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

/** The user message, in the rubric's read order (indication, theatre record, discharge, follow-up records), AND the sections it was built from (the texts a quote can be located in). Deterministic. */
export function renderStaySections(stay: StayRecord, records: InWindow): { user: string; sections: Section[] } {
  const adm = stay.admission;
  const c = stay.cdmss;
  const sections: Section[] = [];
  const sec = (source: Section["source"], ref: string | null, field: string, text: string): string => { sections.push({ source, ref, field, text }); return text; };
  const parts = [
    "PRE-OPERATIVE INDICATION", `admission: ${adm.admission_type ?? "-"}, ${adm.department ?? "-"}`, sec("cdmss", c?.ref ?? null, "indication", clip(c?.indication || c?.diagnosis || "-", 3000)), "",
    "THEATRE RECORD", ...stay.theatre.map((o) => `${o.surgery_name || o.template_name || "-"} (day ${dayOffset(o.created_at, adm.admitted_at) ?? "?"} after admission)\n${sec("theatre", o.ref, "note", clip(o.note || "-", 4000))}`), "",
    "DISCHARGE", `type: ${stay.discharge?.discharge_type ?? "-"}`, `procedure: ${sec("cdmss", c?.ref ?? null, "procedure", clip(c?.procedure || "-", 800))}`, `course: ${sec("cdmss", c?.ref ?? null, "course_summary", clip(c?.course_summary || "-", 3000))}`,
    `disposition: ${sec("cdmss", c?.ref ?? null, "disposition", clip(c?.disposition || "-", 600))}`, `follow-up advised: ${sec("cdmss", c?.ref ?? null, "follow_up", clip(c?.follow_up || "-", 800))}`,
    `aftercare: ${sec("cdmss", c?.ref ?? null, "aftercare_instructions", clip(c?.aftercare_instructions || "-", 1000))}`, `warning signs: ${sec("cdmss", c?.ref ?? null, "aftercare_warning_signs", clip(c?.aftercare_warning_signs || "-", 800))}`, "",
    "POST-DISCHARGE QUESTIONS", "not read in this slice", "",
    `OUTPATIENT FOLLOW-UP RECORDS INSIDE THE WINDOW (${records.length})`, ...(records.length === 0 ? ["none"] : records.map((r, i) => sec("follow_up", cleanRefOf(r.rec_uid), "record", renderRecord(r, i, stay.discharge?.discharged_at ?? null)))),
  ];
  return { user: parts.join("\n"), sections };
}
export const renderStay = (stay: StayRecord, records: InWindow): string => renderStaySections(stay, records).user;
const cleanRefOf = (v: string): string | null => cleanRef(v);

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
  const { user, sections } = renderStaySections(stay, recs);
  const out = await askJson({
    system: systemPrompt(r), user, schema: r.output as Record<string, unknown>,
    extraValidate: (v) => (Array.isArray(v.same_problem) && v.same_problem.length !== recs.length ? [`$.same_problem: needs ${recs.length} entries, one per follow-up record`] : []),
  });
  if (!out.ok) return withDate({ status: "failed", findings: [], reason: out.reason, evidence: { prompt_version: promptVersion(r), model: out.model, attempts: out.attempts }, calls: out.attempts });
  const v = out.value;
  const prop: Proposal = { label: v.label as OutcomeLabel, negative_signals: (v.negative_signals as string[]) ?? [], same_problem: (v.same_problem as boolean[]) ?? [], planned_staging: v.planned_staging === true, better_or_no_complaint: v.better_or_no_complaint === true, escalate: v.escalate === true };
  const dec = applyOutcomeRules(prop, recs.length);
  // E3-1: locate each quote in the sections shown to the model; keep only {item, source, record_ref, field, start, end}. The quote text and the model's free-text item are discarded here.
  const quotes = Array.isArray(v.evidence) ? (v.evidence as Array<{ item?: unknown; quote?: unknown }>) : [];
  const refs: EvidenceRef[] = [];
  let unlocated = 0;
  for (const q of quotes) { const at = locateQuote(q?.item, q?.quote, sections); if (at) refs.push(at); else unlocated += 1; }
  const findings = [`label:${dec.label}`, ...dec.codes.map((c) => `neg:${c}`), ...(dec.reason ? [`reason:${dec.reason}`] : []), ...(dec.escalate ? ["escalate"] : []), ...(stay.theatre_truncated ? ["truncated:theatre"] : []), ...(stay.follow_up_truncated ? ["truncated:follow_up"] : [])];
  return withDate({
    status: "ok",
    score: { label: dec.label, negative_signals: dec.codes, window_class: cls.id, window_days: cls.days, n_followups_in_window: recs.length, n_same_problem: dec.n_same_problem, planned_staging: prop.planned_staging, escalate: dec.escalate, theatre_truncated: stay.theatre_truncated, follow_up_truncated: stay.follow_up_truncated, ...(dec.reason ? { reason: dec.reason } : {}), model_label: prop.label, attempts: out.attempts, ...base },
    findings,
    evidence: { model: out.model, prompt_version: promptVersion(r), attempts: out.attempts, window_class: cls.id, window_days: cls.days, n_theatre_notes: stay.theatre.length, n_followups_in_window: recs.length, theatre_truncated: stay.theatre_truncated, follow_up_truncated: stay.follow_up_truncated, refs, quote_unlocated: unlocated },
    calls: out.attempts,
  });
}
