import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isOtCaptureEnabled } from "@/lib/capture/access";
import { kickOcrAfterUpload } from "@/lib/capture/ocr/run";
import { deleteCaptureBlob, storeCaptureBlob } from "@/lib/capture/blob-store";
import {
  assertCaptureStore,
  countRecentByIpHash,
  HOURLY_UPLOAD_CAP,
  insertCaptures,
  isMissingCaptureTable,
} from "@/lib/capture/db";
import { normalizeHospital, planImages, type IncomingImage } from "@/lib/capture/images";
import {
  captureIpSalt,
  clientIpFromHeaders,
  hashIp,
  sanitizeUploaderName,
  truncateUserAgent,
} from "@/lib/capture/provenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function captureDbFailure(error: unknown): NextResponse {
  if (isMissingCaptureTable(error)) {
    return NextResponse.json(
      {
        ok: false,
        error: "gov_document_captures is not migrated yet. POST /api/admin/migrate on this deployment.",
        code: "migration_required",
      },
      { status: 503 },
    );
  }
  const message = error instanceof Error ? error.message : "";
  if (/DATABASE_URL is not set/i.test(message)) {
    return NextResponse.json(
      { ok: false, error: "Database is not configured for this deployment.", code: "db_unconfigured" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: false, error: "Could not store the capture." }, { status: 500 });
}

export async function GET() {
  return NextResponse.json({ ok: true, enabled: isOtCaptureEnabled() });
}

export async function POST(request: NextRequest) {
  if (!isOtCaptureEnabled()) {
    return NextResponse.json(
      { ok: false, error: "OT capture is off", code: "flag_off" },
      { status: 403 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected a multipart image upload." }, { status: 400 });
  }

  const hospital = normalizeHospital(form.get("hospital_code"));
  if (!hospital.ok) {
    return NextResponse.json({ ok: false, error: hospital.error }, { status: 400 });
  }
  const uploadedBy = sanitizeUploaderName(form.get("uploaded_by"));

  const files: IncomingImage[] = [];
  const parts = [...form.getAll("files"), ...form.getAll("file")];
  for (const part of parts) {
    if (!(part instanceof File)) continue;
    const bytes = new Uint8Array(await part.arrayBuffer());
    files.push({
      filename: part.name || "ot-sheet.jpg",
      contentType: part.type || "",
      bytes,
    });
  }

  const planned = planImages(files);
  if (!planned.ok) {
    return NextResponse.json({ ok: false, error: planned.error }, { status: planned.status });
  }

  const ip = clientIpFromHeaders(request.headers);
  const ipHash = ip ? hashIp(ip, captureIpSalt()) : null;
  const userAgent = truncateUserAgent(request.headers.get("user-agent"));

  try {
    await assertCaptureStore();
    if (ipHash) {
      const recent = await countRecentByIpHash(ipHash);
      if (recent + planned.images.length > HOURLY_UPLOAD_CAP) {
        return NextResponse.json(
          { ok: false, error: "Too many uploads from this network in the last hour." },
          { status: 429 },
        );
      }
    }
  } catch (error) {
    return captureDbFailure(error);
  }

  const batchId = randomUUID();
  const stored: Array<{ id: string; url: string; pathname: string; index: number }> = [];
  const rollbackBlobs = async () => {
    await Promise.all(stored.map((blob) => deleteCaptureBlob(blob.url).catch(() => undefined)));
  };

  try {
    for (let index = 0; index < planned.images.length; index++) {
      const image = planned.images[index]!;
      const id = randomUUID();
      const pathname = `ot-captures/${hospital.code}/${id}.${image.ext}`;
      const blob = await storeCaptureBlob(pathname, image.bytes, image.contentType);
      stored.push({ id, url: blob.url, pathname: blob.pathname, index });
    }
  } catch (error) {
    await rollbackBlobs();
    const message = error instanceof Error ? error.message : "";
    if (/token|BLOB_|not configured|access denied|No blob credentials/i.test(message)) {
      return NextResponse.json(
        { ok: false, error: "Blob storage is not configured for this deployment.", code: "blob_unconfigured" },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: "Could not store the image." }, { status: 500 });
  }

  try {
    await insertCaptures(
      stored.map((blob) => {
        const image = planned.images[blob.index]!;
        return {
          id: blob.id,
          hospitalCode: hospital.code,
          uploadedBy,
          userAgent,
          ipHash,
          blobUrl: blob.url,
          blobPathname: blob.pathname,
          contentType: image.contentType,
          bytes: image.bytes.byteLength,
          originalFilename: image.filename,
          batchId,
          photoIndex: blob.index + 1,
        };
      }),
    );
  } catch (error) {
    await rollbackBlobs();
    return captureDbFailure(error);
  }

  kickOcrAfterUpload(stored.map((blob) => blob.id));

  return NextResponse.json({
    ok: true,
    captures: stored.map((blob, index) => ({
      id: blob.id,
      status: "queued",
      batch_id: batchId,
      photo_index: index + 1,
    })),
  });
}
