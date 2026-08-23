/**
 * lib/mcp/tools/stt.ts — STT read tools (Operator MCP S1, PRD §12 11.4).
 *
 * Reuses the STT-lab route logic in-process: registry (`lib/stt/registry` listEngines /
 * adapterFor + adapter.health) and the runs queries copied VERBATIM from
 * app/api/admin/stt-lab/runs/route.ts and runs/[id]/route.ts. No cookie, no HTTP hop.
 * Read-only. Transcript text of runs is returned only with include_text=true.
 */

import { sql } from "@/lib/db";
import { listEngines, adapterFor } from "@/lib/stt/registry";
import { subjectOf, type SubjectRowish } from "@/lib/stt/subject";
import { failSafe, argBool, argInt, argStr, type McpTool, type ToolArgs } from "../registry";

export type EngineHealth = {
  id: string;
  display_name: string;
  adapter_key: string;
  enabled: boolean;
  fanout_enabled: boolean;
  is_paid: boolean;
  cost_per_min_usd: number | null;
  capabilities: unknown;
  has_adapter: boolean;
  virtual: boolean;
  health: { ok: boolean; latencyMs: number; error?: string };
};

/** Same logic as GET /api/admin/stt-lab/health (virtual engines skip; adapter.health()). */
export async function probeSttEngines(): Promise<EngineHealth[]> {
  const engines = await listEngines();
  return Promise.all(
    engines.map(async (e) => {
      const adapter = adapterFor(e.adapter_key);
      const cfg = (e.config_json ?? {}) as Record<string, unknown>;
      const virtual = cfg.virtual === true;
      let health: { ok: boolean; latencyMs: number; error?: string };
      if (virtual) {
        health = { ok: true, latencyMs: 0 };
      } else if (!adapter) {
        health = { ok: false, latencyMs: 0, error: "no_adapter_registered" };
      } else {
        try {
          health = await adapter.health();
        } catch (err) {
          health = { ok: false, latencyMs: 0, error: String(err).slice(0, 120) };
        }
      }
      return {
        id: e.id,
        display_name: e.display_name,
        adapter_key: e.adapter_key,
        enabled: e.enabled,
        fanout_enabled: e.fanout_enabled,
        is_paid: e.is_paid,
        cost_per_min_usd: e.cost_per_min_usd,
        capabilities: e.capabilities_json,
        has_adapter: !!adapter,
        virtual,
        health,
      };
    }),
  );
}

const listSttEngines: McpTool = {
  name: "scribe_list_stt_engines",
  description: "STT engine registry (stt_engine): id, display name, adapter, enabled/fanout flags, cost, capabilities. Same data as GET /api/admin/stt-lab/engines. Read-only.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () =>
    failSafe({ engines: [] as unknown[] }, async () => {
      // Copied verbatim from app/api/admin/stt-lab/engines/route.ts GET.
      const engines = (await sql`
        SELECT id, display_name, adapter_key, capabilities_json, enabled, fanout_enabled, is_paid, cost_per_min_usd, sort_order
          FROM stt_engine ORDER BY sort_order ASC, id ASC
      `) as unknown[];
      return { engines };
    }),
};

const sttHealth: McpTool = {
  name: "scribe_stt_health",
  description: "Probe every registered STT engine through its adapter (Deepgram, Sarvam, Whisper, IndicConformer, ElevenLabs, EkaScribe; virtual engines skip). Same as GET /api/admin/stt-lab/health.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () =>
    failSafe({ engines: [] as EngineHealth[], checked_at: new Date().toISOString() }, async () => ({
      engines: await probeSttEngines(),
      checked_at: new Date().toISOString(),
    })),
};

