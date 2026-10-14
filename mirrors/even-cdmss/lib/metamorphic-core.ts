/**
 * lib/metamorphic-core.ts — metamorphic relations + synthetic known-positive controls over the
 * OPD deterministic leg (PRD CDMSS-METAMORPHIC-AND-SYNTHETIC-CONTROLS v1.0, 1 Aug 2026).
 *
 * ONE DEFINITION OF EVERY RELATION (PRD §9.2, load-bearing): the CI tests
 * (lib/__tests__/metamorphic-deterministic.test.ts, lib/__tests__/synthetic-controls.test.ts) and
 * the engine-health panel (app/admin/observability/engine-health/page.tsx) BOTH call the
 * `runRelations()` / `runSyntheticControls()` exported here. Nothing else implements a relation.
 *
 * Every relation asserts a DIRECTION or an INVARIANCE over `OpdFinding[]` / `OpdCompleteness` —
 * never an index value, a band, or a score (PRD §3). G-1 compares findings as a MULTISET of
 * `finding_ref` (§9.3). Fixtures are hand-built `DeidOpdCase` literals: no real patient data, no
 * db13 uid, no PHI (M3). Banned-FDC fixtures use PLACEHOLDER molecule names against a test table
 * (the standing rule inherited from lib/__tests__/cdsco-banned-fdc-core.test.ts: no real
 * banned-drug data may originate from a builder, including in tests).
 *
 * ⚠️ DEVIATION, FLAGGED (build report §deviations): the PRD requires this file be "pure and
 * dependency-free — no ./db, no ./llm, no next/*". Three of the stage-3 emitters under test
 * (`ddiFindings`, `muscleRelaxantFindings`, and the 0.81.8/0.81.14 informational emitters) are
 * exported from lib/opd-note-audit.ts — the ORCHESTRATOR module, whose import graph reaches ./db
 * and ./llm. The single-definition rule ("the functions under test are the ones stage 3 composes",
 * §9.1) and the engine-freeze rule (no emitter may be moved or forked) cannot both be satisfied
 * without importing them from there. This file therefore performs NO I/O and calls NO db/llm
 * function, but its import graph is not clean of them. Precedent: lib/__tests__/
 * opd-audit-0818-orchestrator.test.ts already imports the same emitters under node:test, green in
 * CI (./db connects lazily; nothing in the graph does I/O at import time).
 *
 * ⚠️ SECOND FLAGGED DUPLICATION: the isGout / vitamin-D-band / msk / lmp CONTEXT DERIVATIONS and
 * the stage-3 composition order live INLINE in auditOpdNote (lib/opd-note-audit.ts:1062-1080,
 * unexported). `detFindings()` below mirrors them verbatim. If stage 3 gains an emitter or a
 * context input, THIS composition must be updated by hand or the suite silently tests a subset.
 * (Extracting the composition into an exported pure function is an ENGINE-FILE edit, out of this
 * build's contract — recommended as a follow-up.)
 */

import type { DeidOpdCase, OpdMed } from './opd-ingest-core';
import {
  prescribingChecks, opdCompleteness, stampFindingIdentity,
  type OpdFinding, type OpdCompleteness,
} from './opd-note-audit-core';
import { doseFindings } from './dose-limits';
import { bannedFdcFindings as bannedFdcFromLiveSeed, bannedFdcNearMisses as nearMissFromLiveSeed } from './cdsco-banned-fdc';
import {
  bannedFdcFindings as bannedFdcAgainstTable, bannedFdcNearMisses as nearMissAgainstTable,
  type BannedFdcTable,
} from './cdsco-banned-fdc-core';
import { parseVitaminDLevel, vitaminDBand, type VitaminDBand } from './clinical-bands';
// Orchestrator-exported emitters + context predicates — see the flagged deviation in the header.
import {
  ddiFindings, muscleRelaxantFindings, unindicatedRespFindings, decongestantDurationFindings,
  vitaminDRepletionFindings, pregnancyRiskFindings, lmpIntervalDays, mskContextDocumented,
} from './opd-note-audit';

// ── Fixture factory ───────────────────────────────────────────────────────────
export function mkOpdCase(p: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [],
    impressionCodes: [], impressions: [], history: [], comorbidities: [], medications: [],
    investigations: [], advice: [], examination: [], allergies: null, followUpType: null,
    followUpDateSet: false, ...p,
  };
}
const clone = (c: DeidOpdCase): DeidOpdCase => JSON.parse(JSON.stringify(c)) as DeidOpdCase;

/** A fully-dosed, formulary-resolved med line (fixtures override what a relation blanks). */
function med(over: Partial<OpdMed> & { generic: string }): OpdMed {
  return {
    dose: '1 tablet', frequency: 'BD', duration: '5 days', route: 'oral',
    resolvedGeneric: over.generic, formularyMatch: 'source-generic',
    ...over,
  };
}

// ── The deterministic leg, mirrored from lib/opd-note-audit.ts:1062-1080 ──────
// (flagged duplication — see header). Pre-finalize: the DB-dependent passes (suppressions,
// quieting, LVC stamping, dedupeRouteAware/consolidateDecisions) are NOT applied; the emitters
// themselves are what this suite ratifies.
const GOUT_RE = /\bgout\b|\bgouty\b|\btophus\b|\btophi\b/i;   // verbatim from opd-note-audit.ts:1064
const GOUT_ICD_RE = /^M1[0A]/i;

export function detFindings(oc: DeidOpdCase, opts?: { bannedTable?: BannedFdcTable }): OpdFinding[] {
  const goutHay = [oc.reasonForConsult || '', ...oc.presentingComplaints, ...oc.impressions, ...oc.history].join(' ');
  const goutCodes = [...oc.diagnosisCodes, ...oc.impressionCodes].map((c) => c.trim());
  const isGout = GOUT_RE.test(goutHay) || goutCodes.some((c) => GOUT_ICD_RE.test(c));
  const mskDocumented = mskContextDocumented(oc);
  const lmpDays = lmpIntervalDays(oc.lmp, oc.noteDate);
  const vitDBand: VitaminDBand | null = (() => {
    const hay = [...oc.history, ...oc.investigations, ...oc.impressions, ...oc.presentingComplaints, ...oc.examination].join(' · ');
    const lvl = parseVitaminDLevel(hay);
    return lvl == null ? null : vitaminDBand(lvl);
  })();
  // 0.81.21 (DETERMINISM-TRIO §3) — the near-miss counter joined stage 3 beside the exact-match
  // check, so this mirror carries it too (the header's standing rule: an emitter added to the
  // engine must be added here or the suite silently tests a subset). Informational + confidence 0,
  // so `scoring()` filters it out of every relation that reads scoring findings.
  const banned = opts?.bannedTable
    ? [...bannedFdcAgainstTable(oc.medications, opts.bannedTable), ...nearMissAgainstTable(oc.medications, opts.bannedTable)]
    : [...bannedFdcFromLiveSeed(oc.medications), ...nearMissFromLiveSeed(oc.medications)];
  const det = [
    ...prescribingChecks(oc),
    ...doseFindings(oc.medications, { isGout }),
    ...ddiFindings(oc.medications),
    ...muscleRelaxantFindings(oc.medications, { mskDocumented }),
    ...unindicatedRespFindings(oc),
    ...decongestantDurationFindings(oc.medications),
    ...vitaminDRepletionFindings(oc.medications, vitDBand),
    ...pregnancyRiskFindings(oc.medications, { lmpIntervalDays: lmpDays }),
    ...banned,
  ];
  return stampFindingIdentity(det);
}

