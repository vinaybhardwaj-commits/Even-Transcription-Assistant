/**
 * lib/mcp/tools/encounters.ts — encounters + LLM traces read tools (Operator MCP S1, PRD §12 11.6).
 *
 * Reuses the admin query layer in-process: lib/encounter/admin (listAdminEncounters,
 * getFullEncounter — the same functions behind /api/admin/encounters) and lib/llm-trace/log
 * (listAdminTraces, getTrace — `llm_traces`, NOT the older `trace` table).
 *
 * Privacy defaults (PRD §16): list/get are summaries + pointers.
 *   include_identity=true → patient_label_raw, chief_complaint, doctor name/email/slug
 *   include_text=true     → transcripts / note / cdmss / native analysis / diarization content
 *   include_prompts=true  → trace request_input + result_summary
 * Audio is a pointer (audio_object_key) — no presigned URL from these tools.
 */

import { getFullEncounter, listAdminEncounters, type EncountersBucket, type EncountersWindow } from "@/lib/encounter/admin";
import { getTrace, listAdminTraces, type AdminTraceFilter, type TraceStatus } from "@/lib/llm-trace/log";
import { argBool, argInt, argStr, failSafe, type McpTool, type ToolArgs } from "../registry";

const NOTE_TYPES = ["clinic_encounter", "general_medical", "operative_procedure", "dietetic_consult", "physiotherapy", "discharge_summary", "opd_prescription"];

const listEncounters: McpTool = {
  name: "scribe_list_encounters",
  description: "Doctor-PWA encounters (admin list): id, status, send_status, recorded_at, duration, doctor id, pipeline flags. Filters: bucket (all|sent|failed|draft|processing), window (today|week|month|all), doctor_id, note_type, limit, offset. Identity (patient label, chief complaint, doctor name/email) only with include_identity=true.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      bucket: { type: "string", enum: ["all", "sent", "failed", "draft", "processing"], default: "all" },
      window: { type: "string", enum: ["today", "week", "month", "all"], default: "month" },
      doctor_id: { type: "string", description: "doc_… id" },
      note_type: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 25 },
      offset: { type: "integer", minimum: 0, default: 0 },
      include_identity: { type: "boolean", default: false },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ rows: [] as unknown[], total: 0 }, async () => {
      const bucketRaw = argStr(args, "bucket", 16);
      const bucket: EncountersBucket = bucketRaw === "sent" || bucketRaw === "failed" || bucketRaw === "draft" || bucketRaw === "processing" ? bucketRaw : "all";
      const windowRaw = argStr(args, "window", 16);
      const window: EncountersWindow = windowRaw === "today" || windowRaw === "week" || windowRaw === "month" || windowRaw === "all" ? windowRaw : "month";
      const doctorId = argStr(args, "doctor_id", 64);
      const noteTypeRaw = argStr(args, "note_type", 32);
      const includeIdentity = argBool(args, "include_identity");
      const result = await listAdminEncounters({
        bucket,
        window,
        limit: argInt(args, "limit", 25, 1, 200),
        offset: argInt(args, "offset", 0, 0, 100_000),
        doctorId: doctorId && doctorId.startsWith("doc_") ? doctorId : null,
        noteType: noteTypeRaw && NOTE_TYPES.includes(noteTypeRaw) ? noteTypeRaw : null,
      });
      const rows = result.rows.map((r) => {
        const base = {
          id: r.id,
          status: r.status,
          send_status: r.send_status,
          recorded_at: r.recorded_at,
          duration_seconds: r.duration_seconds,
          sent_at: r.sent_at,
          doctor_id: r.doctor?.id ?? null,
          has_note: r.has_note,
          has_cdmss: r.has_cdmss,
          delivered_count: r.delivered_count,
        };
        return includeIdentity
          ? { ...base, patient_label_raw: r.patient_label_raw, chief_complaint: r.chief_complaint, doctor: r.doctor }
          : base;
      });
      return { rows, total: result.total, counts: result.counts, filter: { bucket, window, limit: rows.length } };
    }),
};

