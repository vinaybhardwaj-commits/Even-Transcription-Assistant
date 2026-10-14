/**
 * lib/scoring-policy/store.ts — the ONLY database-touching file in the scoring-policy module.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY QUERY HERE IS INFERRED. The build sandbox has no live database. The tables are created
 * by migrations/0026_scoring_policy.sql IN THIS COMMIT, so their shape is known — but the fact that
 * the migration has RUN is not. Accordingly:
 *
 *   EVERY read path is wrapped so that ANY failure — table missing, migration not yet run,
 *   connection error, malformed JSON — degrades to EQUAL WEIGHTS, i.e. exactly today's legacy
 *   scoring (PRD §8.1). Never a 500, never a blank score, never a WRONG score.
 *
 * That is not defensive padding: between deploy and migration there is a real window in which these
 * tables do not exist, and the IPD/OPD read paths call into here on every page render.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { sql } from '../db';
import { requireAdmin } from '../admin-gate';
import { isAdminUnlocked } from '../admin-cookie';
import {
  asTier, canonicalVectorJson, equalWeights, weightedKeysFor, weightsVersionString, PHASE_A_NOTE_TYPES,
  type NoteType, type Tier, type WeightVector,
} from './weights';
import type { StoredItem as CompletenessStoredItem } from './completeness';
import type { CohortRow as PreviewCohortRow } from './preview';
import { canonicalByDocument } from '../audit-canonical';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface ActivePolicy {
  noteType: string;
  version: number;
  vector: WeightVector;
  /** `nabh-weights/<note_type>/<n>` — PRD §2.8. */
  versionString: string;
  rationale: string | null;
  publishedByName: string | null;
  publishedAt: string | null;
  /** TRUE when this is the §8.1 fallback rather than a row that was actually read. */
  fallback: boolean;
}

export interface PolicyVersionRow {
  id: string;
  noteType: string;
  version: number;
  vector: WeightVector;
  rationale: string;
  publishedByName: string | null;
  publishedAt: string | null;
  isActive: boolean;
  supersedes: number | null;
  weightsSha256: string | null;
}

/** The §8.1 fallback: v0, all-Standard, flagged. Reproduces legacy scoring exactly. */
export function fallbackPolicy(noteType: string): ActivePolicy {
  return {
    noteType,
    version: 0,
    vector: equalWeights(weightedKeysFor(noteType)),
    versionString: weightsVersionString(noteType, 0),
    rationale: null,
    publishedByName: null,
    publishedAt: null,
    fallback: true,
  };
}

/** Coerce a jsonb payload into a WeightVector. Anything unusable ⇒ equal weights for that key. */
function toVector(raw: unknown, noteType: string): WeightVector {
  const keys = weightedKeysFor(noteType);
  const out: WeightVector = {};
  let src: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) src = raw as Record<string, unknown>;
  else if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (p && typeof p === 'object') src = p as Record<string, unknown>; } catch { /* fallback below */ } }
  for (const k of keys) out[k] = asTier(src[k]);
  return out;
}

// ── module-scope cache (PRD §4) ──────────────────────────────────────────────────────────────────
// "Cache the active vector per note type in module scope, 60-second TTL, invalidated on publish."
// Pure arithmetic over already-fetched rows means no extra DB round-trip per audit — but the ACTIVE
// VECTOR itself is one query per render without this.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: ActivePolicy }>();

export function invalidatePolicyCache(noteType?: string): void {
  if (noteType) cache.delete(noteType); else cache.clear();
}

/**
 * The active weight vector for a note type. NEVER THROWS — every failure yields `fallbackPolicy`.
 *
 * INFERRED SQL (validate against live before Dr. Binita touches this):
 *   SELECT id, note_type, version, weights, weights_sha256, rationale,
 *          published_by_name, published_at, is_active, supersedes
 *     FROM scoring_policy_versions
 *    WHERE note_type = $1 AND is_active
 *    ORDER BY version DESC
 *    LIMIT 1
 */
