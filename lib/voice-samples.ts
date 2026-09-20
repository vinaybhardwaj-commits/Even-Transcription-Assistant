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
import { webmDurationMs } from "@/lib/audio-duration";

/**
 * ─── THE ENROLMENT FLOORS, AND WHAT THEY REST ON ────────────────────────────────────────────────
 *
 * The gate was `ok.length < 3` — a COUNT that has never measured a clip, so three one-second clips
 * enrolled exactly as readily as three good ones. These are the two numbers that replace it.
 *
 * MIN_CLIP_MS = 3000. Basis, and the weaker half is stated first: three seconds is the ordinary
 * utterance length for ECAPA speaker verification, which is EXTERNAL knowledge and not something
 * this repository measured. What the repository does show is that the Mini embeds a speaker from
 * its LONGEST SEGMENT ALONE (eta-diarize server.py:169-173, recorded in
 * docs/handoff/ETA-VOICE-MATCH-ROOT-CAUSE-19-SEP-2026.md), and that a real match was made off a
 * 5.6 s longest segment while shorter fragments of the same speaker landed at 0.628 — under the
 * 0.65 floor. A clip near one second cannot produce a longest segment worth embedding.
 *
 * MIN_SESSION_MS = 30000. Basis: the only enrolment row in production carrying a duration at all is
 * a curated print built from 121.4 s of room audio (lx survey §3), and that print is the one that
 * matches at 0.908; the six-clip near-field prints, whose clips are short scripted sentences, sit
 * at 0.535 against a 0.65 threshold. Thirty seconds is chosen conservatively BELOW that 121 s
 * exemplar and above 3 x MIN_CLIP_MS.
 *
 * WHAT I COULD NOT GROUND: the optimum. Nothing in this repository measures enrolment length
 * against match quality, so 30 s is a floor argued from two data points, not a tuned figure. If V
 * wants a different number this is the one line to change, and S2b's re-enrolment measurements are
 * what should set it.
 */
export const MIN_CLIP_MS = 3_000;
/** UNMEASURED PLACEHOLDER for S2b. Argued from two data points (see above), never measured against
 *  match quality. This is the ONE line to change when it is; nothing else reads a session floor. */
export const MIN_SESSION_MS = 30_000;
export const MIN_CLIPS = 3;

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

  if (ok.length < MIN_CLIPS) {
    return { ok: false, error: `only ${ok.length}/${clips.length} clips embedded (${errors.slice(0, 2).join("; ")})` };
  }

  // ── DEFECT 2. Measure every clip. A duration we cannot READ is not a duration we may assume:
  // an unparseable clip is rejected, because "we do not know" must not pass a floor.
  const measured = ok.map((x) => ({ ...x, dur: webmDurationMs(x.buf) }));
  const tooShort = measured.filter((m) => m.dur === null || m.dur.ms < MIN_CLIP_MS);
  if (measured.length - tooShort.length < MIN_CLIPS) {
    const unreadable = tooShort.filter((m) => m.dur === null).length;
    return {
      ok: false,
      error: `clips too short: ${tooShort.length}/${measured.length} under ${MIN_CLIP_MS} ms`
        + (unreadable ? ` (${unreadable} unreadable)` : ""),
    };
  }
  const usable = measured.filter((m) => m.dur !== null && m.dur.ms >= MIN_CLIP_MS) as Array<
    typeof measured[number] & { dur: { ms: number; basis: string } }
  >;
  const totalMs = usable.reduce((a, m) => a + m.dur.ms, 0);
  if (totalMs < MIN_SESSION_MS) {
    return { ok: false, error: `enrolment total ${totalMs} ms is under the ${MIN_SESSION_MS} ms minimum` };
  }

  // ── DEFECT 1. The audio is the point: without it no centroid can ever be recomputed with a
  // better model, which is how six of seven live prints became irreversible. Upload EVERY clip
  // BEFORE any row is written, and refuse the whole session if one cannot be retained. The old
  // code caught the failure and stored the sample with a null key.
  const sessionId = newSessionId();
  const prepared: Array<{ id: string; key: string; x: typeof usable[number] }> = [];
  for (const x of usable) {
    const id = newSampleId();
    const key = sampleAudioKey(clinicianId, id, extForContentType(x.contentType));
    try {
      await putObjectBytes(key, x.buf, x.contentType);
    } catch (e) {
      return {
        ok: false,
        error: `audio retention failed for clip ${x.i}; refusing the enrolment (${String(e).slice(0, 80)})`,
      };
    }
    prepared.push({ id, key, x });
  }

  // ── DEFECT 3. ATOMIC, not self-healing. The centroid is a pure average of embeddings we already
  // hold (recomputeCentroid needs no service call), so it can be computed HERE, in memory, and
  // written in the same batch as the samples it summarises. The Neon HTTP driver has no
  // interactive transaction, but it does take an array of statements as one — which is exactly
  // enough, because nothing in this batch needs to read what another statement wrote.
  // Self-healing was the alternative: mark the print stale and repair on the next read. It was
  // rejected because it leaves a window in which a stale centroid is served as though it were
  // current, and the repair needs a sweeper nobody runs.
  const priorRows = (await sql`
    SELECT encode(embedding, 'base64') AS emb
      FROM voice_sample
     WHERE clinician_id = ${clinicianId} AND included = true
     ORDER BY created_at ASC
  `) as Array<{ emb: string }>;
  const allEmbeddings = [...priorRows.map((r) => r.emb).filter(Boolean), ...prepared.map((p) => p.x.r.embeddingBase64)];
  const centroidB64 = averageEmbeddings(allEmbeddings);

  const batch = [
    ...prepared.map((p) => sql`
      INSERT INTO voice_sample
        (id, clinician_id, source, embedding, audio_r2_key, content_type,
         duration_ms, session_id, sample_index, captured_by_admin_id, included, created_at)
      VALUES
        (${p.id}, ${clinicianId}, 'enrollment', decode(${p.x.r.embeddingBase64}, 'base64'),
         ${p.key}, ${p.x.contentType}, ${p.x.dur.ms}, ${sessionId}, ${p.x.i},
         ${opts.capturedByAdminId ?? null}, true, NOW())
    `),
    sql`
      INSERT INTO voice_print
        (doctor_id, centroid, sample_count, samples_json, enrolled_at, last_sample_at, needs_reenrollment)
      VALUES
        (${clinicianId}, decode(${centroidB64}, 'base64'), ${allEmbeddings.length},
         ${JSON.stringify(allEmbeddings)}::jsonb, NOW(), NOW(), FALSE)
      ON CONFLICT (doctor_id) DO UPDATE SET
        centroid           = EXCLUDED.centroid,
        sample_count       = EXCLUDED.sample_count,
        samples_json       = EXCLUDED.samples_json,
        last_sample_at     = NOW(),
        needs_reenrollment = FALSE
    `,
  ];
  try {
    await (sql as unknown as { transaction: (q: unknown[]) => Promise<unknown> }).transaction(batch);
  } catch (e) {
    return { ok: false, error: `atomic write failed; no sample or centroid was stored (${String(e).slice(0, 80)})` };
  }

  return {
    ok: true,
    stored: prepared.length,
    failed: errors.length,
    totalSamples: allEmbeddings.length,
    errors,
  };
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

