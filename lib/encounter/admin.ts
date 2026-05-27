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
