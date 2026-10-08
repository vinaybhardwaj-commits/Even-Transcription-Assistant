/**
 * lib/rooms-live/steward-status.ts — S1: the Steward status strip's data, from steward_config (kill_switch, shadow, start_day_live, last_tick). Server side; PURE over the rows.
 * "starts recording: ON" and "restarts and alerts" use the Steward's own actionMode(), so the strip can never say ON where the loop would record a shadow row.
 * A kill_switch row that is missing or malformed is "unavailable", never "Steward off": parseConfig falls back to ON (fail-closed) and that is not a statement about the Steward.
 */
import { actionMode, parseConfig } from "@/lib/steward/config";
import type { StewardStatus } from "./steward-lines";

export const STATUS_KEYS = ["kill_switch", "shadow", "start_day_live", "last_tick"] as const;
/** every action but scribe_start: the "restarts and alerts" group */
const OTHERS = ["scribe_stop", "scribe_restart", "alert", "message", "ticket:wake", "ticket:open_pulse", "ticket:relaunch_chrome", "ticket:policy_cycle", "ticket:restart_recorder_app", "ticket:restart_kiosk_health"];

const val = (v: unknown): unknown => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
};

export function statusFromRows(rows: ReadonlyArray<{ key: string; value: unknown }>): StewardStatus {
  const { config, invalid } = parseConfig(rows);
  if (invalid.includes("kill_switch") || invalid.includes("shadow")) return { state: "unavailable" };
  const lt = val(rows.find((r) => r.key === "last_tick")?.value);
  const at = lt && typeof lt === "object" && typeof (lt as { at?: unknown }).at === "string" ? (lt as { at: string }).at : null;
  const last_tick_at = at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null;
  if (config.kill_switch) return { state: "off", last_tick_at };
  const live = OTHERS.filter((a) => actionMode(config, a) === "live").length;
  return { state: "on", last_tick_at, starts_live: actionMode(config, "scribe_start") === "live", others: live === 0 ? "watching" : live === OTHERS.length ? "live" : "partly" };
}
