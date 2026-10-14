/**
 * lib/learning.ts — wired layer for the OPD-audit → CDMSS learning loop (LL.1 / LL.2-v1).
 *
 * Loads recent OPD audit findings from Neon, runs the pure miner (lib/learning-core), and
 * upserts candidate rule PROPOSALS into the `learning_proposals` review queue. Plus review
 * (approve/reject) helpers. Everything stays in the queue — applying an approved proposal to
 * `lvc_recommendations` is a separate, gated step (LL.2b, after matcher tests). Nothing here
 * mutates the live audit engine, the corpus, or lvc_recommendations.
 */
import { sql } from './db';
import { canonicalDistinctOnSql } from './audit-canonical';
import { geminiUtilityModel, TEXT_MODEL } from './llm';
import { governedChat } from './trace';
import {
  mineRuleCandidates, mineHarvestGaps, mineMissedFlags, mineFalseClusters, routeAdjudications,
  DEFAULT_THRESHOLDS, DEFAULT_GAP_THRESHOLDS, isMineableFinding,
  CANONICALIZE_SYSTEM, buildCanonicalizeUser, parseCanonicalMap,
  type AuditRowLite, type MineThresholds, type MissedFlagLite, type FindingLabelLite,
  type CoverageProbe, type AdjudicationLite, type AdjudicationRouting,
} from './learning-core';
import { OPD_ENGINE_VERSIONS_CURRENT, OPD_ENGINE_VERSION } from './opd-note-audit-core';
import { retrieve } from './retrieve';
import { loadValidLabelInstances, createSuppression } from './audit-suppression-store';
import { previewCollateral, type Suppression } from './audit-suppression-core';
import { parseGoal, FALLBACK_ROSTER } from './review-stats-core';
import { buildFlywheel, type FlywheelView } from './learning-flywheel-core';
import { buildMeters, type Meter } from './model-programme-core';

const APP = process.env.APP_SOURCE || 'standalone';
const ENGINE_FAMILY = [...OPD_ENGINE_VERSIONS_CURRENT];
// IST Monday-start week + today, as SQL fragments (mirrors review-stats istWeekStart, DB-side).
const IST_WEEK_START = `(date_trunc('week', (now() AT TIME ZONE 'Asia/Kolkata')))::date`;
const IST_TODAY = `((now() AT TIME ZONE 'Asia/Kolkata')::date)`;
const sql2 = sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>;

function asArr<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p as T[] : []; } catch { return []; } }
  return [];
}
function asObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {}; } catch { return {}; } }
  return {};
}

/** Latest audit per note (DISTINCT ON uid) over the lookback window — avoids cross-engine-version double counting. */
export async function loadRecentAuditRows(days = 90): Promise<AuditRowLite[]> {
  const rows = await sql2(
    // §5.2 (addendum E) — THE RULE, not newest-by-time. Measured, this picked the same row as the
    // canonical rule on all 7,552 duplicated notes, but by coincidence rather than construction.
    // CHOSEN FILTER: the SHAPE of the version tail, not the engine family. This read has never had
    // an engine filter and mines a wide corpus; the family form would silently drop every note only
    // ever audited at a pre-0.81 engine (~2,533 today), changing what learning sees. The shape test
    // is exactly what makes the int[] cast in CANONICAL_RANK_SQL safe BY CONSTRUCTION — the earlier
    // `NOT LIKE '%-mini'` enumerated one known bad suffix and let `opd-note-audit/0.5-verify`
    // (Mar 2024, measured live) through to raise `invalid input syntax for type integer` on any
    // caller passing a window wide enough to reach it.
    canonicalDistinctOnSql({
      table: 'opd_note_audits',
      identity: 'uid',
      cols: 'id, doctor_uid, consult_type, findings, sources',
      where: `app_source = $1 AND excluded_reason IS NULL
        AND split_part(engine_version, '/', 2) ~ '^[0-9]+(\\.[0-9]+)*$'
        AND note_date >= NOW() - ($2 || ' days')::interval`,
    }),
    [APP, String(Math.max(1, Math.min(365, days)))],
  );
  return rows.map((r) => ({
    id: String(r.id),
    doctor_uid: r.doctor_uid == null ? null : String(r.doctor_uid),
    consult_type: r.consult_type == null ? null : String(r.consult_type),
    findings: asArr(r.findings),
    sources: asArr(r.sources),
  }));
}

// ── LEARNING-LOOP-V2 §2.3 — reviewer-driven mining (the other half of the flywheel) ──
const VERDICT_SET = ['true_positive', 'nitpick', 'false'];
// Conservative corpus-evidence floor for promoting a missed-flag cluster to a rule DRAFT. retrieve()
// failure OR top hit below this → uncitable → harvest_topic (evidence over frequency — the same
// stance the finding-miner takes). Set deliberately mid-range; tune only with live data.
const CITE_SIM_FLOOR = 0.5;

