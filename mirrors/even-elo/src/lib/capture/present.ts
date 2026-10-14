import { ipHashPrefix } from "./provenance";

export const QUEUE_FILTERS = ["all", "queued", "processing", "needs_review", "extracted", "voided"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

export const CAPTURE_STATUSES = [
  "queued",
  "stored",
  "processing",
  "classified",
  "extracted",
  "needs_review",
  "failed",
  "voided",
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export function isQueueFilter(value: string): value is QueueFilter {
  return (QUEUE_FILTERS as readonly string[]).includes(value);
}

export function headlineCount(counts: Record<string, number>, key: string): number {
  if (key === "queued") return (counts.queued ?? 0) + (counts.stored ?? 0);
  return counts[key] ?? 0;
}

export function captureQueueTitle(input: {
  uploadedBy: string | null;
  batchSize: number;
  photoIndex: number | null;
  filename: string | null;
}): string {
  const name = input.uploadedBy?.trim() || "";
  if (input.batchSize > 1) {
    const who = name ? `optional name “${name}”` : "no name given";
    const idx = input.photoIndex ?? 1;
    return `Batch · ${input.batchSize} photos · ${idx} of ${input.batchSize} · ${who}`;
  }
  if (name) return `OT sheet · optional name “${name}”`;
  if (input.filename) return `OT sheet · ${input.filename}`;
  return "OT sheet photo";
}

export function formatCaptureWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${day.replace("Sept", "Sep")}, ${time} IST`;
}

export function captureSubtitle(input: {
  uploadedAt: string;
  hospitalCode: string;
  status: string;
  docType?: string | null;
}): string {
  const when = formatCaptureWhen(input.uploadedAt);
  const doc = input.docType ? ` · ${input.docType}` : "";
  if ((input.status === "queued" || input.status === "stored") && !input.docType) {
    return `Uploaded ${when} · ${input.hospitalCode} · doc_type pending`;
  }
  return `Uploaded ${when} · ${input.hospitalCode} · ${input.status}${doc}`;
}

export function captureProvenance(input: {
  userAgent: string | null;
  ipHash: string | null;
}): string {
  const ua = input.userAgent?.trim() || "—";
  const shown = ua.length > 72 ? `${ua.slice(0, 72)}…` : ua;
  const prefix = ipHashPrefix(input.ipHash);
  return `UA ${shown} · IP hash ${prefix ? `${prefix}…` : "—"}`;
}

const PUBLIC_KEYS = [
  "id",
  "hospital_code",
  "uploaded_by",
  "uploaded_at",
  "status",
  "content_type",
  "bytes",
  "batch_id",
  "photo_index",
  "batch_size",
  "title",
  "subtitle",
  "provenance",
  "image_path",
  "void_reason",
  "voided_at",
  "doc_type",
  "classify_confidence",
  "ocr_error",
] as const;

export interface CapturePublicItem {
  id: string;
  hospital_code: string;
  uploaded_by: string | null;
  uploaded_at: string;
  status: string;
  content_type: string;
  bytes: number;
  batch_id: string | null;
  photo_index: number | null;
  batch_size: number;
  title: string;
  subtitle: string;
  provenance: string;
  image_path: string;
  void_reason: string | null;
  voided_at: string | null;
  doc_type: string | null;
  classify_confidence: number | null;
  ocr_error: string | null;
}

export interface CaptureRow {
  id: string;
  hospital_code: string;
  uploaded_by: string | null;
  uploaded_at: Date | string;
  user_agent: string | null;
  ip_hash: string | null;
  content_type: string;
  bytes: number;
  status: string;
  batch_id: string | null;
  photo_index: number | null;
  batch_size: number | string | null;
  original_filename: string | null;
  blob_pathname?: string | null;
  blob_url?: string | null;
  void_reason?: string | null;
  voided_at?: Date | string | null;
  doc_type?: string | null;
  classify_confidence?: number | string | null;
  error?: string | null;
}

function asConfidence(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 1000) / 1000;
}

function clipError(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 180);
}

function asIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function toPublicCapture(row: CaptureRow): CapturePublicItem {
  const uploadedAt = asIso(row.uploaded_at) ?? "";
  const batchSize = Math.max(1, Number(row.batch_size ?? 1) || 1);
  const item: CapturePublicItem = {
    id: row.id,
    hospital_code: row.hospital_code,
    uploaded_by: row.uploaded_by,
    uploaded_at: uploadedAt,
    status: row.status,
    content_type: row.content_type,
    bytes: Number(row.bytes) || 0,
    batch_id: row.batch_id,
    photo_index: row.photo_index,
    batch_size: batchSize,
    title: captureQueueTitle({
      uploadedBy: row.uploaded_by,
      batchSize,
      photoIndex: row.photo_index,
      filename: row.original_filename,
    }),
    subtitle: captureSubtitle({
      uploadedAt,
      hospitalCode: row.hospital_code,
      status: row.status,
      docType: row.doc_type,
    }),
    provenance: captureProvenance({
      userAgent: row.user_agent,
      ipHash: row.ip_hash,
    }),
    image_path: `/api/capture/${row.id}/image`,
    void_reason: row.void_reason ?? null,
    voided_at: asIso(row.voided_at),
    doc_type: row.doc_type ?? null,
    classify_confidence: asConfidence(row.classify_confidence),
    ocr_error: clipError(row.error),
  };
  for (const key of Object.keys(item)) {
    if (!(PUBLIC_KEYS as readonly string[]).includes(key)) {
      delete (item as unknown as Record<string, unknown>)[key];
    }
  }
  return item;
}

export function publicCaptureHasBlobLocator(item: CapturePublicItem): boolean {
  const record = item as unknown as Record<string, unknown>;
  return "blob_url" in record || "blob_pathname" in record || "ip_hash" in record;
}
