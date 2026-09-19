/**
 * lib/transcript/repeat-runs.ts — phrase-loop detector, MARK NEVER DELETE.
 *
 * Flags whole turns that sit inside a Whisper segment-level repeat loop (root cause:
 * docs/handoff/scratch/phrase-loop-19-SEP-2026.md — buildTurns maps Whisper's raw segments to
 * cues 1:1; on some windows Whisper itself returns the same short phrase as many separate
 * consecutive segments). This module is PURE: no DB, no I/O. It takes an ordered list of turns
 * for one window and returns, for each turn, whether it sits in a run and which one.
 *
 * ─── THE DEFINITION, AND WHERE IT DEPARTS FROM THE CANONICAL DOC ────────────────────────────
 * docs/handoff/ETA-M4-WHISPER-VS-ROUTE-QUALITY-CC-KICKOFF-14-SEP-2026.md §1 defines three
 * measures, none of which is a literal fit here:
 *   A. Phrase loop — an n-gram of 3-12 WORDS repeating 3+ times back to back, on JOINED text.
 *   B. Repeated sentence — 2+ consecutive identical normalised SENTENCES, on joined text.
 *   C. Consecutive identical segments — explicitly "route ONLY", and explicitly: "do not
 *      manufacture segments for the whisper side".
 * This detector's unit is a whole TURN (one persisted cue row = one Whisper segment already
 * split by the pipeline, not manufactured here for the purpose of this comparison), which is
 * closest in spirit to B's "consecutive identical segments" idea applied to real segments,
 * carried at C's granularity. Neither B's threshold (2+) nor A's threshold (3+) transfers
 * cleanly: A's "three, not two" reasoning ("two repeats occur in ordinary speech") was written
 * for short word n-grams, not whole turns, and this build's own required test case ("a phrase
 * legitimately repeated 3 times must NOT be flagged") is incompatible with a literal reps>=3
 * reading at turn granularity. AMBIGUOUS — resolved conservatively per the kickoff's own
 * instruction: MIN_RUN_LENGTH_TO_FLAG is 4, one past the doc's stated legitimate-repeat count,
 * because wrongly flagging real speech (a false positive) hides evidence from downstream
 * threshold work, while under-flagging a borderline run (a false negative) leaves that data
 * visible and merely unmarked — the safer failure under "mark, never delete".
 */

export type RepeatRunTurnInput = {
  source_ref: string;
  text: string;
};

export type RepeatRunResult = {
  source_ref: string;
  in_run: boolean;
  run_id: string | null;
  run_length: number;
  run_rank: number;
};

/** Runs of this length or longer are flagged. See the module doc comment for why 4. */
export const MIN_RUN_LENGTH_TO_FLAG = 4;

/** Canonical normalisation, ETA-M4-WHISPER-VS-ROUTE-QUALITY-CC-KICKOFF-14-SEP-2026.md §1, verbatim:
 * "lowercase; collapse runs of whitespace to one space; strip punctuation except ., ? and !;
 * tokenise on spaces." Tokenising is a no-op for whole-turn equality but kept for fidelity to the
 * definition and so a future n-gram-within-turn measure can reuse this function unchanged. */
export function normalizeTurnText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s.?!]/gu, "")
    // Stripping punctuation can leave a run it used to separate (e.g. "wait -- really" -> "wait  really")
    // - re-collapse so the whole function's own stated property ("whitespace collapsed to one space")
    // holds on its OUTPUT, not just after the first pass.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect maximal back-to-back runs of identical normalised turn text, in the given order.
 *
 * Empty-after-normalise text never participates in a run (buildTurns already drops blank
 * segments before a cue is ever written, so this is a defensive floor, not an expected path).
 */
export function detectRepeatRuns(turns: RepeatRunTurnInput[]): RepeatRunResult[] {
  const results: RepeatRunResult[] = new Array(turns.length);
  const normalized = turns.map((t) => normalizeTurnText(t.text));

  let i = 0;
  while (i < turns.length) {
    const key = normalized[i];
    let j = i + 1;
    if (key.length > 0) {
      while (j < turns.length && normalized[j] === key) j++;
    }
    const runLength = j - i;
    const inRun = key.length > 0 && runLength >= MIN_RUN_LENGTH_TO_FLAG;
    const runId = inRun ? turns[i].source_ref : null;
    for (let k = i; k < j; k++) {
      results[k] = {
        source_ref: turns[k].source_ref,
        in_run: inRun,
        run_id: runId,
        run_length: inRun ? runLength : 1,
        run_rank: inRun ? k - i + 1 : 1,
      };
    }
    i = j;
  }

  return results;
}
