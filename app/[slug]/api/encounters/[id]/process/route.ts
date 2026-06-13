/**
 * POST /{slug}/api/encounters/{id}/process
 *
 * Runs Medical Encounter Note generation (qwen2.5:14b) and Clinical
 * Decision Support (llama3.1:8b) sequentially, persists both JSONs to
 * the encounter row, flips status to "complete" (or "failed" on error).
 *
 * Idempotent: if both note_json and cdmss_json already exist, returns
 * them without re-running. Caller can pass {force: true} to re-run.
 *
 * Returns: { encounter: {id, status}, note, cdmss, note_ms, cdmss_ms }
 *
 * S6.3 (27 May 2026): AbortError handling on the streaming branch.
 * When the client aborts (cancel button), the upstream LLM call rejects
 * with AbortError → the outer catch detects it, flips status to
 * 'draft_partial', PRESERVES whatever note_json / cdmss_json was already
 * written to the row (per V's Q2 lock), and writes an audit_log entry.
 *
 * S6.2b (27 May 2026): instruments the streaming branch with llm_traces
 * rows — one for surface='note-pipeline' wrapping generateNote(), one for
 * surface='cdmss-analysis' wrapping runCdmssPipeline(). On AbortError,
 * whichever trace is still in_progress is finalised as 'aborted'. The
 * admin trace dashboard at /admin/traces reads these rows.
 */
import { NextRequest, after } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { generateNote, noteHeadline, noteTypeHasCdmss, type EncounterNote } from "@/lib/note-generation";
import { runCdmssStub, type CdmssOutput } from "@/lib/cdmss-stub";
import { runCdmssPipeline, type CdmssRich } from "@/lib/cdmss-pipeline";
import { openTrace, type TraceHandle } from "@/lib/llm-trace/log";
import { respondOk, respondError } from "@/lib/respond";
import { getObjectBytes, headObject } from "@/lib/r2";
import { sarvamBatchTranslate, isNonEnglish, SARVAM_MEDICAL_PROMPT } from "@/lib/sarvam";
import { indicNoteAssist, INDIC_NOTE_ASSIST_ON } from "@/lib/stt/indic-note-assist";
import { INDIC_COMPREHENSION_ON, generateNativeAnalysis } from "@/lib/stt/indic-comprehension";
import { runDiarize, reconcileTagged, applyRoleOverrides } from "@/lib/diarize";
import { capturePassiveSample } from "@/lib/voice-samples";
import { enqueueFanout, runFanoutForEncounter } from "@/lib/stt/fanout";
import { sanitizeEnglish, sanitizeOriginal, trimLeadingNoiseEntries } from "@/lib/transcript-guard";
import { transcribeDiarized } from "@/lib/transcribe";
import type { SarvamDiarEntry } from "@/lib/sarvam";

export const runtime = "nodejs";
export const maxDuration = 300;

