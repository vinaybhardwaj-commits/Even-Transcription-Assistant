/**
 * GET /api/admin/encounters
 *
 * Cross-doctor encounter log for /admin/encounters (Sprint 8).
 *
 * Query params:
 *   ?bucket=all|sent|failed|draft|processing  (V's Q1 filter chips)
 *   ?window=today|week|month|all              (defaults to month)
 *   ?limit=25                                  (clamped 1..200)
 *   ?offset=0
 *
 * Returns: { rows, total, counts }
 *   - rows: paginated encounter rows joined to doctor + send aggregates
 *   - total: total matching rows for the current bucket+window
 *   - counts: bucket counts within the chosen window (for chip labels)
 *
 * Gated by eta_admin_session cookie.
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import {
  listAdminEncounters,
  type EncountersBucket,
  type EncountersWindow,
} from "@/lib/encounter/admin";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseBucket(raw: string | null): EncountersBucket {
  if (raw === "sent" || raw === "failed" || raw === "draft" || raw === "processing") return raw;
  return "all";
}

function parseWindow(raw: string | null): EncountersWindow {
  if (raw === "today" || raw === "week" || raw === "month" || raw === "all") return raw;
  return "month";
}

export async function GET(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    await verifyAdminJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }

  const url = new URL(req.url);
  const NOTE_TYPES = ["clinic_encounter", "general_medical", "operative_procedure", "dietetic_consult", "physiotherapy"];
  const rawNoteType = url.searchParams.get("note_type");
  const noteType = rawNoteType && NOTE_TYPES.includes(rawNoteType) ? rawNoteType : null;
  const bucket = parseBucket(url.searchParams.get("bucket"));
  const window = parseWindow(url.searchParams.get("window"));
  const limit  = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  // doctor_id is an optional filter — when set, scopes rows + counts to that doctor.
  // We validate by prefix only; the SQL parameter-binds it so it's already escape-safe.
  const rawDoctorId = url.searchParams.get("doctor_id");
  const doctorId =
    typeof rawDoctorId === "string" && rawDoctorId.startsWith("doc_")
      ? rawDoctorId
      : null;

  const result = await listAdminEncounters({
    bucket,
    window,
    limit: Number.isFinite(limit) ? limit : 25,
    offset: Number.isFinite(offset) ? offset : 0,
    doctorId,
    noteType,
  });

  return respondOk({
    ...result,
    filter: { bucket, window, limit, offset, doctor_id: doctorId },
  });
}
