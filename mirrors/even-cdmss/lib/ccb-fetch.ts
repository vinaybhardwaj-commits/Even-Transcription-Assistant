/**
 * ⚠️ RETIRED SURFACE — DO NOT DELETE. The mechanics here are LIVE.
 *
 * Care Conversation Briefs was retired as a care-manager product on 30 Jul 2026 — non-use, not
 * malfunction. The nav card is gone and the batch cron is paused, so this code is now invisible,
 * unused-looking and untraced: exactly the profile a tech-debt sweep deletes. It must not be.
 *
 * These mechanics are the best working example of ClinicalState, MemberState and the longitudinal
 * spine in the system, and they are RE-EXPOSED as a microservice behind /api/v1/patient-summary,
 * which feeds the physician's pre-encounter Patient Summary in Pulse (the OPD HIS). Deleting or
 * "cleaning up" anything here breaks that API.
 *
 * See: CDMSS-CCB-REPURPOSE-PRD-v0.1-30-JUL-2026 and the Patient Summary API kickoff (30 Jul 2026),
 * and the entry in CDMSS-OPEN-ISSUE-REGISTER-23-JUL-2026.md.
 *
 * ⚠️ HAZARD — CCB_ENABLED IS NOT A CCB FLAG. It gates ALL EIGHT /care pages: /care, /care/briefs,
 * /care/m/[uid], /care/[uid], /care/triage, /care/review, /care/lvc, /care/concepts. Setting it to
 * 0 does NOT disable CCB — it 404s the entire care-manager surface and takes down OPD Audit
 * Triage, LVC adjudication, Concept Coder and Review Mode with it. The flag keeps its name by
 * decision; this warning is the mitigation.
 */
/**
 * lib/ccb-fetch.ts — Care Conversation Brief: episode bundler (WIRED).
 *
 * Reads db13 through the existing Metabase reader (lib/metabase.ts → `metabaseQuery`),
 * using the pure, validated SQL builders + mappers in ccb-fetch-core.ts. Server-only.
 *
 * `assembleEpisode(prescUid)`:
 *   1. fetch the anchor prescription (individual_uid via `_parent_id`, kx_encounter_id, …)
 *   2. bridge individual_uid → kx_uhid (individuals.kx_uhid)
 *   3. in parallel: kx order ledger (by uhid) + consumer result PDFs (by individual_uid)
 *   4. coverage = reports.length ? 'rich' : 'order_only'  (graceful degradation)
 *
 * Identifiers stay in db13 and on the returned bundle; they are NOT sent to any LLM
 * by this module (the brief generator de-identifies before any model call).
 */

import { metabaseQuery } from './metabase';
import { rowToOpdCase } from './opd-ingest-core';
import {
  prescriptionSql, bridgeSql, ordersSql, reportsSql,
  mapPrescription, mapOrders, mapReports, buildBundle, bundleWindow,
  isUhid,
  type EpisodeBundle,
} from './ccb-fetch-core';

export interface AssembleOpts {
  /** days before / after the note day to gather orders + result PDFs (reports land late). */
  back?: number;
  fwd?: number;
}

/** Assemble a member's episode bundle from a prescription uid. Returns null if the
 *  prescription isn't found. Order/report reads soft-fail to empty (never throw the bundle away). */
export async function assembleEpisode(prescUid: string, opts: AssembleOpts = {}): Promise<EpisodeBundle | null> {
  const prescRows = await metabaseQuery(prescriptionSql(prescUid));
  if (!prescRows.length) return null;

  // Clean, de-identified content via the OPD-audit extractor (dpipe primary + HTML-stripped fallback).
  const { case: oc } = rowToOpdCase(prescRows[0]);
  const { keys, prescription } = mapPrescription(prescRows[0], oc);

  // Bridge: individual_uid → EHRC uhid (maintained FK).
  try {
    const b = await metabaseQuery(bridgeSql(keys.individualUid));
    const uhid = b[0]?.kx_uhid;
    keys.kxUhid = isUhid(uhid) ? uhid : null;
  } catch { /* bridge best-effort */ }

  const { d0, d1 } = bundleWindow(keys.noteDate, opts.back, opts.fwd);

  const [orders, reports] = await Promise.all([
    keys.kxUhid
      ? metabaseQuery(ordersSql(keys.kxUhid, d0, d1)).then(mapOrders).catch(() => [])
      : Promise.resolve([]),
    metabaseQuery(reportsSql(keys.individualUid, d0, d1)).then(mapReports).catch(() => []),
  ]);

  return buildBundle(keys, prescription, orders, reports);
}
