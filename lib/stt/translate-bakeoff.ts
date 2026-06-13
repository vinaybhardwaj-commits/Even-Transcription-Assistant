/**
 * Translation bake-off (PRD: ETA-INDIC-COMPREHENSION-LAYER-PRD.md §6).
 *
 * OFFLINE measurement: for non-English encounters, translate the native
 * transcript with each candidate and score FAITHFULNESS against the native
 * source (drug names/doses/units + negations weighted above fluency). Lets the
 * data — not brand — pick the translator the live layer should use. Never runs
 * in the live note path. Candidates that need no Mac-Mini change:
 *   translate_saaras      — incumbent: the already-computed audio->English (transcript_raw)
 *   translate_qwen        — qwen2.5:14b text translation of the native transcript
 *   translate_sarvam_api  — Sarvam-Translate (Mayura) text API
 * (Sarvam-1 local can be added later as translate_sarvam1_local — needs the Mini handoff.)
 */
import { sql } from "@/lib/db";
import { customAlphabet } from "nanoid";
import { qwenJson } from "@/lib/qwen";
import { sarvamTranslateText, isNonEnglish } from "@/lib/sarvam";

const rid = customAlphabet("abcdefghjkmnpqrstuvwxyz0123456789", 16);

const TR_SYS = `You are a clinical translator. Translate the Indian-language clinical transcript to natural English. Keep English medical terms, drug names, doses and units EXACTLY as written. Do not add, omit, or invent. Return JSON {"english":"..."}.`;

async function qwenTranslate(native: string, lang: string | null): Promise<string | null> {
  try {
    const r = await qwenJson<{ english?: string }>(TR_SYS, `Language: ${lang ?? "unknown"}\nTranscript:\n${native.slice(0, 9000)}`, { temperature: 0, timeoutMs: 60_000 });
    return (r.json?.english ?? "").trim() || null;
  } catch { return null; }
}

const JUDGE_SYS = `You are an expert medical translation evaluator. You are shown a clinical encounter transcript in its ORIGINAL Indian language (the SOURCE) and several English translations of it (A, B, ...) from different systems — you are NOT told which. Score each translation 1-10 on FAITHFULNESS TO THE SOURCE, in priority order: (1) drug names, doses and units preserved exactly; (2) negations/assertions preserved (no flipped polarity, e.g. "no fever" must not become "fever"); (3) all findings present; (4) nothing invented. Fluency matters least. Return ONLY JSON {"scores":{"A":n,...},"winner":"A","reason":"..."}.`;

async function scoreTranslate(encounterId: string, native: string): Promise<void> {
  const rows = (await sql`
    SELECT id, engine, transcript_english FROM transcription_run
     WHERE encounter_id = ${encounterId} AND tier = 'translate' AND error IS NULL AND transcript_english IS NOT NULL
  `) as Array<{ id: string; engine: string; transcript_english: string | null }>;
  if (rows.length === 0) return;
  const labels = rows.map((_, i) => String.fromCharCode(65 + i));
  const body = `SOURCE (original language):\n${native.slice(0, 6000)}\n\n` +
    rows.map((r, i) => `TRANSLATION ${labels[i]}:\n${(r.transcript_english || "").slice(0, 5000)}`).join("\n\n");
  let scores: Record<string, number> = {};
  try {
    const j = await qwenJson<{ scores?: Record<string, number> }>(JUDGE_SYS, body, { temperature: 0, timeoutMs: 60_000 });
    scores = j.json?.scores ?? {};
  } catch { /* leave unscored */ }
  let bestId: string | null = null; let best = -1;
  for (let i = 0; i < rows.length; i++) {
    const raw = scores[labels[i]];
    const sc = typeof raw === "number" ? Math.max(0, Math.min(10, raw)) : null;
    const meta = JSON.stringify({ translate_faithfulness: sc, scored_at: new Date().toISOString() });
    await sql`UPDATE transcription_run SET judge_score = ${sc}, metrics_json = COALESCE(metrics_json, '{}'::jsonb) || ${meta}::jsonb WHERE id = ${rows[i].id}`;
    if (sc !== null && sc > best) { best = sc; bestId = rows[i].id; }
  }
  if (bestId) {
    await sql`UPDATE transcription_run SET is_winner = false WHERE encounter_id = ${encounterId} AND tier = 'translate'`;
    await sql`UPDATE transcription_run SET is_winner = true WHERE id = ${bestId}`;
  }
}

