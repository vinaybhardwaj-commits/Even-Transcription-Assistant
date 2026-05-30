/**
 * lib/encounter/admin.ts — server helpers for the admin Encounter detail
 * page (Sprint 7). Three exports:
 *
 *   - getFullEncounter(id)    — bundle the encounter row, its doctor, all
 *                                send_events, audit_logs, and llm_traces
 *                                (with full events array per trace).
 *   - softDeleteEncounter()   — set status='deleted', null the JSONs +
 *                                transcripts, leave audio_object_key intact
 *                                in R2 (per PRD §4.17). Writes audit_log.
 *   - listEncounterRecipientCandidates() — global CCs + per-doctor
 *                                recipients for the resend picker.
 */

import { sql } from "@/lib/db";
import { listTracesForEncounter, getTrace, type TraceStatus } from "@/lib/llm-trace/log";
import type { EncounterNote } from "@/lib/note-generation";
import type { CdmssOutput } from "@/lib/cdmss-stub";

type EncounterStatus =
  | "draft" | "processing" | "complete" | "failed" | "deleted" | "draft_partial";

export type EncounterFull = {
  // Encounter row
  id: string;
  status: EncounterStatus;
  send_status: "pending" | "sent" | "failed";
  patient_label_raw: string | null;
  recorded_at: string;
  duration_seconds: number | null;
  transcript_raw: string | null;
  transcript_clean: string | null;
  detected_language: string | null;
  transcript_original: string | null;
  // v2.1 diarization (migration 0007)
  speakers: unknown[] | null;
  transcript_segments: unknown[] | null;
  overlap_windows: unknown[] | null;
  aggregates: Record<string, unknown> | null;
  tagged_transcript: unknown[] | null;
  diarize_status: string | null;
  diarize_error: string | null;
  diarize_started_at: string | null;
  diarize_completed_at: string | null;
  note_json: EncounterNote | null;
  note_json_edited: EncounterNote | null;
  cdmss_json: CdmssOutput | null;
  audio_object_key: string | null;
  audio_bytes: number | null;
  sent_at: string | null;
  deleted_at: string | null;

  // Doctor (for hero)
  doctor: {
    id: string;
    full_name: string;
    email: string;
    url_slug: string;
  } | null;

  // Send timeline (right rail)
  send_events: Array<{
    id: string;
    recipient_email: string;
    status: string;
    subject_rendered: string | null;
    resend_message_id: string | null;
    failure_reason: string | null;
    updated_at: string | null;
    opened_at: string | null;
    bounced_at: string | null;
    complained_at: string | null;
    created_at: string;
  }>;

  // Audit log (right rail)
  audit_log: Array<{
    id: string;
    actor_type: "admin" | "doctor" | "system";
    actor_id: string | null;
    action: string;
    metadata_json: unknown;
    created_at: string;
  }>;

  // Multi-engine transcription comparison (testbed): one row per engine.
  transcription_runs: Array<{
    id: string;
    engine: string;
    mode: string;
    detected_language: string | null;
    transcript_original: string | null;
    transcript_english: string | null;
    latency_ms: number | null;
    judge_score: number | null;
    is_winner: boolean;
    created_at: string;
  }>;

  // LLM traces (one per surface invocation). Full payload with events.
  llm_traces: Array<{
    id: string;
    surface: string;
    status: TraceStatus;
    total_ms: number | null;
    started_at: string;
    completed_at: string | null;
    error_message: string | null;
    events: Array<{
      ts: number;
      stage: string;
      msg: string;
      ms?: number;
      done?: boolean;
      error?: boolean;
    }>;
    model_calls: Array<{
      model: string;
      latency_ms: number;
      tokens_in?: number;
      tokens_out?: number;
    }>;
  }>;
};