/** Reviewer "missed" flags (a finding the audit should have caught) with a comment, on current-family
 *  non-excluded audits. Fail-safe → []. */
export async function fetchMissedFlags(): Promise<MissedFlagLite[]> {
  const rows = await sql2(
    `SELECT f.audit_id, f.category, f.comment, f.author
       FROM opd_audit_feedback f
       JOIN opd_note_audits a ON a.id = f.audit_id
      WHERE f.app_source = $1 AND f.scope = 'missed' AND COALESCE(f.comment, '') <> ''
        AND f.study IS NOT DISTINCT FROM $3
        AND a.excluded_reason IS NULL AND a.engine_version = ANY($2)
      ORDER BY f.created_at DESC
      LIMIT 4000`,
    [APP, ENGINE_FAMILY, null]).catch(() => []);
  return rows.map((r) => ({
    audit_id: String(r.audit_id ?? ''), category: r.category == null ? null : String(r.category),
    comment: String(r.comment ?? ''), author: r.author == null ? null : String(r.author),
  }));
}

/** Current-state finding labels: latest verdict per (audit_id, finding_ref), subject recovered from
 *  the audit's findings jsonb by finding_ref, on current-family non-excluded audits. Fail-safe → []. */
export async function fetchFindingLabels(): Promise<FindingLabelLite[]> {
  const rows = await sql2(
    `SELECT DISTINCT ON (f.audit_id, f.finding_ref)
            f.audit_id, f.finding_ref, f.verdict, f.author, f.signal_type,
            (SELECT x->>'subject' FROM jsonb_array_elements(a.findings) x
              WHERE x->>'finding_ref' = f.finding_ref LIMIT 1) AS subject
       FROM opd_audit_feedback f
       JOIN opd_note_audits a ON a.id = f.audit_id
      WHERE f.app_source = $1 AND f.scope = 'finding' AND f.finding_ref IS NOT NULL
        AND f.verdict = ANY($2)
        AND f.study IS NOT DISTINCT FROM $4
        AND a.excluded_reason IS NULL AND a.engine_version = ANY($3)
      ORDER BY f.audit_id, f.finding_ref, f.created_at DESC
      LIMIT 8000`,
    [APP, VERDICT_SET, ENGINE_FAMILY, null]).catch(() => []);
  return rows.map((r) => ({
    audit_id: String(r.audit_id ?? ''), finding_ref: String(r.finding_ref ?? ''),
    subject: r.subject == null ? '' : String(r.subject),
    signal_type: r.signal_type == null ? null : String(r.signal_type),
    verdict: String(r.verdict ?? ''), author: r.author == null ? null : String(r.author),
  }));
}

// Bounded probe budget per rail per run (§1). retrieve() = embed + hybrid + rerank; a few dozen calls
// sit comfortably inside the miner's existing budget (it already Flash-canonicalises 300 subjects).
// Clusters beyond the cap are DEFERRED to the next daily run and logged — never silently dropped.
const PROBE_CAP = 40;

/** THE single live corpus probe (HARVEST-DEMAND-RANK §2.2) — one definition of the similarity floor
 *  and one fail-safe, shared by both harvest rails. Impure; the pure miners receive only its result.
 *  A retrieve() failure (or an empty query) is treated as UNCOVERED — deficit 1 — because the safe
 *  error is to harvest a topic we already have, not to skip a genuine gap. Never throws. */
async function probeCoverage(title: string): Promise<CoverageProbe> {
  const q = (title || '').trim();
  if (!q) return { topSim: 0, covered: false };
  try {
    const r = await retrieve(q, { topK: 5, useReranker: true, hybrid: true });
    const topSim = r.hits?.[0]?.similarity ?? 0;
    return { topSim, covered: topSim >= CITE_SIM_FLOOR };
  } catch (e) {
    console.warn('[learning] coverage probe failed → treating as uncovered', q.slice(0, 60), (e as Error).message);
    return { topSim: 0, covered: false };
  }
}

/** Corpus-evidence check for a missed-flag cluster — a thin wrapper over the shared probe. */
async function missedClusterCitable(title: string): Promise<boolean> {
  return (await probeCoverage(title)).covered;
}

/** Current-state adjudicated decisions (latest per cluster_key) from the append-only governance
 *  ledger. The table is lab-side (created on demand by the Lab MCP) and carries no app_source /
 *  engine_version / excluded_reason columns — the engine version is embedded in the coarse
 *  cluster_key `<signal_type>@<engine_version>`. Fail-safe → [] (absent table included). */
