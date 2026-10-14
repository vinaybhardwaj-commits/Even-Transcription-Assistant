/**
 * lib/world-model/walk-o.ts — WM0 slice W0.1: the SPINE WALK (world-model-walk-o/0.1).
 *
 * ONE QUESTION, ASKED REPEATEDLY: "what did the spine know about this member on day D?" — for every
 * calendar day D on which the member has OPD or lab evidence. Each answer is a MemberStateSnapshot
 * reconstructed by the EXISTING frozen path; this module reconstructs nothing of its own.
 *
 * WHAT THIS MODULE IS NOT. It is not a new projection, not a new schema, and not a new reader of
 * db13. It is a LOOP over `getMemberSnapshotAsOf` plus an honest status per iteration. Every
 * clinical fact it shows was produced by the frozen cores; the walk contributes only the ordering,
 * the per-day status, and the labelling.
 *
 * ── THE THREE CONSTRAINTS THIS FILE IMPLEMENTS (CAT Design, 31 Aug 2026) ────────────────────────
 *
 * C1 (honesty)  Cuts are dated by CLINICAL date — the date the prescription or lab result carries.
 *               Result-availability lag is NOT modelled: a lab drawn on the 3rd and reported on the
 *               5th sits at the 3rd, so a cut can show a value a clinician could not yet have seen.
 *               The chip `HONESTY_CHIP` says exactly this, and the page renders it verbatim.
 * C2 (one fold) `ipdEncountersForMember` is called ONCE PER WALK, not once per cut. Its `notes` and
 *               `refused` are MEMBER-level facts ("this stay never reached the spine, and why"), so
 *               the same arrays ride every cut rather than being recomputed N times against the
 *               stay library. N cuts must not mean N library reads.
 * C3 (enumerator) The candidate days come from `assembleEvidence`, which pulls OPD + lab ONLY. The
 *               folded kinds (care_call, PROM, ipd) deliberately do NOT open a cut of their own — a
 *               walk is a walk of the member's DOCUMENTED CLINICAL CONTACT, and a PROM score or a
 *               retro-folded stay is enrichment that shows up INSIDE a cut, never as one.
 *
 * ── THE CUT IS A STRICT PRIOR-DAY CUT, AND THAT IS THE POINT ────────────────────────────────────
 *
 * `getMemberSnapshotAsOf(uid, D, …)` applies `applyAsOfCut`, which keeps evidence dated STRICTLY
 * before D. So the cut at day D is "what was knowable the morning of D, before that day's own
 * encounter happened" — day D's own evidence is excluded, exactly as D2 drops the audited note's own
 * ref so a note can never count as its own prior context. A cut at the member's FIRST evidence day
 * therefore has nothing before it and is honestly `no_prior_history`, not an error.
 *
 * ── THROW AND NULL ARE DIFFERENT ANSWERS AND ARE NEVER COLLAPSED ────────────────────────────────
 *
 * This is the whole honesty contract, copied from lib/opd-longitudinal.ts:
 *   · db13 THREW           → `context_fetch_failed`  — we do not know what was there.
 *   · snapshot was NULL    → `no_prior_history`      — we DO know, and there was nothing.
 * Collapsing these turns an outage into a clean bill of health, which is the failure this whole
 * surface exists to make impossible. `getMemberSnapshotAsOf` deliberately does NOT soft-catch its
 * presc/lab fetch so that the throw can reach us; the `.catch(() => [])` pattern from its sibling
 * `getMemberSnapshot` MUST NOT be used here.
 *
 * ── SQL HONESTY ────────────────────────────────────────────────────────────────────────────────
 *
 * This module writes NO SQL. The enumerator reuses the FROZEN, orchestrator-validated query strings
 * from member-state.ts verbatim (`__sqlForTest`, the only public handle on them — see the note at
 * `enumerateCutDates`), and the reconstruct path is `getMemberSnapshotAsOf` unchanged. There is not
 * one new query, table name, or column name in this ship.
 *
 * ── DEPENDENCY INJECTION (why the seams exist) ──────────────────────────────────────────────────
 *
 * The three impure edges are injectable with real defaults — the `run: Db13Runner = metabaseQuery`
 * pattern this repo already uses in lib/readmission/db13.ts. That is what lets the W0.1 gate prove
 * the throw/null split, the strict prior-day cut, and the fold-off labelling OFFLINE, with no live
 * db13 and no live Neon. Production callers pass nothing and get the real path.
 */

