import { parseClock, parseSurgeryDate, type SheetTextField, SHEET_TEXT_FIELDS } from "./ocr/parse";
import { captureProvenance, formatCaptureWhen } from "./present";
import { sanitizeFreeText } from "./provenance";
import { ABX_LATE_LABEL, ABX_ON_TIME_LABEL, CASE_LINK_LABEL, SHEET_FORM_FIELDS, type SheetFormField } from "./sheet-form";

export { ABX_LATE_LABEL, ABX_ON_TIME_LABEL, CASE_LINK_LABEL, SHEET_FORM_FIELDS };
export type { SheetFormField };

export const SHEET_REVIEW_FILTERS = ["all", "pending_human", "approved", "rejected"] as const;
export type SheetReviewFilter = (typeof SHEET_REVIEW_FILTERS)[number];

export function isSheetReviewFilter(value: string): value is SheetReviewFilter {
  return (SHEET_REVIEW_FILTERS as readonly string[]).includes(value);
}

export function cleanSheetQuery(raw: string): string {
  return raw.replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function todayIst(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function formatSheetDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(date)
    .replace("Sept", "Sep");
}

export function formatSheetDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Antibiotic given from 0 to 60 minutes before incision. */
export function abxOnTime(antibioticAt: string | null | undefined, incision: string | null | undefined): boolean {
  const antibiotic = parseClock(antibioticAt);
  const cut = parseClock(incision);
  if (antibiotic == null || cut == null) return false;
  let delta = cut - antibiotic;
  if (delta < -12 * 60) delta += 24 * 60;
  if (delta > 12 * 60) delta -= 24 * 60;
  return delta >= 0 && delta <= 60;
}

export function abxLabel(antibioticAt: string | null | undefined, incision: string | null | undefined): string {
  return abxOnTime(antibioticAt, incision) ? ABX_ON_TIME_LABEL : ABX_LATE_LABEL;
}

export interface SheetStatRow {
  review_status: string;
  surgery_date: string | null;
  antibiotic_at: string | null;
  incision: string | null;
}

export interface SheetStats {
  sheets_today: number;
  needs_review: number;
  approved: number;
  abx_on_time: number;
  abx_total: number;
  abx_label: string;
}

export function summarizeSheets(rows: readonly SheetStatRow[], today = todayIst()): SheetStats {
  let sheetsToday = 0;
  let needsReview = 0;
  let approved = 0;
  let onTime = 0;
  let total = 0;
  for (const row of rows) {
    if (row.review_status === "pending_human") needsReview += 1;
    if (row.review_status === "approved") approved += 1;
    if (row.review_status === "rejected") continue;
    if (row.surgery_date && row.surgery_date.slice(0, 10) === today) sheetsToday += 1;
    total += 1;
    if (abxOnTime(row.antibiotic_at, row.incision)) onTime += 1;
  }
  return {
    sheets_today: sheetsToday,
    needs_review: needsReview,
    approved,
    abx_on_time: onTime,
    abx_total: total,
    abx_label: total === 0 ? "—" : `${onTime}/${total}`,
  };
}

const BLOCKED_EDIT_KEYS = new Set([
  "surgical_case_id",
  "review_status",
  "capture_id",
  "id",
  "hospital_code",
  "ot_on_time",
  "ot_equipment_protocol",
  "ot_overrun_minutes",
  "case_observations",
]);

export interface SheetEdits {
  texts: Partial<Record<SheetTextField, string | null>>;
  surgery_date: string | null | undefined;
  equipment_notes: string | null | undefined;
  notes: string | null | undefined;
}

export function parseSheetEdits(body: unknown): { ok: true; edits: SheetEdits } | { ok: false; error: string } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const source = record && record.fields && typeof record.fields === "object" ? (record.fields as Record<string, unknown>) : record;
  if (!source) return { ok: false, error: "Expected a fields object." };
  for (const key of Object.keys(source)) {
    if (BLOCKED_EDIT_KEYS.has(key)) {
      return { ok: false, error: `${key} is not written from sheet review.` };
    }
  }
  const edits: SheetEdits = { texts: {}, surgery_date: undefined, equipment_notes: undefined, notes: undefined };
  for (const key of SHEET_TEXT_FIELDS) {
    if (!(key in source)) continue;
    const max = key === "antibiotic" || key === "surgery_name" ? 400 : 240;
    edits.texts[key] = sanitizeFreeText(source[key], max);
  }
  if ("surgery_date" in source) {
    const raw = source.surgery_date;
    if (raw == null || raw === "") {
      edits.surgery_date = null;
    } else {
      const parsed = parseSurgeryDate(raw);
      if (!parsed) return { ok: false, error: "Surgery date must be a real date (DD/MM/YYYY)." };
      edits.surgery_date = parsed;
    }
  }
  if ("equipment_notes" in source) {
    edits.equipment_notes = sanitizeFreeText(source.equipment_notes, 2000);
  }
  if ("notes" in source) {
    edits.notes = sanitizeFreeText(source.notes, 2000);
  }
  return { ok: true, edits };
}

