/**
 * TEMPORARY DIAGNOSTIC — POST /api/admin/stt-lab/ekascribe-probe
 * Auth: Bearer MIGRATION_SECRET. Body: { encounterId, maxWaitMs? }.
 * Loads an encounter's R2 audio and runs the eka.care v2 flow verbosely,
 * requesting transcript_template + clinical_notes_template + eka_emr_template
 * in ONE init, then dumps the raw status output[] so we can see exactly how
 * the ASR template behaves. Remove after diagnosis.
 */
import { NextRequest } from "next/server";
import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";
import { headObject, getObjectBytes } from "@/lib/r2";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 300;

const BASE = "https://api.eka.care";
const nano = customAlphabet("abcdefghjkmnpqrstuvwxyz0123456789", 14);

function extFor(ct: string): string {
  const t = (ct.split(";")[0] || "").trim().toLowerCase();
  return t.includes("mp4") || t.includes("m4a") ? "m4a" : t.includes("wav") ? "wav" : t.includes("ogg") ? "ogg" : "webm";
}
function decodePreview(value: unknown): { value_len: number; decoded_preview: string } {
  if (typeof value !== "string") return { value_len: 0, decoded_preview: JSON.stringify(value)?.slice(0, 300) ?? "" };
  let s = value;
  try { s = Buffer.from(value, "base64").toString("utf8"); } catch { /* not b64 */ }
  return { value_len: s.length, decoded_preview: s.slice(0, 400) };
}

export async function POST(req: NextRequest) {
  const secret = process.env.MIGRATION_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return respondError("AUTH_REQUIRED", "migration secret required");
  let body: { encounterId?: string; maxWaitMs?: number } = {};
  try { body = (await req.json()) as typeof body; } catch { /* */ }
  if (!body.encounterId) return respondError("VALIDATION_FAILED", "encounterId required");
  const maxWaitMs = Math.min(body.maxWaitMs ?? 180_000, 270_000);
  const log: Record<string, unknown> = { encounterId: body.encounterId };
  const t0 = Date.now();

  try {
    const rows = (await sql`SELECT id, audio_object_key, detected_language FROM encounter WHERE id = ${body.encounterId} LIMIT 1`) as Array<{ id: string; audio_object_key: string | null; detected_language: string | null }>;
    const enc = rows[0];
    if (!enc) return respondError("NOT_FOUND", "encounter not found");
    if (!enc.audio_object_key) return respondError("VALIDATION_FAILED", "encounter has no audio");
    log.detected_language = enc.detected_language;

    const head = await headObject(enc.audio_object_key);
    const contentType = head.content_type || "audio/webm";
    log.content_type = contentType; log.size = head.size;
    const b = await getObjectBytes(enc.audio_object_key);
    if (!b) return respondError("NOT_FOUND", "audio object missing in R2");
    const audio = Buffer.from(b);

    // 0. login
    const id = process.env.EKACARE_CLIENT_ID, sec = process.env.EKACARE_CLIENT_SECRET;
    log.creds_present = Boolean(id && sec);
    const lr = await fetch(`${BASE}/connect-auth/v1/account/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: id, client_secret: sec }), cache: "no-store", signal: AbortSignal.timeout(15_000) });
    log.login_status = lr.status;
    const lj = (await lr.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!lj.access_token) { log.login_body = JSON.stringify(lj).slice(0, 300); return respondOk(log); }
    const token = lj.access_token;
    const H = { Authorization: `Bearer ${token}` };
    const txn = `eta_${nano()}`;
    const fname = `audio.${extFor(contentType)}`;
    const baseType = (contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
    const lang = "en-IN";
    log.txn = txn; log.fname = fname;

    // 1. presigned
    const pres = await fetch(`${BASE}/v1/file-upload?txn_id=${encodeURIComponent(txn)}&action=ekascribe-v2`, { method: "POST", headers: H, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    log.presigned_status = pres.status;
    const presText = await pres.text();
    if (!pres.ok) { log.presigned_body = presText.slice(0, 400); return respondOk(log); }
    const pj = JSON.parse(presText) as { uploadData: { url: string; fields: Record<string, string> }; folderPath: string };
    log.presigned_keys = Object.keys(pj); log.upload_fields = Object.keys(pj.uploadData?.fields ?? {});

    // 2. s3 upload
    const form = new FormData();
    for (const [k, v] of Object.entries(pj.uploadData.fields)) form.append(k, k === "key" ? v.replace("${filename}", fname) : v);
    form.append("file", new Blob([audio], { type: baseType }), fname);
    const up = await fetch(pj.uploadData.url, { method: "POST", body: form, cache: "no-store", signal: AbortSignal.timeout(60_000) });
    log.s3_status = up.status;
    if (!(up.status === 200 || up.status === 201 || up.status === 204)) { log.s3_body = (await up.text()).slice(0, 300); return respondOk(log); }

    // 3. init — request ALL THREE templates in one go
    const templates = ["transcript_template", "clinical_notes_template", "eka_emr_template"];
    const initBody = {
      mode: "dictation", transfer: "non-vaded",
      batch_s3_url: pj.uploadData.url + pj.folderPath,
      client_generated_files: [fname], model_type: process.env.EKASCRIBE_MODEL || "pro",
      input_language: [lang], output_language: "en-IN",
      output_format_template: templates.map((t) => ({ template_id: t, codification_needed: false })),
    };
    const init = await fetch(`${BASE}/voice/api/v2/transaction/init/${encodeURIComponent(txn)}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(initBody), cache: "no-store", signal: AbortSignal.timeout(20_000) });
    log.init_status = init.status;
    log.init_body = (await init.text()).slice(0, 400);
    if (!(init.status === 200 || init.status === 201)) return respondOk(log);

    // 4. poll
    const polls: Array<{ at_ms: number; status: number; output?: unknown }> = [];
    let finalOutput: unknown = null;
    while (Date.now() - t0 < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await fetch(`${BASE}/voice/api/v3/status/${encodeURIComponent(txn)}`, { headers: H, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (st.status === 202) { polls.push({ at_ms: Date.now() - t0, status: 202 }); continue; }
      const sj = (await st.json().catch(() => ({}))) as { data?: { output?: Array<{ template_id: string; value: unknown; status: string; type?: string; name?: string; errors?: string[]; warnings?: string[] }> } };
      const out = (sj.data?.output ?? []).map((o) => ({ template_id: o.template_id, type: o.type, name: o.name, status: o.status, errors: o.errors, warnings: o.warnings, ...decodePreview(o.value) }));
      polls.push({ at_ms: Date.now() - t0, status: st.status, output: out });
      if (st.status === 200 || st.status === 206) { finalOutput = out; break; }
      if (![200, 202, 206].includes(st.status)) break;
    }
    log.polls = polls;
    log.final_output = finalOutput;
    log.total_ms = Date.now() - t0;
    return respondOk(log);
  } catch (e) {
    log.exception = String(e).slice(0, 300);
    log.total_ms = Date.now() - t0;
    return respondOk(log);
  }
}
