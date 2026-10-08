/**
 * lib/sarvam-gw.ts — S8A: the Sarvam calls the new MCP code makes, through the AWS gateway (lib/sarvam-gateway.ts). Bodies and shapes are the ones
 * lib/sarvam.ts already uses against api.sarvam.ai; only the transport differs. The direct callers of lib/sarvam.ts (room drain, fanout, bake-offs)
 * are NOT touched and keep SARVAM_API_KEY.
 *
 * Batch model saaras:v3 ONLY (the gateway does not cover saarika:v2.5, today's direct default). Every function returns a result object and never
 * throws; error strings are codes (`init_502`, `sarvam_gateway_sts: 403 AccessDenied`), never a response body, a token or a URL.
 *
 * S8A-FIX: the batch submit is split in three idempotent calls (init / upload / start) so the job can persist Sarvam's job id BETWEEN them; every
 * failure carries `status` (HTTP, when there was one) and `transient` (429, 5xx, timeout, network: worth retrying; a 4xx is terminal).
 */
import { gatewayFetch, SarvamGatewayError } from "./sarvam-gateway";

export const SARVAM_GW_STT_MODEL = "saaras:v3";
export const SARVAM_GW_TRANSLATE_MODEL = "mayura:v1";
export const TRANSLATE_CHUNK_CHARS = 900;
const JOB_PATH = "/speech-to-text/job/v1";
const XFER_TIMEOUT_MS = 60_000;

/** languageCode: the entry's OWN language if the response carries one (null when it does not: saaras gives one code for the whole file) */
export type GwEntry = { transcript: string; start: number; end: number; speakerId: string; languageCode: string | null };
export type Fail = { ok: false; error: string; status?: number; transient: boolean };

/** 429 and 5xx are worth another try; so is a timeout or a network failure. Any other status is the caller's problem. PURE. */
export const isTransientStatus = (status: number | undefined): boolean => status === undefined || status === 429 || status >= 500;

function failFrom(error: string, status?: number): Fail {
  return { ok: false, error, ...(status !== undefined ? { status } : {}), transient: isTransientStatus(status) };
}
/** A thrown gateway error: a typed gateway code; transient unless it is configuration / a bad key / a 4xx from Google or AWS. */
function failFromThrown(e: unknown): Fail {
  if (e instanceof SarvamGatewayError) {
    const status = /(?:^|\s)(\d{3})(?:\s|$)/.exec(e.detail ?? "")?.[1];
    const code = status ? Number(status) : undefined;
    const permanent = e.code === "sarvam_gateway_not_configured" || e.code === "sarvam_gateway_key_invalid";
    return { ok: false, error: e.message, ...(code !== undefined ? { status: code } : {}), transient: !permanent && (code === undefined || isTransientStatus(code)) };
  }
  return { ok: false, error: `gw_exc: ${(e as { name?: string })?.name ?? "error"}`, transient: true };
}

const baseType = (ct: string): string => (ct.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
const extOf = (ct: string): string => (ct.includes("wav") ? "wav" : ct.includes("ogg") ? "ogg" : ct.includes("mp4") || ct.includes("m4a") ? "mp4" : ct.includes("mpeg") || ct.includes("mp3") ? "mp3" : "webm");

async function jsonPost(route: string, body: unknown): Promise<{ ok: true; json: Record<string, unknown> } | Fail> {
  const res = await gatewayFetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    await res.text().catch(() => ""); // drained, never quoted
    return failFrom(`http_${res.status}`, res.status);
  }
  try {
    return { ok: true, json: (await res.json()) as Record<string, unknown> };
  } catch {
    return { ok: false, error: "bad_json", status: res.status, transient: false };
  }
}

export type BatchStartOpts = { mode?: "transcribe" | "codemix" | "translate"; languageCode?: string | null; numSpeakers?: number | null; prompt?: string | null };

