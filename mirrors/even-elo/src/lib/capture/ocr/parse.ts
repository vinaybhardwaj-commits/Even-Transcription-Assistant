import { OT_TRACKING_SHEET_PROMPT_VERSION } from "../prompts/ot-tracking-sheet-v1";

/** Below this extract confidence, the capture stays needs_review and a human edits the sheet. */
export const EXTRACT_REVIEW_BELOW = 0.72;
/** A non-sheet this confident is classified and left out of the human OT-sheet queue. */
export const CLASSIFY_OTHER_CONFIDENT = 0.8;

export const SHEET_TEXT_FIELDS = [
  "uhid",
  "ip_no",
  "patient_name",
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
] as const;

export type SheetTextField = (typeof SHEET_TEXT_FIELDS)[number];

export interface NormalizedSheet {
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
  equipment_json: { notes: string } | null;
  notes_json: { text?: string; raw_surgery_date?: string } | null;
  review_status: "pending_human";
  prompt_version: typeof OT_TRACKING_SHEET_PROMPT_VERSION;
}

export type CaptureOcrStatus = "classified" | "extracted" | "needs_review" | "failed";

export interface OcrDecision {
  status: CaptureOcrStatus;
  docType: string | null;
  classifyConfidence: number | null;
  extractConfidence: number | null;
  extractJson: unknown;
  error: string | null;
  sheet: NormalizedSheet | null;
}

export type ClassifyParse =
  | { ok: true; docType: "ot_tracking_sheet" | "unknown"; confidence: number | null }
  | { ok: false; error: string };

export type ExtractParse =
  | { ok: true; confidence: number | null; sheet: NormalizedSheet; raw: unknown }
  | { ok: false; error: string };

const TIME_FIELDS = new Set<SheetTextField>([
  "antibiotic_at",
  "scheduled_at",
  "wheel_in",
  "sign_in",
  "induction",
  "time_out",
  "incision",
  "closure",
  "sign_out",
  "wheel_out",
]);

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("no json object");
  }
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

export function readConfidence(value: unknown): number | null {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return readConfidence(Number.isFinite(parsed) ? parsed : null);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scaled = value > 1 && value <= 100 ? value / 100 : value;
  if (scaled < 0 || scaled > 1) return null;
  return Math.round(scaled * 1000) / 1000;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "—" || cleaned === "-" || cleaned.toLowerCase() === "null") return null;
  return cleaned.slice(0, max);
}

/** Minutes from midnight, or null when the clock is not readable. */
export function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase().replace(/\./g, ":").replace(/\s+/g, " ");
  const ampm = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2] == null ? 0 : Number(ampm[2]);
    if (hour > 12 || minute > 59) return null;
    if (ampm[3] === "pm" && hour < 12) hour += 12;
    if (ampm[3] === "am" && hour === 12) hour = 0;
    return hour * 60 + minute;
  }
  const hm = text.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }
  const compact = text.match(/^(\d{3,4})$/);
  if (compact) {
    const digits = compact[1]!.padStart(4, "0");
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2));
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }
  return null;
}

export function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** EHRC dates are day-first when both numbers could be a day or a month. */
export function parseSurgeryDate(value: unknown): string | null {
  const text = cleanText(value, 40);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const ymd = text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (ymd) return isoDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  const named = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase()];
    if (!month) return null;
    return isoDate(Number(named[3]), month, Number(named[1]));
  }
  const numeric = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
  if (!numeric) return null;
  const a = Number(numeric[1]);
  const b = Number(numeric[2]);
  let year = Number(numeric[3]);
  if (year < 100) year += 2000;
  if (a > 12 && b <= 12) return isoDate(year, b, a);
  if (b > 12 && a <= 12) return isoDate(year, a, b);
  return isoDate(year, b, a);
}