export async function fetchAdjudicationDecisions(): Promise<AdjudicationLite[]> {
  const rows = await sql2(
    `SELECT DISTINCT ON (cluster_key) cluster_key, decision, author, prd_ref
       FROM opd_feedback_adjudications
      ORDER BY cluster_key, created_at DESC, id DESC`,
    []).catch(() => []);
  return rows.map((r) => ({
    clusterKey: String(r.cluster_key ?? ''), decision: String(r.decision ?? ''),
    author: r.author == null ? null : String(r.author),
    prdRef: r.prd_ref == null ? null : String(r.prd_ref),
  })).filter((r) => r.clusterKey && r.decision);
}

/** Governance readout for the console: `adjudicated: fix ×N · suppress ×N` + the owed engine PRDs. */
export async function fetchAdjudicationGovernance(): Promise<AdjudicationRouting> {
  return routeAdjudications(await fetchAdjudicationDecisions().catch(() => []));
}

interface ReviewerMineResult {
  missed: number; suppressions: number; inserted: number; refreshed: number;
  probed: number; deferredProbes: number; adjudicatedSuppress: number; adjudicatedFix: number;
}

/** Mine reviewer signal into the SAME proposal queue: missed flags → missed_rule / harvest_topic,
 *  false clusters → suppression candidates. Two-pass on missed flags so the live probe (impure
 *  retrieve) is decided per cluster while the miner itself stays pure.
 *
 *  §2.4 — the adjudication ledger is read here as GOVERNANCE: a `suppress` decision vouches for its
 *  signal class (relaxing the miner's ≥2-reviewer gate); `fix` is surfaced only; the rest no-op. The
 *  ledger keys coarse (`<signal_type>@<engine_version>`) so it can never name a harvest topic — and
 *  by construction NOTHING here routes a decision to harvest. */
async function mineAndSaveReviewerProposals(): Promise<ReviewerMineResult> {
  const [flags, labels, adjudications] = await Promise.all([fetchMissedFlags(), fetchFindingLabels(), fetchAdjudicationDecisions()]);
  const gov = routeAdjudications(adjudications);
  let inserted = 0; let refreshed = 0;

  // pass 1: form clusters (harvest-only, unprobed) → the probe worklist, highest nFlags first.
  const draft = mineMissedFlags(flags);
  const worklist = draft.slice(0, PROBE_CAP);
  const deferredProbes = Math.max(0, draft.length - worklist.length);
  if (deferredProbes > 0) console.warn(`[learning] missed rail: ${deferredProbes} cluster(s) beyond the ${PROBE_CAP}-probe cap — deferred to the next run, not dropped`);
  const probes = new Map<string, CoverageProbe>();
  await Promise.all(worklist.map(async (c) => { probes.set(c.title, await probeCoverage(c.title)); }));

  // pass 2: inject the probe. Unprobed (deferred) clusters get no coverage → uncovered → harvest,
  // demand-rank null, ranked by flags as before. Nothing is lost, only unranked until tomorrow.
  const missed = mineMissedFlags(flags, { coverage: (c) => probes.get(c.title) });
  for (const c of missed) {
    const r = await upsertProposal({ type: c.type, clusterKey: c.clusterKey, title: c.title, payload: c.payload, evidence: [], nSupport: c.provenance.nFlags, provenance: c.provenance, confidence: c.confidence, suggestedReviewer: c.suggestedReviewer });
    if (r === 'inserted') inserted++; else if (r === 'refreshed') refreshed++;
  }

  const suppressions = mineFalseClusters(labels, { vouchedSignalTypes: gov.vouchedSignalTypes });
  for (const s of suppressions) {
    const r = await upsertProposal({ type: s.type, clusterKey: s.clusterKey, title: s.title, payload: s.payload, evidence: [], nSupport: s.provenance.nFalseNitpick, provenance: s.provenance, confidence: s.confidence, suggestedReviewer: s.suggestedReviewer });
    if (r === 'inserted') inserted++; else if (r === 'refreshed') refreshed++;
  }
  return {
    missed: missed.length, suppressions: suppressions.length, inserted, refreshed,
    probed: worklist.length, deferredProbes, adjudicatedSuppress: gov.nSuppress, adjudicatedFix: gov.nFix,
  };
}

/** Flash-canonicalise distinct finding subjects → { subject: canonical practice label }.
 *  Batched (a handful of cheap Flash calls), soft-fails per batch so a Flash outage just falls
 *  back to deterministic-signature clustering — never breaks the mining run. */
