// lib/ipd-audit/episode-opd-adapter.ts — EpisodeState (#4) SL4: the OPD-linkage adapter.
//
// Resolves the admission's patient to their OPD longitudinal record and projects DE-IDENTIFIED
// pre/post phase facts. CONSUMER side (like toKxEnvelope) — EpisodeState never imports this; it
// stays standalone. Reads the OPD record via a de-identified db13 query (NOT member-state/**
// internals), keyed through the maintained `individuals.kx_uhid` bridge.
//
// THE PHI BOUNDARY. The patient uhid (PHI, from the kx admission header) is used ONLY as a
// transient JOIN KEY to resolve the OPD individual_uid — it is never placed in the linkage. The
// pure projector reads ONLY structured, inherently-de-identified fields (ICD codes, drug names,
// dates); the free-text OPD complaint narrative — where PHI would hide — is deliberately NOT
// projected. A structural test asserts no PHI reaches the phase facts.
//
// Best-effort: any failure (no member match, ~50% of admissions have no OPD history, a db outage)
// returns an empty/absent linkage — never throws, never fabricates a link.

import { metabaseQuery } from '../metabase';
import type { IpdAdmissionHeader } from './db13';
import type { OpdLinkage } from '../episode-state/build-intra';

const esc = (s: string) => String(s).replace(/'/g, "''");
const MAX_ITEMS = 15;   // keep the projected object bounded

/** One raw OPD encounter row — ONLY the whitelisted structured fields are typed/read. */
export interface OpdRow { day?: string | null; dx?: string | null; meds?: string | null }

const parseIcd = (dxText: string | null | undefined): string[] => {
  if (!dxText) return [];
  try { const a = JSON.parse(dxText); return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : []; }
  catch { return []; }
};
const parseMeds = (medsText: string | null | undefined): string[] => {
  if (!medsText) return [];
  try {
    const a = JSON.parse(medsText);
    if (!Array.isArray(a)) return [];
    return a.map((m) => String((m?.brand_name || m?.generic_name || '')).trim()).filter(Boolean);
  } catch { return []; }
};
const dayOf = (d: string | null | undefined): string => (d ? String(d).slice(0, 10) : '');

/**
 * PURE projector — raw OPD rows → de-identified OpdLinkage. A WHITELIST: it reads only `day`, `dx`
 * (ICD codes) and `meds` (drug names). Any PHI column present on the row is ignored by
 * construction. `pre` rows are pre-admission encounters; `post` rows are post-discharge.
 */
export function projectOpdLinkage(preRows: OpdRow[], postRows: OpdRow[]): OpdLinkage {
  const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean))).slice(0, MAX_ITEMS);
  const conditions = uniq(preRows.flatMap((r) => parseIcd(r.dx)));
  const medications = uniq(preRows.flatMap((r) => parseMeds(r.meds)));
  const followUps = postRows
    .map((r) => { const icd = parseIcd(r.dx); return [dayOf(r.day), icd.join(', ')].filter(Boolean).join(' · '); })
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
  return { pre: { conditions, medications }, post: { followUps } };
}

export interface OpdLinkageResult { linkage: OpdLinkage | null; linked: boolean; encountersPre: number; encountersPost: number }

/**
 * Resolve + project the OPD linkage for one admission. NEVER THROWS. `linked` is true when the
 * patient resolved to an OPD individual (regardless of whether they had encounters in-window).
 */
export async function resolveOpdLinkage(header: IpdAdmissionHeader | null, admitDate: string | null, dischargeDate: string | null): Promise<OpdLinkageResult> {
  const empty: OpdLinkageResult = { linkage: null, linked: false, encountersPre: 0, encountersPost: 0 };
  try {
    const uhid = header?.uhid;                       // PHI — transient join key ONLY, never projected
    if (!uhid || !admitDate) return empty;
    const iuRows = await metabaseQuery(`SELECT uid FROM individuals WHERE kx_uhid = '${esc(uhid)}' LIMIT 1`);
    const iu = iuRows[0]?.uid ? String(iuRows[0].uid) : null;
    if (!iu) return empty;                            // no member match ⇒ unlinked tail, empty pre/post

    const cols = `_create_time::date AS day, diagnosis_icd_codes::text AS dx, medications::text AS meds`;
    const preRows = await metabaseQuery(
      `SELECT ${cols} FROM "individuals-prescriptions" WHERE _parent_id = '${esc(iu)}' AND _create_time::date < '${esc(admitDate)}' ORDER BY _create_time DESC LIMIT 30`) as OpdRow[];
    const postRows = dischargeDate
      ? await metabaseQuery(`SELECT ${cols} FROM "individuals-prescriptions" WHERE _parent_id = '${esc(iu)}' AND _create_time::date > '${esc(dischargeDate)}' ORDER BY _create_time ASC LIMIT 30`) as OpdRow[]
      : [];
    return { linkage: projectOpdLinkage(preRows, postRows), linked: true, encountersPre: preRows.length, encountersPost: postRows.length };
  } catch (e) {
    console.warn('[episode-state] OPD linkage failed (non-fatal, empty pre/post):', String((e as Error).message).slice(0, 160));
    return empty;
  }
}
