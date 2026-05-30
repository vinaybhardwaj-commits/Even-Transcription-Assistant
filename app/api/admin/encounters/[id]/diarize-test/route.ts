/** TEMP — GET /api/admin/encounters/{id}/diarize-test : run /diarize WITH the
 * doctor's enrolled centroid to verify clinician naming. REMOVE after. */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { sql } from "@/lib/db";
import { headObject, getObjectBytes } from "@/lib/r2";
import { runDiarize } from "@/lib/diarize";
import { respondOk, respondError } from "@/lib/respond";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await readAdminCookie(); if (!c) return respondError("AUTH_REQUIRED", "x");
  try { await verifyAdminJwt(c); } catch { return respondError("AUTH_EXPIRED", "x"); }
  const { id } = await params;
  const rows = (await sql`SELECT audio_object_key, doctor_id FROM encounter WHERE id = ${id} LIMIT 1`) as Array<{ audio_object_key: string | null; doctor_id: string }>;
  const r = rows[0]; if (!r?.audio_object_key) return respondError("NOT_FOUND", "no audio");
  const vp = (await sql`SELECT encode(vp.centroid,'base64') AS b, d.full_name AS n FROM voice_print vp JOIN doctor d ON d.id=vp.doctor_id WHERE vp.doctor_id=${r.doctor_id} LIMIT 1`) as Array<{ b: string; n: string }>;
  const cents = vp[0]?.b ? [{ clinician_id: r.doctor_id, full_name: vp[0].n, centroid_base64: vp[0].b }] : [];
  const head = await headObject(r.audio_object_key);
  const bytes = await getObjectBytes(r.audio_object_key);
  if (!bytes) return respondError("NOT_FOUND", "no bytes");
  const d = await runDiarize(bytes, head.content_type || "audio/webm", { encounterId: id, clinicianCentroids: cents, manualRelabels: [] });
  return respondOk({ ok: d.ok, centroids_sent: cents.length, speakers: d.ok ? d.result.speakers : null, error: d.ok ? null : d.error });
}
