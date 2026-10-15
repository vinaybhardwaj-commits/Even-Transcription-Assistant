/**
 * lib/jev/worker/uses.ts — the state-builder interface and the use registry (PRD §3.2, §3.4).
 *
 * A USE says which subjects are ready for a question set, and how to build the state Jev reads for one subject. P1 ships the
 * INTERFACE and no production use: U-A (epic #23), U-B (STT quality) and U-C (rubric) register theirs in P2-P4, each behind
 * its own flag. A builder RE-FETCHES its evidence by id at every step; the state is never held across steps and never put in
 * `progress` or any column (ids and counts only, PRD §12).
 */
import type { JevSubjectType } from "../types";
import type { RealUse } from "./flags";

export const UNBUILDABLE_REASONS = ["bad_unit_key", "not_found", "no_data", "blind_room_day", "not_implemented", "bad_id", "build_error", "read_refused"] as const;
export type UnbuildableReason = (typeof UNBUILDABLE_REASONS)[number];
/** Maps a reader refusal to the closed vocabulary; anything outside it becomes read_refused, so free text can never reach a report. */
export const unbuildableFrom = (reason: string): UnbuildableReason => ((UNBUILDABLE_REASONS as readonly string[]).includes(reason) ? (reason as UnbuildableReason) : "read_refused");

export type StateBuild =
  | { tooLarge: true; bytes: number }
  /** A deterministic pre-gate failed (PRD §2: e.g. patient-side speech under 3 turns, an unusable transcript): the call is SKIPPED and the row says why. */
  | { abstain: string }
  /** The builder could not build, and says why with a CLOSED code (UnbuildableReason), never text. The call is skipped exactly as for a null build; bench records it as no_state:<reason>. */
  | { unbuildable: UnbuildableReason }
  | { state: unknown; /** ids only: window_ids, nemotron_row_ids, consult_key... */ evidence: Record<string, unknown>; lane: "timeline" | "text" };

export interface JevUseDef {
  use: RealUse;
  /** The question set (id) this use asks. */
  setId: string;
  subjectType: JevSubjectType;
  /** Subject ids whose evidence is ready, oldest first, at most `limit`. The sweeper drops those that already hold a decision for the current hash. */
  /** `ctx` (the sweeper passes it) lets a source exclude already-decided subjects in SQL; sources that ignore it stay valid. */
  eligible(limit: number, ctx?: { sha: string; mode: string }): Promise<string[]>;
  /** Subject ids for the bench subjects route, when it must differ from the sweeper's `eligible` (the seeded sample the bench was built on). */
  benchEligible?(limit: number): Promise<string[]>;
  /** Null = the subject is no longer buildable (evidence withdrawn): recorded as no opinion, never a fabricated state. */
  build(subjectId: string): Promise<StateBuild | null>;
  /**
   * Bench reports compare Jev's answer with a human label. When a question's options are not the label's own vocabulary (u10_end_row answers
   * `cand_03`; the label is a row), this maps the answer back through the build's `evidence`. Absent = the option key is the label.
   */
  resolve?(questionId: string, value: string, evidence: Record<string, unknown>): string;
}

/** Keyed by use AND set: one use (consult_rubric) holds several sets with different subjects and builders. */
const uses = new Map<string, JevUseDef>();
const key = (use: string, setId: string): string => `${use}/${setId}`;

export function registerUse(def: JevUseDef): void {
  if (uses.has(key(def.use, def.setId))) throw new Error(`jev use already registered: ${def.use}/${def.setId}`);
  uses.set(key(def.use, def.setId), def);
}
/** With a set id: that set's definition. Without: the first one registered for the use (the P1 single-set callers). */
export const getUse = (use: string, setId?: string): JevUseDef | undefined =>
  setId !== undefined ? uses.get(key(use, setId)) : [...uses.values()].find((u) => u.use === use);
export const usesOf = (use: string): JevUseDef[] => [...uses.values()].filter((u) => u.use === use);
export const listUses = (): JevUseDef[] => [...uses.values()];
/** Test-only. */
export const _clearUsesForTests = (): void => uses.clear();