function normalizeTimeField(value: unknown): string | null {
  const text = cleanText(value, 40);
  if (!text) return null;
  const minutes = parseClock(text);
  return minutes == null ? text : formatClock(minutes);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseClassify(raw: string): ClassifyParse {
  let value: unknown;
  try {
    value = extractJsonObject(raw);
  } catch {
    return { ok: false, error: "classifier JSON failed" };
  }
  const record = asRecord(value);
  if (!record) return { ok: false, error: "classifier JSON failed" };
  const doc = cleanText(record.doc_type, 40)?.toLowerCase() ?? "";
  const docType = doc === "ot_tracking_sheet" ? "ot_tracking_sheet" : "unknown";
  return { ok: true, docType, confidence: readConfidence(record.confidence) };
}

function notesFrom(record: Record<string, unknown>, rawDate: string | null, parsedDate: string | null): NormalizedSheet["notes_json"] {
  const text = cleanText(record.notes, 2000);
  const raw = !parsedDate && rawDate ? rawDate : null;
  if (!text && !raw) return null;
  return {
    ...(text ? { text } : {}),
    ...(raw ? { raw_surgery_date: raw } : {}),
  };
}

export function parseExtract(raw: string): ExtractParse {
  let value: unknown;
  try {
    value = extractJsonObject(raw);
  } catch {
    return { ok: false, error: "extract JSON failed" };
  }
  const record = asRecord(value);
  if (!record) return { ok: false, error: "extract JSON failed" };
  const fields = asRecord(record.fields) ?? record;
  const rawDate = cleanText(fields.surgery_date, 40);
  const surgeryDate = parseSurgeryDate(rawDate);
  const sheet = {
    review_status: "pending_human",
    prompt_version: OT_TRACKING_SHEET_PROMPT_VERSION,
    surgery_date: surgeryDate,
  } as NormalizedSheet;
  for (const key of SHEET_TEXT_FIELDS) {
    sheet[key] = TIME_FIELDS.has(key) ? normalizeTimeField(fields[key]) : cleanText(fields[key], key === "antibiotic" || key === "surgery_name" ? 400 : 240);
  }
  const equipment = cleanText(record.equipment_notes, 2000);
  sheet.equipment_json = equipment ? { notes: equipment } : null;
  sheet.notes_json = notesFrom(record, rawDate, surgeryDate);
  return { ok: true, confidence: readConfidence(record.confidence), sheet, raw: value };
}

function emptyDecision(status: CaptureOcrStatus, error: string | null): OcrDecision {
  return {
    status,
    docType: null,
    classifyConfidence: null,
    extractConfidence: null,
    extractJson: null,
    error,
    sheet: null,
  };
}

/**
 * Map model output to a capture status. A usable OT sheet is always
 * review_status pending_human. This never returns a surgical case id.
 */
export function decideOcr(input: {
  unsupportedReason?: string | null;
  vertexError?: string | null;
  classify?: ClassifyParse | null;
  extract?: ExtractParse | null;
  extractJson?: unknown;
}): OcrDecision {
  if (input.vertexError) {
    return emptyDecision("failed", input.vertexError.slice(0, 280));
  }
  if (input.unsupportedReason) {
    return { ...emptyDecision("needs_review", input.unsupportedReason.slice(0, 280)), docType: null };
  }
  const classify = input.classify;
  if (!classify || !classify.ok) {
    return emptyDecision("needs_review", classify?.error ?? "classifier JSON failed");
  }
  if (classify.docType !== "ot_tracking_sheet") {
    const confident = (classify.confidence ?? 0) >= CLASSIFY_OTHER_CONFIDENT;
    return {
      status: confident ? "classified" : "needs_review",
      docType: "unknown",
      classifyConfidence: classify.confidence,
      extractConfidence: null,
      extractJson: input.extractJson ?? null,
      error: confident ? null : "not an OT tracking sheet",
      sheet: null,
    };
  }
  const extract = input.extract;
  if (!extract || !extract.ok) {
    return {
      status: "needs_review",
      docType: "ot_tracking_sheet",
      classifyConfidence: classify.confidence,
      extractConfidence: null,
      extractJson: input.extractJson ?? null,
      error: extract?.error ?? "extract JSON failed",
      sheet: null,
    };
  }
  const sheet = extract.sheet;
  const thin = !sheet.patient_name && !sheet.surgery_name && !sheet.uhid;
  const low = extract.confidence == null || extract.confidence < EXTRACT_REVIEW_BELOW;
  return {
    status: thin || low ? "needs_review" : "extracted",
    docType: "ot_tracking_sheet",
    classifyConfidence: classify.confidence,
    extractConfidence: extract.confidence,
    extractJson: input.extractJson ?? extract.raw,
    error: thin ? "extract missed patient, surgery, and UHID" : low ? "extract confidence below review threshold" : null,
    sheet,
  };
}
