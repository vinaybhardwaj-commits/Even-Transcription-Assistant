/**
 * Voice-sample retention helpers (Voiceprint Retention PRD, Sprint A).
 *
 * Each enrollment clip (Sprint B: each passive encounter match) is retained as
 * one `voice_sample` row holding its 192-dim ECAPA embedding + (for enrollment)
 * the raw audio in R2. The `voice_print` centroid is the running average of all
 * `included` samples — recomputed here on every enroll / retrain / delete.
 *
 * No Mac Mini call is needed to recompute: the embeddings are already stored.
 * The Mini (/enroll) is only used to embed NEW audio.
 */
import { sql } from "@/lib/db";
import { customAlphabet } from "nanoid";
import { runEnroll, averageEmbeddings } from "@/lib/enroll";
import { putObjectBytes } from "@/lib/r2";

const nano = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 12);
export const newSampleId = (): string => `vs_${nano()}`;
export const newSessionId = (): string => `vse_${nano()}`;

export function extForContentType(ct: string): string {
  const t = (ct.split(";")[0] || "").trim().toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4") || t.includes("m4a")) return "mp4";
  if (t.includes("wav")) return "wav";
  if (t.includes("ogg")) return "ogg";
  return "webm";
}

export function sampleAudioKey(clinicianId: string, id: string, ext: string): string {
  return `voice-samples/${clinicianId}/${id}.${ext}`;
}

/**
 * Recompute the voice_print centroid from all `included` voice_sample rows for
 * a clinician and upsert it. Returns the sample count used. If zero samples
 * remain, flags needs_reenrollment and leaves the last centroid in place (so
 * identify/diarize don't crash on a missing centroid mid-cleanup).
 */
export async function recomputeCentroid(clinicianId: string): Promise<{ sampleCount: number }> {
  const rows = (await sql`
    SELECT encode(embedding, 'base64') AS emb
      FROM voice_sample
     WHERE clinician_id = ${clinicianId} AND included = true
     ORDER BY created_at ASC
  `) as Array<{ emb: string }>;
  const embs = rows.map((r) => r.emb).filter(Boolean);
  if (embs.length === 0) {
    await sql`UPDATE voice_print SET needs_reenrollment = true, last_sample_at = NOW() WHERE doctor_id = ${clinicianId}`;
    return { sampleCount: 0 };
  }
  const centroidB64 = averageEmbeddings(embs);
  await sql`
    INSERT INTO voice_print
      (doctor_id, centroid, sample_count, samples_json, enrolled_at, last_sample_at, needs_reenrollment)
    VALUES
      (${clinicianId}, decode(${centroidB64}, 'base64'), ${embs.length},
       ${JSON.stringify(embs)}::jsonb, NOW(), NOW(), FALSE)
    ON CONFLICT (doctor_id) DO UPDATE SET
      centroid           = EXCLUDED.centroid,
      sample_count       = EXCLUDED.sample_count,
      samples_json       = EXCLUDED.samples_json,
      last_sample_at     = NOW(),
      needs_reenrollment = FALSE
  `;
  return { sampleCount: embs.length };
}

export type StoreResult =
  | { ok: true; stored: number; failed: number; totalSamples: number; errors: string[] }
  | { ok: false; error: string };

/**
 * Embed a batch of enrollment clips via the Mini, upload each successful clip's
 * audio to R2, insert one voice_sample row per clip, then recompute the
 * centroid from ALL accumulated samples (accumulate — never overwrite).
 * Requires >=3 successful embeddings (matches prior enroll behaviour).
 */
export async function storeEnrollmentSession(opts: {
  clinicianId: string;
  clips: { buf: Buffer; contentType: string }[];
  capturedByAdminId?: string | null;
}): Promise<StoreResult> {
  const { clinicianId, clips } = opts;
  if (clips.length === 0) return { ok: false, error: "no_clips" };

  const embedded = await Promise.all(
    clips.map(async (c, i) => {
      const r = await runEnroll(c.buf, c.contentType || "audio/webm");
      return { i, buf: c.buf, contentType: c.contentType || "audio/webm", r };
    }),
  );
  const ok = embedded.filter((x) => x.r.ok) as Array<{
    i: number; buf: Buffer; contentType: string; r: { ok: true; embeddingBase64: string };
  }>;
  const errors = embedded
    .filter((x) => !x.r.ok)
    .map((x) => (x.r as { ok: false; error: string }).error);

  if (ok.length < 3) {
    return { ok: false, error: `only ${ok.length}/${clips.length} clips embedded (${errors.slice(0, 2).join("; ")})` };
  }

  const sessionId = newSessionId();
  let stored = 0;
  for (const x of ok) {
    const id = newSampleId();
    const ext = extForContentType(x.contentType);
    let audioKey: string | null = sampleAudioKey(clinicianId, id, ext);
    try {
      await putObjectBytes(audioKey, x.buf, x.contentType);
    } catch {
      audioKey = null; // keep the embedding even if the audio upload fails
    }
    try {
      await sql`
        INSERT INTO voice_sample
          (id, clinician_id, source, embedding, audio_r2_key, content_type,
           duration_ms, session_id, sample_index, captured_by_admin_id, included, created_at)
        VALUES
          (${id}, ${clinicianId}, 'enrollment', decode(${x.r.embeddingBase64}, 'base64'),
           ${audioKey}, ${x.contentType}, ${null}, ${sessionId}, ${x.i},
           ${opts.capturedByAdminId ?? null}, true, NOW())
      `;
      stored++;
    } catch {
      // skip a row that fails to insert; others still count
    }
  }
  if (stored === 0) return { ok: false, error: "all_sample_inserts_failed" };

  const { sampleCount } = await recomputeCentroid(clinicianId);
  return { ok: true, stored, failed: errors.length, totalSamples: sampleCount, errors };
}

// ---- read / manage helpers (Sprint A3) -------------------------------------

export type VoiceSampleRow = {
  id: string;
  source: string;
  audio_r2_key: string | null;
  source_encounter_id: string | null;
  content_type: string | null;
  duration_ms: number | null;
  session_id: string | null;
  sample_index: number | null;
  match_confidence: number | null;
  included: boolean;
  created_at: string;
  has_audio: boolean;
};

export async function listSamples(clinicianId: string): Promise<VoiceSampleRow[]> {
  const rows = (await sql`
    SELECT id, source, audio_r2_key, source_encounter_id, content_type, duration_ms,
           session_id, sample_index, match_confidence, included, created_at
      FROM voice_sample
     WHERE clinician_id = ${clinicianId}
     ORDER BY created_at DESC, sample_index ASC NULLS LAST
  `) as Array<Omit<VoiceSampleRow, "has_audio">>;
  return rows.map((r) => ({ ...r, has_audio: !!r.audio_r2_key }));
}

/** Decode a base64 float32[] embedding into a plain number[] (for download/inspection). */
export function embeddingBase64ToFloats(b64: string): number[] {
  const buf = Buffer.from(b64, "base64");
  const n = Math.floor(buf.length / 4);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
