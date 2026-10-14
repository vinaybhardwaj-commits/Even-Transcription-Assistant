import "server-only";
import { NextResponse } from "next/server";
import { getCurrentUser, type JWTPayload } from "@/lib/auth";
import { isOtCaptureEnabled } from "./access";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export async function requireCaptureStaff(): Promise<
  { user: JWTPayload } | { response: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return { response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }
  if (!user.is_super_admin) {
    return { response: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }) };
  }
  if (!isOtCaptureEnabled()) {
    return {
      response: NextResponse.json({ ok: false, error: "OT capture is off", code: "flag_off" }, { status: 404 }),
    };
  }
  return { user };
}

export function migrationRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "gov_document_captures is not migrated yet. POST /api/admin/migrate on this deployment.",
      code: "migration_required",
    },
    { status: 503 },
  );
}

export function sheetMigrationRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "gov_ot_tracking_sheets is not migrated yet. POST /api/admin/migrate on this deployment.",
      code: "migration_required",
    },
    { status: 503 },
  );
}