export async function runTranslateBakeoff(encounterId: string): Promise<{ encounter_id: string; inserted: number; errors: string[] }> {
  const rows = (await sql`SELECT id, transcript_raw, transcript_original, detected_language FROM encounter WHERE id = ${encounterId} LIMIT 1`) as Array<{ transcript_raw: string | null; transcript_original: string | null; detected_language: string | null }>;
  const enc = rows[0];
  if (!enc) return { encounter_id: encounterId, inserted: 0, errors: ["not_found"] };
  const native = (enc.transcript_original ?? "").trim();
  const indic = (enc.detected_language && isNonEnglish(enc.detected_language)) || /[ऀ-෿]/.test(native);
  if (!native || !indic) return { encounter_id: encounterId, inserted: 0, errors: ["not_indic_or_no_native"] };

  await sql`DELETE FROM transcription_run WHERE encounter_id = ${encounterId} AND tier = 'translate'`;

  const candidates: Array<{ engine: string; english: string | null; latency: number; error: string | null }> = [];
  if ((enc.transcript_raw ?? "").trim()) candidates.push({ engine: "translate_saaras", english: (enc.transcript_raw as string).trim(), latency: 0, error: null });
  { const t0 = Date.now(); const e = await qwenTranslate(native, enc.detected_language); candidates.push({ engine: "translate_qwen", english: e, latency: Date.now() - t0, error: e ? null : "empty" }); }
  { const r = await sarvamTranslateText(native, enc.detected_language); candidates.push({ engine: "translate_sarvam_api", english: r.ok ? r.english : null, latency: r.latencyMs, error: r.ok ? null : r.error }); }

  let inserted = 0; const errors: string[] = [];
  for (const c of candidates) {
    try {
      await sql`INSERT INTO transcription_run (id, encounter_id, engine, stt_engine_id, mode, tier, detected_language, transcript_original, transcript_english, latency_ms, error, created_at)
        VALUES (${rid()}, ${encounterId}, ${c.engine}, ${c.engine}, 'batch', 'translate', ${enc.detected_language}, ${native}, ${c.english}, ${c.latency}, ${c.error}, NOW())`;
      inserted++;
    } catch (e) { errors.push(`${c.engine}_insert: ${String(e).slice(0, 80)}`); }
    if (c.error) errors.push(`${c.engine}: ${c.error}`);
  }
  try { await scoreTranslate(encounterId, native); } catch (e) { errors.push(`score: ${String(e).slice(0, 60)}`); }
  return { encounter_id: encounterId, inserted, errors };
}

export async function translateBakeoffPending(limit = 3): Promise<{ processed: number; results: Array<{ encounter_id: string; inserted: number; errors: string[] }> }> {
  const encs = (await sql`
    SELECT e.id FROM encounter e
     WHERE e.transcript_original IS NOT NULL AND length(trim(e.transcript_original)) > 0
       AND (e.detected_language IS NULL OR e.detected_language NOT ILIKE 'en%')
       AND NOT EXISTS (SELECT 1 FROM transcription_run tr WHERE tr.encounter_id = e.id AND tr.tier = 'translate' AND (tr.metrics_json ->> 'scored_at') IS NOT NULL)
     ORDER BY e.recorded_at DESC NULLS LAST
     LIMIT ${limit}
  `) as Array<{ id: string }>;
  const results = [];
  for (const e of encs) results.push(await runTranslateBakeoff(e.id));
  return { processed: encs.length, results };
}

export async function translateBakeoffStatus(): Promise<{ per_translator: Array<{ engine: string; runs: number; ok: number; avg_faithfulness: number | null; avg_latency_ms: number | null; wins: number }> }> {
  const rows = (await sql`
    SELECT engine,
           COUNT(*)::int AS runs,
           COUNT(*) FILTER (WHERE error IS NULL)::int AS ok,
           ROUND(AVG(judge_score)::numeric, 2) AS avg_faithfulness,
           ROUND(AVG(latency_ms)::numeric, 0) AS avg_latency_ms,
           COUNT(*) FILTER (WHERE is_winner)::int AS wins
      FROM transcription_run WHERE tier = 'translate'
     GROUP BY engine ORDER BY avg_faithfulness DESC NULLS LAST
  `) as Array<{ engine: string; runs: number; ok: number; avg_faithfulness: number | null; avg_latency_ms: number | null; wins: number }>;
  return { per_translator: rows };
}
