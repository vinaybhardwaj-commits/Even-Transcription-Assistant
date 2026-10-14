/**
 * lib/record-audit-link-store.ts — Record-audit member linkage (Right Care × ClinicalState
 * Slice 1, Part C). Stores the identity extracted FOR LINKAGE ONLY from an uploaded record
 * into record_audit_member_links (migration 0011) — a table physically separate from the
 * de-identified run row, so identity lives ALONGSIDE the clinical record, never inside it.
 *
 * Store layer by design (architecture boundary): this is the ONLY module that writes the
 * linkage table, and identity never flows into ClinicalState, ExtractedCase, AuditReport,
 * or appropriateness_runs.output. Resolution to resolved_individual_uid is deferred to the
 * downstream identity bridge — rows are written with it NULL. Dark behind
 * RIGHT_CARE_CLINICAL_STATE=1 + RECORD_AUDIT_LINK=1 (both default OFF). Soft-fails like
 * the runs store: a linkage failure never breaks the run save or the UX.
 */

import { sql } from './db';

const run = sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>;

/** The raw member linkage key, exactly as the identity-only pass read it off the document. */
export interface MemberLink { uhid?: string; mrn?: string; name?: string; dob?: string }

const LINK_KEYS = ['uhid', 'mrn', 'name', 'dob'] as const;
const MAX_FIELD = 200;

/** Both persistence flags must be on for any identity capture or linkage write (Part D). */
export function recordAuditLinkEnabled(): boolean {
  return process.env.RIGHT_CARE_CLINICAL_STATE === '1' && process.env.RECORD_AUDIT_LINK === '1';
}

/** Validate an untrusted value into a MemberLink: known keys only, non-empty trimmed strings,
 *  length-capped. Returns null when nothing usable remains — nothing to link on. */
export function parseMemberLink(x: unknown): MemberLink | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const out: MemberLink = {};
  for (const k of LINK_KEYS) {
    const v = o[k];
    if (typeof v !== 'string') continue;
    const t = v.trim().slice(0, MAX_FIELD);
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** Persist the linkage key for a saved audit run. resolved_individual_uid deliberately NULL —
 *  resolution is the downstream identity bridge's job. Soft-fails to false. */
export async function saveMemberLink(runId: string, link: MemberLink): Promise<boolean> {
  if (!runId) return false;
  try {
    await run(
      `INSERT INTO record_audit_member_links (run_id, member_link)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (run_id) DO NOTHING`,
      [runId, JSON.stringify(link)],
    );
    return true;
  } catch (e) {
    console.warn('[record-audit-link] saveMemberLink failed', (e as Error).message);
    return false;
  }
}
