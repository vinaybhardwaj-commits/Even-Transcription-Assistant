/**
 * lib/encounter-clock/timeline-features.ts — cheap per-row features for the pre-STT timeline (epic #23 e).
 *
 * The 30 s timeline Jev already reads (timeline.ts) carries who, overlap and speech. This adds what that state
 * can grow without a model and without audio: loudness and level-log changes from the room level log, silence
 * and mean turn length from the Nemotron turns. Pitch is not cheap (no pitch track in the level log) and is
 * always null — a missing measurement, never a made-up number.
 *
 * NO EVIDENCE IS NOT ZERO. A row no stored Nemotron window fully covers has silence_s, mean_turn_s and
 * overlap_s null. Loudness is null when the row has no level samples. Speaker labels are the timeline's own
 * letters (DOC, B, C, …), never a name.
 */
import { DEAD_MIC_DBFS, DEAD_MIC_ZERO_RATIO, ENERGY_ACTIVE_MIN, dbfs } from "@/lib/encounter-clock/gate";

export const FEATURES_VERSION = "timeline-features-v1";

export type LevelPoint = { t_ms: number; avg: number | null; peak: number; zero_ratio: number | null };

export type FeatureTurn = { start_ms: number; end_ms: number };

export type FeatureRowIn = {
  t: string;
  start_ms: number;
  end_ms: number;
  /** Speaker letters already assigned by the timeline. Absent on a compressed range row. */
  who?: readonly string[] | null;
  overlap_s?: number | null;
};

export type FeatureRow = {
  t: string;
  who: string[];
  loud_db: number | null;
  silence_s: number | null;
  mean_turn_s: number | null;
  overlap_s: number | null;
  level_events: number | null;
  /** Always null. Pitch needs a model; the level log does not carry one. */
  pitch: null;
};

const LABEL_RE = /^(DOC|[B-Z]|\?)$/;

function unionMs(spans: Array<{ a: number; b: number }>): number {
  const sorted = spans.filter((s) => s.b > s.a).sort((x, y) => x.a - y.a);
  let total = 0, curA = 0, curB = -Infinity;
  for (const s of sorted) {
    if (s.a > curB) { if (curB > curA) total += curB - curA; curA = s.a; curB = s.b; }
    else if (s.b > curB) curB = s.b;
  }
  if (curB > curA) total += curB - curA;
  return total;
}

function sampleState(s: LevelPoint): "dead_mic" | "quiet" | "active" {
  const amp = s.avg ?? s.peak;
  const db = dbfs(amp);
  if ((s.zero_ratio != null && s.zero_ratio >= DEAD_MIC_ZERO_RATIO) || db <= DEAD_MIC_DBFS) return "dead_mic";
  return amp >= ENERGY_ACTIVE_MIN ? "active" : "quiet";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * PURE. `covered(start, end)` is true only when a stored Nemotron window spans the whole row.
 * `who` on the input wins; it is filtered to the letter allowlist.
 */
export function buildRowFeatures(input: {
  rows: readonly FeatureRowIn[];
  turns: readonly FeatureTurn[];
  levels: readonly LevelPoint[];
  covered: (start_ms: number, end_ms: number) => boolean;
}): FeatureRow[] {
  return input.rows.map((row) => {
    const span = row.end_ms - row.start_ms;
    const cover = span > 0 && input.covered(row.start_ms, row.end_ms);
    const clipped = cover
      ? input.turns
        .map((t) => ({ a: Math.max(t.start_ms, row.start_ms), b: Math.min(t.end_ms, row.end_ms) }))
        .filter((t) => t.b > t.a)
      : [];
    const speech = unionMs(clipped);
    const levels = input.levels.filter((s) => s.t_ms >= row.start_ms && s.t_ms < row.end_ms);
    const dbs = levels.map((s) => {
      const amp = s.avg ?? s.peak;
      return amp > 0 ? dbfs(amp) : DEAD_MIC_DBFS;
    });
    const med = median(dbs);
    let events: number | null = null;
    if (levels.length >= 2) {
      events = 0;
      let prev = sampleState(levels[0]!);
      for (let i = 1; i < levels.length; i++) {
        const st = sampleState(levels[i]!);
        if (st !== prev) { events++; prev = st; }
      }
    }
    const who = (row.who ?? []).filter((w) => LABEL_RE.test(w));
    return {
      t: row.t,
      who,
      loud_db: med == null || !Number.isFinite(med) ? null : Math.round(med),
      silence_s: cover ? Math.max(0, Math.round((span - speech) / 1000)) : null,
      mean_turn_s: cover && clipped.length ? Math.max(0, Math.round(speech / clipped.length / 1000)) : null,
      overlap_s: cover && row.overlap_s != null && Number.isFinite(row.overlap_s) ? Math.round(row.overlap_s) : null,
      level_events: events,
      pitch: null,
    };
  });
}

/** PURE — true when a feature list is safe to store or show: letters, relative times, numbers, null pitch. */
export function featuresAreWordFree(rows: readonly FeatureRow[]): boolean {
  const tRe = /^t[+-]\d{2,4}:[0-5]\d(\.\.t[+-]\d{2,4}:[0-5]\d)?$/;
  return rows.every((r) =>
    tRe.test(r.t)
    && r.who.every((w) => LABEL_RE.test(w))
    && r.pitch === null
    && [r.loud_db, r.silence_s, r.mean_turn_s, r.overlap_s, r.level_events].every((n) => n === null || (typeof n === "number" && Number.isInteger(n) && n >= -120 && n <= 9999)));
}