type Row = {
  id: string;
  doctor_id: string;
  status: "draft" | "processing" | "complete" | "failed" | "deleted" | "draft_partial";
  transcript_raw: string | null;
  transcript_original: string | null;
  detected_language: string | null;
  note_type: string | null;
  audio_object_key: string | null;
  note_json: EncounterNote | null;
  cdmss_json: CdmssOutput | CdmssRich | null;
};

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; code?: unknown };
  if (typeof err.name === "string" && err.name === "AbortError") return true;
  if (typeof err.code === "string" && err.code === "ERR_ABORTED") return true;
  return false;
}

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

  let force = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    force = body.force === true;
  } catch { /* intentional: best-effort side-write/parse; main flow continues */ }

  // Load row
  let row: Row | undefined;
  try {
    const rows = (await sql`
      SELECT id, doctor_id, status, transcript_raw, transcript_original, detected_language, note_type,
             audio_object_key, note_json, cdmss_json
        FROM encounter
       WHERE id = ${id} AND deleted_at IS NULL
       LIMIT 1
    `) as Row[];
    row = rows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
  if (!row) return respondError("NOT_FOUND", "encounter_not_found");
  if (row.doctor_id !== claims.doctor_id) {
    return respondError("FORBIDDEN", "not_your_encounter");
  }
  if (row.status === "deleted") {
    return respondError("VALIDATION_FAILED", "encounter_deleted");
  }

  // Idempotent fast path
  if (!force && row.note_json && row.cdmss_json) {
    return respondOk({
      encounter: { id, status: row.status },
      note: row.note_json,
      cdmss: row.cdmss_json,
      cached: true,
    });
  }

  if (!row.transcript_raw || row.transcript_raw.trim().length === 0) {
    await sql`UPDATE encounter SET status = 'failed' WHERE id = ${id}`;
    return respondError(
      "PIPELINE_FAILED",
      "no_transcript_to_process",
    );
  }

  // For a non-English encounter, replace the (placeholder/code-mixed) canonical
  // transcript with a FULL-FILE Sarvam batch translation. Whole-conversation
  // context is materially more accurate than the per-window live rolling, and
  // this is also the safety net if the live rolling under-captured. English
  // encounters skip this entirely (Deepgram/Whisper path stands). Soft-fail:
  // never block the note on it — fall back to whatever transcript_raw is.
  // Sarvam batch diarized English segments — captured in translateIfNeeded,
  // reconciled against pyannote in diarizeStore for the speaker-tagged note.
  let sarvamEntries: SarvamDiarEntry[] = [];
  const translateIfNeeded = async (emit?: (o: unknown) => void): Promise<void> => {
    if (!row) return;
    if (!row.audio_object_key) return;
    // Fire when the detected language is non-English, OR (robustness — language
    // detection can come back null) when the working transcript contains Indic
    // script (Devanagari..Sinhala, U+0900-U+0DFF: Hindi/Bengali/Gujarati/Tamil/
    // Telugu/Kannada/Malayalam). English-only transcripts skip this.
    const langNonEn = !!row.detected_language && isNonEnglish(row.detected_language);
    const hasIndic = /[\u0900-\u0DFF]/.test(row.transcript_raw ?? "");
    if (!langNonEn && !hasIndic) return;
    emit?.({ stage: "progress", msg: "Translating full conversation (Sarvam)\u2026" });
    try {
      const head = await headObject(row.audio_object_key);
      const bytes = await getObjectBytes(row.audio_object_key);
      if (!bytes) {
        emit?.({ stage: "progress", msg: "Audio unavailable for batch translate; using live transcript" });
        return;
      }
      const bt = await sarvamBatchTranslate(bytes, head.content_type || "audio/webm", {
        prompt: SARVAM_MEDICAL_PROMPT,
        withDiarization: true,
        signal: req.signal,
      });
      if (bt.ok && Array.isArray(bt.entries)) sarvamEntries = bt.entries;
      if (bt.ok && bt.transcript.trim().length > 0) {
        row.transcript_raw = bt.transcript;
        await sql`UPDATE encounter SET transcript_raw = ${bt.transcript} WHERE id = ${id}`;
        emit?.({ stage: "progress", msg: `Full-conversation translation ready (${bt.transcript.length} chars)` });
        // Optional submit-time parallel pick-best: run IndicConformer on the SAME
        // audio and keep whichever English transcript is the better note basis.
        // Flag-gated (ETA_NOTE_PARALLEL_INDIC) + soft-fail: defaults to Sarvam.
        if (INDIC_NOTE_ASSIST_ON()) {
          try {
            const assist = await indicNoteAssist({
              bytes, contentType: head.content_type || "audio/webm",
              detectedLanguage: row.detected_language, sarvamEnglish: row.transcript_raw, emit,
            });
            if (assist.used === "indicconformer" && assist.english.trim().length > 0 && assist.english !== row.transcript_raw) {
              row.transcript_raw = assist.english;
              await sql`UPDATE encounter SET transcript_raw = ${assist.english} WHERE id = ${id}`;
            }
          } catch (e) {
            console.warn(`[process] indic note-assist failed enc=${id}: ${String(e).slice(0, 100)}`);
          }
        }
      } else {
        emit?.({ stage: "progress", msg: `Batch translate unavailable (${bt.ok ? "empty" : bt.error}); using live transcript` });
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.warn(`[process] batch-translate failed enc=${id}: ${m}`);
      emit?.({ stage: "progress", msg: "Batch translate error; using live transcript" });
    }
  };

  // B14 guard — strip non-clinical lead-in (foreign-language intro + ASR/ad
  // hallucination) from the canonical transcripts BEFORE they seed the note +
  // the displayed boxes. Leading-anchored, bounded, length-floored (see
  // lib/transcript-guard.ts). Soft: never blocks the encounter.
  const guardTranscripts = async (emit?: (o: unknown) => void): Promise<void> => {
    if (!row) return;
    const beforeEn = row.transcript_raw ?? "";
    const beforeOrig = row.transcript_original ?? "";
    const cleanedEn = sanitizeEnglish(beforeEn);
    const cleanedOrig = sanitizeOriginal(beforeOrig, row.detected_language);
    sarvamEntries = trimLeadingNoiseEntries(sarvamEntries);
    const enChanged = cleanedEn !== beforeEn && cleanedEn.trim().length > 0;
    const origChanged =
      beforeOrig.length > 0 && cleanedOrig !== beforeOrig && cleanedOrig.trim().length > 0;
    if (!enChanged && !origChanged) return;
    if (enChanged) row.transcript_raw = cleanedEn;
    if (origChanged) row.transcript_original = cleanedOrig;
    try {
      if (enChanged && origChanged) {
        await sql`UPDATE encounter SET transcript_raw = ${row.transcript_raw}, transcript_original = ${row.transcript_original} WHERE id = ${id}`;
      } else if (enChanged) {
        await sql`UPDATE encounter SET transcript_raw = ${row.transcript_raw} WHERE id = ${id}`;
      } else {
        await sql`UPDATE encounter SET transcript_original = ${row.transcript_original} WHERE id = ${id}`;
      }
      emit?.({ stage: "progress", msg: "Removed non-clinical lead-in from transcript" });
    } catch (e) {
      console.warn(`[process] transcript guard persist failed enc=${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // V2.SD.3 — submit-time speaker diarization. NON-CRITICAL: never blocks the
  // encounter. Calls the live Mac Mini /diarize on the canonical R2 audio and
  // stores speakers/segments/overlap/aggregates + a status lifecycle. No
  // clinician centroids yet (enrollment = V2.SD.1) so roles are heuristic;
  // no manual_relabels yet (live relabel = V2.SD.2). Soft-fails to
  // diarize_status='failed' and the note/email behave as v2.0 (unlabeled).
  const diarizeStore = async (emit?: (o: unknown) => void): Promise<void> => {
    if (!row) return;
    if (!row.audio_object_key) {
      try { await sql`UPDATE encounter SET diarize_status = 'skipped' WHERE id = ${id}`; } catch { /* intentional: best-effort side-write/parse; main flow continues */ }
      return;
    }
    emit?.({ stage: "progress", msg: "Identifying speakers (diarization)\u2026" });
    try {
      await sql`UPDATE encounter SET diarize_status = 'running', diarize_started_at = NOW() WHERE id = ${id}`;
      const head = await headObject(row.audio_object_key);
      const bytes = await getObjectBytes(row.audio_object_key);
      if (!bytes) {
        await sql`UPDATE encounter SET diarize_status = 'failed', diarize_completed_at = NOW(), diarize_error = 'audio_missing' WHERE id = ${id}`;
        emit?.({ stage: "progress", msg: "Diarization skipped (audio unavailable)" });
        return;
      }
      // Load the doctor's enrolled voiceprint (if any) so /diarize can NAME them
      // (otherwise speakers stay heuristic — Patient/Attender/Nurse).
      let clinicianCentroids: unknown[] = [];
      try {
        const vp = (await sql`
          SELECT encode(vp.centroid, 'base64') AS centroid_b64, d.full_name AS full_name
            FROM voice_print vp JOIN clinician d ON d.id = vp.doctor_id
           WHERE vp.doctor_id = ${row.doctor_id} LIMIT 1
        `) as Array<{ centroid_b64: string; full_name: string }>;
        if (vp[0]?.centroid_b64) {
          clinicianCentroids = [{
            clinician_id: row.doctor_id,
            full_name: vp[0].full_name,
            centroid_base64: vp[0].centroid_b64,
          }];
        }
      } catch (e) {
        console.warn(`[process] voice_print load failed enc=${id}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const d = await runDiarize(bytes, head.content_type || "audio/webm", {
        encounterId: id,
        clinicianCentroids,
        manualRelabels: [],
        signal: req.signal,
      });
      if (d.ok) {
        await sql`
          UPDATE encounter
             SET speakers             = ${JSON.stringify(d.result.speakers)}::jsonb,
                 transcript_segments  = ${JSON.stringify(d.result.transcript_segments)}::jsonb,
                 overlap_windows      = ${JSON.stringify(d.result.overlap_windows)}::jsonb,
                 aggregates           = ${JSON.stringify(d.result.aggregates)}::jsonb,
                 diarize_status       = 'complete',
                 diarize_completed_at = NOW(),
                 diarize_error        = NULL
           WHERE id = ${id}
        `;
        // Passive voiceprint capture (Voiceprint Retention Sprint B): if the
        // Mini returned this clinician's speaker embedding and the match is
        // confident, retain it as a passive sample (audio = this encounter's
        // recording). No-op until /diarize returns embedding_base64. Fully
        // non-blocking — never affects the note/email/diarize result.
        try {
          const mine = d.result.speakers.find(
            (sp) => sp.clinician_id === row!.doctor_id && typeof sp.embedding_base64 === "string" && sp.embedding_base64.length > 0,
          );
          if (mine?.embedding_base64) {
            await capturePassiveSample({
              clinicianId: row.doctor_id,
              embeddingBase64: mine.embedding_base64,
              encounterId: id,
              audioR2Key: row.audio_object_key,
              contentType: head.content_type ?? null,
              confidence: typeof mine.confidence === "number" ? mine.confidence : null,
            });
          }
        } catch (pe) {
          console.warn(`[process] passive voice capture failed enc=${id}: ${pe instanceof Error ? pe.message : String(pe)}`);
        }
        // Speaker-tag the note transcript. Non-English: Sarvam batch-diarized
        // English segments (captured in translateIfNeeded). English: Deepgram
        // diarized batch utterances. Either way, reconcile anonymous speaker
        // ids onto pyannote's NAMED speakers by time overlap, then refine roles
        // from the per-speaker text (first-person → Patient).
        try {
          const segs = d.result.transcript_segments as Array<{ start_ms?: number; end_ms?: number; speaker_idx?: number }>;
          let entries = sarvamEntries;
          const isEnglish =
            !(!!row.detected_language && isNonEnglish(row.detected_language)) &&
            !/[\u0900-\u0DFF]/.test(row.transcript_raw ?? "");
          if (entries.length === 0 && isEnglish) {
            const dgd = await transcribeDiarized(bytes, head.content_type || "audio/webm");
            if (dgd.ok) entries = dgd.entries;
          }
          if (entries.length > 0) {
            const tagged = reconcileTagged(entries, segs, d.result.speakers);
            const { speakers: refined, changed } = applyRoleOverrides(d.result.speakers, tagged);
            const finalTagged = changed ? reconcileTagged(entries, segs, refined) : tagged;
            await sql`UPDATE encounter SET tagged_transcript = ${JSON.stringify(finalTagged)}::jsonb WHERE id = ${id}`;
            if (changed) await sql`UPDATE encounter SET speakers = ${JSON.stringify(refined)}::jsonb WHERE id = ${id}`;
            emit?.({ stage: "progress", msg: `Speaker-tagged conversation ready (${finalTagged.length} turn(s)${changed ? ", roles refined" : ""})` });
          }
        } catch (te) {
          console.warn(`[process] tag/role reconcile failed enc=${id}: ${te instanceof Error ? te.message : String(te)}`);
        }
        emit?.({ stage: "progress", msg: `Diarization complete (${d.result.speakers.length} speaker(s), ${d.latencyMs}ms)` });
      } else {
        await sql`UPDATE encounter SET diarize_status = 'failed', diarize_completed_at = NOW(), diarize_error = ${d.error.slice(0, 300)} WHERE id = ${id}`;
        emit?.({ stage: "progress", msg: `Diarization unavailable (${d.error.slice(0, 80)})` });
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.warn(`[process] diarize failed enc=${id}: ${m}`);
      try { await sql`UPDATE encounter SET diarize_status = 'failed', diarize_completed_at = NOW(), diarize_error = ${m.slice(0, 300)} WHERE id = ${id}`; } catch { /* intentional: best-effort side-write/parse; main flow continues */ }
      emit?.({ stage: "progress", msg: "Diarization error (non-critical)" });
    }
  };

  // ---- NDJSON streaming branch ----
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/x-ndjson") || accept.includes("text/event-stream")) {
    const encoder = new TextEncoder();
    const doctorId = claims.doctor_id;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          } catch {
            /* client gone */
          }
        };
        const close = () => {
          try { controller.close(); } catch { /* already closed */ }
        };

        // S6.2b: trace handles for each surface. Kept as locals in this
        // closure so the outer catch (abort handler) can finalise whichever
        // is still in_progress as 'aborted'.
        let noteTrace:  TraceHandle | null = null;
        let cdmssTrace: TraceHandle | null = null;

        // Heartbeat every 5s so proxies don't kill the stream
        const hbInterval = setInterval(() => {
          emit({ stage: "heartbeat", ts: Date.now() });
        }, 5000);

        try {
          // Full-file Sarvam batch translate for non-English (accuracy + safety net).
          await translateIfNeeded(emit);
          await guardTranscripts(emit);

          // ---- Indic Comprehension Layer (non-English; flag ETA_INDIC_COMPREHENSION, default ON) ----
          // Saves a faithful native-language analysis for inspection and supplies the native
          // transcript as a ground-truth reference to the English note model. Soft-fail.
          let nativeRef: string | undefined;
          if (INDIC_COMPREHENSION_ON() && row &&
              ((row.detected_language && isNonEnglish(row.detected_language)) || /[\u0900-\u0DFF]/.test(row.transcript_original ?? ""))) {
            nativeRef = (row.transcript_original ?? "").trim() || undefined;
            try {
              const na = await generateNativeAnalysis(row.transcript_original ?? "", row.detected_language);
              if (na) {
                await sql`UPDATE encounter SET native_analysis = ${JSON.stringify(na)}::jsonb, native_analysis_lang = ${na.language ?? row.detected_language}, translation_engine = 'saaras' WHERE id = ${id}`;
                emit({ stage: "progress", msg: "Original-language analysis saved" });
              }
            } catch { /* soft-fail: note still generated from the English transcript */ }
          }

          // ---- Note generation (surface=note-pipeline) ----
          noteTrace = await openTrace({
            surface: "note-pipeline",
            encounter_id: id,
            doctor_email: null,
            request_input: { transcript_chars: row.transcript_raw!.length },
          });
          noteTrace.event("start", "Generating encounter note");

          const noteRes = await generateNote(row.transcript_raw!, {
            signal: req.signal,
            noteType: row.note_type ?? undefined,
            nativeReference: nativeRef,
            onEvent: (e) => {
              emit(e);
              // Mirror the same event into the trace's events array.
              const ev = e as Record<string, unknown>;
              const stage = typeof ev.stage === "string" ? ev.stage : "?";
              const state = typeof ev.state === "string" ? ev.state : undefined;
              const msNum = typeof ev.ms === "number" ? ev.ms : undefined;
              noteTrace?.event(
                `${stage}:${state ?? "tick"}`,
                JSON.stringify(ev).slice(0, 300),
                msNum,
                state === "done",
                state === "error",
              );
            },
          });

          if (!noteRes.ok) {
            emit({ stage: "error", where: "note", message: noteRes.error });
            await noteTrace.finalise({
              status: "errored",
              error_message: noteRes.error,
            });
            noteTrace = null;
            await sql`UPDATE encounter SET status = 'failed' WHERE id = ${id}`.catch(() => { /* intentional: best-effort side-write/parse; main flow continues */ });
            close();
            clearInterval(hbInterval);
            return;
          }

          await noteTrace.finalise({
            status: "completed",
            result_summary: { chief_complaint: noteHeadline(noteRes.note, row.note_type ?? undefined) || null },
            model_calls: [
              {
                model: "qwen2.5:14b",
                latency_ms: noteRes.latency_ms,
              },
            ],
          });
          noteTrace = null;

          // Persist note immediately
          try {
            await sql`
              UPDATE encounter
                 SET note_json = ${JSON.stringify(noteRes.note)}::jsonb,
                     transcript_clean = ${row.transcript_raw}
               WHERE id = ${id}
            `;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            emit({ stage: "error", where: "persist_note", message: msg });
            close();
            clearInterval(hbInterval);
            return;
          }

          // ---- CDMSS pipeline (surface=cdmss-analysis) — OFF for operative/dietetic/physio (note matrix) ----
          let cdmssToStore: CdmssRich | CdmssOutput | null = null;
          let cdmssErr: string | undefined;
          let cdmssLatencyMs: number | undefined;
          if (noteTypeHasCdmss(row.note_type ?? undefined)) {
            cdmssTrace = await openTrace({
              surface: "cdmss-analysis",
              encounter_id: id,
              doctor_email: null,
              request_input: { note_summary: noteHeadline(noteRes.note, row.note_type ?? undefined) || null },
            });
            cdmssTrace.event("start", "Running CDMSS pipeline");

            const pipelineRes = await runCdmssPipeline(noteRes.note, {
              noteType: row.note_type ?? undefined,
              signal: req.signal,
              onEvent: (e) => {
                emit(e);
                const ev = e as Record<string, unknown>;
                const stage = typeof ev.stage === "string" ? ev.stage : "?";
                const state = typeof ev.state === "string" ? ev.state : undefined;
                const msNum = typeof ev.ms === "number" ? ev.ms : undefined;
                cdmssTrace?.event(
                  `${stage}:${state ?? "tick"}`,
                  JSON.stringify(ev).slice(0, 300),
                  msNum,
                  state === "done",
                  state === "error",
                );
              },
            });
            cdmssLatencyMs = pipelineRes.latency_ms;

            if (pipelineRes.ok) {
              cdmssToStore = pipelineRes.cdmss;
            } else if (pipelineRes.fallback) {
              cdmssToStore = pipelineRes.fallback;
              cdmssErr = pipelineRes.error;
            } else {
              cdmssToStore = {
                differentials_to_consider: [],
                red_flags: [],
                evidence_based_suggestions: [],
                follow_up_considerations: [],
              };
              cdmssErr = pipelineRes.error;
            }

            await cdmssTrace.finalise({
              status: pipelineRes.ok ? "completed" : "errored",
              error_message: cdmssErr,
              result_summary: pipelineRes.ok
                ? { citations_count: (cdmssToStore as { citations?: unknown[] }).citations?.length ?? 0 }
                : null,
              model_calls: [
                { model: "llama3.1:8b",  latency_ms: pipelineRes.latency_ms ?? 0 },
                { model: "qwen2.5:14b", latency_ms: pipelineRes.latency_ms ?? 0 },
              ],
            });
            cdmssTrace = null;

            try {
              await sql`
                UPDATE encounter
                   SET cdmss_json = ${JSON.stringify(cdmssToStore)}::jsonb,
                       status     = 'complete'
                 WHERE id = ${id}
              `;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              emit({ stage: "error", where: "persist_cdmss", message: msg });
              close();
              clearInterval(hbInterval);
              return;
            }
          } else {
            // CDMSS-off note type: no decision support, just finalise.
            emit({ stage: "progress", msg: "Clinical decision support is not applicable for this note type" });
            try {
              await sql`UPDATE encounter SET status = 'complete' WHERE id = ${id}`;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              emit({ stage: "error", where: "persist_status", message: msg });
              close();
              clearInterval(hbInterval);
              return;
            }
          }

          emit({
            stage: "final",
            encounter: { id, status: "complete" },
            note: noteRes.note,
            cdmss: cdmssToStore,
            note_ms: noteRes.latency_ms,
            cdmss_ms: cdmssLatencyMs,
            cdmss_error: cdmssErr,
          });

          // V2.SD.3 — diarization runs AFTER the note is delivered to the client.
          await diarizeStore(emit);
        } catch (e) {
          // S6.3: distinguish doctor cancel from real errors.
          // S6.2b: finalise any in-progress trace before returning.
          if (isAbortError(e) || req.signal.aborted) {
            // Trace finalisation as 'aborted'
            try {
              if (noteTrace) {
                await noteTrace.finalise({
                  status: "aborted",
                  error_message: "cancelled by user",
                });
                noteTrace = null;
              }
              if (cdmssTrace) {
                await cdmssTrace.finalise({
                  status: "aborted",
                  error_message: "cancelled by user",
                });
                cdmssTrace = null;
              }
            } catch { /* best-effort */ }
            try {
              await sql`
                UPDATE encounter
                   SET status = 'draft_partial'
                 WHERE id = ${id}
                   AND status = 'processing'
              `;
              await sql`
                INSERT INTO audit_log
                  (actor_type, actor_id, action, target_type, target_id, metadata_json)
                VALUES
                  ('doctor', ${doctorId}, 'encounter.cancel_processing', 'encounter', ${id},
                   ${JSON.stringify({ reason: "client_abort" })}::jsonb)
              `;
            } catch {
              /* best-effort; client is already gone */
            }
            emit({ stage: "cancelled", message: "processing cancelled by user" });
          } else {
            const msg = e instanceof Error ? e.message : String(e);
            // Trace finalisation as 'errored'
            try {
              if (noteTrace) {
                await noteTrace.finalise({ status: "errored", error_message: msg });
                noteTrace = null;
              }
              if (cdmssTrace) {
                await cdmssTrace.finalise({ status: "errored", error_message: msg });
                cdmssTrace = null;
              }
            } catch { /* best-effort */ }
            emit({ stage: "error", where: "outer", message: msg.slice(0, 200) });
          }
        } finally {
          clearInterval(hbInterval);
          close();
        }
      },
      cancel() {
        /* client disconnect — req.signal will abort upstream LLM calls
           which throws AbortError, caught by the start()-body try/catch
           above, where we write status='draft_partial' + audit_log and
           finalise any in-progress llm_traces row as 'aborted'. */
      },
    });

    // STT Engine Lab (L1): fan the submitted audio out to all enabled engines
    // AFTER the response completes. Fully non-blocking; never affects the note.
    after(async () => {
      try { await enqueueFanout(id); await runFanoutForEncounter(id); }
      catch (e) { console.warn(`[stt-fanout] enc=${id}: ${e instanceof Error ? e.message : String(e)}`); }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // ---- Non-streaming fallthrough (rare; trace instrumentation skipped) ----
  await translateIfNeeded();
  await guardTranscripts();
  const noteRes = await generateNote(row.transcript_raw, { signal: req.signal, noteType: row.note_type ?? undefined, nativeReference: (INDIC_COMPREHENSION_ON() && row.detected_language && isNonEnglish(row.detected_language)) ? (row.transcript_original ?? undefined) : undefined });
  if (!noteRes.ok) {
    await sql`UPDATE encounter SET status = 'failed' WHERE id = ${id}`;
    return respondError(
      "PIPELINE_FAILED",
      `note_failed: ${noteRes.error.slice(0, 120)}`,
    );
  }

  try {
    await sql`
      UPDATE encounter
         SET note_json = ${JSON.stringify(noteRes.note)}::jsonb,
             transcript_clean = ${row.transcript_raw}
       WHERE id = ${id}
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", `note_persist_failed: ${msg.slice(0, 120)}`);
  }

  let cdmssToStore: CdmssRich | CdmssOutput | null = null;
  let cdmssErr: string | undefined;
  let cdmssLatencyMs: number | undefined;
  if (noteTypeHasCdmss(row.note_type ?? undefined)) {
    const pipelineRes = await runCdmssPipeline(noteRes.note, { signal: req.signal, noteType: row.note_type ?? undefined });
    cdmssLatencyMs = pipelineRes.latency_ms;
    if (pipelineRes.ok) {
      cdmssToStore = pipelineRes.cdmss;
    } else if (pipelineRes.fallback) {
      cdmssToStore = pipelineRes.fallback;
      cdmssErr = pipelineRes.error;
    } else {
      cdmssToStore = {
        differentials_to_consider: [],
        red_flags: [],
        evidence_based_suggestions: [],
        follow_up_considerations: [],
      };
      cdmssErr = pipelineRes.error;
    }
    try {
      await sql`
        UPDATE encounter
           SET cdmss_json = ${JSON.stringify(cdmssToStore)}::jsonb,
               status     = 'complete'
         WHERE id = ${id}
      `;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return respondError("PIPELINE_FAILED", `cdmss_persist_failed: ${msg.slice(0, 120)}`);
    }
  } else {
    try {
      await sql`UPDATE encounter SET status = 'complete' WHERE id = ${id}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return respondError("PIPELINE_FAILED", `status_persist_failed: ${msg.slice(0, 120)}`);
    }
  }

  await diarizeStore();

  return respondOk({
    encounter: { id, status: "complete" as const },
    note: noteRes.note,
    cdmss: cdmssToStore,
    note_ms: noteRes.latency_ms,
    cdmss_ms: cdmssLatencyMs,
    cdmss_error: cdmssErr,
  });
}
