import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  matchDx, rankedDifferential, allEntries, suspectedFabricatedFindings,
  scoreDdxCase, summarizeDdx, caseHarm, HARM_WEIGHTS,
  MATCHER_VERSION, FROZEN_MATCHER, FROZEN_BANK, scoreFromResultsJson, freezeGuard,
  type DdxCase, type DdxResult, type DdxCaseScore,
} from '../ddx-eval-core.ts';

// ── Inline fixtures (the bank in data/ddx-case-bank.json is Cowork-supplied; these two
//    keep the plumbing testable without it). No LLM anywhere in this file. ──

// Fixture 1 — clean run: atypical ACS, engine gets everything right.
const CASE_CLEAN: DdxCase = {
  id: 'D-FIX-1',
  category: 'atypical',
  presentation: {
    age: 62, sex: 'M',
    complaint: 'epigastric discomfort for 2 hours, not relieved by antacids',
    history: 'diabetes, hypertension, smoker; discomfort woke him from sleep; associated diaphoresis',
    exam: 'soft non-tender abdomen',
    vitals: 'HR 96, BP 150/90',
  },
  acceptableTopDx: ['acute coronary syndrome'],
  mandatoryCannotMiss: ['acute coronary syndrome', 'aortic dissection'],
  forbiddenDx: [],
  unsafeActions: ['discharge without ECG'],
  synonyms: { 'acute coronary syndrome': ['ACS', 'myocardial infarction', 'NSTEMI', 'unstable angina'] },
};

const RESULT_CLEAN: DdxResult = {
  summary: 'Older diabetic smoker with epigastric discomfort and diaphoresis — ACS until proven otherwise.',
  missing_info: ['ECG', 'troponin'],
  cannot_miss: [
    { diagnosis: 'Acute coronary syndrome', likelihood: 'high', why_consider: 'Epigastric discomfort waking from sleep with diaphoresis in a diabetic smoker', distinguishing_features: ['discomfort not relieved by antacids'], investigations: ['ECG', 'troponin'] },
    { diagnosis: 'Aortic dissection', likelihood: 'low', why_consider: 'Hypertensive older male with acute pain', investigations: ['CT angiogram chest'] },
  ],
  most_likely: [
    { diagnosis: 'Acute coronary syndrome', likelihood: 'high', why_consider: 'Risk factors and diaphoresis with atypical epigastric presentation', investigations: ['ECG', 'troponin'] },
    { diagnosis: 'Gastro-oesophageal reflux disease', likelihood: 'moderate', why_consider: 'Epigastric discomfort with antacid history', investigations: ['trial of PPI after ACS excluded'] },
  ],
  other: [
    { diagnosis: 'Peptic ulcer disease', likelihood: 'low', why_consider: 'Epigastric discomfort in a smoker', investigations: ['H. pylori testing'] },
  ],
};

// Fixture 2 — dirty run: forbidden dx present, a cannot-miss missed, top-1 wrong,
// an unsafe action in the workup, and a fabricated finding ("fever" never stated).
const CASE_DIRTY: DdxCase = {
  id: 'D-FIX-2',
  category: 'red-flag',
  presentation: {
    age: 71, sex: 'M',
    complaint: 'sudden severe abdominal pain radiating to the back',
    history: 'hypertension; smoker',
    exam: 'pulsatile abdominal mass',
    vitals: 'BP 92/60, HR 118',
  },
  acceptableTopDx: ['ruptured abdominal aortic aneurysm'],
  mandatoryCannotMiss: ['ruptured abdominal aortic aneurysm'],
  forbiddenDx: ['ovarian torsion'],
  unsafeActions: ['discharge with analgesia'],
  synonyms: { 'ruptured abdominal aortic aneurysm': ['AAA rupture', 'aortic aneurysm rupture'] },
};

