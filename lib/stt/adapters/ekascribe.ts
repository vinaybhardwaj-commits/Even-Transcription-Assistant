/**
 * Ekascribe (eka.care) — async job-based medical scribe (L7).
 * Auth: client-credentials -> Bearer JWT (cached). Flow per request:
 *   1) POST /connect-auth/v1/account/login {client_id,client_secret} -> token
 *   2) POST /v1/file-upload?txn_id&action=ekascribe-v2 -> presigned S3 POST
 *   3) S3 POST (multipart: fields + file)
 *   4) POST /voice/api/v2/transaction/init/{txn} {template, model, language, ...}
 *   5) poll GET /voice/api/v3/status/{txn} until 200 (or 206)
 * Serves the ASR tier (transcript_template) AND the scribe tier
 * (clinical_notes_template) via generateNote().
 */
import { customAlphabet } from "nanoid";
import type { SttAdapter, SttTranscribeResult, SttNoteResult } from "../types";

const BASE = "https://api.eka.care";
const nano = customAlphabet("abcdefghjkmnpqrstuvwxyz0123456789", 14);

let cachedToken: { token: string; exp: number } | null = null;

async function getToken(): Promise<string | null> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const id = process.env.EKACARE_CLIENT_ID, secret = process.env.EKACARE_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch(`${BASE}/connect-auth/v1/account/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: id, client_secret: secret }), cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 1800) * 1000 };
  return j.access_token;
}

function extFor(ct: string): string {
  const t = (ct.split(";")[0] || "").trim().toLowerCase();
  return t.includes("mp4") || t.includes("m4a") ? "m4a" : t.includes("wav") ? "wav" : t.includes("ogg") ? "ogg" : "webm";
}

function decodeValue(value: unknown): { obj: unknown; text: string } {
  if (typeof value !== "string") return { obj: value, text: typeof value === "object" ? JSON.stringify(value) : String(value ?? "") };
  let s = value;
  try { s = Buffer.from(value, "base64").toString("utf8"); } catch { /* not base64 */ }
  let obj: unknown = s;
  try { obj = JSON.parse(s); } catch { return { obj: s, text: s }; }
  // extract a readable transcript/note from common shapes
  const pick = (o: unknown): string | null => {
    if (typeof o === "string") return o;
    if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      for (const k of ["transcript", "text", "note", "content", "summary"]) if (typeof r[k] === "string") return r[k] as string;
    }
    return null;
  };
  const t = pick(obj);
  return { obj, text: t ?? (typeof obj === "string" ? obj : JSON.stringify(obj)) };
}

type JobResult = { ok: true; obj: unknown; text: string; latencyMs: number } | { ok: false; error: string; latencyMs: number };

async function runJob(audio: Buffer, contentType: string, templateId: string, opts: { language?: string; maxWaitMs?: number }): Promise<JobResult> {
  const t0 = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 150_000;
  const token = await getToken();
  if (!token) return { ok: false, error: "ekacare_auth_failed", latencyMs: Date.now() - t0 };
  const H = { Authorization: `Bearer ${token}` };
  const txn = `eta_${nano()}`;
  const fname = `audio.${extFor(contentType)}`;
  const baseType = (contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
  const lang = (opts.language && opts.language.toLowerCase().startsWith("en")) ? "en-IN" : (opts.language && opts.language.length >= 2 ? opts.language.slice(0, 2) : "en-IN");

  try {
    // 1. presigned
    const pres = await fetch(`${BASE}/v1/file-upload?txn_id=${encodeURIComponent(txn)}&action=ekascribe-v2`, { method: "POST", headers: H, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!pres.ok) return { ok: false, error: `presigned_${pres.status}: ${(await pres.text()).slice(0, 100)}`, latencyMs: Date.now() - t0 };
    const pj = (await pres.json()) as { uploadData: { url: string; fields: Record<string, string> }; folderPath: string };
    // 2. S3 POST upload
    const form = new FormData();
    for (const [k, v] of Object.entries(pj.uploadData.fields)) form.append(k, k === "key" ? v.replace("${filename}", fname) : v);
    form.append("file", new Blob([audio], { type: baseType }), fname);
    const up = await fetch(pj.uploadData.url, { method: "POST", body: form, cache: "no-store", signal: AbortSignal.timeout(60_000) });
    if (!(up.status === 200 || up.status === 201 || up.status === 204)) return { ok: false, error: `s3_upload_${up.status}`, latencyMs: Date.now() - t0 };
    // 3. init
    const initBody = {
      mode: "dictation", transfer: "non-vaded",
      batch_s3_url: pj.uploadData.url + pj.folderPath,
      client_generated_files: [fname], model_type: process.env.EKASCRIBE_MODEL || "pro",
      input_language: [lang], output_language: "en-IN",
      output_format_template: [{ template_id: templateId, codification_needed: false }],
    };
    const init = await fetch(`${BASE}/voice/api/v2/transaction/init/${encodeURIComponent(txn)}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(initBody), cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!(init.status === 200 || init.status === 201)) return { ok: false, error: `init_${init.status}: ${(await init.text()).slice(0, 100)}`, latencyMs: Date.now() - t0 };
    // 4. poll
    while (Date.now() - t0 < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await fetch(`${BASE}/voice/api/v3/status/${encodeURIComponent(txn)}`, { headers: H, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (st.status === 202) continue;
      if (st.status === 200 || st.status === 206) {
        const sj = (await st.json()) as { data?: { output?: Array<{ template_id: string; value: unknown; status: string }> } };
        const out = (sj.data?.output ?? []).find((o) => o.template_id === templateId);
        if (!out) return { ok: false, error: "no_output_for_template", latencyMs: Date.now() - t0 };
        if (out.status === "failure") return { ok: false, error: "template_failure", latencyMs: Date.now() - t0 };
        const { obj, text } = decodeValue(out.value);
        if (!text || !text.trim()) return { ok: false, error: "empty_output", latencyMs: Date.now() - t0 };
        return { ok: true, obj, text: text.trim(), latencyMs: Date.now() - t0 };
      }
      return { ok: false, error: `status_${st.status}`, latencyMs: Date.now() - t0 };
    }
    return { ok: false, error: "timeout", latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: `exc: ${String(e).slice(0, 120)}`, latencyMs: Date.now() - t0 };
  }
}

