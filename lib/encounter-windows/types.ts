/**
 * lib/encounter-windows/types.ts — shared types for the encounter-window resolver.
 *
 * An ENCOUNTER WINDOW is one consult on one machine: when it opened, when it closed, who the doctor was and
 * how sure we are. Source of truth is `pulse_presence_events` (Pulse Presence extension); the resolver is a
 * port of the reference implementation in ~/pulse-watch (occupancy.mjs + gate-p1/consults.mjs), proven on
 * 114 consults for 2-4 Oct 2026. See docs/handoff/ETA-ENCOUNTER-WINDOWS-BUILD-04-OCT-2026.md.
 */

export const RESOLVER_VERSION = "encounter-windows/1";

/** One presence event, flattened to the fields the resolver needs. Timestamps may be ISO strings (Neon HTTP). */
export type PresenceEvent = {
  id: number | string;
  source: "ext" | "resolver" | string;
  machine: string | null;
  event: string | null;
  ts: string | number | Date;
  /** payload->>'doctor_uid' */
  uid?: string | null;
  /** payload->>'display_name' */
  dn?: string | null;
  /** payload->>'encounter_id' (the consult uid) */
  enc?: string | null;
  /** payload->>'prescription_ref' */
  rx?: string | null;
  /** payload->>'tab_focus': 'true' | 'false' | boolean | null */
  focus?: string | boolean | null;
  /** payload->>'reason' (resolver logouts) */
  reason?: string | null;
};

export type Attribution = "rows" | "occupant" | "none";
export type CloseReason = "endConsult" | "url_clear" | "next_open" | "logout" | "idle_timeout" | "cap_90m" | "open";
export type Quality = "clean" | "ambiguous" | "multi_doctor" | "unclosed" | "unattributed";

/** One row of eta_encounter_windows. Timestamps are ISO-8601 UTC strings. */
export type EncounterWindowRow = {
  consult_key: string;
  consult_uid: string | null;
  prescription_ref: string | null;
  machine: string;
  room_id: string | null;
  room_slug: string | null;
  doctor_uid: string | null;
  display_name: string | null;
  attribution: Attribution;
  t_open: string;
  t_close: string | null;
  close_reason: CloseReason;
  quality: Quality;
  reopen_count: number;
  source_event_ids: number[];
  resolver_version: string;
};

export type RoomRef = { room_id: string; slug: string | null };

export type ComputeOptions = {
  /** Keep windows with from <= t_open < to. Defaults: unbounded. */
  from?: string | number | Date;
  to?: string | number | Date;
  /** "Now" for the open-vs-cap decision and the occupancy clock. Default: the latest event timestamp. */
  asOf?: string | number | Date;
  /** machine -> room. Keys are matched after normalizeHostname() on both sides. */
  crosswalk?: Map<string, RoomRef> | Record<string, RoomRef>;
  genuineMin?: number;
  nightlyCutoff?: string;
  lookbackH?: number;
  focusMin?: number;
  /** Test hook: also return per-consult internals. */
  debug?: boolean;
};

export type ComputeSummary = {
  consults: number;
  /** encounter_open rows with only a prescription_ref and no encounter_id partner in the range: NOT consults. */
  unpaired_refs: number;
  by_quality: Record<Quality, number>;
  by_attribution: Record<Attribution, number>;
  by_close_reason: Record<string, number>;
};

export type ComputeResult = { rows: EncounterWindowRow[]; summary: ComputeSummary };

/** "EHRC-CONSUL2’s Mac mini (2)" -> "EHRC-CONSUL2s-Mac-mini-2" (the extension's machine_id spelling). */
export function normalizeHostname(h: string): string {
  return h.replace(/’/g, "").replace(/'/g, "").replace(/\s*\((\d+)\)/, "-$1").replace(/\s+/g, "-");
}