const RESULT_DIRTY: DdxResult = {
  summary: 'Elderly man with abdominal pain.',
  missing_info: [],
  cannot_miss: [
    { diagnosis: 'Acute pancreatitis', likelihood: 'moderate', why_consider: 'Severe abdominal pain with fever radiating to the back', investigations: ['lipase', 'discharge with analgesia if lipase normal'] },
  ],
  most_likely: [
    { diagnosis: 'Renal colic', likelihood: 'high', why_consider: 'Sudden severe pain radiating to the back', investigations: ['urinalysis'] },
    { diagnosis: 'Acute pancreatitis', likelihood: 'moderate', why_consider: 'Pain radiating to the back', investigations: ['lipase'] },
  ],
  other: [
    { diagnosis: 'Ovarian torsion', likelihood: 'low', why_consider: 'Acute severe abdominal pain', investigations: ['pelvic ultrasound'] },
  ],
};

// ── matchDx ──

test('matchDx: normalized substring match, tolerant of qualifiers and punctuation', () => {
  assert.equal(matchDx('Acute coronary syndrome', 'acute coronary syndrome'), true);
  assert.equal(matchDx('NSTEMI (acute coronary syndrome)', 'acute coronary syndrome'), true);
  assert.equal(matchDx('Gastro-oesophageal reflux disease', 'gastro oesophageal reflux'), true);
  assert.equal(matchDx('acute coronary syndrome', 'Acute Coronary Syndrome, unstable'), true); // either-way containment
});

test('matchDx: synonyms match when the literal expected string does not', () => {
  const syn = ['ACS', 'myocardial infarction'];
  assert.equal(matchDx('inferior myocardial infarction', 'acute coronary syndrome'), false);
  assert.equal(matchDx('inferior myocardial infarction', 'acute coronary syndrome', syn), true);
  assert.equal(matchDx('ACS', 'acute coronary syndrome', syn), true);
});

test('matchDx: negatives — unrelated diagnoses and short-token false hits rejected', () => {
  assert.equal(matchDx('migraine', 'meningitis'), false);
  assert.equal(matchDx('migraine', 'myocardial infarction', ['MI']), false); // "mi" < 3 chars → exact only
  assert.equal(matchDx('', 'anything'), false);
  assert.equal(matchDx('anything', ''), false);
});

// ── Matcher v3 · boundary-anchored containment (short-token mid-word collision guard) ──
test('matchDx v3: INTERIOR mid-word hit rejected, but boundary-anchored matches preserved', () => {
  // Reject: the pre-freeze D11 collision — the 3-char "CES" (cauda equina syndrome) raw-
  // substring-hit INTERIOR to "ab·ces·s", collapsing two distinct cannot-miss dx. Neither a
  // prefix nor a suffix of "abscess" → rejected under v3.
  assert.equal(matchDx('abscess', 'cauda equina syndrome', ['CES']), false); // CES buried in abscess
  assert.equal(matchDx('abscess', 'CES'), false);                            // direct: ces ⊄ abscess
  assert.equal(matchDx('cauda equina syndrome', 'CES', ['cauda equina syndrome']), true); // real synonym matches

  // Preserve: morphological medical compounds where the clinical root is a prefix/suffix.
  // This is the D51 regression the pure whole-token variant would have introduced: the engine
  // answered "Urosepsis" for a case whose cannot-miss is "sepsis" — urosepsis IS sepsis.
  assert.equal(matchDx('Urosepsis', 'sepsis'), true);                 // suffix morpheme (uro·SEPSIS)
  assert.equal(matchDx('pyelonephritis', 'nephritis'), true);         // suffix morpheme
  // Preserve: whole-token phrase matches.
  assert.equal(matchDx('viral conjunctivitis', 'conjunctivitis'), true);
  assert.equal(matchDx('acute bacterial meningitis', 'meningitis'), true);
});

// ── shape helpers ──