async function canonicalizeBatch(batch: string[]): Promise<Record<string, string>> {
  try {
    // Governed envelope (Stage 4): the traceless mining run behaves exactly as before.
    const r = await governedChat(undefined, 'learning_canonicalize', {
      model: TEXT_MODEL,
      messages: [
        { role: 'system', content: CANONICALIZE_SYSTEM },
        { role: 'user', content: buildCanonicalizeUser(batch) },
      ],
      temperature: 0,
      max_tokens: 8000,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    }, { gemini: geminiUtilityModel(), promptRef: 'learning-core/CANONICALIZE_SYSTEM' });
    return parseCanonicalMap(r.choices?.[0]?.message?.content || '', batch);
  } catch (e) {
    console.warn('[learning] canonicalize batch failed', (e as Error).message);
    return {};
  }
}

export async function canonicalizeSubjects(subjects: string[]): Promise<Record<string, string>> {
  const B = 50;
  const batches: string[][] = [];
  for (let i = 0; i < subjects.length; i += B) batches.push(subjects.slice(i, i + B));
  // PARALLEL — a capped, bounded set of batches (see caller) so the whole run finishes well
  // within the function limit; sequential batching risked blowing 300s on full data.
  const parts = await Promise.all(batches.map(canonicalizeBatch));
  const map: Record<string, string> = {};
  for (const p of parts) Object.assign(map, p);
  return map;
}

export interface MineSummary {
  scanned: number; subjects: number; canonicalized: number; candidates: number; gaps: number;
  missed: number; suppressions: number; inserted: number; refreshed: number; healed: number;
  /** live corpus probes made this run, and clusters deferred past the per-rail cap (both rails). */
  probed: number; deferredProbes: number;
  /** governance readout from the adjudication ledger — never a harvest driver. */
  adjudicatedSuppress: number; adjudicatedFix: number;
}

/** Upsert one candidate into the review queue (proposed-only refresh). Returns insert/refresh/null. */
async function upsertProposal(c: {
  type: string; clusterKey: string; title: string; payload: unknown; evidence: unknown;
  nSupport: number; provenance: unknown; confidence: number; suggestedReviewer: string;
}): Promise<'inserted' | 'refreshed' | null> {
  const res = (await sql`
    INSERT INTO learning_proposals
      (app_source, type, status, cluster_key, title, payload, evidence, provenance, confidence, n_support, suggested_reviewer)
    VALUES (${APP}, ${c.type}, 'proposed', ${c.clusterKey}, ${c.title},
      ${JSON.stringify(c.payload)}::jsonb, ${JSON.stringify(c.evidence)}::jsonb, ${JSON.stringify(c.provenance)}::jsonb,
      ${c.confidence}, ${c.nSupport}, ${c.suggestedReviewer})
    ON CONFLICT (type, cluster_key) DO UPDATE SET
      title = EXCLUDED.title, payload = EXCLUDED.payload, evidence = EXCLUDED.evidence,
      provenance = EXCLUDED.provenance, confidence = EXCLUDED.confidence,
      n_support = EXCLUDED.n_support, suggested_reviewer = EXCLUDED.suggested_reviewer, updated_at = NOW()
      WHERE learning_proposals.status = 'proposed'
    RETURNING (xmax = 0) AS inserted`) as Array<{ inserted: boolean }>;
  if (!res.length) return null;
  return res[0].inserted ? 'inserted' : 'refreshed';
}

/** Mine recent audits → upsert candidate rule proposals (proposed-only refresh; rejected/approved left alone).
 *  gapThresholds tunes the harvest-gap floor independently (admin preview); production default 10/3. */