/** 1. init — returns Sarvam's job id. The caller persists it BEFORE anything else, so a replay resumes instead of paying twice. */
export async function gwBatchInit(opts: BatchStartOpts = {}): Promise<{ ok: true; jobId: string } | Fail> {
  try {
    const init = await jsonPost(JOB_PATH, {
      job_parameters: {
        model: SARVAM_GW_STT_MODEL,
        with_diarization: true,
        with_timestamps: true,
        ...(opts.mode === "codemix" || opts.mode === "translate" ? { mode: opts.mode } : {}), // translate = speech -> English (S8A4 second pass)
        ...(opts.languageCode ? { language_code: opts.languageCode } : {}),
        ...(opts.numSpeakers ? { num_speakers: opts.numSpeakers } : {}),
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      },
    });
    if (!init.ok) return { ...init, error: `init_${init.status ?? init.error}` };
    const jobId = typeof init.json.job_id === "string" ? init.json.job_id : "";
    return jobId ? { ok: true, jobId } : { ok: false, error: "init_no_job_id", transient: false };
  } catch (e) {
    return failFromThrown(e);
  }
}

/** 2. upload-files -> Azure PUT (NOT signed). Re-running it for the same job just overwrites the blob. */
export async function gwBatchUpload(jobId: string, audio: Uint8Array, contentType: string): Promise<{ ok: true } | Fail> {
  const type = baseType(contentType);
  const fname = `audio.${extOf(type)}`;
  try {
    const up = await jsonPost(`${JOB_PATH}/upload-files`, { job_id: jobId, files: [fname] });
    if (!up.ok) return { ...up, error: `upload_links_${up.status ?? up.error}` };
    const urls = up.json.upload_urls as Record<string, { file_url?: string }> | undefined;
    const putUrl = urls?.[fname]?.file_url;
    if (!putUrl) return { ok: false, error: "no_upload_url", transient: false };
    // The blob URL is Azure's own, pre-signed; the gateway's SigV4 does not apply and must not be sent.
    const sv = /[?&]sv=([^&]+)/.exec(putUrl)?.[1];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), XFER_TIMEOUT_MS);
    let put: Response;
    try {
      put = await fetch(putUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": type, ...(sv ? { "x-ms-version": sv } : {}) }, body: Buffer.from(audio), signal: ctrl.signal });
    } catch {
      return { ok: false, error: ctrl.signal.aborted ? "azure_put_timeout" : "azure_put_network", transient: true };
    } finally {
      clearTimeout(timer);
    }
    return put.ok ? { ok: true } : failFrom(`azure_put_${put.status}`, put.status);
  } catch (e) {
    return failFromThrown(e);
  }
}

/** 3. start. */
export async function gwBatchStartJob(jobId: string): Promise<{ ok: true } | Fail> {
  try {
    const start = await jsonPost(`${JOB_PATH}/${encodeURIComponent(jobId)}/start`, {});
    return start.ok ? { ok: true } : { ...start, error: `start_${start.status ?? start.error}` };
  } catch (e) {
    return failFromThrown(e);
  }
}

export type BatchStatus = { ok: true; state: "Pending" | "Running" | "Completed" | "Failed" | string; outputs: string[] } | Fail;

export async function gwBatchStatus(jobId: string): Promise<BatchStatus> {
  try {
    const res = await gatewayFetch(`${JOB_PATH}/${encodeURIComponent(jobId)}/status`, { method: "GET" });
    if (!res.ok) {
      await res.text().catch(() => "");
      return failFrom(`status_${res.status}`, res.status);
    }
    const st = (await res.json()) as { job_state?: string; job_details?: Array<{ outputs?: Array<{ file_name?: string }> }> };
    const outputs = (st.job_details ?? []).flatMap((d) => (d.outputs ?? []).map((o) => String(o.file_name ?? "")).filter(Boolean));
    return { ok: true, state: String(st.job_state ?? "Pending"), outputs };
  } catch (e) {
    return failFromThrown(e);
  }
}

export type BatchOutput = { ok: true; transcript: string; languageCode: string | null; entries: GwEntry[] } | Fail;

