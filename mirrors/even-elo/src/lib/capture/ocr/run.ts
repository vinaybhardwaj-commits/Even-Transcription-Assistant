import "server-only";
import { parseVertexConfig, type EnvSource } from "@/lib/vertex/env";
import { isOtCaptureOcrEnabled } from "../access";
import { readCaptureBlob } from "../blob-store";
import {
  CLASSIFY_SYSTEM,
  CLASSIFY_USER,
  EXTRACT_SYSTEM,
  EXTRACT_USER,
  OT_TRACKING_SHEET_PROMPT_VERSION,
  repairUser,
} from "../prompts/ot-tracking-sheet-v1";
import { claimCapture, completeCapture, isMissingSheetTable, listOcrCandidates, releaseClaim } from "../sheets-db";
import { decideOcr, parseClassify, parseExtract, type OcrDecision } from "./parse";
import { VertexOcrError, vertexOcrText } from "./vertex-ocr";

export const OCR_DEFAULT_LIMIT = 2;
export const OCR_MAX_LIMIT = 4;

const VISION_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface OcrItemResult {
  id: string;
  status: string;
  doc_type: string | null;
}

export interface OcrBatchResult {
  ok: true;
  processed: number;
  skipped?: "flag_off" | "not_configured";
  results: OcrItemResult[];
}

export function clampOcrLimit(value: unknown, fallback = OCR_DEFAULT_LIMIT): number {
  if (value == null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(OCR_MAX_LIMIT, Math.floor(parsed)));
}

function visionType(contentType: string): string | null {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "image/jpg") return "image/jpeg";
  if (VISION_TYPES.has(base)) return base;
  return null;
}

async function readImageBase64(pathname: string): Promise<{ base64: string; contentType: string } | null> {
  const blob = await readCaptureBlob(pathname);
  if (!blob || blob.statusCode !== 200 || !blob.stream) return null;
  const chunks: Buffer[] = [];
  const reader = blob.stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value) chunks.push(Buffer.from(next.value));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 1) return null;
  return {
    base64: bytes.toString("base64"),
    contentType: blob.blob.contentType || "application/octet-stream",
  };
}

async function modelText(
  credentials: NonNullable<ReturnType<typeof parseVertexConfig>["credentials"]>,
  system: string,
  user: string,
  image: { mimeType: string; base64: string } | null,
  maxOutputTokens: number,
): Promise<string> {
  return vertexOcrText({ credentials, system, user, image, maxOutputTokens });
}

async function decideForCapture(
  claimed: { content_type: string; blob_pathname: string },
  credentials: NonNullable<ReturnType<typeof parseVertexConfig>["credentials"]>,
): Promise<OcrDecision> {
  const mime = visionType(claimed.content_type);
  if (!mime) {
    return decideOcr({
      unsupportedReason: "OCR accepts JPEG, PNG, or WEBP. This capture needs a JPEG retake or a manual review.",
    });
  }
  const image = await readImageBase64(claimed.blob_pathname);
  if (!image) {
    return decideOcr({ vertexError: "Image is missing from the blob store." });
  }
  const inline = { mimeType: visionType(image.contentType) ?? mime, base64: image.base64 };
  let classifyRaw = await modelText(credentials, CLASSIFY_SYSTEM, CLASSIFY_USER, inline, 512);
  let classify = parseClassify(classifyRaw);
  if (!classify.ok) {
    classifyRaw = await modelText(credentials, CLASSIFY_SYSTEM, repairUser("classify", classifyRaw), inline, 512);
    classify = parseClassify(classifyRaw);
  }
  if (!classify.ok || classify.docType !== "ot_tracking_sheet") {
    return decideOcr({ classify, extractJson: { prompt_version: OT_TRACKING_SHEET_PROMPT_VERSION, classify: classifyRaw } });
  }
  let extractRaw = await modelText(credentials, EXTRACT_SYSTEM, EXTRACT_USER, inline, 4096);
  let extract = parseExtract(extractRaw);
  if (!extract.ok) {
    extractRaw = await modelText(credentials, EXTRACT_SYSTEM, repairUser("extract", extractRaw), inline, 4096);
    extract = parseExtract(extractRaw);
  }
  return decideOcr({
    classify,
    extract,
    extractJson: {
      prompt_version: OT_TRACKING_SHEET_PROMPT_VERSION,
      classify: classifyRaw,
      extract: extractRaw,
    },
  });
}

async function processOne(
  id: string,
  retry: boolean,
  credentials: NonNullable<ReturnType<typeof parseVertexConfig>["credentials"]>,
): Promise<OcrItemResult | null> {
  const claimed = await claimCapture(id, retry);
  if (!claimed) return null;
  try {
    const decision = await decideForCapture(claimed, credentials);
    const saved = await completeCapture({
      id: claimed.id,
      hospitalCode: claimed.hospital_code,
      decision,
      modelId: credentials.model,
    });
    if (saved === "lost") return null;
    console.error(JSON.stringify({ capture_ocr: decision.status, id: claimed.id, doc_type: decision.docType }));
    return { id: claimed.id, status: decision.status, doc_type: decision.docType };
  } catch (error) {
    if (isMissingSheetTable(error)) {
      await releaseClaim(claimed.id).catch(() => undefined);
      throw error;
    }
    const message = error instanceof VertexOcrError ? error.message : "OCR failed";
    const failed = decideOcr({ vertexError: message });
    await completeCapture({
      id: claimed.id,
      hospitalCode: claimed.hospital_code,
      decision: failed,
      modelId: credentials.model,
    }).catch(async () => {
      await releaseClaim(claimed.id).catch(() => undefined);
    });
    console.error(JSON.stringify({ capture_ocr: "failed", id: claimed.id }));
    return { id: claimed.id, status: "failed", doc_type: null };
  }
}

/**
 * Classify and extract queued captures. No-ops when FEATURE_OT_CAPTURE_OCR is not exactly "true".
 * Does not mint surgical_cases and does not write OT stream cells.
 */
export async function processQueuedCaptures(
  input: { limit?: number; ids?: string[]; retry?: boolean; env?: EnvSource } = {},
): Promise<OcrBatchResult> {
  const env = input.env ?? process.env;
  if (!isOtCaptureOcrEnabled(env)) {
    return { ok: true, processed: 0, skipped: "flag_off", results: [] };
  }
  const parsed = parseVertexConfig(env);
  if (!parsed.credentials) {
    return { ok: true, processed: 0, skipped: "not_configured", results: [] };
  }
  const limit = clampOcrLimit(input.limit);
  const retry = input.retry === true;
  const ids = input.ids?.filter(Boolean).slice(0, OCR_MAX_LIMIT) ?? (await listOcrCandidates(limit, retry));
  const results: OcrItemResult[] = [];
  for (const id of ids) {
    if (results.length >= limit) break;
    const item = await processOne(id, retry, parsed.credentials);
    if (item) results.push(item);
    if (results.length < limit) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: true, processed: results.length, results };
}

/** Best-effort kick after upload. The cron is the backstop when the platform freezes this promise. */
export function kickOcrAfterUpload(ids: string[]): void {
  if (!isOtCaptureOcrEnabled() || ids.length === 0) return;
  void processQueuedCaptures({ ids, limit: Math.min(ids.length, OCR_MAX_LIMIT), retry: false }).catch(() => {
    console.error(JSON.stringify({ capture_ocr: "upload_kick_failed" }));
  });
}