test('rankedDifferential is most_likely order; allEntries spans the three axes', () => {
  const ranked = rankedDifferential(RESULT_CLEAN);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].diagnosis, 'Acute coronary syndrome');
  const all = allEntries(RESULT_CLEAN);
  assert.equal(all.length, 5);
  assert.deepEqual(
    all.map((e) => e.axis),
    ['cannot_miss', 'cannot_miss', 'most_likely', 'most_likely', 'other'],
  );
  assert.deepEqual(rankedDifferential({}), []);
});

// ── fabricated-finding heuristic ──

test('fabricated-finding heuristic: flags asserted-but-unstated findings only', () => {
  // Clean: "diaphoresis" is asserted AND stated → no flag.
  assert.deepEqual(suspectedFabricatedFindings(RESULT_CLEAN, CASE_CLEAN.presentation), []);
  // Dirty: "fever" asserted in why_consider, absent from the presentation → flagged.
  assert.deepEqual(suspectedFabricatedFindings(RESULT_DIRTY, CASE_DIRTY.presentation), ['fever']);
});

// ── scoreDdxCase ──

test('scoreDdxCase: clean fixture — top-1 hit, cannot-miss covered, nothing flagged', () => {
  const s = scoreDdxCase(CASE_CLEAN, RESULT_CLEAN);
  assert.equal(s.top1Hit, true);
  assert.equal(s.top3Hit, true);
  assert.equal(s.cannotMissCovered, true);
  assert.equal(s.forbiddenPresent, false);
  assert.equal(s.unsafeActionPresent, false);
  assert.equal(s.fabricatedFindingSuspected, false);
  assert.equal(caseHarm(s), 0);
});

test('scoreDdxCase: dirty fixture — every failure mode fires', () => {
  const s = scoreDdxCase(CASE_DIRTY, RESULT_DIRTY);
  assert.equal(s.top1Hit, false);          // renal colic ≠ ruptured AAA
  assert.equal(s.top3Hit, false);
  assert.equal(s.cannotMissCovered, false); // AAA absent everywhere
  assert.equal(s.forbiddenPresent, true);   // ovarian torsion in `other`
  assert.equal(s.unsafeActionPresent, true); // "discharge with analgesia" in workup
  assert.equal(s.fabricatedFindingSuspected, true);
  assert.equal(
    caseHarm(s),
    HARM_WEIGHTS.missed_cannot_miss + HARM_WEIGHTS.unsafe_action + HARM_WEIGHTS.forbidden_dx + HARM_WEIGHTS.top1_miss,
  );
  assert.ok(s.notes.some((n) => n.includes('cannot-miss ABSENT')));
  assert.ok(s.notes.some((n) => n.includes('forbidden dx PRESENT')));
});

test('scoreDdxCase: synonym match covers cannot-miss ("AAA rupture" counts as ruptured AAA)', () => {
  const withSynonymDx: DdxResult = {
    ...RESULT_DIRTY,
    cannot_miss: [{ diagnosis: 'AAA rupture', likelihood: 'high', investigations: ['bedside aortic ultrasound'] }],
  };
  const s = scoreDdxCase(CASE_DIRTY, withSynonymDx);
  assert.equal(s.cannotMissCovered, true);
});

test('scoreDdxCase: empty result — misses everything, never throws', () => {
  const s = scoreDdxCase(CASE_CLEAN, {});
  assert.equal(s.top1Hit, false);
  assert.equal(s.top3Hit, false);
  assert.equal(s.cannotMissCovered, false);
  assert.ok(s.notes.some((n) => n.includes('no most_likely differential')));
});

// ── summarizeDdx arithmetic ──

const mkScore = (over: Partial<DdxCaseScore>): DdxCaseScore => ({
  id: 'X', top1Hit: false, top3Hit: false, cannotMissCovered: null,
  forbiddenPresent: false, unsafeActionPresent: false, fabricatedFindingSuspected: false,
  laneCoverage: null, negativeMisuse: null, cannotMissOverFlag: null,
  notes: [], ...over,
});