// ── Assertion helpers ─────────────────────────────────────────────────────────
const refs = (fs: OpdFinding[]): string[] => fs.map((f) => f.finding_ref || '?').sort();
const hasSignal = (fs: OpdFinding[], type: string): boolean => fs.some((f) => f.signal_type === type);
const multisetEq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
/** every ref of `base` present in `trans` with at least the same multiplicity */
function multisetContains(trans: string[], base: string[]): boolean {
  const pool = [...trans];
  for (const r of base) { const i = pool.indexOf(r); if (i < 0) return false; pool.splice(i, 1); }
  return true;
}
const scoring = (fs: OpdFinding[]): OpdFinding[] => fs.filter((f) => f.informational !== true && f.confidence > 0);
const summarize = (fs: OpdFinding[]): string => fs.length ? fs.map((f) => `${f.signal_type}:${f.finding_ref}`).sort().join(', ') : '(none)';

// ── Part A — metamorphic relations ────────────────────────────────────────────
export interface RelationResult {
  id: string;
  title: string;
  transformation: string;
  assertion: string;
  pass: boolean;
  /** what the relation observed, for the report/panel — never a score */
  detail: string;
}

interface Relation {
  id: string; title: string; transformation: string; assertion: string;
  run: () => { pass: boolean; detail: string };
}

// Shared base notes. NON-febrile, non-URTI, non-MSK unless a relation needs it.
const baseEtoricoxib = (strength: string, frequency = 'OD'): DeidOpdCase => mkOpdCase({
  presentingComplaints: ['pain in the right great toe for 2 days'],
  impressions: ['Acute monoarthritis'], diagnosisCodes: ['M13.9'],
  examination: ['Right first MTP joint swollen'],
  advice: ['Rest, review with reports'], followUpType: 'IF_REQUIRED',
  medications: [med({ generic: 'Etoricoxib', strength, frequency })],
});

const baseInteraction = (): DeidOpdCase => mkOpdCase({
  presentingComplaints: ['bilateral knee pain for 3 weeks'],
  impressions: ['Osteoarthritis knee'], diagnosisCodes: ['M17.9'],
  history: ['Hypertension on treatment'],
  examination: ['Crepitus both knees'],
  advice: ['Quadriceps strengthening'], followUpType: 'IF_REQUIRED',
  medications: [
    med({ generic: 'Naproxen', strength: '250 mg', therapeuticClass: 'NSAID' }),
    med({ generic: 'Telmisartan', strength: '40 mg', frequency: 'OD', duration: '30 days', therapeuticClass: 'Antihypertensive' }),
  ],
});

