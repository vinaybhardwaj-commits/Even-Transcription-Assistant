/**
 * lib/mcp/tools/jev.ts — Slice J2 (ETA-JEV-ARM-D §5.5) plus J-CORE-2 (PLAN-v3.md §2). Operator-
 * door tools for Jev.
 *
 * scribe_jev_window_run submits the jev_window job (bench-only; the job itself never reaches
 * TypeSafe unless ETA_JEV_ENABLED — D1 gate lives in lib/jev/client.ts, not here).
 * scribe_jev_signals is READ-only and returns jev_window_signal rows — probabilities and phase,
 * never transcript text (that lives in jev_window_text and is not this tool's business).
 * scribe_jev_decisions is READ-only and returns jev_decision rows (migration 116) — the general
 * decision log every use writes through lib/jev/ask.ts. No FK on subject_id (it is polymorphic on
 * subject_type, see the migration), so filtering is by exact match on the columns given, ANDed.
 * scribe_clinical_route_replay (order JEV-U6-ROUTE, PLAN-v3 §A) INVOKES U6 clinical-or-not routing
 * over one room-day's bench_window rows — the already-trialled question E-6's shadow-v2 also asks
 * (lib/jev/prompts/encounter-v1.ts), reused here at bench_window/subject_type='window' granularity
 * for the transcript-hygiene workstream, not E-6's own 'probe' granularity. Same JEV_CLINICAL_ROUTE
 * gate as the standalone runner; off answers {ran:false} with zero Jev calls and zero DB reads.
 */
import { JEV_SUBJECT_TYPES } from "@/lib/jev/types";
import { query } from "@/lib/brain/db";
import { submitJob } from "@/lib/jobs/submit";
import { runClinicalRouteAsync } from "@/lib/jev/clinical-route";
import { argInt, argStr, failSafe, type McpTool, type ToolArgs, type ToolContext } from "../registry";

const jevWindowRun: McpTool = {
  name: "scribe_jev_window_run",
  description:
    "INVOKES — submit the jev_window job (Slice J2) for one room-day: reads jev_window_text (J0), batches windows, asks Jev (mock or real per ETA_JEV_MOCK/ETA_JEV_ENABLED), persists jev_window_signal rows. Fails jev_english_missing if J0 has never run for this room-day. Returns { ok, job_id }.",
  scope: "invoke",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string", description: "the room-day to run" },
      force: { type: "boolean", description: "re-run windows already signalled" },
    },
    required: ["room_day_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) =>
    failSafe({ ok: false as boolean }, async () => {
      const roomDayId = argStr(args, "room_day_id", 128);
      if (!roomDayId) return { ok: false, error: "room_day_id_required" };
      const force = args.force === true;
      const job = await submitJob({ kind: "jev_window", args: { room_day_id: roomDayId, force }, actor: ctx.actor, origin: ctx.origin, scopes: ctx.scopes });
      return { ok: true, job_id: job.id };
    }),
};

type SignalRow = {
  window_id: string;
  room_day_id: string;
  session_id: string;
  start_ms: string | number;
  end_ms: string | number;
  phase: string;
  phase_probs: unknown;
  phase_confidence: number;
  p_start: number;
  p_end: number;
  p_clinician: number;
  p_clinical: number;
  model: string;
  prompt_version: string;
};