export function notesText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const text = (value as { text?: unknown; notes?: unknown }).text ?? (value as { notes?: unknown }).notes;
  return typeof text === "string" ? text : "";
}

export function equipmentText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const text = (value as { notes?: unknown }).notes;
  return typeof text === "string" ? text : "";
}

function asConfidence(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 1000) / 1000;
}

function asIso(value: Date | string | null | undefined): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export interface PublicSheetListItem {
  id: string;
  capture_id: string;
  hospital_code: string;
  surgery_date_label: string;
  ot_no: string | null;
  surgeon_name: string | null;
  surgery_name: string | null;
  patient_name: string | null;
  review_status: string;
  capture_status: string;
  abx_label: string;
  abx_on_time: boolean;
}

export function toPublicSheetListItem(row: {
  id: string;
  capture_id: string;
  hospital_code: string;
  surgery_date: string | null;
  ot_no: string | null;
  surgeon_name: string | null;
  surgery_name: string | null;
  patient_name: string | null;
  antibiotic_at: string | null;
  incision: string | null;
  review_status: string;
  capture_status: string;
}): PublicSheetListItem {
  const onTime = abxOnTime(row.antibiotic_at, row.incision);
  return {
    id: row.id,
    capture_id: row.capture_id,
    hospital_code: row.hospital_code,
    surgery_date_label: formatSheetDate(row.surgery_date),
    ot_no: row.ot_no,
    surgeon_name: row.surgeon_name,
    surgery_name: row.surgery_name,
    patient_name: row.patient_name,
    review_status: row.review_status,
    capture_status: row.capture_status,
    abx_label: abxLabel(row.antibiotic_at, row.incision),
    abx_on_time: onTime,
  };
}

export interface PublicSheetDetail {
  id: string;
  capture_id: string;
  hospital_code: string;
  review_status: string;
  capture_status: string;
  doc_type: string | null;
  prompt_version: string;
  classify_confidence: number | null;
  extract_confidence: number | null;
  fields: Record<SheetFormField["key"], string>;
  abx_label: string;
  abx_on_time: boolean;
  image_path: string;
  content_type: string;
  provenance: string;
  uploaded_by: string | null;
  uploaded_at: string;
  title: string;
  case_link_label: typeof CASE_LINK_LABEL;
  surgical_case_id: null;
  review_note: string | null;
  editable: boolean;
}

