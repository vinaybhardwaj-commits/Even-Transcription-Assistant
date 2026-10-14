/**
 * lib/ccb-worklist-core.ts — Care Conversation Brief: the /care/briefs flagged-list core.
 *
 * PURE. No db, no network, no env. Extracted verbatim from app/care/briefs/page.tsx so the
 * query and the signal precedence can be unit-tested and timed. This is a MOVE, not an
 * improvement: the SQL below is byte-for-byte the query the page ran at f818411 — no index
 * hints, no shape changes, no reordering. Any behaviour change here is a bug.
 *
 * `pickSignal` is the JS mirror of the SQL's `coalesce(...)` signal picker. Nothing calls it in
 * production today (the signal is still computed in Postgres); it exists so the precedence rules
 * are pinned by tests and so a future caller can reproduce them off a fetched envelope.
 */

/** One row of the flagged list, as the page renders it. */
export type Flagged = {
  individual_uid: string;
  uhid: string | null;
  presc_uid: string;
  date: string | null;
  citation_coverage_pct: number | null;
  priority: string | null;
  coverage: string | null;
  doctor_speciality: string | null;
  signal: string | null;
};

/**
 * Members flagged for a conversation: one row per member (best-grounded flagged episode), with a
 * plain-language signal pulled from the stored brief (the cited surgical/specialist indication).
 *
 * Parameterized: `$1` is the engine version. It is NEVER interpolated into the text.
 */
export function flaggedListSql(): string {
  return `SELECT individual_uid, uhid, presc_uid, note_date_ist AS date, citation_coverage_pct, priority, coverage, doctor_speciality, signal
       FROM (
         SELECT DISTINCT ON (individual_uid)
           individual_uid, uhid, presc_uid,
           to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date_ist,
           citation_coverage_pct, priority, coverage, doctor_speciality,
           coalesce(
             (SELECT f->>'claim' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(envelope->'clinical')='array' THEN envelope->'clinical' ELSE '[]'::jsonb END) f
                WHERE f->>'id' IN (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(envelope->'commercial'->'gated_on')='array' THEN envelope->'commercial'->'gated_on' ELSE '[]'::jsonb END)) LIMIT 1),
             (SELECT f->>'claim' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(envelope->'clinical')='array' THEN envelope->'clinical' ELSE '[]'::jsonb END) f
                WHERE f->>'kind' IN ('surgical_indication','speciality') LIMIT 1)
           ) AS signal,
           created_at
         FROM ccb_briefs
         WHERE engine_version = $1 AND pitch_allowed = true AND individual_uid IS NOT NULL
         ORDER BY individual_uid, citation_coverage_pct DESC NULLS LAST, created_at DESC
       ) x
       ORDER BY citation_coverage_pct DESC NULLS LAST, note_date_ist DESC
       LIMIT 30`;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Postgres `->>` renders any scalar as text and yields SQL NULL for JSON null / objects / absent
 * keys. Mirror that: scalars stringify, everything else is null.
 */
function claimText(f: Record<string, unknown>): string | null {
  const c = f.claim;
  if (typeof c === 'string') return c;
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  return null;
}

/**
 * The signal precedence, exactly as the SQL coalesce computes it:
 *   1. the claim of the FIRST clinical finding whose `id` appears in `commercial.gated_on`;
 *   2. else the claim of the FIRST clinical finding whose `kind` is surgical_indication|speciality.
 *
 * Note the LIMIT-1 subtlety this mirrors: branch 1 picks the first gated match and returns ITS
 * claim. If that claim is null, `coalesce` falls to branch 2 — it does NOT try the second gated
 * match. Malformed / non-array `clinical` or `gated_on` degrade to empty (the jsonb_typeof guards).
 */
export function pickSignal(envelope: unknown): string | null {
  if (!isRec(envelope)) return null;

  const clinical: unknown[] = Array.isArray(envelope.clinical) ? envelope.clinical : [];
  if (!clinical.length) return null;

  const commercial = envelope.commercial;
  const gatedRaw: unknown[] =
    isRec(commercial) && Array.isArray(commercial.gated_on) ? commercial.gated_on : [];
  const gatedIds = new Set(gatedRaw.filter((x): x is string => typeof x === 'string'));

  // Branch 1 — first finding whose id is gated on (LIMIT 1, then coalesce).
  if (gatedIds.size) {
    const hit = clinical.find((f) => isRec(f) && typeof f.id === 'string' && gatedIds.has(f.id));
    if (isRec(hit)) {
      const claim = claimText(hit);
      if (claim !== null) return claim;
    }
  }

  // Branch 2 — first finding of a qualifying kind.
  const alt = clinical.find(
    (f) => isRec(f) && (f.kind === 'surgical_indication' || f.kind === 'speciality'),
  );
  if (isRec(alt)) return claimText(alt);

  return null;
}

/**
 * Bounded race with a fail-safe fallback — the house pattern from lib/metabase.ts's
 * `raceTimeout()` (§ complexity history bundle), with the caller's `.catch()` folded in so a
 * rejection can never escape. Resolves `fallback` on timeout AND on rejection; never rejects.
 *
 * The timer is cleared once the race settles, so a fast result does not hold the event loop open
 * for the remainder of `ms` (matters for the test runner and for serverless freeze).
 */
export function boundedRace<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([Promise.resolve(p).catch(() => fallback), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
