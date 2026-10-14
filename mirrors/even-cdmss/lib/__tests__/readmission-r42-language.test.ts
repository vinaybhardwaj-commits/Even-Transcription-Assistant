/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r42-language.test.ts
 * R4.2 (CDMSS-READMISSIONS-R4.2-PRD v1.0) — the surface speaks plain clinical English: the pure
 * label / date-fallback helpers (every enum value + junk → raw string, never a crash, never a dash) ·
 * the ledger legend + rendering pins · the case-line skip on the literal 18-Aug example · the brief's
 * vocabulary · the narrative-prompt rule (recon fingerprints unchanged, narrative fingerprint changed) ·
 * chips keep their short labels.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ledgerSourceLabel, ledgerSideLabel, ledgerWeightLabel, ledgerDateLabel, LEDGER_LEGEND, artefactLabel, artefactStateWord,
  caseLine, narrativeSentences, opensWithDetectionVocabulary, coverageChips, chipText, type SurfaceFinding,
} from '../readmission-surface-core.ts';
import { buildFullReconPrompt, buildSecondAvoidablePrompt, buildConditionPassPrompt, buildOonPrompt, buildNarrativePrompt } from '../readmission-prompts.ts';
import { reconPromptFingerprints } from '../readmission-refresh-core.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const row = { indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-05T09:30:00+05:30' };

// ── R42-1/2/3: words for every enum value; junk → raw string ────────────────────────────

test('ledgerSourceLabel: every source in words; labs told apart by id prefix; junk / null → raw string or "unknown source", never a throw', () => {
  assert.equal(ledgerSourceLabel('index_summary', 'S1'), 'Discharge summary — first stay');
  assert.equal(ledgerSourceLabel('readmit_summary', 'R1'), 'Discharge summary — return stay');
  assert.equal(ledgerSourceLabel('lab', 'L1'), 'Lab result');
  assert.equal(ledgerSourceLabel('lab', 'LX2'), 'Lab result');
  assert.equal(ledgerSourceLabel('lab', 'M3'), 'Lab result');
  assert.equal(ledgerSourceLabel('lab', 'IX1'), 'Lab value from discharge summary');
  assert.equal(ledgerSourceLabel('lab', 'RX4'), 'Lab value from discharge summary');
  assert.equal(ledgerSourceLabel('lab'), 'Lab result');
  assert.equal(ledgerSourceLabel('ot_note', 'OT1'), 'Operative note');
  assert.equal(ledgerSourceLabel('pac_note', 'PAC1'), 'Pre-anaesthesia check');
  assert.equal(ledgerSourceLabel('progress_note', 'P1'), 'Ward progress note');
  assert.equal(ledgerSourceLabel('cm_form', 'F1'), 'Care-manager follow-up form');
  assert.equal(ledgerSourceLabel('adt', 'T1'), 'Admission record');
  assert.equal(ledgerSourceLabel('nursing_note', 'N1'), 'nursing_note');
  assert.equal(ledgerSourceLabel(null), 'unknown source'); assert.equal(ledgerSourceLabel(undefined), 'unknown source'); assert.equal(ledgerSourceLabel(''), 'unknown source');
});

test('ledgerSideLabel / ledgerWeightLabel: words for every value; junk → raw; null → both stays / unweighted', () => {
  assert.equal(ledgerSideLabel('index'), 'first stay'); assert.equal(ledgerSideLabel('readmit'), 'return stay');
  assert.equal(ledgerSideLabel(null), 'both stays'); assert.equal(ledgerSideLabel(undefined), 'both stays'); assert.equal(ledgerSideLabel('elsewhere'), 'elsewhere');
  assert.equal(ledgerWeightLabel('interested'), "treating team's own account");
  assert.equal(ledgerWeightLabel('disinterested'), 'independent record');
  assert.equal(ledgerWeightLabel('neither'), 'patient-reported account');
  assert.equal(ledgerWeightLabel('odd'), 'odd'); assert.equal(ledgerWeightLabel(null), 'unweighted'); assert.equal(ledgerWeightLabel(''), 'unweighted');
  assert.equal(LEDGER_LEGEND, "The audit weighs evidence by who wrote it: the treating team describing its own care is one account; labs and the other admission's team are independent of it.");
});

