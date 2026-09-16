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
import { charsPerAudioSecond } from "@/lib/stt/route-run";
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
    failSafe({ routing: [] as unknown[], engines: [] as unknown[], stages: ["live", "note", "room"], buckets: ["english", "indic"] }, async () => {
      // Copied verbatim from app/api/admin/stt-lab/routing/route.ts GET.
      const routing = (await sql`SELECT stage, language_bucket, engine_id, updated_at FROM stt_routing ORDER BY stage, language_bucket`) as unknown[];
      const engines = (await sql`SELECT id, display_name, enabled, capabilities_json FROM stt_engine ORDER BY sort_order, id`) as unknown[];
      return { routing, engines, stages: ["live", "note", "room"], buckets: ["english", "indic"] };
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
        // C3 — the subject block is ALWAYS present, but it must not become a BACK DOOR onto the
        // patient label. subjectLabel() prefers patient_label_raw for an encounter, so without
        // include_identity the label is built WITHOUT it and falls back to the id. Caught by
        // R5: the first version leaked the label into `subject.label` on an un-identified call.
        const { patient_label_raw, ...rest } = r;
        const subject = subjectOf({ ...(r as SubjectRowish), patient_label_raw: includeIdentity ? patient_label_raw : undefined });
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
        // Same gate as the list: the label must not smuggle the patient label past
        // include_identity. A room window has no patient label to gate in the first place.
        patient_label_raw: includeIdentity ? patient_label_raw : undefined,
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


/**
 * Slice C1 step 4 — THE FOUR TRIPWIRES.
 *
 * This slice switches the room engine on a PRIOR, not on a comparison: an English-only model on
 * code-mixed OPD speech is wrong by construction, and the Indic gold corpus that would settle it
 * empirically does not exist (stt_gold: 3 rows, 0 Indic) and cannot be built by writing code.
 * Shipping on a prior is only defensible if the prior is cheap to DISPROVE, so these four signals
 * exist to find out — within a day — whether the switch was inert or harmful. None of them needs
 * ground truth:
 *
 *  1. ENGINE MIX, per span. If spans are overwhelmingly `whisper`, the router is picking the same
 *     engine we already had and the switch is INERT. That is the cheapest possible refutation.
 *  2. LANGUAGE MIX, per span. The first real measurement of how much non-English is actually
 *     spoken in these rooms. If it is ~all `en`, the premise of the whole slice is wrong.
 *  3. EMPTY-TRANSCRIPT RATE. A regression against the history already in the table: the same
 *     measure is computable for the engine that ran before, so the comparison is free.
 *  4. CHARACTERS PER AUDIO-SECOND. A crude yield. Nobody knows the right value, but a sharp drop
 *     against the previous engine is a red flag that needs no reference text.
 *
 * It reports per ENGINE, side by side, because every one of these is only meaningful as a
 * before-and-after — a number for `route` alone answers nothing.
 */
const routeTripwires: McpTool = {
  name: "scribe_route_tripwires",
  description:
    "The four Slice C1 tripwires for the room-engine switch, per engine, side by side: per-span engine mix, per-span language mix, empty-transcript rate, and characters per audio-second. Room windows only (transcription_run subject_type='bench_window', mode='batch', tier='asr'). The mixes come from metrics_json.language_timeline, which only the `route` engine writes, so they are null for every other engine — that is the point: the yield and empty-rate columns ARE comparable across engines and are how you tell a harmful switch from an inert one. Counts and rates only; no transcript text, no patient label. Pass days to widen the window (default 7).",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "integer", minimum: 1, maximum: 90, default: 7 },
      engine: { type: "string", description: "restrict to one engine id" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ days: 7, engines: [] as unknown[] }, async () => {
      const days = argInt(args, "days", 7, 1, 90);
      const engine = argStr(args, "engine");

      // Per engine, over room windows only. `chars` is measured on the stored transcript rather
      // than on the timeline, so the yield column means the same thing for an engine that writes
      // no timeline — otherwise the one number meant to be comparable would not be.
      //
      // audio_seconds is read out of metrics_json, where the room drain has always written it.
      const rows = (await sql`
        SELECT tr.engine,
               COUNT(*)::int AS runs,
               COUNT(*) FILTER (WHERE tr.error IS NOT NULL)::int AS errors,
               COUNT(*) FILTER (WHERE tr.error IS NULL
                                  AND COALESCE(length(COALESCE(tr.transcript_original, tr.transcript_english, '')), 0) = 0)::int AS empty_runs,
               SUM(COALESCE(length(COALESCE(tr.transcript_original, tr.transcript_english, '')), 0))::bigint AS chars,
               SUM(COALESCE((tr.metrics_json->>'audio_seconds')::float8, 0))::float8 AS audio_seconds,
               COUNT(*) FILTER (WHERE tr.metrics_json ? 'language_timeline')::int AS runs_with_timeline
          FROM transcription_run tr
         WHERE tr.subject_type = 'bench_window'
           AND tr.mode = 'batch' AND tr.tier = 'asr'
           AND tr.created_at >= NOW() - ((${days})::int || ' days')::interval
           AND (${engine ?? null}::text IS NULL OR tr.engine = ${engine ?? null})
         GROUP BY tr.engine
         ORDER BY tr.engine
      `) as Array<{ engine: string; runs: number; errors: number; empty_runs: number; chars: string | number; audio_seconds: number | null; runs_with_timeline: number }>;

      // The two per-span mixes. Precomputed at write time into the same key, so this sums small
      // objects instead of unnesting every span of every run in the window.
      const mixes = (await sql`
        SELECT tr.engine,
               COALESCE(SUM((tr.metrics_json->'language_timeline'->>'span_count')::int), 0)::int AS spans,
               jsonb_object_agg(k.key, k.total) FILTER (WHERE k.key IS NOT NULL) AS engine_mix
          FROM transcription_run tr
          LEFT JOIN LATERAL (
                 SELECT e.key, SUM(e.value::int)::int AS total
                   FROM jsonb_each_text(COALESCE(tr.metrics_json->'language_timeline'->'engine_mix', '{}'::jsonb)) e
                  GROUP BY e.key
               ) k ON TRUE
         WHERE tr.subject_type = 'bench_window'
           AND tr.mode = 'batch' AND tr.tier = 'asr'
           AND tr.metrics_json ? 'language_timeline'
           AND tr.created_at >= NOW() - ((${days})::int || ' days')::interval
           AND (${engine ?? null}::text IS NULL OR tr.engine = ${engine ?? null})
         GROUP BY tr.engine
      `) as Array<{ engine: string; spans: number; engine_mix: Record<string, number> | null }>;

      const langMixes = (await sql`
        SELECT tr.engine,
               jsonb_object_agg(k.key, k.total) FILTER (WHERE k.key IS NOT NULL) AS language_mix
          FROM transcription_run tr
          LEFT JOIN LATERAL (
                 SELECT e.key, SUM(e.value::int)::int AS total
                   FROM jsonb_each_text(COALESCE(tr.metrics_json->'language_timeline'->'language_mix', '{}'::jsonb)) e
                  GROUP BY e.key
               ) k ON TRUE
         WHERE tr.subject_type = 'bench_window'
           AND tr.mode = 'batch' AND tr.tier = 'asr'
           AND tr.metrics_json ? 'language_timeline'
           AND tr.created_at >= NOW() - ((${days})::int || ' days')::interval
           AND (${engine ?? null}::text IS NULL OR tr.engine = ${engine ?? null})
         GROUP BY tr.engine
      `) as Array<{ engine: string; language_mix: Record<string, number> | null }>;

      const spanBy = new Map(mixes.map((m) => [m.engine, m]));
      const langBy = new Map(langMixes.map((m) => [m.engine, m.language_mix]));

      return {
        days,
        engines: rows.map((r) => {
          const chars = Number(r.chars ?? 0);
          const secs = Number(r.audio_seconds ?? 0);
          const scored = r.runs - r.errors;
          const m = spanBy.get(r.engine);
          return {
            engine: r.engine,
            runs: r.runs,
            errors: r.errors,
            // TRIPWIRE 3. Over runs that did not error — an engine that is DOWN is a different
            // fault from an engine that is UP and hearing nothing, and averaging them together
            // is how an outage reads as a quiet room.
            empty_transcript_rate: scored > 0 ? Math.round((r.empty_runs / scored) * 1000) / 1000 : null,
            empty_runs: r.empty_runs,
            // TRIPWIRE 4. Null, not zero, when there is no audio to divide by.
            chars_per_audio_second: charsPerAudioSecond(chars, secs > 0 ? secs : null),
            chars,
            audio_seconds: Math.round(secs * 10) / 10,
            runs_with_timeline: r.runs_with_timeline,
            // TRIPWIRES 1 and 2. Null for an engine that writes no timeline, which is every engine
            // but `route` — stated in the description so a null is never read as "zero spans".
            spans: m?.spans ?? null,
            engine_mix: m?.engine_mix ?? null,
            language_mix: langBy.get(r.engine) ?? null,
          };
        }),
      };
    }),
};