import { metabaseQuery } from '../metabase';
import { isUid } from '../ccb-dossier-core';
import { bridgeUhidToIndividual } from '../ccb-resolve';
import { assembleEvidence } from '../member-state/assemble-core';          // C3 — the cut-date enumerator
import { __sqlForTest, getMemberSnapshotAsOf } from '../member-state/member-state';
import { ipdEncountersForMember, ipdFoldEnabled } from '../member-state/ipd-fold';   // C2 — once per walk
import type { MemberStateSnapshot } from '../member-state/schema';
import type { StayEvidenceResult } from '../member-state/ipd-evidence';

export const WORLD_MODEL_WALK_VERSION = 'world-model-walk-o/0.1' as const;

/** The walk's grain, rendered verbatim. A cut is a CALENDAR DAY, and the day's own evidence is out. */
export const GRAIN_LABEL = 'calendar day, same-day excluded' as const;

/** C1, VERBATIM. Never paraphrase this string — it is the ratified wording of the lag we do NOT model. */
export const HONESTY_CHIP = 'dated by clinical date; result-availability lag not modeled' as const;

/**
 * The three answers a cut can give. `ok` and `no_prior_history` are both KNOWLEDGE;
 * `context_fetch_failed` is the absence of knowledge. See the throw/null note in the file header.
 */
export type WalkCutStatus = 'ok' | 'no_prior_history' | 'context_fetch_failed';

/** One day of the walk. `snapshot` is present ONLY when `status === 'ok'`. */
export interface WalkCut {
  /** The cut day, `YYYY-MM-DD`. Evidence STRICTLY BEFORE this day is what the snapshot contains. */
  date: string;
  status: WalkCutStatus;
  /** The frozen `member-state/1.2` snapshot, WRAPPED not extended. Absent unless status is 'ok'. */
  snapshot?: MemberStateSnapshot;
  /** C2 — the walk-level fold notes, carried onto every cut. Member-level facts, not per-day ones. */
  foldNotes: string[];
  /** C2 — the walk-level fold refusals ("this fact did not reach the spine, and here is why"). */
  foldRefused: StayEvidenceResult['refused'];
}

/**
 * The three flags read AT COMPUTE TIME and returned with the walk, so a reader can never mistake a
 * flag-off surface for an empty one.
 *
 * Booleans, not the raw env strings, and deliberately so: `MEMBERSTATE_IPD_FOLD` is on for the
 * single value `'1'`, which means the raw strings `'true'` and `'0'` are BOTH off (see
 * `ipdFoldEnabled`). Handing a reader the literal `'true'` would invite exactly the wrong reading.
 * The IPD boolean is `ipdFoldEnabled()` itself, so the walk and the fold can never disagree.
 */
export interface WalkFlags {
  MEMBERSTATE_IPD_FOLD: boolean;
  CARE_CALL_ENABLED: boolean;
  PROMS_ENABLED: boolean;
}

/**
 * Whether the enumerator could see the member's evidence at all.
 *
 * ⚠️ THIS FIELD IS AN ADDITION TO THE SPEC'S `{ cuts, flags }` DTO, and it is here for one reason:
 * without it, a db13 outage during ENUMERATION is indistinguishable from a member with no evidence.
 * Both produce zero cuts. A per-cut `context_fetch_failed` cannot cover this case, because when
 * enumeration fails there is no date to hang a cut on. Reporting "no cuts" for an outage would be
 * precisely the throw/null collapse the status enum exists to prevent, one level up. Flagged to the
 * Orchestrator for ratification.
 */