// ── R42-4: dates never dash ─────────────────────────────────────────────────────────────

test('ledgerDateLabel: the item timestamp when present; else the stay fallback; null side placed by what it is; missing stay date → words; NEVER a dash', () => {
  assert.equal(ledgerDateLabel({ at: '2026-06-03T08:00:00Z', side: 'index', source: 'lab' }, row), '3 Jun 2026');
  assert.equal(ledgerDateLabel({ at: '2026-06-01 09:15:00', side: 'index', source: 'ot_note' }, row), '1 Jun 2026');
  assert.equal(ledgerDateLabel({ at: null, side: 'index', source: 'index_summary' }, row), 'first stay · discharged 1 Jun 2026');
  assert.equal(ledgerDateLabel({ at: null, side: 'readmit', source: 'readmit_summary' }, row), 'return stay · admitted 5 Jun 2026');
  assert.equal(ledgerDateLabel({ at: 'not a date', side: 'readmit', source: 'lab' }, row), 'return stay · admitted 5 Jun 2026');
  assert.equal(ledgerDateLabel({ at: null, side: null, source: 'adt', text: 'index stay: department Orthopaedics, discharged 2026-06-01' }, row), 'first stay · discharged 1 Jun 2026');
  assert.equal(ledgerDateLabel({ at: null, side: null, source: 'adt', text: 'readmit stay: department Orthopaedics, admitted 2026-06-05, gap 4 days' }, row), 'return stay · admitted 5 Jun 2026');
  assert.equal(ledgerDateLabel({ at: null, side: null, source: 'adt', text: 'readmission reported at ANOTHER hospital around 2026-06-05 (patient-reported)' }, row), 'return stay · admitted 5 Jun 2026');
  assert.equal(ledgerDateLabel({ at: null, side: null, source: 'cm_form', text: 'Patient called on day 3' }, row), 'return stay · admitted 5 Jun 2026');
  assert.equal(ledgerDateLabel({ at: null, side: 'index', source: 'index_summary' }, { indexDischargeAt: null, readmitAdmitAt: null }), 'first stay · date not recorded');
  assert.equal(ledgerDateLabel({ at: null, side: 'readmit', source: 'readmit_summary' }, { indexDischargeAt: null, readmitAdmitAt: 'garbage' }), 'return stay · date not recorded');
  // a dash is a test failure — sweep every combination
  for (const at of [null, undefined, '', 'junk', '2026-06-03T08:00:00Z']) for (const side of ['index', 'readmit', null, 'odd']) for (const source of ['lab', 'adt', 'cm_form', 'ot_note', 'index_summary', 'zzz']) {
    for (const r of [row, { indexDischargeAt: null, readmitAdmitAt: null }]) {
      const out = ledgerDateLabel({ at, side, source, text: 'x' }, r);
      assert.ok(out && !/^—$|—$|^-$/.test(out) && out !== '', `no dash for at=${at} side=${side} source=${source}`);
    }
  }
});

// ── the ledger rendering + the card chips ────────────────────────────────────────────────

