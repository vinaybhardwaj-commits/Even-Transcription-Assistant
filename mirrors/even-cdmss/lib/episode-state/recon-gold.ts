/**
 * lib/episode-state/recon-gold.ts — the frozen EpisodeState reconstruction-fidelity gold
 * (episode-recon-gold/1.0): loader, validator, and the governance hash-pin (EpisodeState #4 SL5b).
 *
 * ROLE OF THIS GOLD: V's per-(case, phase) ratings of whether the assembled EpisodeState faithfully
 * represents the documented discharge course — faithful / missed_material_fact / mis_phased /
 * over_included. It measures BUILDER FIDELITY (completeness + phase-correctness), a bench DISTINCT
 * from the audit engine's recall/precision (ipd-audit-gold) and from the OPD link rate.
 *
 * PARTIAL BY DESIGN: V rated a stratified ~half and stopped intentionally. This gold is computed over
 * EXACTLY V's genuine verdicts — nothing backfilled, un-rated phases simply absent. (CC's SL5a
 * build-time test posts on IP-100 pre/intra were excluded; IP-100 keeps its V-rated post.) V's rated
 * set is ALL FAITHFUL (70 faithful, 0 miss / mis-phased / over-included). That means the bench has NO
 * negative examples: it shows no completeness misses across the sampled strata, but it CANNOT
 * characterise a miss rate or exercise the miss / mis-phased / over-included modes at all. It does
 * NOT license "the builder is provably faithful".
 *
 * PIN MECHANISM (mirrors ipd-audit/gold.ts): the cases array is canonicalised (JSON.stringify as
 * committed), SHA-256'd, and the hash lives BOTH in the artifact header (content_sha256) and here as
 * EPISODE_RECON_GOLD_SHA256. lib/__tests__/episode-recon-gold.test.ts recomputes on every `npm test`,
 * so any drift — an edited verdict, a dropped case — fails CI. Changing the gold legitimately means a
 * NEW ratification: bump the version, re-pin, record V's sign-off.
 *
 * Pure module: no db, no fetch, no env. Node 'crypto' only (same tier as the reasoning cores).
 * De-identified: ip_uid / document_id link-back keys + clinical strata only — no names/UHID/URLs.
 */

import { createHash } from 'crypto';

export const EPISODE_RECON_GOLD_VERSION = 'episode-recon-gold/1.0';

/** The governance pin — sha256 of JSON.stringify(gold.cases). Re-pinning requires V. */
export const EPISODE_RECON_GOLD_SHA256 = 'cfa86d3c3e50515ed1e49c0fbfeef4fee221709bc5456b7d2380d1f05a12ff3e';

export type ReconVerdict = 'faithful' | 'missed_material_fact' | 'mis_phased' | 'over_included';
export type ReconPhase = 'pre' | 'intra' | 'post';
export type ReconLinkage = 'linked' | 'intra-only';

export interface ReconGoldCase {
  ip_uid: string;               // admission link-back key (not PHI)
  document_id: string;          // db13 doc id — the re-identification path, resolvable only via db13
  speciality: string;           // clinical stratum
  linkage: ReconLinkage;        // OPD-linked (pre/post populated) vs intra-only
  phases: Partial<Record<ReconPhase, ReconVerdict>>;   // only the phases V actually rated
  notes?: Partial<Record<ReconPhase, string>>;         // V's rationale where entered (de-identified)
}

export interface EpisodeReconGold {
  version: string;
  status: string;
  validator: string;
  ratified_at: string;
  builder_version: string;
  n_cases: number;
  n_phases: number;
  content_sha256: string;
  cases: ReconGoldCase[];
}

const VERDICTS = new Set<ReconVerdict>(['faithful', 'missed_material_fact', 'mis_phased', 'over_included']);
const PHASES = new Set<ReconPhase>(['pre', 'intra', 'post']);

/** Canonical content = the cases array exactly as committed (stable key order by construction). */
export function reconGoldContentSha256(cases: unknown): string {
  return createHash('sha256').update(JSON.stringify(cases), 'utf8').digest('hex');
}

/** Count the rated (case, phase) verdicts — the gold's actual size. */
export function reconPhaseCount(cases: ReconGoldCase[]): number {
  return cases.reduce((n, c) => n + Object.keys(c.phases).length, 0);
}

/**
 * Load + validate the committed artifact. THROWS on any drift: wrong version, not ratified, wrong
 * validator, case/phase-count mismatch, hash mismatch (in-file OR against the pinned constant),
 * duplicate ids, an out-of-enum verdict, or an out-of-enum phase.
 */
export function loadEpisodeReconGold(raw: unknown): EpisodeReconGold {
  const g = raw as EpisodeReconGold;
  if (g?.version !== EPISODE_RECON_GOLD_VERSION) throw new Error(`recon gold version ${g?.version} ≠ ${EPISODE_RECON_GOLD_VERSION}`);
  if (g.status !== 'ratified') throw new Error(`recon gold status '${g.status}' — only a ratified gold loads`);
  if (g.validator !== 'V') throw new Error('recon gold validator must be V (single-validator)');
  if (!Array.isArray(g.cases) || g.cases.length !== g.n_cases) throw new Error(`recon gold has ${g.cases?.length} cases, header says n_cases=${g.n_cases}`);
  const sha = reconGoldContentSha256(g.cases);
  if (sha !== g.content_sha256) throw new Error(`recon gold content drifted: sha ${sha.slice(0, 12)}… ≠ in-file ${String(g.content_sha256).slice(0, 12)}…`);
  if (sha !== EPISODE_RECON_GOLD_SHA256) throw new Error('recon gold content ≠ the pinned governance hash — re-ratification required');
  const seen = new Set<string>();
  let phases = 0;
  for (const c of g.cases) {
    if (!c.ip_uid || seen.has(c.ip_uid)) throw new Error(`duplicate/missing case ip_uid ${c.ip_uid}`);
    seen.add(c.ip_uid);
    if (c.linkage !== 'linked' && c.linkage !== 'intra-only') throw new Error(`${c.ip_uid}: linkage '${c.linkage}' outside enum`);
    for (const [ph, v] of Object.entries(c.phases)) {
      if (!PHASES.has(ph as ReconPhase)) throw new Error(`${c.ip_uid}: phase '${ph}' outside pre|intra|post`);
      if (!VERDICTS.has(v as ReconVerdict)) throw new Error(`${c.ip_uid}.${ph}: verdict '${v}' outside the enum`);
      phases++;
    }
  }
  if (phases !== g.n_phases) throw new Error(`recon gold has ${phases} rated phases, header says n_phases=${g.n_phases}`);
  return g;
}
