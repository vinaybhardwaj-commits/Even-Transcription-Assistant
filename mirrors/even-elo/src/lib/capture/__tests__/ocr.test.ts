import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@/lib/migrations";
import { isOtCaptureOcrEnabled } from "../access";
import { decideOcr, parseClassify, parseClock, parseExtract, parseSurgeryDate, SHEET_TEXT_FIELDS } from "../ocr/parse";
import { clampOcrLimit } from "../ocr/run";
import {
  CLASSIFY_SYSTEM,
  EXTRACT_SYSTEM,
  OT_TRACKING_SHEET_PROMPT_VERSION,
} from "../prompts/ot-tracking-sheet-v1";
import { SHEET_FORM_FIELDS } from "../sheet-form";
import {
  abxOnTime,
  parseSheetEdits,
  publicSheetLeaksCaptureSecrets,
  SHEET_INSERT_COLUMNS,
  summarizeSheets,
  toPublicSheetDetail,
} from "../sheets";
import { toPublicCapture } from "../present";

const GOOD_EXTRACT = JSON.stringify({
  confidence: 0.94,
  fields: {
    uhid: "EHRC-18492",
    ip_no: "IP-7721",
    patient_name: "Sample Patient",
    surgery_date: "18/09/2026",
    ot_no: "OT-3",
    anesthesia: "GA",
    surgery_name: "Hysteroscopy",
    surgeon_name: "Dr A Sharma",
    asst_surgeon: null,
    anesthetist: "Dr P Nair",
    antibiotic: "Inj. Cefuroxime 1.5g",
    antibiotic_at: "08:40",
    scrub_nurse: "S Devi",
    technician: null,
    circulating_nurse: "R Joseph",
    scheduled_at: "08:00",
    wheel_in: "08:25",
    sign_in: "08:30",
    induction: "08:35",
    time_out: "08:50",
    incision: "09:05",
    closure: "09:48",
    sign_out: "09:55",
    wheel_out: "10:05",
  },
  equipment_notes: "hysteroscope",
  notes: "uneventful",
});

describe("FEATURE_OT_CAPTURE_OCR", () => {
  it("is on only for exact true", () => {
    expect(isOtCaptureOcrEnabled({ FEATURE_OT_CAPTURE_OCR: "true" })).toBe(true);
    expect(isOtCaptureOcrEnabled({ FEATURE_OT_CAPTURE_OCR: " true " })).toBe(true);
    expect(isOtCaptureOcrEnabled({})).toBe(false);
    expect(isOtCaptureOcrEnabled({ FEATURE_OT_CAPTURE_OCR: "false" })).toBe(false);
    expect(isOtCaptureOcrEnabled({ FEATURE_OT_CAPTURE_OCR: "1" })).toBe(false);
    expect(isOtCaptureOcrEnabled({ FEATURE_OT_CAPTURE_OCR: "TRUE" })).toBe(false);
    expect(isOtCaptureOcrEnabled({ FEATURE_OT_CAPTURE: "true" })).toBe(false);
  });
});

describe("OT sheet prompts", () => {
  it("asks for strict JSON and does not bake sample patients", () => {
    expect(OT_TRACKING_SHEET_PROMPT_VERSION).toBe("ot-tracking-sheet-v1");
    expect(CLASSIFY_SYSTEM).toMatch(/JSON/);
    expect(EXTRACT_SYSTEM).toMatch(/null/);
    expect(CLASSIFY_SYSTEM + EXTRACT_SYSTEM).not.toMatch(/Pinky|Samantaray|Praveena|Ranka/);
  });
});

describe("classify and extract parsing", () => {
  it("reads fenced JSON and day-first dates", () => {
    const parsed = parseClassify('```json\n{"doc_type":"ot_tracking_sheet","confidence":94}\n```');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.docType).toBe("ot_tracking_sheet");
      expect(parsed.confidence).toBe(0.94);
    }
    expect(parseSurgeryDate("18/09/2026")).toBe("2026-09-18");
    expect(parseSurgeryDate("2026-09-18")).toBe("2026-09-18");
    expect(parseSurgeryDate("18 Sep 2026")).toBe("2026-09-18");
    expect(parseClock("08:40")).toBe(8 * 60 + 40);
    expect(parseClock("8.40 am")).toBe(8 * 60 + 40);
    expect(parseClock("9:05 pm")).toBe(21 * 60 + 5);
  });

  it("normalizes a valid extract and keeps review pending", () => {
    const extract = parseExtract(GOOD_EXTRACT);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    expect(extract.sheet.review_status).toBe("pending_human");
    expect(extract.sheet.surgery_date).toBe("2026-09-18");
    expect(extract.sheet.incision).toBe("09:05");
    expect(extract.sheet.antibiotic_at).toBe("08:40");
    expect(extract.sheet.equipment_json).toEqual({ notes: "hysteroscope" });
    expect("surgical_case_id" in extract.sheet).toBe(false);
  });

  it("fails closed on prose", () => {
    expect(parseExtract("this is not json").ok).toBe(false);
    expect(parseClassify("unknown page").ok).toBe(false);
  });
});

