/**
 * GET /api/admin/stt-lab/runs — subjects that have batch ASR runs (list view).
 *
 * K4a C1 — THE JOIN IS THE WHOLE CHANGE. This used to read `FROM encounter e JOIN
 * transcription_run tr ON tr.encounter_id = e.id`, which cannot express a run whose subject is
 * not an encounter, and which would DROP one silently rather than show it wrong: an inner join
 * from encounter simply never produces the row. It now starts from transcription_run and LEFT
 * JOINs outwards, so a bench_window run appears with its encounter columns NULL.
 *
 * Grouping is on (subject_type, subject_id), not on the encounter. `id` is still returned and
 * is still the encounter id for an encounter subject — 0059's CHECK guarantees
 * subject_id = encounter_id there — so the existing UI's links keep working untouched.
 */
import { NextRequest } from "next/server";
import { listSttRunSubjects } from "@/lib/room-access/stt-reads";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { subjectOf, type SubjectRowish } from "@/lib/stt/subject";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

  // GUARD: the same subject list as the MCP tool (lib/room-access): a window with ANY held-out placement is left out
  const { visible: rows } = await listSttRunSubjects(limit);
  return respondOk({
    runs: rows.map((r) => ({ ...r, subject: subjectOf(r as SubjectRowish) })),
  });
}