// ---- passive capture (Sprint B) --------------------------------------------

/** Confidence at/above which a passively-captured sample is auto-included in
 *  the centroid average. Below it, the sample is retained + downloadable but
 *  NOT averaged (admin can delete; future: include toggle). Strict by default
 *  so a marginal speaker match can't poison recognition. */
const PASSIVE_INCLUDE_GATE = Number(process.env.PASSIVE_VOICEPRINT_GATE ?? "0.82");

/**
 * Retain the clinician's own voice from a real encounter as a passive sample.
 * Deduped to one row per (clinician, encounter). Audio is REFERENCED (the
 * existing encounter recording) — never a fresh patient-bearing clip. Only
 * recomputes the centroid when the sample clears the include gate. No-op if no
 * embedding is supplied (e.g. the Mini hasn't been upgraded to return one).
 */
export async function capturePassiveSample(opts: {
  clinicianId: string;
  embeddingBase64: string;
  encounterId: string;
  audioR2Key: string | null;
  contentType?: string | null;
  confidence: number | null;
}): Promise<{ captured: boolean; included: boolean }> {
  const { clinicianId, embeddingBase64, encounterId } = opts;
  if (!embeddingBase64) return { captured: false, included: false };
  const dup = (await sql`
    SELECT 1 FROM voice_sample
     WHERE clinician_id = ${clinicianId} AND source = 'passive' AND source_encounter_id = ${encounterId}
     LIMIT 1
  `) as Array<unknown>;
  if (dup.length) return { captured: false, included: false };
  const conf = typeof opts.confidence === "number" ? opts.confidence : null;
  const included = conf !== null && conf >= PASSIVE_INCLUDE_GATE;
  const id = newSampleId();
  await sql`
    INSERT INTO voice_sample
      (id, clinician_id, source, embedding, audio_r2_key, source_encounter_id,
       content_type, session_id, match_confidence, included, created_at)
    VALUES
      (${id}, ${clinicianId}, 'passive', decode(${embeddingBase64}, 'base64'),
       ${opts.audioR2Key}, ${encounterId}, ${opts.contentType ?? null},
       ${"passive:" + encounterId}, ${conf}, ${included}, NOW())
  `;
  if (included) await recomputeCentroid(clinicianId);
  return { captured: true, included };
}