export async function getActivePolicy(noteType: string): Promise<ActivePolicy> {
  const hit = cache.get(noteType);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const rows = await run(
      `SELECT version, weights, rationale, published_by_name,
              to_char(published_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS published_at
         FROM scoring_policy_versions
        WHERE note_type = $1 AND is_active
        ORDER BY version DESC
        LIMIT 1`,
      [noteType],
    );
    const r = rows[0];
    if (!r) {
      // No active row is a legitimate state (migration run, nothing published) — fall back quietly.
      const value = fallbackPolicy(noteType);
      cache.set(noteType, { at: Date.now(), value });
      return value;
    }
    const version = Number(r.version ?? 0);
    const value: ActivePolicy = {
      noteType,
      version,
      vector: toVector(r.weights, noteType),
      versionString: weightsVersionString(noteType, version),
      rationale: r.rationale == null ? null : String(r.rationale),
      publishedByName: r.published_by_name == null ? null : String(r.published_by_name),
      publishedAt: r.published_at == null ? null : String(r.published_at),
      fallback: false,
    };
    cache.set(noteType, { at: Date.now(), value });
    return value;
  } catch {
    // Table missing / migration not yet run / DB down. Degrade to legacy, and do NOT cache the
    // failure for long — a short-lived cache entry means the first request after the migration
    // lands picks the real vector up within the TTL.
    const value = fallbackPolicy(noteType);
    cache.set(noteType, { at: Date.now(), value });
    return value;
  }
}

/** Active policies for several note types at once. Never throws. */
export async function getActivePolicies(noteTypes: readonly string[]): Promise<Record<string, ActivePolicy>> {
  const out: Record<string, ActivePolicy> = {};
  await Promise.all(noteTypes.map(async (nt) => { out[nt] = await getActivePolicy(nt); }));
  return out;
}

/**
 * The working draft, or null. Never throws.
 *
 * INFERRED SQL:
 *   SELECT weights, updated_by, updated_at FROM scoring_policy_drafts WHERE note_type = $1 LIMIT 1
 */
export async function getDraft(noteType: string): Promise<{ vector: WeightVector; updatedBy: string | null; updatedAt: string | null } | null> {
  try {
    const rows = await run(
      `SELECT weights, updated_by, to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS updated_at
         FROM scoring_policy_drafts WHERE note_type = $1 LIMIT 1`,
      [noteType],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      vector: toVector(r.weights, noteType),
      updatedBy: r.updated_by == null ? null : String(r.updated_by),
      updatedAt: r.updated_at == null ? null : String(r.updated_at),
    };
  } catch {
    return null;
  }
}

/**
 * Upsert the shared draft. Returns false on failure rather than throwing — a draft that cannot be
 * saved must not take the screen down.
 *
 * INFERRED SQL:
 *   INSERT INTO scoring_policy_drafts (note_type, weights, updated_by, updated_at)
 *   VALUES ($1, $2::jsonb, $3, NOW())
 *   ON CONFLICT (note_type) DO UPDATE SET weights = EXCLUDED.weights,
 *     updated_by = EXCLUDED.updated_by, updated_at = NOW()
 */
