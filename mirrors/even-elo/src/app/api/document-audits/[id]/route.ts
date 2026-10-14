import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { loadDocumentAuditDetail } from "@/lib/document-audits-db";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401, headers: NO_STORE },
    );
  }

  const { id } = await context.params;
  try {
    const detail = await loadDocumentAuditDetail(id);
    if (!detail) {
      return NextResponse.json(
        { ok: false, error: "Document audit not found" },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json({ ok: true, ...detail }, { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not load document audit" },
      { status: 500, headers: NO_STORE },
    );
  }
}
