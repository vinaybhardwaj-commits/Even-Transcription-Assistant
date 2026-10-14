/**
 * lib/provenance-tier.ts — provenance tier ledger loader (thin; the classifier lives in the pure
 * core). READ-ONLY over stored audits except the small append-only daily snapshot (L6: counts only,
 * no clinical text, no PHI). Every path fails safe: any error degrades to an empty ledger — never a
 * 500, never wrong counts presented as right.
 *
 * Strategy: one SQL aggregate collapses findings into (engine_version, quieting_gen, rule_ref,
 * source, verdict, signal_type) combos server-side; the pure classifier then maps each combo to a
 * tier in JS with the attributed rules' citation fields fetched in one query. No LLM (L3).
 */

import { sql } from './db';
import {
  classifyProvenanceTier, citationResolves, PROVENANCE_TIERS,
  type ProvenanceTier, type RuleCitationFields, type FindingProvenance,
} from './provenance-tier-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

/** Reconstruct the minimal FindingProvenance the classifier needs from the SQL-projected columns
 *  (prov_source / prov_book / prov_chapter / prov_derivation). null when the finding has none. */
function provenanceFromRow(c: Record<string, unknown>): FindingProvenance | null {
  const deriv = c.prov_derivation == null ? null : String(c.prov_derivation);
  const src = c.prov_source == null ? null : String(c.prov_source);
  if (!deriv && !src) return null;
  const citation = src ? { source: src, book: c.prov_book == null ? null : String(c.prov_book), chapter: c.prov_chapter == null ? null : String(c.prov_chapter) } : null;
  return { citation, derivation: deriv === 'llm' ? 'llm' : 'external' };
}

export interface TierPartition {
  engine_version: string;
  quieting_gen: number;
  total: number;
  tiers: Record<ProvenanceTier, number>;
}

export async function ensureProvenanceSnapshotTable(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS provenance_tier_snapshots (
    day            date NOT NULL,
    engine_version text NOT NULL,
    quieting_gen   integer NOT NULL,
    tier           text NOT NULL,
    count          integer NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, engine_version, quieting_gen, tier)
  )`, []);
}

/** Rule citation fields for the given rule_refs. Falls back to a citation_doi-free column list if
 *  the wider SELECT errors (schema honesty: citation_doi is a live column per lib/lvc.ts, but the
 *  ledger must not blank out if that inference is wrong). */
async function fetchRuleCitations(ids: string[]): Promise<Map<string, RuleCitationFields>> {
  const map = new Map<string, RuleCitationFields>();
  if (!ids.length) return map;
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await run(`SELECT id, citation_doi, citation_pmid, citation_url FROM lvc_recommendations WHERE id = ANY($1)`, [ids]);
  } catch {
    rows = await run(`SELECT id, citation_pmid, citation_url FROM lvc_recommendations WHERE id = ANY($1)`, [ids]).catch(() => []);
  }
  for (const r of rows) {
    map.set(String(r.id), {
      citation_doi: r.citation_doi == null ? null : String(r.citation_doi),
      citation_pmid: r.citation_pmid == null ? null : String(r.citation_pmid),
      citation_url: r.citation_url == null ? null : String(r.citation_url),
    });
  }
  return map;
}

/**
 * The live ledger: tier counts per (engine_version, quieting_gen) over NON-INFORMATIONAL findings.
 * L5: partitions are never blended here — the surface labels any cross-partition total it renders.
 */
export async function loadTierLedger(): Promise<TierPartition[]> {
  try {
    const combos = await run(
      `SELECT engine_version, coalesce(quieting_gen, 0)::int AS gen,
              f->>'rule_ref' AS rule_ref, f->>'source' AS source,
              f->>'verdict' AS verdict, f->>'signal_type' AS signal_type,
              f->'provenance'->'citation'->>'source' AS prov_source,
              f->'provenance'->'citation'->>'book' AS prov_book,
              f->'provenance'->'citation'->>'chapter' AS prov_chapter,
              f->'provenance'->>'derivation' AS prov_derivation,
              count(*)::int AS n
       FROM opd_note_audits, jsonb_array_elements(findings) f
       WHERE app_source = $1 AND engine_version LIKE 'opd-note-audit/%'
         AND (f->>'informational') IS DISTINCT FROM 'true'
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10`, [APP]);

    const ruleIds = [...new Set(combos.map((c) => (c.rule_ref == null ? '' : String(c.rule_ref))).filter(Boolean))];
    const rules = await fetchRuleCitations(ruleIds);

    const parts = new Map<string, TierPartition>();
    for (const c of combos) {
      const ev = String(c.engine_version);
      const gen = Number(c.gen) || 0;
      const key = `${ev}|${gen}`;
      let p = parts.get(key);
      if (!p) {
        p = { engine_version: ev, quieting_gen: gen, total: 0, tiers: Object.fromEntries(PROVENANCE_TIERS.map((t) => [t, 0])) as Record<ProvenanceTier, number> };
        parts.set(key, p);
      }
      const rule_ref = c.rule_ref == null ? null : String(c.rule_ref);
      const tier = classifyProvenanceTier(
        {
          rule_ref,
          source: c.source == null ? undefined : String(c.source),
          verdict: c.verdict == null ? undefined : String(c.verdict),
          signal_type: c.signal_type == null ? undefined : String(c.signal_type),
          provenance: provenanceFromRow(c),
        },
        rule_ref ? rules.get(rule_ref) ?? null : null,
      );
      const n = Number(c.n) || 0;
      p.tiers[tier] += n;
      p.total += n;
    }
    return [...parts.values()].sort((a, b) => b.engine_version.localeCompare(a.engine_version) || b.quieting_gen - a.quieting_gen);
  } catch {
    return [];   // fail-safe: an empty ledger, never a 500 and never wrong counts
  }
}

/** L6 — append today's rollup (IST day), one row per (day, engine, gen, tier). Idempotent:
 *  ON CONFLICT DO NOTHING makes the first page-load of the day the writer; re-loads are no-ops.
 *  Counts only. Best-effort — a failure never affects the live view. */
export async function snapshotToday(parts: TierPartition[]): Promise<void> {
  try {
    await ensureProvenanceSnapshotTable();
    const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);   // IST calendar day
    for (const p of parts) {
      for (const tier of PROVENANCE_TIERS) {
        await run(
          `INSERT INTO provenance_tier_snapshots (day, engine_version, quieting_gen, tier, count)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (day, engine_version, quieting_gen, tier) DO NOTHING`,
          [day, p.engine_version, p.quieting_gen, tier, p.tiers[tier]]);
      }
    }
  } catch { /* best-effort */ }
}

export interface SnapshotRow { day: string; engine_version: string; quieting_gen: number; tier: string; count: number }
export async function loadSnapshots(days = 30): Promise<SnapshotRow[]> {
  try {
    const rows = await run(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, engine_version, quieting_gen, tier, count
       FROM provenance_tier_snapshots
       WHERE day > (now() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
       ORDER BY day DESC, engine_version DESC, quieting_gen DESC`, [Math.max(1, days)]);
    return rows.map((r) => ({
      day: String(r.day), engine_version: String(r.engine_version),
      quieting_gen: Number(r.quieting_gen) || 0, tier: String(r.tier), count: Number(r.count) || 0,
    }));
  } catch { return []; }
}

