/**
 * Spine types (SPINE-PLAN §2 column names). Times are epoch milliseconds (UTC); the store converts from/to ISO strings.
 * No names, no prescription ids, no text: ids and timings only.
 */
export const PROXIES = ["pulse", "pqm", "acoustic", "timeline", "doctor_activity", "cutter", "caa", "nemotron_window"] as const;
export type Proxy = (typeof PROXIES)[number];
export const STRONG_PROXIES: readonly Proxy[] = ["pulse", "pqm"];
export const WEAK_PROXIES: readonly Proxy[] = ["acoustic", "timeline", "doctor_activity", "nemotron_window"];
export const DERIVED_PROXIES: readonly Proxy[] = ["cutter", "caa"];

export type EncounterStatus = "candidate" | "confirmed" | "rejected" | "merged";
export type KeyKind = "consult_uid" | "consult_key" | "pqm_uid" | "window_id" | "caa_uid" | "buddy_opaque";
export type LinkBasis = "exact" | "overlap" | "merge";

/** One spine_signal row. attrs holds ids, quality and close_reason only (consult_uid, consult_key, pqm_uid, window_id, caa_uid, buddy_opaque, close_reason, final_reason). */
export interface SpineSignal {
  proxy: Proxy;
  source_key: string;
  source_rev: number;
  room_id: string | null;
  t_open: number;
  t_close: number | null;
  /** The encounter this signal was assigned to last run (spine_signal.encounter_id), if any. */
  encounter_id?: string | null;
  attrs?: Record<string, unknown>;
}

export interface PriorEncounter {
  encounter_id: string;
  ist_date: string;
  room_id: string;
  t_open: number;
  t_close: number;
  status: EncounterStatus;
  merged_into: string | null;
  anchor_proxy: Proxy;
  boundary_rev: number;
  reason: string | null;
  created_at: number;
}
export interface PriorLink {
  encounter_id: string;
  key_kind: KeyKind;
  value: string;
}
export interface SpinePrior {
  encounters: PriorEncounter[];
  links: PriorLink[];
}

export interface MergedEncounter {
  encounter_id: string;
  ist_date: string;
  room_id: string;
  t_open: number;
  t_close: number;
  status: EncounterStatus;
  merged_into: string | null;
  anchor_proxy: Proxy;
  boundary_rev: number;
  merge_version: string;
  reason: string;
  /** multi_machine | pulse_overlap | ambiguous | frozen. Not a spine_encounter column. */
  flags: string[];
  /** True when the boundary moved against prior: the writer enqueues a recut. */
  boundary_moved: boolean;
}
export interface MergedLink {
  encounter_id: string;
  key_kind: KeyKind;
  value: string;
  basis: LinkBasis;
}
export interface SignalAssignment {
  proxy: Proxy;
  source_key: string;
  source_rev: number;
  encounter_id: string;
}
export interface MergeResult {
  merge_version: string;
  encounters: MergedEncounter[];
  links: MergedLink[];
  assignments: SignalAssignment[];
  /** M1 counts: no room, still open under the cap, derived signal with no key match ("proxy:source_key"). */
  unplaced: number;
  open_deferred: number;
  unattached: string[];
}