const sttRouting: McpTool = {
  name: "scribe_stt_routing",
  description: "STT routing matrix: stage (live|note) × language bucket (english|indic) → engine_id (stt_routing) plus the engine list. Same as GET /api/admin/stt-lab/routing.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () =>
    failSafe({ routing: [] as unknown[], engines: [] as unknown[], stages: ["live", "note"], buckets: ["english", "indic"] }, async () => {
      // Copied verbatim from app/api/admin/stt-lab/routing/route.ts GET.
      const routing = (await sql`SELECT stage, language_bucket, engine_id, updated_at FROM stt_routing ORDER BY stage, language_bucket`) as unknown[];
      const engines = (await sql`SELECT id, display_name, enabled, capabilities_json FROM stt_engine ORDER BY sort_order, id`) as unknown[];
      return { routing, engines, stages: ["live", "note"], buckets: ["english", "indic"] };
    }),
};

const listSttRuns: McpTool = {
  name: "scribe_list_stt_runs",
  description: "SUBJECTS that have batch ASR runs (transcription_run mode=batch tier=asr): per-subject engine count, errors, winner, gold flag, avg judge. Same as GET /api/admin/stt-lab/runs. K4a: a run's subject is (subject_type, subject_id) and may be an ENCOUNTER or a bench_window ROOM WINDOW, so every row carries `subject` { type, id, kind_label, label } and the encounter-only fields (patient_label_raw, detected_language, note_type, recorded_at) are NULL on a room window rather than absent. Gold is encounter-only by construction, so has_gold is always false for a window. patient_label only with include_identity=true.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      include_identity: { type: "boolean", default: false, description: "include patient_label_raw" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ runs: [] as unknown[] }, async () => {
      const limit = argInt(args, "limit", 50, 1, 200);
      const includeIdentity = argBool(args, "include_identity");
      // Still the same query as app/api/admin/stt-lab/runs/route.ts GET — subject-driven,
      // LEFT JOINing outwards so a run with no encounter appears rather than vanishing.
      const rows = (await sql`
        SELECT tr.subject_type, tr.subject_id, tr.subject_id AS id,
               e.patient_label_raw, e.recorded_at, e.detected_language, e.note_type,
               bw.start_ms AS window_start_ms, bw.end_ms AS window_end_ms,
               bw.source_mic AS window_source_mic, bw.session_id AS window_session_id,
               COUNT(DISTINCT tr.engine)::int AS engines,
               COUNT(*) FILTER (WHERE tr.error IS NOT NULL)::int AS errored,
               (SELECT w.engine FROM transcription_run w
                 WHERE w.subject_type = tr.subject_type AND w.subject_id = tr.subject_id
                   AND w.mode='batch' AND w.tier='asr' AND w.is_winner LIMIT 1) AS winner,
               (tr.subject_type = 'encounter'
                 AND EXISTS(SELECT 1 FROM stt_gold g WHERE g.encounter_id = tr.subject_id)) AS has_gold,
               ROUND(AVG(tr.judge_score)::numeric, 2)::float8 AS avg_judge
          FROM transcription_run tr
          LEFT JOIN encounter e ON e.id = tr.encounter_id
          LEFT JOIN bench_window bw ON tr.subject_type = 'bench_window' AND bw.id = tr.subject_id
         WHERE tr.mode='batch' AND tr.tier='asr'
         GROUP BY tr.subject_type, tr.subject_id, e.patient_label_raw, e.recorded_at,
                  e.detected_language, e.note_type, bw.start_ms, bw.end_ms, bw.source_mic, bw.session_id
         ORDER BY COALESCE(e.recorded_at, to_timestamp(bw.start_ms / 1000.0)) DESC NULLS LAST
         LIMIT ${limit}
      `) as Array<Record<string, unknown>>;
      const runs = rows.map((r) => {
        // C3 — the subject block is ALWAYS present; include_identity governs only the patient
        // label, exactly as before. A room window has no patient label to govern.
        const subject = subjectOf(r as SubjectRowish);
        const { patient_label_raw, ...rest } = r;
        return includeIdentity ? { ...rest, subject, patient_label_raw } : { ...rest, subject };
      });
      return { runs };
    }),
};