export async function mineAndSaveProposals(days = 90, thresholds: MineThresholds = DEFAULT_THRESHOLDS, useCanonical = true, gapThresholds: MineThresholds = DEFAULT_GAP_THRESHOLDS): Promise<MineSummary> {
  const rows = await loadRecentAuditRows(days);

  // LL.2: canonicalise the distinct mineable subjects so paraphrases merge before clustering.
  // Cap to the top-N most frequent subjects (bounds the parallel Flash batches so the run finishes
  // well within the function limit). The dropped long-tail singletons fall back to the deterministic
  // signature in the miner — they can't form a ≥15 cluster anyway, so nothing material is lost.
  const counts = new Map<string, number>();
  for (const row of rows) for (const f of row.findings || []) if (isMineableFinding(f) && f.subject) counts.set(f.subject, (counts.get(f.subject) || 0) + 1);
  const subjects = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([s]) => s);
  const labelMap = useCanonical && subjects.length ? await canonicalizeSubjects(subjects) : {};
  const canonicalLabel = Object.keys(labelMap).length ? (s: string) => labelMap[s] || '' : undefined;

  const cands = mineRuleCandidates(rows, thresholds, { canonicalLabel });
  // LL.4 — the SAME clustering also yields harvest-gap topics: high-volume practices the corpus
  // could not cite. They land in the same review queue; approving one only adds an ingest_topics row.
  //
  // HARVEST-DEMAND-RANK §2.2 — two-pass, mirroring the missed-flag rail. Pass 1 clusters and applies
  // the cheap citedFrac PRE-filter; the survivors (top 40 by uncited volume) get a live corpus probe;
  // pass 2 re-mines with the probe injected, which DROPS the topics the corpus already covers — the
  // live gate overrides the retrospective proxy — and demand-ranks the rest.
  const gapDraft = mineHarvestGaps(rows, gapThresholds, { canonicalLabel });
  const gapWorklist = gapDraft.slice(0, PROBE_CAP);
  const gapDeferred = Math.max(0, gapDraft.length - gapWorklist.length);
  if (gapDeferred > 0) console.warn(`[learning] finding-gap rail: ${gapDeferred} cluster(s) beyond the ${PROBE_CAP}-probe cap — deferred to the next run, not dropped`);
  const gapProbes = new Map<string, CoverageProbe>();
  await Promise.all(gapWorklist.map(async (g) => { gapProbes.set(g.clusterKey, await probeCoverage(g.title)); }));
  const gaps = mineHarvestGaps(rows, gapThresholds, { canonicalLabel, coverage: (c) => gapProbes.get(c.clusterKey) });
  const gapsCovered = gapWorklist.length - gaps.filter((g) => g.provenance.demandRank != null).length;
  if (gapsCovered > 0) console.info(`[learning] finding-gap rail: ${gapsCovered} probed cluster(s) dropped — corpus already covers them (topSim ≥ ${CITE_SIM_FLOOR})`);
  let inserted = 0; let refreshed = 0;
  for (const c of cands) {
    const r = await upsertProposal({ type: c.type, clusterKey: c.clusterKey, title: c.title, payload: c.payload, evidence: c.evidence, nSupport: c.provenance.nOccurrences, provenance: c.provenance, confidence: c.confidence, suggestedReviewer: c.suggestedReviewer });
    if (r === 'inserted') inserted++; else if (r === 'refreshed') refreshed++;
  }
  for (const g of gaps) {
    const r = await upsertProposal({ type: g.type, clusterKey: g.clusterKey, title: g.title, payload: g.payload, evidence: [], nSupport: g.provenance.nOccurrences, provenance: g.provenance, confidence: g.confidence, suggestedReviewer: g.suggestedReviewer });
    if (r === 'inserted') inserted++; else if (r === 'refreshed') refreshed++;
  }
  // §2.3 — the SAME run also mines reviewer signal (missed flags + false clusters) into the queue.
  const rev = await mineAndSaveReviewerProposals();
  inserted += rev.inserted; refreshed += rev.refreshed;
  const healed = await reconcileApproved();
  return {
    scanned: rows.length, subjects: subjects.length, canonicalized: Object.keys(labelMap).length,
    candidates: cands.length, gaps: gaps.length, missed: rev.missed, suppressions: rev.suppressions,
    inserted, refreshed, healed,
    probed: gapWorklist.length + rev.probed, deferredProbes: gapDeferred + rev.deferredProbes,
    adjudicatedSuppress: rev.adjudicatedSuppress, adjudicatedFix: rev.adjudicatedFix,
  };
}

/** Heal approved proposals whose apply step never landed (applied_ref IS NULL) — re-runs the
 *  correct apply for each type and records the ref. Idempotent (a healed row gets a non-null ref so
 *  it's skipped next time). A safety net against any apply hiccup; never touches proposed/rejected. */
async function reconcileApproved(): Promise<number> {
  const orphans = (await sql`
    SELECT id, type, title, payload, evidence, provenance FROM learning_proposals
     WHERE app_source = ${APP} AND status = 'approved' AND applied_ref IS NULL`) as Array<Record<string, unknown>>;
  let healed = 0;
  for (const p of orphans) {
    const ref = await applyProposal(String(p.id), p);
    if (ref) { await sql`UPDATE learning_proposals SET applied_ref = ${ref}, updated_at = NOW() WHERE id = ${p.id}`; healed++; }
  }
  return healed;
}

/** On approve of an lvc_rule: insert it into lvc_recommendations as an ACTIVE, EHRC-mined,
 *  licence-ok rule. The existing matcher's `WHERE status='active'` recall then picks it up, so it
 *  fires in the live Right Care surface — no change to the matcher query itself. id is derived
 *  from the proposal id, so re-approval is idempotent. Returns the created lvc id. */
