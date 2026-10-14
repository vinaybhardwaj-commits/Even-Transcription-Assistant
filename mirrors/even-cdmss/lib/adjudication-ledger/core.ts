// lib/adjudication-ledger/core.ts — Adjudication Ledger (#3): the PURE federation core.
//
// The cross-cutting v2 measurement primitive. Every HUMAN adjudication on every surface — the IPD
// audit finding-triage, the OPD finding-triage, the IPD consensus-gold union, the EpisodeState
// reconstruction-fidelity ratings — normalizes to ONE shape here, so the federated adjudication
// stream IS the consensus gold, accumulating in real time. Read-time federation: no store migration,
// the live per-surface stores stay byte-for-byte as shipped (the SQL lives in federate.ts).
//
// TWO VERDICT FAMILIES, KEPT DISTINCT:
//   • finding-precision  (ipd_audit_feedback · opd_audit_feedback · ipd_gold_adjudication) →
//     TP / ValidExtra / False / Nitpick / Contested. Feeds precision.
//   • fidelity           (episode_recon_ratings) → Faithful / MissedMaterial / MisPhased /
//     OverIncluded. A BUILDER-fidelity measurement, NOT finding TP/False — kept OUT of the precision
//     denominator, surfaced as its own rollup. faithful is NEVER mapped to TP.
//
// THE HARD GUARDRAIL: federate HUMAN ground-truth ONLY. Machine/judge verdict stores
// (concordance_*, lvc_judge_verdicts, …) are the engine scoring ITSELF — folding them in would
// measure the engine against its own judge and corrupt precision. They are enumerated in
// EXCLUDED_MACHINE_STORES and a test asserts the federation set contains none of them.
//
// ADVISORY, NOT A SCORECARD: the ledger is an audit trail of what the AI proposed and what humans
// decided. "Who" is carried as a display field where present — it is NEVER a grouping key for a
// per-reviewer accuracy rollup. No rollup here keys by reviewer; a test enforces it. PURE: no db,
// no fetch, no env.

export const ADJUDICATION_LEDGER_VERSION = 'adjudication-ledger/1.0' as const;

export type VerdictFamily = 'finding' | 'fidelity';

/** finding-precision family — the human call on a finding the engine PRODUCED. */
export type FindingVerdict = 'TP' | 'ValidExtra' | 'False' | 'Nitpick' | 'Contested';
/** builder-fidelity family — the human call on whether the BUILDER faithfully reconstructed the
 *  documented course. Deliberately disjoint from the finding vocab. */
export type FidelityVerdict = 'Faithful' | 'MissedMaterial' | 'MisPhased' | 'OverIncluded';
export type CanonicalVerdict = FindingVerdict | FidelityVerdict;

/** A federated HUMAN adjudication store. `reviewerColumn` names the "who" column where the store
 *  captures it; null = the store has no per-reviewer attribution (anonymous, or single-validator V). */
export interface FederatedStore {
  store: string;                 // the live source table (read-only; never migrated)
  surface: string;               // display id
  surfaceLabel: string;
  family: VerdictFamily;
  reviewerColumn: string | null;
}

/**
 * THE FEDERATION SET — human ground-truth adjudication stores only. Verified in-repo (16→18 Jul):
 *  - ipd_audit_feedback     : S3.2 finding-triage posts true_positive/nitpick/false/contested
 *                             (the legacy agree/disagree/needs_action rows are WHOLE-AUDIT reactions,
 *                             finding_ref NULL — not finding precision; dropped by the finding map).
 *  - opd_audit_feedback     : scope='finding' rows, same OPD-grade vocab; `author` is the "who".
 *  - ipd_gold_adjudication  : the consensus-gold union verdicts (single-validator V).
 *  - episode_recon_ratings  : the FIDELITY family (V) — its own rollup, out of precision.
 */
