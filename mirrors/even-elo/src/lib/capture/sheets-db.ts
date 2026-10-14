import "server-only";
import { sql } from "@/lib/db";
import type { OcrDecision } from "./ocr/parse";
import type { NormalizedSheet } from "./ocr/parse";
import type { SheetEdits } from "./sheets";

export function isMissingSheetTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /gov_ot_tracking_sheets|prompt_version|model_id/i.test(message) && /does not exist|undefined_table|undefined_column|column/i.test(message);
}

export interface ClaimedCapture {
  id: string;
  hospital_code: string;
  blob_pathname: string;
  content_type: string;
}

export async function listOcrCandidates(limit: number, retry: boolean): Promise<string[]> {
  const rows = (await sql`
    SELECT c.id
    FROM gov_document_captures c
    WHERE c.status <> 'voided'
      AND NOT EXISTS (
        SELECT 1 FROM gov_ot_tracking_sheets s WHERE s.capture_id = c.id
      )
      AND (
        c.status IN ('queued', 'stored')
        OR (
          c.status = 'processing'
          AND c.processed_at IS NULL
          AND c.uploaded_at < now() - interval '10 minutes'
        )
        OR (
          ${retry}::boolean
          AND c.status IN ('failed', 'needs_review', 'classified')
        )
      )
    ORDER BY c.uploaded_at ASC
    LIMIT ${limit}
  `) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export async function claimCapture(id: string, retry: boolean): Promise<ClaimedCapture | null> {
  const rows = (await sql`
    UPDATE gov_document_captures c
    SET status = 'processing'
    WHERE c.id = ${id}::uuid
      AND c.status <> 'voided'
      AND NOT EXISTS (
        SELECT 1 FROM gov_ot_tracking_sheets s WHERE s.capture_id = c.id
      )
      AND (
        c.status IN ('queued', 'stored')
        OR (
          c.status = 'processing'
          AND c.processed_at IS NULL
          AND c.uploaded_at < now() - interval '10 minutes'
        )
        OR (
          ${retry}::boolean
          AND c.status IN ('failed', 'needs_review', 'classified')
        )
      )
    RETURNING c.id, c.hospital_code, c.blob_pathname, c.content_type
  `) as ClaimedCapture[];
  return rows[0] ?? null;
}

export async function releaseClaim(id: string): Promise<void> {
  await sql`
    UPDATE gov_document_captures
    SET status = 'queued'
    WHERE id = ${id}::uuid
      AND status = 'processing'
      AND processed_at IS NULL
  `;
}

function jsonbParam(value: unknown): string | null {
  if (value == null) return null;
  const text = JSON.stringify(value);
  return text.length > 100_000 ? JSON.stringify({ truncated: true }) : text;
}

export async function completeCapture(input: {
  id: string;
  hospitalCode: string;
  decision: OcrDecision;
  modelId: string | null;
}): Promise<"saved" | "lost"> {
  const decision = input.decision;
  const sheet: NormalizedSheet | null = decision.sheet;
  const promptVersion = sheet?.prompt_version ?? "ot-tracking-sheet-v1";
  if (!sheet) {
    const rows = (await sql`
      UPDATE gov_document_captures
      SET status = ${decision.status},
          doc_type = ${decision.docType},
          classify_confidence = ${decision.classifyConfidence},
          extract_json = ${jsonbParam(decision.extractJson)}::jsonb,
          extract_confidence = ${decision.extractConfidence},
          error = ${decision.error},
          processed_at = now(),
          prompt_version = ${promptVersion},
          model_id = ${input.modelId}
      WHERE id = ${input.id}::uuid
        AND status = 'processing'
      RETURNING id
    `) as Array<{ id: string }>;
    return rows[0] ? "saved" : "lost";
  }
  // The sheet insert reads the updated capture, so a lost claim cannot mint a row.
  const rows = (await sql`
    WITH updated AS (
      UPDATE gov_document_captures
      SET status = ${decision.status},
          doc_type = ${decision.docType},
          classify_confidence = ${decision.classifyConfidence},
          extract_json = ${jsonbParam(decision.extractJson)}::jsonb,
          extract_confidence = ${decision.extractConfidence},
          error = ${decision.error},
          processed_at = now(),
          prompt_version = ${promptVersion},
          model_id = ${input.modelId}
      WHERE id = ${input.id}::uuid
        AND status = 'processing'
      RETURNING id
    ),
    inserted AS (
      INSERT INTO gov_ot_tracking_sheets (
        capture_id, hospital_code,
        uhid, ip_no, patient_name, surgery_date, ot_no,
        anesthesia, surgery_name, surgeon_name, asst_surgeon, anesthetist,
        antibiotic, antibiotic_at,
        scrub_nurse, technician, circulating_nurse,
        scheduled_at, wheel_in, sign_in, induction, time_out, incision,
        closure, sign_out, wheel_out,
        equipment_json, notes_json,
        review_status, classify_confidence, extract_confidence, prompt_version
      )
      SELECT
        updated.id,
        ${input.hospitalCode},
        ${sheet.uhid},
        ${sheet.ip_no},
        ${sheet.patient_name},
        ${sheet.surgery_date}::date,
        ${sheet.ot_no},
        ${sheet.anesthesia},
        ${sheet.surgery_name},
        ${sheet.surgeon_name},
        ${sheet.asst_surgeon},
        ${sheet.anesthetist},
        ${sheet.antibiotic},
        ${sheet.antibiotic_at},
        ${sheet.scrub_nurse},
        ${sheet.technician},
        ${sheet.circulating_nurse},
        ${sheet.scheduled_at},
        ${sheet.wheel_in},
        ${sheet.sign_in},
        ${sheet.induction},
        ${sheet.time_out},
        ${sheet.incision},
        ${sheet.closure},
        ${sheet.sign_out},
        ${sheet.wheel_out},
        ${jsonbParam(sheet.equipment_json)}::jsonb,
        ${jsonbParam(sheet.notes_json)}::jsonb,
        'pending_human',
        ${decision.classifyConfidence},
        ${decision.extractConfidence},
        ${sheet.prompt_version}
      FROM updated
      ON CONFLICT (capture_id) DO NOTHING
      RETURNING capture_id
    )
    SELECT id FROM updated
  `) as Array<{ id: string }>;
  return rows[0] ? "saved" : "lost";
}

export interface SheetStatSqlRow {
  review_status: string;
  surgery_date: string | null;
  antibiotic_at: string | null;
  incision: string | null;
}

export async function listSheetStatRows(hospital: string): Promise<SheetStatSqlRow[]> {
  return (await sql`
    SELECT
      review_status,
      surgery_date::text AS surgery_date,
      antibiotic_at,
      incision
    FROM gov_ot_tracking_sheets
    WHERE (${hospital} = 'ALL' OR hospital_code = ${hospital})
  `) as SheetStatSqlRow[];
}

export interface SheetListRow {
  id: string;
  capture_id: string;
  hospital_code: string;
  patient_name: string | null;
  surgery_date: string | null;
  ot_no: string | null;
  surgery_name: string | null;
  surgeon_name: string | null;
  antibiotic_at: string | null;
  incision: string | null;
  review_status: string;
  capture_status: string;
}

export async function listSheets(input: {
  hospital: string;
  review: string;
  query: string;
}): Promise<SheetListRow[]> {
  const like = input.query ? `%${input.query}%` : "";
  return (await sql`
    SELECT
      s.id,
      s.capture_id,
      s.hospital_code,
      s.patient_name,
      s.surgery_date::text AS surgery_date,
      s.ot_no,
      s.surgery_name,
      s.surgeon_name,
      s.antibiotic_at,
      s.incision,
      s.review_status,
      c.status AS capture_status
    FROM gov_ot_tracking_sheets s
    JOIN gov_document_captures c ON c.id = s.capture_id
    WHERE c.status <> 'voided'
      AND (${input.hospital} = 'ALL' OR s.hospital_code = ${input.hospital})
      AND (${input.review} = 'all' OR s.review_status = ${input.review})
      AND (
        ${like} = ''
        OR COALESCE(s.surgeon_name, '') ILIKE ${like}
        OR COALESCE(s.surgery_name, '') ILIKE ${like}
        OR COALESCE(s.ot_no, '') ILIKE ${like}
        OR COALESCE(s.patient_name, '') ILIKE ${like}
        OR COALESCE(s.uhid, '') ILIKE ${like}
      )
    ORDER BY s.surgery_date DESC NULLS LAST, s.created_at DESC
    LIMIT 200
  `) as SheetListRow[];
}

export interface SheetDetailRow {
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
  reviewed_at: Date | string | null;
  created_at: Date | string;
  capture_status: string;
  content_type: string;
  uploaded_by: string | null;
  uploaded_at: Date | string;
  user_agent: string | null;
  ip_hash: string | null;
  doc_type: string | null;
}

export async function getSheet(id: string): Promise<SheetDetailRow | null> {
  const rows = (await sql`
    SELECT
      s.id,
      s.capture_id,
      s.hospital_code,
      s.uhid,
      s.ip_no,
      s.patient_name,
      s.surgery_date::text AS surgery_date,
      s.ot_no,
      s.anesthesia,
      s.surgery_name,
      s.surgeon_name,
      s.asst_surgeon,
      s.anesthetist,
      s.antibiotic,
      s.antibiotic_at,
      s.scrub_nurse,
      s.technician,
      s.circulating_nurse,
      s.scheduled_at,
      s.wheel_in,
      s.sign_in,
      s.induction,
      s.time_out,
      s.incision,
      s.closure,
      s.sign_out,
      s.wheel_out,
      s.equipment_json,
      s.notes_json,
      s.review_status,
      s.classify_confidence,
      s.extract_confidence,
      s.prompt_version,
      s.review_note,
      s.reviewed_at,
      s.created_at,
      c.status AS capture_status,
      c.content_type,
      c.uploaded_by,
      c.uploaded_at,
      c.user_agent,
      c.ip_hash,
      c.doc_type
    FROM gov_ot_tracking_sheets s
    JOIN gov_document_captures c ON c.id = s.capture_id
    WHERE s.id = ${id}::uuid
    LIMIT 1
  `) as SheetDetailRow[];
  return rows[0] ?? null;
}

export async function findSheetIdByCapture(captureId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM gov_ot_tracking_sheets WHERE capture_id = ${captureId}::uuid LIMIT 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function updateSheetFields(id: string, edits: SheetEdits): Promise<boolean> {
  const current = await getSheet(id);
  if (!current || current.review_status !== "pending_human") return false;
  const nextNotes =
    edits.notes === undefined
      ? current.notes_json
      : edits.notes
        ? {
            ...(current.notes_json && typeof current.notes_json === "object" ? (current.notes_json as object) : {}),
            text: edits.notes,
          }
        : null;
  const nextEquipment = edits.equipment_notes === undefined ? current.equipment_json : edits.equipment_notes ? { notes: edits.equipment_notes } : null;
  const rows = (await sql`
    UPDATE gov_ot_tracking_sheets
    SET
      uhid = ${edits.texts.uhid === undefined ? current.uhid : edits.texts.uhid},
      ip_no = ${edits.texts.ip_no === undefined ? current.ip_no : edits.texts.ip_no},
      patient_name = ${edits.texts.patient_name === undefined ? current.patient_name : edits.texts.patient_name},
      surgery_date = ${edits.surgery_date === undefined ? current.surgery_date : edits.surgery_date}::date,
      ot_no = ${edits.texts.ot_no === undefined ? current.ot_no : edits.texts.ot_no},
      anesthesia = ${edits.texts.anesthesia === undefined ? current.anesthesia : edits.texts.anesthesia},
      surgery_name = ${edits.texts.surgery_name === undefined ? current.surgery_name : edits.texts.surgery_name},
      surgeon_name = ${edits.texts.surgeon_name === undefined ? current.surgeon_name : edits.texts.surgeon_name},
      asst_surgeon = ${edits.texts.asst_surgeon === undefined ? current.asst_surgeon : edits.texts.asst_surgeon},
      anesthetist = ${edits.texts.anesthetist === undefined ? current.anesthetist : edits.texts.anesthetist},
      antibiotic = ${edits.texts.antibiotic === undefined ? current.antibiotic : edits.texts.antibiotic},
      antibiotic_at = ${edits.texts.antibiotic_at === undefined ? current.antibiotic_at : edits.texts.antibiotic_at},
      scrub_nurse = ${edits.texts.scrub_nurse === undefined ? current.scrub_nurse : edits.texts.scrub_nurse},
      technician = ${edits.texts.technician === undefined ? current.technician : edits.texts.technician},
      circulating_nurse = ${edits.texts.circulating_nurse === undefined ? current.circulating_nurse : edits.texts.circulating_nurse},
      scheduled_at = ${edits.texts.scheduled_at === undefined ? current.scheduled_at : edits.texts.scheduled_at},
      wheel_in = ${edits.texts.wheel_in === undefined ? current.wheel_in : edits.texts.wheel_in},
      sign_in = ${edits.texts.sign_in === undefined ? current.sign_in : edits.texts.sign_in},
      induction = ${edits.texts.induction === undefined ? current.induction : edits.texts.induction},
      time_out = ${edits.texts.time_out === undefined ? current.time_out : edits.texts.time_out},
      incision = ${edits.texts.incision === undefined ? current.incision : edits.texts.incision},
      closure = ${edits.texts.closure === undefined ? current.closure : edits.texts.closure},
      sign_out = ${edits.texts.sign_out === undefined ? current.sign_out : edits.texts.sign_out},
      wheel_out = ${edits.texts.wheel_out === undefined ? current.wheel_out : edits.texts.wheel_out},
      equipment_json = ${jsonbParam(nextEquipment)}::jsonb,
      notes_json = ${jsonbParam(nextNotes)}::jsonb,
      updated_at = now()
    WHERE id = ${id}::uuid
      AND review_status = 'pending_human'
    RETURNING id
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function reviewSheet(input: {
  id: string;
  decision: "approved" | "rejected";
  profileId: string;
  note: string | null;
}): Promise<boolean> {
  const rows = (await sql`
    UPDATE gov_ot_tracking_sheets
    SET review_status = ${input.decision},
        reviewed_by_profile_id = ${input.profileId}::uuid,
        reviewed_at = now(),
        review_note = ${input.note},
        updated_at = now()
    WHERE id = ${input.id}::uuid
      AND review_status = 'pending_human'
    RETURNING id
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}
