/**
 * lib/readmission-detect-core.ts — PURE Stage-1 readmission detection (PRD
 * CDMSS-READMISSION-AGENT-PRD-v0.7 §4/§4a, decisions 5, 8, 12, 13).
 *
 * No DB, no model, no network — mirrors the pure-core convention of
 * lib/opd-note-audit-core.ts. The db13 layer (lib/readmission/db13.ts) fetches raw
 * KX encounters + POST_IPD form rows; everything decisive happens here so it is
 * strip-types testable:
 *
 *   · LEAD-semantics pairing: each IP discharge pairs with the SAME PERSON's next IP
 *     admission, strictly after the discharge and within a flat 90-day window
 *     (30-day figures reported as a subset — decision 5). Implemented in TS rather
 *     than SQL LEAD because the duplicate-MRN reconcile merges two UHIDs into one
 *     person, and a PARTITION BY uhid can never produce a cross-UHID pair.
 *   · Tags: tight_7d / within_30d / structural_bounce (same dept OR same doctor) /
 *     er_route / excluded_category.
 *   · Lane precedence (first match wins): excluded → er_routed → tight_bounce →
 *     structural_30d → other.
 *   · Duplicate-MRN reconcile: two UHIDs are the same person ONLY on name AND dob
 *     agreement — NEVER on mobile (measured 9/12 false; §8c.1). Mobile is not even
 *     an input here, so the wrong join is unrepresentable.
 *   · Form detector union + dedup (decisions 12/13): a POST_IPD form readmission
 *     within ±5 days of a KX readmit admission is the same event (keep the KX pair,
 *     attach the CM note); a form readmission with an Even index stay but no KX
 *     readmit is out-of-network and becomes its own finding class.
 *
 * PHI note: patientName/dob ride on KxEncounter ONLY for the name+dob reconcile.
 * They never reach a finding row or a model prompt — lib/readmission/assemble.ts is
 * the de-identification choke point (PRD §8b).
 */

export const READMIT_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

/** Decision 8 — Mohsin's clinical exclusion set, EXACT live KX department strings. */
export const EXCLUDED_DEPARTMENTS: readonly string[] = [
  'Oncology',
  'Medical Oncology',
  'Radiation Oncology',
  'Surgical Oncology & Oncoplastic Breast Surgery',
  'Nephrology',
  'Obstetrics and Gynecology',
];

export interface KxEncounter {
  encounterId: string;
  uhid: string;
  /** 'ip_admission' | 'er_admission' (recon §5: ER shares the ADT table). */
  encounterType: string;
  admitAt: string;                 // ISO timestamp
  dischargeAt: string | null;      // ISO timestamp; null = not discharged / unknown
  admissionType: string | null;    // HIS field — NOT a planned signal (recon catch 1)
  department: string | null;
  doctor: string | null;
  payer: string | null;
  /** Identity facts for the name+dob duplicate-MRN reconcile ONLY (§8c.1).
   *  Never stored on a finding row, never sent to the model. */
  patientName?: string | null;
  dob?: string | null;
}

export interface PairTags {
  tight_7d: boolean;
  within_30d: boolean;
  structural_bounce: boolean;
  er_route: boolean;
  excluded_category: boolean;
}

export type Lane = 'excluded' | 'er_routed' | 'tight_bounce' | 'structural_30d' | 'other';

export interface ReadmitPair {
  index: KxEncounter;
  readmit: KxEncounter;
  gapDays: number;
  tags: PairTags;
  lane: Lane;
  /** Attached by the form dedup (decision 12): the CM note + form uid for a
   *  form-reported readmission that IS this KX pair. */
  cmNote?: string | null;
  formUid?: string | null;
}

/** One POST_IPD form readmission record (recon §1), already linked to its member's
 *  KX UHIDs via individuals.kx_uhid (+ old_kx_uhids) by the db13 layer. */
export interface FormReadmission {
  formUid: string;
  memberUid: string;
  readmissionDate: string | null;   // patient-reported; approximate
  eventType: string | null;
  isPlanned: boolean | null;        // key appears only when true (recon catch 2)
  sameCondition: boolean | null;
  notes: string | null;
  uhids: string[];                  // kx_uhid ∪ old_kx_uhids, may be empty
}

/** Out-of-network finding (decision 13): Even index stay, readmit elsewhere. */
export interface OonDetection {
  formUid: string;
  memberUid: string;
  index: KxEncounter;
  reportedReadmitDate: string | null;
  eventType: string | null;
  isPlanned: boolean | null;
  sameCondition: boolean | null;
  cmNote: string | null;
}