/**
 * C2 item 4 — THE FIRST READER `room_turn_speaker` HAS EVER HAD.
 *
 * The table was created by migration 0074 and has exactly one writer, behind two env gates that
 * have never been on; nothing in app/ or lib/ has ever read it. So this tool is not "another view"
 * — it is the first time speaker attribution is answerable at all.
 *
 * WHAT IT WILL NOT DO. It returns no transcript text: a span is a timing and a speaker, and joining
 * it to the words would turn a diagnostic into a transcript with names attached. And it reports a
 * clinician ONLY where one was matched against an enrolled voiceprint — `role: "unattributed"`
 * means "we do not know", never "someone else". A reader that wants to guess from speaker_idx has
 * the index and can do so knowingly; this tool will not do it for them.
 */
const roomTurnSpeakers: McpTool = {
  name: "scribe_window_speakers",
  description:
    "Speaker spans for a room window (room_turn_speaker): per bound turn, its speaker_idx, overlap_ms, and — ONLY where the diarize service matched an enrolled voiceprint — clinician_id, role and match_confidence. role is 'clinician' or 'unattributed'; unattributed means the voice was not identified, NOT that it was someone else. speaker_idx is the service's cluster order (sorted by total speaking time), so it is NOT a role and must not be read as one. No transcript text. Pass window_id, or room_day_id for a whole day.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      window_id: { type: "string" },
      room_day_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ spans: [] as unknown[], summary: {} }, async () => {
      const windowId = argStr(args, "window_id", 64);
      const roomDayId = argStr(args, "room_day_id", 64);
      const limit = argInt(args, "limit", 200, 1, 500);
      if (!windowId && !roomDayId) return { error: "window_id or room_day_id is required", spans: [], summary: {} };

      const spans = (await sql`
        SELECT window_id, source_ref, speaker_idx, overlap_ms, room_day_id,
               clinician_id, role, match_confidence, created_at
          FROM room_turn_speaker
         WHERE (${windowId ?? null}::text IS NULL OR window_id = ${windowId ?? null})
           AND (${roomDayId ?? null}::text IS NULL OR room_day_id = ${roomDayId ?? null})
         ORDER BY window_id, source_ref
         LIMIT ${limit}
      `) as Array<{ speaker_idx: number; role: string | null; clinician_id: string | null }>;

      // The summary answers the question the table exists for: how much of this is attributed?
      const attributed = spans.filter((r) => r.role === "clinician").length;
      const byClinician: Record<string, number> = {};
      for (const r of spans) if (r.clinician_id) byClinician[r.clinician_id] = (byClinician[r.clinician_id] ?? 0) + 1;
      return {
        spans,
        summary: {
          turns: spans.length,
          attributed_turns: attributed,
          unattributed_turns: spans.length - attributed,
          attribution_rate: spans.length ? Math.round((attributed / spans.length) * 1000) / 1000 : null,
          by_clinician: byClinician,
          distinct_speaker_idx: new Set(spans.map((r) => r.speaker_idx)).size,
        },
      };
    }),
};