export function toPublicSheetDetail(row: {
  id: string;
  capture_id: string;
  hospital_code: string;
  uhid: string | null;
  ip_no: string | null;
  patient_name: string | null;
  surgery_date: string | null;
  ot_no: string | null;
  anesthesia: string | null;
  surgery_name: string | null;
  surgeon_name: string | null;
  asst_surgeon: string | null;
  anesthetist: string | null;
  antibiotic: string | null;
  antibiotic_at: string | null;
  scrub_nurse: string | null;
  technician: string | null;
  circulating_nurse: string | null;
  scheduled_at: string | null;
  wheel_in: string | null;
  sign_in: string | null;
  induction: string | null;
  time_out: string | null;
  incision: string | null;
  closure: string | null;
  sign_out: string | null;
  wheel_out: string | null;
  equipment_json: unknown;
  notes_json: unknown;
  review_status: string;
  classify_confidence: number | string | null;
  extract_confidence: number | string | null;
  prompt_version: string;
  review_note: string | null;
  capture_status: string;
  content_type: string;
  uploaded_by: string | null;
  uploaded_at: Date | string;
  user_agent: string | null;
  ip_hash: string | null;
  doc_type: string | null;
}): PublicSheetDetail {
  const fields = {
    patient_name: row.patient_name ?? "",
    uhid: row.uhid ?? "",
    ip_no: row.ip_no ?? "",
    surgery_date: formatSheetDateInput(row.surgery_date),
    ot_no: row.ot_no ?? "",
    anesthesia: row.anesthesia ?? "",
    surgery_name: row.surgery_name ?? "",
    surgeon_name: row.surgeon_name ?? "",
    asst_surgeon: row.asst_surgeon ?? "",
    anesthetist: row.anesthetist ?? "",
    antibiotic: row.antibiotic ?? "",
    antibiotic_at: row.antibiotic_at ?? "",
    scrub_nurse: row.scrub_nurse ?? "",
    technician: row.technician ?? "",
    circulating_nurse: row.circulating_nurse ?? "",
    scheduled_at: row.scheduled_at ?? "",
    wheel_in: row.wheel_in ?? "",
    sign_in: row.sign_in ?? "",
    induction: row.induction ?? "",
    time_out: row.time_out ?? "",
    incision: row.incision ?? "",
    closure: row.closure ?? "",
    sign_out: row.sign_out ?? "",
    wheel_out: row.wheel_out ?? "",
    equipment_notes: equipmentText(row.equipment_json),
    notes: notesText(row.notes_json),
  };
  const who = row.patient_name?.trim() || row.surgery_name?.trim() || "OT sheet";
  return {
    id: row.id,
    capture_id: row.capture_id,
    hospital_code: row.hospital_code,
    review_status: row.review_status,
    capture_status: row.capture_status,
    doc_type: row.doc_type,
    prompt_version: row.prompt_version,
    classify_confidence: asConfidence(row.classify_confidence),
    extract_confidence: asConfidence(row.extract_confidence),
    fields,
    abx_label: abxLabel(row.antibiotic_at, row.incision),
    abx_on_time: abxOnTime(row.antibiotic_at, row.incision),
    image_path: `/api/capture/${row.capture_id}/image`,
    content_type: row.content_type,
    provenance: captureProvenance({ userAgent: row.user_agent, ipHash: row.ip_hash }),
    uploaded_by: row.uploaded_by,
    uploaded_at: formatCaptureWhen(asIso(row.uploaded_at)),
    title: who,
    case_link_label: CASE_LINK_LABEL,
    surgical_case_id: null,
    review_note: row.review_note,
    editable: row.review_status === "pending_human",
  };
}

export function publicSheetLeaksCaptureSecrets(sheet: PublicSheetDetail): boolean {
  const serialized = JSON.stringify(sheet);
  return serialized.includes("blob") || serialized.includes("ip_hash") || serialized.includes("ot-captures/");
}

/** Columns this stage inserts. surgical_case_id is intentionally absent. */
export const SHEET_INSERT_COLUMNS = [
  "capture_id",
  "hospital_code",
  "uhid",
  "ip_no",
  "patient_name",
  "surgery_date",
  "ot_no",
  "anesthesia",
  "surgery_name",
  "surgeon_name",
  "asst_surgeon",
  "anesthetist",
  "antibiotic",
  "antibiotic_at",
  "scrub_nurse",
  "technician",
  "circulating_nurse",
  "scheduled_at",
  "wheel_in",
  "sign_in",
  "induction",
  "time_out",
  "incision",
  "closure",
  "sign_out",
  "wheel_out",
  "equipment_json",
  "notes_json",
  "review_status",
  "classify_confidence",
  "extract_confidence",
  "prompt_version",
] as const;
