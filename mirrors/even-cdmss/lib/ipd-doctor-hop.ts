/**
 * lib/ipd-doctor-hop.ts — the PARTIAL inpatient → clinician identity hop
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A1; spec §5.3, D-identity, acceptance #6).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT REFUSES TO BE.
 *
 * `ipd_discharge_audits` has no `doctor_uid` column and this file does not give it one. The hop is
 * READ-TIME ONLY (A1): db13's `kx_ip_admissions.current_treating_doctor_id` is a KarExpert
 * practitioner id, and `doctors` carries the same namespace in two places —
 * `karexpert_metadata__practitioner_id` and the VALUES of the jsonb
 * `karexpert_metadata__practitioner_id_by_hospital`. Their union is the only measured bridge.
 *
 * MEASURED 29 Aug 2026 on db13, checked into
 * `handoff-docs/CDMSS-STEWARDSHIP-SQL-VALIDATION-AND-HOP-MEASURE-29-AUG-2026.md`:
 *
 *   stays in the 90-day window          1267
 *   stays carrying a treating id        1045
 *   distinct treating ids                110
 *   match `doctors.uid`                    0 / 110
 *   match `karexpert_metadata__uid`        0 / 110
 *   match the practitioner-id union       68 / 110
 *   practitioner ids that are AMBIGUOUS     7   (each maps to exactly 2 doctors.uid)
 *   stays resolvable                     483 / 1045   (46.2%)   ← the ADMISSIONS-table basis
 *
 * ⚠️ THE BOARD'S BASIS IS SMALLER, AND IT IS THE ONE THE BANNER MUST QUOTE (round-2 validation,
 * finding F-1, 29 Aug). The numbers above are over the admissions table's 1,045 filled stays. The
 * board's population is the AUDITED stays — `ipd_board_stays`, engine 0.2, 90 IST days — and over
 * that population the same hop measures:
 *
 *   audited stays in the window          685
 *   resolved to one clinician            281   (41.0%)   ← the AUDITED-STAY basis
 *   unmatched practitioner id            320
 *   no treating id / not in admissions    77
 *   ambiguous practitioner id              7
 *   ambiguous stay                         0   (unit-test-only today)
 *
 * The two bases are both true and they answer different questions; the board must quote the second,
 * because that is the population its column is drawn from. `hopCoverageLine` computes the rate LIVE
 * from what was actually asked, so the banner cannot fall out of date with either number.
 *
 * So this hop resolves well under half the audited stays, and that is the honest ceiling — not a bug
 * to be engineered away with a looser rule.
 *
 * THE FOUR REFUSALS, each of which has a name because each has been proposed:
 *
 *   1. AN AMBIGUOUS PRACTITIONER ID NEVER RESOLVES. Seven ids map to two `doctors.uid` each. The
 *      in-window one is `0dd90283-71cf-11f0-9659-1243a45a76a3-1021357153`, 10 stays behind it, the
 *      SAME display name on both rows and two different e-mails. Picking either would be a coin
 *      toss recorded as a fact about a named clinician.
 *   2. E-MAIL IS NOT A TIEBREAK. The obvious repair — "when two uids compete, prefer the one whose
 *      e-mail matches" — dies on the measurement: Example Person's two rows share the identical
 *      address `person@example.com`. This file reads no e-mail column at all, and a test asserts it.
 *   3. NO DISPLAY-NAME JOIN, EVER (D-identity, refuse-list §8). Name matching was 87/140 at the
 *      27 Aug cut and it is forbidden regardless of its rate. `resolveDoctor` in
 *      lib/ipd-audit/doctor-lookup.ts stays exactly as it is — the IPD list's name chrome — and this
 *      file neither calls it nor duplicates it.
 *   4. NOTHING IS WRITTEN. No `doctor_uid` lands on `ipd_discharge_audits`. A1 says read time, and a
 *      stored hop would outlive the day its rate was measured.
 *
 * FAIL-CLOSED IS THE WHOLE DESIGN. Unmatched, ambiguous, unfilled, two treating ids on one stay,
 * db13 unreachable — every one of them is `unjoined`, and the surface shows the split banner and an
 * honest count rather than a number that quietly covers half the ward.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ INFERRED SQL: this sandbox has no live DB. The two db13 strings are exported verbatim in
 * `HOP_INFERRED_SQL` and listed in the slice report. `metabaseQuery` takes NO bind parameters
 * (lib/metabase.ts), so values are filtered and single-quote-escaped before interpolation — the same
 * `IN (…)` pattern lib/ipd-audit/doctor-lookup.ts already uses against this same database.
 */
