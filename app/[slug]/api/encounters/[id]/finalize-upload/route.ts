/**
 * POST /{slug}/api/encounters/{id}/finalize-upload
 *
 * Called after the browser successfully PUTs the audio to R2. We verify
 * the object exists, update the encounter row with the object key +
 * size + duration, and flip status to "processing".
 *
 * (Sprint 1.F.7 will fan out the note + CDMSS pipelines from here.)
 *
 * Body: { key, duration_seconds, deepgram_transcript?, whisper_transcript? }
 * Returns: { encounter: {id, status} }
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { headObject, deleteObject, whisperBufferKey } from "@/lib/r2";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

type EncounterRow = {
  id: string;
  doctor_id: string;
  status: "draft" | "processing" | "complete" | "failed" | "deleted";
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;

  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try {
    claims = await verifyDoctorJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");
  if (!id.startsWith("enc_")) {
    return respondError("VALIDATION_FAILED", "bad_encounter_id");
  }

  // Verify ownership + draft status
  let row: EncounterRow | undefined;
  try {
    const rows = (await sql`
      SELECT id, doctor_id, status
        FROM encounter
       WHERE id = ${id} AND deleted_at IS NULL
       LIMIT 1
    `) as EncounterRow[];
    row = rows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
  if (!row) return respondError("NOT_FOUND", "encounter_not_found");
  if (row.doctor_id !== claims.doctor_id) {
    return respondError("FORBIDDEN", "not_your_encounter");
  }
  if (row.status !== "draft") {
    return respondError(
      "VALIDATION_FAILED",
      `cannot_finalize_in_status_${row.status}`,
    );
  }

  // Parse body
  let body: {
    key?: string;
    duration_seconds?: number;
    deepgram_transcript?: string;
    whisper_transcript?: string;
    sarvam_codemix?: string;
    sarvam_language?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  if (typeof body.key !== "string" || !body.key.startsWith("encounters/")) {
    return respondError("VALIDATION_FAILED", "bad_key");
  }

  // Confirm object exists in R2
  const head = await headObject(body.key);
  if (head.size === null) {
    return respondError(
      "UPSTREAM_UNAVAILABLE",
      `r2_object_missing: ${body.key}`,
    );
  }
  if (head.size === 0) {
    return respondError("VALIDATION_FAILED", "uploaded_object_is_empty");
  }

  const durationSeconds =
    typeof body.duration_seconds === "number" &&
    Number.isFinite(body.duration_seconds) &&
    body.duration_seconds > 0
      ? Math.floor(body.duration_seconds)
      : null;

  // B6 fix (28 May 2026): pick whichever source has more content, instead of
  // always preferring Whisper.
  //
  // Why: useWhisperRolling only updates `latest.text` on a SUCCESSFUL pass.
  // If a pass errors mid-recording (B7 — happens on long sessions), the
  // hook's latest.text is frozen at the last good pass, which can cover
  // only the first ~30-90s of audio. Deepgram, meanwhile, keeps appending
  // final utterances for the full recording. The previous "always prefer
  // Whisper" rule silently discarded the full Deepgram transcript and saved
  // the short Whisper stub, leading to a near-empty note and the downstream
  // `note_too_empty_for_seed` error.
  //
  // The new rule: trust Whisper only if it is materially longer than
  // Deepgram (>=120% — Whisper is more accurate on medical terms, so a
  // small win in length confirms it actually covered the full audio).
  // Otherwise prefer the longer Deepgram-cleaned text.
  const wh =
    typeof body.whisper_transcript === "string"
      ? body.whisper_transcript.trim()
      : "";
  const dg =
    typeof body.deepgram_transcript === "string"
      ? body.deepgram_transcript.trim()
      : "";

  let transcriptRaw: string | null = null;
  let chosenSource: "whisper" | "deepgram" | "sarvam" | "none" = "none";
  if (wh.length > 0 && dg.length > 0) {
    if (wh.length >= dg.length * 1.2) {
      transcriptRaw = wh;
      chosenSource = "whisper";
    } else {
      transcriptRaw = dg;
      chosenSource = "deepgram";
    }
  } else if (wh.length > 0) {
    transcriptRaw = wh;
    chosenSource = "whisper";
  } else if (dg.length > 0) {
    transcriptRaw = dg;
    chosenSource = "deepgram";
  }

  // Multilingual override (Sarvam). For a non-English encounter Deepgram is
  // ~empty and Whisper mistranslates/romanizes, so the Sarvam English
  // translation becomes the canonical transcript that feeds the note, and the
  // original-language transcript is preserved. English encounters are NOT
  // touched (Deepgram path stands).
  // Multilingual: the live rolling sends an accumulated CODE-MIXED transcript +
  // detected language. For a non-English encounter we preserve that as the
  // original-language transcript and use it as a PLACEHOLDER canonical so the
  // encounter has a working transcript; /process then REPLACES transcript_raw
  // with a full-file batch English translation (best accuracy). English
  // encounters are untouched (Deepgram/Whisper path stands).
  const svCodemix = typeof body.sarvam_codemix === "string" ? body.sarvam_codemix.trim() : "";
  const svLang = typeof body.sarvam_language === "string" ? body.sarvam_language.trim() : "";
  const svNonEnglish =
    svLang.length > 0 && svLang.toLowerCase() !== "unknown" && !svLang.toLowerCase().startsWith("en");

  const detectedLanguage: string | null = svLang.length > 0 ? svLang : null;
  let transcriptOriginal: string | null = null;
  if (svNonEnglish) {
    transcriptOriginal = svCodemix.length > 0 ? svCodemix : null;
    if (svCodemix.length > 0) {
      transcriptRaw = svCodemix; // placeholder; /process replaces with batch English
      chosenSource = "sarvam";
    }
  }

  console.warn(
    `[finalize-upload] enc=${id} chosen=${chosenSource} lang=${detectedLanguage ?? "-"} dg=${dg.length} wh=${wh.length} sarvam_cm=${svCodemix.length} kept=${transcriptRaw?.length ?? 0}`,
  );

  // Update row → processing
  try {
    await sql`
      UPDATE encounter
         SET audio_object_key   = ${body.key},
             audio_bytes        = ${head.size},
             duration_seconds   = ${durationSeconds},
             transcript_raw     = ${transcriptRaw},
             transcript_original = ${transcriptOriginal},
             detected_language  = ${detectedLanguage},
             status             = 'processing'
       WHERE id = ${id}
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }

  // Testbed log: one transcription_run row per engine for side-by-side
  // comparison. Best-effort — never block finalize on it.
  try {
    const mk = () =>
      `trun_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runs: Array<{
      engine: string;
      original: string | null;
      english: string | null;
      lang: string | null;
      winner: boolean;
    }> = [
      { engine: "deepgram", original: null, english: dg || null, lang: null, winner: chosenSource === "deepgram" },
      { engine: "whisper", original: wh || null, english: null, lang: null, winner: chosenSource === "whisper" },
      { engine: "sarvam", original: svCodemix || null, english: null, lang: svLang || null, winner: chosenSource === "sarvam" },
    ];
    for (const r of runs) {
      if (!r.original && !r.english) continue;
      await sql`
        INSERT INTO transcription_run
          (id, encounter_id, engine, mode, detected_language, transcript_original, transcript_english, is_winner)
        VALUES
          (${mk()}, ${id}, ${r.engine}, 'live', ${r.lang}, ${r.original}, ${r.english}, ${r.winner})
      `;
    }
  } catch (e) {
    console.warn(`[finalize-upload] transcription_run log failed enc=${id}`, e);
  }

  // B7 cleanup: the rolling Whisper pipeline accumulated raw
  // MediaRecorder output at whisper-buffer/{enc_id}.webm while
  // recording. The canonical audio is now at audio_object_key, so
  // the rolling buffer can be dropped. Best-effort; failure here
  // doesn't affect the encounter (and orphan buffers stay capped at
  // 60 MB by the route's MAX_BUFFER_BYTES guard).
  void deleteObject(whisperBufferKey(id));

  return respondOk({
    encounter: { id, status: "processing" as const },
    audio: { key: body.key, bytes: head.size, content_type: head.content_type },
    transcript: {
      chosen_source: chosenSource,
      whisper_chars: wh.length,
      deepgram_chars: dg.length,
      kept_chars: transcriptRaw?.length ?? 0,
    },
  });
}
