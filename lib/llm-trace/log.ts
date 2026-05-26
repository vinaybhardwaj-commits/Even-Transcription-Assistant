/**
 * lib/llm-trace/log.ts — forensic per-pipeline trace logging.
 *
 * Writes to the `llm_traces` table (migration 0002). One row per multi-stage
 * LLM pipeline fire; the row's `events` JSONB field accumulates all stage
 * events for that pipeline. Drives the TracePanel, BackgroundTraceToaster,
 * and AiActivityList UI components (lifted from OPD v6.0).
 *
 * Distinct from the per-stage `trace` table (PRD §6.1, CDMSS shape) which
 * would log one row per individual LLM call. Both can coexist; this module
 * targets only `llm_traces`.
 *
 * All writes soft-fail with console.warn — pipeline never aborts on a
 * trace persistence failure.
 *
 * Usage pattern in a route:
 *
 *   const trace = await openTrace({ surface: "ddx", encounter_id, doctor_email });
 *   try {
 *     trace.event("expanding", "Building clinical summary…");
 *     // ...pipeline work, more trace.event() calls...
 *     trace.event("done", "", Date.now() - t0, true);
 *     await trace.finalise({ status: "completed", result_summary: result });
 *   } catch (e) {
 *     await trace.finalise({ status: "errored", error_message: String(e) });
 *   }
 */

import { sql } from "@/lib/db";

export type TraceEventLog = {
  ts: number;
  stage: string;
  msg: string;
  ms?: number;
  done?: boolean;
  error?: boolean;
};

export type TraceStatus = "in_progress" | "completed" | "errored" | "aborted";

export type OpenTraceArgs = {
  surface: string;
  encounter_id?: string | null;
  patient_id?: string | null;
  doctor_email?: string | null;
  request_input?: unknown;
};

export type TraceHandle = {
  id: string;
  event: (
    stage: string,
    msg: string,
    ms?: number,
    done?: boolean,
    error?: boolean
  ) => void;
  finalise: (args: {
    status: TraceStatus;
    result_summary?: unknown;
    error_message?: string;
    model_calls?: Array<{
      model: string;
      latency_ms: number;
      tokens_in?: number;
      tokens_out?: number;
    }>;
  }) => Promise<void>;
};

export async function openTrace(args: OpenTraceArgs): Promise<TraceHandle> {
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const events: TraceEventLog[] = [];

  try {
    await sql`
      INSERT INTO llm_traces
        (id, surface, encounter_id, patient_id, doctor_email,
         request_input, events, status, started_at)
      VALUES (
        ${id}, ${args.surface}, ${args.encounter_id ?? null},
        ${args.patient_id ?? null}, ${args.doctor_email ?? null},
        ${args.request_input ? JSON.stringify(args.request_input) : null}::jsonb,
        '[]'::jsonb, 'in_progress', ${startedAt}::timestamptz
      )
    `;
  } catch (e) {
    console.warn("[llm-trace] openTrace insert failed (continuing):", e);
  }

  return {
    id,
    event(stage, msg, ms, done = false, error = false) {
      events.push({ ts: Date.now(), stage, msg, ms, done, error });
    },
    async finalise({ status, result_summary, error_message, model_calls }) {
      const total_ms =
        events.length > 0 ? Date.now() - (events[0]?.ts ?? Date.now()) : null;
      const completed_at = new Date().toISOString();
      try {
        await sql`
          UPDATE llm_traces
             SET events = ${JSON.stringify(events)}::jsonb,
                 result_summary = ${result_summary ? JSON.stringify(result_summary) : null}::jsonb,
                 model_calls = ${model_calls ? JSON.stringify(model_calls) : null}::jsonb,
                 total_ms = ${total_ms},
                 status = ${status},
                 error_message = ${error_message ?? null},
                 completed_at = ${completed_at}::timestamptz
           WHERE id = ${id}
        `;
      } catch (e) {
        console.warn("[llm-trace] finalise UPDATE failed (continuing):", e);
      }
    },
  };
}

export async function getTrace(id: string): Promise<{
  id: string;
  surface: string;
  encounter_id: string | null;
  patient_id: string | null;
  doctor_email: string | null;
  request_input: unknown;
  events: TraceEventLog[];
  result_summary: unknown;
  model_calls: unknown;
  total_ms: number | null;
  status: TraceStatus;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
} | null> {
  try {
    const rows = (await sql`
      SELECT id, surface, encounter_id, patient_id, doctor_email,
             request_input, events, result_summary, model_calls,
             total_ms, status, error_message,
             started_at::text AS started_at,
             completed_at::text AS completed_at
        FROM llm_traces WHERE id = ${id} LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: String(r.id),
      surface: String(r.surface),
      encounter_id: r.encounter_id ? String(r.encounter_id) : null,
      patient_id: r.patient_id ? String(r.patient_id) : null,
      doctor_email: r.doctor_email ? String(r.doctor_email) : null,
      request_input: r.request_input ?? null,
      events: Array.isArray(r.events) ? (r.events as TraceEventLog[]) : [],
      result_summary: r.result_summary ?? null,
      model_calls: r.model_calls ?? null,
      total_ms: r.total_ms == null ? null : Number(r.total_ms),
      status: (r.status as TraceStatus) ?? "in_progress",
      error_message: r.error_message ? String(r.error_message) : null,
      started_at: String(r.started_at),
      completed_at: r.completed_at ? String(r.completed_at) : null,
    };
  } catch (e) {
    console.warn("[llm-trace] getTrace failed:", e);
    return null;
  }
}

export async function listTracesForEncounter(
  encounterId: string,
  limit = 100
): Promise<
  Array<{
    id: string;
    surface: string;
    status: TraceStatus;
    total_ms: number | null;
    started_at: string;
  }>
> {
  try {
    const rows = (await sql`
      SELECT id, surface, status, total_ms, started_at::text AS started_at
        FROM llm_traces
       WHERE encounter_id = ${encounterId}
       ORDER BY started_at DESC
       LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      surface: String(r.surface),
      status: (r.status as TraceStatus) ?? "in_progress",
      total_ms: r.total_ms == null ? null : Number(r.total_ms),
      started_at: String(r.started_at),
    }));
  } catch (e) {
    console.warn("[llm-trace] listTracesForEncounter failed:", e);
    return [];
  }
}

export async function listTracesForPatient(
  patientId: string,
  limit = 100
): Promise<
  Array<{
    id: string;
    surface: string;
    status: TraceStatus;
    total_ms: number | null;
    started_at: string;
    encounter_id: string | null;
  }>
> {
  try {
    const rows = (await sql`
      SELECT id, surface, status, total_ms, encounter_id,
             started_at::text AS started_at
        FROM llm_traces
       WHERE patient_id = ${patientId}
       ORDER BY started_at DESC
       LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      surface: String(r.surface),
      status: (r.status as TraceStatus) ?? "in_progress",
      total_ms: r.total_ms == null ? null : Number(r.total_ms),
      started_at: String(r.started_at),
      encounter_id: r.encounter_id ? String(r.encounter_id) : null,
    }));
  } catch (e) {
    console.warn("[llm-trace] listTracesForPatient failed:", e);
    return [];
  }
}
