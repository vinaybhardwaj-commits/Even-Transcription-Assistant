/**
 * lib/mcp/tools/health.ts — topology read tools (Operator MCP S1, PRD §12 11.1).
 *
 * scribe_health composes, in-process:
 *   - GET /api/health logic (app DB, KB DB, Ollama, Whisper, Resend, R2) — the route's GET()
 *     is called directly (no HTTP hop);
 *   - GET /api/brain/health logic (brain pool + config names);
 *   - STT-lab engine probes (lib/mcp/tools/stt probeSttEngines — adapter iteration);
 *   - NEW Pyannote probe: GET {DIARIZE_BASE_URL}/health, 5s timeout, soft-fail;
 *   - listeners: bench_listener rows (S2) — room_id, slug, last_poll_at, listening (≤10 s),
 *     recording (kiosk-reported session), paused; [] + note "bus not migrated" before 0044.
 * scribe_system_map = the same picture + flag states + env NAMES (set/unset booleans only).
 * No secrets, ever. Every sub-probe soft-fails to { ok:false }.
 */

import { GET as appHealthGET } from "@/app/api/health/route";
import { GET as brainHealthGET } from "@/app/api/brain/health/route";
import * as flags from "@/lib/live-flags";
import { probe, type McpTool } from "../registry";
import { probeSttEngines, type EngineHealth } from "./stt";
import { classifyBusError, listListeners } from "@/lib/bench-commands";

const PYANNOTE_TIMEOUT_MS = 5_000;

export type PyannoteProbe = { ok: boolean; latency_ms: number; error?: string; device?: string; models?: string[]; base_url_env: string; configured: boolean; [k: string]: unknown };

