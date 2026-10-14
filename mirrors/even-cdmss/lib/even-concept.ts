/**
 * lib/even-concept.ts — IMPURE Concept Coder worker (Phase 1, CDMSS-CONCEPT-CODER-PRD v1.0 §3/§5).
 * Cron-drained, bounded per tick, resumable via even_concept_state, haltable via even_concept_paused.
 * Mirrors lib/even-ground.ts, which is the nearest precedent.
 *
 * Every write is ADDITIVE + SCORE-INVARIANT — only opd_note_audits.findings[].concept_id and
 * .concept_context. NO verdict/confidence/domain/score/band/lvc_category is read or written, and the
 * writeback SQL names no score column. computeOpdScore reads only (verdict, confidence, domain), so
 * this is structurally incapable of moving a score (PRD §3; asserted in tests).
 *
 * R-11 (PRD §7): the extractor is given a finding STRING and nothing else — never a note, never the
 * audit context — and its output never returns to the audit model. It parses grammar; it does not
 * judge quality.
 *
 * ⚠️ SQL HONESTY: no live DB in the sandbox — every query below is INFERRED from the shipped shapes
 * (even-ground's candidate/writeback/watermark SQL, migrations/0020_lvc_concepts.sql). All paths are
 * FAIL-SAFE: a per-note or per-string error skips+logs, never a 500, never a wrong write. Listed
 * verbatim in the build report for validation against live Neon before the cron is enabled.
 */
import { sql } from './db';
import { getSettings, setSetting } from './mini-backfill';
import { governedChat, startTrace, finishTraceIfRunning } from './trace';
import { OPD_ENGINE_VERSIONS_CURRENT } from './opd-note-audit-core';
import {
  normalizeConceptSubject, stampConcepts, pendingSubjects, validateExtraction, baseConceptId,
  type ConceptAssignment, type ExtractionReject, type ConceptStatusRaw, type ConceptTickRow,
} from './even-concept-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export const EC_KEYS = { epoch: 'even_concept_epoch', lock: 'even_concept_lock', paused: 'even_concept_paused' } as const;
export const EC_BATCH = Math.max(1, Math.min(1000, parseInt(process.env.LVC_CONCEPT_BATCH || '200', 10) || 200));
/** Hard ceiling on model calls per tick — extraction is per UNIQUE STRING (~2,400/week), and this keeps
 *  a single tick's cost and wall-clock bounded regardless of how many misses a batch surfaces. */
export const EC_EXTRACT_BUDGET = Math.max(0, Math.min(200, parseInt(process.env.LVC_CONCEPT_EXTRACT_BUDGET || '40', 10) || 40));
export const EC_LOCK_TTL_MS = 5 * 60 * 1000;
/** One cheap model, pinned. temperature 0 + strict JSON out (PRD §5). */
export const EC_MODEL = process.env.LVC_CONCEPT_MODEL || 'google/gemini-2.5-flash';

// ── the extraction prompt (governed; registered in the reasoning registry) ───────
// STRUCTURAL ONLY (PRD §7): the closed direction vocabulary carries no clinical position, and there is
// deliberately NO enumerated target vocabulary — listing drugs would tell the model which drugs are
// low-value candidates, which is squarely R-11 and out of scope for this build.
export const CONCEPT_EXTRACT_SYSTEM = `You parse the GRAMMAR of a short clinical audit finding string. You do not judge clinical quality, and you never decide whether the finding is correct.

Return STRICT JSON, one object, no prose and no code fence:
{"direction":"...","action":"...","target":"...","context":"..."}

direction — exactly one of: overuse | underuse | documentation | process
  overuse       something was done that arguably should not have been
  underuse      something was NOT done that arguably should have been
  documentation something was not recorded, unclear, or internally inconsistent
  process       a workflow/administrative step, not a clinical decision

action  — the verb-ish category, lowercase, 1-2 words (e.g. rx, investigation, imaging, duplication, combo_rx, counseling, followup, documentation)
target  — WHAT the action applies to, lowercase, as written in the string (a drug, a test, a document element). Do not expand abbreviations. Do not substitute a brand for a molecule.
context — the clinical situation the string names, lowercase, or "" if the string names none. Never invent one.

CRITICAL: direction is decided by what the string ASSERTS, not by keywords. "antibiotic prescribed without documented indication" is overuse. "antibiotic not prescribed despite documented UTI" is underuse. Read the whole clause before choosing.

If you cannot read the string, return {"direction":"","action":"","target":"","context":""} — never guess.`;