export async function getFullEncounter(id: string): Promise<EncounterFull | null> {
  // 1) encounter + doctor in one go
  const encRows = (await sql`
    SELECT
      e.id,
      e.status,
      e.send_status,
      e.patient_label_raw,
      e.recorded_at::text   AS recorded_at,
      e.duration_seconds,
      e.transcript_raw,
      e.transcript_clean,
      e.detected_language,
      e.transcript_original,
      e.speakers,
      e.transcript_segments,
      e.overlap_windows,
      e.aggregates,
      e.tagged_transcript,
      e.diarize_status,
      e.diarize_error,
      e.diarize_started_at::text   AS diarize_started_at,
      e.diarize_completed_at::text AS diarize_completed_at,
      e.note_json,
      e.note_json_edited,
      e.cdmss_json,
      e.audio_object_key,
      e.audio_bytes,
      e.sent_at::text       AS sent_at,
      e.deleted_at::text    AS deleted_at,
      d.id                  AS doctor_id,
      d.full_name           AS doctor_full_name,
      d.email               AS doctor_email,
      d.url_slug            AS doctor_url_slug
    FROM encounter e
    LEFT JOIN doctor d ON d.id = e.doctor_id
    WHERE e.id = ${id}
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  const r = encRows[0];
  if (!r) return null;

  // 2) send_events
  const seRows = (await sql`
    SELECT
      id,
      recipient_email,
      status,
      subject_rendered,
      resend_message_id,
      failure_reason,
      updated_at::text    AS updated_at,
      opened_at::text     AS opened_at,
      bounced_at::text    AS bounced_at,
      complained_at::text AS complained_at,
      created_at::text    AS created_at
    FROM send_event
    WHERE encounter_id = ${id}
    ORDER BY created_at ASC
  `) as Array<Record<string, unknown>>;

  // 3) audit_log
  const auRows = (await sql`
    SELECT
      id,
      actor_type,
      actor_id,
      action,
      metadata_json,
      created_at::text AS created_at
    FROM audit_log
    WHERE target_type = 'encounter' AND target_id = ${id}
    ORDER BY created_at DESC
    LIMIT 100
  `) as Array<Record<string, unknown>>;

  // 3b) transcription_run — per-engine comparison rows (testbed)
  const trRows = (await sql`
    SELECT id, engine, mode, detected_language, transcript_original,
           transcript_english, latency_ms, judge_score, is_winner,
           created_at::text AS created_at
    FROM transcription_run
    WHERE encounter_id = ${id}
    ORDER BY created_at ASC
  `) as Array<Record<string, unknown>>;

  // 4) llm_traces — first summary, then full detail for each
  const traceSummary = await listTracesForEncounter(id, 20);
  const tracesFull = await Promise.all(
    traceSummary.map(async (t) => {
      const full = await getTrace(t.id);
      if (!full) return null;
      const events = Array.isArray(full.events) ? full.events : [];
      const modelCalls = Array.isArray(full.model_calls)
        ? (full.model_calls as Array<{
            model: string;
            latency_ms: number;
            tokens_in?: number;
            tokens_out?: number;
          }>)
        : [];
      return {
        id: full.id,
        surface: full.surface,
        status: full.status,
        total_ms: full.total_ms,
        started_at: full.started_at,
        completed_at: full.completed_at,
        error_message: full.error_message,
        events,
        model_calls: modelCalls,
      };
    }),
  );

  return {
    id: String(r.id),
    status: r.status as EncounterStatus,
    send_status: (r.send_status as "pending" | "sent" | "failed") ?? "pending",
    patient_label_raw: r.patient_label_raw ? String(r.patient_label_raw) : null,
    recorded_at: String(r.recorded_at),
    duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
    transcript_raw: r.transcript_raw ? String(r.transcript_raw) : null,
    transcript_clean: r.transcript_clean ? String(r.transcript_clean) : null,
    note_json: (r.note_json as EncounterNote | null) ?? null,
    detected_language: r.detected_language ? String(r.detected_language) : null,
    transcript_original: r.transcript_original ? String(r.transcript_original) : null,
    speakers: (r.speakers as unknown[] | null) ?? null,
    transcript_segments: (r.transcript_segments as unknown[] | null) ?? null,
    overlap_windows: (r.overlap_windows as unknown[] | null) ?? null,
    aggregates: (r.aggregates as Record<string, unknown> | null) ?? null,
    tagged_transcript: (r.tagged_transcript as unknown[] | null) ?? null,
    diarize_status: r.diarize_status ? String(r.diarize_status) : null,
    diarize_error: r.diarize_error ? String(r.diarize_error) : null,
    diarize_started_at: r.diarize_started_at ? String(r.diarize_started_at) : null,
    diarize_completed_at: r.diarize_completed_at ? String(r.diarize_completed_at) : null,
    note_json_edited: (r.note_json_edited as EncounterNote | null) ?? null,
    cdmss_json: (r.cdmss_json as CdmssOutput | null) ?? null,
    audio_object_key: r.audio_object_key ? String(r.audio_object_key) : null,
    audio_bytes: r.audio_bytes == null ? null : Number(r.audio_bytes),
    sent_at: r.sent_at ? String(r.sent_at) : null,
    deleted_at: r.deleted_at ? String(r.deleted_at) : null,
    doctor: r.doctor_id
      ? {
          id: String(r.doctor_id),
          full_name: String(r.doctor_full_name ?? ""),
          email: String(r.doctor_email ?? ""),
          url_slug: String(r.doctor_url_slug ?? ""),
        }
      : null,
    send_events: seRows.map((x) => ({
      id: String(x.id),
      recipient_email: String(x.recipient_email),
      status: String(x.status),
      subject_rendered: x.subject_rendered ? String(x.subject_rendered) : null,
      resend_message_id: x.resend_message_id ? String(x.resend_message_id) : null,
      failure_reason: x.failure_reason ? String(x.failure_reason) : null,
      updated_at: x.updated_at ? String(x.updated_at) : null,
      opened_at: x.opened_at ? String(x.opened_at) : null,
      bounced_at: x.bounced_at ? String(x.bounced_at) : null,
      complained_at: x.complained_at ? String(x.complained_at) : null,
      created_at: String(x.created_at),
    })),
    audit_log: auRows.map((x) => ({
      id: String(x.id),
      actor_type: x.actor_type as "admin" | "doctor" | "system",
      actor_id: x.actor_id ? String(x.actor_id) : null,
      action: String(x.action),
      metadata_json: x.metadata_json ?? null,
      created_at: String(x.created_at),
    })),
    transcription_runs: trRows.map((x) => ({
      id: String(x.id),
      engine: String(x.engine),
      mode: String(x.mode),
      detected_language: x.detected_language ? String(x.detected_language) : null,
      transcript_original: x.transcript_original ? String(x.transcript_original) : null,
      transcript_english: x.transcript_english ? String(x.transcript_english) : null,
      latency_ms: x.latency_ms == null ? null : Number(x.latency_ms),
      judge_score: x.judge_score == null ? null : Number(x.judge_score),
      is_winner: Boolean(x.is_winner),
      created_at: String(x.created_at),
    })),
    llm_traces: tracesFull.filter(
      (t): t is NonNullable<typeof t> => t !== null,
    ),
  };
}

export async function softDeleteEncounter(args: {
  id: string;
  adminId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await sql`
      UPDATE encounter
         SET status              = 'deleted',
             note_json           = NULL,
             note_json_edited    = NULL,
             cdmss_json          = NULL,
             transcript_raw      = NULL,
             transcript_clean    = NULL,
             deleted_at          = NOW()
       WHERE id = ${args.id}
         AND deleted_at IS NULL
    `;
    await sql`
      INSERT INTO audit_log
        (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES
        ('admin', ${args.adminId}, 'encounter.soft_delete', 'encounter', ${args.id},
         ${JSON.stringify({ retained: ["audio_object_key", "audit_log", "send_event"] })}::jsonb)
    `;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listEncounterRecipientCandidates(
  doctorId: string,
): Promise<{
  per_doctor: Array<{ id: string; email: string; name: string; role: string }>;
  global: Array<{ id: string; email: string; name: string; role: string }>;
}> {
  const [perRows, globalRows] = await Promise.all([
    sql`
      SELECT id::text AS id, email, name, role
        FROM recipient_per_doctor
       WHERE doctor_id = ${doctorId}
       ORDER BY name
    `,
    sql`
      SELECT id::text AS id, email, name, role
        FROM recipient_global
       WHERE active = TRUE
       ORDER BY name
    `,
  ]);
  return {
    per_doctor: (perRows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      email: String(r.email),
      name: String(r.name),
      role: String(r.role),
    })),
    global: (globalRows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      email: String(r.email),
      name: String(r.name),
      role: String(r.role),
    })),
  };
}

// ---------------------------------------------------------------------------
// Sprint 8 list helpers — cross-doctor encounter list for /admin/encounters.
//
// Per V's Q1 lock (27 May 2026), the filter chips are:
//   - all        → no status/send_status filter
//   - sent       → send_status = 'sent'
//   - failed     → send_status = 'failed'
//   - draft      → status = 'draft'
//   - processing → status = 'processing'
//
// Per V's Q3 lock — rows are grouped by recorded_at bucket (today /
// yesterday / earlier_this_week / earlier_this_month / older) in the
// CLIENT, not the API. API just returns ORDER BY recorded_at DESC.
// ---------------------------------------------------------------------------

export type EncountersBucket = "all" | "sent" | "failed" | "draft" | "processing";
export type EncountersWindow = "today" | "week" | "month" | "all";

export type AdminEncounterListRow = {
  id: string;
  status: EncounterStatus;
  send_status: "pending" | "sent" | "failed";
  patient_label_raw: string | null;
  chief_complaint: string | null;
  recorded_at: string;
  duration_seconds: number | null;
  sent_at: string | null;
  doctor: {
    id: string;
    full_name: string;
    email: string;
    url_slug: string;
  } | null;
  // For the PIPELINE column — yes/no flags for note + cdmss completion
  has_note: boolean;
  has_cdmss: boolean;
  // For the SEND column — recipient count from send_events with terminal success
  delivered_count: number;
};

export type AdminEncounterListResult = {
  rows: AdminEncounterListRow[];
  total: number;
  // Bucket counts (always computed across the chosen WINDOW, never the bucket)
  // so the filter chips can show 'Sent 14 / Failed 1 / Draft 2 …'
  counts: {
    all: number;
    sent: number;
    failed: number;
    draft: number;
    processing: number;
    today: number;
    week: number;
    month: number;
  };
};

function windowSinceForEnc(window: EncountersWindow): Date {
  const d = new Date();
  switch (window) {
    case "today": d.setUTCHours(0, 0, 0, 0); return d;
    case "week":  return new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "month": return new Date(d.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":   return new Date(0);
  }
}

export async function listAdminEncounters(args: {
  bucket?: EncountersBucket;
  window?: EncountersWindow;
  limit?: number;
  offset?: number;
  doctorId?: string | null;
}): Promise<AdminEncounterListResult> {
  const bucket = args.bucket ?? "all";
  const window = args.window ?? "month";
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
  const offset = Math.max(args.offset ?? 0, 0);
  // Optional per-doctor scope. Each SQL below adds an extra AND when set.
  // We bind as text or NULL so the same query plan handles both cases.
  const doctorId: string | null =
    typeof args.doctorId === "string" && args.doctorId.length > 0
      ? args.doctorId
      : null;
  const since = windowSinceForEnc(window).toISOString();

  // Translate bucket → (statusFilter, sendStatusFilter)
  const statusFilter: string | null =
    bucket === "draft" ? "draft" :
    bucket === "processing" ? "processing" :
    null;
  const sendStatusFilter: string | null =
    bucket === "sent" ? "sent" :
    bucket === "failed" ? "failed" :
    null;

  try {
    // Total + rows (parallel)
    const [totalRows, rows] = await Promise.all([
      sql`
        SELECT COUNT(*)::int AS n
          FROM encounter e
         WHERE e.recorded_at >= ${since}::timestamptz
           AND (e.deleted_at IS NULL)
           AND (${statusFilter}::text     IS NULL OR e.status      = ${statusFilter}::encounter_status)
           AND (${sendStatusFilter}::text IS NULL OR e.send_status = ${sendStatusFilter}::send_status)
           AND (${doctorId}::text         IS NULL OR e.doctor_id   = ${doctorId})
      `,
      sql`
        SELECT
          e.id,
          e.status,
          e.send_status,
          e.patient_label_raw,
          COALESCE(
            (e.note_json_edited->>'chief_complaint'),
            (e.note_json->>'chief_complaint'),
            e.chief_complaint
          )                    AS chief_complaint,
          e.recorded_at::text  AS recorded_at,
          e.duration_seconds,
          e.sent_at::text      AS sent_at,
          (e.note_json IS NOT NULL OR e.note_json_edited IS NOT NULL) AS has_note,
          (e.cdmss_json IS NOT NULL) AS has_cdmss,
          d.id                 AS doctor_id,
          d.full_name          AS doctor_full_name,
          d.email              AS doctor_email,
          d.url_slug           AS doctor_url_slug,
          (
            SELECT COUNT(*)::int FROM send_event se
             WHERE se.encounter_id = e.id
               AND se.status IN ('sent','delivered','opened')
          ) AS delivered_count
        FROM encounter e
        LEFT JOIN doctor d ON d.id = e.doctor_id
        WHERE e.recorded_at >= ${since}::timestamptz
          AND (e.deleted_at IS NULL)
          AND (${statusFilter}::text     IS NULL OR e.status      = ${statusFilter}::encounter_status)
          AND (${sendStatusFilter}::text IS NULL OR e.send_status = ${sendStatusFilter}::send_status)
          AND (${doctorId}::text         IS NULL OR e.doctor_id   = ${doctorId})
        ORDER BY e.recorded_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    ]);

    // Bucket counts — single query computing all five bucket counters + window counters
    const countRows = (await sql`
      WITH window_today AS (
        SELECT COUNT(*)::int AS n FROM encounter
         WHERE recorded_at >= date_trunc('day', NOW()) AND deleted_at IS NULL
           AND (${doctorId}::text IS NULL OR doctor_id = ${doctorId})
      ),
      window_week AS (
        SELECT COUNT(*)::int AS n FROM encounter
         WHERE recorded_at >= NOW() - INTERVAL '7 days' AND deleted_at IS NULL
           AND (${doctorId}::text IS NULL OR doctor_id = ${doctorId})
      ),
      window_month AS (
        SELECT COUNT(*)::int AS n FROM encounter
         WHERE recorded_at >= NOW() - INTERVAL '30 days' AND deleted_at IS NULL
           AND (${doctorId}::text IS NULL OR doctor_id = ${doctorId})
      ),
      window_set AS (
        SELECT * FROM encounter
         WHERE recorded_at >= ${since}::timestamptz AND deleted_at IS NULL
           AND (${doctorId}::text IS NULL OR doctor_id = ${doctorId})
      )
      SELECT
        (SELECT COUNT(*)::int FROM window_set)                                      AS all_count,
        (SELECT COUNT(*)::int FROM window_set WHERE send_status = 'sent')           AS sent_count,
        (SELECT COUNT(*)::int FROM window_set WHERE send_status = 'failed')         AS failed_count,
        (SELECT COUNT(*)::int FROM window_set WHERE status = 'draft')               AS draft_count,
        (SELECT COUNT(*)::int FROM window_set WHERE status = 'processing')          AS processing_count,
        (SELECT n FROM window_today)                                                AS today_count,
        (SELECT n FROM window_week)                                                 AS week_count,
        (SELECT n FROM window_month)                                                AS month_count
    `) as Array<{
      all_count: number; sent_count: number; failed_count: number;
      draft_count: number; processing_count: number;
      today_count: number; week_count: number; month_count: number;
    }>;
    const c = countRows[0] ?? {
      all_count: 0, sent_count: 0, failed_count: 0,
      draft_count: 0, processing_count: 0,
      today_count: 0, week_count: 0, month_count: 0,
    };

    return {
      rows: (rows as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        status: r.status as EncounterStatus,
        send_status: (r.send_status as "pending" | "sent" | "failed") ?? "pending",
        patient_label_raw: r.patient_label_raw ? String(r.patient_label_raw) : null,
        chief_complaint: r.chief_complaint ? String(r.chief_complaint) : null,
        recorded_at: String(r.recorded_at),
        duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
        sent_at: r.sent_at ? String(r.sent_at) : null,
        doctor: r.doctor_id ? {
          id: String(r.doctor_id),
          full_name: String(r.doctor_full_name ?? ""),
          email:     String(r.doctor_email ?? ""),
          url_slug:  String(r.doctor_url_slug ?? ""),
        } : null,
        has_note: Boolean(r.has_note),
        has_cdmss: Boolean(r.has_cdmss),
        delivered_count: r.delivered_count == null ? 0 : Number(r.delivered_count),
      })),
      total: (totalRows as Array<{ n: number }>)[0]?.n ?? 0,
      counts: {
        all:        c.all_count,
        sent:       c.sent_count,
        failed:     c.failed_count,
        draft:      c.draft_count,
        processing: c.processing_count,
        today:      c.today_count,
        week:       c.week_count,
        month:      c.month_count,
      },
    };
  } catch (e) {
    console.warn("[admin] listAdminEncounters failed:", e);
    return {
      rows: [], total: 0,
      counts: { all: 0, sent: 0, failed: 0, draft: 0, processing: 0, today: 0, week: 0, month: 0 },
    };
  }
}
