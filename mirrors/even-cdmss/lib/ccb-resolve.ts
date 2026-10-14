/**
 * lib/ccb-resolve.ts — member → episode resolver for the CCB consumer API (Pulse).
 *
 * Pulse keys on the MEMBER (member ID, UHID, or individual_uid), not our internal presc_uid.
 * This resolves those to the prescription uid(s) for the member's OPD episode(s):
 *   • member ID       → mobile → individual_uid  (via ccb-search, accounts-members → individuals)
 *   • uhid            → individual_uid via the maintained FK `individuals.kx_uhid`
 *   • individual_uid  → presc uid(s): a specific IST day if `date` is given, else the LATEST episode
 * Validated interpolation (mirrors lib/metabase.ts). Read-only.
 */

import { metabaseQuery, OPD_MEDICAL_TYPES } from './metabase';
import { bridgeMemberIdToIndividuals } from './ccb-search';

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const isUhid = (u: string) => /^[A-Za-z0-9/_-]{3,40}$/.test(u);
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const quotedTypes = () => OPD_MEDICAL_TYPES.map((t) => `'${t}'`).join(', ');

/** uhid → consumer individual_uid (via individuals.kx_uhid). Null if unmatched. */
export async function bridgeUhidToIndividual(uhid: string): Promise<string | null> {
  if (!isUhid(uhid)) return null;
  const rows = await metabaseQuery(`SELECT uid FROM individuals WHERE kx_uhid = '${uhid}' LIMIT 1`);
  const u = rows[0]?.uid ? String(rows[0].uid) : '';
  return isUid(u) ? u : null;
}

/** All medical OPD prescription uids for a member on an IST day (latest first). */
export async function resolveEpisodeUids(individualUid: string, day: string): Promise<string[]> {
  if (!isUid(individualUid) || !isDay(day)) return [];
  const rows = await metabaseQuery(
    `SELECT uid FROM "individuals-prescriptions"`
    + ` WHERE _parent_id = '${individualUid}' AND is_draft = false AND type_of_prescription IN (${quotedTypes()})`
    + ` AND (timestamp AT TIME ZONE 'Asia/Kolkata')::date = '${day}'`
    + ` ORDER BY timestamp DESC LIMIT 20`,
  );
  return rows.map((r) => String(r.uid)).filter(isUid);
}

/** Latest medical OPD prescription uids for a member (dateless — the "open latest" default). */
export async function resolveLatestEpisodeUids(individualUid: string): Promise<string[]> {
  if (!isUid(individualUid)) return [];
  const rows = await metabaseQuery(
    `SELECT uid FROM "individuals-prescriptions"`
    + ` WHERE _parent_id = '${individualUid}' AND is_draft = false AND type_of_prescription IN (${quotedTypes()})`
    + ` ORDER BY timestamp DESC LIMIT 20`,
  );
  return rows.map((r) => String(r.uid)).filter(isUid);
}

export interface ResolveInput { uid?: string; uhid?: string; individualUid?: string; memberId?: string; date?: string }

/** Resolve a request to a presc_uid: a direct `uid`, or a member key ({member_id|uhid|individual_uid})
 *  optionally scoped to a `date` (else the latest episode). Returns the chosen uid + the candidate list. */
export async function resolveBriefUid(p: ResolveInput): Promise<{ uid: string | null; candidates: string[] }> {
  if (p.uid && isUid(p.uid)) return { uid: p.uid, candidates: [p.uid] };

  let iuid = p.individualUid && isUid(p.individualUid) ? p.individualUid : null;
  if (!iuid && p.uhid) iuid = await bridgeUhidToIndividual(p.uhid).catch(() => null);
  if (!iuid && p.memberId) {
    const inds = await bridgeMemberIdToIndividuals(p.memberId).catch(() => [] as string[]);
    iuid = inds[0] ?? null;
  }
  if (!iuid) return { uid: null, candidates: [] };

  const eps = p.date && isDay(p.date)
    ? await resolveEpisodeUids(iuid, p.date).catch(() => [])
    : await resolveLatestEpisodeUids(iuid).catch(() => []);
  return { uid: eps[0] ?? null, candidates: eps };
}
