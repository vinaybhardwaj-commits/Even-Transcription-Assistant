/**
 * lib/mcp/tools/voice.ts — voice / Pyannote read tools (Operator MCP S1, PRD §12 11.5).
 *
 * scribe_voice_health        — the Pyannote probe alone (Mini GET /health, 5s, soft-fail).
 * scribe_list_voiceprints    — voice_print LEFT JOIN clinician, every row: clinician id, name, status,
 *                              deleted, matchable, sample count, enrolled/last sample times,
 *                              needs_reenrollment. NO centroid / embeddings. Unfiltered on purpose.
 * scribe_list_voice_samples  — lib/voice-samples listSamples for one clinician: id, created_at,
 *                              source, duration, included, has_audio. Presigned audio URLs
 *                              (voice-samples/ prefix, 1 h) ONLY with include_urls=true.
 * scribe_get_clusters        — speaker_cluster for a room-day via the brain pool
 *                              (SQL_CLUSTERS_FOR_DAY): id, kind, first/last_seen, has_centroid.
 *                              No vectors. (Nothing writes this table yet — usually empty.)
 * No thresholds are published here; the phone-path identify constant is not a room-path number.
 */

import { sql } from "@/lib/db";
import { query } from "@/lib/brain/db";
import { findRoomDay, roomExists, readClustersForDay, CLUSTERING_STATUS } from "@/lib/brain/state";
import { listSamples } from "@/lib/voice-samples";
import { signGetUrl } from "@/lib/r2";
import { argBool, argInt, argStr, failSafe, type McpTool, type ToolArgs } from "../registry";
import { readLatestRun, readRun } from "@/lib/encounter-hypotheses";
import { runShadowForRoomDay } from "@/lib/encounter-clock/shadow-io";
import { lookupSegments, SESSION_WINDOW_LIMIT_DEFAULT, SESSION_WINDOW_LIMIT_MAX } from "@/lib/diarize-segments";
import { probePyannote } from "./health";
import { pickIstDate, resolveRoom } from "./brain";

const PRESIGN_SECONDS = 3600;

const voiceHealth: McpTool = {
  name: "scribe_voice_health",
  description: "Pyannote / ECAPA Mini service probe: GET {DIARIZE_BASE_URL}/health (5s timeout, soft-fail).",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => probePyannote(),
};

const listVoiceprints: McpTool = {
  name: "scribe_list_voiceprints",
  description: "ALL clinician voiceprints (voice_print LEFT JOIN clinician), disabled and deleted included: clinician_id, name, clinician_status (active|disabled|locked, null when no clinician row), deleted, matchable, sample_count, enrolled_at, last_sample_at, needs_reenrollment. `matchable` is what room matching and encounter diarization actually offer (active, not deleted, has a centroid); `summary.matchable` is that count, `summary.total` is every row here. No embeddings.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  // DELIBERATELY UNFILTERED. The readers that offer a voice for matching filter to active clinicians
  // (lib/stt/diarize-window.ts, the encounter process route, voice/identify). This operator view
  // shows every row so a disabled doctor's voiceprint is visible — and says, per row and in the
  // summary, which rows the matchers would skip, so the two views can never be mistaken for each
  // other by their counts.
  handler: async () =>
    failSafe({ voiceprints: [] as unknown[], summary: { total: 0, matchable: 0 } }, async () => {
      const rows = (await sql`
        SELECT vp.doctor_id AS clinician_id, c.full_name, c.url_slug, vp.sample_count, vp.enrolled_at,
               vp.last_sample_at, vp.needs_reenrollment, (vp.centroid IS NOT NULL) AS has_centroid,
               c.status::text AS clinician_status, (c.deleted_at IS NOT NULL) AS deleted,
               (c.id IS NOT NULL AND c.status = 'active' AND c.deleted_at IS NULL AND vp.centroid IS NOT NULL) AS matchable
          FROM voice_print vp
          LEFT JOIN clinician c ON c.id = vp.doctor_id
         ORDER BY vp.last_sample_at DESC
      `) as Array<{ clinician_id: string; full_name: string | null; url_slug: string | null; sample_count: number; enrolled_at: string | Date; last_sample_at: string | Date; needs_reenrollment: boolean; has_centroid: boolean; clinician_status: string | null; deleted: boolean; matchable: boolean }>;
      return {
        summary: { total: rows.length, matchable: rows.filter((r) => r.matchable === true).length },
        voiceprints: rows.map((r) => ({
          clinician_id: r.clinician_id,
          name: r.full_name,
          url_slug: r.url_slug,
          clinician_status: r.clinician_status,
          deleted: r.deleted === true,
          matchable: r.matchable === true,
          sample_count: r.sample_count,
          enrolled_at: new Date(r.enrolled_at).toISOString(),
          updated_at: new Date(r.last_sample_at).toISOString(),
          needs_reenrollment: r.needs_reenrollment,
          has_centroid: r.has_centroid,
        })),
      };
    }),
};