const RELATIONS: Relation[] = [
  {
    id: 'D-1', title: 'Dose context is read',
    transformation: 'etoricoxib 120 mg/day, no gout → add a documented gout diagnosis',
    assertion: 'the dose_ceiling_exceeded finding disappears (120 mg/day is permitted with documented gout)',
    run: () => {
      const base = baseEtoricoxib('120 mg');
      const trans = clone(base);
      trans.impressions = ['Acute gout flare'];
      trans.diagnosisCodes = ['M10.9'];
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = hasSignal(bf, 'dose_ceiling_exceeded') && !hasSignal(tf, 'dose_ceiling_exceeded');
      return { pass, detail: `base ${summarize(bf)} → gout ${summarize(tf)}` };
    },
  },
  {
    id: 'D-2', title: 'Dose context, inverse',
    transformation: 'etoricoxib 60 mg/day → raise to 120 mg/day, no gout',
    assertion: 'the dose_ceiling_exceeded finding appears',
    run: () => {
      const base = baseEtoricoxib('60 mg');
      const trans = clone(base);
      trans.medications[0].strength = '120 mg';
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = !hasSignal(bf, 'dose_ceiling_exceeded') && hasSignal(tf, 'dose_ceiling_exceeded');
      return { pass, detail: `60 mg ${summarize(bf)} → 120 mg ${summarize(tf)}` };
    },
  },
  {
    id: 'D-3', title: 'SOS cap is applied',
    transformation: 'etoricoxib SOS with no documented cap → add an explicit max frequency keeping the total under ceiling',
    assertion: 'the dose_ceiling_sos advisory disappears',
    run: () => {
      const base = baseEtoricoxib('90 mg', 'SOS');
      const trans = clone(base);
      trans.medications[0].frequency = 'SOS, max 1 per day';
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = hasSignal(bf, 'dose_ceiling_sos') && !hasSignal(tf, 'dose_ceiling_sos');
      return { pass, detail: `uncapped ${summarize(bf)} → capped ${summarize(tf)}` };
    },
  },
  {
    id: 'D-4', title: 'Dose completeness',
    transformation: 'a medication with dose, frequency and duration → blank the duration',
    assertion: 'an incomplete_dosing finding appears, naming duration',
    run: () => {
      const base = mkOpdCase({
        presentingComplaints: ['sore ear'], impressions: ['Otitis externa'], diagnosisCodes: ['H60.9'],
        examination: ['Left canal inflamed'], advice: ['Keep ear dry'], followUpType: 'IF_REQUIRED',
        medications: [med({ generic: 'Amoxicillin', strength: '500 mg' })],
      });
      const trans = clone(base);
      delete trans.medications[0].duration;
      const bf = detFindings(base); const tf = detFindings(trans);
      const f = tf.find((x) => x.signal_type === 'incomplete_dosing');
      const pass = !hasSignal(bf, 'incomplete_dosing') && !!f && /duration/i.test(f.rationale);
      return { pass, detail: `base ${summarize(bf)} → blanked ${f ? `"${f.rationale.slice(0, 60)}…"` : '(no incomplete_dosing finding)'}` };
    },
  },
  {
    id: 'D-5', title: 'Formulation is read',
    transformation: 'a plain-release molecule → the sustained-release form (same strength/frequency)',
    assertion: 'a finding whose rationale depends on release profile changes or disappears (any finding_ref multiset change)',
    run: () => {
      const base = mkOpdCase({
        presentingComplaints: ['low back ache after lifting'], impressions: ['Lumbago'], diagnosisCodes: ['M54.5'],
        examination: ['Paraspinal tenderness'], advice: ['Local heat'], followUpType: 'IF_REQUIRED',
        medications: [med({ generic: 'Diclofenac', strength: '100 mg' })],   // 200 mg/day scheduled > the 150 mg/day ceiling
      });
      const trans = clone(base);
      trans.medications[0].generic = 'Diclofenac SR';
      trans.medications[0].resolvedGeneric = 'Diclofenac SR';
      trans.medications[0].form = 'Tablet (SR)';
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = !multisetEq(refs(bf), refs(tf));
      return { pass, detail: `plain ${summarize(bf)} → SR ${summarize(tf)}${pass ? '' : ' (identical — the engine reads no release profile)'}` };
    },
  },
  {
    id: 'D-6', title: 'Interaction needs both members',
    transformation: 'a known pair (naproxen + telmisartan, NSAID + ARB) → remove one member',
    assertion: 'the drug_interaction finding disappears',
    run: () => {
      const base = baseInteraction();
      const trans = clone(base);
      trans.medications = trans.medications.filter((m) => m.generic !== 'Telmisartan');
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = hasSignal(bf, 'drug_interaction') && !hasSignal(tf, 'drug_interaction');
      return { pass, detail: `pair ${summarize(bf)} → single ${summarize(tf)}` };
    },
  },
  {
    id: 'D-7', title: 'Interaction ignores non-analgesic dose',
    // DETERMINISM-TRIO PRD v1.0 §2.4 (8 Aug 2026): the relation now carries BOTH arms, because the
    // fix is a THRESHOLD and a one-armed relation cannot tell "reads the dose" from "stopped
    // flagging aspirin". Negative arm = 75 mg OD (antiplatelet, must be silent); positive arm =
    // 650 mg TDS = 1950 mg/day (analgesic intent, must still fire) — §2.3 rows 1 and 5.
    transformation: 'aspirin 75 mg (antiplatelet) + an ARB, then the same script at 650 mg TDS (analgesic)',
    assertion: 'no NSAID-interaction finding fires at 75 mg; the interaction DOES fire at 1950 mg/day',
    run: () => {
      const withAspirin = (strength: string, frequency: string) => mkOpdCase({
        presentingComplaints: ['routine review of blood pressure'],
        impressions: ['Hypertension; post-PTCA on antiplatelet'], diagnosisCodes: ['I10'],
        history: ['PTCA 2024, on aspirin 75 mg'], examination: ['BP 128/82'],
        advice: ['Continue current medication'], followUpType: 'MANDATORY_FOLLOW_UP',
        medications: [
          med({ generic: 'Aspirin', strength, frequency, duration: '30 days', therapeuticClass: 'Antiplatelet' }),
          med({ generic: 'Telmisartan', strength: '40 mg', frequency: 'OD', duration: '30 days', therapeuticClass: 'Antihypertensive' }),
        ],
      });
      const ddiOf = (c: ReturnType<typeof mkOpdCase>) => detFindings(c).filter((f) => f.signal_type === 'drug_interaction');
      const low = ddiOf(withAspirin('75 mg', 'OD'));
      const high = ddiOf(withAspirin('650 mg', 'TDS'));
      const pass = low.length === 0 && high.length > 0;
      const show = (fs: OpdFinding[]) => fs.length ? fs.map((f) => `"${f.subject}"`).join('; ') : '(none)';
      return { pass, detail: `75 mg OD → ${show(low)} · 650 mg TDS → ${show(high)}` };
    },
  },
  {
    id: 'G-1', title: 'Order independence',
    transformation: 'reorder medications[]',
    assertion: 'findings identical as a set (finding_ref multiset unchanged)',
    run: () => {
      const base = mkOpdCase({
        presentingComplaints: ['generalised body ache'], impressions: ['Viral myalgia'], diagnosisCodes: ['M79.1'],
        history: ['Atrial fibrillation on anticoagulation'], examination: ['No focal deficit'],
        advice: ['Hydration'], followUpType: 'IF_REQUIRED',
        medications: [
          med({ generic: 'Ibuprofen', strength: '400 mg', frequency: 'TDS', therapeuticClass: 'NSAID' }),
          med({ generic: 'Warfarin', strength: '5 mg', frequency: 'OD', duration: '30 days', therapeuticClass: 'Anticoagulant' }),
          med({ generic: 'Diclofenac', strength: '75 mg', frequency: 'TDS', therapeuticClass: 'NSAID' }),
        ],
      });
      const trans = clone(base);
      trans.medications = [...trans.medications].reverse();
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = multisetEq(refs(bf), refs(tf));
      return { pass, detail: pass ? `${bf.length} findings, refs stable under reorder` : `refs differ — [${refs(bf).join(',')}] vs [${refs(tf).join(',')}]` };
    },
  },
  {
    id: 'G-2', title: 'Unrelated addition',
    transformation: 'add a medication that trips no rule (cetirizine 10 mg, fully dosed)',
    assertion: 'existing findings unchanged; only additions permitted',
    run: () => {
      const base = baseInteraction();
      const trans = clone(base);
      trans.medications.push(med({ generic: 'Cetirizine', strength: '10 mg', frequency: 'OD', therapeuticClass: 'Antihistamine' }));
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = multisetContains(refs(tf), refs(bf));
      return { pass, detail: pass ? `all ${bf.length} base findings retained (${tf.length} after addition)` : `a base finding vanished — base [${refs(bf).join(',')}] vs [${refs(tf).join(',')}]` };
    },
  },
  {
    id: 'G-3', title: 'Empty-field safety',
    transformation: 'blank examination, then advice, then investigations, one at a time',
    assertion: 'no crash; absence never produces an accusatory (scoring) finding',
    run: () => {
      const base = mkOpdCase({
        presentingComplaints: ['itchy scalp'], impressions: ['Seborrhoeic dermatitis'], diagnosisCodes: ['L21.0'],
        examination: ['Scaling over vertex'], investigations: ['KOH mount'],
        advice: ['Medicated shampoo twice weekly'], followUpType: 'IF_REQUIRED',
        medications: [med({ generic: 'Cetirizine', strength: '10 mg', frequency: 'OD' })],
      });
      const bf = detFindings(base);
      const details: string[] = [];
      let pass = true;
      for (const field of ['examination', 'advice', 'investigations'] as const) {
        const trans = clone(base);
        trans[field] = [];
        try {
          const tf = detFindings(trans);
          opdCompleteness(trans);   // must not throw either
          const newScoring = scoring(tf).filter((f) => !refs(bf).includes(f.finding_ref || '?'));
          if (newScoring.length) { pass = false; details.push(`${field}: accusatory ${summarize(newScoring)}`); }
          else details.push(`${field}: silent`);
        } catch (e) { pass = false; details.push(`${field}: THREW ${(e as Error).message}`); }
      }
      return { pass, detail: details.join(' · ') };
    },
  },
  {
    id: 'G-4', title: 'Unit invariance',
    transformation: 'the same dose expressed as "120 mg" and "0.12 g"',
    assertion: 'same finding set',
    run: () => {
      const a = baseEtoricoxib('120 mg');
      const b = baseEtoricoxib('0.12 g');
      const fa = detFindings(a); const fb = detFindings(b);
      const pass = multisetEq(refs(fa), refs(fb)) && hasSignal(fa, 'dose_ceiling_exceeded');
      return { pass, detail: `mg ${summarize(fa)} vs g ${summarize(fb)}` };
    },
  },
  {
    id: 'G-5', title: 'Duplicate line',
    transformation: 'duplicate one medication line verbatim',
    assertion: 'no interaction fires against the drug and itself; additions limited to the duplication family (duplicate_prescription / duplicate_molecule — the engine\'s designed response to a repeated line; interpretation flagged in the build report)',
    run: () => {
      const base = mkOpdCase({
        presentingComplaints: ['burning micturition'], impressions: ['Uncomplicated UTI'], diagnosisCodes: ['N39.0'],
        examination: ['No renal angle tenderness'], advice: ['Fluids'], followUpType: 'IF_REQUIRED',
        medications: [
          med({ generic: 'Cefixime', strength: '200 mg' }),
          med({ generic: 'Paracetamol', strength: '500 mg', frequency: 'TDS' }),
        ],
      });
      const trans = clone(base);
      trans.medications.push(JSON.parse(JSON.stringify(trans.medications[0])) as OpdMed);
      const bf = detFindings(base); const tf = detFindings(trans);
      const selfInteraction = tf.some((f) => f.signal_type === 'drug_interaction' && /cefixime\s*\+\s*cefixime/i.test(f.subject));
      const allowed = new Set(['duplicate_prescription', 'duplicate_molecule']);
      const baseRefs = refs(bf);
      const additions = tf.filter((f) => !baseRefs.includes(f.finding_ref || '?'));
      const outOfFamily = additions.filter((f) => !allowed.has(f.signal_type || ''));
      const pass = !selfInteraction && outOfFamily.length === 0 && multisetContains(refs(tf), baseRefs);
      return { pass, detail: `additions: ${summarize(additions)}${selfInteraction ? ' — SELF-INTERACTION FIRED' : ''}${outOfFamily.length ? ` — out-of-family ${summarize(outOfFamily)}` : ''}` };
    },
  },
  {
    id: 'G-6', title: 'Teleconsult context',
    transformation: 'set isTeleconsult: true on a note with no examination',
    assertion: 'no finding or completeness item penalises the missing physical examination',
    run: () => {
      const base = mkOpdCase({
        presentingComplaints: ['acidity after meals'], impressions: ['Gastritis'], diagnosisCodes: ['K29.7'],
        advice: ['Avoid late meals'], followUpType: 'IF_REQUIRED',
        medications: [med({ generic: 'Pantoprazole', strength: '40 mg', frequency: 'OD' })],
      });
      const trans = clone(base);
      trans.isTeleconsult = true;
      const bc: OpdCompleteness = opdCompleteness(base);
      const tc: OpdCompleteness = opdCompleteness(trans);
      const baseHasExamGap = bc.items.some((i) => i.key === 'examination' && !i.present);
      const teleHasExamItem = tc.items.some((i) => i.key === 'examination');
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = baseHasExamGap && !teleHasExamItem && multisetEq(refs(bf), refs(tf));
      return { pass, detail: `in-person exam gap: ${baseHasExamGap}; tele exam item present: ${teleHasExamItem}; findings invariant: ${multisetEq(refs(bf), refs(tf))}` };
    },
  },
  {
    id: 'G-7', title: 'Referral handoff',
    transformation: 'set isReferralHandoff + an onward referral on a note with no plan and no follow-up',
    assertion: 'completeness expectations relax (the referral IS the plan and the care transition); no finding demands definitive management',
    run: () => {
      const base = mkOpdCase({
        presentingComplaints: ['right shoulder pain, restricted movement'], impressions: ['Rotator cuff pathology, suspected'],
        diagnosisCodes: ['M75.1'], examination: ['Painful arc positive'],
        medications: [med({ generic: 'Paracetamol', strength: '500 mg', frequency: 'TDS' })],
      });
      const trans = clone(base);
      trans.referrals = ['In-Person Orthopedics (Even-recommended)'];
      trans.numReferrals = 1;
      trans.isReferralHandoff = true;
      const bc = opdCompleteness(base); const tc = opdCompleteness(trans);
      const gap = (c: OpdCompleteness, k: string) => c.items.some((i) => i.key === k && !i.present);
      const bf = detFindings(base); const tf = detFindings(trans);
      const pass = gap(bc, 'advice_given') && gap(bc, 'follow_up')
        && !gap(tc, 'advice_given') && !gap(tc, 'follow_up')
        && multisetEq(refs(bf), refs(tf));
      return { pass, detail: `base gaps advice/follow-up: ${gap(bc, 'advice_given')}/${gap(bc, 'follow_up')} → with referral: ${gap(tc, 'advice_given')}/${gap(tc, 'follow_up')}` };
    },
  },
];