const getSttRun: McpTool = {
  name: "scribe_get_stt_run",
  description: "One SUBJECT's per-engine batch runs + scores + gold reference (transcription_run / stt_gold). Same as GET /api/admin/stt-lab/runs/{id}. K4a: takes `subject_id` — an enc_… id or a bench_window id — and answers with `subject` { type, id, kind_label, label }. `encounter` is NULL for a room window and `window` carries its span and microphone instead; gold is encounter-only, so a window's is always null. `encounter_id` is still accepted as an alias so existing callers keep working. Transcript / note / gold TEXT only with include_text=true; patient_label only with include_identity=true.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      subject_id: { type: "string", description: "enc_… id, or a bench_window id" },
      encounter_id: { type: "string", description: "alias for subject_id, kept so existing callers work" },
      include_text: { type: "boolean", default: false },
      include_identity: { type: "boolean", default: false },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ encounter: null as unknown, runs: [] as unknown[], gold: null as unknown }, async () => {
      const id = argStr(args, "subject_id") ?? argStr(args, "encounter_id");
      if (!id) return { encounter: null, runs: [], gold: null, error: "subject_id_required" };
      const includeText = argBool(args, "include_text");
      const includeIdentity = argBool(args, "include_identity");
      // Same shape as app/api/admin/stt-lab/runs/[id]/route.ts GET: ask the runs what kind of
      // subject this is, then LEFT JOIN outwards. Neither lookup is required to hit.
      const kindRows = (await sql`SELECT DISTINCT subject_type FROM transcription_run WHERE subject_id = ${id} LIMIT 2`) as Array<{ subject_type: string }>;
      const subjectType = kindRows[0]?.subject_type ?? (id.startsWith("enc_") ? "encounter" : "bench_window");
      const enc = (await sql`SELECT id, patient_label_raw, recorded_at, detected_language, note_type FROM encounter WHERE id = ${id} LIMIT 1`) as Array<Record<string, unknown>>;
      const win = (await sql`SELECT id, session_id, start_ms, end_ms, source_mic, state FROM bench_window WHERE id = ${id} LIMIT 1`) as Array<Record<string, unknown>>;
      if (!enc[0] && !win[0] && kindRows.length === 0) return { encounter: null, runs: [], gold: null, error: "subject_not_found" };
      const runs = (await sql`
        SELECT engine, tier, transcript_english, transcript_original, note_text, latency_ms, error,
               judge_score, agreement_score, wer, cer, med_term_recall, is_winner, metrics_json
          FROM transcription_run
         WHERE subject_id = ${id} AND mode='batch'
         ORDER BY tier, is_winner DESC, engine
      `) as Array<Record<string, unknown>>;
      const gold = (await sql`SELECT reference_original, reference_english, reference_language, critical_terms_json, terms_model FROM stt_gold WHERE encounter_id = ${id} LIMIT 1`) as Array<Record<string, unknown>>;
      const { patient_label_raw, ...encRest } = enc[0] ?? ({} as Record<string, unknown>);
      const subject = subjectOf({
        subject_type: subjectType,
        subject_id: id,
        patient_label_raw,
        window_start_ms: win[0]?.start_ms,
        window_end_ms: win[0]?.end_ms,
        window_source_mic: win[0]?.source_mic,
        window_session_id: win[0]?.session_id,
      });
      const strip = (r: Record<string, unknown>) => {
        const { transcript_english, transcript_original, note_text, ...rest } = r;
        return {
          ...rest,
          transcript_english_chars: typeof transcript_english === "string" ? transcript_english.length : null,
          transcript_original_chars: typeof transcript_original === "string" ? transcript_original.length : null,
          note_text_chars: typeof note_text === "string" ? note_text.length : null,
        };
      };
      const g = gold[0] ?? null;
      const goldOut = !g
        ? null
        : includeText
          ? g
          : { reference_language: g.reference_language, terms_model: g.terms_model, has_reference: !!(g.reference_original || g.reference_english) };
      return {
        subject,
        // NULL for a room window — never an empty object pretending to be an encounter.
        encounter: enc[0] ? (includeIdentity ? enc[0] : encRest) : null,
        window: win[0] ?? null,
        runs: includeText ? runs : runs.map(strip),
        gold: goldOut,
      };
    }),
};

export const STT_TOOLS: McpTool[] = [listSttEngines, sttHealth, sttRouting, listSttRuns, getSttRun];
