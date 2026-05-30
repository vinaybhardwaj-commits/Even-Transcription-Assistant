/** TEMP — dump the stored voice_print centroid for the encounter's doctor. REMOVE. */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = await readAdminCookie(); if (!c) return respondError("AUTH_REQUIRED","x");
  try { await verifyAdminJwt(c); } catch { return respondError("AUTH_EXPIRED","x"); }
  const { id } = await params;
  const er = (await sql`SELECT doctor_id FROM encounter WHERE id=${id} LIMIT 1`) as Array<{doctor_id:string}>;
  if (!er[0]) return respondError("NOT_FOUND","no enc");
  const vp = (await sql`SELECT encode(centroid,'base64') AS b, octet_length(centroid) AS blen, sample_count FROM voice_print WHERE doctor_id=${er[0].doctor_id} LIMIT 1`) as Array<{b:string;blen:number;sample_count:number}>;
  if (!vp[0]) return respondOk({ found:false });
  const buf = Buffer.from(vp[0].b, "base64");
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + 12);
  const f = Array.from(new Float32Array(ab));
  return respondOk({ found:true, db_byte_length: vp[0].blen, sample_count: vp[0].sample_count, b64_len: vp[0].b.length, decoded_bytes: buf.length, first3_floats: f });
}