export function runRelations(): RelationResult[] {
  return RELATIONS.map((r) => {
    try {
      const { pass, detail } = r.run();
      return { id: r.id, title: r.title, transformation: r.transformation, assertion: r.assertion, pass, detail };
    } catch (e) {
      return { id: r.id, title: r.title, transformation: r.transformation, assertion: r.assertion, pass: false, detail: `THREW: ${(e as Error).message}` };
    }
  });
}

/**
 * MEASURED status of every relation. Originally ratified at `main` 46c7cf9 (engine 0.81.17);
 * RE-MEASURED 2 August 2026 at engine opd-note-audit/0.81.20, live on production via an Engine
 * Health panel load (the panel runs the deterministic relations on page load), after the deploys
 * 6cff240 and 97e2f36 — evidence: CDMSS-RERATIFICATION-EVIDENCE-2-AUG-2026.md.
 *
 * ALL FOURTEEN MATCHED. The map itself did not change; only RATIFIED_AT_ENGINE moved. Synthetic
 * known-positives 19/19 fired, negative controls 6/6 held (recall_det = 100%). D-4's observed
 * detail showed 6cff240's incomplete_dosing change in the instrument — the strength gap gone,
 * duration still checked, the relation still passing — and neither pinned defect was disturbed.
 *
 * The CI test asserts each relation MATCHES this map — a 'fail' entry is an OBSERVED PRODUCTION
 * DEFECT reproduced as a standing test (PRD §3.1: D-7 "must not [be] changed … to make it pass";
 * §7.3: "record it, do not fix it in this build"). A permanently-red gate would stop all work (the
 * PRD's own M1 rationale), so known defects are PINNED, not asserted green: if the engine ever
 * changes so a pinned failure starts passing, the test fails LOUDLY and the map must be
 * re-ratified with V.
 *
 * ⚠️ NOTE FOR THE NEXT ENGINE BUMP: no gate demands this re-measure. changelog:coverage gates only
 * engine VERSIONS, so a scoring change that does not bump — and a bump that nobody re-measures —
 * both pass silently. Re-measuring the relations and moving RATIFIED_AT_ENGINE is step 3 of the
 * engine-bump checklist, alongside appending to OPD_ENGINE_VERSIONS_CURRENT and writing the
 * changelog entry. All three depend on the builder noticing.
 */
export const RATIFIED_RELATION_STATUS: Record<string, 'pass' | 'fail'> = {
  'D-1': 'pass', 'D-2': 'pass', 'D-3': 'pass', 'D-4': 'pass',
  'D-5': 'fail',   // the engine reads no release profile at 0.81.20 (dosageForm plumbed 0.81.11; read since 6cff240 for incomplete_dosing gaps, but a coarse FORM is not a release profile) — observed class Q2
  'D-6': 'pass',
  // D-7 RE-RATIFIED pass (dose-aware aspirin class, 8 Aug 2026 — DETERMINISM-TRIO PRD v1.0 §2,
  // V ruled D-1/D-2). The pinned defect was real and is fixed, not silenced: tagsFor tagged aspirin
  // `nsaid` BY NAME at any dose and ddiFindings promoted any NSAID-molecule line to major 'NSAID',
  // so aspirin 75 mg beside an ARB fired `nsaid × ace_arb` and lowered live scores. ddiFindings now
  // computes the total daily aspirin mg with the one dose machinery (aspirinMaxDailyMg) and marks a
  // line at ≤ 100 mg/day — or one whose dose will not parse (D-2) — suppressNsaid, which
  // tagInteractions honours by dropping the tag AFTER tagsFor. `antiplatelet` is never removed.
  // The relation itself was STRENGTHENED rather than relaxed: it now also asserts the POSITIVE arm
  // (650 mg TDS = 1950 mg/day still fires), so it cannot be satisfied by an engine that has merely
  // stopped flagging aspirin. Threshold behaviour is regression-guarded by
  // lib/__tests__/aspirin-dose-class.test.ts (every row of PRD §2.3).
  'D-7': 'pass',
  // G-1 RE-RATIFIED pass (DDI pair-order canonicalisation, 1 Aug 2026). The suite surfaced it at
  // f816f34: interaction subjects embedded the meds[] input order ("Interaction (major): A + B"
  // vs "… B + A"), so finding_ref — sha1 over the subject detail — changed when the EMR reordered
  // medication lines, orphaning triage rows on re-audit. Fixed by canonicalising (drug_a, drug_b)
  // at all three construction sites (orderPair in lib/ddi-tags.ts); the ordering itself is
  // regression-guarded by lib/__tests__/ddi-pair-order.test.ts.
  'G-1': 'pass',
  'G-2': 'pass', 'G-3': 'pass', 'G-4': 'pass', 'G-5': 'pass',
  'G-6': 'pass', 'G-7': 'pass',
};

/**
 * The engine version RATIFIED_RELATION_STATUS was measured at. The panel renders this constant and
 * warns when it differs from the deployed OPD_ENGINE_VERSION.
 *
 * MOVED 0.81.20 → 0.81.21 on 8 August 2026 (DETERMINISM-TRIO PRD v1.0 §2.4). The evidence for this
 * move is THIS BUILD'S GREEN SUITE, and the PRD says so in terms: the relations are code-level and
 * CI-measured — `runRelations()` is the same function the panel loads — so a passing
 * lib/__tests__/metamorphic-deterministic.test.ts at 0.81.21 IS the re-measurement, in a way the
 * LLM-leg (Part C) relations, which need a live model, are not. D-7 flips fail → pass with the
 * fix that earned it (see its entry above); every other status is unchanged, including D-5, which
 * stays pinned FAIL — a coarse dosage form is still not a release profile.
 *
 * MOVED 0.81.17 → 0.81.20 on 2 August 2026, and the reason it may move is the whole point: a
 * measurement was taken, on production, at the deployed engine, after both of that day's
 * score-affecting deploys (CDMSS-RERATIFICATION-EVIDENCE-2-AUG-2026.md). This constant's standing
 * warning — that refreshing the number WITHOUT a re-measure "would turn an honest stale label into
 * a dishonest fresh one" (ENGINE-HEALTH-HONESTY PRD §3) — is unchanged and still governs. Changing
 * it requires re-ratifying the map with V and citing the evidence document that recorded the load.
 */