export interface DetectionResult {
  pairs: ReadmitPair[];
  oon: OonDetection[];
  laneCounts: Record<Lane, number>;
  within30: number;
  /** Form-record dispositions, for the worker's honesty report. */
  formStats: {
    total: number;
    dedupedIntoPairs: number;
    outOfNetwork: number;
    noEvenIpStay: number;      // out of the Even-only v1 scope (decision 12)
    noReadmitDate: number;     // cannot be matched or windowed — reported, not audited
    kxMatchedNoPair: number;   // a KX admission matched but is not a detected pair
    noIndexInWindow: number;   // OON candidate with no Even discharge within 90d before
  };
}

/** Candidate column names per logical ADT field — tried in order, first present wins
 *  (the db13 layer's tolerant mapping; PURE so the priority order is testable).
 *  VALIDATED LIVE (5 Aug 2026, detect_only on prod, two rounds):
 *  · admission maps via `admission_date_time`; discharge is `discharge_date`
 *    (timestamptz) — `discharge_date_time`/`discharge_datetime` belong to
 *    kx_discharge_summary_records, a DIFFERENT table (the zero-lanes defect).
 *  · department is `treating_sub_department_name` ("Oncology", "Nephrology",
 *    "Obstetrics and Gynecology", "Urology", …), `treating_department_name` as
 *    fallback — a null department killed the excluded tag AND the same-department
 *    arm of structural_bounce (the excluded:0 defect).
 *  · doctor is `current_treating_doctor` ("Dr Vishal Naik", …), `admitting_doctor`
 *    as fallback. */
export const ADT_COLUMN_CANDIDATES = {
  encounterId: ['encounter_id', 'ipd_no', 'ip_no', 'encounter_no', 'admission_no', 'ip_number'],
  uhid: ['uhid'],
  encounterType: ['encounter_type'],
  admitAt: ['admission_date_time', 'admission_datetime', 'admit_date_time'],
  dischargeAt: ['discharge_date', 'discharge_date_time', 'discharge_datetime'],
  admissionType: ['admission_type'],
  department: ['treating_sub_department_name', 'treating_department_name', 'department', 'speciality', 'department_name'],
  doctor: ['current_treating_doctor', 'admitting_doctor', 'treating_doctor', 'treating_doctor_team', 'treating_doctor_name', 'admitting_doctor_team'],
  payer: ['payer', 'payer_name', 'payer_type', 'payor'],
  patientName: ['patient_name', 'name'],
  dob: ['dob', 'date_of_birth', 'birth_date'],
} as const;

/** The FULL live-mapping report: one entry per logical field the detector reads. */
export interface MappedAdtCols {
  admission: string | null;
  discharge: string | null;
  department: string | null;
  doctor: string | null;
  encounter_id: string | null;
  dob: string | null;
  name: string | null;
}

/** Which candidate actually resolved, in priority order, across the sampled rows —
 *  surfaced on the worker's detect/sweep response so the orchestrator validates the
 *  ENTIRE mapping live (a single-field miss like excluded:0 can't hide again).
 *  Null = none matched: a visible gap, never a guess. */
export function resolveMappedCols(rows: Record<string, unknown>[]): MappedAdtCols {
  const find = (cands: readonly string[]): string | null => {
    for (const c of cands) if (rows.some((r) => c in r && r[c] != null && r[c] !== '')) return c;
    return null;
  };
  return {
    admission: find(ADT_COLUMN_CANDIDATES.admitAt),
    discharge: find(ADT_COLUMN_CANDIDATES.dischargeAt),
    department: find(ADT_COLUMN_CANDIDATES.department),
    doctor: find(ADT_COLUMN_CANDIDATES.doctor),
    encounter_id: find(ADT_COLUMN_CANDIDATES.encounterId),
    dob: find(ADT_COLUMN_CANDIDATES.dob),
    name: find(ADT_COLUMN_CANDIDATES.patientName),
  };
}

const parseTs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Duplicate-MRN reconcile (§8c.1): map uhid → person key. Two UHIDs merge ONLY when
 * name AND dob both agree (both non-empty). individuals.old_kx_uhids covers only 35
 * people so it is not the primary fix; and mobile is deliberately not an input.
 */