/** GET {DIARIZE_BASE_URL}/health — Mini pyannote/ECAPA service. Soft-fail. */
export async function probePyannote(): Promise<PyannoteProbe> {
  const base = process.env.DIARIZE_BASE_URL?.trim();
  if (!base) return { ok: false, latency_ms: 0, error: "DIARIZE_BASE_URL not set", base_url_env: "DIARIZE_BASE_URL", configured: false };
  const r = await probe(async () => {
    const res = await fetch(`${base.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(PYANNOTE_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) throw new Error(`pyannote_health_${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; device?: string; models?: string[] };
    if (j.ok === false) throw new Error("pyannote_reports_not_ok");
    return { device: typeof j.device === "string" ? j.device : undefined, models: Array.isArray(j.models) ? j.models.map(String) : undefined };
  });
  return { ...r, base_url_env: "DIARIZE_BASE_URL", configured: true };
}

type AppHealth = { ok: boolean; sha?: string; region?: string; now?: string; services?: Record<string, { ok: boolean; latency_ms: number; error?: string }> };
type BrainHealth = { ok: boolean; now?: string; db?: unknown; config?: unknown; service?: string; home?: string; version?: string | null };

async function appHealth(): Promise<AppHealth & { degraded?: boolean; error?: string }> {
  try {
    const res = await appHealthGET();
    return (await res.json()) as AppHealth;
  } catch (e) {
    return { ok: false, degraded: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

async function brainHealth(): Promise<BrainHealth & { degraded?: boolean; error?: string }> {
  try {
    const res = await brainHealthGET();
    return (await res.json()) as BrainHealth;
  } catch (e) {
    return { ok: false, degraded: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

async function sttHealthSafe(): Promise<{ engines: EngineHealth[]; degraded?: boolean; error?: string }> {
  try {
    return { engines: await probeSttEngines() };
  } catch (e) {
    return { engines: [], degraded: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

export type ListenerHealth = { room_id: string; slug: string; name: string; tab_id: string; last_poll_at: string; age_ms: number; listening: boolean; recording: boolean; recording_session_id: string | null; paused: boolean };

async function listenersSafe(): Promise<{ listeners: ListenerHealth[]; note?: string; degraded?: boolean }> {
  try {
    const rows = await listListeners();
    return {
      listeners: rows.map((l) => ({
        room_id: l.room_id,
        slug: l.slug,
        name: l.name,
        tab_id: l.tab_id,
        last_poll_at: new Date(l.last_poll_at).toISOString(),
        age_ms: l.age_ms,
        listening: l.listening,
        recording: !!l.recording_session_id,
        recording_session_id: l.recording_session_id,
        paused: l.paused,
      })),
    };
  } catch (e) {
    const b = classifyBusError(e);
    return { listeners: [], note: b.code === "bus_not_migrated" ? "bus not migrated" : "bus down", degraded: true };
  }
}

export async function composeHealth() {
  const [app, brain, stt, pyannote, lst] = await Promise.all([appHealth(), brainHealth(), sttHealthSafe(), probePyannote(), listenersSafe()]);
  const s = app.services ?? {};
  const services = {
    app_db: s.db ?? { ok: false, latency_ms: 0, error: "no_probe" },
    kb_db: s.kb ?? { ok: false, latency_ms: 0, error: "no_probe" },
    r2: s.r2 ?? { ok: false, latency_ms: 0, error: "no_probe" },
    whisper: s.whisper ?? { ok: false, latency_ms: 0, error: "no_probe" },
    ollama: s.llm ?? { ok: false, latency_ms: 0, error: "no_probe" },
    resend: s.resend ?? { ok: false, latency_ms: 0, error: "no_probe" },
  };
  const engines = stt.engines.map((e) => ({
    id: e.id,
    display_name: e.display_name,
    enabled: e.enabled,
    fanout_enabled: e.fanout_enabled,
    virtual: e.virtual,
    ok: e.health.ok,
    latency_ms: e.health.latencyMs,
    ...(e.health.error ? { error: e.health.error } : {}),
  }));
  const ok = Boolean(app.ok) && Boolean(brain.ok) && pyannote.ok && engines.filter((e) => e.enabled && !e.virtual).every((e) => e.ok);
  return {
    ok,
    now: new Date().toISOString(),
    sha: app.sha ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    region: app.region ?? process.env.VERCEL_REGION ?? "local",
    services,
    brain: { ...brain, ok: Boolean(brain.ok) },
    pyannote,
    stt: { engines, ...(stt.degraded ? { degraded: true, error: stt.error } : {}) },
    listeners: lst.listeners,
    ...(lst.note ? { listeners_note: lst.note } : {}),
    ...(app.degraded ? { app_health_degraded: true, app_health_error: app.error } : {}),
  };
}

const ENV_NAMES = [
  "APP_DATABASE_URL", "DATABASE_URL", "BRAIN_DATABASE_URL", "KB_DATABASE_URL",
  "BRAIN_SERVICE_TOKEN", "SCRIBE_MCP_TOKEN", "ADMIN_TOKEN", "MIGRATION_SECRET",
  "R2_ACCOUNT_ID", "R2_BUCKET", "WHISPER_BASE_URL", "INDICCONFORMER_BASE_URL", "DIARIZE_BASE_URL",
  "OLLAMA_BASE_URL", "DEEPGRAM_API_KEY", "SARVAM_API_KEY", "ELEVENLABS_API_KEY",
  "RESEND_API_KEY", "GCP_SA_KEY", "GEMINI_MODEL",
] as const;

const scribeHealth: McpTool = {
  name: "scribe_health",
  description: "Composite health: app DB, KB DB, R2, Whisper, Ollama, Resend (from /api/health), brain (/api/brain/health), every STT engine (adapter probe), Pyannote (Mini /health, 5s), and Bench listeners (empty until the S2 command bus).",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => composeHealth(),
};

const scribeSystemMap: McpTool = {
  name: "scribe_system_map",
  description: "System map as JSON: the scribe_health picture + client flag states + which env NAMES are set (booleans only, never values) + store/route topology. No secrets.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const health = await composeHealth();
    const flagStates = {
      NEXT_PUBLIC_ETA_LIVE_SINK: flags.LIVE_SINK,
      NEXT_PUBLIC_ETA_NOTEGEN: flags.NOTEGEN,
      NEXT_PUBLIC_ETA_BACKGROUND_PROCESSING: flags.BACKGROUND_PROCESSING,
      NEXT_PUBLIC_ETA_LANG_ROUTER: flags.LANG_ROUTER,
      NEXT_PUBLIC_ETA_MIC_PREFLIGHT: flags.MIC_PREFLIGHT,
      NEXT_PUBLIC_ETA_AUDIO_WATCHDOG: flags.AUDIO_WATCHDOG,
      NEXT_PUBLIC_ETA_LIVE_FLASH: flags.LIVE_FLASH,
      NEXT_PUBLIC_ETA_HEADER_GUARD: flags.HEADER_GUARD,
      NEXT_PUBLIC_ETA_INDIC_LIVE_BOX: flags.INDIC_LIVE_BOX,
      NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS: flags.TRIM_LIVE_BUFFERS,
      NEXT_PUBLIC_ETA_DEEPGRAM_RECONNECT: flags.DEEPGRAM_RECONNECT,
      NEXT_PUBLIC_ETA_SAFARI_STREAMING_GUARD: flags.SAFARI_STREAMING_GUARD,
    };
    const env = Object.fromEntries(ENV_NAMES.map((n) => [n, Boolean(process.env[n])]));
    return {
      health,
      flags: flagStates,
      env_set: env,
      stores: {
        app_neon: { env: "APP_DATABASE_URL", driver: "neon http", tables: ["clinician", "encounter", "llm_traces", "trace", "voice_print", "voice_sample", "stt_*", "room", "bench_session", "bench_chunk", "bench_event", "audit_log"] },
        brain_role: { env: "BRAIN_DATABASE_URL", driver: "neon ws pool", tables: ["room_day", "visit", "speaker_cluster", "cue"] },
        kb_neon: { env: "KB_DATABASE_URL", tables: ["mksap_chunks"] },
        r2: { env: "R2_BUCKET", prefixes: ["encounters/", "whisper-buffer/", "voice-samples/", "bench/{slug}/{UTC-date}/{session_id}/"] },
      },
      brain_routes: ["POST /api/brain/cues", "GET /api/brain/rooms/:id/state", "GET /api/brain/rooms/:id/cues", "GET /api/brain/health"],
      mcp: { path: "/api/mcp", token_env: "SCRIBE_MCP_TOKEN", slice: "S2 (read tools + command bus + remote tape control)", command_bus: health.listeners_note ?? "bench_command / bench_listener (0044)" },
    };
  },
};

export const HEALTH_TOOLS: McpTool[] = [scribeHealth, scribeSystemMap];
