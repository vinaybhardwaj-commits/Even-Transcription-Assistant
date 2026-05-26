/**
 * lib/llm-trace/log.ts — Sprint 0 no-op stub.
 *
 * The lifted OPD version writes to an llm_traces table (per-pipeline shape).
 * ETA's schema has a per-stage `trace` table (CDMSS-shaped — see db/schema.ts).
 * Sprint 1 reconciles: either add an llm_traces table to schema OR rewrite
 * this module against the per-stage trace table.
 *
 * For Sprint 0 the lifted TracePanel + BackgroundTraceToaster + AiActivityList
 * components import types from this file; the FUNCTIONS just need to exist
 * and return the right shape so the build passes. Nothing in the Sprint 0
 * deploy actually fires LLM pipelines, so no-op persistence is fine.
 *
 * DO NOT use these stubs in Sprint 1+ work without revisiting persistence.
 */

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
  event: (stage: string, msg: string, ms?: number, done?: boolean, error?: boolean) => void;
  finalise: (args: {
    status: TraceStatus;
    result_summary?: unknown;
    error_message?: string;
    model_calls?: Array<{ model: string; latency_ms: number; tokens_in?: number; tokens_out?: number }>;
  }) => Promise<void>;
};

export async function openTrace(_args: OpenTraceArgs): Promise<TraceHandle> {
  const id = crypto.randomUUID();
  return {
    id,
    event: () => {
      // Sprint 0 no-op. Sprint 1 wires real persistence.
    },
    finalise: async () => {
      // Sprint 0 no-op.
    },
  };
}

export async function getTrace(_id: string): Promise<{
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
  return null;
}

export async function listTracesForEncounter(
  _encounterId: string,
  _limit = 100
): Promise<Array<{
  id: string;
  surface: string;
  status: TraceStatus;
  total_ms: number | null;
  started_at: string;
}>> {
  return [];
}

export async function listTracesForPatient(
  _patientId: string,
  _limit = 100
): Promise<Array<{
  id: string;
  surface: string;
  status: TraceStatus;
  total_ms: number | null;
  started_at: string;
  encounter_id: string | null;
}>> {
  return [];
}