export function buildConceptExtractUser(norm: string): string {
  return `Finding string:\n"""${norm.slice(0, 400)}"""\n\nReturn the JSON object.`;
}

// ── INFERRED SQL (validate verbatim against live Neon) ──────────────────────────
// Newest-first, epoch-aware candidate drain. engine_version is SELECTED so the writeback can target the
// exact (uid, engine_version) row — opd_note_audits is keyed by (uid, engine_version).
// DEFECT A FIX (26 Jul): the join is on (uid, engine_version), matching the grain opd_note_audits is
// actually keyed at and the grain WRITEBACK_SQL targets. Keyed on uid alone, ONE watermark row
// certified only ONE engine row and the `s.uid IS NULL OR ...` predicate then excluded every other
// engine row for that uid permanently — 256 in-family findings across 201 uids were unreachable.
// The rest of the WHERE clause is deliberately unchanged: ALL engine versions stay candidates, because
// legacy strings warm the lvc_concept_strings cache and may recur live (V's decision). Provenance, not
// exclusion, is how Phase 2 separates them — see in_family on the watermark.
const CANDIDATE_SELECT_SQL = `SELECT a.uid, a.engine_version, a.findings
  FROM opd_note_audits a
  LEFT JOIN even_concept_state s ON s.uid = a.uid AND s.engine_version = a.engine_version
  WHERE a.app_source = $1 AND a.excluded_reason IS NULL
    AND a.findings @> '[{"verdict":"low-value"}]'
    AND (s.uid IS NULL OR s.coded_epoch < $2)
  ORDER BY a.note_date DESC
  LIMIT $3`;

// Additive writeback — the findings jsonb ONLY. NO score column is named.
const WRITEBACK_SQL = `UPDATE opd_note_audits SET findings = $1::jsonb WHERE uid = $2 AND engine_version = $3`;

// Carries engine_version + in_family; conflict target is the composite key from migration 0021.
const WATERMARK_UPSERT_SQL = `INSERT INTO even_concept_state (uid, engine_version, in_family, coded_epoch, coded_at, n_stamped)
  VALUES ($1, $2, $3, $4, now(), $5)
  ON CONFLICT (uid, engine_version) DO UPDATE SET coded_epoch = EXCLUDED.coded_epoch,
    in_family = EXCLUDED.in_family, coded_at = now(), n_stamped = EXCLUDED.n_stamped`;

const CACHE_GET_MANY_SQL = `SELECT norm, concept_id, context FROM lvc_concept_strings WHERE norm = ANY($1::text[])`;
const CACHE_PUT_SQL = `INSERT INTO lvc_concept_strings (norm, concept_id, context, confidence, source, model, extracted_at)
  VALUES ($1,$2,$3,$4,'extracted',$5, now()) ON CONFLICT (norm) DO NOTHING`;

