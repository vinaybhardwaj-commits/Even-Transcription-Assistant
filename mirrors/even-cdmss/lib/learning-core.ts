/**
 * lib/learning-core.ts — PURE core for the OPD-audit → CDMSS learning loop (LL.1/LL.2-v1).
 *
 * Mines accumulated OPD note-quality audit FINDINGS into candidate low-value-care RULE
 * proposals for the human review queue. PURE + unit-testable under
 * `node --experimental-strip-types` (data injected). NOTHING here touches the live engine,
 * the corpus, or `lvc_recommendations` — it only produces candidate proposals; applying an
 * approved proposal is a separate, gated step (LL.2b).
 *
 * v1 clustering is DETERMINISTIC (normalised-subject signature) — high precision, groups the
 * near-verbatim recurring findings the auditor LLM tends to emit. Merging paraphrases via a
 * Flash canonicalisation pass is the LL.2 enhancement; this first cut stays dependency-free.
 *
 * Two gates before a cluster becomes a proposal (locked 30 Jun):
 *   • volume   — ≥ minOccurrences AND across ≥ minDoctors distinct doctors
 *   • evidence — ≥ 1 corpus citation supporting it ("evidence over frequency", non-negotiable)
 */

export type ProposalType = 'lvc_rule' | 'harvest_article' | 'calibration';
export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';
export type SuggestedReviewer = 'pharmacy_ams' | 'dept_lead' | 'owner';

/** Minimal finding shape read from opd_note_audits.findings (jsonb). */
export interface AuditFindingLite {
  subject: string;
  verdict: string;          // low-value | context-dependent | high-value | uncertain
  domain: string;           // appropriateness | prescribing_safety
  rationale?: string;
  citation_ids?: number[];
  source?: string;          // 'llm' | 'deterministic'
  informational?: boolean;
}
/** Minimal source shape from opd_note_audits.sources (jsonb). */
export interface AuditSourceLite {
  n: number;
  source?: string; book?: string; chapter?: string | null;
  item_number?: string | null; url?: string | null; preview?: string;
}
export interface AuditRowLite {
  id: string;
  doctor_uid: string | null;
  consult_type: string | null;
  findings: AuditFindingLite[];
  sources: AuditSourceLite[];
}

export interface MineThresholds { minOccurrences: number; minDoctors: number; requireCitation: boolean }
export const DEFAULT_THRESHOLDS: MineThresholds = { minOccurrences: 15, minDoctors: 3, requireCitation: true };
// Harvest-gap gate (LL.4): high-volume practices the corpus could NOT support (uncited). Lower
// stakes than a clinical rule (it only steers what literature the harvester fetches), so a
// modest volume floor; evidence is by definition absent (that's what makes it a gap).
export const DEFAULT_GAP_THRESHOLDS: MineThresholds = { minOccurrences: 10, minDoctors: 3, requireCitation: false };

export interface HarvestGapCandidate {
  type: 'harvest_topic';
  clusterKey: string;
  title: string;            // canonical clinical topic the corpus is thin on
  payload: { topic: string; query_terms: string };
  provenance: {
    nOccurrences: number; nUncited: number; nDoctors: number; depts: string[]; sampleSubjects: string[];
    /** Live-probe corpus thinness ∈ [0,1] (1 = corpus has nothing). null when the cluster was not
     *  probed this run (probe budget) — then the candidate ranks by uncited volume, as before. */
    coverageDeficit?: number | null;
    demandRank?: number | null;   // 0–100, demandRankScore(); null ⇔ coverageDeficit null
  };
  confidence: number;
  suggestedReviewer: SuggestedReviewer;
}
// A practice is a corpus GAP when the auditor flagged it often but the corpus could rarely support
// it. "Rarely" = at most this fraction of occurrences carried a citation. Since HARVEST-DEMAND-RANK
// this is a cheap PRE-FILTER that narrows which clusters are worth a live probe — never the final
// gate. The final gate is the live retrieve() probe (covered → dropped), which cannot confuse
// "corpus has no evidence" with "the engine didn't attach any".
export const MAX_CITED_FRACTION = 0.5;