export function reconcilePersons(encounters: KxEncounter[]): Map<string, string> {
  const byIdentity = new Map<string, Set<string>>();
  for (const e of encounters) {
    const name = norm(e.patientName);
    const dob = (e.dob ?? '').slice(0, 10);
    if (!name || !dob) continue;
    const k = `${name}|${dob}`;
    const set = byIdentity.get(k) ?? new Set<string>();
    set.add(e.uhid);
    byIdentity.set(k, set);
  }
  const personOf = new Map<string, string>();
  for (const [identity, uhids] of byIdentity) {
    if (uhids.size > 1) {
      const key = `dup:${identity}`;
      for (const u of uhids) personOf.set(u, key);
    }
  }
  return personOf; // uhids not present map to themselves (caller falls back to uhid)
}

/**
 * LEAD-semantics pairing over one person's IP admissions ordered by admission time:
 * discharge_i pairs with admission_{i+1} when admission_{i+1} > discharge_i and
 * admission_{i+1} <= discharge_i + 90 days. Same-day/overlapping stays (readmit
 * admission at or before the index discharge) never pair.
 */
export function pairEncounters(encounters: KxEncounter[]): Array<{ index: KxEncounter; readmit: KxEncounter; gapDays: number }> {
  const personOf = reconcilePersons(encounters);
  const ip = encounters.filter((e) => e.encounterType === 'ip_admission' && parseTs(e.admitAt) != null);
  const byPerson = new Map<string, KxEncounter[]>();
  for (const e of ip) {
    const key = personOf.get(e.uhid) ?? e.uhid;
    const arr = byPerson.get(key) ?? [];
    arr.push(e);
    byPerson.set(key, arr);
  }
  const out: Array<{ index: KxEncounter; readmit: KxEncounter; gapDays: number }> = [];
  for (const arr of byPerson.values()) {
    arr.sort((a, b) => (parseTs(a.admitAt)! - parseTs(b.admitAt)!) || a.encounterId.localeCompare(b.encounterId));
    for (let i = 0; i + 1 < arr.length; i++) {
      const index = arr[i];
      const readmit = arr[i + 1];          // LEAD: the NEXT admission in admission order
      const disch = parseTs(index.dischargeAt);
      const adm = parseTs(readmit.admitAt);
      if (disch == null || adm == null) continue;
      if (adm <= disch) continue;                                 // same-day / overlap: not a readmit
      if (adm > disch + READMIT_WINDOW_DAYS * DAY_MS) continue;   // flat 90-day window (decision 5)
      out.push({ index, readmit, gapDays: Math.floor((adm - disch) / DAY_MS) });
    }
  }
  return out;
}

const isExcludedDept = (d: string | null | undefined): boolean =>
  d != null && EXCLUDED_DEPARTMENTS.includes(d.trim());

/** Tag one pair. `erEncounters` = the person's er_admission encounters (for er_route). */
export function computeTags(
  pair: { index: KxEncounter; readmit: KxEncounter },
  erEncounters: KxEncounter[] = [],
): PairTags {
  const disch = parseTs(pair.index.dischargeAt)!;
  const adm = parseTs(pair.readmit.admitAt)!;
  const sameDept = !!pair.index.department && !!pair.readmit.department
    && norm(pair.index.department) === norm(pair.readmit.department);
  const sameDoctor = !!pair.index.doctor && !!pair.readmit.doctor
    && norm(pair.index.doctor) === norm(pair.readmit.doctor);
  const erWithin48h = erEncounters.some((er) => {
    if (er.encounterType !== 'er_admission') return false;
    const t = parseTs(er.admitAt);
    return t != null && t <= adm && t >= adm - 48 * 3_600_000;
  });
  return {
    tight_7d: adm <= disch + 7 * DAY_MS,
    within_30d: adm <= disch + 30 * DAY_MS,
    structural_bounce: sameDept || sameDoctor,
    er_route: norm(pair.readmit.admissionType) === 'emergency' || erWithin48h,
    excluded_category: isExcludedDept(pair.index.department) || isExcludedDept(pair.readmit.department),
  };
}

/** Lane precedence, first match wins (PRD §4): excluded → er_routed → tight_bounce →
 *  structural_30d → other. */
export function laneFor(tags: PairTags): Lane {
  if (tags.excluded_category) return 'excluded';
  if (tags.er_route) return 'er_routed';
  if (tags.tight_7d && tags.structural_bounce) return 'tight_bounce';
  if (tags.within_30d && tags.structural_bounce) return 'structural_30d';
  return 'other';
}

/** Even→Even dedup key (§8d): (index_encounter_id, readmit_encounter_id). */
export function pairDedupKey(indexEncounterId: string, readmitEncounterId: string): string {
  return `${indexEncounterId}|${readmitEncounterId}`;
}