export const FEDERATED_STORES: FederatedStore[] = [
  { store: 'ipd_audit_feedback', surface: 'ipd-audit', surfaceLabel: 'IPD audit', family: 'finding', reviewerColumn: null },
  { store: 'opd_audit_feedback', surface: 'opd-audit', surfaceLabel: 'OPD audit', family: 'finding', reviewerColumn: 'author' },
  { store: 'ipd_gold_adjudication', surface: 'ipd-consensus-gold', surfaceLabel: 'IPD consensus gold', family: 'finding', reviewerColumn: null },
  { store: 'episode_recon_ratings', surface: 'episode-recon', surfaceLabel: 'EpisodeState recon', family: 'fidelity', reviewerColumn: null },
];

/**
 * THE GUARDRAIL LIST — machine/judge verdict stores that must NEVER be federated. These are the
 * engine's OWN scoring / cross-model concordance / LLM-judge output — NOT human labels. Including any
 * of them would conflate "what the AI decided" with "what a human decided" and corrupt precision.
 * A test asserts FEDERATED_STORES ∩ this = ∅ and that federate.ts references none of them.
 */
// Named per the kickoff's `concordance_verdict*` + the judge/verdict tables. NB the cross-model
// concordance RUNS store is deliberately NOT listed here: it is a machine result store folded into
// `traces` and owned by the reasoning-governance layer, not a per-finding verdict table at risk of
// federation — and the literal table name is left unspelled so its parallel-store snapshot is unperturbed.
export const EXCLUDED_MACHINE_STORES = [
  'concordance_verdicts', 'concordance_verdict',
  'lvc_judge_verdicts', 'audit_verdicts', 'finding_verdicts',
  'missed_verdict', 'compensation_verdict',
] as const;

// ── verdict normalization (raw store vocab → canonical) ─────────────────────────────────────────
// finding family. `needs_action` is DELIBERATELY absent — it is a whole-audit reaction, not a
// finding-precision verdict, so it normalizes to null and is dropped from the precision family.
const FINDING_MAP: Record<string, FindingVerdict> = {
  true_positive: 'TP', tp: 'TP', agree: 'TP',
  valid_extra: 'ValidExtra', validextra: 'ValidExtra',
  false: 'False', disagree: 'False',
  nitpick: 'Nitpick',
  contested: 'Contested',
};
// fidelity family — faithful is NEVER 'TP'; it is its own thing.
const FIDELITY_MAP: Record<string, FidelityVerdict> = {
  faithful: 'Faithful',
  missed_material_fact: 'MissedMaterial', missed_material: 'MissedMaterial', 'missed-material': 'MissedMaterial',
  mis_phased: 'MisPhased', 'mis-phased': 'MisPhased',
  over_included: 'OverIncluded', 'over-included': 'OverIncluded',
};

/** Normalize a raw store verdict into the canonical vocab for its family. Returns null for values
 *  outside the family (e.g. needs_action, a bare audit comment) — the caller drops those rows. */
export function normalizeVerdict(family: VerdictFamily, raw: string | null | undefined): CanonicalVerdict | null {
  const k = String(raw ?? '').trim().toLowerCase();
  if (!k) return null;
  return family === 'fidelity' ? (FIDELITY_MAP[k] ?? null) : (FINDING_MAP[k] ?? null);
}

/** The canonical verdicts that count as a CORRECT engine positive for precision (numerator).
 *  ValidExtra joins TP: a valid-extra is a V-confirmed real finding the engine surfaced. */
export const PRECISION_POSITIVE: ReadonlySet<CanonicalVerdict> = new Set<CanonicalVerdict>(['TP', 'ValidExtra']);
/** The precision DENOMINATOR members: correct positives + False. Nitpick / Contested are excluded
 *  (the S3.2 convention); fidelity verdicts are excluded by family. */
export const PRECISION_DENOMINATOR: ReadonlySet<CanonicalVerdict> = new Set<CanonicalVerdict>(['TP', 'ValidExtra', 'False']);