export interface WalkEnumeration {
  status: 'ok' | 'context_fetch_failed';
  /** Distinct OPD/lab days seen. 0 with status 'ok' means the member genuinely has no evidence. */
  candidateDays: number;
}

/**
 * The walk DTO. It WRAPS `MemberStateSnapshot` (as a field on WalkCut) and never extends it: no key
 * is added to the `.strict()` `zMemberStateSnapshot`, and `member-state/1.2` is not bumped.
 */
export interface WalkO {
  version: typeof WORLD_MODEL_WALK_VERSION;
  individualUid: string;
  computedAt: string;
  enumeration: WalkEnumeration;
  cuts: WalkCut[];
  flags: WalkFlags;
}

/** The IPD label. `fold_off` is NOT "no stays" — it is "we did not look". */
export type IpdFoldLabel = 'fold_off' | 'folded';
export function ipdFoldLabelFor(flags: WalkFlags): IpdFoldLabel {
  return flags.MEMBERSTATE_IPD_FOLD ? 'folded' : 'fold_off';
}

/** The injectable impure edges. Defaults are the real ones; tests pass fakes. */
export type Db13Runner = (sql: string) => Promise<Record<string, unknown>[]>;
export interface WalkDeps {
  /** db13 runner for the ENUMERATOR only. The reconstruct path has its own. */
  query?: Db13Runner;
  /** The reconstruct function. MUST be the frozen `getMemberSnapshotAsOf` in production. */
  reconstruct?: (individualUid: string, asOfDate: string, computedAt: string) => Promise<MemberStateSnapshot | null>;
  /** The stay fold. Called ONCE per walk (C2), and only when the flag is on. */
  fold?: (individualUid: string) => Promise<{ refused: StayEvidenceResult['refused']; notes: string[] }>;
  /** Flag override for tests. Production reads the environment. */
  flags?: WalkFlags;
}

/** Read the three flags at compute time. */
export function readWalkFlags(): WalkFlags {
  return {
    MEMBERSTATE_IPD_FOLD: ipdFoldEnabled(),                  // the fold's OWN predicate — never a second opinion
    CARE_CALL_ENABLED: process.env.CARE_CALL_ENABLED === '1',
    PROMS_ENABLED: process.env.PROMS_ENABLED === '1',
  };
}

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * C3 — the candidate cut days, from `assembleEvidence` and nothing else.
 *
 * ⚠️ ON `__sqlForTest`: `assembleEvidence` is pure and takes ALREADY-FETCHED rows, but member-state.ts
 * keeps its two frozen query builders private and exposes them ONLY through this handle. Using it is
 * a deliberate trade against inventing a third copy of those strings: the enumerator and the
 * reconstructor MUST agree about what evidence exists, and byte-identity is the only way to guarantee
 * that. member-state.ts is on the untouched list, so widening the export was not available. Flagged
 * in the report as the one naming compromise in this ship.
 *
 * Throws on a real db13 failure — the caller turns that into `context_fetch_failed`, never into
 * "no evidence". `assembleEvidence` itself never throws (it degrades malformed rows to empty).
 */
export async function enumerateCutDates(individualUid: string, computedAt: string, query: Db13Runner): Promise<string[]> {
  const [presc, labs] = await Promise.all([
    query(__sqlForTest.prescriptionsSql(individualUid)),   // NOT soft-caught — an outage must surface
    query(__sqlForTest.labsSql(individualUid)),
  ]);
  const evidence = assembleEvidence({
    memberRef: individualUid,
    generatedAt: computedAt,
    sourceWatermarks: { db13: computedAt },
    prescriptionRows: presc,
    labRows: labs,
  });
  const days = new Set<string>();
  for (const e of evidence.encounters) {
    const d = String(e.date ?? '').slice(0, 10);
    if (isDay(d)) days.add(d);                              // empty / malformed dates are dropped, not guessed
  }
  return [...days].sort();                                  // ISO dates sort lexicographically = chronologically
}