export const RATIFIED_AT_ENGINE = 'opd-note-audit/0.81.21';

/**
 * Drift warning for the health panel (pure — the deployed engine version is an argument so this
 * module never imports engine code). Null when the map is current; otherwise the exact sentence
 * the panel must show. The stale number was never the danger; not knowing it was stale was.
 */
export function ratificationDriftWarning(deployedEngine: string): string | null {
  if (deployedEngine === RATIFIED_AT_ENGINE) return null;
  return `Ratified at ${RATIFIED_AT_ENGINE}. The deployed engine is ${deployedEngine}. These statuses have not been re-measured against the deployed engine.`;
}

// ── Part B — synthetic known-positives + negative controls ────────────────────
/** Placeholder-molecule banned-FDC test table (standing rule from cdsco-banned-fdc-core.test.ts). */
export const MM_BANNED_TEST_TABLE: BannedFdcTable = {
  version: 'cdsco-banned-fdc/metamorphic-test',
  entries: [
    { id: 'mm-entry-1', molecules: ['mol-a', 'mol-b'], notification_date: '2026-06-11', gazette_ref: 'S.O. MMTEST(E)' },
    { id: 'mm-entry-2', molecules: ['mol-c', 'mol-d', 'mol-e'], notification_date: '2026-06-11', gazette_ref: 'S.O. MMTEST2(E)' },
  ],
};

export interface SyntheticFixture {
  id: string;
  family: 'dose_ceiling' | 'dose_sos' | 'banned_fdc' | 'interaction' | 'incomplete_dosing' | 'negative';
  /** positives: the signal_type that must fire. negatives: the nearby signal_type that must NOT. */
  expected_signal_type: string;
  kind: 'positive' | 'negative';
  note: string;
  case: DeidOpdCase;
  usesBannedTestTable?: boolean;
}

const controlCase = (meds: OpdMed[], over: Partial<DeidOpdCase> = {}): DeidOpdCase => mkOpdCase({
  presentingComplaints: ['generalised weakness'], impressions: ['General medical review'], diagnosisCodes: ['Z00.0'],
  examination: ['Unremarkable'], advice: ['Balanced diet'], followUpType: 'IF_REQUIRED',
  medications: meds, ...over,
});