async function applyLvcRule(proposalId: string, p: Record<string, unknown>): Promise<string> {
  const payload = asObj(p.payload);
  const provenance = asObj(p.provenance);
  const evidence = asArr<{ item_number?: string; url?: string }>(p.evidence);
  const lvcId = `ehrc-${proposalId}`;
  const statement = String(payload.statement || p.title || '').slice(0, 600);
  const rationale = payload.rationale ? String(payload.rationale).slice(0, 2000) : null;
  const keywords = Array.isArray(payload.keywords) ? (payload.keywords as unknown[]).map(String) : [];
  // lvc_rule carries provenance.dominantDomain; a reviewer-mined missed_rule carries provenance.category.
  const domain = String(provenance.dominantDomain || provenance.category || '');
  const actionType = domain === 'prescribing_safety' ? 'medication' : 'other';
  const ev0 = evidence[0] || {};
  const pmid = ev0.item_number && /^\d{5,9}$/.test(String(ev0.item_number)) ? String(ev0.item_number) : null;
  const url = ev0.url ? String(ev0.url) : null;
  await sql`
    INSERT INTO lvc_recommendations
      (id, region, society, specialty, statement, precondition, action_type, consider_instead,
       rationale, keywords, citation_doi, citation_pmid, citation_url, source_release_year,
       status, provenance, license_status)
    VALUES (${lvcId}, 'IN', 'EHRC', NULL, ${statement}, NULL, ${actionType}, NULL,
       ${rationale}, ${keywords}::text[], NULL, ${pmid}, ${url}, NULL,
       'active', 'EHRC-mined', 'ok')
    ON CONFLICT (id) DO UPDATE SET
      statement = EXCLUDED.statement, action_type = EXCLUDED.action_type, rationale = EXCLUDED.rationale,
      keywords = EXCLUDED.keywords, citation_pmid = EXCLUDED.citation_pmid, citation_url = EXCLUDED.citation_url,
      status = 'active', provenance = 'EHRC-mined', license_status = 'ok', updated_at = NOW()`;
  return lvcId;
}

/** On approve of a harvest_topic (LL.4): add the topic to ingest_topics so the EXISTING harvest
 *  cron (oldest-run-first) fetches + ingests literature for it on its next pass. We never touch the
 *  ingestion or corpus code — only the topic list, and only after human approval. An already-present
 *  topic is left exactly as configured (DO NOTHING) so we never re-enable or rewrite an admin's row.
 *  Returns the topic name as the applied ref. */
async function applyHarvestTopic(p: Record<string, unknown>): Promise<string | null> {
  const payload = asObj(p.payload);
  const topic = String(payload.topic || p.title || '').slice(0, 200).trim();
  const queryTerms = String(payload.query_terms || '').slice(0, 400).trim();
  if (!topic || !queryTerms) return null;
  await sql`
    INSERT INTO ingest_topics (topic, query_terms, enabled)
    VALUES (${topic}, ${queryTerms}, true)
    ON CONFLICT (topic) DO NOTHING`;
  return topic;
}

/** On approve of a suppression proposal (§2.3): re-run the DUAL-LABEL safety check at approval time
 *  (loadValidLabelInstances → previewCollateral) and create the suppression ONLY if it removes NONE
 *  of the CM-validated signals for its type. Unsafe → returns null; the caller refuses approval and
 *  leaves the proposal 'proposed'. The invariant is enforced here exactly as in the manual path —
 *  never weakened. Returns the created suppression id, or null when refused/invalid. */
async function applySuppression(p: Record<string, unknown>): Promise<string | null> {
  const payload = asObj(p.payload);
  const signal_type = String(payload.signal_type || '').trim();
  if (!signal_type) return null;
  const discriminator = payload.discriminator == null || payload.discriminator === '' ? null : String(payload.discriminator);
  const match_kind = payload.match_kind === 'subject_contains' && discriminator ? 'subject_contains' : 'type_only';
  const action = payload.action === 'drop' ? 'drop' : 'downgrade';
  const proposed: Suppression = { signal_type, discriminator, match_kind, scope: 'all', doctor_uid: null, action, active: true };
  const validSet = await loadValidLabelInstances(signal_type).catch(() => []);
  if (!previewCollateral(proposed, validSet).safe) return null;   // REFUSE — dual-label invariant intact
  const row = await createSuppression({
    signal_type, discriminator, match_kind, scope: 'all', action,
    reason: String(payload.reason || 'EHRC reviewer-mined suppression').slice(0, 1000),
    created_by: 'learning-loop', source_triage_ref: String(p.id).slice(0, 64),
  });
  return row.id;
}

/** Apply an approved proposal by type; null when the apply is refused (suppression fails the
 *  dual-label check) or invalid. Shared by reviewProposal + reconcileApproved. */
async function applyProposal(id: string, p: Record<string, unknown>): Promise<string | null> {
  const t = String(p.type);
  if (t === 'lvc_rule' || t === 'missed_rule') return applyLvcRule(id, p);
  if (t === 'harvest_topic') return applyHarvestTopic(p);
  if (t === 'suppression') return applySuppression(p);
  return null;
}

