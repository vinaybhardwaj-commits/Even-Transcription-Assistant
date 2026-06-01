/**
 * TEMPORARY DIAGNOSTIC — POST /api/admin/stt-lab/ekascribe-probe
 * Auth: Bearer MIGRATION_SECRET. Body: { encounterId, templates?, repeat?, maxWaitMs? }.
 * Runs the eka.care v2 flow verbosely with whatever templates[] are requested
 * (default clinical_notes_template alone), so we can compare single-template vs
 * bundled behaviour and capture per-template status/errors. Remove after diagnosis.
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
  if (typeof value !== "string") return { value_len: 0, decoded_preview: (JSON.stringify(value) ?? "").slice(0, 200) };
  let s = value;
  try { s = Buffer.from(value, "base64").toString("utf8"); } catch { /* */ }
  return { value_len: s.length, decoded_preview: s.slice(0, 200) };
}

async function getToken(): Promise<string | null> {
  const id = process.env.EKACARE_CLIENT_ID, secret = process.env.EKACARE_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch(`${BASE}/connect-auth/v1/account/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: id, client_secret: secret }), cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return null;
  const j = (await r.json()) as { access_token?: string };
  return j.access_token ?? null;
}

async function oneRun(audio: Buffer, contentType: string, templates: string[], maxWaitMs: number) {
  const t0 = Date.now();
  const token = await getToken();
  if (!token) return { error: "auth_failed" };
  const H = { Authorization: `Bearer ${token}` };
  const txn = `eta_${nano()}`;
  const fname = `audio.${extFor(contentType)}`;
  const baseType = (contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
  const pres = await fetch(`${BASE}/v1/file-upload?txn_id=${encodeURIComponent(txn)}&action=ekascribe-v2`, { method: "POST", headers: H, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!pres.ok) return { error: `presigned_${pres.status}` };
  const pj = (await pres.json()) as { uploadData: { url: string; fields: Record<string, string> }; folderPath: string };
  const form = new FormData();
  for (const [k, v] of Object.entries(pj.uploadData.fields)) form.append(k, k === "key" ? v.replace("${filename}", fname) : v);
  form.append("file", new Blob([audio], { type: baseType }), fname);
  const up = await fetch(pj.uploadData.url, { method: "POST", body: form, cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (![200, 201, 204].includes(up.status)) return { error: `s3_${up.status}` };
  const initBody = { mode: "dictation", transfer: "non-vaded", batch_s3_url: pj.uploadData.url + pj.folderPath, client_generated_files: [fname], model_type: process.env.EKASCRIBE_MODEL || "pro", input_language: ["en-IN"], output_language: "en-IN", output_format_template: templates.map((t) => ({ template_id: t, codification_needed: false })) };
  const init = await fetch(`${BASE}/voice/api/v2/transaction/init/${encodeURIComponent(txn)}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(initBody), cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (![200, 201].includes(init.status)) return { error: `init_${init.status}: ${(await init.text()).slice(0,150)}` };
  while (Date.now() - t0 < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await fetch(`${BASE}/voice/api/v3/status/${encodeURIComponent(txn)}`, { headers: H, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (st.status === 202) continue;
    const sj = (await st.json().catch(() => ({}))) as { data?: { output?: Array<{ template_id: string; value: unknown; status: string; errors?: string[]; warnings?: string[] }> } };
    const out = (sj.data?.output ?? []).map((o) => ({ template_id: o.template_id, status: o.status, errors: o.errors, warnings: o.warnings, ...decodePreview(o.value) }));
    return { http: st.status, ms: Date.now() - t0, requested: templates, output: out };
  }
  return { error: "timeout", ms: Date.now() - t0 };
}

export async function POST(req: NextRequest) {
  const secret = process.env.MIGRATION_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return respondError("AUTH_REQUIRED", "migration secret required");
  let body: { encounterId?: string; templates?: string[]; repeat?: number; maxWaitMs?: number } = {};
  try { body = (await req.json()) as typeof body; } catch { /* */ }
  if (!body.encounterId) return respondError("VALIDATION_FAILED", "encounterId required");
  const templates = Array.isArray(body.templates) && body.templates.length ? body.templates : ["clinical_notes_template"];
  const repeat = Math.min(Math.max(body.repeat ?? 1, 1), 3);
  const maxWaitMs = Math.min(body.maxWaitMs ?? 38000, 250000);
  const rows = (await sql`SELECT audio_object_key FROM encounter WHERE id = ${body.encounterId} LIMIT 1`) as Array<{ audio_object_key: string | null }>;
  if (!rows[0]?.audio_object_key) return respondError("NOT_FOUND", "no audio");
  const head = await headObject(rows[0].audio_object_key);
  const contentType = head.content_type || "audio/webm";
  const b = await getObjectBytes(rows[0].audio_object_key);
  if (!b) return respondError("NOT_FOUND", "audio missing");
  const audio = Buffer.from(b);
  const runs = [];
  for (let i = 0; i < repeat; i++) runs.push(await oneRun(audio, contentType, templates, maxWaitMs));
  return respondOk({ encounterId: body.encounterId, content_type: contentType, runs });
}