export const SYNTHETIC_FIXTURES: SyntheticFixture[] = [
  // Dose ceiling exceeded — data/dose-limits.json (5)
  { id: 'POS-DOSE-1', family: 'dose_ceiling', expected_signal_type: 'dose_ceiling_exceeded', kind: 'positive',
    note: 'paracetamol stacked across two products: 650 QID + 500 TDS = 4100 mg/day > 4000',
    case: controlCase([med({ generic: 'Paracetamol', strength: '650 mg', frequency: 'QID' }), med({ generic: 'Paracetamol', brand: 'FebriRelief Plus', strength: '500 mg', frequency: 'TDS' })]) },
  { id: 'POS-DOSE-2', family: 'dose_ceiling', expected_signal_type: 'dose_ceiling_exceeded', kind: 'positive',
    note: 'ibuprofen 800 QID = 3200 mg/day > 2400 (single product)',
    case: controlCase([med({ generic: 'Ibuprofen', strength: '800 mg', frequency: 'QID' })]) },
  { id: 'POS-DOSE-3', family: 'dose_ceiling', expected_signal_type: 'dose_ceiling_exceeded', kind: 'positive',
    note: 'diclofenac 75 TDS = 225 mg/day > 150',
    case: controlCase([med({ generic: 'Diclofenac', strength: '75 mg', frequency: 'TDS' })]) },
  { id: 'POS-DOSE-4', family: 'dose_ceiling', expected_signal_type: 'dose_ceiling_exceeded', kind: 'positive',
    note: 'etoricoxib 120 OD with NO documented gout > the 90 mg/day default ceiling (Decision 6)',
    case: controlCase([med({ generic: 'Etoricoxib', strength: '120 mg', frequency: 'OD' })]) },
  { id: 'POS-DOSE-5', family: 'dose_ceiling', expected_signal_type: 'dose_ceiling_exceeded', kind: 'positive',
    note: 'mefenamic acid 500 QID = 2000 mg/day > 1500',
    case: controlCase([med({ generic: 'Mefenamic Acid', strength: '500 mg', frequency: 'QID' })]) },
  // Dose ceiling SOS — default_sos_cap_per_day (3)
  { id: 'POS-SOS-1', family: 'dose_sos', expected_signal_type: 'dose_ceiling_sos', kind: 'positive',
    note: 'paracetamol 1000 TDS scheduled + 650 SOS uncapped (default cap 3) → 4950 potential > 4000',
    case: controlCase([med({ generic: 'Paracetamol', strength: '1000 mg', frequency: 'TDS' }), med({ generic: 'Paracetamol', brand: 'FebriRelief', strength: '650 mg', frequency: 'SOS' })]) },
  { id: 'POS-SOS-2', family: 'dose_sos', expected_signal_type: 'dose_ceiling_sos', kind: 'positive',
    note: 'etoricoxib 90 SOS with an EXPLICIT max 2/day → 180 potential > 90',
    case: controlCase([med({ generic: 'Etoricoxib', strength: '90 mg', frequency: 'SOS, max 2 per day' })]) },
  { id: 'POS-SOS-3', family: 'dose_sos', expected_signal_type: 'dose_ceiling_sos', kind: 'positive',
    note: 'ibuprofen 600 grid 1-0-1 + 600 SOS uncapped → 3000 potential > 2400',
    case: controlCase([med({ generic: 'Ibuprofen', strength: '600 mg', frequency: '1-0-1' }), med({ generic: 'Ibuprofen', brand: 'DoloTab Forte', strength: '600 mg', frequency: 'SOS' })]) },
  // Banned FDC — placeholder molecules vs MM_BANNED_TEST_TABLE (3)
  { id: 'POS-FDC-1', family: 'banned_fdc', expected_signal_type: 'banned_fdc', kind: 'positive', usesBannedTestTable: true,
    note: 'exact two-molecule banned set (placeholders mol-a + mol-b)',
    case: controlCase([med({ generic: 'Mol-A + Mol-B', resolvedGeneric: 'Mol-A + Mol-B' })]) },
  { id: 'POS-FDC-2', family: 'banned_fdc', expected_signal_type: 'banned_fdc', kind: 'positive', usesBannedTestTable: true,
    note: 'exact three-molecule banned set (placeholders mol-c/mol-d/mol-e)',
    case: controlCase([med({ generic: 'Mol-C/Mol-D/Mol-E', resolvedGeneric: 'Mol-C/Mol-D/Mol-E' })]) },
  { id: 'POS-FDC-3', family: 'banned_fdc', expected_signal_type: 'banned_fdc', kind: 'positive', usesBannedTestTable: true,
    note: 'order-swapped banned pair (mol-b + mol-a) still matches the stored set',
    case: controlCase([med({ generic: 'Mol-B + Mol-A', resolvedGeneric: 'Mol-B + Mol-A' })]) },
  // Drug interaction — the shipped tag/curated tables (4, distinct mechanisms)
  { id: 'POS-DDI-1', family: 'interaction', expected_signal_type: 'drug_interaction', kind: 'positive',
    note: 'warfarin + ibuprofen — anticoagulant + NSAID (major)',
    case: controlCase([med({ generic: 'Warfarin', strength: '5 mg', frequency: 'OD', therapeuticClass: 'Anticoagulant' }), med({ generic: 'Ibuprofen', strength: '400 mg', therapeuticClass: 'NSAID' })]) },
  { id: 'POS-DDI-2', family: 'interaction', expected_signal_type: 'drug_interaction', kind: 'positive',
    note: 'atorvastatin + clarithromycin — statin + macrolide (major)',
    case: controlCase([med({ generic: 'Atorvastatin', strength: '20 mg', frequency: 'OD', therapeuticClass: 'Statin' }), med({ generic: 'Clarithromycin', strength: '500 mg', therapeuticClass: 'Macrolide antibiotic' })]) },
  { id: 'POS-DDI-3', family: 'interaction', expected_signal_type: 'drug_interaction', kind: 'positive',
    note: 'sertraline + tramadol — two serotonergic drugs (major)',
    case: controlCase([med({ generic: 'Sertraline', strength: '50 mg', frequency: 'OD', therapeuticClass: 'SSRI' }), med({ generic: 'Tramadol', strength: '50 mg', therapeuticClass: 'Opioid analgesic' })]) },
  { id: 'POS-DDI-4', family: 'interaction', expected_signal_type: 'drug_interaction', kind: 'positive',
    note: 'telmisartan + spironolactone — ACE-I/ARB + potassium-sparing diuretic (major)',
    case: controlCase([med({ generic: 'Telmisartan', strength: '40 mg', frequency: 'OD', therapeuticClass: 'Antihypertensive' }), med({ generic: 'Spironolactone', strength: '25 mg', frequency: 'OD', therapeuticClass: 'Diuretic' })]) },
  // Incomplete dosing — each of dose, frequency, duration, route blanked (4)
  { id: 'POS-DOSING-1', family: 'incomplete_dosing', expected_signal_type: 'incomplete_dosing', kind: 'positive',
    note: 'dose/strength blanked (no dose field, no strength, none in the name)',
    case: controlCase([{ generic: 'Amoxicillin', resolvedGeneric: 'Amoxicillin', formularyMatch: 'source-generic', frequency: 'BD', duration: '5 days', route: 'oral' }]) },
  { id: 'POS-DOSING-2', family: 'incomplete_dosing', expected_signal_type: 'incomplete_dosing', kind: 'positive',
    note: 'frequency blanked',
    case: controlCase([{ generic: 'Amoxicillin', resolvedGeneric: 'Amoxicillin', formularyMatch: 'source-generic', strength: '500 mg', duration: '5 days', route: 'oral' }]) },
  { id: 'POS-DOSING-3', family: 'incomplete_dosing', expected_signal_type: 'incomplete_dosing', kind: 'positive',
    note: 'duration blanked',
    case: controlCase([{ generic: 'Amoxicillin', resolvedGeneric: 'Amoxicillin', formularyMatch: 'source-generic', strength: '500 mg', frequency: 'BD', route: 'oral' }]) },
  { id: 'POS-DOSING-4', family: 'incomplete_dosing', expected_signal_type: 'incomplete_dosing', kind: 'positive',
    note: 'route blanked and not inferable (no dosage-form word anywhere on the line)',
    case: controlCase([{ generic: 'Amoxicillin', resolvedGeneric: 'Amoxicillin', formularyMatch: 'source-generic', strength: '500 mg', dose: '1', frequency: 'BD', duration: '5 days' }]) },
  // ── The six negative controls — just inside every limit; MUST stay silent ──
  { id: 'NEG-1', family: 'negative', expected_signal_type: 'dose_ceiling_exceeded', kind: 'negative',
    note: 'ibuprofen 800 TDS = exactly 2400 mg/day — AT the ceiling, not over it',
    case: controlCase([med({ generic: 'Ibuprofen', strength: '800 mg', frequency: 'TDS' })]) },
  { id: 'NEG-2', family: 'negative', expected_signal_type: 'dose_ceiling_exceeded', kind: 'negative',
    note: 'etoricoxib 120 OD WITH a documented gout diagnosis — the conditional 120 ceiling applies',
    case: controlCase([med({ generic: 'Etoricoxib', strength: '120 mg', frequency: 'OD' })],
      { presentingComplaints: ['pain in the right great toe'], impressions: ['Acute gout flare'], diagnosisCodes: ['M10.9'] }) },
  { id: 'NEG-3', family: 'negative', expected_signal_type: 'drug_interaction', kind: 'negative',
    note: 'amoxicillin + paracetamol — just OUTSIDE every interaction pair (no shared mechanism tag)',
    case: controlCase([med({ generic: 'Amoxicillin', strength: '500 mg', therapeuticClass: 'Penicillin antibiotic' }), med({ generic: 'Paracetamol', strength: '500 mg', therapeuticClass: 'Analgesic' })],
      { presentingComplaints: ['painful swallowing'], impressions: ['Bacterial tonsillitis'], diagnosisCodes: ['J03.9'] }) },
  { id: 'NEG-4', family: 'negative', expected_signal_type: 'incomplete_dosing', kind: 'negative',
    note: 'a COMPLETE prescription — dose, frequency, duration and route all present',
    case: controlCase([med({ generic: 'Amoxicillin', strength: '500 mg' })]) },
  { id: 'NEG-5', family: 'negative', expected_signal_type: 'banned_fdc', kind: 'negative', usesBannedTestTable: true,
    note: 'banned core + one extra molecule (mol-a + mol-b + mol-z) — the C5 superset boundary',
    case: controlCase([med({ generic: 'Mol-A + Mol-B + Mol-Z', resolvedGeneric: 'Mol-A + Mol-B + Mol-Z' })]) },
  { id: 'NEG-6', family: 'negative', expected_signal_type: 'dose_ceiling_sos', kind: 'negative',
    note: 'paracetamol 500 SOS max 3/day = 1500 mg potential — well inside the 4000 ceiling',
    case: controlCase([med({ generic: 'Paracetamol', strength: '500 mg', frequency: 'SOS, max 3 per day' })]) },
];

export interface SyntheticControlResult {
  id: string;
  family: SyntheticFixture['family'];
  kind: 'positive' | 'negative';
  expected_signal_type: string;
  note: string;
  /** positives: expected signal fired. negatives: it did NOT (see `held`). */
  fired: boolean;
  /** negatives only: no non-informational finding of ANY type fired */
  held?: boolean;
  observed: string;
}
export interface SyntheticControlsReport {
  positives: SyntheticControlResult[];
  negatives: SyntheticControlResult[];
  planted: number;
  fired: number;
  /** recall of the DETERMINISTIC LEG ONLY over the planted corpus — no LLM recall claim (PRD §6) */
  recall_det: number;
  negativesHeld: boolean;
}

export function runSyntheticControls(): SyntheticControlsReport {
  const results: SyntheticControlResult[] = SYNTHETIC_FIXTURES.map((fx) => {
    const findings = detFindings(fx.case, fx.usesBannedTestTable ? { bannedTable: MM_BANNED_TEST_TABLE } : undefined);
    const fired = hasSignal(findings, fx.expected_signal_type);
    const base: SyntheticControlResult = {
      id: fx.id, family: fx.family, kind: fx.kind, expected_signal_type: fx.expected_signal_type,
      note: fx.note, fired, observed: summarize(findings),
    };
    if (fx.kind === 'negative') base.held = !fired && scoring(findings).length === 0;
    return base;
  });
  const positives = results.filter((r) => r.kind === 'positive');
  const negatives = results.filter((r) => r.kind === 'negative');
  const fired = positives.filter((r) => r.fired).length;
  return {
    positives, negatives,
    planted: positives.length, fired,
    recall_det: positives.length ? fired / positives.length : 0,
    negativesHeld: negatives.every((r) => r.held === true),
  };
}

// ── Part C — LLM-leg relations (lab, NOT CI; PRD §5) ─────────────────────────
// Fixtures are SYNTHETIC db13-SHAPED ROWS (rowToOpdCase input) so the lab runner drives the REAL
// grounded audit path (auditOpdNote) without a db13 uid or any PHI (§9.3). The runner
// (scripts/metamorphic-llm-report.mjs) audits base + transformed 3× each and persists to
// lab_analyses under the relation's experiment name; the panel reads them back (§5A).
export type Db13Row = Record<string, unknown>;

