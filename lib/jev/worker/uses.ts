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

export type StateBuild =
  | { tooLarge: true; bytes: number }
  | { state: unknown; /** ids only: window_ids, nemotron_row_ids, consult_key... */ evidence: Record<string, unknown>; lane: "timeline" | "text" };

export interface JevUseDef {
  use: RealUse;
  /** The question set (id) this use asks. */
  setId: string;
  subjectType: JevSubjectType;
  /** Subject ids whose evidence is ready, oldest first, at most `limit`. The sweeper drops those that already hold a decision for the current hash. */
  eligible(limit: number): Promise<string[]>;
  /** Null = the subject is no longer buildable (evidence withdrawn): recorded as no opinion, never a fabricated state. */
  build(subjectId: string): Promise<StateBuild | null>;
}

const uses = new Map<string, JevUseDef>();

export function registerUse(def: JevUseDef): void {
  if (uses.has(def.use)) throw new Error(`jev use already registered: ${def.use}`);
  uses.set(def.use, def);
}
export const getUse = (use: string): JevUseDef | undefined => uses.get(use);
export const listUses = (): JevUseDef[] => [...uses.values()];
/** Test-only. */
export const _clearUsesForTests = (): void => uses.clear();
