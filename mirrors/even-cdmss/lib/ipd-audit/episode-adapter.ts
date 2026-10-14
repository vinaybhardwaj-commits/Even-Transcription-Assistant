// lib/ipd-audit/episode-adapter.ts — the bridge from the IPD audit pass to EpisodeState (#4 SL2).
//
// EpisodeState stays STANDALONE: it never imports ipd-audit. This adapter is the CONSUMER side —
// it knows both the ipd-audit read shapes (IpdAdmissionHeader, BillingEnvelope) and the
// EpisodeState input contract (KxEnvelope), and it wires build+persist into the audit pass as
// ADDITIVE + BEST-EFFORT: nothing here can throw, so a failure never breaks the audit that already
// ran. Forward-only (build at audit time); no backfill.

import type { ExtractedCase } from '../doc-audit-core';
import type { IpdAdmissionHeader } from './db13';
import type { BillingEnvelope } from './billing';
import { buildEpisodeState, type KxEnvelope } from '../episode-state/build-intra';
import { saveEpisodeState } from '../episode-state/store';
import { resolveOpdLinkage } from './episode-opd-adapter';

/**
 * PURE PHI-drop mapper: IpdAdmissionHeader + BillingEnvelope → the de-identified KxEnvelope.
 *
 * THE SECURITY BOUNDARY. IpdAdmissionHeader carries PHI — `patientName`, `uhid`, and the coarse
 * `ageGender` / `team` labels. This mapper is a WHITELIST: it constructs the envelope from an
 * explicit set of non-PHI fields, so a PHI field can never leak into EpisodeState even if the
 * header type later grows one. The structural test asserts the output keys are EXACTLY KxEnvelope's
 * and that no PHI value survives. Returns null when there is no link-back key to key on.
 */
export function toKxEnvelope(header: IpdAdmissionHeader | null, billing: BillingEnvelope | null): KxEnvelope | null {
  const episodeRef = header?.ipUid ?? billing?.ipUid ?? null;
  if (!episodeRef) return null;
  // EXPLICIT whitelist — never spread `header`; PHI (patientName/uhid/ageGender/team) is not copied.
  return {
    episodeRef,
    speciality: header?.speciality ?? null,
    ward: header?.ward ?? null,
    dischargeType: header?.dischargeType ?? null,
    admitDate: header?.admitDate ?? null,
    dischargeDate: header?.dischargeDate ?? null,
    losDays: header?.losDays ?? null,
    // ₹ to 2dp — kill the float representation noise at this boundary (the caller's job).
    netTotal: billing?.netTotal != null ? Math.round(billing.netTotal * 100) / 100 : null,
  };
}

export interface EpisodePersistResult { status: 'inserted' | 'updated' | 'skipped'; episodeRef: string; opdLinked: boolean; opdEncounters: number }

/**
 * Build + persist the EpisodeState for one audited discharge. NEVER THROWS — any failure (db13,
 * Neon, a malformed extract) is swallowed and returned as null, so the audit that already ran is
 * never affected. This is why it is safe to call from inside the audit pass's own try/catch.
 */
export async function persistEpisodeState(
  documentId: string, extracted: ExtractedCase,
  header: IpdAdmissionHeader | null, billing: BillingEnvelope | null,
): Promise<EpisodePersistResult | null> {
  try {
    const kx = toKxEnvelope(header, billing);
    // SL4: OPD pre/post linkage — best-effort, self-contained (resolveOpdLinkage never throws and
    // returns an empty linkage for the ~50% unlinked tail). An empty linkage ⇒ empty pre/post.
    const opd = await resolveOpdLinkage(header, kx?.admitDate ?? null, kx?.dischargeDate ?? null);
    const state = buildEpisodeState(extracted, kx, opd.linkage);
    const status = await saveEpisodeState(documentId, state);
    return { status, episodeRef: state.episodeRef, opdLinked: opd.linked, opdEncounters: opd.encountersPre + opd.encountersPost };
  } catch (e) {
    console.warn('[episode-state] persist failed (non-fatal, audit unaffected):', String((e as Error).message).slice(0, 200));
    return null;
  }
}
