/**
 * lib/night-drain/producer.ts — who made this row, and what kind of row it is.
 *
 * THE PRODUCER IS DERIVED FROM THE RUNNING HOST, never written down. A hardcoded producer label has
 * bitten this project before, and the Yoga measurements this month are why the label matters: two
 * machines given the same audio produce boundaries that differ at speaker switches, so the only way a
 * mixed corpus stays survivable is being able to ask, afterwards, which machine made a row.
 *
 * NO COLUMN, NO MIGRATION (ruling C). The stamp rides in `room_diarize_window.timing_json`, at the top
 * level, next to the diarize client's own timing keys (which are all kept).
 *
 * `diarize_only: true` IS THE REVISITABILITY FLAG (ruling B). These windows are diarized WITHOUT being
 * transcribed, so they have speaker segments and no turn binding — and a row like that must never be
 * indistinguishable from one that was fully processed. Find them again with
 *   SELECT window_id FROM room_diarize_window WHERE timing_json->>'diarize_only' = 'true';
 */
import os from "node:os";

export const NIGHT_DRAIN_WORKER = "night-drain";
export const NIGHT_DRAIN_VERSION = 1;

export type HostInfo = { hostname: () => string; arch: () => string; platform: () => string };
export const RUNNING_HOST: HostInfo = { hostname: () => os.hostname(), arch: () => os.arch(), platform: () => os.platform() };

export type Producer = {
  host: string;
  arch: string;
  platform: string;
  worker: string;
  worker_version: number;
  /** What the diarize service says it computes on (`/health` → device), read at run time. */
  service_device: string | null;
};

export function producerStamp(serviceDevice: string | null, host: HostInfo = RUNNING_HOST): Producer {
  return {
    host: host.hostname(),
    arch: host.arch(),
    platform: host.platform(),
    worker: NIGHT_DRAIN_WORKER,
    worker_version: NIGHT_DRAIN_VERSION,
    service_device: serviceDevice,
  };
}

export type Phases = {
  mcp_ms: number | null;
  download_ms: number | null;
  join_ms: number | null;
  diarize_ms: number | null;
  total_ms: number | null;
};

export type AudioFacts = { pieces: number; bytes: number; seconds: number; source: "primary" | "backup" };

/**
 * PURE — the timing_json to store. The diarize client's timing object (or null when the call was never
 * made) is spread first, so every key it had is still there; the stamp only ADDS `producer`,
 * `diarize_only` and `night_drain`.
 */
export function stampTiming(
  clientTiming: unknown,
  producer: Producer,
  phases: Phases,
  audio: AudioFacts | null,
): Record<string, unknown> {
  const base = clientTiming && typeof clientTiming === "object" && !Array.isArray(clientTiming) ? (clientTiming as Record<string, unknown>) : {};
  return {
    ...base,
    producer,
    diarize_only: true,
    night_drain: { phases, audio_source: "scribe_mcp_chunks", audio },
  };
}