describe("OCR decision", () => {
  it("extracts an OT sheet for human review and does not link a case", () => {
    const decision = decideOcr({
      classify: parseClassify('{"doc_type":"ot_tracking_sheet","confidence":0.91}'),
      extract: parseExtract(GOOD_EXTRACT),
    });
    expect(decision.status).toBe("extracted");
    expect(decision.docType).toBe("ot_tracking_sheet");
    expect(decision.sheet?.review_status).toBe("pending_human");
    expect(decision.sheet && "surgical_case_id" in decision.sheet).toBe(false);
    expect(JSON.stringify(decision)).not.toMatch(/surgical_cases|ot_on_time|case_observations/);
  });

  it("keeps a low-confidence sheet in needs_review", () => {
    const extract = parseExtract(GOOD_EXTRACT.replace("0.94", "0.4"));
    const decision = decideOcr({
      classify: parseClassify('{"doc_type":"ot_tracking_sheet","confidence":0.9}'),
      extract,
    });
    expect(decision.status).toBe("needs_review");
    expect(decision.sheet?.patient_name).toBe("Sample Patient");
  });

  it("does not create a sheet when the page is not an OT tracking sheet", () => {
    const decision = decideOcr({
      classify: parseClassify('{"doc_type":"consent","confidence":0.88}'),
    });
    expect(decision.status).toBe("classified");
    expect(decision.docType).toBe("unknown");
    expect(decision.sheet).toBeNull();
  });

  it("sends a parse failure to needs_review and a vertex error to failed", () => {
    const broken = decideOcr({
      classify: parseClassify('{"doc_type":"ot_tracking_sheet","confidence":0.8}'),
      extract: parseExtract("nope"),
    });
    expect(broken.status).toBe("needs_review");
    expect(broken.sheet).toBeNull();
    const failed = decideOcr({ vertexError: "Vertex request failed" });
    expect(failed.status).toBe("failed");
    expect(failed.sheet).toBeNull();
  });
});

describe("antibiotic timing and sheet stats", () => {
  it("counts antibiotic within 60 minutes before incision", () => {
    expect(abxOnTime("08:40", "09:05")).toBe(true);
    expect(abxOnTime("07:00", "09:05")).toBe(false);
    expect(abxOnTime("09:10", "09:05")).toBe(false);
    expect(abxOnTime(null, "09:05")).toBe(false);
  });

  it("summarizes today, review, and the on-time ratio", () => {
    const stats = summarizeSheets(
      [
        { review_status: "pending_human", surgery_date: "2026-09-27", antibiotic_at: "08:40", incision: "09:05" },
        { review_status: "approved", surgery_date: "2026-09-18", antibiotic_at: "08:40", incision: "09:05" },
        { review_status: "rejected", surgery_date: "2026-09-27", antibiotic_at: "08:40", incision: "09:05" },
        { review_status: "approved", surgery_date: "2026-09-18", antibiotic_at: "09:30", incision: "09:05" },
      ],
      "2026-09-27",
    );
    expect(stats.sheets_today).toBe(1);
    expect(stats.needs_review).toBe(1);
    expect(stats.approved).toBe(2);
    expect(stats.abx_label).toBe("2/3");
  });
});