// ── Demand-rank (HARVEST-DEMAND-RANK §2.1) — one pure scorer, shared by BOTH harvest rails ──
/** Result of one live corpus probe, injected into the pure miners by the wired layer. */
export interface CoverageProbe { topSim: number; covered: boolean }
export interface DemandInputs { nUncited: number; nDoctors: number; coverageDeficit: number }

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Demand-rank 0–100, higher = harvest sooner. Every term is bounded, so no single cluster runs away:
 *    volume  = min(1, nUncited / 60)   — saturates; one huge cluster can't dominate
 *    breadth = min(1, nDoctors / 20)   — a pattern across many prescribers matters more
 *    deficit = coverageDeficit         — the live-probe corpus-thinness term
 *    score   = round(100 × (0.45·deficit + 0.35·volume + 0.20·breadth))
 *  Deficit carries the most weight because "demand-ranked" means rank by where the corpus is
 *  genuinely THIN — not by raw frequency. A high-volume practice the corpus already covers is a
 *  poor harvest target; a single-flag topic it cannot cite at all is an excellent one. */
export function demandRankScore(d: DemandInputs): number {
  const deficit = clamp01(d.coverageDeficit);
  const volume = clamp01(Math.max(0, Number(d.nUncited) || 0) / 60);
  const breadth = clamp01(Math.max(0, Number(d.nDoctors) || 0) / 20);
  return Math.round(100 * (0.45 * deficit + 0.35 * volume + 0.20 * breadth));
}

/** Corpus thinness from one probe: 1 − topHitSimilarity, clamped. Probe failure → the wired layer
 *  passes topSim 0 → deficit 1 (treat as uncovered — we would rather harvest than miss a gap).
 *  Quantised to 4dp so the value STORED in provenance is the exact value the rank was computed from
 *  (1 − 0.82 is 0.18000000000000005 in binary float) — a reviewer can recompute the pill by hand. */
export function coverageDeficitOf(topSim: number): number {
  return Math.round(clamp01(1 - (Number(topSim) || 0)) * 10000) / 10000;
}

export interface RuleCandidate {
  type: 'lvc_rule';
  clusterKey: string;
  title: string;
  payload: {
    statement: string;
    action_type: 'avoid' | 'limit' | 'prefer';
    rationale: string;
    keywords: string[];
    provenance: 'EHRC-mined';
  };
  evidence: AuditSourceLite[];
  provenance: {
    nOccurrences: number;
    nDoctors: number;
    depts: string[];
    exampleAuditIds: string[];
    sampleSubjects: string[];
    dominantDomain: string;
  };
  confidence: number;
  suggestedReviewer: SuggestedReviewer;
}

const STOP = new Set(['for', 'of', 'a', 'an', 'the', 'with', 'and', 'in', 'to', 'on', 'use', 'using',
  'ordering', 'order', 'prescription', 'prescribing', 'prescribed', 'management', 'choice', 'likely', 'acute']);