/** Drill-down: example findings per tier for one engine version (classifier-audit aid, PRD §4).
 *  Bounded sample; subjects only — rendered on the admin-gated page, never persisted. */
export async function tierExamples(engineVersion: string, perTier = 5): Promise<Record<ProvenanceTier, { subject: string; signal_type: string | null; rule_ref: string | null }[]>> {
  const out = Object.fromEntries(PROVENANCE_TIERS.map((t) => [t, []])) as unknown as Record<ProvenanceTier, { subject: string; signal_type: string | null; rule_ref: string | null }[]>;
  try {
    const rows = await run(
      `SELECT f->>'subject' AS subject, f->>'rule_ref' AS rule_ref, f->>'source' AS source,
              f->>'verdict' AS verdict, f->>'signal_type' AS signal_type,
              f->'provenance'->'citation'->>'source' AS prov_source,
              f->'provenance'->'citation'->>'book' AS prov_book,
              f->'provenance'->'citation'->>'chapter' AS prov_chapter,
              f->'provenance'->>'derivation' AS prov_derivation
       FROM opd_note_audits, jsonb_array_elements(findings) f
       WHERE app_source = $1 AND engine_version = $2
         AND (f->>'informational') IS DISTINCT FROM 'true'
       ORDER BY note_date DESC LIMIT 1500`, [APP, engineVersion]);
    const ruleIds = [...new Set(rows.map((r) => (r.rule_ref == null ? '' : String(r.rule_ref))).filter(Boolean))];
    const rules = await fetchRuleCitations(ruleIds);
    for (const r of rows) {
      const rule_ref = r.rule_ref == null ? null : String(r.rule_ref);
      const tier = classifyProvenanceTier(
        { rule_ref, source: r.source == null ? undefined : String(r.source), verdict: r.verdict == null ? undefined : String(r.verdict), signal_type: r.signal_type == null ? undefined : String(r.signal_type), provenance: provenanceFromRow(r) },
        rule_ref ? rules.get(rule_ref) ?? null : null,
      );
      if (out[tier].length < perTier) out[tier].push({ subject: String(r.subject || '').slice(0, 110), signal_type: r.signal_type == null ? null : String(r.signal_type), rule_ref });
    }
    return out;
  } catch { return out; }
}

export { citationResolves };