export interface PartCRelation {
  id: 'L-1' | 'L-2' | 'L-3';
  title: string;
  experiment: string;              // lab_analyses experiment name — panel queries LIKE 'mm-llm-%'
  transformation: string;
  assertion: string;
  baseRow: Db13Row;
  transform: (row: Db13Row) => Db13Row;
  /** does the tested behaviour FIRE in this finding set? (evaluated per run, majority per arm) */
  fires: (findings: OpdFinding[]) => boolean;
  /** verdict from the two per-arm majorities */
  verdict: (baseFires: boolean, transformedFires: boolean) => boolean;
  /**
   * ENGINE-HEALTH-HONESTY PRD §2: what the BASE arm must exhibit for the relation to be testable.
   * 'fires' = base majority of the relation's own `fires` matcher; 'praise' = base majority of
   * praise. If the base arm lacks it, the transformation had nothing to remove and the verdict is
   * VACUOUS — never HOLDS (the disjunction that reported HOLDS on a silent engine, 1 Aug).
   */
  precondition: 'fires' | 'praise';
  /**
   * LLM-LEG-RELATION-REPAIR PRD §3 (DEC-5, 2 Aug 2026) — which way the transformation moves the
   * finding, and therefore what makes the relation TESTABLE.
   *
   *  'removes' — the transformation should make the state GO. Testable only when the base arm HAS
   *              it; otherwise there was nothing to remove. (Every relation before this build.)
   *  'adds'    — the transformation should make the state APPEAR. Testable only when the base arm
   *              does NOT have it; a base that already fires means the engine flags the note even
   *              untransformed, so the transformed arm proves nothing. That reads VACUOUS, never
   *              HOLDS, and is itself a real result: the engine is over-flagging the base.
   *
   * L-1 needed 'adds' because the engine emits NO finding type meaning "a condition was documented
   * and not managed" — all 17 of its types are about a drug, a test or a code (MEASURED 2 Aug), so
   * the old "the demand for management disappears" assertion was unfalsifiable.
   */
  direction: 'removes' | 'adds';
  /**
   * Does this relation still RUN? (V ruled 2 Aug 2026 — stop investing in the LLM leg.)
   *
   * RETIRED IS NOT DELETED. A retired relation keeps its fixture, matchers, transform and verdict
   * in full: the runner skips it and the panel hides it, but the object stays here because it is
   * still a TEST FIXTURE. L-3 in particular is the subject of the 1 August regression guard
   * (engine-health-honesty.test.ts) that pins the real production defect where a disjunction
   * reported HOLDS while a documented penicillin allergy went unflagged. Deleting L-3 would delete
   * that guard, and with it the record of the defect.
   *
   * L-2 and L-3 are retired because both rest on PRAISE, and praise proved too rare to build a
   * test on — 8 appropriateness_high_value findings corpus-wide. Both read VACUOUS. L-1 stays
   * active with its result on record.
   */
  active: boolean;
}

const gpRow = (over: Db13Row): Db13Row => ({
  uid: null,   // synthetic — never a db13 uid (§9.3)
  type_of_prescription: 'HOSPITAL_GP',
  consult_types: ['VISITING_HOSPITAL'],
  follow_up_type: 'IF_REQUIRED',
  timestamp: '2026-07-15T10:00:00Z',
  ...over,
});
const gpBlock = (symptoms: string, diagnoses: { icd_code?: string; diagnosis_or_impression: string }[], plan: string) => ({
  'general_practitioner_prescription__presenting_complaints': [{ symptoms, diagnoses }],
  'general_practitioner_prescription__plan_of_management': [{ management_plan: plan }],
});

const praiseFires = (findings: OpdFinding[]): boolean =>
  findings.some((f) => f.signal_type === 'appropriateness_high_value'
    || (f.domain === 'appropriateness' && f.verdict === 'high-value'));

// L-1 (§4.1) — the plan, examination and medication are IDENTICAL across both arms by construction,
// not by careful copying: the transform reuses these constants, so an edit cannot desynchronise the
// arms and accidentally give the engine a second reason to change its answer.
const L1_PLAN = 'Antibiotic course started. Limb elevation. Review in 5 days or earlier if fever.';
const L1_EXAM = '<p>Left leg: erythema and warmth over the shin, mild tenderness. No fluctuance.</p>';
const L1_MEDS = [{ generic_name: 'Amoxicillin + Clavulanic acid', strength: '625 mg', dosage: '1 tablet', frequency: 'TDS', duration: '5 days', route_of_administration: 'oral' }];