/** Out-of-network dedup key (§8d): (index_encounter_id, form_uid). */
export function oonDedupKey(indexEncounterId: string, formUid: string): string {
  return `${indexEncounterId}|form:${formUid}`;
}

const FORM_DEDUP_WINDOW_MS = 5 * DAY_MS;   // §8d — patient recall is approximate

const parseDay = (s: string | null): number | null => {
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
};

/**
 * Full Stage-1 detection: pair, tag, lane, then union + dedup the form detector
 * (decisions 12/13). Pure — takes everything already fetched.
 */
export function detectReadmissions(encounters: KxEncounter[], forms: FormReadmission[] = []): DetectionResult {
  const personOf = reconcilePersons(encounters);
  const personKey = (uhid: string) => personOf.get(uhid) ?? uhid;
  const ersByPerson = new Map<string, KxEncounter[]>();
  for (const e of encounters) {
    if (e.encounterType !== 'er_admission') continue;
    const k = personKey(e.uhid);
    const arr = ersByPerson.get(k) ?? [];
    arr.push(e);
    ersByPerson.set(k, arr);
  }

  const rawPairs = pairEncounters(encounters);
  const pairs: ReadmitPair[] = rawPairs.map((p) => {
    const tags = computeTags(p, ersByPerson.get(personKey(p.index.uhid)) ?? []);
    return { ...p, tags, lane: laneFor(tags) };
  });

  const ipByUhid = new Map<string, KxEncounter[]>();
  for (const e of encounters) {
    if (e.encounterType !== 'ip_admission') continue;
    const arr = ipByUhid.get(e.uhid) ?? [];
    arr.push(e);
    ipByUhid.set(e.uhid, arr);
  }

  const oon: OonDetection[] = [];
  const formStats = {
    total: forms.length, dedupedIntoPairs: 0, outOfNetwork: 0,
    noEvenIpStay: 0, noReadmitDate: 0, kxMatchedNoPair: 0, noIndexInWindow: 0,
  };

  for (const f of forms) {
    const memberIps = f.uhids.flatMap((u) => ipByUhid.get(u) ?? []);
    if (!memberIps.length) { formStats.noEvenIpStay++; continue; }   // out of v1 scope (decision 12)
    const rd = parseDay(f.readmissionDate);
    if (rd == null) { formStats.noReadmitDate++; continue; }

    // Dedup rule (§3a/§8d): member + readmission_date within ±5d of a KX readmit admission
    // = the same event → keep the KX pair (richer evidence), attach the CM note.
    const uhidSet = new Set(f.uhids);
    const matchedPair = pairs.find((p) => uhidSet.has(p.readmit.uhid)
      && Math.abs((parseTs(p.readmit.admitAt) ?? Infinity) - rd) <= FORM_DEDUP_WINDOW_MS);
    if (matchedPair) {
      matchedPair.cmNote = f.notes ?? null;
      matchedPair.formUid = f.formUid;
      formStats.dedupedIntoPairs++;
      continue;
    }
    // Any KX IP admission near the reported date means the event IS in-network even if it
    // is not a detected pair (e.g. >90d after its index) — not out-of-network. Counted, dropped.
    const nearbyKxAdmission = memberIps.some((e) =>
      Math.abs((parseTs(e.admitAt) ?? Infinity) - rd) <= FORM_DEDUP_WINDOW_MS);
    if (nearbyKxAdmission) { formStats.kxMatchedNoPair++; continue; }

    // Out-of-network (decision 13): the Even index stay = the latest discharge strictly
    // before the reported readmit date, within the same 90-day window.
    const candidates = memberIps
      .filter((e) => {
        const d = parseTs(e.dischargeAt);
        return d != null && d < rd && rd <= d + READMIT_WINDOW_DAYS * DAY_MS;
      })
      .sort((a, b) => parseTs(b.dischargeAt)! - parseTs(a.dischargeAt)!);
    const index = candidates[0];
    if (!index) { formStats.noIndexInWindow++; continue; }
    oon.push({
      formUid: f.formUid, memberUid: f.memberUid, index,
      reportedReadmitDate: f.readmissionDate, eventType: f.eventType,
      isPlanned: f.isPlanned, sameCondition: f.sameCondition, cmNote: f.notes ?? null,
    });
    formStats.outOfNetwork++;
  }

  const laneCounts: Record<Lane, number> = { excluded: 0, er_routed: 0, tight_bounce: 0, structural_30d: 0, other: 0 };
  let within30 = 0;
  for (const p of pairs) {
    laneCounts[p.lane]++;
    if (p.tags.within_30d) within30++;
  }
  return { pairs, oon, laneCounts, within30, formStats };
}
