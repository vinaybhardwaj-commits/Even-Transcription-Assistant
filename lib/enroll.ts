/**
 * Voice-enrollment producer client (v2.1, V2.SD.1).
 *
 * Calls the Mac Mini diarize service's /enroll endpoint to turn a voice clip
 * into a 192-dim ECAPA embedding (same model /diarize matches against), and
 * averages N sentence embeddings into the stored centroid.
 *
 * Env: DIARIZE_BASE_URL (shared with lib/diarize.ts), or the DIARIZE_BASE_URLS pool (REDUNDANCY-R1).
 */
import { endpointsFor, runPool, type Verdict } from "@/lib/service-pool";
import { withServiceAccess, withDiarizeAuth } from "@/lib/service-access";

const ENROLL_TIMEOUT_MS = 60_000;
const DIM = 192;

export type EnrollOutcome =
  | { ok: true; embeddingBase64: string; served_by?: string }
  | { ok: false; error: string; served_by?: string };

/**
 * REDUNDANCY-R1 — transport, timeout, 5xx or 404 (R2: that endpoint does not serve /enroll): try the next endpoint.
 * Any other refusal or `ok:false` is the answer.
 */
export function enrollVerdict(o: EnrollOutcome): Verdict {
  if (o.ok) return "ok";
  if (o.error === "timeout" || o.error.startsWith("network:")) return "failover";
  const m = /^http_(\d{3})/.exec(o.error);
  if (!m) return "final";
  const status = Number(m[1]);
  return status >= 500 || status === 404 ? "failover" : "final";
}

export async function runEnroll(
  audio: Buffer | Uint8Array,
  contentType: string,
): Promise<EnrollOutcome> {
  // Its own route pool (R2), falling back to the diarize lists and then DIARIZE_BASE_URL.
  const endpoints = endpointsFor("diarize_enroll");
  if (endpoints.length === 0) return { ok: false, error: "diarize_base_url_missing" };
  // R1: the whole pool gets the ONE timeout an enroll call always had.
  const { value, served_by } = await runPool(
    "diarize_enroll", endpoints,
    (base, budgetMs) => enrollAt(base, audio, contentType, budgetMs),
    enrollVerdict,
    { budgetMs: ENROLL_TIMEOUT_MS },
  );
  return served_by ? { ...value, served_by } : value;
}

async function enrollAt(base: string, audio: Buffer | Uint8Array, contentType: string, timeoutMs: number): Promise<EnrollOutcome> {
  const baseType = (contentType.split(";")[0] || "").trim().toLowerCase() || "audio/webm";
  const ext = baseType.includes("webm") ? "webm" : baseType.includes("mp4") ? "mp4" : baseType.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: baseType }), `audio.${ext}`);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${base.replace(/\/+$/, "")}/enroll`;
    const res = await fetch(url, withServiceAccess(url, withDiarizeAuth(url, {
      method: "POST", body: form, signal: ctrl.signal, cache: "no-store",
    })));
    clearTimeout(tid);
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, error: `http_${res.status}: ${text.slice(0, 160)}` };
    const j = JSON.parse(text) as { ok?: boolean; embedding_base64?: string; dim?: number; error?: string };
    if (j.ok === false || !j.embedding_base64) return { ok: false, error: j.error || "no_embedding" };
    return { ok: true, embeddingBase64: j.embedding_base64 };
  } catch (e: unknown) {
    clearTimeout(tid);
    return { ok: false, error: ctrl.signal.aborted ? "timeout" : `network: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Average N base64 float32[192] embeddings → base64 float32[192] centroid. */
export function averageEmbeddings(b64s: string[]): string {
  const mean = new Float32Array(DIM);
  let n = 0;
  for (const b of b64s) {
    const buf = Buffer.from(b, "base64");
    if (buf.length < DIM * 4) continue;
    const v = new Float32Array(buf.buffer, buf.byteOffset, DIM);
    for (let i = 0; i < DIM; i++) mean[i] += v[i];
    n++;
  }
  if (n === 0) throw new Error("no_valid_embeddings");
  for (let i = 0; i < DIM; i++) mean[i] /= n;
  return Buffer.from(mean.buffer, mean.byteOffset, DIM * 4).toString("base64");
}

/** Cosine similarity between two base64 float32[192] embeddings. */
export function cosineSimilarity(aB64: string, bB64: string): number | null {
  const a = b64ToF32(aB64);
  const b = b64ToF32(bB64);
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function b64ToF32(b64: string): Float32Array | null {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < DIM * 4) return null;
  // copy into a fresh, 4-byte-aligned ArrayBuffer (Buffer.from may be unaligned)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + DIM * 4);
  return new Float32Array(ab);
}