// Concept upsert — first_seen preserved; n_strings and last_seen advanced. NEITHER volume NOR
// live_volume is touched here (DEFECT C: the old comment claimed volume was advanced; it never was).
//   · `volume` holds the RESEARCH TEAM'S SEED measurement and is deliberately never overwritten —
//     it has evidential value and predicted the live distribution well.
//   · `live_volume` is advanced only by the bulk recompute below, never per-stamp: incrementing per
//     stamp would double-count across an epoch re-drain, since a re-drain re-stamps the same finding.
// review_lane is likewise NOT recomputed here — a whole-corpus property, deferred to a bulk pass.
const CONCEPT_UPSERT_SQL = `INSERT INTO lvc_concepts (concept_id, direction, action, target, n_strings, volume, review_lane, first_seen, last_seen)
  VALUES ($1,$2,$3,$4,1,0,'clean', now(), now())
  ON CONFLICT (concept_id) DO UPDATE SET n_strings = lvc_concepts.n_strings + 1, last_seen = now()`;

/**
 * Bulk `live_volume` recompute (DEFECT C). Counts coded findings per concept over IN-FAMILY rows
 * ONLY, so the ranking Phase 2 reads reflects what a user-facing surface can actually see — every
 * read surface filters on OPD_ENGINE_VERSIONS_CURRENT.
 *
 * IDEMPOTENT and safe to re-run: it SETs an absolute count (never increments), and zeroes concepts
 * with no in-family coded findings so a stale figure cannot survive a re-run. The seed `volume`
 * column is never touched.
 */
const LIVE_VOLUME_RECOMPUTE_SQL = `WITH per AS (
    SELECT f->>'concept_id' AS cid, count(*)::int AS n
    FROM opd_note_audits a, LATERAL jsonb_array_elements(a.findings) f
    WHERE a.app_source = $1 AND a.excluded_reason IS NULL
      AND a.engine_version = ANY($2)
      AND f->>'verdict' = 'low-value' AND (f->>'informational') IS DISTINCT FROM 'true'
      AND f->>'concept_id' IS NOT NULL
    GROUP BY 1)
  UPDATE lvc_concepts c
     SET live_volume = coalesce(p.n, 0)
    FROM (SELECT concept_id FROM lvc_concepts) AS all_c
    LEFT JOIN per p ON p.cid = all_c.concept_id
   WHERE c.concept_id = all_c.concept_id
     AND c.live_volume IS DISTINCT FROM coalesce(p.n, 0)`;

export interface LiveVolumeResult { updated: number; concepts_nonzero: number; total_live_volume: number }

/** Run the bulk live_volume recompute. Read-mostly; touches only lvc_concepts.live_volume. */
export async function recomputeLiveVolume(): Promise<LiveVolumeResult> {
  await run(LIVE_VOLUME_RECOMPUTE_SQL, [APP, [...OPD_ENGINE_VERSIONS_CURRENT]]);
  const r = await run(
    `SELECT count(*) FILTER (WHERE live_volume > 0)::int AS nonzero,
            coalesce(sum(live_volume),0)::int AS total FROM lvc_concepts`, []).catch(() => []);
  const row = (r[0] ?? {}) as Record<string, unknown>;
  return {
    updated: Number(row.nonzero ?? 0),
    concepts_nonzero: Number(row.nonzero ?? 0),
    total_live_volume: Number(row.total ?? 0),
  };
}

const TICK_INSERT_SQL = `INSERT INTO even_concept_ticks (status, processed, stamped, extracted, rejected, epoch, note)
  VALUES ($1,$2,$3,$4,$5,$6,$7)`;

