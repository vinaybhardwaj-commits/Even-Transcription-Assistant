/**
 * lib/ccb-search.ts — Care Conversation Brief: MEMBER SEARCH (WIRED).
 *
 * "Same as Pulse search": resolve a care manager's free-text query (member ID, phone, name,
 * individual UID, or UHID) to the member(s) and their recent OPD episodes, so the /care surface
 * can show a picker and open the brief. Reads db13 through the existing Metabase reader; all SQL
 * is built by the pure, validated builders in ccb-search-core.ts. Server-only, read-only.
 *
 * Identifiers stay in db13 and on the returned hits (the CM needs the phone/UHID to place the
 * call); they are NOT sent to any LLM by this module — the brief generator de-identifies later.
 */

import { metabaseQuery, OPD_MEDICAL_TYPES } from './metabase';
import {
  classifyQuery, planHasProbe,
  membersByMemberIdSql, individualsByMobilesSql, individualByUidSql, individualsByUhidSql,
  individualUidByPrescSql, individualsByNameSql, membershipByMobilesSql, individualsByUidsSql,
  episodesByParentsSql, latestEpisodeSql,
  mapIndividualRow, buildHits, fullName, computeAge, isUid, isMobile,
  type IndividualIdentity, type MemberHit,
} from './ccb-search-core';

const CANDIDATE_CAP = 25; // hard ceiling on distinct members we hydrate per search

/** Resolve a free-text query to ranked member hits (with recent episodes). Empty on no/short query. */
export async function searchMembers(q: string, opts: { limit?: number } = {}): Promise<MemberHit[]> {
  const plan = classifyQuery(q);
  if (!planHasProbe(plan)) return [];

  const identities = new Map<string, IndividualIdentity>();
  const addRows = (rows: Record<string, unknown>[]) => {
    for (const r of rows) { const id = mapIndividualRow(r); if (id && !identities.has(id.uid)) identities.set(id.uid, id); }
  };
  const safe = async (sqlText: string): Promise<Record<string, unknown>[]> => metabaseQuery(sqlText).catch(() => []);

  // Independent direct probes (phone / uhid / uid / name) run in parallel.
  const direct: Promise<Record<string, unknown>[]>[] = [];
  if (plan.phone) direct.push(safe(individualsByMobilesSql([plan.phone])));
  if (plan.uhid) direct.push(safe(individualsByUhidSql(plan.uhid)));
  if (plan.uid) direct.push(safe(individualByUidSql(plan.uid)));
  if (plan.nameTokens) direct.push(safe(individualsByNameSql(plan.nameTokens)));
  for (const rows of await Promise.all(direct)) addRows(rows);

  // Member ID → mobile(s) → individuals (two-hop; accounts-members has no individual_uid FK).
  if (plan.memberId && identities.size < CANDIDATE_CAP) {
    const memberRows = await safe(membersByMemberIdSql(plan.memberId));
    const mobiles = Array.from(new Set(memberRows.map((r) => String(r.mobile || '')).filter(isMobile)));
    if (mobiles.length) addRows(await safe(individualsByMobilesSql(mobiles)));
  }

  // Prescription uid → owning individual (back-compat with old presc-uid links).
  if (plan.uid && identities.size < CANDIDATE_CAP) {
    const pr = await safe(individualUidByPrescSql(plan.uid));
    const parent = pr[0]?.individual_uid ? String(pr[0].individual_uid) : '';
    if (isUid(parent) && !identities.has(parent)) addRows(await safe(individualByUidSql(parent)));
  }

  const idList = Array.from(identities.values()).slice(0, CANDIDATE_CAP);
  if (!idList.length) return [];
  const uids = idList.map((i) => i.uid);
  const allMobiles = Array.from(new Set(idList.flatMap((i) => i.mobiles).filter(isMobile)));

  // Episodes + membership labels in parallel.
  const [episodeRows, membershipRows] = await Promise.all([
    safe(episodesByParentsSql(uids, OPD_MEDICAL_TYPES)),
    allMobiles.length ? safe(membershipByMobilesSql(allMobiles)) : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  const membershipByMobile: Record<string, string> = {};
  for (const r of membershipRows) {
    const mob = String(r.mobile || ''); const mid = r.membership_id ? String(r.membership_id) : '';
    if (mob && mid && !membershipByMobile[mob]) membershipByMobile[mob] = mid;
  }

  return buildHits(idList, episodeRows, membershipByMobile, { limit: opts.limit ?? 12 });
}

/** Member ID → individual uid(s) (for the Pulse brief resolver). Best-effort, read-only. */
export async function bridgeMemberIdToIndividuals(memberId: string): Promise<string[]> {
  try {
    const memberRows = await metabaseQuery(membersByMemberIdSql(memberId));
    const mobiles = Array.from(new Set(memberRows.map((r) => String(r.mobile || '')).filter(isMobile)));
    if (!mobiles.length) return [];
    const indRows = await metabaseQuery(individualsByMobilesSql(mobiles));
    return indRows.map((r) => String(r.uid || '')).filter(isUid);
  } catch { return []; }
}

export interface MemberIdentity { individualUid: string; name: string; gender: string | null; age: number | null }

/** Batch-resolve individual_uid → display identity (name/age/sex) for labelling the flagged
 *  worklist. db13 read; best-effort (returns {} on failure so the surface degrades to uhid-only). */
export async function resolveMemberIdentities(uids: string[]): Promise<Record<string, MemberIdentity>> {
  const clean = Array.from(new Set((uids || []).filter(isUid)));
  if (!clean.length) return {};
  try {
    const rows = await metabaseQuery(individualsByUidsSql(clean));
    const out: Record<string, MemberIdentity> = {};
    for (const r of rows) {
      const id = mapIndividualRow(r);
      if (id) out[id.uid] = { individualUid: id.uid, name: fullName(id.firstName, id.lastName, id.displayName), gender: id.gender, age: computeAge(id.dob) };
    }
    return out;
  } catch { return {}; }
}

/** Latest medical OPD episode uid for a member (dateless — the CM "open latest" default). */
export async function latestMedicalEpisodeUid(individualUid: string): Promise<string | null> {
  if (!isUid(individualUid)) return null;
  try {
    const rows = await metabaseQuery(latestEpisodeSql(individualUid, OPD_MEDICAL_TYPES));
    const uid = rows[0]?.uid ? String(rows[0].uid) : '';
    return isUid(uid) ? uid : null;
  } catch { return null; }
}