describe("sheet review edits", () => {
  it("refuses a surgical case id and OT stream writes", () => {
    expect(parseSheetEdits({ surgical_case_id: "11111111-1111-1111-1111-111111111111" }).ok).toBe(false);
    expect(parseSheetEdits({ fields: { ot_on_time: true } }).ok).toBe(false);
    const parsed = parseSheetEdits({ fields: { surgery_date: "18/09/2026", patient_name: " Sample " } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.edits.surgery_date).toBe("2026-09-18");
      expect(parsed.edits.texts.patient_name).toBe("Sample");
    }
  });

  it("inserts sheet columns without a case link and lists every PRD field", () => {
    expect(SHEET_INSERT_COLUMNS).not.toContain("surgical_case_id");
    expect(SHEET_INSERT_COLUMNS).toContain("capture_id");
    expect(SHEET_INSERT_COLUMNS).toContain("review_status");
    for (const key of SHEET_TEXT_FIELDS) {
      expect(SHEET_FORM_FIELDS.some((field) => field.key === key)).toBe(true);
    }
    expect(SHEET_FORM_FIELDS.some((field) => field.key === "equipment_notes")).toBe(true);
    expect(SHEET_FORM_FIELDS.some((field) => field.key === "notes")).toBe(true);
  });

  it("keeps the staff DTO free of blob locators and the full IP hash", () => {
    const detail = toPublicSheetDetail({
      id: "33333333-3333-3333-3333-333333333333",
      capture_id: "11111111-1111-1111-1111-111111111111",
      hospital_code: "EHRC",
      uhid: "UHID-1",
      ip_no: null,
      patient_name: "Sample Patient",
      surgery_date: "2026-09-18",
      ot_no: "OT-3",
      anesthesia: "GA",
      surgery_name: "Hysteroscopy",
      surgeon_name: "Dr A Sharma",
      asst_surgeon: null,
      anesthetist: null,
      antibiotic: "Cefuroxime",
      antibiotic_at: "08:40",
      scrub_nurse: null,
      technician: null,
      circulating_nurse: null,
      scheduled_at: null,
      wheel_in: "08:25",
      sign_in: null,
      induction: null,
      time_out: null,
      incision: "09:05",
      closure: null,
      sign_out: null,
      wheel_out: null,
      equipment_json: { notes: "scope" },
      notes_json: { text: "uneventful" },
      review_status: "pending_human",
      classify_confidence: "0.910",
      extract_confidence: 0.94,
      prompt_version: "ot-tracking-sheet-v1",
      review_note: null,
      capture_status: "extracted",
      content_type: "image/jpeg",
      uploaded_by: "Ward phone",
      uploaded_at: "2026-09-18T10:52:00.000Z",
      user_agent: "Mozilla/5.0",
      ip_hash: "a3f9c2d4e5f60718293a4b5c6d7e8f90",
      doc_type: "ot_tracking_sheet",
    });
    expect(detail.surgical_case_id).toBeNull();
    expect(detail.fields.surgery_date).toBe("18/09/2026");
    expect(detail.abx_on_time).toBe(true);
    expect(detail.image_path).toBe("/api/capture/11111111-1111-1111-1111-111111111111/image");
    expect(detail.provenance).toContain("a3f9c2d4…");
    expect(detail.provenance).not.toContain("a3f9c2d4e5");
    expect(publicSheetLeaksCaptureSecrets(detail)).toBe(false);
    expect(detail.editable).toBe(true);
  });
});

describe("worker limits", () => {
  it("caps a run so Vertex is not flooded", () => {
    expect(clampOcrLimit(undefined)).toBe(2);
    expect(clampOcrLimit(null)).toBe(2);
    expect(clampOcrLimit(9)).toBe(4);
    expect(clampOcrLimit("1")).toBe(1);
  });
});

describe("capture queue OCR fields", () => {
  it("can show a doc type without leaking the blob", () => {
    const item = toPublicCapture({
      id: "11111111-1111-1111-1111-111111111111",
      hospital_code: "EHRC",
      uploaded_by: null,
      uploaded_at: "2026-09-27T05:12:00.000Z",
      user_agent: null,
      ip_hash: null,
      content_type: "image/jpeg",
      bytes: 10,
      status: "extracted",
      batch_id: null,
      photo_index: 1,
      batch_size: 1,
      original_filename: "sheet.jpg",
      blob_pathname: "ot-captures/EHRC/secret.jpg",
      doc_type: "ot_tracking_sheet",
      classify_confidence: 0.91,
      error: null,
    });
    expect(item.doc_type).toBe("ot_tracking_sheet");
    expect(item.classify_confidence).toBe(0.91);
    expect(JSON.stringify(item)).not.toContain("ot-captures/");
  });
});

describe("migration 033", () => {
  it("adds the sheet table and blocks a case link until Stage 3", () => {
    const migration = MIGRATIONS.find((item) => item.id === "033_gov_ot_tracking_sheets");
    expect(migration?.sql).toContain("gov_ot_tracking_sheets");
    expect(migration?.sql).toContain("capture_id");
    expect(migration?.sql).toContain("gov_ot_sheets_no_case_link_stage2");
    expect(migration?.sql).toContain("pending_human");
    expect(migration?.sql).not.toMatch(/INSERT INTO surgical_cases/i);
    expect(migration?.sql).not.toMatch(/case_observations/i);
  });
});