/** Approve, reject, or (missed_rule only) HARVEST a proposal. approve → the type's apply step
 *  (lvc_rule/missed_rule → lvc_recommendations; harvest_topic → ingest_topics; suppression →
 *  dual-label-gated audit_suppression). harvest → re-route a missed_rule into a harvest_topic
 *  instead of a rule. A suppression whose dual-label check fails is NOT approved (stays proposed). */
export async function reviewProposal(id: string, action: 'approve' | 'reject' | 'harvest', reviewer: string | null, note: string | null): Promise<boolean> {
  if (action === 'reject') {
    const rows = (await sql`
      UPDATE learning_proposals SET status = 'rejected', reviewed_by = ${reviewer}, reviewed_at = NOW(), review_note = ${note}, updated_at = NOW()
       WHERE id = ${id} AND app_source = ${APP} AND status = 'proposed' RETURNING id`) as Array<{ id: string }>;
    return rows.length > 0;
  }
  const props = (await sql`
    SELECT id, type, title, payload, evidence, provenance FROM learning_proposals
     WHERE id = ${id} AND app_source = ${APP} AND status = 'proposed'`) as Array<Record<string, unknown>>;
  if (!props.length) return false;
  const p = props[0];

  // harvest: a missed_rule the reviewer prefers to route to the corpus instead of publishing as a rule.
  if (action === 'harvest') {
    if (String(p.type) !== 'missed_rule') return false;
    const payload = asObj(p.payload);
    const topicP = { payload: { topic: String(p.title || '').slice(0, 200), query_terms: String((payload.keywords as unknown[] | undefined)?.join(' AND ') || p.title || '').slice(0, 400) }, title: p.title };
    const ref = await applyHarvestTopic(topicP as unknown as Record<string, unknown>);
    if (!ref) return false;
    const rows = (await sql`
      UPDATE learning_proposals SET status = 'approved', type = 'harvest_topic', reviewed_by = ${reviewer}, reviewed_at = NOW(), review_note = ${note}, applied_ref = ${ref}, updated_at = NOW()
       WHERE id = ${id} AND app_source = ${APP} AND status = 'proposed' RETURNING id`) as Array<{ id: string }>;
    return rows.length > 0;
  }

  const appliedRef = await applyProposal(id, p);
  if (appliedRef === null && String(p.type) === 'suppression') {
    // dual-label refusal — proposal stays 'proposed'; the invariant is never weakened to force it through.
    throw new Error('dual-label unsafe: this suppression would remove CM-validated signals — not approved');
  }
  const rows = (await sql`
    UPDATE learning_proposals SET status = 'approved', reviewed_by = ${reviewer}, reviewed_at = NOW(), review_note = ${note}, applied_ref = ${appliedRef}, updated_at = NOW()
     WHERE id = ${id} AND app_source = ${APP} AND status = 'proposed' RETURNING id`) as Array<{ id: string }>;
  return rows.length > 0;
}