import { metabaseQuery } from './metabase';

/** ip_uid shapes seen live: `IP-1250`, `IPNO-229`, `ER-511`. Mirrors lib/ipd-audit/db13.ts. */
const isIpUid = (s: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(s);
const esc = (s: string) => s.replace(/'/g, "''");

/** Why a stay did not resolve. Every one of these renders as `IPD unjoined`, but the MS can see
 *  WHICH kind of not-knowing it is, which is the difference between a data gap and a duplicate. */
export type HopReason =
  | 'resolved'
  | 'no_treating_id'          // the admission carries no treating doctor at all
  | 'unmatched_practitioner'  // the id is real and matches no doctors row (42 of 110 ids)
  | 'ambiguous_practitioner'  // the id maps to more than one doctors.uid (7 of 110 ids)
  | 'ambiguous_stay';         // the stay itself names two different treating ids

export interface HopResult {
  /** The Even `doctors.uid`, or null. Null is a REFUSAL, never a default. */
  doctorUid: string | null;
  reason: HopReason;
}

export const UNJOINED: HopResult = Object.freeze({ doctorUid: null, reason: 'unmatched_practitioner' });

// ── the pure half ─────────────────────────────────────────────────────────────────────────

/** One row of the practitioner map as db13 returns it: an id, how many uids claim it, and (when
 *  exactly one does) that uid. */
export interface PractitionerMapRow { pid: string; nUids: number; uid: string | null }

export interface PractitionerMap {
  /** practitioner id → the single `doctors.uid` that claims it. Ambiguous ids are NOT in here. */
  unique: Map<string, string>;
  /** practitioner ids claimed by more than one uid. Present so the surface can say WHY. */
  ambiguous: Set<string>;
}

/**
 * PURE — the union map, with ambiguity kept rather than resolved. An id claimed by two rows is put
 * in `ambiguous` and left out of `unique`, so every lookup through this map is a lookup that
 * cannot silently pick a winner.
 */
export function buildPractitionerMap(rows: readonly PractitionerMapRow[]): PractitionerMap {
  const unique = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const r of rows ?? []) {
    const pid = String(r?.pid ?? '').trim();
    if (!pid) continue;
    const n = Number(r?.nUids ?? 0);
    const uid = String(r?.uid ?? '').trim();
    if (n === 1 && uid) unique.set(pid, uid);
    else if (n > 1) { ambiguous.add(pid); unique.delete(pid); }
  }
  return { unique, ambiguous };
}

/** One admission row: a stay and the practitioner currently treating it. */
export interface AdmissionRow { ipUid: string; treatingId: string | null }

/**
 * PURE — stay → clinician, or a named refusal.
 *
 * A stay appearing twice with two DIFFERENT treating ids is `ambiguous_stay`, not "the last one
 * wins". `kx_ip_admissions` is not guaranteed one row per encounter, and a consultant handover
 * recorded as a second row is exactly the case where guessing attributes a stay to the wrong
 * clinician on a board that names them.
 */
export function resolveStays(
  admissions: readonly AdmissionRow[],
  map: PractitionerMap,
): Record<string, HopResult> {
  const treatingByStay = new Map<string, string | null | 'CONFLICT'>();
  for (const a of admissions ?? []) {
    const ip = String(a?.ipUid ?? '').trim();
    if (!ip) continue;
    const tid = String(a?.treatingId ?? '').trim() || null;
    if (!treatingByStay.has(ip)) { treatingByStay.set(ip, tid); continue; }
    const seen = treatingByStay.get(ip)!;
    if (seen === 'CONFLICT') continue;
    if (seen !== tid && tid !== null && seen !== null) treatingByStay.set(ip, 'CONFLICT');
    else if (seen === null && tid) treatingByStay.set(ip, tid);
  }

  const out: Record<string, HopResult> = {};
  for (const [ip, tid] of treatingByStay) {
    if (tid === 'CONFLICT') { out[ip] = { doctorUid: null, reason: 'ambiguous_stay' }; continue; }
    if (!tid) { out[ip] = { doctorUid: null, reason: 'no_treating_id' }; continue; }
    if (map.ambiguous.has(tid)) { out[ip] = { doctorUid: null, reason: 'ambiguous_practitioner' }; continue; }
    const uid = map.unique.get(tid);
    out[ip] = uid ? { doctorUid: uid, reason: 'resolved' } : { doctorUid: null, reason: 'unmatched_practitioner' };
  }
  return out;
}

export interface HopCoverage {
  /** Stays we asked about. */
  asked: number;
  /** Stays the admissions table knows at all. */
  known: number;
  resolved: number;
  ambiguousPractitioner: number;
  ambiguousStay: number;
  unmatched: number;
  noTreatingId: number;
  /** True when db13 could not be reached: EVERYTHING is unjoined and the surface says so. */
  unavailable: boolean;
}

/** PURE — the honest counts A1 requires on the board ("IPD joined for n of m stays"). */
export function hopCoverage(asked: number, byIpUid: Record<string, HopResult>, unavailable = false): HopCoverage {
  const c: HopCoverage = {
    asked, known: 0, resolved: 0, ambiguousPractitioner: 0, ambiguousStay: 0,
    unmatched: 0, noTreatingId: 0, unavailable,
  };
  for (const r of Object.values(byIpUid)) {
    c.known += 1;
    if (r.reason === 'resolved') c.resolved += 1;
    else if (r.reason === 'ambiguous_practitioner') c.ambiguousPractitioner += 1;
    else if (r.reason === 'ambiguous_stay') c.ambiguousStay += 1;
    else if (r.reason === 'no_treating_id') c.noTreatingId += 1;
    else c.unmatched += 1;
  }
  return c;
}

/**
 * The one sentence the board shows beside the inpatient column. The rate is computed from what was
 * actually ASKED — the audited stays the board reads — so it is the audited-stay basis by
 * construction and cannot drift from the file header. It never appears without its fraction beside
 * it: a rate with no denominator is how "41%" becomes "most of them".
 */
export function hopCoverageLine(c: HopCoverage): string {
  if (c.unavailable) return 'The inpatient clinician hop could not be read just now, so every stay is shown unjoined.';
  const unresolved = c.asked - c.resolved;
  const share = c.asked > 0 ? ` (${Math.round((100 * c.resolved) / c.asked)}% of audited stays)` : '';
  return `IPD joined for ${c.resolved} of ${c.asked} stays${share} · ${unresolved} unjoined `
    + `(${c.unmatched} practitioner id not in the roster, ${c.ambiguousPractitioner} id claimed by two clinicians, `
    + `${c.ambiguousStay} stay naming two clinicians, ${c.noTreatingId} with no treating clinician recorded, `
    + `${Math.max(0, c.asked - c.known)} not found in the admissions table).`;
}

// ── the db13 reads (INFERRED, fail-soft) ──────────────────────────────────────────────────

/**
 * H1 — the practitioner-id union map. `karexpert_metadata__practitioner_id` is a scalar column; the
 * by-hospital column is a jsonb object whose VALUES are practitioner ids, so it is unnested. The
 * `::jsonb` cast is deliberate: it is a no-op if the column is already jsonb and it makes the query
 * work if the column is text or json.
 *
 * `count(DISTINCT uid)` is what makes ambiguity VISIBLE rather than collapsed — the whole point.
 * `min(uid)` is only ever read when that count is 1.
 */
const PRACTITIONER_MAP_SQL = `
SELECT pid, count(DISTINCT uid)::int AS n_uids, min(uid) AS uid
  FROM (
    SELECT karexpert_metadata__practitioner_id AS pid, uid
      FROM doctors
     WHERE karexpert_metadata__practitioner_id IS NOT NULL
       AND karexpert_metadata__practitioner_id <> ''
    UNION ALL
    SELECT v.value #>> '{}' AS pid, d.uid
      FROM doctors d
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN d.karexpert_metadata__practitioner_id_by_hospital IS NULL THEN '{}'::jsonb
             ELSE d.karexpert_metadata__practitioner_id_by_hospital::jsonb END) v
     WHERE v.value #>> '{}' IS NOT NULL AND v.value #>> '{}' <> ''
  ) m
 GROUP BY pid`;

/** H2 — the stays we are asking about, and who is treating them. `encounter_id` is the column that
 *  matches `ipd_discharge_audits.ip_uid` (spec §5.3). Escaped `IN (…)` — no bind params exist. */
function admissionsSql(ipUids: readonly string[]): string {
  const list = ipUids.map((u) => `'${esc(u)}'`).join(', ');
  return `
SELECT encounter_id, current_treating_doctor_id
  FROM kx_ip_admissions
 WHERE encounter_id IN (${list})`;
}

export interface IpdDoctorHop {
  byIpUid: Record<string, HopResult>;
  coverage: HopCoverage;
  /** The map, exposed so an admin probe can report the hop's own numbers without re-querying. */
  ambiguousIds: string[];
}

/**
 * Resolve a page's worth of stays. ONE Metabase call per read, never one per stay.
 *
 * Fail-soft, and the direction matters: any fault leaves EVERY stay unjoined, which renders as the
 * split banner. The failure mode of this function is "we do not know", never "nobody was treating
 * them" and never a partially-populated column that looks complete.
 */
export async function fetchIpdDoctorHop(ipUids: readonly string[]): Promise<IpdDoctorHop> {
  const ids = Array.from(new Set((ipUids ?? []).map((u) => String(u ?? '').trim()).filter((u) => u && isIpUid(u))));
  if (!ids.length) return { byIpUid: {}, coverage: hopCoverage(0, {}), ambiguousIds: [] };

  let mapRows: Record<string, unknown>[];
  let admRows: Record<string, unknown>[];
  try {
    [mapRows, admRows] = await Promise.all([
      metabaseQuery(PRACTITIONER_MAP_SQL),
      metabaseQuery(admissionsSql(ids)),
    ]);
  } catch {
    return { byIpUid: {}, coverage: hopCoverage(ids.length, {}, true), ambiguousIds: [] };
  }

  const map = buildPractitionerMap(mapRows.map((r) => ({
    pid: String(r.pid ?? ''), nUids: Number(r.n_uids ?? 0), uid: r.uid == null ? null : String(r.uid),
  })));
  const byIpUid = resolveStays(
    admRows.map((r) => ({
      ipUid: String(r.encounter_id ?? ''),
      treatingId: r.current_treating_doctor_id == null ? null : String(r.current_treating_doctor_id),
    })),
    map,
  );
  return { byIpUid, coverage: hopCoverage(ids.length, byIpUid), ambiguousIds: [...map.ambiguous].sort() };
}

/** Every INFERRED db13 string this file runs, for the slice report. The admissions string is shown
 *  with a two-id example list; production interpolates the window's stays. */
export const HOP_INFERRED_SQL: Readonly<Record<string, string>> = Object.freeze({
  practitioner_map: PRACTITIONER_MAP_SQL,
  admissions: admissionsSql(['IP-1250', 'IPNO-229']),
});

/**
 * ⚠️ THERE IS DELIBERATELY NO SHAPE TEST ON A PRACTITIONER ID. The measured ids are 38–47 chars and
 * hyphen-separated, and it would be easy to validate that — but a shape guard on a lookup KEY can
 * only ever do harm here: an id whose shape we did not predict must be looked up and found absent,
 * not dropped before the lookup and reported as "not in the roster". The `ip_uid` guard above is a
 * different thing entirely: those values are INTERPOLATED into SQL, so they are filtered.
 */
