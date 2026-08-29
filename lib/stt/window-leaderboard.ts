/**
 * lib/stt/window-leaderboard.ts — the shapes the two Build 2 admin surfaces return.
 *
 * PURE. No database, no fetch. The routes read rows and hand them here; this file decides what a
 * leaderboard line and a ledger line ARE. Split out of the route files because a Next.js route
 * module may only export route handlers and config — and because the rule these functions encode
 * is worth testing directly rather than through an HTTP handler.
 *
 * ─── THE RULE ─────────────────────────────────────────────────────────────────────────────
 * PRD §4: "no code path renders WER without its refusal rate." `LeaderboardRow` makes all four
 * fields non-optional, so there is no value of this type that carries `wer` alone. A caller
 * cannot ask for the headline without its denominator, because the type that would express that
 * request does not exist.
 *
 * A WER of 0.11 over two windows out of two hundred is not a better number than 0.19 over all of
 * them — it is a weaker claim wearing the same units. The survival rate IS part of the
 * measurement.
 */

/** One engine's line. Every field the PRD names is required, on purpose. */
export type LeaderboardRow = {
  engine_key: string;
  family: string | null;
  wer: number | null;
  cer: number | null;
  n_scored: number;
  n_refused: number;
  refusal_breakdown: Record<string, number>;
};

export type SpendRow = {
  /** Null for every run predating the spine. Rendered as unattributed, never as a name. */
  initiated_by: string | null;
  initiated_via: string | null;
  day: string;
  n_runs: number;
  cost_usd_total: number;
  /** Runs whose engine reported NO cost. Not zero-cost runs — unknown-cost runs. */
  cost_unreported_runs: number;
};

/**
 * PURE — assemble scored means and refusal counts into rows.
 *
 * EVERY ENGINE THAT APPEARS ON EITHER SIDE GETS A ROW. An engine whose every pair was declined is
 * the most interesting line on the board — it is the one telling you what evidence is missing —
 * and an implementation that only iterated the scored side would drop it silently.
 *
 * SILENCE_UNTYPED IS EXCLUDED FROM n_refused. It is recorded against a pair that WAS scored: it
 * withholds one metric (insertions per silent second) and leaves the WER standing. Counting it as
 * a refusal would inflate the very denominator the WER is published beside, and would make a
 * board look more refused the more of it had actually been measured.
 */
export function buildLeaderboard(
  scored: ReadonlyArray<{ engine_key: string; family?: string | null; wer: number | null; cer: number | null }>,
  refusals: ReadonlyArray<{ engine_key: string; reason_code: string; n: number }>,
): LeaderboardRow[] {
  const engines = new Set<string>();
  for (const s of scored) engines.add(s.engine_key);
  for (const r of refusals) engines.add(r.engine_key);

  const rows: LeaderboardRow[] = [];
  for (const key of [...engines].sort()) {
    const mine = scored.filter((s) => s.engine_key === key);
    const wers = mine.map((m) => m.wer).filter((w): w is number => typeof w === "number");
    const cers = mine.map((m) => m.cer).filter((c): c is number => typeof c === "number");

    const breakdown: Record<string, number> = {};
    let refused = 0;
    for (const r of refusals) {
      if (r.engine_key !== key || r.reason_code === "SILENCE_UNTYPED") continue;
      breakdown[r.reason_code] = (breakdown[r.reason_code] ?? 0) + r.n;
      refused += r.n;
    }

    rows.push({
      engine_key: key,
      family: mine[0]?.family ?? null,
      wer: wers.length > 0 ? Math.round((wers.reduce((a, b) => a + b, 0) / wers.length) * 1000) / 1000 : null,
      cer: cers.length > 0 ? Math.round((cers.reduce((a, b) => a + b, 0) / cers.length) * 1000) / 1000 : null,
      n_scored: mine.length,
      n_refused: refused,
      refusal_breakdown: breakdown,
    });
  }
  return rows;
}

/**
 * PURE — shape grouped rows into the spend ledger.
 *
 * The null-cost separation is done in SQL (a COUNT with a FILTER) and re-asserted here, so a
 * reader of either layer meets the same rule: a null cost increments `cost_unreported_runs` and
 * contributes NOTHING to `cost_usd_total`.
 *
 * Postgres SUM() ignores NULLs, so a naive ledger reports $0.00 for a day of paid Sarvam calls —
 * and "we spent nothing" and "we do not know what we spent" are opposite statements.
 */
export function buildLedger(rows: ReadonlyArray<Record<string, unknown>>): SpendRow[] {
  return rows.map((r) => ({
    initiated_by: r.initiated_by === null || r.initiated_by === undefined ? null : String(r.initiated_by),
    initiated_via: r.initiated_via === null || r.initiated_via === undefined ? null : String(r.initiated_via),
    day: String(r.day ?? ""),
    n_runs: Number(r.n_runs) || 0,
    cost_usd_total: Number(r.cost_usd_total) || 0,
    cost_unreported_runs: Number(r.cost_unreported_runs) || 0,
  }));
}