// ── the normalized ledger row ───────────────────────────────────────────────────────────────────
export interface LedgerRow {
  surface: string;
  store: string;
  engine_version: string;         // the engine/builder version this adjudication is ABOUT
  audit_ref: string;              // link-back id (audit_id / case_id / document_id)
  finding_ref: string | null;
  finding_subject: string | null;
  engine_verdict: string | null;  // what the engine proposed, where the store carries it
  human_verdict: string;          // the raw human verdict (as stored)
  verdict_family: VerdictFamily;
  canonical_verdict: CanonicalVerdict;
  note: string | null;
  adjudicated_at: string;         // ISO
  reviewer: string | null;        // "who", where present — a DISPLAY field, never a rollup key
  link: string;                   // link-back URL to the source surface
}

// ── filters (pure) ──────────────────────────────────────────────────────────────────────────────
export interface LedgerFilter { surface?: string; engineVersion?: string; verdict?: string; family?: VerdictFamily; from?: string; to?: string }

export function filterRows(rows: LedgerRow[], f: LedgerFilter): LedgerRow[] {
  return rows.filter((r) => {
    if (f.surface && r.surface !== f.surface) return false;
    if (f.engineVersion && r.engine_version !== f.engineVersion) return false;
    if (f.verdict && r.canonical_verdict !== f.verdict) return false;
    if (f.family && r.verdict_family !== f.family) return false;
    if (f.from && r.adjudicated_at < f.from) return false;
    if (f.to && r.adjudicated_at > f.to) return false;
    return true;
  });
}

// ── rollup 1: precision per engine version (finding family only) ─────────────────────────────────
export interface PrecisionRow {
  surface: string;
  engine_version: string;
  tp: number; validExtra: number; falsePos: number; nitpick: number; contested: number;
  labeled: number;                // the precision denominator (tp + validExtra + falsePos)
  precision: number | null;       // (tp + validExtra) / labeled, or null when nothing labeled
}

/** Precision = correct-positives / (correct-positives + False), per (surface, engine_version).
 *  Finding family ONLY (fidelity excluded by family); Nitpick / Contested excluded from the
 *  denominator per the S3.2 convention. */
export function precisionByEngineVersion(rows: LedgerRow[]): PrecisionRow[] {
  const by = new Map<string, PrecisionRow>();
  for (const r of rows) {
    if (r.verdict_family !== 'finding') continue;
    const key = `${r.surface} ${r.engine_version}`;
    let p = by.get(key);
    if (!p) { p = { surface: r.surface, engine_version: r.engine_version, tp: 0, validExtra: 0, falsePos: 0, nitpick: 0, contested: 0, labeled: 0, precision: null }; by.set(key, p); }
    switch (r.canonical_verdict) {
      case 'TP': p.tp++; break;
      case 'ValidExtra': p.validExtra++; break;
      case 'False': p.falsePos++; break;
      case 'Nitpick': p.nitpick++; break;
      case 'Contested': p.contested++; break;
    }
  }
  for (const p of by.values()) {
    p.labeled = p.tp + p.validExtra + p.falsePos;
    p.precision = p.labeled > 0 ? (p.tp + p.validExtra) / p.labeled : null;
  }
  return [...by.values()].sort((a, b) => a.surface.localeCompare(b.surface) || a.engine_version.localeCompare(b.engine_version));
}

// ── page selectors (which family a page renders) — ADD, never move; federation is unchanged ──────
/** The finding-precision rows only (the Adjudication Ledger page). */
export function selectFinding(rows: LedgerRow[]): LedgerRow[] { return rows.filter((r) => r.verdict_family === 'finding'); }
/** The fidelity rows only (the Reconstruction Fidelity page). */
export function selectFidelity(rows: LedgerRow[]): LedgerRow[] { return rows.filter((r) => r.verdict_family === 'fidelity'); }

// ── rollup 1b: precision per SURFACE (headline), with the engine version as the drill-in ─────────
export interface SurfacePrecisionRow {
  surface: string;
  tp: number; validExtra: number; falsePos: number; nitpick: number; contested: number;
  labeled: number;
  precision: number | null;
  byVersion: PrecisionRow[];      // the per-engine-version breakdown — where drift lives
}

/** Precision grouped by surface FIRST (one row per surface), engine version as the drill-in. Reuses
 *  precisionByEngineVersion verbatim, so the convention is byte-identical — (TP+ValidExtra) over
 *  (TP+ValidExtra+False), Nitpick/Contested excluded, finding family only — just re-grouped. */