// ── settings helpers (mirror even-ground) ───────────────────────────────────────
export async function getEpoch(): Promise<number> {
  const s = await getSettings([EC_KEYS.epoch]);
  const n = Number(s[EC_KEYS.epoch]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
export async function bumpEpoch(): Promise<void> {
  try { const e = await getEpoch(); await setSetting(EC_KEYS.epoch, String(e + 1)); } catch { /* best-effort */ }
}
export async function isPaused(): Promise<boolean> {
  try { const s = await getSettings([EC_KEYS.paused]); return s[EC_KEYS.paused] === '1'; } catch { return false; }
}
export async function setPaused(paused: boolean): Promise<void> {
  await setSetting(EC_KEYS.paused, paused ? '1' : '0');
}

async function logTick(t: { status: string; processed?: number; stamped?: number; extracted?: number; rejected?: number; epoch?: number | null; note?: string | null }): Promise<void> {
  try {
    await run(TICK_INSERT_SQL, [t.status, t.processed ?? 0, t.stamped ?? 0, t.extracted ?? 0, t.rejected ?? 0, t.epoch ?? null, t.note ?? null]);
    await run(`DELETE FROM even_concept_ticks WHERE ts < NOW() - interval '30 days'`, []).catch(() => {});
  } catch { /* observability must never break the worker */ }
}

function parseJsonArr<T>(v: unknown, fb: T): T {
  if (v == null) return fb;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fb; }
}

/** Batch cache read. Fail-safe ⇒ empty map (a tick then extracts, or stamps nothing — never wrong). */
async function loadCache(norms: string[]): Promise<Map<string, ConceptAssignment>> {
  const m = new Map<string, ConceptAssignment>();
  if (norms.length === 0) return m;
  try {
    const rows = await run(CACHE_GET_MANY_SQL, [norms]);
    for (const r of rows) {
      const n = String(r.norm ?? '');
      if (n) m.set(n, { concept_id: String(r.concept_id ?? ''), context: r.context == null ? null : String(r.context) });
    }
  } catch { /* fail-safe: empty */ }
  return m;
}

export interface ExtractOutcome { ok: boolean; reason?: ExtractionReject | 'call_failed'; assignment?: ConceptAssignment }

/**
 * ONE extraction call for ONE unseen string. temperature 0, strict JSON, routed through governedChat
 * with a REAL traceId so the call is observable. On ANY failure — call error, unparseable body, a
 * direction outside the closed vocabulary — this logs and returns ok:false, and the caller leaves the
 * finding UNSTAMPED. There is deliberately no fallback that guesses (PRD §5).
 */
export async function extractOne(norm: string, traceId?: string): Promise<ExtractOutcome> {
  let raw = '';
  try {
    const completion = await governedChat(
      traceId, 'concept-extract',
      {
        model: EC_MODEL,
        messages: [{ role: 'system', content: CONCEPT_EXTRACT_SYSTEM }, { role: 'user', content: buildConceptExtractUser(norm) }],
        temperature: 0, top_p: 1, max_tokens: 200,
        response_format: { type: 'json_object' },
      },
      { openrouter: EC_MODEL, promptRef: 'even-concept/CONCEPT_EXTRACT_SYSTEM' },
    ) as { choices?: Array<{ message?: { content?: string } }> };
    raw = String(completion?.choices?.[0]?.message?.content ?? '');
  } catch (e) {
    console.warn('[even-concept] extraction call failed', norm.slice(0, 60), String((e as Error).message).slice(0, 120));
    return { ok: false, reason: 'call_failed' };
  }
  const v = validateExtraction(raw);
  if (!v.ok) {
    console.warn('[even-concept] extraction rejected', v.reason, norm.slice(0, 60));
    return { ok: false, reason: v.reason };
  }
  return { ok: true, assignment: { concept_id: v.conceptId, context: v.slots.context } };
}

// ── the tick ────────────────────────────────────────────────────────────────────
export interface TickResult {
  status: 'ok' | 'idle' | 'paused' | 'locked' | 'error';
  processed: number; stamped: number; extracted: number; rejected: number; epoch: number;
}

export async function runConceptTick(opts: { trigger: 'cron' | 'manual' }): Promise<TickResult> {
  const epoch = await getEpoch();
  const zero = { processed: 0, stamped: 0, extracted: 0, rejected: 0 };

  // 1) SOFT PAUSE first — checked before anything else; codes nothing.
  if (await isPaused()) { await logTick({ status: 'paused', epoch, note: opts.trigger }); return { status: 'paused', ...zero, epoch }; }

  // 2) best-effort single-flight lock.
  try {
    const s = await getSettings([EC_KEYS.lock]);
    const held = s[EC_KEYS.lock] && Number.isFinite(Date.parse(s[EC_KEYS.lock])) && (Date.now() - Date.parse(s[EC_KEYS.lock])) < EC_LOCK_TTL_MS;
    if (held) { await logTick({ status: 'locked', epoch, note: opts.trigger }); return { status: 'locked', ...zero, epoch }; }
    await setSetting(EC_KEYS.lock, new Date().toISOString());
  } catch { /* lock probe failed ⇒ proceed (a duplicate tick only re-stamps identically) */ }

  let processed = 0, stamped = 0, extracted = 0, rejected = 0;
  let traceId: string | undefined;
  try {
    const rows = await run(CANDIDATE_SELECT_SQL, [APP, epoch, EC_BATCH]).catch(() => [] as Record<string, unknown>[]);
    if (rows.length === 0) { await logTick({ status: 'idle', epoch, note: opts.trigger }); return { status: 'idle', ...zero, epoch }; }

    // 3) collect every distinct un-coded subject across the batch, then load the cache ONCE.
    const parsedRows = rows.map((r) => ({
      uid: String(r.uid ?? ''), engineVersion: String(r.engine_version ?? ''),
      findings: parseJsonArr<Record<string, unknown>[]>(r.findings, []),
    })).filter((r) => r.uid && r.engineVersion);

    const allNorms = new Set<string>();
    for (const r of parsedRows) for (const n of pendingSubjects(r.findings as never, () => false)) allNorms.add(n);
    const cache = await loadCache([...allNorms]);

    // 4) extract the misses, bounded by the per-tick budget. One call per UNSEEN STRING, ever.
    const misses = [...allNorms].filter((n) => !cache.has(n));
    if (misses.length > 0 && EC_EXTRACT_BUDGET > 0) {
      traceId = await startTrace('concept-extract', { model: EC_MODEL, misses: misses.length, budget: EC_EXTRACT_BUDGET })
        .catch(() => undefined as string | undefined);
      for (const norm of misses.slice(0, EC_EXTRACT_BUDGET)) {
        const out = await extractOne(norm, traceId);
        if (!out.ok || !out.assignment) { rejected++; continue; }   // log, skip, leave unstamped
        cache.set(norm, out.assignment);
        extracted++;
        // persist the cache row + register the concept. Both best-effort: a failed write costs one
        // re-extraction later, never a wrong stamp.
        await run(CACHE_PUT_SQL, [norm, out.assignment.concept_id, out.assignment.context, null, EC_MODEL]).catch(() => {});
        const base = baseConceptId(out.assignment.concept_id).split(':');
        if (base.length === 3) await run(CONCEPT_UPSERT_SQL, [out.assignment.concept_id, base[0], base[1], base[2]]).catch(() => {});
      }
    }

    // 5) stamp. Pure + additive; a miss leaves the finding untouched.
    for (const r of parsedRows) {
      try {
        const res = stampConcepts(r.findings as never, (n) => cache.get(n) ?? null);
        if (res.stamped > 0) {
          await run(WRITEBACK_SQL, [JSON.stringify(res.findings), r.uid, r.engineVersion]);
          stamped += res.stamped;
        }
        // Watermark EVERY processed note (incl 0-stamp) so it isn't re-scanned until the epoch bumps.
        // Keyed on (uid, engine_version) — one row per ENGINE ROW, not per uid (defect A). in_family
        // records whether any user-facing surface can read this note, since they all filter on
        // OPD_ENGINE_VERSIONS_CURRENT; it is provenance for Phase 2, never a candidacy filter here.
        const inFamily = (OPD_ENGINE_VERSIONS_CURRENT as readonly string[]).includes(r.engineVersion);
        await run(WATERMARK_UPSERT_SQL, [r.uid, r.engineVersion, inFamily, epoch, res.stamped]).catch(() => {});
        processed++;
      } catch (e) {
        console.warn('[even-concept] note skipped', r.uid, String((e as Error).message).slice(0, 120));
      }
    }

    if (traceId) await finishTraceIfRunning(traceId, 'success').catch(() => {});
    await logTick({ status: 'ok', processed, stamped, extracted, rejected, epoch, note: opts.trigger });
    return { status: 'ok', processed, stamped, extracted, rejected, epoch };
  } catch (e) {
    if (traceId) await finishTraceIfRunning(traceId, 'error', String((e as Error).message).slice(0, 200)).catch(() => {});
    await logTick({ status: 'error', processed, stamped, extracted, rejected, epoch, note: String((e as Error).message).slice(0, 200) });
    return { status: 'error', processed, stamped, extracted, rejected, epoch };
  } finally {
    try { await setSetting(EC_KEYS.lock, ''); } catch { /* best-effort release */ }
  }
}

/**
 * Worker-page status payload. Read-only; EVERY aggregate independently soft-fails to null so one slow
 * or failing query degrades a tile rather than blanking the panel. NO PHI and NO doctor identifier is
 * selected anywhere here — counts only.
 *
 * ⚠️ INFERRED SQL, same discipline as the tick above. The coded/candidate counts unnest findings
 * jsonb (the `quietedVolume30d` precedent does the same); they are the two heaviest statements on
 * this page, which is why they share ONE scan.
 */
export async function loadConceptStatusRaw(enabled: boolean): Promise<ConceptStatusRaw> {
  const epoch = await getEpoch().catch(() => 1);
  const paused = await isPaused().catch(() => false);
  const one = async <T>(q: string, p: unknown[], k: string, cast: (v: unknown) => T, dflt: T): Promise<T> =>
    run(q, p).then((r) => (r.length ? cast((r[0] as Record<string, unknown>)[k]) : dflt)).catch(() => dflt);

  // ONE scan for both: eligible findings (low-value, non-informational) and those already carrying a
  // concept_id. `informational` is absent on most findings, so the test is IS DISTINCT FROM 'true'.
  const counts = await run(
    `SELECT count(*) FILTER (WHERE f->>'concept_id' IS NOT NULL)::int AS coded,
            count(*)::int AS candidates
     FROM opd_note_audits a, LATERAL jsonb_array_elements(a.findings) f
     WHERE a.app_source = $1 AND a.excluded_reason IS NULL
       AND f->>'verdict' = 'low-value' AND (f->>'informational') IS DISTINCT FROM 'true'`, [APP])
    .then((r) => (r.length ? r[0] as Record<string, unknown> : null)).catch(() => null);

  // NOT REACHED ≠ tried-and-failed: eligible findings on notes with no watermark row at all. Keeping
  // these separate from `rejected` is the whole point of the two tiles.
  const notYetCoded = await one<number | null>(
    `SELECT count(*)::int n
     FROM opd_note_audits a
     LEFT JOIN even_concept_state s ON s.uid = a.uid,
     LATERAL jsonb_array_elements(a.findings) f
     WHERE a.app_source = $1 AND a.excluded_reason IS NULL AND s.uid IS NULL
       AND f->>'verdict' = 'low-value' AND (f->>'informational') IS DISTINCT FROM 'true'`, [APP], 'n', Number, null);

  const stringsExtracted7d = await one<number | null>(
    `SELECT count(*)::int n FROM lvc_concept_strings WHERE source='extracted' AND extracted_at > now() - interval '7 days'`, [], 'n', Number, null);
  const concepts = await one<number | null>(`SELECT count(*)::int n FROM lvc_concepts`, [], 'n', Number, null);
  const stringsSeed = await one<number | null>(`SELECT count(*)::int n FROM lvc_concept_strings WHERE source='seed'`, [], 'n', Number, null);

  const tickRows = await run(
    `SELECT to_char(ts,'YYYY-MM-DD"T"HH24:MI:SS') AS ts, status, processed, stamped, extracted, rejected, epoch, note
     FROM even_concept_ticks ORDER BY ts DESC LIMIT 6`, []).catch(() => [] as Record<string, unknown>[]);
  const recentTicks: ConceptTickRow[] = tickRows.map((r) => ({
    ts: String(r.ts ?? ''), status: String(r.status ?? ''), processed: Number(r.processed ?? 0),
    stamped: Number(r.stamped ?? 0), extracted: Number(r.extracted ?? 0), rejected: Number(r.rejected ?? 0),
    epoch: r.epoch == null ? null : Number(r.epoch), note: r.note == null ? null : String(r.note),
  }));

  return {
    enabled, paused, epoch,
    coded: counts ? Number(counts.coded ?? 0) : null,
    candidates: counts ? Number(counts.candidates ?? 0) : null,
    notYetCoded, stringsExtracted7d, concepts, stringsSeed,
    lastTick: recentTicks[0] ?? null, recentTicks,
  };
}

/**
 * Stamp-coverage report (PRD §6 Phase 1 gate). Read-only; each aggregate soft-fails to null.
 *
 * ⚠️ GRAIN — read this before quoting any figure from here in Phase 2. THREE different denominators
 * are in play and they are NOT interchangeable:
 *   · FINDING  — one low-value, non-informational element of opd_note_audits.findings. This is what
 *                `coded` / `candidates` on the status payload count, and what a concept's volume is.
 *   · AUDIT ROW — one (uid, engine_version) pair. `even_concept_state` has one row per audit row,
 *                NOT one per note, since migration 0021 re-keyed it. A single note re-audited under
 *                four engine versions is FOUR audit rows.
 *   · NOTE     — one uid, i.e. one prescription. Always ≤ audit rows.
 * The in-family share differs by grain — measured 26 Jul it was ~22% out-of-family by NOTE and ~30%
 * by AUDIT ROW. Quoting one as the other overstates or understates legacy exposure by a third.
 *
 * `inFamilyLabelled` is deliberately reported against the total: family provenance backfills only as
 * the corrected join re-walks each audit row, so it climbs from ~0% to complete over the drain rather
 * than being populated at migration time. A partial figure here means "still filling", not "broken".
 */
export async function loadConceptCoverage(): Promise<Record<string, number | null>> {
  const one = async (q: string, p: unknown[] = []) =>
    run(q, p).then((r) => (r.length ? Number((r[0] as Record<string, unknown>).n ?? 0) : null)).catch(() => null);
  return {
    cachedStrings: await one(`SELECT count(*)::int n FROM lvc_concept_strings`),
    seededStrings: await one(`SELECT count(*)::int n FROM lvc_concept_strings WHERE source='seed'`),
    extractedStrings: await one(`SELECT count(*)::int n FROM lvc_concept_strings WHERE source='extracted'`),
    concepts: await one(`SELECT count(*)::int n FROM lvc_concepts`),
    // AUDIT ROWS, not notes — one per (uid, engine_version).
    auditRowsCoded: await one(`SELECT count(*)::int n FROM even_concept_state`),
    // NOTES — distinct uids, the smaller and more intuitive denominator.
    notesCoded: await one(`SELECT count(DISTINCT uid)::int n FROM even_concept_state`),
    findingsStamped: await one(`SELECT coalesce(sum(n_stamped),0)::int n FROM even_concept_state`),
    // Family provenance fills in as the re-walk proceeds; unlabelled rows are pre-0021 watermarks.
    inFamilyLabelled: await one(`SELECT count(*)::int n FROM even_concept_state WHERE in_family IS NOT NULL`),
    inFamilyUnlabelled: await one(`SELECT count(*)::int n FROM even_concept_state WHERE in_family IS NULL`),
  };
}
