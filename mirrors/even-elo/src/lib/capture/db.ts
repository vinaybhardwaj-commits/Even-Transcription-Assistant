import "server-only";
import { sql } from "@/lib/db";
import type { CaptureRow } from "./present";

export const HOURLY_UPLOAD_CAP = 40;

export function isMissingCaptureTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /gov_document_captures/i.test(message) && /does not exist|undefined_table|relation/i.test(message);
}

export interface InsertCaptureInput {
  id: string;
  hospitalCode: string;
  uploadedBy: string | null;
  userAgent: string | null;
  ipHash: string | null;
  blobUrl: string;
  blobPathname: string;
  contentType: string;
  bytes: number;
  originalFilename: string;
  batchId: string;
  photoIndex: number;
}

function insertQuery(input: InsertCaptureInput) {
  return sql`
    INSERT INTO gov_document_captures (
      id, hospital_code, uploaded_by, user_agent, ip_hash,
      blob_url, blob_pathname, content_type, bytes, original_filename,
      batch_id, photo_index, status
    ) VALUES (
      ${input.id}::uuid,
      ${input.hospitalCode},
      ${input.uploadedBy},
      ${input.userAgent},
      ${input.ipHash},
      ${input.blobUrl},
      ${input.blobPathname},
      ${input.contentType},
      ${input.bytes},
      ${input.originalFilename},
      ${input.batchId}::uuid,
      ${input.photoIndex},
      'queued'
    )
  `;
}

/** One transaction so a failed photo does not leave a partial batch row. */
export async function insertCaptures(inputs: InsertCaptureInput[]): Promise<void> {
  if (inputs.length === 0) return;
  if (inputs.length === 1) {
    await insertQuery(inputs[0]!);
    return;
  }
  await sql.transaction(inputs.map((input) => insertQuery(input)));
}

/** Confirms the queue table is reachable before any blob write. */
export async function assertCaptureStore(): Promise<void> {
  await sql`SELECT 1 AS ok FROM gov_document_captures LIMIT 1`;
}

export async function countRecentByIpHash(ipHash: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n
    FROM gov_document_captures
    WHERE ip_hash = ${ipHash}
      AND uploaded_at > now() - interval '1 hour'
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export async function listCaptures(filter: string, hospital: string): Promise<CaptureRow[]> {
  const rows = (await sql`
    SELECT
      c.id,
      c.hospital_code,
      c.uploaded_by,
      c.uploaded_at,
      c.user_agent,
      c.ip_hash,
      c.content_type,
      c.bytes,
      c.status,
      c.batch_id,
      c.photo_index,
      c.original_filename,
      c.void_reason,
      c.voided_at,
      c.blob_pathname,
      c.doc_type,
      c.classify_confidence,
      c.error,
      COALESCE(b.batch_size, 1) AS batch_size
    FROM gov_document_captures c
    LEFT JOIN (
      SELECT batch_id, COUNT(*)::int AS batch_size
      FROM gov_document_captures
      WHERE batch_id IS NOT NULL
      GROUP BY batch_id
    ) b ON b.batch_id = c.batch_id
    WHERE (
      (${filter} = 'all' AND c.status <> 'voided')
      OR (${filter} = 'queued' AND c.status IN ('queued', 'stored'))
      OR (${filter} <> 'all' AND ${filter} <> 'queued' AND c.status = ${filter})
    )
      AND (${hospital} = 'ALL' OR c.hospital_code = ${hospital})
    ORDER BY c.uploaded_at DESC
    LIMIT 200
  `) as CaptureRow[];
  return rows;
}

export async function countCapturesByStatus(hospital: string): Promise<Record<string, number>> {
  const rows = (await sql`
    SELECT status, COUNT(*)::int AS n
    FROM gov_document_captures
    WHERE (${hospital} = 'ALL' OR hospital_code = ${hospital})
    GROUP BY status
  `) as Array<{ status: string; n: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = Number(row.n) || 0;
  return counts;
}

export async function getCapture(id: string): Promise<CaptureRow | null> {
  const rows = (await sql`
    SELECT
      c.id,
      c.hospital_code,
      c.uploaded_by,
      c.uploaded_at,
      c.user_agent,
      c.ip_hash,
      c.content_type,
      c.bytes,
      c.status,
      c.batch_id,
      c.photo_index,
      c.original_filename,
      c.void_reason,
      c.voided_at,
      c.blob_pathname,
      c.doc_type,
      c.classify_confidence,
      c.error,
      COALESCE(b.batch_size, 1) AS batch_size
    FROM gov_document_captures c
    LEFT JOIN (
      SELECT batch_id, COUNT(*)::int AS batch_size
      FROM gov_document_captures
      WHERE batch_id IS NOT NULL
      GROUP BY batch_id
    ) b ON b.batch_id = c.batch_id
    WHERE c.id = ${id}::uuid
    LIMIT 1
  `) as CaptureRow[];
  return rows[0] ?? null;
}

export async function voidCapture(
  id: string,
  profileId: string,
  reason: string | null,
): Promise<CaptureRow | null> {
  const rows = (await sql`
    UPDATE gov_document_captures
    SET status = 'voided',
        voided_at = now(),
        voided_by_profile_id = ${profileId}::uuid,
        void_reason = ${reason}
    WHERE id = ${id}::uuid
      AND status IN ('queued', 'stored')
    RETURNING id
  `) as Array<{ id: string }>;
  if (!rows[0]) return null;
  return getCapture(id);
}