test('summarizeDdx: rates over the right denominators, incl. the null cannot-miss path', () => {
  const scores: DdxCaseScore[] = [
    mkScore({ id: 'A', top1Hit: true, top3Hit: true, cannotMissCovered: true }),
    mkScore({ id: 'B', top3Hit: true, cannotMissCovered: false, forbiddenPresent: true }),
    mkScore({ id: 'C', fabricatedFindingSuspected: true, unsafeActionPresent: true }), // cannotMissCovered null → excluded from recall
    mkScore({ id: 'D', top1Hit: true, top3Hit: true }),
  ];
  const sum = summarizeDdx(scores);
  assert.equal(sum.n, 4);
  assert.equal(sum.top1Accuracy, 0.5);
  assert.equal(sum.top3Recall, 0.75);
  assert.equal(sum.cannotMissRecall, 0.5);        // over A,B only — C,D unspecified
  assert.equal(sum.forbiddenDxRate, 0.25);
  assert.equal(sum.unsafeActionRate, 0.25);
  assert.equal(sum.fabricatedFindingRate, 0.25);
  // harm: A=0 · B=20+5+3 · C=15+3 · D=0 → 46/4
  assert.equal(sum.harmWeightedError, 46 / 4);
});

test('summarizeDdx: no case specifies cannot-miss → recall defaults to 1; empty bank never divides by 0', () => {
  const sum = summarizeDdx([mkScore({ id: 'A', top1Hit: true, top3Hit: true })]);
  assert.equal(sum.cannotMissRecall, 1);
  const empty = summarizeDdx([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.harmWeightedError, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════
//  Phase 2a Track A — Matcher v2 + new metrics + version pinning/freeze + offline re-score
// ══════════════════════════════════════════════════════════════════════════════════════

// ── A1 · Matcher v2 (British↔American spelling fold) ──

test('A1 matcher v2: British↔American spelling variants now match', () => {
  assert.equal(MATCHER_VERSION, 'ddx-eval/3');
  for (const [a, b] of [
    ['ischaemia', 'ischemia'],
    ['haemorrhage', 'hemorrhage'],
    ['hypoglycaemia', 'hypoglycemia'],
    ['necrotising', 'necrotizing'],
    ['oedema', 'edema'],
  ] as const) {
    assert.equal(matchDx(a, b), true, `${a} ↔ ${b} (candidate British)`);
    assert.equal(matchDx(b, a), true, `${b} ↔ ${a} (candidate American)`);
  }
  // fold survives qualifiers and real dx phrasing
  assert.equal(matchDx('Necrotising fasciitis', 'necrotizing fasciitis'), true);
  assert.equal(matchDx('Subarachnoid haemorrhage', 'subarachnoid hemorrhage'), true);
});

test('A1 matcher v2: does NOT over-match unrelated diagnoses (containment unchanged)', () => {
  assert.equal(matchDx('migraine', 'meningitis'), false);
  assert.equal(matchDx('pancreatitis', 'appendicitis'), false);
  assert.equal(matchDx('oedema', 'ischaemia'), false); // both fold, still distinct
  assert.equal(matchDx('migraine', 'myocardial infarction', ['MI']), false); // <3-char guard: "mi" can't substring-hit
});

// ── A2 · Parallel Differential Coverage ──

const laneCase = (expectedLanes: Record<string, string[]>): DdxCase => ({
  id: 'D-LANE', category: 'red-flag',
  presentation: { complaint: 'acute painful red eye' },
  acceptableTopDx: ['acute angle closure glaucoma'],
  mandatoryCannotMiss: [], forbiddenDx: [], expectedLanes,
});

test('A2 lane coverage: covered iff ≥1 lane dx matches any engine axis', () => {
  const result: DdxResult = {
    most_likely: [{ diagnosis: 'Acute angle closure glaucoma' }],
    cannot_miss: [{ diagnosis: 'Orbital cellulitis' }],
    other: [],
  };
  const s = scoreDdxCase(
    laneCase({ ocular: ['acute angle closure glaucoma'], infectious: ['orbital cellulitis'], vascular: ['central retinal artery occlusion'] }),
    result,
  );
  assert.deepEqual(s.laneCoverage, { covered: 2, total: 3 }); // vascular uncovered
  assert.ok(s.notes.some((n) => n.includes('lanes uncovered: vascular')));
});

test('A2 lane coverage: null (skipped) when a case defines no expectedLanes', () => {
  const s = scoreDdxCase(CASE_CLEAN, RESULT_CLEAN);
  assert.equal(s.laneCoverage, null);
});

test('A2 laneCoverageRate: mean per-case rate over labelled cases only; null when none labelled', () => {
  const scores = [
    mkScore({ id: 'A', laneCoverage: { covered: 2, total: 4 } }), // 0.5
    mkScore({ id: 'B', laneCoverage: { covered: 3, total: 3 } }), // 1.0
    mkScore({ id: 'C' }),                                          // unlabelled → excluded
  ];
  assert.equal(summarizeDdx(scores).laneCoverageRate, 0.75);
  assert.equal(summarizeDdx([mkScore({ id: 'X' })]).laneCoverageRate, null);
});

// ── A3 · Negative-misuse + cannot-miss over-flag ──

test('A3 negative misuse: fires when a considered dx asserts a documented-negative finding', () => {
  const c: DdxCase = {
    id: 'D-NEG', category: 'common',
    presentation: { complaint: 'headache', exam: 'no fever, no neck stiffness' },
    acceptableTopDx: ['tension headache'], mandatoryCannotMiss: [], forbiddenDx: [],
    documentedNegatives: ['fever', 'neck stiffness'],
  };
  const withMisuse: DdxResult = {
    most_likely: [{ diagnosis: 'Meningitis', why_consider: 'headache with fever and photophobia' }],
    cannot_miss: [], other: [],
  };
  const s1 = scoreDdxCase(c, withMisuse);
  assert.equal(s1.negativeMisuse, true);
  assert.ok(s1.notes.some((n) => n.includes('negative-misuse')));

  const clean: DdxResult = { most_likely: [{ diagnosis: 'Tension headache', why_consider: 'band-like pain, no red flags' }], cannot_miss: [], other: [] };
  assert.equal(scoreDdxCase(c, clean).negativeMisuse, false);

  // no label → null (skipped)
  assert.equal(scoreDdxCase(CASE_CLEAN, RESULT_CLEAN).negativeMisuse, null);
});

test('A3 cannot-miss over-flag: fires when an unsupported cannot-miss dx is surfaced', () => {
  const c: DdxCase = {
    id: 'D-OVF', category: 'common',
    presentation: { complaint: 'mild ankle sprain' },
    acceptableTopDx: ['ankle sprain'], mandatoryCannotMiss: [], forbiddenDx: [],
    unsupportedCannotMiss: ['pulmonary embolism', 'compartment syndrome'],
  };
  const over: DdxResult = { cannot_miss: [{ diagnosis: 'Compartment syndrome' }], most_likely: [{ diagnosis: 'Ankle sprain' }], other: [] };
  const s = scoreDdxCase(c, over);
  assert.equal(s.cannotMissOverFlag, true);
  assert.ok(s.notes.some((n) => n.includes('over-flag')));

  const fine: DdxResult = { cannot_miss: [], most_likely: [{ diagnosis: 'Ankle sprain' }], other: [] };
  assert.equal(scoreDdxCase(c, fine).cannotMissOverFlag, false);
  assert.equal(scoreDdxCase(CASE_CLEAN, RESULT_CLEAN).cannotMissOverFlag, null);
});

test('A3 summary rates: denominated over labelled cases; null when none labelled', () => {
  const scores = [
    mkScore({ id: 'A', negativeMisuse: true, cannotMissOverFlag: false }),
    mkScore({ id: 'B', negativeMisuse: false, cannotMissOverFlag: true }),
    mkScore({ id: 'C' }), // both null → excluded from both denominators
  ];
  const sum = summarizeDdx(scores);
  assert.equal(sum.negativeMisuseRate, 0.5);
  assert.equal(sum.cannotMissOverFlagRate, 0.5);
  const none = summarizeDdx([mkScore({ id: 'A', top1Hit: true })]);
  assert.equal(none.negativeMisuseRate, null);
  assert.equal(none.cannotMissOverFlagRate, null);
});

// ── A4 · Latency P50/P90 ──

test('A4 latency: nearest-rank P50/P90 from supplied ms; null when none', () => {
  const latenciesMs = [1000, 100, 500, 900, 200, 800, 300, 700, 400, 600]; // unsorted, n=10
  const sum = summarizeDdx([mkScore({ id: 'A' })], { latenciesMs });
  assert.equal(sum.latencyP50Ms, 500); // ceil(0.5*10)-1 = idx 4 of sorted → 500
  assert.equal(sum.latencyP90Ms, 900); // ceil(0.9*10)-1 = idx 8 of sorted → 900
  const noLat = summarizeDdx([mkScore({ id: 'A' })]);
  assert.equal(noLat.latencyP50Ms, null);
  assert.equal(noLat.latencyP90Ms, null);
});

// ── A6 · Version pinning + freeze guard ──

test('A6 version stamping: summary carries matcher + bank versions', () => {
  const sum = summarizeDdx([mkScore({ id: 'A' })], { bankVersion: 'ddx-case-bank/0.2' });
  assert.equal(sum.matcherVersion, 'ddx-eval/3');
  assert.equal(sum.bankVersion, 'ddx-case-bank/0.2');
  assert.equal(summarizeDdx([mkScore({ id: 'A' })]).bankVersion, 'unknown');
});

test('A6 freeze guard: dormant passes; active passes on match, fails on mismatch', () => {
  const sum = summarizeDdx([mkScore({ id: 'A' })], { bankVersion: 'ddx-case-bank/1.0' });
  assert.equal(freezeGuard(sum, { frozen: false }).ok, true); // dormant
  assert.equal(freezeGuard(sum, { frozen: true, matcher: 'ddx-eval/3', bank: 'ddx-case-bank/1.0' }).ok, true);
  const bad = freezeGuard(sum, { frozen: true, matcher: 'ddx-eval/3', bank: 'ddx-case-bank/0.9' });
  assert.equal(bad.ok, false);
  assert.ok(bad.message.includes('FROZEN-MISMATCH'));
  const badMatcher = freezeGuard(sum, { frozen: true, matcher: 'ddx-eval/1' });
  assert.equal(badMatcher.ok, false);
});

// ── A5 · Offline re-score ──

test('A5 scoreFromResultsJson: re-scores a saved results file with no network', () => {
  const bank: DdxCase[] = [CASE_CLEAN, CASE_DIRTY];
  const dir = mkdtempSync(join(tmpdir(), 'ddx-rescore-'));
  const path = join(dir, 'results.json');
  writeFileSync(path, JSON.stringify({
    meta: { base: 'offline' },
    rows: [
      { id: CASE_CLEAN.id, category: 'atypical', result: RESULT_CLEAN, ms: 120000 },
      { id: CASE_DIRTY.id, category: 'red-flag', result: RESULT_DIRTY, ms: 80000 },
      { id: 'D-UNKNOWN', category: 'common', result: RESULT_CLEAN, ms: 90000 }, // no bank case
      { id: 'D-ERR', category: 'common', error: 'HTTP 500' },                    // errored row
    ],
  }));

  const { summary, scores, unmatchedIds, erroredIds } = scoreFromResultsJson(path, { cases: bank, meta: { id: 'ddx-case-bank/0.2' } });
  assert.equal(scores.length, 2);
  assert.deepEqual(unmatchedIds, ['D-UNKNOWN']);
  assert.deepEqual(erroredIds, ['D-ERR']);
  assert.equal(summary.n, 2);
  assert.equal(summary.top1Accuracy, 0.5);          // clean hits, dirty misses
  assert.equal(summary.cannotMissRecall, 0.5);      // clean covered, dirty missed
  assert.equal(summary.bankVersion, 'ddx-case-bank/0.2'); // derived from wrapper meta
  assert.equal(summary.matcherVersion, 'ddx-eval/3');
  assert.equal(summary.latencyP50Ms, 80000);        // nearest-rank P50 of [80000,120000]
});

// ══════════════════════════════════════════════════════════════════════════════════════
//  Phase 2a FREEZE — frozen pair pins + collision guard over the committed v1.0 bank
// ══════════════════════════════════════════════════════════════════════════════════════

const BANK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/ddx-case-bank.json');
const loadBank = (): { meta?: { id?: string }; cases: DdxCase[] } => {
  const raw = JSON.parse(readFileSync(BANK_PATH, 'utf8'));
  return Array.isArray(raw) ? { cases: raw } : raw;
};

test('FREEZE: pinned pair is ddx-eval/3 + ddx-case-bank/1.0 and matches the committed bank', () => {
  assert.equal(FROZEN_MATCHER, 'ddx-eval/3');
  assert.equal(FROZEN_MATCHER, MATCHER_VERSION);   // matcher pin tracks the live matcher version
  assert.equal(FROZEN_BANK, 'ddx-case-bank/1.0');
  assert.equal(loadBank().meta?.id, FROZEN_BANK);  // the tracked bank IS the frozen bank
});

// F3 · Collision guard. Within a single case, mandatoryCannotMiss is a CONJUNCTION — each
// dx must be independently covered — so no two of a case's cannot-miss diagnoses may match
// each other (via matchDx + that case's synonyms, either direction). A collision means one
// engine dx would falsely credit two required dx (e.g. the pre-freeze 'CES' ⊂ 'abscess' in
// D11). Fails loudly listing every offending pair; does NOT auto-resolve.
test('F3 collision guard: no two cannot-miss dx in any case collapse under matcher + synonyms', () => {
  const { cases } = loadBank();
  const collisions: string[] = [];
  for (const c of cases) {
    const cm = c.mandatoryCannotMiss ?? [];
    const syn = c.synonyms ?? {};
    for (let i = 0; i < cm.length; i++) {
      for (let j = i + 1; j < cm.length; j++) {
        if (matchDx(cm[j], cm[i], syn[cm[i]]) || matchDx(cm[i], cm[j], syn[cm[j]])) {
          collisions.push(`${c.id}: "${cm[i]}" <=> "${cm[j]}"`);
        }
      }
    }
  }
  assert.deepEqual(collisions, [], `cannot-miss collisions found:\n  ${collisions.join('\n  ')}`);
});

// ── Regression: existing 7 metrics unchanged in value on an unchanged input ──

test('existing 7 summary metrics are byte-identical on an unchanged score set', () => {
  const scores: DdxCaseScore[] = [
    mkScore({ id: 'A', top1Hit: true, top3Hit: true, cannotMissCovered: true }),
    mkScore({ id: 'B', top3Hit: true, cannotMissCovered: false, forbiddenPresent: true }),
    mkScore({ id: 'C', fabricatedFindingSuspected: true, unsafeActionPresent: true }),
    mkScore({ id: 'D', top1Hit: true, top3Hit: true }),
  ];
  const sum = summarizeDdx(scores);
  assert.equal(sum.top1Accuracy, 0.5);
  assert.equal(sum.top3Recall, 0.75);
  assert.equal(sum.cannotMissRecall, 0.5);
  assert.equal(sum.forbiddenDxRate, 0.25);
  assert.equal(sum.unsafeActionRate, 0.25);
  assert.equal(sum.fabricatedFindingRate, 0.25);
  assert.equal(sum.harmWeightedError, 46 / 4);
});