export async function saveDraft(noteType: string, vector: WeightVector, updatedBy: string | null): Promise<boolean> {
  try {
    await run(
      `INSERT INTO scoring_policy_drafts (note_type, weights, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (note_type) DO UPDATE SET
         weights = EXCLUDED.weights, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [noteType, JSON.stringify(vector), updatedBy],
    );
    return true;
  } catch {
    return false;
  }
}

/** INFERRED SQL: DELETE FROM scoring_policy_drafts WHERE note_type = $1 */
export async function clearDraft(noteType: string): Promise<void> {
  try { await run(`DELETE FROM scoring_policy_drafts WHERE note_type = $1`, [noteType]); } catch { /* non-fatal */ }
}

/**
 * Version history, newest first. Never throws — an unreadable history renders as empty.
 *
 * INFERRED SQL:
 *   SELECT id, note_type, version, weights, weights_sha256, rationale, published_by_name,
 *          published_at, is_active, supersedes
 *     FROM scoring_policy_versions WHERE note_type = $1 ORDER BY version DESC LIMIT $2
 */
export async function listVersions(noteType: string, limit = 50): Promise<PolicyVersionRow[]> {
  try {
    const rows = await run(
      `SELECT id, note_type, version, weights, weights_sha256, rationale, published_by_name,
              to_char(published_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS published_at,
              is_active, supersedes
         FROM scoring_policy_versions
        WHERE note_type = $1
        ORDER BY version DESC
        LIMIT $2`,
      [noteType, Math.max(1, Math.min(200, limit))],
    );
    return rows.map((r) => ({
      id: String(r.id ?? ''),
      noteType: String(r.note_type ?? noteType),
      version: Number(r.version ?? 0),
      vector: toVector(r.weights, noteType),
      rationale: String(r.rationale ?? ''),
      publishedByName: r.published_by_name == null ? null : String(r.published_by_name),
      publishedAt: r.published_at == null ? null : String(r.published_at),
      isActive: r.is_active === true,
      supersedes: r.supersedes == null ? null : Number(r.supersedes),
      weightsSha256: r.weights_sha256 == null ? null : String(r.weights_sha256),
    }));
  } catch {
    return [];
  }
}

export function vectorSha256(vector: WeightVector, keys: string[]): string {
  return createHash('sha256').update(canonicalVectorJson(vector, keys)).digest('hex');
}

export interface PublishResult {
  ok: boolean;
  version?: number;
  versionString?: string;
  error?: string;
  /** Set when the draft moved under the publisher's feet (PRD §8.6). */
  staleDraft?: { updatedBy: string | null; updatedAt: string | null };
}

export const MIN_RATIONALE_CHARS = 10;

/**
 * Publish a new version. PRD §5.4: insert with version = max+1, set the previous row inactive,
 * clear the draft, invalidate the cache.
 *
 * NOT WRAPPED IN A TRANSACTION, and that is a deliberate, flagged limitation: lib/db.ts exposes the
 * Neon HTTP driver (`neon()`), which is a stateless per-statement fetch — it has no session, so
 * BEGIN/COMMIT cannot span calls through it. The three statements are therefore ordered so that any
 * interruption leaves a READABLE state rather than a wrong one:
 *
 *   1. INSERT the new row with is_active = FALSE   → history gains a row; nothing is live yet
 *   2. flip the OLD active row to FALSE            → briefly zero active rows ⇒ readers get the
 *                                                    §8.1 fallback (legacy scoring), never a crash
 *   3. flip the NEW row to TRUE                    → live
 *
 * The partial unique index guarantees step 3 cannot produce two active rows. A failure between 2
 * and 3 leaves the note type on legacy weights until someone publishes again — degraded, visible,
 * and never a wrong score. The reverse order could transiently violate the index and fail the whole
 * publish, which is worse.
 *
 * INFERRED SQL — all four statements listed verbatim in the build report.
 */
export async function publishVersion(input: {
  noteType: string;
  vector: WeightVector;
  rationale: string;
  publishedBy: string | null;
  publishedByName: string | null;
  /** The draft `updated_at` the publisher had loaded; mismatch ⇒ §8.6 warning. */
  expectedDraftUpdatedAt?: string | null;
}): Promise<PublishResult> {
  const { noteType, vector, rationale } = input;
  if (!rationale || rationale.trim().length < MIN_RATIONALE_CHARS) {
    return { ok: false, error: `A written rationale of at least ${MIN_RATIONALE_CHARS} characters is required.` };
  }
  const keys = weightedKeysFor(noteType);
  // ⚠️ SHAPE BRANCH (§12.3). `weights` is a {fieldKey: tier} OBJECT for the weightage note types and
  // a package ARRAY for note_type='lab_packages'. The canonical-JSON hash is defined over the key
  // space, which an array does not have — so hash the serialised array directly. Without this
  // branch the array would be hashed against the 21 discharge-summary keys and every version would
  // carry the same meaningless digest.
  const isArrayShape = Array.isArray(vector);

  try {
    // §8.6 — concurrent editing. Advisory: it warns, it does not lock.
    if (input.expectedDraftUpdatedAt !== undefined) {
      const draft = await getDraft(noteType);
      if (draft && draft.updatedAt && draft.updatedAt !== input.expectedDraftUpdatedAt) {
        return { ok: false, staleDraft: { updatedBy: draft.updatedBy, updatedAt: draft.updatedAt } };
      }
    }

    const maxRows = await run(
      `SELECT COALESCE(max(version), 0)::int AS v FROM scoring_policy_versions WHERE note_type = $1`,
      [noteType],
    );
    const prev = Number(maxRows[0]?.v ?? 0);
    const next = prev + 1;
    const sha = isArrayShape
      ? createHash('sha256').update(JSON.stringify(vector)).digest('hex')
      : vectorSha256(vector, keys);

    // 1 — append, inactive
    await run(
      `INSERT INTO scoring_policy_versions
         (note_type, version, weights, weights_sha256, rationale, published_by, published_by_name, is_active, supersedes)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, FALSE, $8)`,
      [noteType, next, JSON.stringify(vector), sha, rationale.trim(),
        input.publishedBy, input.publishedByName, prev > 0 ? prev : null],
    );
    // 2 — retire the incumbent
    await run(
      `UPDATE scoring_policy_versions SET is_active = FALSE WHERE note_type = $1 AND is_active AND version <> $2`,
      [noteType, next],
    );
    // 3 — go live
    await run(
      `UPDATE scoring_policy_versions SET is_active = TRUE WHERE note_type = $1 AND version = $2`,
      [noteType, next],
    );

    await clearDraft(noteType);
    invalidatePolicyCache(noteType);
    return { ok: true, version: next, versionString: weightsVersionString(noteType, next) };
  } catch (e) {
    return { ok: false, error: `Could not publish: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
}

// ── the preview cohort (PRD §5.3 "Last 90 days") ────────────────────────────────────────────────
// Lives here rather than in the route so the server-rendered first paint and the POST endpoint read
// the SAME query — a preview that changed shape between first render and first interaction would be
// worse than no preview.

export const PREVIEW_WINDOW_DAYS = 90;
const PREVIEW_MAX_ROWS = 2000;

/** `report.completeness.items`, tolerating a jsonb that arrives as an object or as a string. */
export function extractItems(report: unknown): CompletenessStoredItem[] {
  let rep: unknown = report;
  if (typeof rep === 'string') { try { rep = JSON.parse(rep); } catch { return []; } }
  if (!rep || typeof rep !== 'object') return [];
  const c = (rep as Record<string, unknown>).completeness;
  if (!c || typeof c !== 'object') return [];
  const items = (c as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.filter((i): i is CompletenessStoredItem => !!i && typeof i === 'object' && typeof (i as { key?: unknown }).key === 'string');
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The IPD preview cohort. NEVER THROWS — returns [] on any failure, which the screen renders as
 * "no preview available" beside fully working tier controls (PRD §8.1).
 *
 * INFERRED SQL — column names from migrations/0013_ipd_discharge_audits.sql; the SELECT list is the
 * one app/admin/ipd-audit/page.tsx already uses, plus `report`.
 *
 *   SELECT id, report, completeness_pct, care_value_index, band,
 *          score_appropriateness, score_efficiency, score_safety, score_cost,
 *          score_documentation, score_patient_centred
 *     FROM ipd_discharge_audits
 *    WHERE coalesce(discharged_at, audited_at) >= NOW() - INTERVAL '90 days'
 *    ORDER BY coalesce(discharged_at, audited_at) DESC
 *    LIMIT 2000
 */
export async function ipdPreviewCohort(): Promise<PreviewCohortRow[]> {
  try {
    const raw = await run(
      `SELECT id, document_id, engine_version, model, report, completeness_pct, care_value_index, band,
              score_appropriateness, score_efficiency, score_safety, score_cost,
              score_documentation, score_patient_centred,
              to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at
         FROM ipd_discharge_audits
        WHERE coalesce(discharged_at, audited_at) >= NOW() - INTERVAL '${PREVIEW_WINDOW_DAYS} days'
        ORDER BY coalesce(discharged_at, audited_at) DESC
        LIMIT ${PREVIEW_MAX_ROWS}`,
    );
    // ONE ROW PER DOCUMENT (PRD §1.2). Without this the cohort counts a re-audited summary twice,
    // inflating n and skewing the mean, the SD and the band histogram the impact panel reports.
    const rows = canonicalByDocument(raw);
    const out: PreviewCohortRow[] = [];
    for (const r of rows) {
      const items = extractItems(r.report);
      if (!items.length) continue;      // no stored per-field detail ⇒ cannot be re-weighted
      out.push({
        id: String(r.id ?? ''),
        items,
        kind: 'ipd',
        domains: {
          appropriateness: numOrNull(r.score_appropriateness),
          efficiency: numOrNull(r.score_efficiency),
          safety: numOrNull(r.score_safety),
          cost: numOrNull(r.score_cost),
          documentation: numOrNull(r.score_documentation),
          patient_centred: numOrNull(r.score_patient_centred),
        },
        storedCompleteness: numOrNull(r.completeness_pct),
        storedIndex: numOrNull(r.care_value_index),
        storedBand: r.band == null ? null : String(r.band),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * How many OPD audits CARRY PER-FIELD DETAIL — the "currently {n}" in the empty state.
 *
 * A.1 (kickoff §12.1a): this counts `completeness_items IS NOT NULL`, NOT all audits. Counting every
 * audit would have told Dr. Binita there were 25,130 notes to preview against when the true number
 * of re-weightable notes was zero — the count has to mean what the sentence around it claims.
 *
 * Returns 0 if the column does not exist yet (migration 0027 unrun), because the query errors and
 * the catch returns 0 — which is the honest answer at that point.
 *
 * INFERRED SQL:
 *   SELECT count(*)::int AS n FROM opd_note_audits
 *    WHERE audited_at >= NOW() - INTERVAL '90 days' AND completeness_items IS NOT NULL
 */
export async function opdAccumulatedCount(): Promise<number> {
  try {
    const rows = await run(
      `SELECT count(*)::int AS n FROM opd_note_audits
        WHERE audited_at >= NOW() - INTERVAL '${PREVIEW_WINDOW_DAYS} days'
          AND completeness_items IS NOT NULL`,
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

// ── shared route helpers ────────────────────────────────────────────────────────────────────────
// These live here, not in a route file: Next.js validates route modules and rejects any export that
// is not a handler or a known config field ("`authedAdmin` is not a valid Route export field"), so
// the four endpoints cannot share a helper via one of themselves.

/**
 * Admin gate for the scoring-policy endpoints — the admin session cookie OR ADMIN_TOKEN, exactly as
 * every other admin surface in this repo does it.
 *
 * ⚠️ PRD §5.1 says "gated by the existing admin check via `getCurrentUser()`". THERE IS NO
 * getCurrentUser() IN THIS CODEBASE (0 references across 765 source files). The real mechanisms are
 * isAdminUnlocked() (lib/admin-cookie, for pages) and requireAdmin() (lib/admin-gate, for routes).
 * Flagged in the build report.
 */
export async function authedAdminRequest(req: NextRequest): Promise<boolean> {
  if (await isAdminUnlocked()) return true;
  return requireAdmin(req) === null;
}

/** Only the two Phase A note types are addressable; `ot_note` renders locked (decision §1.4). */
export function resolveNoteType(v: string | null | undefined): string {
  return (PHASE_A_NOTE_TYPES as readonly string[]).includes(String(v)) ? String(v) : 'discharge_summary';
}

export type { WeightVector, Tier, NoteType };