// ── LEARNING-LOOP-V2 §2.1 — flywheel strip data (all fail-safe; any error → the pure builder still
//    renders "—" for that number, never a 500). The two headline ratios are computed for the FIRST
//    time here (attribution %, grounded %) over the distinct-note current-family 90d basis. ──
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export async function fetchFlywheelData(): Promise<FlywheelView> {
  // A — audits this week (IST Mon-start) + days elapsed into the week
  const a = await sql2(
    `SELECT count(*)::int AS audits_week, (${IST_TODAY} - ${IST_WEEK_START} + 1)::int AS days_elapsed
       FROM opd_note_audits
      WHERE app_source = $1 AND excluded_reason IS NULL AND engine_version = ANY($2)
        AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= ${IST_WEEK_START}`,
    [APP, ENGINE_FAMILY]).catch(() => []);
  // B — non-informational findings surfaced this week
  const b = await sql2(
    `SELECT count(*)::int AS findings_week
       FROM opd_note_audits a
       CROSS JOIN LATERAL jsonb_array_elements(a.findings) f
      WHERE a.app_source = $1 AND a.excluded_reason IS NULL AND a.engine_version = ANY($2)
        AND (a.note_date AT TIME ZONE 'Asia/Kolkata')::date >= ${IST_WEEK_START}
        AND COALESCE((f->>'informational')::boolean, false) = false`,
    [APP, ENGINE_FAMILY]).catch(() => []);
  // C — reviewer labels captured this week (all feedback scopes)
  const c = await sql2(
    `SELECT count(*)::int AS labels_week FROM opd_audit_feedback
      WHERE app_source = $1 AND study IS NOT DISTINCT FROM $2
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= ${IST_WEEK_START}`,
    [APP, null]).catch(() => []);
  // D — proposals approved this week, by type (rules published / topics harvested)
  const d = await sql2(
    `SELECT type, count(*)::int AS n FROM learning_proposals
      WHERE app_source = $1 AND status = 'approved'
        AND (reviewed_at AT TIME ZONE 'Asia/Kolkata')::date >= ${IST_WEEK_START}
      GROUP BY type`,
    [APP]).catch(() => []);
  // E — suppressions created this week
  const e = await sql2(
    `SELECT count(*)::int AS n FROM audit_suppression
      WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date >= ${IST_WEEK_START}`,
    []).catch(() => []);
  // F — THE TWO HEADLINE RATIOS (90d, current family, distinct latest audit per note — no double count):
  //     attribution = LVC findings carrying a rule_ref / all LVC findings
  //     grounded    = LLM findings with ≥1 citation / all LLM findings
  const f = await sql2(
    `WITH notes AS (
        ${canonicalDistinctOnSql({
          table: 'opd_note_audits',
          identity: 'uid',
          cols: 'findings',
          where: `app_source = $1 AND excluded_reason IS NULL AND engine_version = ANY($2)
           AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= ${IST_TODAY} - 90`,
        })})
     SELECT
       count(*) FILTER (WHERE fi->>'signal_type' = 'low_value_care')::int AS lvc_total,
       count(*) FILTER (WHERE fi->>'signal_type' = 'low_value_care' AND COALESCE(fi->>'rule_ref','') <> '')::int AS lvc_with_ref,
       count(*) FILTER (WHERE fi->>'source' = 'llm')::int AS llm_total,
       count(*) FILTER (WHERE fi->>'source' = 'llm' AND jsonb_array_length(COALESCE(fi->'citation_ids','[]'::jsonb)) > 0)::int AS llm_grounded
       FROM notes n
       CROSS JOIN LATERAL jsonb_array_elements(n.findings) fi
      WHERE COALESCE((fi->>'informational')::boolean, false) = false`,
    [APP, ENGINE_FAMILY]).catch(() => []);

  const fr = f[0] || {};
  return buildFlywheel({
    auditsWeek: num(a[0]?.audits_week), daysElapsed: Math.max(1, num(a[0]?.days_elapsed) || 1),
    engine: OPD_ENGINE_VERSION.replace(/^opd-note-audit\//, ''),
    findingsWeek: num(b[0]?.findings_week), labelsWeek: num(c[0]?.labels_week),
    approvedByType: (d as Array<Record<string, unknown>>).map((r) => ({ type: String(r.type), n: num(r.n) })),
    suppressionsWeek: num(e[0]?.n),
    lvcTotal: num(fr.lvc_total), lvcWithRef: num(fr.lvc_with_ref), llmTotal: num(fr.llm_total), llmGrounded: num(fr.llm_grounded),
  });
}

// ── LEARNING-LOOP-V2 §2.4 — model-programme meters. model_v1_version absent → every model-side meter
//    renders "armed — awaits engine freeze" (never faked); reviewer cadence always live. ──
async function settingValue(key: string): Promise<string | null> {
  const rows = await sql2(`SELECT value FROM app_settings WHERE key = $1`, [key]).catch(() => []);
  const v = rows[0]?.value;
  return v == null ? null : String(v).trim() || null;
}

export async function fetchProgrammeData(): Promise<Meter[]> {
  const frozenRaw = await settingValue('model_v1_version');
  // value may be a bare string or a JSON-quoted string; unwrap either → null when absent/empty.
  let frozenVersion: string | null = null;
  if (frozenRaw) { try { const p = JSON.parse(frozenRaw); frozenVersion = typeof p === 'string' && p.trim() ? p.trim() : (frozenRaw || null); } catch { frozenVersion = frozenRaw; } }

  const goal = parseGoal(await settingValue('review_goal'));
  let roster = FALLBACK_ROSTER.length;
  const rr = await settingValue('review_roster');
  if (rr) { try { const arr = JSON.parse(rr); if (Array.isArray(arr) && arr.length) roster = arr.length; } catch { /* keep fallback */ } }

  const cad = await sql2(
    `SELECT count(*)::int AS n FROM opd_audit_feedback
      WHERE app_source = $1 AND scope = 'finding' AND study IS NOT DISTINCT FROM $2
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= ${IST_WEEK_START}`,
    [APP, null]).catch(() => []);

  return buildMeters({
    frozenVersion,
    teacherPool: 0, evalPairs: 0, panelsFilled: 0, adjudications: 0,   // model-side: armed until freeze
    cadenceWeek: num(cad[0]?.n), cadenceTarget: goal.weekly_target, roster,
  });
}
