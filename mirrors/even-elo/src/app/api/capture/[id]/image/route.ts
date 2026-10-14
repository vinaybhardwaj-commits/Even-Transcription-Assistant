import { NextResponse } from "next/server";
import { getCapture, isMissingCaptureTable } from "@/lib/capture/db";
import { readCaptureBlob } from "@/lib/capture/blob-store";
import { isUuid, migrationRequiredResponse, requireCaptureStaff } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: { id: string } }) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;
  const id = context.params.id;
  if (!isUuid(id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  try {
    const row = await getCapture(id);
    if (!row?.blob_pathname) {
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    const blob = await readCaptureBlob(row.blob_pathname);
    if (!blob || blob.statusCode !== 200 || !blob.stream) {
      return NextResponse.json({ ok: false, error: "Image is not in the blob store." }, { status: 404 });
    }
    const contentType = row.content_type || blob.blob.contentType || "application/octet-stream";
    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.includes("heic")
          ? "heic"
          : contentType.includes("heif")
            ? "heif"
            : "jpg";
    return new NextResponse(blob.stream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="ot-capture-${id}.${ext}"`,
      },
    });
  } catch (error) {
    if (isMissingCaptureTable(error)) return migrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not read the image." }, { status: 500 });
  }
}
