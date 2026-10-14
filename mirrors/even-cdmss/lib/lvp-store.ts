/**
 * lib/lvp-store.ts — Low-value patterns L1: the IO layer (Neon).
 *
 * The ONLY persistent store is `lvp_hidden` (append-only hide/unhide rows, latest wins — the
 * opd_audit_triage idiom; migration 0036, executable via /api/admin/migrate-lvp-hidden). The
 * Suggested list is computed ON READ from concept stamps (`findings[].concept_id` on
 * opd_note_audits, O4/O7) joined to lvc_concepts for direction/action/target/first_seen —
 * no pattern rows are written anywhere.
 *
 * ⚠️ Every SQL string here is INFERRED (the sandbox has no live DB — kickoff §8); the reference
 * aggregate ran against the lab mirror on 20 Aug 2026. Fail-safe: loadShelf degrades to an
 * empty shelf on any data-layer error, never wrong data; a hide append either lands whole
 * (single INSERT) or errors with no partial write.
 *
 * NOTHING here reads or writes opd_audit_triage, opd_gov_signal, or any score column, and the
 * list path contains no INSERT/UPDATE (kickoff §6, acceptance 11).
 */

import { sql } from './db';
import {
  conceptIdFromPatternId, formatDisplayDate, parseConceptId, patternIdFor, patternTitle,
  shelveSuggestions, statusPill, stripIdentifiers, whyText,
} from './lvp-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// ── DDL (migration 0036 — reference copy in migrations/0036_lvp_hidden.sql) ─────────────────────
export async function ensureLvpHiddenTable(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS lvp_hidden (
    id         bigserial PRIMARY KEY,
    pattern_id text NOT NULL,
    action     text NOT NULL CHECK (action IN ('hide','unhide')),
    cm_user    text NOT NULL DEFAULT 'care-manager',
    reason     text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS lvp_hidden_pattern_idx ON lvp_hidden (pattern_id, created_at DESC)`, []);
}

// ── row shapes returned to the list route (§6) ──────────────────────────────────────────────────
export interface SuggestedPattern {
  pattern_id: string;
  concept_id: string;
  direction: string;
  action: string;
  target: string;
  title: string;
  why: string;
  pill: string;                 // 'not a ding' | 'probably not overuse'
  volume_week: number;
  doctor_count: number | null;  // null = unknown → the card omits the spread zone
  first_seen: string | null;    // display date ('12 Jul 2026') or null → the card omits `since`
  examples: string[];           // 0–3 × '{date} — {stripped subject}'
  generated_at: string;
  // L2: the operator model that wrote this card's title and why, or 'stub' when nothing decorated
  // it. Widened from the 'stub' literal; components/care/PatternsShelf.tsx already types it `string`.
  model: string;
}

export interface HiddenPattern {
  pattern_id: string;
  concept_id: string | null;
  title: string;
  cm_user: string;
  reason: string | null;
  hidden_at: string | null;     // display date (IST)
}

export interface LvpShelf {
  suggested: SuggestedPattern[];
  hidden: HiddenPattern[];
}

// ── SQL (all INFERRED; listed verbatim in the build report) ─────────────────────────────────────

// The kickoff §2 reference aggregate, verbatim: last-7-IST-days stamped low-value findings.
const WEEK_AGGREGATE_SQL = `SELECT f->>'concept_id' AS concept_id,
       count(*)::int AS volume_week,
       count(DISTINCT doctor_uid)::int AS doctor_count
FROM opd_note_audits, jsonb_array_elements(findings) f
WHERE note_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 7
  AND f->>'verdict' = 'low-value'
  AND f->>'concept_id' IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC`;

// Governed-dictionary join — authoritative for direction/action/target when the row exists (§4.3).
const CONCEPT_META_SQL = `SELECT concept_id, direction, action, target,
       to_char(first_seen AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS first_seen
FROM lvc_concepts WHERE concept_id = ANY($1)`;

// 0–3 most recent example findings per visible concept (week window only).
const EXAMPLES_SQL = `SELECT concept_id, note_date, subject FROM (
  SELECT f->>'concept_id' AS concept_id,
         to_char(a.note_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS note_date,
         f->>'subject' AS subject,
         row_number() OVER (PARTITION BY f->>'concept_id' ORDER BY a.note_date DESC) AS rn
  FROM opd_note_audits a, jsonb_array_elements(a.findings) f
  WHERE a.note_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 7
    AND f->>'verdict' = 'low-value'
    AND f->>'concept_id' = ANY($1)
) t WHERE rn <= 3`;

// Latest-wins hide state (the opd-triage DISTINCT ON idiom; id DESC breaks created_at ties).
const HIDDEN_LATEST_SQL = `SELECT pattern_id, cm_user, reason,
       to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS hidden_on
FROM (
  SELECT DISTINCT ON (pattern_id) pattern_id, action, cm_user, reason, created_at
  FROM lvp_hidden ORDER BY pattern_id, created_at DESC, id DESC
) latest WHERE action = 'hide'`;

const APPEND_SQL = `INSERT INTO lvp_hidden (pattern_id, action, cm_user, reason) VALUES ($1, $2, $3, $4)`;

// L2 (O11): the operator's copy for the kinds that have any. A LEFT JOIN in spirit — read after the
// shelf is decided, for the shelved head only, and applied to two string zones. It cannot move a
// number, a sort position or a cap, because by the time it runs all of those are already fixed.
const DECORATIONS_SQL = `SELECT pattern_id, title, why, model FROM lvp_decorations WHERE pattern_id = ANY($1)`;

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

type HiddenRowRaw = { pattern_id: string; cm_user: string; reason: string | null; hidden_on: string | null };

async function loadHiddenLatest(): Promise<HiddenRowRaw[]> {
  const rows = await run(HIDDEN_LATEST_SQL, []);
  return (rows as Record<string, unknown>[]).map((r) => ({
    pattern_id: String(r.pattern_id),
    cm_user: r.cm_user == null ? 'care-manager' : String(r.cm_user),
    reason: r.reason == null ? null : String(r.reason),
    hidden_on: r.hidden_on == null ? null : String(r.hidden_on),
  }));
}

/**
 * The whole shelf: Suggested (computed on read, hide-filtered, overuse-first, floor 5, cap 23)
 * + Hidden (latest-wins hide rows, rendered regardless of current volume — §4.4).
 * Throws on data-layer error; the route degrades to an empty shelf (kickoff §8).
 */
export async function loadShelf(): Promise<LvpShelf> {
  const [aggRows, hiddenLatest] = await Promise.all([
    run(WEEK_AGGREGATE_SQL, []),
    loadHiddenLatest(),
  ]);
  const hiddenIds = new Set(hiddenLatest.map((h) => h.pattern_id));

  const agg = (aggRows as Record<string, unknown>[]).map((r) => ({
    concept_id: String(r.concept_id),
    volume_week: Number(r.volume_week ?? 0),
    doctor_count: r.doctor_count == null ? null : Number(r.doctor_count),
  }));

  // Dictionary meta for every concept we might render (suggested candidates + hidden rows).
  const hiddenConceptIds = hiddenLatest
    .map((h) => conceptIdFromPatternId(h.pattern_id))
    .filter((c): c is string => c != null);
  const metaIds = [...new Set([...agg.map((a) => a.concept_id), ...hiddenConceptIds])];
  const metaRows = metaIds.length ? await run(CONCEPT_META_SQL, [metaIds]) : [];
  const meta = new Map<string, { direction: string; action: string; target: string; first_seen: string | null }>();
  for (const r of metaRows as Record<string, unknown>[]) {
    meta.set(String(r.concept_id), {
      direction: String(r.direction),
      action: String(r.action),
      target: String(r.target),
      first_seen: r.first_seen == null ? null : String(r.first_seen),
    });
  }

  const generatedAt = new Date().toISOString();
  const candidates = agg
    .filter((a) => !hiddenIds.has(patternIdFor(a.concept_id)))
    .map((a) => {
      // The lvc_concepts join is authoritative when both exist; prefix-parse is the fallback.
      const parsed = parseConceptId(a.concept_id);
      const m = meta.get(a.concept_id);
      const parts = m ?? parsed;
      return {
        pattern_id: patternIdFor(a.concept_id),
        concept_id: a.concept_id,
        direction: parts.direction,
        action: parts.action,
        target: parts.target,
        title: patternTitle(parts),
        why: whyText(a.volume_week, a.concept_id),
        pill: statusPill(parts.direction),
        volume_week: a.volume_week,
        doctor_count: a.doctor_count,
        first_seen: formatDisplayDate(m?.first_seen ?? null),
        examples: [] as string[],
        generated_at: generatedAt,
        // `as string`, not `as const`: L2 overwrites this in place below when a decoration exists,
        // and a `'stub'` literal type would make that assignment a type error.
        model: 'stub' as string,
      };
    });

  const suggested = shelveSuggestions(candidates);

  // Examples only for the cards that made the shelf (belt-and-braces strip on every snippet).
  if (suggested.length) {
    const exRows = await run(EXAMPLES_SQL, [suggested.map((s) => s.concept_id)]);
    const byConcept = new Map<string, string[]>();
    for (const r of exRows as Record<string, unknown>[]) {
      const cid = String(r.concept_id);
      const date = formatDisplayDate(r.note_date == null ? null : String(r.note_date));
      const subject = stripIdentifiers(r.subject == null ? '' : String(r.subject));
      if (!subject) continue;
      const list = byConcept.get(cid) ?? [];
      if (list.length < 3) list.push(date ? `${date} — ${subject}` : subject);
      byConcept.set(cid, list);
    }
    for (const s of suggested) s.examples = byConcept.get(s.concept_id) ?? [];
  }

  // ── L2 decoration (O11): COPY ONLY, and only after the shelf is fully decided ──────────────────
  // ⚠️ APPLIED HERE, DELIBERATELY LAST. Floor, both caps, hide filtering, sort order, volume,
  // doctor count, since-date, examples, pill and the stable pattern_id are ALL already computed
  // above and are not read again below. This block can therefore only overwrite two strings, which
  // is exactly what "decorate only" means — a decoration cannot promote a kind onto the shelf,
  // reorder it, or change a single number on it.
  //
  // FAIL-SAFE: any decoration read error degrades to stub copy, never to a broken shelf. That is
  // also what an unapplied migration 0040 looks like, and it is the same outcome as a failed
  // operator run (F11) — the card simply keeps the copy lib/lvp-core.ts computed.
  if (suggested.length) {
    const decRows = await run(DECORATIONS_SQL, [suggested.map((s) => s.pattern_id)]).catch(() => []);
    const decorations = new Map<string, { title: string; why: string; model: string }>();
    for (const r of decRows as Record<string, unknown>[]) {
      const title = r.title == null ? '' : String(r.title);
      const why = r.why == null ? '' : String(r.why);
      // A half-written row decorates nothing: both zones or neither, so a card can never show an
      // operator title above stub prose that contradicts it.
      if (!title || !why) continue;
      decorations.set(String(r.pattern_id), { title, why, model: r.model == null ? 'stub' : String(r.model) });
    }
    for (const s of suggested) {
      const d = decorations.get(s.pattern_id);
      if (!d) continue;
      s.title = d.title;
      s.why = d.why;
      s.model = d.model;
    }
  }

  // Hidden tab: every latest-wins hide row, regardless of current volume (§4.4).
  const hidden: HiddenPattern[] = hiddenLatest.map((h) => {
    const cid = conceptIdFromPatternId(h.pattern_id);
    const m = cid ? meta.get(cid) : undefined;
    const parts = m ?? (cid ? parseConceptId(cid) : null);
    return {
      pattern_id: h.pattern_id,
      concept_id: cid,
      title: parts ? patternTitle(parts) : h.pattern_id,
      cm_user: h.cm_user,
      reason: h.reason,
      hidden_at: formatDisplayDate(h.hidden_on),
    };
  });

  return { suggested, hidden };
}

// ── writes (the hide route ONLY — the list path never reaches here) ─────────────────────────────

/** Append one hide/unhide row (append-only; latest wins; cm_user is the O8 literal). */
export async function appendHideRow(patternId: string, op: 'hide' | 'unhide', reason: string | null): Promise<void> {
  await run(APPEND_SQL, [patternId, op, 'care-manager', reason]);
}