const listVoiceSamples: McpTool = {
  name: "scribe_list_voice_samples",
  description: "Voice samples for one clinician (voice_sample): id, created_at, source (enrollment|passive), duration_ms, included, has_audio, source_encounter_id. Presigned audio URLs (1 h) only with include_urls=true.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      clinician_id: { type: "string" },
      include_urls: { type: "boolean", default: false },
    },
    required: ["clinician_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ samples: [] as unknown[] }, async () => {
      const clinicianId = argStr(args, "clinician_id", 128);
      if (!clinicianId) return { samples: [], error: "clinician_id_required" };
      const includeUrls = argBool(args, "include_urls");
      const rows = await listSamples(clinicianId);
      const samples = await Promise.all(
        rows.map(async (s) => {
          const base = {
            id: s.id,
            created_at: s.created_at,
            source: s.source,
            duration_ms: s.duration_ms,
            content_type: s.content_type,
            included: s.included,
            has_audio: s.has_audio,
            source_encounter_id: s.source_encounter_id,
            session_id: s.session_id,
            sample_index: s.sample_index,
            match_confidence: s.match_confidence,
          };
          if (!includeUrls || !s.audio_r2_key) return base;
          let url: string | null = null;
          try {
            url = await signGetUrl({ key: s.audio_r2_key, expiresInSeconds: PRESIGN_SECONDS, contentType: s.content_type ?? undefined });
          } catch {
            url = null;
          }
          return { ...base, audio_r2_key: s.audio_r2_key, presigned_get: url, expires_in_seconds: url ? PRESIGN_SECONDS : null };
        }),
      );
      return { clinician_id: clinicianId, samples };
    }),
};

type ClusterRow = { id: string; kind: string; visit_id: string | null; first_seen_at: Date; last_seen_at: Date; has_centroid: boolean };

const getClusters: McpTool = {
  name: "scribe_get_clusters",
  description: "Same-day speaker clusters for a room-day: id, kind (doctor|other), visit_id, first_seen_at, last_seen_at, has_centroid. No vectors. ALWAYS read `clustering` first: while clustering is not running (running:false, reason clustering_not_running) `clusters` is empty BY DESIGN and means nothing about who spoke — it is not 'clustering ran and found nobody'.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string" },
      room_slug: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata); default today" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ clusters: [] as unknown[] }, async () => {
      const room = await resolveRoom(args);
      if (!room) return { clusters: [], error: "unknown_room" };
      const d = pickIstDate(args);
      if ("error" in d) return { clusters: [], error: d.error };
      if (!(await roomExists(room.id))) return { clusters: [], error: "unknown_room" };
      const day = await findRoomDay(room.id, d.date);
      if (!day) return { room_id: room.id, room_day_id: null, ist_date: d.date, clustering: CLUSTERING_STATUS, clusters: [] };
      const r = readClustersForDay(day.id);
      return {
        room_id: room.id,
        room_day_id: day.id,
        ist_date: d.date,
        clustering: r.clustering,
        clusters: (r.clusters as ClusterRow[]).map((c) => ({
          id: c.id,
          kind: c.kind,
          visit_id: c.visit_id,
          first_seen_at: new Date(c.first_seen_at).toISOString(),
          last_seen_at: new Date(c.last_seen_at).toISOString(),
          has_centroid: c.has_centroid,
        })),
      };
    }),
};

const diarizeSegments: McpTool = {
  name: "scribe_diarize_segments",
  description:
    "Speaker timings WITHOUT text for one phone encounter (encounter_id), one room window (window_id) or one bench session's diarized windows (session_id, limit): [{start_ms, end_ms, speaker_idx, speaker_label S0/S1…, source, overlap, confidence?}] plus per-speaker total_speech_ms and, only where the diarize service matched a voiceprint, matched_clinician_id. Labels are neutral indices, never roles or names. Same payload as GET /api/diarize-segments.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      encounter_id: { type: "string", description: "enc_… id" },
      window_id: { type: "string", description: "bw_… id" },
      session_id: { type: "string", description: "bs_… id" },
      limit: { type: "integer", minimum: 1, maximum: SESSION_WINDOW_LIMIT_MAX, default: SESSION_WINDOW_LIMIT_DEFAULT },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ segments: null as unknown }, async () => {
      const r = await lookupSegments({
        encounter_id: argStr(args, "encounter_id", 64),
        window_id: argStr(args, "window_id", 64),
        session_id: argStr(args, "session_id", 64),
        limit: argInt(args, "limit", SESSION_WINDOW_LIMIT_DEFAULT, 1, SESSION_WINDOW_LIMIT_MAX),
      });
      return r.ok ? { segments: r.payload } : { segments: null, error: r.error };
    }),
};