const getEncounter: McpTool = {
  name: "scribe_get_encounter",
  description: "One encounter (admin bundle): status/timings/pipeline flags, doctor id, transcription runs (engine, latency, score — no text), llm trace ids, send events, audit rows, audio pointer (R2 key only). include_identity=true adds patient label + doctor name/email; include_text=true adds transcripts, note_json, cdmss_json, native analysis, diarization content.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      encounter_id: { type: "string", description: "enc_… id" },
      include_identity: { type: "boolean", default: false },
      include_text: { type: "boolean", default: false },
    },
    required: ["encounter_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ encounter: null as unknown }, async () => {
      const id = argStr(args, "encounter_id", 64);
      if (!id || !id.startsWith("enc_")) return { encounter: null, error: "bad_encounter_id" };
      const enc = await getFullEncounter(id);
      if (!enc) return { encounter: null, error: "encounter_not_found" };
      const includeIdentity = argBool(args, "include_identity");
      const includeText = argBool(args, "include_text");
      const base: Record<string, unknown> = {
        id: enc.id,
        status: enc.status,
        send_status: enc.send_status,
        recorded_at: enc.recorded_at,
        duration_seconds: enc.duration_seconds,
        detected_language: enc.detected_language,
        note_type: enc.note_type,
        sent_at: enc.sent_at,
        deleted_at: enc.deleted_at,
        doctor_id: enc.doctor?.id ?? null,
        audio_object_key: enc.audio_object_key,
        audio_bytes: enc.audio_bytes,
        diarize_status: enc.diarize_status,
        diarize_error: enc.diarize_error,
        diarize_started_at: enc.diarize_started_at,
        diarize_completed_at: enc.diarize_completed_at,
        has_transcript: !!(enc.transcript_clean || enc.transcript_raw),
        transcript_chars: (enc.transcript_clean ?? enc.transcript_raw ?? "").length,
        has_note: !!enc.note_json,
        has_note_edit: !!enc.note_json_edited,
        has_cdmss: !!enc.cdmss_json,
        has_native_analysis: !!enc.native_analysis,
        speaker_count: Array.isArray(enc.speakers) ? enc.speakers.length : null,
        transcription_runs: enc.transcription_runs.map((r) => ({
          id: r.id,
          engine: r.engine,
          mode: r.mode,
          detected_language: r.detected_language,
          latency_ms: r.latency_ms,
          judge_score: r.judge_score,
          is_winner: r.is_winner,
          created_at: r.created_at,
          ...(includeText ? { transcript_original: r.transcript_original, transcript_english: r.transcript_english } : {}),
        })),
        llm_traces: enc.llm_traces.map((t) => ({ id: t.id, surface: t.surface, status: t.status, total_ms: t.total_ms, started_at: t.started_at, completed_at: t.completed_at, error_message: t.error_message })),
        send_events: enc.send_events.map((s) => ({ id: s.id, status: s.status, created_at: s.created_at, updated_at: s.updated_at, failure_reason: s.failure_reason, ...(includeIdentity ? { recipient_email: s.recipient_email } : {}) })),
        audit_log: enc.audit_log,
      };
      if (includeIdentity) {
        base.patient_label_raw = enc.patient_label_raw;
        base.doctor = enc.doctor;
      }
      if (includeText) {
        base.transcript_raw = enc.transcript_raw;
        base.transcript_clean = enc.transcript_clean;
        base.transcript_original = enc.transcript_original;
        base.native_analysis = enc.native_analysis;
        base.native_analysis_lang = enc.native_analysis_lang;
        base.note_json = enc.note_json;
        base.note_json_edited = enc.note_json_edited;
        base.cdmss_json = enc.cdmss_json;
        base.speakers = enc.speakers;
        base.transcript_segments = enc.transcript_segments;
        base.overlap_windows = enc.overlap_windows;
        base.aggregates = enc.aggregates;
        base.tagged_transcript = enc.tagged_transcript;
      }
      return { encounter: base };
    }),
};

const listTraces: McpTool = {
  name: "scribe_list_traces",
  description: "LLM pipeline traces (llm_traces): id, surface, status, total_ms, started/completed, error, encounter_id, model summary, tokens. Filters: surface, status (in_progress|completed|errored|aborted), window (today|last24h|all), limit, offset. Same as GET /api/admin/traces.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      surface: { type: "string" },
      status: { type: "string", enum: ["in_progress", "completed", "errored", "aborted"] },
      window: { type: "string", enum: ["today", "last24h", "all"], default: "last24h" },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
      offset: { type: "integer", minimum: 0, default: 0 },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ traces: [] as unknown[], total: 0 }, async () => {
      const statusRaw = argStr(args, "status", 16);
      const status: TraceStatus | null = statusRaw === "in_progress" || statusRaw === "completed" || statusRaw === "errored" || statusRaw === "aborted" ? statusRaw : null;
      const windowRaw = argStr(args, "window", 16);
      const window: AdminTraceFilter["window"] = windowRaw === "today" || windowRaw === "last24h" || windowRaw === "all" ? windowRaw : "last24h";
      const { rows, total } = await listAdminTraces({
        surface: argStr(args, "surface", 64),
        status,
        window,
        limit: argInt(args, "limit", 50, 1, 500),
        offset: argInt(args, "offset", 0, 0, 100_000),
      });
      return { traces: rows, total };
    }),
};

const getTraceTool: McpTool = {
  name: "scribe_get_trace",
  description: "One llm_traces row: surface, status, timings, events (stage log), model_calls, encounter_id. request_input (prompt) and result_summary ONLY with include_prompts=true; doctor_email/patient_id only with include_identity=true.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      trace_id: { type: "string" },
      include_prompts: { type: "boolean", default: false },
      include_identity: { type: "boolean", default: false },
    },
    required: ["trace_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ trace: null as unknown }, async () => {
      const id = argStr(args, "trace_id", 128);
      if (!id || id.length < 8) return { trace: null, error: "bad_trace_id" };
      const t = await getTrace(id);
      if (!t) return { trace: null, error: "trace_not_found" };
      const includePrompts = argBool(args, "include_prompts");
      const includeIdentity = argBool(args, "include_identity");
      const { request_input, result_summary, doctor_email, patient_id, ...rest } = t;
      return {
        trace: {
          ...rest,
          ...(includePrompts ? { request_input, result_summary } : { has_request_input: request_input != null, has_result_summary: result_summary != null }),
          ...(includeIdentity ? { doctor_email, patient_id } : {}),
        },
      };
    }),
};

export const ENCOUNTER_TOOLS: McpTool[] = [listEncounters, getEncounter, listTraces, getTraceTool];