export function precisionBySurface(rows: LedgerRow[]): SurfacePrecisionRow[] {
  const by = new Map<string, SurfacePrecisionRow>();
  for (const pv of precisionByEngineVersion(rows)) {
    let s = by.get(pv.surface);
    if (!s) { s = { surface: pv.surface, tp: 0, validExtra: 0, falsePos: 0, nitpick: 0, contested: 0, labeled: 0, precision: null, byVersion: [] }; by.set(pv.surface, s); }
    s.tp += pv.tp; s.validExtra += pv.validExtra; s.falsePos += pv.falsePos; s.nitpick += pv.nitpick; s.contested += pv.contested;
    s.byVersion.push(pv);
  }
  for (const s of by.values()) {
    s.labeled = s.tp + s.validExtra + s.falsePos;
    s.precision = s.labeled > 0 ? (s.tp + s.validExtra) / s.labeled : null;
    s.byVersion.sort((a, b) => a.engine_version.localeCompare(b.engine_version));
  }
  return [...by.values()].sort((a, b) => a.surface.localeCompare(b.surface));
}

// ── rollup 2: verdict distribution (per surface + engine version) ────────────────────────────────
export interface DistributionRow { surface: string; engine_version: string; counts: Record<string, number>; total: number }

export function verdictDistribution(rows: LedgerRow[]): DistributionRow[] {
  const by = new Map<string, DistributionRow>();
  for (const r of rows) {
    const key = `${r.surface} ${r.engine_version}`;
    let d = by.get(key);
    if (!d) { d = { surface: r.surface, engine_version: r.engine_version, counts: {}, total: 0 }; by.set(key, d); }
    d.counts[r.canonical_verdict] = (d.counts[r.canonical_verdict] ?? 0) + 1;
    d.total++;
  }
  return [...by.values()].sort((a, b) => a.surface.localeCompare(b.surface) || a.engine_version.localeCompare(b.engine_version));
}

// ── rollup 3: volume over time (per day + surface) ───────────────────────────────────────────────
export interface VolumeRow { day: string; surface: string; n: number }

export function volumeOverTime(rows: LedgerRow[]): VolumeRow[] {
  const by = new Map<string, VolumeRow>();
  for (const r of rows) {
    const day = (r.adjudicated_at || '').slice(0, 10);
    if (!day) continue;
    const key = `${day} ${r.surface}`;
    const v = by.get(key) ?? { day, surface: r.surface, n: 0 };
    v.n++; by.set(key, v);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day) || a.surface.localeCompare(b.surface));
}

// ── rollup 4: fidelity (SEPARATE — never blended into precision) ─────────────────────────────────
export interface FidelityRow {
  engine_version: string;
  faithful: number; missedMaterial: number; misPhased: number; overIncluded: number;
  total: number;
  faithfulRate: number | null;    // faithful / total — a fidelity rate, NOT precision
}

/** The recon fidelity breakdown, its own panel. Fidelity family only; a faithful is NEVER counted
 *  as a TP and this never contributes to precisionByEngineVersion. */
export function fidelityRollup(rows: LedgerRow[]): FidelityRow[] {
  const by = new Map<string, FidelityRow>();
  for (const r of rows) {
    if (r.verdict_family !== 'fidelity') continue;
    let f = by.get(r.engine_version);
    if (!f) { f = { engine_version: r.engine_version, faithful: 0, missedMaterial: 0, misPhased: 0, overIncluded: 0, total: 0, faithfulRate: null }; by.set(r.engine_version, f); }
    switch (r.canonical_verdict) {
      case 'Faithful': f.faithful++; break;
      case 'MissedMaterial': f.missedMaterial++; break;
      case 'MisPhased': f.misPhased++; break;
      case 'OverIncluded': f.overIncluded++; break;
    }
    f.total++;
  }
  for (const f of by.values()) f.faithfulRate = f.total > 0 ? f.faithful / f.total : null;
  return [...by.values()].sort((a, b) => a.engine_version.localeCompare(b.engine_version));
}
