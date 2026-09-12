/**
 * lib/whisper-constants.ts — one name for one thing (hotfix fix-up, item 3).
 *
 * `EMPTY_TRANSCRIPT` used to be a bare literal at the return site in `lib/whisper.ts` with a second
 * copy declared in `lib/mcp/tools/bench.ts`: two spellings of one fact, so changing either alone
 * left the other silently disagreeing — which is how the job path came to treat a quiet room as a
 * failed read.
 *
 * WHY ITS OWN MODULE, AND NOT `lib/whisper.ts`. Eleven test files mock `@/lib/whisper` wholesale,
 * because it is the network client. A constant that lives inside it is erased by every one of those
 * mocks, so each would have to re-supply a value it does not care about — and a mock that forgets
 * it fails in a way that has nothing to do with what the test is checking. Data belongs somewhere
 * nobody needs to mock. The producer imports this too, so there is exactly one declaration.
 */

/**
 * A 200 from Whisper carrying no speech. An `ok:false` that means SUCCESS — the read finished and
 * the room was quiet — so every consumer must branch on it before treating `!ok` as a failure.
 */
export const EMPTY_TRANSCRIPT = "empty_transcript";