/**
 * E18 R31 — THE OPERATOR SURFACE FOR THE SILENT BACKLOG.
 *
 * WHY A DRY RUN IS THE DEFAULT, AND NOT A FLAG THAT DEFAULTS TO TRUE. An empty room and a dead mic produce the
 * same row, and the third shape — no level at all — is the real production shape. A bulk operation over a
 * population we have just admitted we cannot classify is exactly the thing that must be previewable. So the
 * default call answers "here is what I would re-adjudicate" and writes nothing; `apply: true` is an argument the
 * caller must pass, and it is refused without a detector name and a reason.
 *
 * WHY IT IS OPERATOR-INVOKED AND NEVER AUTOMATIC. Nothing schedules this. No cron reaches it, the auto-drain does
 * not call it, and applying 0101 does not trigger it. Re-adjudicating a verdict is a deliberate act by a person
 * who has read the preview.
 *
 * WHAT IT DOES NOT DO. It invokes no classifier, because none exists: E13 (dead-mic detection) and E15 (VAD
 * calibration) are both open. It moves a named population back into the queue and records WHICH detector the
 * caller says will re-read it, so a later pass with a better one is distinguishable from this one.
 */
const silenceReadjudicate: McpTool = {
  name: "scribe_silence_readjudicate",
  description:
    "The silent-window backlog (E18): what a bulk re-adjudication WOULD re-run, and — only with apply:true — the re-run itself. " +
    "DRY RUN BY DEFAULT: the plain call writes nothing and returns what THIS call would move (would.windows, the same limit apply uses), " +
    "how many match the filter altogether (eligible.total), the span each covers, how many rooms it touches, " +
    "and the distribution of the evidence those verdicts hold (audio level present vs absent, VAD parameters reported vs not, verdict, engine). " +
    "apply:true moves that population back to 'closed' for the drain to read again, and REQUIRES detector and reason; unscoped apply also requires all_rooms:true. " +
    "Scope it with room_id, room_day_id, from_ms/to_ms. It classifies nothing: no dead-mic detector and no VAD calibration exist yet (E13, E15).",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string", maxLength: 64, description: "one room; omit for every room" },
      room_day_id: { type: "string", maxLength: 64 },
      from_ms: { type: "integer", minimum: 0, description: "window start at or after this epoch ms" },
      to_ms: { type: "integer", minimum: 0, description: "window start before this epoch ms" },
      include_reopened: { type: "boolean", default: false, description: "windows already handed back once" },
      limit: { type: "integer", minimum: 1, maximum: 1000, default: 100, description: "caps how many windows apply moves" },
      apply: { type: "boolean", description: "DO IT. Omit for the dry run, which is the default and writes nothing." },
      detector: { type: "string", maxLength: 64, description: "required with apply: which detector will re-read this set" },
      reason: { type: "string", maxLength: 300, description: "required with apply: why this set is being re-run" },
      batch: { type: "string", maxLength: 64, description: "names the batch; generated from the detector and the time when omitted" },
      all_rooms: { type: "boolean", description: "required with apply when no room, day or time bound is given" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ ok: false, dry_run: true }, async () => {
      const { previewSilenceReadjudication, reopenSilentWindows, DETECTOR_NAME } = await import("@/lib/stt/silence");
      const roomId = argStr(args, "room_id", 64) || null;
      const roomDayId = argStr(args, "room_day_id", 64) || null;
      const fromMs = args.from_ms === undefined || args.from_ms === null ? null : argInt(args, "from_ms", 0, 0, Number.MAX_SAFE_INTEGER);
      const toMs = args.to_ms === undefined || args.to_ms === null ? null : argInt(args, "to_ms", 0, 0, Number.MAX_SAFE_INTEGER);
      const includeReopened = argBool(args, "include_reopened");
      const limit = argInt(args, "limit", 100, 1, 1000);
      const filter = { roomId, roomDayId, fromMs, toMs, includeReopened, limit };
      const scope = { room_id: roomId, room_day_id: roomDayId, from_ms: fromMs, to_ms: toMs, include_reopened: includeReopened, limit };
      const would = await previewSilenceReadjudication(filter);

      if (!argBool(args, "apply")) return { ok: true, dry_run: true, scope, would };

      // From here on it writes, so every refusal happens BEFORE the first row moves.
      const detector = argStr(args, "detector", 64);
      const reason = argStr(args, "reason", 300);
      if (!detector) return { ok: false, dry_run: false, error: "detector_required", detail: "apply names which detector will re-read this set" };
      if (!reason) return { ok: false, dry_run: false, error: "reason_required", detail: "apply names why this set is being re-run" };
      // The detector is an identity later passes are compared against, so it must be matchable exactly.
      if (!DETECTOR_NAME.test(detector)) {
        return { ok: false, dry_run: false, error: "detector_name_invalid", detail: "letters, digits and . _ : - only, 1-64 characters, starting with a letter or digit" };
      }
      const bounded = Boolean(roomId || roomDayId || fromMs !== null || toMs !== null);
      if (!bounded && !argBool(args, "all_rooms")) {
        return { ok: false, dry_run: false, error: "unscoped_apply_needs_all_rooms", detail: "scope by room, day or time, or pass all_rooms:true to mean every room", would };
      }
      const batch = argStr(args, "batch", 64) || `readjudicate_${detector}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const done = await reopenSilentWindows({ ...filter, batch, reason, detector });
      // `would` was taken BEFORE the move, so it is what this call said it would do; `remaining` is what the
      // next call would still find. Both, because "100 moved" alone does not say whether the job is finished.
      const remaining = await previewSilenceReadjudication(filter);
      return {
        ok: true, dry_run: false, scope, batch: done.batch, detector: done.detector,
        reopened: done.reopened, window_ids: done.window_ids.slice(0, 50),
        would, remaining_eligible: remaining.eligible.total,
      };
    }),
};

export const STT_TOOLS: McpTool[] = [listSttEngines, sttHealth, sttRouting, listSttRuns, getSttRun, routeTripwires, roomTurnSpeakers, silenceReadjudicate];
