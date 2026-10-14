import type { Sql } from '../../db/sql.js'
import { individualForPrescLookupSql, isInstant, isUid, prescriptionsForConsultSql, prescriptionsInWindowSql } from '../cdmss/db13-recipes.js'
import { encounterIdFor } from './identity.js'
import { addLink, currentLinks, type EncounterLink, type KeyKind, type LinkBasis, type LinkStatus } from './links.js'

/**
 * Link resolver (design D3). Resolves presc_uid, pulse_consult_uid and individual_uid for an encounter from
 * Pulse (db13 via Metabase) and appends encounter_links rows. Rules:
 *  - `verified` only ever comes from an exact Metabase lookup. A window match is `probable`.
 *  - A `probable` link is NEVER treated as verified downstream: read `link_status === 'verified'` (use
 *    `isVerified`), never the mere presence of a link. The resolver itself does not build on probable
 *    links as if verified: an individual_uid derived from a probable presc_uid stays probable.
 *  - Ambiguity (zero or several rows where exactly one is needed) writes no verified link.
 *  - Identifiers never leave encounter_links: this module logs nothing and returns codes and counts only.
 */

export type MetabaseOutcome =
  | { status: 'ok'; rows: Record<string, unknown>[] }
  | { status: 'unavailable'; recipe: string; reason: string }

/** The only I/O surface: a recipe name plus a SQL string built by db13-recipes. Wired to db13 later. */
export interface MetabaseClient {
  query(recipe: string, sql: string): Promise<MetabaseOutcome>
}

export interface ResolveHints {
  /** For the window fallback only. All three or none. */
  window?: { doctorUid: string; fromIso: string; toIso: string }
}

export interface ResolveResult {
  appended: number
  /** Codes only. */
  notes: ('metabase_unavailable' | 'no_prescription' | 'ambiguous_prescription' | 'window_ambiguous' | 'no_individual' | 'ambiguous_individual' | 'bad_hint')[]
}

export const isVerified = (link: EncounterLink | undefined): boolean => link?.link_status === 'verified'

const str = (v: unknown): string | null => (typeof v === 'string' && isUid(v) ? v : null)

/** Takes the consult_uid only: the encounter is encounterIdFor(consultUid), so no cross-consult link can be written. */
export async function resolveEncounterLinks(
  sql: Sql,
  mb: MetabaseClient,
  consultUid: string,
  hints: ResolveHints = {},
): Promise<ResolveResult> {
  const encounter = { encounterId: encounterIdFor(consultUid), consultUid }
  const result: ResolveResult = { appended: 0, notes: [] }

  /** Skips a write that would repeat the current newest row, so repeated resolver runs stay quiet. */
  const put = async (key_kind: KeyKind, value: string, link_status: LinkStatus, basis: LinkBasis) => {
    const cur = (await currentLinks(sql, encounter.encounterId))[key_kind]
    if (cur && cur.value === value && cur.link_status === link_status && cur.basis === basis) return
    // Never downgrade a verified link for the same value.
    if (cur && cur.value === value && cur.link_status === 'verified' && link_status !== 'verified') return
    await addLink(sql, encounter.encounterId, { key_kind, value, link_status, basis })
    result.appended += 1
  }

  // (a) prescriptions for the ETA consult_uid.
  let presc: { prescUid: string; consultUid: string | null; exact: boolean } | null = null
  const exact = await mb.query('presc_for_consult', prescriptionsForConsultSql(encounter.consultUid))
  if (exact.status === 'unavailable') {
    result.notes.push('metabase_unavailable')
  } else {
    const rows = exact.rows.map((r) => ({ p: str(r.presc_uid), c: str(r.pulse_consult_uid) })).filter((r) => r.p && r.c === encounter.consultUid)
    if (rows.length === 1) {
      presc = { prescUid: rows[0]!.p!, consultUid: rows[0]!.c, exact: true }
      await put('presc_uid', presc.prescUid, 'verified', 'metabase_lookup')
      await put('pulse_consult_uid', presc.consultUid!, 'verified', 'metabase_lookup')
    } else if (rows.length > 1) {
      // Same consult_uid on several prescriptions: the consult link is exact, but no single presc_uid is.
      result.notes.push('ambiguous_prescription')
      await put('pulse_consult_uid', encounter.consultUid, 'verified', 'metabase_lookup')
    } else if (isVerified((await currentLinks(sql, encounter.encounterId)).presc_uid)) {
      // A verified presc_uid already exists: a window guess must not supersede it.
      result.notes.push('no_prescription')
    } else if (hints.window) {
      const w = hints.window
      if (!isUid(w.doctorUid) || !isInstant(w.fromIso) || !isInstant(w.toIso)) {
        result.notes.push('bad_hint')
      } else {
        const win = await mb.query('presc_in_window', prescriptionsInWindowSql(w.doctorUid, w.fromIso, w.toIso))
        if (win.status === 'unavailable') {
          result.notes.push('metabase_unavailable')
        } else {
          const cand = win.rows.map((r) => ({ p: str(r.presc_uid), c: str(r.pulse_consult_uid) })).filter((r) => r.p)
          if (cand.length === 1) {
            presc = { prescUid: cand[0]!.p!, consultUid: cand[0]!.c, exact: false }
            await put('presc_uid', presc.prescUid, 'probable', 'room_doctor_window')
            if (presc.consultUid) await put('pulse_consult_uid', presc.consultUid, 'probable', 'room_doctor_window')
          } else {
            result.notes.push(cand.length === 0 ? 'no_prescription' : 'window_ambiguous')
          }
        }
      }
    } else {
      result.notes.push('no_prescription')
    }
  }

  // (b) individual_uid for the current presc_uid. Verified only for a verified presc_uid and exactly one row.
  const after = await currentLinks(sql, encounter.encounterId)
  const prescLink = presc ? { value: presc.prescUid, verified: presc.exact } : after.presc_uid ? { value: after.presc_uid.value, verified: isVerified(after.presc_uid) } : null
  // A refused presc_uid yields no individual lookup and no individual link.
  if (prescLink && after.presc_uid?.link_status !== 'refused') {
    const ind = await mb.query('individual_for_presc', individualForPrescLookupSql(prescLink.value))
    if (ind.status === 'unavailable') {
      result.notes.push('metabase_unavailable')
    } else {
      const ids = Array.from(new Set(ind.rows.map((r) => str(r.individual_uid)).filter((v): v is string => v !== null)))
      if (ind.rows.length === 1 && ids.length === 1) {
        await put('individual_uid', ids[0]!, prescLink.verified ? 'verified' : 'probable', 'metabase_lookup')
      } else {
        result.notes.push(ind.rows.length === 0 ? 'no_individual' : 'ambiguous_individual')
      }
    }
  }
  return result
}
