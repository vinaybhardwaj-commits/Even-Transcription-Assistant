/**
 * lib/mcp/tools/voice.ts — voice / Pyannote read tools (Operator MCP S1, PRD §12 11.5).
 *
 * scribe_voice_health        — the Pyannote probe alone (Mini GET /health, 5s, soft-fail).
 * scribe_list_voiceprints    — voice_print JOIN clinician (voice_print.doctor_id → clinician.id,
 *                              migration 0014): clinician id, name, sample count, enrolled/last
 *                              sample times, needs_reenrollment. NO centroid / embeddings.
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
import { argBool, argStr, failSafe, type McpTool, type ToolArgs } from "../registry";
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
  description: "Enrolled clinician voiceprints (voice_print JOIN clinician): clinician_id, name, sample_count, enrolled_at, last_sample_at, needs_reenrollment. No embeddings.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () =>
    failSafe({ voiceprints: [] as unknown[] }, async () => {
      const rows = (await sql`
        SELECT vp.doctor_id AS clinician_id, c.full_name, c.url_slug, vp.sample_count, vp.enrolled_at,
               vp.last_sample_at, vp.needs_reenrollment, (vp.centroid IS NOT NULL) AS has_centroid
          FROM voice_print vp
          JOIN clinician c ON c.id = vp.doctor_id
         ORDER BY vp.last_sample_at DESC
      `) as Array<{ clinician_id: string; full_name: string; url_slug: string; sample_count: number; enrolled_at: string | Date; last_sample_at: string | Date; needs_reenrollment: boolean; has_centroid: boolean }>;
      return {
        voiceprints: rows.map((r) => ({
          clinician_id: r.clinician_id,
          name: r.full_name,
          url_slug: r.url_slug,
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

export const VOICE_TOOLS: McpTool[] = [voiceHealth, listVoiceprints, listVoiceSamples, getClusters];