const jevSignals: McpTool = {
  name: "scribe_jev_signals",
  description:
    "READS — jev_window_signal rows for one room-day: phase, phase probabilities, p_start/p_end/p_clinician/p_clinical, model, prompt_version. Never returns transcript text. Optional from_ms/to_ms narrow by start_ms.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string" },
      from_ms: { type: "number" },
      to_ms: { type: "number" },
    },
    required: ["room_day_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ signals: [] as unknown[] }, async () => {
      const roomDayId = argStr(args, "room_day_id", 128);
      if (!roomDayId) return { ok: false, error: "room_day_id_required", signals: [] };
      const fromMs = typeof args.from_ms === "number" ? args.from_ms : null;
      const toMs = typeof args.to_ms === "number" ? args.to_ms : null;
      const r = await query<SignalRow>(
        `SELECT window_id, room_day_id, session_id, start_ms, end_ms, phase, phase_probs, phase_confidence,
                p_start, p_end, p_clinician, p_clinical, model, prompt_version
           FROM jev_window_signal
          WHERE room_day_id = $1
            AND ($2::bigint IS NULL OR start_ms >= $2)
            AND ($3::bigint IS NULL OR start_ms <= $3)
          ORDER BY start_ms`,
        [roomDayId, fromMs, toMs],
      );
      return {
        ok: true,
        room_day_id: roomDayId,
        signals: r.rows.map((row) => ({ ...row, start_ms: Number(row.start_ms), end_ms: Number(row.end_ms) })),
      };
    }),
};

type DecisionRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  question_id: string;
  prompt_version: string;
  model: string;
  answer: unknown;
  probabilities: unknown;
  confidence: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  created_at: string;
};

const jevDecisions: McpTool = {
  name: "scribe_jev_decisions",
  description:
    "READS — jev_decision rows (migration 116, J-CORE-2): every Jev decision logged through lib/jev/ask.ts, across every use. `answer` is a structured, closed-vocabulary value (noul/choice/score) — never transcript or state text. Filters: subject_type, subject_id, question_id, prompt_version (all optional, ANDed, exact match). limit default 100, max 500, newest first.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      subject_type: { type: "string", enum: [...JEV_SUBJECT_TYPES] },
      subject_id: { type: "string" },
      question_id: { type: "string" },
      prompt_version: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ decisions: [] as unknown[] }, async () => {
      const subjectType = argStr(args, "subject_type", 32);
      const subjectId = argStr(args, "subject_id", 128);
      const questionId = argStr(args, "question_id", 128);
      const promptVersion = argStr(args, "prompt_version", 64);
      const limit = argInt(args, "limit", 100, 1, 500);
      const r = await query<DecisionRow>(
        `SELECT id, subject_type, subject_id, question_id, prompt_version, model, answer, probabilities,
                confidence, latency_ms, input_tokens, created_at
           FROM jev_decision
          WHERE ($1::text IS NULL OR subject_type = $1)
            AND ($2::text IS NULL OR subject_id = $2)
            AND ($3::text IS NULL OR question_id = $3)
            AND ($4::text IS NULL OR prompt_version = $4)
          ORDER BY created_at DESC
          LIMIT $5`,
        [subjectType, subjectId, questionId, promptVersion, limit],
      );
      return { ok: true, decisions: r.rows };
    }),
};

const clinicalRouteReplay: McpTool = {
  name: "scribe_clinical_route_replay",
  description:
    "INVOKES — U6 clinical-or-not routing (order JEV-U6-ROUTE, PLAN-v3 §A) over every bench_window in one room-day with English text (jev_window_text). Classifies each window clinical_consultation / staff_or_admin_talk / phone_call / social_chatter / garbled_or_no_real_speech / cannot_tell, one call per window, stored in jev_decision (subject_type='window'). Same JEV_CLINICAL_ROUTE gate as automatic use: off answers { ran:false } with zero Jev calls. Nothing excluded from notes yet — read + classify + log only. Returns per-category COUNTS only, never window text.",
  scope: "invoke",
  inputSchema: {
    type: "object",
    properties: { room_day_id: { type: "string" } },
    required: ["room_day_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ ran: false as boolean }, async () => {
      const roomDayId = argStr(args, "room_day_id", 128);
      if (!roomDayId) return { ran: false, error: "room_day_id_required" };
      const outcome = await runClinicalRouteAsync(roomDayId);
      return { ok: true, ...outcome };
    }),
};

export const JEV_TOOLS: McpTool[] = [jevWindowRun, jevSignals, jevDecisions, clinicalRouteReplay];
