/** What an engine returns for one unit. score = numbers and enums, findings = closed codes, evidence = the per-unit JSON that goes to R2 (never transcript text for a code engine). */
export type EngineResult = {
  status: "ok" | "empty" | "skipped" | "failed";
  score?: Record<string, unknown>;
  findings: string[];
  evidence?: Record<string, unknown>;
  /** why a unit is skipped / empty / failed: a closed code (no_diarization, no_turns, blind_room_day, no_audio_state, ...) */
  reason?: string;
  /** model calls this unit made (attempts); counted against the llm_zdr ceilings (S71-R4 G71) */
  calls?: number;
};
export type UnitOutcome = EngineResult & { room_id: string | null; ist_date: string | null };