export const PART_C_RELATIONS: PartCRelation[] = [
  {
    id: 'L-1', title: 'Status qualifier is read', experiment: 'mm-llm-l1',
    transformation: 'mark the documented cellulitis "healed / resolved" while the antibiotic stays',
    assertion: 'a finding appears against the now-unindicated antibiotic',
    // FLIPPED 2 Aug 2026 (LLM-LEG-RELATION-REPAIR §4.1, DEC-1). The old form asserted that a finding
    // DEMANDING MANAGEMENT of the condition disappears — a finding the engine cannot emit (MEASURED:
    // all 17 live finding types are about a drug, a test or a code), so the base could fire only by
    // coincidence when an unrelated finding happened to mention cellulitis. Unfalsifiable as written.
    // The flipped form tests a capability the prompt DOES specify (opd-note-audit-core.ts:843,
    // "UNINDICATED / CONTRADICTED DRUG: check EVERY prescribed drug has a plausible indication in
    // THIS note"): an antibiotic that was correct for an active cellulitis becomes unindicated the
    // moment the cellulitis reads healed, and nothing else about the note moves.
    baseRow: gpRow({
      ...gpBlock('Left leg redness, swelling and pain for 3 days. Warm to touch. No fever.',
        [{ icd_code: 'L03.1', diagnosis_or_impression: 'Left leg cellulitis' }],
        L1_PLAN),
      'general_practitioner_prescription__examination': L1_EXAM,
      medications: L1_MEDS,
    }),
    // ONLY the symptom line and the diagnosis text change. Examination, plan and medications are
    // carried through untouched by the spread.
    transform: (row) => ({
      ...row,
      ...gpBlock('Review of left leg cellulitis — fully healed. No pain, no swelling. No fever.',
        [{ icd_code: 'L03.1', diagnosis_or_impression: 'Left leg cellulitis — healed / resolved' }],
        L1_PLAN),
    }),
    // Tests the ANTIBIOTIC, never the condition. Matching on /cellulitis/ was the original defect:
    // it made the matcher fire on any finding that merely mentioned the diagnosis.
    fires: (findings) => findings.some((f) =>
      f.informational !== true
      && (f.verdict === 'low-value' || f.verdict === 'context-dependent')
      && /amoxicillin|clavulan|antibiotic/i.test(`${f.subject} ${f.rationale}`)),
    verdict: (base, transformed) => !base && transformed,
    precondition: 'fires',
    direction: 'adds',
    active: true,   // the one LLM-leg relation still running; its result stands on record
  },
  {
    id: 'L-2', title: 'Praise requires evidence', experiment: 'mm-llm-l2',
    transformation: 'delete the documented indication the praised drug rests on',
    assertion: 'the appropriateness_high_value finding disappears',
    // REBUILT 2 Aug 2026 (LLM-LEG-RELATION-REPAIR §4.2, DEC-3). The old base carried
    // `medications: []` and rested its praise on a cardiology referral — the one shape the engine
    // almost never praises. MEASURED: praise is rare (8 appropriateness_high_value findings
    // corpus-wide) and 10 of the 12 most recent land on a NAMED DRUG or a NAMED TEST; exactly one
    // is referral-shaped. So the base scored 0/3 on both pipelines and L-2 was VACUOUS before its
    // transformation was ever judged. This base copies the shape of uNpGAZQG7KkpTiXVGMpY, which
    // earned this praise on two separate runs: iron justified by documented heavy bleeding.
    baseRow: gpRow({
      ...gpBlock('Heavy menstrual bleeding for 4 months, passing clots. Tiredness on exertion.',
        [{ icd_code: 'D25.9', diagnosis_or_impression: 'Uterine fibroid' },
         { icd_code: 'N92.0', diagnosis_or_impression: 'Heavy menstrual bleeding' }],
        'Iron supplementation started for anaemia risk from heavy bleeding. Pelvic ultrasound reviewed. Review in 6 weeks with haemoglobin.'),
      medications: [
        { generic_name: 'Ferrous Ascorbate + Folic Acid', strength: '100 mg', dosage: '1 tablet', frequency: 'OD', duration: '30 days', route_of_administration: 'oral' },
        { generic_name: 'Mefenamic Acid + Paracetamol', strength: '250/325 mg', dosage: '1 tablet', frequency: 'TDS', duration: '3 days', route_of_administration: 'oral' },
      ],
    }),
    // THE DRUGS STAY, THE REASON FOR THEM GOES — medications are carried through by the spread and
    // are byte-identical across the arms. Only the complaint, the diagnoses and the plan change,
    // so the iron and the mefenamic acid are left with nothing in the note justifying them.
    transform: (row) => ({
      ...row,
      ...gpBlock('Came for a routine review. No specific complaint.',
        [{ icd_code: 'Z00.0', diagnosis_or_impression: 'General medical examination' }],
        'Continue current medication. Review in 6 weeks.'),
    }),
    fires: praiseFires,
    verdict: (base, transformed) => base && !transformed,
    precondition: 'fires',
    direction: 'removes',
    // RETIRED 2 Aug 2026 (V): rests on praise, and praise is too rare to build a test on — 8
    // appropriateness_high_value findings corpus-wide. Kept in full as a verdict-logic fixture.
    active: false,
  },
  {
    id: 'L-3', title: 'Praise is not blind', experiment: 'mm-llm-l3',
    transformation: 'add a clear safety problem elsewhere in the note (documented penicillin allergy + amoxicillin prescribed — LLM-leg only; the deterministic leg has no allergy check)',
    assertion: 'either the praise disappears OR a safety finding appears — silence on both is a failure',
    // BASE REPLACED 2 Aug 2026 (LLM-LEG-RELATION-REPAIR §4.3, DEC-4) — CLINICAL CONTENT ONLY. The
    // old base was a viral URTI with one antihistamine, which does not earn praise (see L-2's note),
    // so L-3's `praise` precondition was never met and the relation was VACUOUS before the allergy
    // transformation was ever judged. Its failure was never about allergies. Calamine for a rash is
    // a praise shape observed in production (gs73Lv5Xo8OIzj5DqvJY).
    // The transform, fires, verdict and precondition below are UNTOUCHED, byte for byte.
    baseRow: gpRow({
      ...gpBlock('Itchy raised rash over both forearms since yesterday after gardening. No breathlessness, no facial swelling. Afebrile.',
        [{ icd_code: 'L50.9', diagnosis_or_impression: 'Acute urticaria' }],
        'Antihistamine started for the itch. Calamine for symptomatic relief. Explained no antibiotic is needed. Review if breathlessness or facial swelling.'),
      medications: [
        { generic_name: 'Cetirizine', strength: '10 mg', dosage: '1 tablet', frequency: 'OD', duration: '3 days', route_of_administration: 'oral' },
        { generic_name: 'Calamine Lotion', dosage: 'topical application', frequency: 'BD', duration: '5 days', route_of_administration: 'topical' },
      ],
    }),
    transform: (row) => ({
      ...row,
      patient_details__allergies: 'Penicillin allergy — rash and facial swelling with amoxicillin in 2023',
      medications: [
        ...(row.medications as Db13Row[]),
        { generic_name: 'Amoxicillin', strength: '500 mg', dosage: '1 capsule', frequency: 'BD', duration: '5 days', route_of_administration: 'oral' },
      ],
    }),
    fires: (findings) => {
      // in the TRANSFORMED arm this means "the engine responded": praise gone is checked by the
      // verdict fn; here `fires` = a drug-allergy safety finding is present.
      return findings.some((f) => f.domain === 'prescribing_safety'
        && /allerg|penicillin|amoxicillin/i.test(`${f.subject} ${f.rationale}`)
        && f.informational !== true);
    },
    // L-3's verdict is evaluated by the RUNNER over BOTH matchers (praise + safety); this
    // signature receives (praiseStillPresent, safetyFired) for the transformed arm.
    verdict: (praiseStillPresent, safetyFired) => !praiseStillPresent || safetyFired,
    precondition: 'praise',
    direction: 'removes',
    // RETIRED 2 Aug 2026 (V): same praise problem as L-2. ⚠️ MUST NOT BE DELETED — this object is
    // the fixture for the 1 August regression guard in engine-health-honesty.test.ts, which pins
    // the production defect where the old disjunction reported HOLDS on a silent engine while a
    // documented penicillin allergy went unflagged. Deleting it deletes the record of that defect.
    active: false,
  },
];

/** 3-run majority for one arm. A 2–1 result is a SPLIT — recorded, never silently passed (M2). */
export function majorityOf(fires: boolean[]): { fired: boolean; split: boolean } {
  const yes = fires.filter(Boolean).length;
  return { fired: yes * 2 > fires.length, split: yes !== 0 && yes !== fires.length };
}

// ── Part C verdict — ONE implementation (runner + panel), ENGINE-HEALTH-HONESTY PRD §2 ────────
// A disjunction cannot distinguish "the engine responded correctly" from "the engine was silent":
// on 1 Aug L-3 reported HOLDS while a documented penicillin allergy + amoxicillin went unflagged,
// because base praise never appeared and `!praiseStillPresent` carried the verdict. The
// precondition is therefore evaluated FIRST; a relation whose base arm lacks the state the
// transformation is supposed to remove is VACUOUS — a real, visible result, never HOLDS.
export type PartCVerdict = 'HOLDS' | 'FAILS' | 'VACUOUS';

export interface PartCArmMajorities {
  baseFired: boolean;        // base-arm majority of the relation's `fires` matcher
  basePraise: boolean;       // base-arm majority of praise (L-3's precondition)
  transformedFired: boolean; // transformed-arm majority of the relation's `fires` matcher
  transformedPraise: boolean;// transformed-arm majority of praise (L-3's verdict input)
}

export function partCVerdict(rel: PartCRelation, m: PartCArmMajorities): { verdict: PartCVerdict; reason?: string } {
  // Does the BASE arm exhibit the state the relation is about? (praise, or the relation's own matcher)
  const baseHasState = rel.precondition === 'praise' ? m.basePraise : m.baseFired;

  // LLM-LEG-RELATION-REPAIR §3 (DEC-5): testability depends on which way the transformation moves.
  // An 'adds' relation is meaningless when the base ALREADY fires — the engine flags the note before
  // the transformation, so the transformed arm proves nothing about the transformation. That is a
  // real result about the engine over-flagging, and it must never be reported as HOLDS.
  if (rel.direction === 'adds' && baseHasState) {
    return { verdict: 'VACUOUS', reason: 'could not be tested — the base arm already fired, so the engine flags this even before the transformation' };
  }
  // A 'removes' relation is meaningless when the base LACKS the state — nothing to remove. Reason
  // string byte-identical to the one shipped with ENGINE-HEALTH-HONESTY.
  if (rel.direction === 'removes' && !baseHasState) {
    return { verdict: 'VACUOUS', reason: `could not be tested — the base arm produced no ${rel.precondition}` };
  }

  // Testable. The formula itself lives on the relation ('removes' → base && !transformed,
  // 'adds' → !base && transformed), so there is exactly one place per relation that states it.
  const holds = rel.id === 'L-3'
    ? rel.verdict(m.transformedPraise, m.transformedFired)   // (praiseStillPresent, safetyFired)
    : rel.verdict(m.baseFired, m.transformedFired);
  return { verdict: holds ? 'HOLDS' : 'FAILS' };
}
