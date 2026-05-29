/** TEMP DIAGNOSTIC — GET /api/admin/encounters/{id}/batch-test
 * Runs the full-file Sarvam batch translate on the encounter's real R2 audio,
 * verifying the batch pipeline works in the Vercel runtime. REMOVE after. */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { sql } from "@/lib/db";
import { headObject, getObjectBytes } from "@/lib/r2";
import { sarvamBatchTranslate, SARVAM_MEDICAL_PROMPT } from "@/lib/sarvam";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await readAdminCookie();
  if (!c) return respondError("AUTH_REQUIRED", "x");
  try { await verifyAdminJwt(c); } catch { return respondError("AUTH_EXPIRED", "x"); }
  const { id } = await params;
  const rows = (await sql`SELECT audio_object_key FROM encounter WHERE id = ${id} LIMIT 1`) as Array<{ audio_object_key: string | null }>;
  const key = rows[0]?.audio_object_key;
  if (!key) return respondError("NOT_FOUND", "no audio");
  const head = await headObject(key);
  const bytes = await getObjectBytes(key);
  if (!bytes) return respondError("NOT_FOUND", "no bytes");
  const t0 = Date.now();
  const bt = await sarvamBatchTranslate(bytes, head.content_type || "audio/webm", { prompt: SARVAM_MEDICAL_PROMPT });
  return respondOk({
    content_type: head.content_type, bytes: head.size, elapsed_ms: Date.now() - t0,
    ok: bt.ok, lang: bt.ok ? bt.languageCode : null,
    text: bt.ok ? bt.transcript.slice(0, 500) : null, error: bt.ok ? null : bt.error,
  });
}