/**
 * download-files -> GET each output (a short-lived Azure URL, unsigned) -> transcript, language, diarized entries.
 * The timeout covers the BODY read too (the timer is cleared only after the JSON is parsed), so a stalled body cannot hang the step.
 */
export async function gwBatchResult(jobId: string, outputs: string[]): Promise<BatchOutput> {
  try {
    const dl = await jsonPost(`${JOB_PATH}/download-files`, { job_id: jobId, files: outputs });
    if (!dl.ok) return { ...dl, error: `download_links_${dl.status ?? dl.error}` };
    const urls = dl.json.download_urls as Record<string, { file_url?: string }> | undefined;
    let transcript = "";
    let lang: string | null = null;
    const entries: GwEntry[] = [];
    for (const name of outputs) {
      const u = urls?.[name]?.file_url;
      if (!u) continue;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), XFER_TIMEOUT_MS);
      let j: { transcript?: string; language_code?: string | null; diarized_transcript?: { entries?: Array<{ transcript?: string; start_time_seconds?: number; end_time_seconds?: number; speaker_id?: string | number; language_code?: string | null }> } };
      try {
        const r = await fetch(u, { cache: "no-store", signal: ctrl.signal });
        if (!r.ok) continue;
        j = (await r.json()) as typeof j;
      } catch {
        return { ok: false, error: ctrl.signal.aborted ? "download_timeout" : "download_network", transient: true };
      } finally {
        clearTimeout(timer);
      }
      if (j.transcript) transcript += (transcript ? " " : "") + j.transcript.trim();
      if (!lang && j.language_code) lang = j.language_code;
      for (const e of j.diarized_transcript?.entries ?? []) {
        if (e.transcript && e.transcript.trim()) {
          entries.push({ transcript: e.transcript.trim(), start: e.start_time_seconds ?? 0, end: e.end_time_seconds ?? 0, speakerId: String(e.speaker_id ?? ""), languageCode: typeof e.language_code === "string" && e.language_code ? e.language_code : null });
        }
      }
    }
    if (!transcript.trim() && entries.length === 0) return { ok: false, error: "empty_batch_transcript", transient: false };
    if (!transcript.trim()) transcript = entries.map((e) => e.transcript).join(" ");
    return { ok: true, transcript: transcript.trim(), languageCode: lang, entries };
  } catch (e) {
    return failFromThrown(e);
  }
}

/** Sentence-ish chunks of at most `max` characters (a single sentence longer than `max` is cut hard). PURE and deterministic. */
export function chunkText(text: string, max: number = TRANSLATE_CHUNK_CHARS): string[] {
  const clean = (text || "").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let buf = "";
  const push = (s: string) => {
    for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max));
  };
  for (const part of clean.split(/(?<=[.!?।\n])\s+/)) {
    if (buf && (buf + " " + part).length > max) {
      push(buf);
      buf = part;
    } else buf = buf ? `${buf} ${part}` : part;
  }
  if (buf) push(buf);
  return chunks;
}

/**
 * One mayura:v1 request (<= 900 chars). Source language: a BCP-47 code with a region when known, else "auto" — the same fallback
 * lib/sarvam.ts:312 (sarvamTranslateText) has always sent to mayura:v1, so the API is known to take it.
 */
export async function gwTranslateChunk(text: string, sourceLang?: string | null): Promise<{ ok: true; english: string } | Fail> {
  const src = sourceLang && sourceLang.includes("-") ? sourceLang : "auto";
  try {
    const r = await jsonPost("/translate", { input: text, source_language_code: src, target_language_code: "en-IN", model: SARVAM_GW_TRANSLATE_MODEL, mode: "formal" });
    if (!r.ok) return { ...r, error: `translate_${r.status ?? r.error}` };
    const english = typeof r.json.translated_text === "string" ? r.json.translated_text.trim() : "";
    return english ? { ok: true, english } : { ok: false, error: "empty_translation", transient: false };
  } catch (e) {
    return failFromThrown(e);
  }
}