test('the case page renders every ledger column through the word helpers with the legend above; no enum and no dash left in the row markup', () => {
  const page = code('components/care/ReadmissionCasePage.tsx');
  assert.match(page, /\{LEDGER_LEGEND\}/);
  assert.match(page, /ledgerSourceLabel\(it\.source, it\.id\)/); assert.match(page, /ledgerSideLabel\(it\.side\)/);
  assert.match(page, /ledgerWeightLabel\(it\.weight\)/); assert.match(page, /ledgerDateLabel\(it, row\)/);
  assert.ok(!/it\.side \?\? '—'|it\.at \? it\.at\.slice\(0, 10\) : '—'|SOURCE_WORD\[/.test(page), 'the old enum / dash cells are gone');
  assert.ok(!/'Index DS'|'Readmit DS'/.test(page), 'no short chip labels inside the ledger');
});

test('the card chips keep their short ratified labels and copy (not reopened)', () => {
  const f = { findingClass: 'even_even', cmNote: null, finding: null, indexCase: null, returnBill: { state: 'not_finalised', netRs: null, lines: null } } as unknown as SurfaceFinding;
  assert.deepEqual(coverageChips(f).map((c) => c.label), ['Index DS', 'Readmit DS', 'Labs', 'OT', 'PAC', 'Progress', 'POST_IPD', 'Bill']);
  assert.equal(chipText({ key: 'bill', label: 'Bill', state: 'absent' }), 'Bill pending');
  assert.equal(chipText({ key: 'ot', label: 'OT', state: 'absent' }), 'OT none');
});

// ── R42-5: the case line skips flag-language openings ────────────────────────────────────

test('caseLine skips a flag-language opening — the literal 18-Aug stored example — and takes the first following sentence that does not open with detection vocabulary', () => {
  const live = 'This case was flagged as an even_even finding in the other lane because a 64-year-old female was discharged from Neurology and readmitted to Internal Medicine 21 days later, with a different treating doctor [T1, T2]. The readmission was classified as unplanned, for the same underlying condition, and the audit verdict is that the case needs adjudication regarding medical justification.\n\nDuring the index Neurology stay, the patient presented with recurrent brief episodes of giddiness and right-sided upper and lower limb numbness and tingling, each lasting 1–2 minutes [S2, S6].';
  // the picked sentence is 172 chars, so the ~160-char word-boundary cap applies on top of the skip
  assert.equal(caseLine({ text: live, valid: true }), 'The readmission was classified as unplanned, for the same underlying condition, and the audit verdict is that the case needs adjudication regarding medical…');
  assert.equal(caseLine({ text: live, valid: true }, 400), 'The readmission was classified as unplanned, for the same underlying condition, and the audit verdict is that the case needs adjudication regarding medical justification.');
  const other = 'This case was flagged as a structural 30-day readmission: the patient was discharged from General Surgery on 2025-09-17 and readmitted on 2025-09-25 [T1]. She was admitted with a discharging wound [R1].';
  assert.equal(caseLine({ text: other, valid: true }), 'She was admitted with a discharging wound.');
  // several flagged sentences in a row → the first clean one
  assert.equal(caseLine({ text: 'This case was flagged in the tight_bounce lane [T1]. The detection lane was tight_bounce [T1]. He returned febrile [R1].', valid: true }), 'He returned febrile.');
  // nothing qualifies → fallback to the first sentence
  assert.equal(caseLine({ text: 'This case was flagged as even_even [T1]. It sits in the other lane [T2].', valid: true }), 'This case was flagged as even_even.');
  // a clean opening is untouched
  assert.equal(caseLine({ text: 'A 64-year-old woman returned to Internal Medicine 21 days after a Neurology discharge [T1, T2]. Then more.', valid: true }), 'A 64-year-old woman returned to Internal Medicine 21 days after a Neurology discharge.');
  assert.deepEqual(narrativeSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
  assert.equal(opensWithDetectionVocabulary('Readmitted to the same lane of the ward'), true);   // the phrase "lane" is detection vocabulary on this surface
  assert.equal(opensWithDetectionVocabulary('The lanyard was blue'), false);                        // word boundary
});

// ── R42-7: the brief; R42-6: the prompt; fingerprints ────────────────────────────────────

test('brief: source tags and artefact rows in the same vocabulary; artefactLabel / artefactStateWord cover every key and state', () => {
  const brief = code('lib/readmission/brief.ts');
  assert.match(brief, /const T_INDEX = '\[discharge summary — first stay\]';/);
  assert.match(brief, /const T_READMIT = '\[discharge summary — return stay\]';/);
  assert.match(brief, /const T_FORM = '\[care-manager follow-up form, patient-reported\]';/);
  assert.match(brief, /artefactLabel\(c\.key\)/); assert.match(brief, /artefactStateWord\(c\)/);
  assert.ok(!/POST_IPD form held|index DS, extracted|readmit DS, extracted/.test(brief));
  for (const [k, w] of [['index_ds', 'Discharge summary — first stay'], ['readmit_ds', 'Discharge summary — return stay'], ['labs', 'Lab results'], ['ot', 'Operative notes'], ['pac', 'Pre-anaesthesia check'], ['progress', 'Ward progress notes'], ['post_ipd', 'Care-manager follow-up form'], ['bill', 'Hospital bill'], ['zzz', 'zzz']] as const) assert.equal(artefactLabel(k), w);
  assert.equal(artefactStateWord({ key: 'ot', state: 'present' }), 'present');
  assert.equal(artefactStateWord({ key: 'ot', state: 'empty' }), 'empty — rows exist, no usable text');
  assert.equal(artefactStateWord({ key: 'ot', state: 'absent' }), 'none');
  assert.equal(artefactStateWord({ key: 'bill', state: 'absent' }), 'pending — bill not finalised');
  assert.equal(artefactStateWord({ key: 'ot', state: 'unknown' }), 'unknown — not looked for, or the look failed');
  assert.equal(artefactStateWord({ key: 'ot', state: 'n/a' }), 'n/a');
});

test('R42-6: the narrative builder carries the plain-language rule; the four recon builders are byte-identical (fingerprints unchanged); the narrative component of the refresh fingerprint changed', () => {
  const cat = { items: [
    { id: 'S1', source: 'index_summary' as const, side: 'index' as const, text: 'diagnosis: fracture neck of femur' },
    { id: 'L1', source: 'lab' as const, side: 'index' as const, text: 'Hb: 9.1 g/dL', abnormal: true, at: '2026-06-01' },
    { id: 'OT1', source: 'ot_note' as const, side: 'index' as const, text: 'OT note' },
  ] };
  const h = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
  assert.equal(h(buildFullReconPrompt(cat, { gapDays: 4, lane: 'tight_bounce', indexDepartment: 'Ortho', readmitDepartment: 'Ortho', sameDoctor: true, labProfile: 'has_late_labs' })), 'a65be27800b26f0e');
  assert.equal(h(buildSecondAvoidablePrompt(cat, { gapDays: 4, labProfile: 'has_late_labs' })), '3e11e8555c9ac2d6');
  assert.equal(h(buildConditionPassPrompt(cat, { gapDays: 4 })), '6a9f30d7f6926f5e');
  assert.equal(h(buildOonPrompt(cat, { reportedReadmitDate: '2026-06-05', labProfile: 'has_late_labs' })), 'a1513639455807b3');
  const p = buildNarrativePrompt(cat, { findingClass: 'even_even', lane: 'tight_bounce', gapDays: 4, indexDepartment: 'Ortho', readmitDepartment: 'Ortho', planned: 'unplanned', sameCondition: 'same', avoidable: null, omissions: [], exculpatory: [], weakestStep: null, refusalRecord: [] }, { audited: 0, totalNotes: 0, candidates: [], joinFailed: false });
  assert.match(p.user, /LANGUAGE \(plain clinical English\)/);
  assert.match(p.user, /Never use internal system vocabulary — no lane names/);
  assert.match(p.user, /Open with the CLINICAL story/);
  // the refresh fingerprint: recon components as before, narrative component moved (the recorded probe auto-invalidates by design)
  const fp = reconPromptFingerprints().split('.');
  assert.deepEqual(fp.slice(0, 4), ['59fe9addffa993dc', '22170f09ffd188c1', '88b7fc2dd3d06b4b', '8eb4054a9a6810f9']);
  assert.notEqual(fp[4], 'd5c590afec772ac4');
  assert.equal(fp[4], 'dad75db58c605cb4');
});