/** Normalised signature of a finding subject — clusters near-verbatim repeats (precision-first). */
export function subjectSignature(subject: string): string {
  const s = (subject || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')                                   // drop parentheticals
    .replace(/\b\d+(?:\.\d+)?\s?(?:mg|mcg|ug|g|gm|ml|iu|k|%|mmhg|mu\/l)?\b/g, ' ') // doses/numbers
    .replace(/[^a-z0-9 ]/g, ' ');
  const toks = s.split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
  return [...new Set(toks)].sort().join(' ').trim();
}

/** Keywords for the candidate rule (significant tokens, original order, deduped). */
export function subjectKeywords(subject: string): string[] {
  const s = (subject || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  const out: string[] = [];
  for (const t of s.split(/\s+/)) if (t.length > 2 && !STOP.has(t) && !out.includes(t)) out.push(t);
  return out.slice(0, 12);
}

function uniqStr(a: string[]): string[] { return [...new Set(a.map((x) => x.trim()).filter(Boolean))]; }

interface Cluster {
  key: string;
  subjects: string[];
  labels: string[];
  rationales: string[];
  doctors: Set<string>;
  depts: Set<string>;
  auditIds: string[];
  domains: Record<string, number>;
  verdicts: Record<string, number>;
  evidence: Map<string, AuditSourceLite>;   // dedup by url|item|preview
  n: number;
}

export interface MineOpts {
  /** Maps a finding subject → a canonical low-value-practice label (LL.2 Flash canonicalisation).
   *  When omitted, clustering falls back to the deterministic subject signature (LL.2-v1). */
  canonicalLabel?: (subject: string) => string;
  /** Live corpus probe per gap cluster, injected by the wired layer (keeps this miner pure + the
   *  probe budget bounded). `covered` → the corpus already supports the topic → the candidate is
   *  DROPPED. Absent/undefined → cluster was not probed → legacy uncited-volume ranking. */
  coverage?: (c: { title: string; clusterKey: string }) => CoverageProbe | null | undefined;
}

/** Findings eligible for low-value-care RULE mining: LLM clinical-judgment, low-value/context-
 *  dependent, appropriateness/prescribing. Excludes informational roll-ups + deterministic
 *  house-keeping (dosing/brand/formulary) + already-encoded rules (DDI/duplicate). */
export function isMineableFinding(f: AuditFindingLite): boolean {
  if (!f || f.informational) return false;
  if (f.source !== 'llm') return false;
  if (f.verdict !== 'low-value' && f.verdict !== 'context-dependent') return false;
  return f.domain === 'appropriateness' || f.domain === 'prescribing_safety';
}

/** Mine candidate low-value-care rules from audit rows. Pure. Clusters on the injected canonical
 *  label (paraphrases merge) or, absent one, the deterministic subject signature. */
export function mineRuleCandidates(rows: AuditRowLite[], thresholds: MineThresholds = DEFAULT_THRESHOLDS, opts: MineOpts = {}): RuleCandidate[] {
  const clusters = new Map<string, Cluster>();

  for (const row of rows || []) {
    const sources = row.sources || [];
    const byN = new Map(sources.map((s) => [s.n, s]));
    for (const f of row.findings || []) {
      if (!isMineableFinding(f)) continue;
      const rawLabel = opts.canonicalLabel ? (opts.canonicalLabel(f.subject) || '') : '';
      const key = rawLabel ? normalizeLabel(rawLabel) : subjectSignature(f.subject);
      if (!key || key.length < 4) continue;

      let c = clusters.get(key);
      if (!c) {
        c = { key, subjects: [], labels: [], rationales: [], doctors: new Set(), depts: new Set(), auditIds: [], domains: {}, verdicts: {}, evidence: new Map(), n: 0 };
        clusters.set(key, c);
      }
      c.n += 1;
      c.subjects.push(f.subject);
      if (rawLabel) c.labels.push(rawLabel);
      if (f.rationale) c.rationales.push(f.rationale);
      if (row.doctor_uid) c.doctors.add(row.doctor_uid);
      if (row.consult_type) c.depts.add(row.consult_type);
      if (c.auditIds.length < 20) c.auditIds.push(row.id);
      c.domains[f.domain] = (c.domains[f.domain] || 0) + 1;
      c.verdicts[f.verdict] = (c.verdicts[f.verdict] || 0) + 1;
      for (const cid of f.citation_ids || []) {
        const src = byN.get(cid);
        if (src) { const k = src.url || src.item_number || src.preview || `${src.n}`; if (!c.evidence.has(k)) c.evidence.set(k, src); }
      }
    }
  }

  const out: RuleCandidate[] = [];
  for (const c of clusters.values()) {
    const nDoctors = c.doctors.size;
    const hasEvidence = c.evidence.size > 0;
    if (c.n < thresholds.minOccurrences) continue;
    if (nDoctors < thresholds.minDoctors) continue;
    if (thresholds.requireCitation && !hasEvidence) continue;

    const title = mode(c.labels) || mode(c.subjects);
    const dominantDomain = mode(Object.entries(c.domains).flatMap(([d, n]) => Array(n).fill(d)));
    const dominantVerdict = (c.verdicts['low-value'] || 0) >= (c.verdicts['context-dependent'] || 0) ? 'low-value' : 'context-dependent';
    const action_type: RuleCandidate['payload']['action_type'] = dominantVerdict === 'low-value' ? 'avoid' : 'limit';
    const evidence = [...c.evidence.values()].slice(0, 4);
    // confidence: evidence-gated, scaled by volume + breadth, capped.
    const volScore = Math.min(0.4, (c.n - thresholds.minOccurrences) / 200 + 0.1);
    const breadthScore = Math.min(0.2, nDoctors / 50);
    const confidence = Math.min(0.9, 0.4 + volScore + breadthScore);

    out.push({
      type: 'lvc_rule',
      clusterKey: c.key,
      title,
      payload: {
        statement: `${action_type === 'avoid' ? 'Avoid' : 'Limit'}: ${title}`,
        action_type,
        rationale: mode(c.rationales) || c.rationales[0] || '',
        keywords: subjectKeywords(title),
        provenance: 'EHRC-mined',
      },
      evidence,
      provenance: {
        nOccurrences: c.n,
        nDoctors,
        depts: uniqStr([...c.depts]),
        exampleAuditIds: c.auditIds.slice(0, 8),
        sampleSubjects: uniqStr(c.subjects).slice(0, 5),
        dominantDomain,
      },
      confidence: Math.round(confidence * 100) / 100,
      suggestedReviewer: dominantDomain === 'prescribing_safety' ? 'pharmacy_ams' : (c.depts.size === 1 ? 'dept_lead' : 'owner'),
    });
  }
  // highest-signal first
  return out.sort((a, b) => b.provenance.nOccurrences - a.provenance.nOccurrences || b.confidence - a.confidence);
}

/** Build a PubMed query from a canonical topic label — significant terms AND-joined. Conservative;
 *  always human-reviewed before it is ever written to ingest_topics. */
export function harvestQuery(title: string): string {
  const kw = subjectKeywords(title);
  if (kw.length >= 2) return kw.slice(0, 6).join(' AND ');
  return (title || '').trim();
}

/** LL.4 — mine HARVEST-GAP candidates: high-volume mineable practices the corpus could NOT
 *  support (every occurrence uncited) → proposed harvest TOPICS. Pure. Clusters exactly like
 *  mineRuleCandidates but keeps only the fully-uncited clusters — i.e. the clusters the rule miner
 *  rejected for lack of evidence. Any corpus support at all → it's a rule's job, not a gap.
 *
 *  HARVEST-DEMAND-RANK §2.2: when `opts.coverage` injects a live probe, that probe becomes the
 *  final gate (covered → dropped, whatever citedFrac said) and the candidate is ranked by
 *  demandRankScore instead of raw uncited volume. Unprobed clusters keep the legacy behaviour. */
export function mineHarvestGaps(rows: AuditRowLite[], thresholds: MineThresholds = DEFAULT_GAP_THRESHOLDS, opts: MineOpts = {}): HarvestGapCandidate[] {
  const clusters = new Map<string, { key: string; subjects: string[]; labels: string[]; doctors: Set<string>; depts: Set<string>; cited: number; n: number }>();
  for (const row of rows || []) {
    for (const f of row.findings || []) {
      if (!isMineableFinding(f)) continue;
      const rawLabel = opts.canonicalLabel ? (opts.canonicalLabel(f.subject) || '') : '';
      const key = rawLabel ? normalizeLabel(rawLabel) : subjectSignature(f.subject);
      if (!key || key.length < 4) continue;
      let c = clusters.get(key);
      if (!c) { c = { key, subjects: [], labels: [], doctors: new Set(), depts: new Set(), cited: 0, n: 0 }; clusters.set(key, c); }
      c.n += 1;
      c.subjects.push(f.subject);
      if (rawLabel) c.labels.push(rawLabel);
      if (row.doctor_uid) c.doctors.add(row.doctor_uid);
      if (row.consult_type) c.depts.add(row.consult_type);
      if ((f.citation_ids || []).length > 0) c.cited += 1;
    }
  }
  const out: HarvestGapCandidate[] = [];
  for (const c of clusters.values()) {
    const uncited = c.n - c.cited;
    const citedFrac = c.n ? c.cited / c.n : 0;
    if (uncited < thresholds.minOccurrences) continue;   // ≥N occurrences the corpus could NOT support
    if (c.doctors.size < thresholds.minDoctors) continue;
    if (citedFrac > MAX_CITED_FRACTION) continue;        // corpus already covers it well enough → not a gap
    const title = mode(c.labels) || mode(c.subjects);
    const query_terms = harvestQuery(title);
    if (!title || !query_terms) continue;

    // Live probe (when this cluster was in the probe budget) — the FINAL coverage gate.
    const probe = opts.coverage ? opts.coverage({ title, clusterKey: c.key }) : undefined;
    if (probe && probe.covered) continue;           // corpus already covers it → not a harvest target
    const coverageDeficit = probe ? coverageDeficitOf(probe.topSim) : null;
    const demandRank = probe ? demandRankScore({ nUncited: uncited, nDoctors: c.doctors.size, coverageDeficit: coverageDeficit as number }) : null;

    const volScore = Math.min(0.4, (uncited - thresholds.minOccurrences) / 200 + 0.1);
    const breadthScore = Math.min(0.2, c.doctors.size / 50);
    const legacyConfidence = Math.round(Math.min(0.9, 0.4 + volScore + breadthScore) * 100) / 100;
    out.push({
      type: 'harvest_topic',
      clusterKey: c.key,
      title,
      payload: { topic: title, query_terms },
      provenance: { nOccurrences: c.n, nUncited: uncited, nDoctors: c.doctors.size, depts: uniqStr([...c.depts]), sampleSubjects: uniqStr(c.subjects).slice(0, 5), coverageDeficit, demandRank },
      confidence: demandRank == null ? legacyConfidence : demandRank / 100,
      suggestedReviewer: 'owner',
    });
  }
  // demand-ranked first (probed); unprobed clusters fall back to uncited volume and sort last.
  return out.sort((a, b) =>
    (b.provenance.demandRank ?? -1) - (a.provenance.demandRank ?? -1)
    || b.provenance.nUncited - a.provenance.nUncited
    || b.confidence - a.confidence);
}

// ── Reviewer-driven mining (LEARNING-LOOP-V2 §2.3) — the other half of the loop ──
// Pure: fed current-state feedback rows, produces the same proposal shapes the finding-miner does.

export function truncateCard(s: string, n = 140): string {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

// --- missed-flag mining: what reviewers said the audit MISSED → rule or harvest candidates ---
export interface MissedFlagLite { audit_id: string; category: string | null; comment: string; author: string | null }
export interface MissedRuleCandidate {
  type: 'missed_rule'; clusterKey: string; title: string;
  payload: { statement: string; action_type: 'avoid'; rationale: string; keywords: string[]; provenance: 'EHRC-mined' };
  provenance: { nFlags: number; reviewers: string[]; category: string | null; sampleComments: string[]; auditIds: string[] };
  confidence: number; suggestedReviewer: SuggestedReviewer;
}
export interface MissedHarvestCandidate {
  type: 'harvest_topic'; clusterKey: string; title: string;
  payload: { topic: string; query_terms: string };
  provenance: {
    nFlags: number; reviewers: string[]; category: string | null; sampleComments: string[]; auditIds: string[];
    source: 'missed_flags'; coverageDeficit?: number | null; demandRank?: number | null;
  };
  confidence: number; suggestedReviewer: SuggestedReviewer;
}
export type MissedCandidate = MissedRuleCandidate | MissedHarvestCandidate;

// HARVEST-DEMAND-RANK §2.3 — the frequency gate is SPLIT, because the two paths carry different
// stakes. Fetching evidence on a clinician's say-so is cheap and reversible, so ONE missed-flag is
// enough to harvest when the live probe says the corpus can't support the topic (the probe is the
// quality gate that replaces the frequency gate). Auto-drafting a rule that will FIRE on real notes
// is not: that still needs corroboration (≥2 flags) AND corpus evidence.
export const MISSED_HARVEST_MIN = 1;
export const MISSED_RULE_MIN = 2;
export interface MissedMineOpts {
  /** Corpus-citability decision per cluster (injected by the wired layer's retrieval; the same
   *  "is there evidence?" gate the rule miner applies). Absent → uncitable → harvest candidate. */
  isCitable?: (c: { title: string; keywords: string[]; category: string | null }) => boolean;
  /** Live corpus probe per cluster — supersedes isCitable when present, and additionally carries the
   *  similarity needed to demand-rank the harvest candidate. */
  coverage?: (c: { title: string; keywords: string[]; category: string | null }) => CoverageProbe | null | undefined;
}

/** Cluster current-state missed-finding flags by (category + normalized-comment signature), then:
 *    covered by the corpus  → ≥MISSED_RULE_MIN flags ⇒ DETERMINISTIC missed_rule draft; fewer ⇒ nothing
 *                             (the corpus already supports it, and one flag can't justify a rule)
 *    not covered            → ≥MISSED_HARVEST_MIN flags ⇒ harvest_topic, demand-ranked
 *  Comments truncated to 140 on the card. Pure — the coverage decision is injected. */
export function mineMissedFlags(flags: MissedFlagLite[], opts: MissedMineOpts = {}): MissedCandidate[] {
  const clusters = new Map<string, { key: string; category: string | null; comments: string[]; reviewers: Set<string>; auditIds: string[]; n: number }>();
  for (const fl of flags || []) {
    const comment = (fl.comment || '').trim();
    if (!comment) continue;
    const sig = subjectSignature(comment);
    if (!sig || sig.length < 4) continue;
    const key = `missed:${fl.category || ''}|${sig}`;
    let c = clusters.get(key);
    if (!c) { c = { key, category: fl.category ?? null, comments: [], reviewers: new Set(), auditIds: [], n: 0 }; clusters.set(key, c); }
    c.n += 1;
    c.comments.push(comment);
    if (fl.author) c.reviewers.add(fl.author);
    if (c.auditIds.length < 20 && fl.audit_id) c.auditIds.push(fl.audit_id);
  }
  const out: MissedCandidate[] = [];
  for (const c of clusters.values()) {
    if (c.n < MISSED_HARVEST_MIN) continue;
    const rep = mode(c.comments) || c.comments[0] || '';
    const title = truncateCard(rep, 80);
    const keywords = subjectKeywords(rep);
    const reviewers = uniqStr([...c.reviewers]);
    const sampleComments = uniqStr(c.comments).slice(0, 3).map((s) => truncateCard(s, 140));
    const auditIds = c.auditIds.slice(0, 8);
    const ruleConfidence = Math.round(Math.min(0.9, 0.4 + Math.min(0.3, (c.n - MISSED_RULE_MIN) / 20) + Math.min(0.2, reviewers.length / 10)) * 100) / 100;
    const probe = opts.coverage ? opts.coverage({ title, keywords, category: c.category }) : undefined;
    const citable = probe ? probe.covered : (opts.isCitable ? !!opts.isCitable({ title, keywords, category: c.category }) : false);

    if (citable) {
      // Corpus covers the topic. Harvesting it again adds nothing (the live gate drops it); the only
      // remaining path is a rule DRAFT, which needs corroboration.
      if (c.n < MISSED_RULE_MIN) continue;
      out.push({
        type: 'missed_rule', clusterKey: c.key, title,
        payload: { statement: truncateCard(rep, 300), action_type: 'avoid', rationale: `Reviewers flagged this as a finding the audit missed (${c.category || 'uncategorised'}).`, keywords, provenance: 'EHRC-mined' },
        provenance: { nFlags: c.n, reviewers, category: c.category, sampleComments, auditIds },
        confidence: ruleConfidence, suggestedReviewer: c.category === 'prescribing_safety' ? 'pharmacy_ams' : 'owner',
      });
    } else {
      // Uncovered: ≥1 flag is enough. Demand-rank it with flags as the volume proxy and the distinct
      // flagging reviewers as the breadth proxy.
      const coverageDeficit = probe ? coverageDeficitOf(probe.topSim) : null;
      const demandRank = probe ? demandRankScore({ nUncited: c.n, nDoctors: reviewers.length, coverageDeficit: coverageDeficit as number }) : null;
      out.push({
        type: 'harvest_topic', clusterKey: c.key, title,
        payload: { topic: title, query_terms: harvestQuery(title) },
        provenance: { nFlags: c.n, reviewers, category: c.category, sampleComments, auditIds, source: 'missed_flags', coverageDeficit, demandRank },
        confidence: demandRank == null ? ruleConfidence : demandRank / 100,
        suggestedReviewer: 'owner',
      });
    }
  }
  return out.sort((a, b) => b.provenance.nFlags - a.provenance.nFlags || b.confidence - a.confidence);
}

// --- false-cluster mining: finding classes reviewers repeatedly mark false → suppression candidates ---
export interface FindingLabelLite { audit_id: string; finding_ref: string; subject: string; signal_type: string | null; verdict: string; author: string | null }
export interface SuppressionCandidate {
  type: 'suppression'; clusterKey: string; title: string;
  payload: { signal_type: string; discriminator: string | null; match_kind: 'type_only' | 'subject_contains'; scope: 'all'; action: 'downgrade'; reason: string };
  provenance: { nFalseNitpick: number; reviewers: string[]; precision: number; nLabeled: number; sampleSubjects: string[]; auditIds: string[]; vouched?: boolean };
  confidence: number; suggestedReviewer: SuggestedReviewer;
}
export const FALSE_CLUSTER_MIN = 3;             // ≥3 false+nitpick
export const FALSE_CLUSTER_MIN_REVIEWERS = 2;   // across ≥2 reviewers
export const FALSE_PRECISION_MAX = 0.5;         // AND labeled-precision < 0.5

// ── Adjudication ledger routing (HARVEST-DEMAND-RANK §2.4) — GOVERNANCE ONLY ──
// The ledger (opd_feedback_adjudications) keys COARSE: `<signal_type>@<engine_version>`. A coarse key
// names a signal CLASS, never a clinical topic — so it structurally cannot say what to harvest. It
// therefore routes to suppression/fix governance ONLY, and NEVER creates a harvest_topic. Harvest is
// reviewer-driven, through the ≥1 missed-flag rail (§2.3).
export type AdjudicationRoute = 'suppression_vouch' | 'surfaced_only' | 'none';
export interface AdjudicationLite { clusterKey: string; decision: string; author: string | null; prdRef?: string | null }
export interface AdjudicationRouting {
  /** signal_types an adjudicator vouched for suppressing — relaxes the miner's ≥2-reviewer gate. */
  vouchedSignalTypes: string[];
  /** `fix` decisions: surfaced in the console with their PRD ref. No learning-loop mutation. */
  surfacedFixes: { clusterKey: string; signalType: string | null; prdRef: string | null }[];
  nSuppress: number;
  nFix: number;
}

/** `<signal_type>@<engine_version>` → signal_type. A key with no `@` (e.g. a bug id like `0.8-17`)
 *  names no signal class → null, and vouches nothing. */
export function adjudicationSignalType(clusterKey: string): string | null {
  const at = (clusterKey || '').indexOf('@');
  const t = (at > 0 ? clusterKey.slice(0, at) : '').trim();
  return t || null;
}

/** Where one adjudicated decision goes. Note that NO decision routes to harvest — by construction. */
export function routeAdjudication(decision: string): AdjudicationRoute {
  if (decision === 'suppress') return 'suppression_vouch';
  if (decision === 'fix') return 'surfaced_only';
  return 'none';   // accept | defer | monitor (and anything unknown) → no action
}

/** Reduce current-state ledger rows to the two governance outputs. Pure. */
export function routeAdjudications(rows: AdjudicationLite[]): AdjudicationRouting {
  const vouched = new Set<string>();
  const surfacedFixes: AdjudicationRouting['surfacedFixes'] = [];
  let nSuppress = 0; let nFix = 0;
  for (const r of rows || []) {
    const route = routeAdjudication(r.decision);
    if (route === 'suppression_vouch') {
      nSuppress++;
      const st = adjudicationSignalType(r.clusterKey);
      if (st) vouched.add(st);
    } else if (route === 'surfaced_only') {
      nFix++;
      surfacedFixes.push({ clusterKey: r.clusterKey, signalType: adjudicationSignalType(r.clusterKey), prdRef: r.prdRef ?? null });
    }
  }
  return { vouchedSignalTypes: [...vouched], surfacedFixes, nSuppress, nFix };
}

export interface FalseClusterOpts {
  /** signal_types an adjudicator has vouched for suppression (§2.4). For these the ≥2-REVIEWER gate
   *  relaxes to ≥1 — an adjudicated decision IS the second opinion the gate exists to demand. The
   *  volume (≥3) and precision (<0.5) gates still apply, and the DUAL-LABEL invariant is enforced
   *  independently at approval time (applySuppression) — never weakened here. */
  vouchedSignalTypes?: string[];
}

/** Cluster CURRENT-STATE finding labels by subject signature; a cluster becomes a suppression
 *  candidate when ≥3 false/nitpick across ≥2 reviewers AND precision (tp/(tp+nitpick+false)) < 0.5.
 *  Precision mirrors the rollup's open-adjudication threshold. An adjudicator `suppress` decision on
 *  the cluster's signal class vouches for it, relaxing the reviewer gate to ≥1 (§2.4). Pure. */
export function mineFalseClusters(labels: FindingLabelLite[], opts: FalseClusterOpts = {}): SuppressionCandidate[] {
  const vouched = new Set(opts.vouchedSignalTypes || []);
  const clusters = new Map<string, { key: string; subjects: string[]; signalTypes: Record<string, number>; verdicts: Record<string, number>; fnReviewers: Set<string>; auditIds: string[] }>();
  for (const l of labels || []) {
    const subject = (l.subject || '').trim();
    const sig = subjectSignature(subject);
    if (!sig || sig.length < 4) continue;
    let c = clusters.get(sig);
    if (!c) { c = { key: sig, subjects: [], signalTypes: {}, verdicts: {}, fnReviewers: new Set(), auditIds: [] }; clusters.set(sig, c); }
    c.subjects.push(subject);
    if (l.signal_type) c.signalTypes[l.signal_type] = (c.signalTypes[l.signal_type] || 0) + 1;
    c.verdicts[l.verdict] = (c.verdicts[l.verdict] || 0) + 1;
    if ((l.verdict === 'false' || l.verdict === 'nitpick') && l.author) c.fnReviewers.add(l.author);
    if (c.auditIds.length < 20 && l.audit_id) c.auditIds.push(l.audit_id);
  }
  const out: SuppressionCandidate[] = [];
  for (const c of clusters.values()) {
    const tp = c.verdicts['true_positive'] || 0;
    const nit = c.verdicts['nitpick'] || 0;
    const fal = c.verdicts['false'] || 0;
    const fn = nit + fal;
    const labeled = tp + nit + fal;
    if (fn < FALSE_CLUSTER_MIN) continue;
    const precision = labeled > 0 ? tp / labeled : 0;
    if (!(precision < FALSE_PRECISION_MAX)) continue;
    const signal_type = mode(Object.entries(c.signalTypes).flatMap(([s, n]) => Array(n).fill(s)));
    if (!signal_type) continue;
    // Reviewer gate AFTER the signal class is known: an adjudicator vouch on this class stands in for
    // the second reviewer (the labels may all be one person's — V/Zaki solo today).
    const isVouched = vouched.has(signal_type);
    const minReviewers = isVouched ? 1 : FALSE_CLUSTER_MIN_REVIEWERS;
    if (c.fnReviewers.size < minReviewers) continue;
    const title = mode(c.subjects);
    const discriminator = subjectKeywords(title)[0] || null;
    out.push({
      type: 'suppression', clusterKey: `false:${c.key}`, title,
      payload: {
        signal_type, discriminator, match_kind: discriminator ? 'subject_contains' : 'type_only', scope: 'all', action: 'downgrade',
        reason: `Reviewer-mined: ${fn} false/nitpick across ${c.fnReviewers.size} reviewer${c.fnReviewers.size === 1 ? '' : 's'} (precision ${precision.toFixed(2)} where labeled).${isVouched ? ` Adjudicated suppress on ${signal_type}.` : ''}`,
      },
      provenance: { nFalseNitpick: fn, reviewers: uniqStr([...c.fnReviewers]), precision: Math.round(precision * 100) / 100, nLabeled: labeled, sampleSubjects: uniqStr(c.subjects).slice(0, 5), auditIds: c.auditIds.slice(0, 8), vouched: isVouched },
      confidence: Math.round(Math.min(0.9, 0.4 + Math.min(0.3, (fn - FALSE_CLUSTER_MIN) / 10) + Math.min(0.2, c.fnReviewers.size / 10)) * 100) / 100,
      suggestedReviewer: 'pharmacy_ams',
    });
  }
  return out.sort((a, b) => b.provenance.nFalseNitpick - a.provenance.nFalseNitpick || b.confidence - a.confidence);
}

/** Stable cluster key from a canonical label — collapses minor wording/case drift across runs. */
export function normalizeLabel(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── LL.2 Flash canonicalisation: map varied finding subjects → one canonical practice label ──
export const CANONICALIZE_SYSTEM = `You group clinical-audit finding labels into canonical LOW-VALUE-CARE PRACTICES so that different wordings of the SAME underlying practice collapse to ONE label.

Given a numbered list of auditor finding "subjects", output for EACH a short canonical practice label (≤ 8 words) naming the underlying practice in GENERAL terms — drug class / test / procedure + indication where relevant — so paraphrases of the same practice get the IDENTICAL label.

Rules:
- Merge paraphrases: "Antibiotic for likely viral URTI", "Cefpodoxime for acute pharyngitis (viral)", "Antibiotic for acute URI" → all "Antibiotic for viral upper respiratory infection".
- Keep clinically distinct practices separate (different drug class, test, or indication → different label).
- Use generic molecule/class + indication; never brand names or doses.
- One entry per input index, covering every index exactly once.

Return ONLY JSON, no prose: {"map":[{"i":1,"label":"…"},{"i":2,"label":"…"}]}`;

export function buildCanonicalizeUser(subjects: string[]): string {
  return 'FINDING SUBJECTS:\n' + subjects.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

function extractJson(text: string): unknown {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { if (--depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Parse the canonicalisation response → { subject: canonicalLabel }. Unmapped subjects omitted. */
export function parseCanonicalMap(text: string, subjects: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const obj = extractJson(text) as { map?: unknown } | null;
  const arr = obj && Array.isArray(obj.map) ? obj.map : [];
  for (const e of arr) {
    const o = (e && typeof e === 'object' ? e : {}) as { i?: unknown; label?: unknown };
    const idx = Math.round(Number(o.i)) - 1;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (idx >= 0 && idx < subjects.length && label) out[subjects[idx]] = label;
  }
  return out;
}

/** Most frequent string in an array (first-seen tiebreak). */
function mode(arr: string[]): string {
  const counts = new Map<string, number>();
  let best = ''; let bestN = 0;
  for (const x of arr) {
    if (!x) continue;
    const n = (counts.get(x) || 0) + 1; counts.set(x, n);
    if (n > bestN) { bestN = n; best = x; }
  }
  return best;
}