const encounterHypotheses: McpTool = {
  name: "scribe_encounter_hypotheses",
  description:
    "Encounter-clock hypotheses (E-5 store, 0114) for a room-day: the LATEST smoother run (versions, probe counts, runs_for_day) and its encounter intervals (start_ms/end_ms epoch, speech/non_speech probes, unjudged and dead-mic ms, closed_by — one of the smoother's five values — doctor_present counts, and E-3 identity only where a voiceprint match filled it). Pass room_day_id, or room_id/room_slug + ist_date, or run_id for one run. run:null means no run was ever stored for that day, which is not the same as a run that found nothing (n_hypotheses 0). No text, no audio.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string" },
      run_id: { type: "string", description: "ehr_… — one specific run instead of the latest" },
      room_id: { type: "string" },
      room_slug: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata); default today" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ run: null as unknown }, async () => {
      const runId = argStr(args, "run_id", 64);
      if (runId) {
        const run = await readRun(runId);
        return run ? { run } : { run: null, error: "run_not_found" };
      }
      let roomDayId = argStr(args, "room_day_id", 64);
      let resolved: Record<string, unknown> = {};
      if (!roomDayId) {
        if (!argStr(args, "room_id", 64) && !argStr(args, "room_slug", 64)) {
          return { run: null, error: "room_day_id, run_id, or room_id/room_slug is required" };
        }
        const room = await resolveRoom(args);
        if (!room) return { run: null, error: "unknown_room" };
        const d = pickIstDate(args);
        if ("error" in d) return { run: null, error: d.error };
        const day = await findRoomDay(room.id, d.date);
        if (!day) return { room_id: room.id, room_day_id: null, ist_date: d.date, run: null, runs_for_day: 0 };
        roomDayId = day.id;
        resolved = { room_id: room.id, ist_date: d.date };
      }
      const r = await readLatestRun(roomDayId);
      return { ...resolved, room_day_id: roomDayId, runs_for_day: r.runs_for_day, run: r.run };
    }),
};

/**
 * scribe_encounter_shadow_run — the E-shadow run: E-1 probes, E-2 gate, E-4 smoother, E-5 write, for
 * one room-day. Operator triggered, never a cron. INVOKE scope: it writes.
 *
 * It writes to the two E-5 tables and nothing else, calls no STT, fetches no audio, and changes
 * nothing a clinician sees. Where a window has no stored transcript the gate's own rule applies and
 * the probe is unjudged. A rerun appends a new run (the E-5 store is append-only by design) and names
 * the run it supersedes for readers, who take the latest.
 */
const encounterShadowRun: McpTool = {
  name: "scribe_encounter_shadow_run",
  description:
    "Run the encounter clock over one room-day and store the hypotheses (E-5). Operator triggered. Reads the level log and the transcripts already stored for that day — no STT, no audio fetch, no clinician-facing write. Pass room_day_id, or room_id/room_slug + ist_date. Returns the run id, the run it supersedes, and a numbers-only summary including every rollback trigger from the flag-on plan. A rerun appends a new run; readers take the latest.",
  scope: "invoke",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string" },
      room_id: { type: "string" },
      room_slug: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata); default today" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ ok: false as const }, async () => {
      const room = await resolveRoom(args);
      if (!room) return { ok: false, error: "unknown_room" };
      const d = pickIstDate(args);
      if ("error" in d) return { ok: false, error: d.error };
      let roomDayId = argStr(args, "room_day_id", 64);
      if (!roomDayId) {
        const day = await findRoomDay(room.id, d.date);
        if (!day) return { ok: false, error: "no_room_day", room_id: room.id, ist_date: d.date };
        roomDayId = day.id;
      }
      const res = await runShadowForRoomDay({ room_id: room.id, room_day_id: roomDayId, ist_date: d.date });
      return { room_id: room.id, ist_date: d.date, room_day_id: roomDayId, ...res };
    }),
};

export const VOICE_TOOLS: McpTool[] = [voiceHealth, listVoiceprints, listVoiceSamples, getClusters, diarizeSegments, encounterHypotheses, encounterShadowRun];