export const ekascribeAdapter: SttAdapter = {
  key: "ekascribe",
  capabilities: { tiers: ["scribe"], stages: ["note"], languages: ["indic", "multi"], streaming: false, translates: true, async: true },
  async transcribe(): Promise<SttTranscribeResult> {
    // EkaScribe is an end-to-end medical scribe. This account does NOT expose a
    // verbatim ASR transcript — transcript_template is silently unsupported
    // (eka.care returns clinical_notes_template / eka_emr_template only). So we
    // do not participate in the ASR tier; EkaScribe competes on the scribe tier
    // via generateNote(). Capability 'asr' is removed from the registry row too
    // (migration 0023) so the ASR fan-out never selects this engine.
    return { original: null, english: null, language: null, latencyMs: 0, costUsd: null, error: "asr_unsupported_on_account" };
  },
  async generateNote(audio, opts): Promise<SttNoteResult> {
    const r = await runJob(audio, opts.contentType, opts.template || process.env.EKASCRIBE_SCRIBE_TEMPLATE || "clinical_notes_template", { language: opts.language });
    if (r.ok) return { note: r.obj, noteText: r.text, latencyMs: r.latencyMs, costUsd: null, error: null };
    return { note: null, noteText: null, latencyMs: r.latencyMs, costUsd: null, error: r.error };
  },
  async health() {
    const t0 = Date.now();
    if (!process.env.EKACARE_CLIENT_ID || !process.env.EKACARE_CLIENT_SECRET) return { ok: false, latencyMs: 0, error: "ekacare_creds_missing" };
    const token = await getToken();
    return token ? { ok: true, latencyMs: Date.now() - t0 } : { ok: false, latencyMs: Date.now() - t0, error: "auth_failed" };
  },
};
