#!/usr/bin/env node
/**
 * scripts/e7-timeline-score.mjs — E-7 scoring for the patient-leave shadow (epic #23 h).
 *
 * Read-only. No database client is imported.
 *   node scripts/e7-timeline-score.mjs --dry-run
 *     prints the SELECTs a scorer would run and does not connect.
 *   node scripts/e7-timeline-score.mjs --fixture tests/fixtures/e7-timeline.json
 *     scores that file and prints counts and whole seconds only.
 *
 * Match rule matches lib/encounter-clock/e7-boundaries.ts: overlap at least half the shorter interval.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MATCH_OVERLAP = 0.5;

const len = (a) => Math.max(0, a.end_ms - a.start_ms);
export const overlapMs = (a, b) => Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));
export function matches(a, b) {
  const shorter = Math.min(len(a), len(b));
  return shorter > 0 && overlapMs(a, b) >= MATCH_OVERLAP * shorter;
}
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
const sec = (ms) => Math.round(ms / 1000);
const err = (xs) => ({
  n: xs.length,
  median_s: percentile(xs, 0.5) == null ? null : sec(percentile(xs, 0.5)),
  p90_s: percentile(xs, 0.9) == null ? null : sec(percentile(xs, 0.9)),
});

/** Same numbers as boundaryScore in lib/encounter-clock/e7-boundaries.ts. */
export function boundaryScore(truth, hyp) {
  const same = (a, b) => (a.room_id ?? "_") === (b.room_id ?? "_");
  const tMatches = truth.map((t) => hyp.map((h, j) => (same(t, h) && matches(t, h) ? j : -1)).filter((j) => j >= 0));
  const hMatched = hyp.map((h) => truth.some((t) => same(t, h) && matches(t, h)));
  const startErr = [], endErr = [];
  truth.forEach((t, i) => {
    const js = tMatches[i];
    if (!js.length) return;
    const best = js.map((j) => hyp[j]).sort((a, b) => overlapMs(t, b) - overlapMs(t, a) || a.start_ms - b.start_ms)[0];
    startErr.push(Math.abs(best.start_ms - t.start_ms));
    endErr.push(Math.abs(best.end_ms - t.end_ms));
  });
  return {
    truth: truth.length,
    hypotheses: hyp.length,
    missed: tMatches.filter((m) => m.length === 0).length,
    extra: hMatched.filter((ok) => !ok).length,
    two_consult_splits: tMatches.filter((m) => m.length > 1).length,
    start_error_s: err(startErr),
    end_error_s: err(endErr),
  };
}

/** Same numbers as closeCoverage in lib/encounter-clock/e7-boundaries.ts. */
export function closeCoverage(rows) {
  const by = {};
  let clicked = 0;
  for (const r of rows) {
    by[r.close_kind] = (by[r.close_kind] ?? 0) + 1;
    if (r.end_clicked) clicked++;
  }
  return { consults: rows.length, by_close_kind: by, end_clicked: clicked, not_clicked: rows.length - clicked };
}

export const DRY_RUN_SQL = `-- read only. bind room_day_id, room_id, and the ist day bounds. does not connect.
SELECT start_ms, end_ms, closed_by, reason_codes, confidence, encounter_end_ms
  FROM encounter_timeline_shadow s
  JOIN encounter_timeline_shadow_run r ON r.id = s.run_id
 WHERE r.id = (SELECT id FROM encounter_timeline_shadow_run WHERE room_day_id = $1 ORDER BY created_at DESC LIMIT 1);
SELECT (EXTRACT(EPOCH FROM t_open) * 1000) AS start_ms,
       (EXTRACT(EPOCH FROM t_close) * 1000) AS end_ms,
       close_reason
  FROM eta_encounter_windows
 WHERE room_id = $2 AND t_open >= $3 AND t_open < $4;
SELECT t0_ms, t1_ms FROM consult_index WHERE room_id = $2 AND ist_date = $5;
`;

export function scoreFixture(fx) {
  const room = fx.room_id ?? "_";
  const tag = (rows) => rows.map((r) => ({ ...r, room_id: r.room_id ?? room }));
  return {
    pulse: boundaryScore(tag(fx.pulse), tag(fx.shadow)),
    cuts: boundaryScore(tag(fx.cuts), tag(fx.shadow)),
    close: closeCoverage(fx.pulse),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--dry-run")) {
    process.stdout.write(DRY_RUN_SQL);
    return;
  }
  const i = args.indexOf("--fixture");
  if (i >= 0 && args[i + 1]) {
    const fx = JSON.parse(readFileSync(args[i + 1], "utf8"));
    process.stdout.write(`${JSON.stringify(scoreFixture(fx))}\n`);
    return;
  }
  process.stderr.write("usage: node scripts/e7-timeline-score.mjs --dry-run | --fixture <file>\n");
  process.exit(2);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main();
