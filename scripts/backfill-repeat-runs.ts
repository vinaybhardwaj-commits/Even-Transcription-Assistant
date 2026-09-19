/**
 * scripts/backfill-repeat-runs.ts — run the phrase-loop backfill once (0104).
 *
 * Read-and-flag only: no row's text is touched, nothing is re-transcribed. Prints counts only —
 * never a turn's text (patient/doctor speech).
 *
 *   APP_DATABASE_URL=... npx tsx scripts/backfill-repeat-runs.ts
 */
import { backfillRepeatRuns } from "../lib/transcript/repeat-runs-backfill";

async function main() {
  const summary = await backfillRepeatRuns();
  console.log(JSON.stringify({
    windows_considered: summary.windows_considered,
    windows_with_turns: summary.windows_with_turns,
    turns_total: summary.turns_total,
    turns_flagged: summary.turns_flagged,
    windows_with_a_flag: summary.per_window.filter((w) => w.flagged > 0).length,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
