/**
 * lib/stt/reliability-label.ts — E31 C6/C7: WHAT THE LEADERBOARD'S RELIABILITY FIGURE MEASURES, SAID ON THE PAGE.
 *
 * The leaderboard exists to choose an engine, and for that an engine that needs three attempts is worse than one that
 * needs one. So for encounters the headline reliability is PER ATTEMPT. Two things keep that honest:
 *   - it counts only runs from the date every attempt started being kept (STT_PER_ATTEMPT_SINCE). Before that date
 *     each retry deleted the failure before it, so the history is missing failures and a per-attempt figure over it
 *     would flatter MORE than the old figure did. Until the date is set, the figure is withheld, not guessed;
 *   - room windows keep only their latest run by design (lib/stt/room-drain.ts), so their figure is the FINAL OUTCOME
 *     per window and is labelled that way, never as reliability per attempt.
 *
 * Pure, with no imports: the admin client renders it and must not pull the database module in.
 */
export type ReliabilityBasis = "per_attempt" | "final_outcome" | "mixed";

export function reliabilityBasisFor(subjectKind: string): ReliabilityBasis {
  if (subjectKind === "bench_window") return "final_outcome";
  if (subjectKind === "all") return "mixed";
  return "per_attempt";
}

/** The column heading for the headline reliability figure. */
export function reliabilityHeading(basis: ReliabilityBasis): string {
  if (basis === "final_outcome") return "Reliab. (final outcome)";
  if (basis === "mixed") return "Reliab. (not comparable)";
  return "Reliab. per attempt";
}

/** The plain sentence under the table that says what the figure covers. */
export function reliabilityCaption(basis: ReliabilityBasis, perAttemptSince: string | null): string {
  if (basis === "final_outcome") {
    return "Room windows keep only their latest run, so reliability here is the final outcome per window, not per attempt.";
  }
  if (basis === "mixed") {
    return "Mixed subjects: encounters are counted per attempt and room windows by final outcome, so no single reliability figure is shown.";
  }
  if (!perAttemptSince) {
    return "Reliability per attempt is not shown yet: it counts runs from the date every attempt started being kept, and that date has not been set. Final outcome per encounter is shown beside it.";
  }
  return `Reliability per attempt counts runs from ${perAttemptSince.slice(0, 10)} only. Before that date a retry deleted the failed attempt before it, so earlier runs cannot be counted per attempt. Final outcome per encounter covers the whole period selected.`;
}
