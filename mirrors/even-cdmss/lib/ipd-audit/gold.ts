/**
 * lib/ipd-audit/gold.ts — the frozen IPD audit gold (ipd-audit-gold/1.0): loader, validator,
 * and the governance hash-pin (S2 close, IPD Discharge Audit PRD).
 *
 * ROLE OF THIS GOLD: it is the engine's V-ratified OUTPUT, frozen (single-validator,
 * all 25 M0 cases accepted 16-Jul-2026). It measures REPRODUCIBILITY, cross-model
 * (Gemini↔Qwen) PARITY, and version-bump REGRESSION — not absolute accuracy against an
 * independent standard. That is its designed purpose for v1.
 *
 * PIN MECHANISM (mirrors the right-care-check-gold discipline): the case set is
 * canonicalised (JSON.stringify of the cases array as committed), SHA-256'd, and the hash
 * lives BOTH in the artifact header (content_sha256) and here as IPD_AUDIT_GOLD_SHA256.
 * lib/__tests__/ipd-audit-gold.test.ts recomputes on every `npm test`, so any drift in the
 * committed artifact — an edited rationale, a dropped case — fails CI. Changing the gold
 * legitimately means a NEW ratification: bump the version, re-pin, record V's sign-off.
 *
 * Pure module: no db, no fetch, no env. Node 'crypto' only (same tier as reasoning cores).
 */

import { createHash } from 'crypto';

// 2.0 (consensus-gold #7 — V, 18-Jul-2026, MAJOR: the reference's CONTENT changed): the
// low-value-care THEME set is re-adjudicated against the engine's K=5 union — 195 candidates
// V-rated tp/valid_extra/false/nitpick/contested. tp+valid_extra are the MATERIAL themes
// (findings); nitpick moves to a separate minor_findings tier (excluded from material
// recall/precision); false dropped; contested excluded. This removes the single-shot thinness
// bias that made 1.1's recall/precision (0.57/0.61) under-count the engine. The K=5 band/CVI
// DISTRIBUTION (1.1, S4 option b) and the high-value/uncertain findings are byte-preserved.
// (2 of the 195 verdicts were CC's SL2 verification posts, user-authorised to treat as ratified.)
export const IPD_AUDIT_GOLD_VERSION = 'ipd-audit-gold/2.0';

/** The governance pin — sha256 of JSON.stringify(gold.cases). Re-pinning requires V. */
export const IPD_AUDIT_GOLD_SHA256 = '9020a78a76cdda6d0046752f149e182e6cd02dc8a3645bedcf903dac57777e9f';

export interface IpdGoldFinding {
  subject: string;
  verdict: 'high-value' | 'context-dependent' | 'low-value' | 'uncertain';
  domain: string | null;
  rationale: string;
}

export interface IpdGoldCase {
  id: string;                 // IPD-G-NN
  ip_uid: string | null;      // link-back key (re-identification path; no names/UHID stored)
  // source_pdf_url is deliberately NOT in the committed gold (PHI-safety deviation, flagged):
  // the repo is public and the bucket publicly readable — document_id is the same
  // re-identification path, resolvable only via db13 / the access-controlled surface.
  document_id: string;
  speciality: string;
  month: string;              // YYYY-MM
  los_days: number | null;
  // 1.1: the band/CVI as a K=5 DISTRIBUTION, never a point value
  band_modal: string;         // mode of the 5-run bands — the ±1-tier reference
  band_range: string;         // distinct bands observed, best→worst span (e.g. 'B–C')
  cvi_mean: number;           // mean of the 5 runs (not median — raw draws not retained in the S4 pack)
  cvi_range: [number, number];
  k: number;                  // 5
  completeness_pct: number;
  missing_mandatory: string[];
  findings: IpdGoldFinding[];
  // 2.0: the nitpick tier — V-ratified as REAL but trivial (low-value noise). Deliberately
  // SEPARATE from `findings` so it never inflates the material recall/precision set. Optional
  // (absent/[] on cases with no nitpick).
  minor_findings?: IpdGoldFinding[];
}

export interface IpdAuditGold {
  version: string;
  status: string;
  validator: string;
  ratified_at: string;
  engine_version: string;
  model: string;
  n: number;
  content_sha256: string;
  cases: IpdGoldCase[];
}

const VERDICTS = new Set(['high-value', 'context-dependent', 'low-value', 'uncertain']);

/** Canonical content = the cases array exactly as committed (stable key order by construction). */
export function goldContentSha256(cases: unknown): string {
  return createHash('sha256').update(JSON.stringify(cases), 'utf8').digest('hex');
}

/**
 * Load + validate the committed artifact. THROWS on any drift: wrong version, not ratified,
 * wrong validator, case-count mismatch, hash mismatch (in-file OR against the pinned
 * constant), duplicate ids, or an out-of-enum verdict.
 */
export function loadIpdAuditGold(raw: unknown): IpdAuditGold {
  const g = raw as IpdAuditGold;
  if (g?.version !== IPD_AUDIT_GOLD_VERSION) throw new Error(`gold version ${g?.version} ≠ ${IPD_AUDIT_GOLD_VERSION}`);
  if (g.status !== 'ratified') throw new Error(`gold status '${g.status}' — only a ratified gold loads`);
  if (g.validator !== 'V') throw new Error('gold validator must be V (single-validator)');
  if (!Array.isArray(g.cases) || g.cases.length !== g.n) throw new Error(`gold has ${g.cases?.length} cases, header says n=${g.n}`);
  const sha = goldContentSha256(g.cases);
  if (sha !== g.content_sha256) throw new Error(`gold content drifted: sha ${sha.slice(0, 12)}… ≠ in-file ${String(g.content_sha256).slice(0, 12)}…`);
  if (sha !== IPD_AUDIT_GOLD_SHA256) throw new Error(`gold content ≠ the pinned governance hash — re-ratification required`);
  const seen = new Set<string>();
  const BANDS = new Set(['A', 'B', 'C', 'D', 'E']);
  for (const c of g.cases) {
    if (!c.id || seen.has(c.id)) throw new Error(`duplicate/missing case id ${c.id}`);
    seen.add(c.id);
    if (!BANDS.has(c.band_modal)) throw new Error(`${c.id}: band_modal '${c.band_modal}' outside A–E`);
    if (c.k !== 5 || !Array.isArray(c.cvi_range) || c.cvi_range.length !== 2) throw new Error(`${c.id}: malformed K=5 distribution block`);
    for (const f of c.findings) {
      if (!VERDICTS.has(f.verdict)) throw new Error(`${c.id}: verdict '${f.verdict}' outside the enum`);
    }
    for (const f of c.minor_findings ?? []) {
      if (!VERDICTS.has(f.verdict)) throw new Error(`${c.id}: minor verdict '${f.verdict}' outside the enum`);
    }
  }
  return g;
}