/**
 * Resolve the person for a walk. `individual_uid` is THE person key.
 *
 * ⚠️ AMBIGUITY IS A REFUSAL, NOT A CHOICE. A uhid resolves ONLY through `bridgeUhidToIndividual`,
 * which is a single exact `individuals.kx_uhid` match. `bridgeMemberIdToIndividuals` and its
 * `inds[0]` first-match are NEVER used: a household shares a member account, and picking the first
 * of several would put one person's history under another person's name. A `clinical_states.member_uid`
 * is a Firestore member document id and is NEVER treated as an individual_uid.
 */
export async function resolveWalkSubject(
  input: { individualUid?: string | null; uhid?: string | null },
): Promise<{ individualUid: string | null; reason: 'resolved' | 'bad_input' | 'uhid_unresolved' }> {
  const direct = String(input.individualUid ?? '').trim();
  if (direct) return isUid(direct) ? { individualUid: direct, reason: 'resolved' } : { individualUid: null, reason: 'bad_input' };

  const uhid = String(input.uhid ?? '').trim();
  if (!uhid) return { individualUid: null, reason: 'bad_input' };
  const resolved = await bridgeUhidToIndividual(uhid).catch(() => null);
  return resolved ? { individualUid: resolved, reason: 'resolved' } : { individualUid: null, reason: 'uhid_unresolved' };
}

/**
 * THE WALK. One cut per calendar day on which the member has OPD or lab evidence, each cut carrying
 * the spine as it stood the morning of that day.
 *
 * NEVER THROWS. Every failure becomes a labelled status, so the admin surface degrades to an honest
 * "we could not see" rather than to a 500 or, far worse, to a silent clean slate.
 */
export async function walkO(individualUid: string, computedAt: string, deps: WalkDeps = {}): Promise<WalkO> {
  const query = deps.query ?? metabaseQuery;
  const reconstruct = deps.reconstruct ?? getMemberSnapshotAsOf;
  const fold = deps.fold ?? ipdEncountersForMember;
  const flags = deps.flags ?? readWalkFlags();

  const base = { version: WORLD_MODEL_WALK_VERSION, individualUid, computedAt, flags } as const;
  if (!isUid(individualUid)) {
    return { ...base, enumeration: { status: 'ok', candidateDays: 0 }, cuts: [] };
  }

  // (1) C3 — enumerate the candidate days. A throw here is an OUTAGE, not an empty history.
  let dates: string[];
  try {
    dates = await enumerateCutDates(individualUid, computedAt, query);
  } catch {
    return { ...base, enumeration: { status: 'context_fetch_failed', candidateDays: 0 }, cuts: [] };
  }
  const enumeration: WalkEnumeration = { status: 'ok', candidateDays: dates.length };

  // (2) C2 — the stay fold, ONCE for the whole walk, and ONLY when the flag is on. Flag off ⇒ not a
  //     single stay-library read happens, and the page says `fold_off` rather than "no stays".
  let foldNotes: string[] = [];
  let foldRefused: StayEvidenceResult['refused'] = [];
  if (flags.MEMBERSTATE_IPD_FOLD) {
    const folded = await fold(individualUid).catch(() => null);
    if (folded) {
      foldNotes = folded.notes;
      foldRefused = folded.refused;
    } else {
      foldNotes = ['the inpatient fold could not be read — nothing folded'];
    }
  }

  // (3) One reconstruct per day, SEQUENTIALLY. N cuts is already N query pairs against db13; firing
  //     them all at once would turn a long-history member into a thundering herd on the shared
  //     Metabase connection. The walk is an admin forensic tool — correctness over wall-clock.
  const cuts: WalkCut[] = [];
  for (const date of dates) {
    let status: WalkCutStatus;
    let snapshot: MemberStateSnapshot | undefined;
    try {
      const snap = await reconstruct(individualUid, date, computedAt);
      // NULL and THROW are different answers. Never collapsed. See the file header.
      if (snap) { status = 'ok'; snapshot = snap; } else { status = 'no_prior_history'; }
    } catch {
      status = 'context_fetch_failed';
    }
    cuts.push({ date, status, snapshot, foldNotes, foldRefused });
  }

  return { ...base, enumeration, cuts };
}
