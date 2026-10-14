// Inquiry K1 — inquiry-core (PRD §15): candidate mapping per kind (incl. unmappable → dropped);
// validation rejects foreign ids / rewritten family/subject / over-length / generic; high-alert-
// always-first guarantee; cap 5; fallback on zero valid picks; ask-set/0.1 byte-identity of the
// fallback output vs buildAskSet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesFromUnknowns, droppedUnknowns, validateSelection, parseSelection,
  assembleInquiryAskSet, fallbackAskSet, runInquirySelection, questionMentionsSubject,
  priorityRank, INQUIRY_VERSION, INQUIRY_ASK_SET_VERSION, INQUIRY_SELECT_SYSTEM,
  type CandidateAsk, type SelectionPick,
} from '../inquiry/inquiry-core';
import { buildAskSet, ASK_SET_VERSION } from '../care-call-core';
import { deriveUnknowns, type UnknownItem } from '../inquiry/unknowns-core';
import type { DeidOpdCase } from '../opd-ingest-core';

const KEYS = { presc_uid: 'presc123', individual_uid: 'indiv123', uhid: null, note_date: '2026-07-09' };

function mkCase(over: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [], impressionCodes: [],
    impressions: [], history: [], comorbidities: [], medications: [], investigations: [], advice: [], examination: [],
    allergies: 'nil', followUpType: null, followUpDateSet: false, ...over,
  };
}

/** 1-based candidate number for an id — picks are NUMBER-based since B6. */
const nOf = (cands: CandidateAsk[], id: string): number => {
  const i = cands.findIndex((c) => c.id === id);
  assert.ok(i >= 0, `candidate ${id} present`);
  return i + 1;
};

const unk = (o: Partial<UnknownItem> & { kind: UnknownItem['kind']; subject: string }): UnknownItem => ({
  id: `unk-${o.kind}:${o.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  detail: o.detail ?? `${o.subject} detail`, criticality: o.criticality ?? 'review',
  sourceRefs: o.sourceRefs ?? ['src-1'],
  stateRef: o.stateRef ?? { kind: 'member', version: 'member-state/1.1', computedAt: null },
  ...o,
});

test('version constants match the PRD exactly', () => {
  assert.equal(INQUIRY_VERSION, 'inquiry/0.1');
  assert.equal(INQUIRY_ASK_SET_VERSION, 'ask-set/0.2');
  assert.equal(ASK_SET_VERSION, 'ask-set/0.1');
  assert.ok(INQUIRY_SELECT_SYSTEM.length > 100);
});

test('candidate mapping per kind (PRD §5 table) — family and skeleton per kind', () => {
  const episode = mkCase();
  const unknowns: UnknownItem[] = [
    unk({ kind: 'med_contradiction', subject: 'Atorvastatin' }),
    unk({ kind: 'unknown_finding', subject: 'chest pain' }),
    unk({ kind: 'missing_critical', subject: 'smoking status' }),
    unk({ kind: 'care_gap', subject: 'Vitamin D', detail: 'severely abnormal (8) ng/ml — not rechecked in 1.1y' }),
    unk({ kind: 'followup_open', subject: 'Repeat HbA1c after 3 months' }),
    unk({ kind: 'allergy_unconfirmed', subject: 'allergies' }),
  ];
  const cands = candidatesFromUnknowns(unknowns, episode, KEYS);
  const byFam = (f: string, re: RegExp) => cands.find((c) => c.family === f && re.test(c.question));
  assert.ok(byFam('MED_STATUS', /stopped Atorvastatin — how is it now/), 'med_contradiction → MED_STATUS skeleton');
  assert.ok(byFam('COMPLAINT_STATUS', /How is chest pain now\?/), 'unknown_finding → COMPLAINT_STATUS');
  assert.ok(byFam('COMPLAINT_STATUS', /How is smoking status now\?/), 'missing_critical → COMPLAINT_STATUS');
  assert.ok(byFam('FOLLOWUP_ACTION', /Vitamin D was .*book a repeat test/), 'care_gap → FOLLOWUP_ACTION');
  assert.ok(byFam('FOLLOWUP_ACTION', /Doctor advised Repeat HbA1c/), 'followup_open → FOLLOWUP_ACTION (ask-set/0.1 phrasing)');
  assert.ok(byFam('ALLERGY_CONFIRM', /medicine allergies/), 'allergy_unconfirmed → ALLERGY_CONFIRM');
  for (const c of cands) assert.match(c.id, /^(MED_STATUS|FOLLOWUP_ACTION|COMPLAINT_STATUS|ALLERGY_CONFIRM|OUTSIDE_RECORDS):/, 'deterministic family:slug id');
});

test('baseline buildAskSet asks are also candidates (why baseline, unknownIds [])', () => {
  const episode = mkCase({ medications: [{ generic: 'Metformin' }], presentingComplaints: ['cough'] });
  const cands = candidatesFromUnknowns([], episode, KEYS);
  const base = buildAskSet(episode, KEYS);
  for (const a of base.asks) {
    const c = cands.find((x) => x.id === a.id)!;
    assert.ok(c, `baseline candidate ${a.id}`);
    assert.equal(c.why, 'baseline');
    assert.deepEqual(c.unknownIds, []);
  }
});

test('instability_input / unmappable unknowns produce no candidate and land in dropped', () => {
  const unknowns = [unk({ kind: 'instability_input', subject: 'BP' })];
  const cands = candidatesFromUnknowns(unknowns, mkCase(), KEYS);
  assert.equal(cands.some((c) => c.subject === 'BP'), false);
  const dropped = droppedUnknowns(unknowns, cands);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].kind, 'instability_input');
});

test('same-id candidates merge (allergy unknown merges into the baseline allergy ask)', () => {
  const episode = mkCase({ allergies: null });
  const u = unk({ kind: 'allergy_unconfirmed', subject: 'allergies' });
  const cands = candidatesFromUnknowns([u], episode, KEYS);
  const allergy = cands.filter((c) => c.family === 'ALLERGY_CONFIRM');
  assert.equal(allergy.length, 1, 'no duplicate ALLERGY_CONFIRM candidate');
  assert.deepEqual(allergy[0].unknownIds, [u.id]);
});

test('validateSelection (B6 numbers, B7 phrase-all): out-of-range / non-integer n rejected; duplicate rejected; NO pick cap', () => {
  const cands = candidatesFromUnknowns([unk({ kind: 'unknown_finding', subject: 'knee pain' })], mkCase(), KEYS);
  const id = 'COMPLAINT_STATUS:knee-pain';
  const n = nOf(cands, id);
  const picks: SelectionPick[] = [
    { n: 0, question: 'Zero is out of range (1-based)?' },
    { n: 99, question: 'Ninety-nine is out of range?' },
    { n: 1.5, question: 'A fractional number is rejected?' },
    { n, question: 'How is the knee pain today?' },
    { n, question: 'Duplicate — how is the knee pain?' },
  ];
  const valid = validateSelection(picks, cands);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].ask.id, id, 'n resolves to the candidate at position n-1');
  // B7: the ≤3 pick cap is GONE — every distinct valid phrasing is kept (dedupe still holds)
  const many: SelectionPick[] = cands.map((c, i) => ({ n: i + 1, question: c.question }));
  assert.equal(validateSelection(many.concat(many), cands).length, cands.length, 'phrase-all: one phrasing per candidate, duplicates still deduped');
  // literal position check: n is 1-based, so n=2 resolves to candidates[1]
  const v2 = validateSelection([{ n: 2, question: cands[1].question }], cands);
  assert.equal(v2.length, 1);
  assert.equal(v2[0].ask.id, cands[1].id, 'n=2 → candidates[1]');
});

test('validateSelection: rewritten family/subject never survive — candidate fields win', () => {
  const u = unk({ kind: 'med_contradiction', subject: 'Atorvastatin' });
  const cands = candidatesFromUnknowns([u], mkCase(), KEYS);
  const c = cands.find((x) => x.family === 'MED_STATUS')!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evil: any = { n: nOf(cands, c.id), family: 'OUTSIDE_RECORDS', subject: 'something else', question: 'Are you still taking Atorvastatin these days?' };
  const valid = validateSelection([evil], cands);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].ask.family, 'MED_STATUS');
  assert.equal(valid[0].ask.subject, 'Atorvastatin');
});

test('validateSelection: over-length and empty questions are rejected', () => {
  const cands = candidatesFromUnknowns([unk({ kind: 'unknown_finding', subject: 'back pain' })], mkCase(), KEYS);
  const n = nOf(cands, 'COMPLAINT_STATUS:back-pain');
  assert.equal(validateSelection([{ n, question: 'x'.repeat(161) }], cands).length, 0);
  assert.equal(validateSelection([{ n, question: '   ' }], cands).length, 0);
  assert.equal(validateSelection([{ n, question: 'How is your back pain now?' }], cands).length, 1);
});

test('validateSelection: a generic question (no subject token) is replaced by the candidate skeleton', () => {
  const cands = candidatesFromUnknowns([unk({ kind: 'unknown_finding', subject: 'migraine headaches' })], mkCase(), KEYS);
  const valid = validateSelection([{ n: nOf(cands, 'COMPLAINT_STATUS:migraine-headaches'), question: 'And how are you feeling overall?' }], cands);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].ask.question, 'How is migraine headaches now?');   // skeleton restored
  assert.equal(questionMentionsSubject('migraine headaches', 'And how are you feeling overall?'), false);
});

test('assembly: every high-alert MED_STATUS ask is ALWAYS first (ladder rank 0), regardless of picks', () => {
  const episode = mkCase({
    medications: [{ generic: 'Insulin glargine', highAlert: true }, { generic: 'Telmisartan' }],
    presentingComplaints: ['dizziness'],
  });
  const u = unk({ kind: 'unknown_finding', subject: 'blurred vision' });
  const cands = candidatesFromUnknowns([u], episode, KEYS);
  const pick = validateSelection([{ n: nOf(cands, 'COMPLAINT_STATUS:blurred-vision'), question: 'Any blurred vision since the visit?' }], cands);
  const out = assembleInquiryAskSet(episode, KEYS, cands, pick);
  assert.equal(out.source, 'inquiry');
  assert.equal(out.ask_set_version, 'ask-set/0.2');
  assert.equal(out.asks[0].family, 'MED_STATUS');
  assert.equal(out.asks[0].meta?.highAlert, true);
  // K2: the LADDER owns order — the routine med (rank 5) precedes the complaints (rank 6);
  // the Gemini pick keeps its PHRASING but does not jump the queue.
  assert.equal(out.asks[1].id, 'MED_STATUS:telmisartan');
  const picked = out.asks.find((a) => a.id === 'COMPLAINT_STATUS:blurred-vision')!;
  assert.ok(picked, 'ladder-served pick present');
  assert.equal(picked.question, 'Any blurred vision since the visit?', 'Gemini phrasing used');
});

test('K2 ladder (B5 ranks): rungs serve in order 0<1<3<4<5<6<7<8 regardless of the pick order fed in', () => {
  const episode = mkCase({
    medications: [{ generic: 'Insulin glargine', highAlert: true }, { generic: 'Amlodipine' }],
    presentingComplaints: ['dizziness'],
    allergies: null,
    advice: ['Review in 2 weeks'],
  });
  const unknowns = [
    unk({ kind: 'med_contradiction', subject: 'Atorvastatin' }),
    unk({ kind: 'care_gap', subject: 'Vitamin D', detail: 'severely abnormal (8) ng/ml — not rechecked in 1.1y' }),
  ];
  const cands = candidatesFromUnknowns(unknowns, episode, KEYS);
  assert.equal(priorityRank(cands.find((c) => c.id === 'MED_STATUS:insulin-glargine')!), 0);
  assert.equal(priorityRank(cands.find((c) => c.id === 'MED_STATUS:atorvastatin')!), 1);
  assert.equal(priorityRank(cands.find((c) => c.id === 'FOLLOWUP_ACTION:vitamin-d')!), 3);
  assert.equal(priorityRank(cands.find((c) => c.family === 'FOLLOWUP_ACTION' && /Review in 2 weeks/.test(c.subject))!), 4);
  assert.equal(priorityRank(cands.find((c) => c.id === 'MED_STATUS:amlodipine')!), 5);
  assert.equal(priorityRank(cands.find((c) => c.family === 'COMPLAINT_STATUS')!), 6);
  assert.equal(priorityRank(cands.find((c) => c.family === 'ALLERGY_CONFIRM')!), 7);
  // OUTSIDE_RECORDS fell off buildAskSet's cap in this fixture — rank asserted on a literal
  assert.equal(priorityRank({ id: 'OUTSIDE_RECORDS:x', family: 'OUTSIDE_RECORDS', subject: '', question: 'q', unknownIds: [], why: 'baseline', sourceKinds: [] }), 8);
  // feed picks in REVERSED priority order — served order must still be the ladder's
  const picks = validateSelection([
    { n: nOf(cands, 'COMPLAINT_STATUS:dizziness'), question: 'How is the dizziness now?' },
    { n: nOf(cands, 'FOLLOWUP_ACTION:vitamin-d'), question: 'Your Vitamin D was very low — book a repeat test?' },
    { n: nOf(cands, 'MED_STATUS:atorvastatin'), question: 'You had stopped Atorvastatin — taking it now?' },
  ], cands);
  const out = assembleInquiryAskSet(episode, KEYS, cands, picks);
  assert.deepEqual(out.asks.map((a) => a.id), [
    'MED_STATUS:insulin-glargine',       // 0 high-alert
    'MED_STATUS:atorvastatin',           // 1 contradiction
    'FOLLOWUP_ACTION:vitamin-d',         // 3 care-gap follow-up
    cands.find((c) => priorityRank(c) === 4)!.id,   // 4 routine follow-up
    'MED_STATUS:amlodipine',             // 5 routine med
  ]);
  // a low-ranked Gemini pick (the complaint) did NOT become slot-1 — and fell off the top 5
  assert.ok(out.overflow.some((o) => o.family === 'COMPLAINT_STATUS' && o.subject === 'dizziness'));
});

test('B5 new-med rung: a med absent from a NON-EMPTY snapshot ranks 2 and leads over a care-gap; empty/absent snapshot stays routine 5', () => {
  const NOW = '2026-07-15T00:00:00.000Z';
  const episode = mkCase({
    medications: [
      { generic: 'Dapagliflozin', brand: 'Forxiga', strength: '10mg' },   // just started — NOT in prior records
      { generic: 'Metformin', brand: 'Glycomet', strength: '500mg' },     // long-standing — in prior records
    ],
  });
  const snapshot = {
    version: 'member-state/1.1', computedAt: NOW, asOf: '2026-07-01', sourceWatermarks: {},
    problems: [], allergies: [], conflicts: [], followUps: [], sourceEncounterRefs: [],
    medications: [{
      normalizedConcept: { raw: 'Metformin', relation: 'exact', normalizerVersion: 'member-normalize/0.2' },
      status: 'prescribed', firstSeen: '2026-01-01', lastSeen: '2026-06-15', occurrences: [],
    }],
    investigations: [{
      normalizedAnalyte: { raw: 'HbA1c', relation: 'exact', normalizerVersion: 'member-normalize/0.2' },
      unit: '%',
      series: [{ encounterRef: 'lab1', date: '2025-10-01', value: '9.1', unit: '%', abnormal: 'HIGH', provenance: { sourceField: 'x', rawText: 'x', extractionMethod: 'deterministic', confidence: 1 } }],
    }],
  };
  const unknowns = deriveUnknowns({ episode, snapshot: snapshot as never, now: NOW });
  const cands = candidatesFromUnknowns(unknowns, episode, KEYS);
  // the new_medication unknown MERGED into the baseline med candidate (same deterministic id)
  const dapa = cands.find((c) => c.id === 'MED_STATUS:dapagliflozin-forxiga-10mg')!;
  assert.ok(dapa, 'merged candidate exists under the buildAskSet med-label id');
  assert.ok(dapa.sourceKinds?.includes('new_medication'), 'baseline candidate gained the new_medication kind');
  assert.equal(priorityRank(dapa), 2, 'newly-started med is rank 2');
  const metf = cands.find((c) => c.id === 'MED_STATUS:metformin-glycomet-500mg')!;
  assert.equal(priorityRank(metf), 5, 'a med present in prior records stays routine');
  const gap = cands.find((c) => c.family === 'FOLLOWUP_ACTION' && c.sourceKinds?.includes('care_gap'))!;
  assert.ok(gap, 'stale abnormal HbA1c derives a care-gap follow-up');
  assert.equal(priorityRank(gap), 3);
  // assembled: new med leads, the care-gap keeps slot 2 (the B2 ruling shape)
  const out = assembleInquiryAskSet(episode, KEYS, cands, []);
  assert.equal(out.asks[0].id, 'MED_STATUS:dapagliflozin-forxiga-10mg');
  assert.equal(out.asks[1].id, gap.id);
  // EMPTY snapshot med list / absent snapshot ⇒ no new_medication ⇒ the same med stays rank 5
  for (const snap of [{ ...snapshot, medications: [], investigations: [] }, null]) {
    const c2 = candidatesFromUnknowns(deriveUnknowns({ episode, snapshot: snap as never, now: NOW }), episode, KEYS);
    const d2 = c2.find((c) => c.id === 'MED_STATUS:dapagliflozin-forxiga-10mg')!;
    assert.equal(d2.sourceKinds?.includes('new_medication'), false, 'thin evidence never flags "new"');
    assert.equal(priorityRank(d2), 5);
  }
});

test('assembly: total cap stays 5 and the overflow list is preserved', () => {
  // 2 high-alert meds (always first) + 3 picks would already fill the set — the deterministic
  // follow-up/allergy backfill must respect the cap, and everything unserved lands in overflow.
  const episode = mkCase({
    medications: [{ generic: 'Insulin glargine', highAlert: true }, { generic: 'Warfarin', highAlert: true }, { generic: 'Amlodipine' }],
    presentingComplaints: ['cough', 'fever'],
    allergies: null,
    advice: ['Repeat CBC after 1 week'],
  });
  const unknowns = [unk({ kind: 'unknown_finding', subject: 'night sweats' }), unk({ kind: 'unknown_finding', subject: 'blurred vision' }), unk({ kind: 'care_gap', subject: 'HbA1c', detail: 'abnormal (9.1) % — not rechecked in 8mo' })];
  const cands = candidatesFromUnknowns(unknowns, episode, KEYS);
  const picks = validateSelection([
    { n: nOf(cands, 'COMPLAINT_STATUS:night-sweats'), question: 'Any night sweats still?' },
    { n: nOf(cands, 'COMPLAINT_STATUS:blurred-vision'), question: 'Any blurred vision since the visit?' },
    { n: nOf(cands, 'FOLLOWUP_ACTION:hba1c'), question: 'Your HbA1c needs a repeat — shall I book it?' },
  ], cands);
  const out = assembleInquiryAskSet(episode, KEYS, cands, picks);
  assert.equal(out.asks.length, 5, 'total cap stays 5');
  assert.equal(out.asks[0].meta?.highAlert, true);
  assert.equal(out.asks[1].meta?.highAlert, true);
  assert.ok(out.overflow.length >= 1, 'overflow preserved');
  // K2 ladder: both follow-ups (care-gap rank 3, baseline rank 4) now outrank complaints (6) —
  // the unserved complaints/allergy/outside land in overflow instead.
  assert.ok(out.overflow.some((o) => o.family === 'COMPLAINT_STATUS'), 'unserved lower-rung asks recorded in overflow');
  const ids = new Set(out.asks.map((a) => a.id));
  assert.equal(ids.size, 5, 'no duplicate served asks');
});

test('K2: zero-valid-picks (parsed) is NOT a fallback — ladder assembles with skeleton phrasing, source inquiry', async () => {
  const episode = mkCase({ medications: [{ generic: 'Metformin', highAlert: false }], presentingComplaints: ['cough'], allergies: null });
  const base = buildAskSet(episode, KEYS);
  // parsed-but-empty picks array via assembly
  const cands = candidatesFromUnknowns([], episode, KEYS);
  const out = assembleInquiryAskSet(episode, KEYS, cands, []);
  assert.equal(out.source, 'inquiry');
  assert.equal(out.ask_set_version, 'ask-set/0.2');
  assert.deepEqual(out.asks.map((a) => a.id).sort(), base.asks.map((a) => a.id).sort(), 'baseline-only candidates ⇒ same served asks, ladder-ordered');
  for (const a of out.asks) {
    assert.equal(a.question, base.asks.find((b) => b.id === a.id)!.question, `${a.id}: skeleton phrasing`);
  }
  // via the full runner: parsed-empty and parsed-with-only-out-of-range-numbers both keep the member asks
  const u = unk({ kind: 'care_gap', subject: 'Vitamin D', detail: 'severely abnormal (8) ng/ml — not rechecked in 1.1y' });
  for (const raw of ['{"picks":[]}', '{"picks":[{"n":99,"question":"Are you taking the never-served medicine?"}]}']) {
    const r = await runInquirySelection(episode, KEYS, [u], { generate: async () => raw });
    assert.equal(r.source, 'inquiry', `${raw}: parsed ⇒ not a fallback`);
    assert.equal(r.ask_set_version, 'ask-set/0.2');
    assert.ok(r.asks.some((a) => a.id === 'FOLLOWUP_ACTION:vitamin-d'), 'member-derived ask kept via the ladder');
  }
});

test('K2: transport failure retries ONCE, then falls back byte-identical to buildAskSet', async () => {
  const episode = mkCase({ medications: [{ generic: 'Amlodipine' }] });
  const base = buildAskSet(episode, KEYS);
  const checkFallback = (r: { asks: unknown; overflow: unknown; source: string; ask_set_version: string }) => {
    assert.equal(r.source, 'deterministic_fallback');
    assert.equal(r.ask_set_version, 'ask-set/0.1');
    assert.deepEqual(r.asks, base.asks);           // byte-identity of the served set
    assert.deepEqual(r.overflow, base.overflow);
  };
  // throw twice → fallback, exactly 2 attempts
  let calls = 0;
  checkFallback(await runInquirySelection(episode, KEYS, [], { generate: async () => { calls++; throw new Error('gemini down'); } }));
  assert.equal(calls, 2, 'one retry before fallback');
  // unparseable twice → fallback, exactly 2 attempts
  calls = 0;
  checkFallback(await runInquirySelection(episode, KEYS, [], { generate: async () => { calls++; return 'sorry, I cannot produce JSON today'; } }));
  assert.equal(calls, 2);
  // timeout twice → fallback
  checkFallback(await runInquirySelection(episode, KEYS, [], {
    generate: () => new Promise((res) => setTimeout(() => res('{"picks":[]}'), 80)),
    timeoutMs: 10,
  }));
  // transient hiccup: fail once, succeed on the retry → served as inquiry, NOT a fallback
  calls = 0;
  const recovered = await runInquirySelection(episode, KEYS, [], {
    generate: async () => { calls++; if (calls === 1) throw new Error('blip'); return '{"picks":[]}'; },
  });
  assert.equal(calls, 2);
  assert.equal(recovered.source, 'inquiry');
  assert.equal(recovered.ask_set_version, 'ask-set/0.2');
});

test('runInquirySelection happy path: validated picks served as ask-set/0.2 with askMeta derivation', async () => {
  const episode = mkCase({ medications: [{ generic: 'Insulin glargine', highAlert: true }], allergies: null });
  const u = unk({ kind: 'care_gap', subject: 'Vitamin D', detail: 'severely abnormal (8) ng/ml — not rechecked in 1.1y', criticality: 'safety' });
  const n = nOf(candidatesFromUnknowns([u], episode, KEYS), 'FOLLOWUP_ACTION:vitamin-d');
  const r = await runInquirySelection(episode, KEYS, [u], {
    generate: async () => JSON.stringify({ picks: [{ n, question: 'Your Vitamin D was very low — shall I book a repeat test?', why: 'stale critical result' }] }),
  });
  assert.equal(r.source, 'inquiry');
  assert.equal(r.ask_set_version, 'ask-set/0.2');
  assert.equal(r.asks[0].meta?.highAlert, true, 'high-alert still first');
  const picked = r.asks.find((a) => a.id === 'FOLLOWUP_ACTION:vitamin-d')!;
  assert.ok(picked);
  const meta = r.askMeta.find((m) => m.askId === picked.id)!;
  assert.deepEqual(meta.unknownIds, [u.id]);
  assert.equal(meta.why, 'stale critical result');
  assert.ok(r.candidateCount >= 2);
});

test('B7 phrase-all: with a phrasing for EVERY candidate, all 5 ladder-served asks carry Gemini phrasing (no skeleton)', async () => {
  // >5 candidates so the ladder must choose which 5 serve — the regression: an un-selected
  // served ask used to fall to raw skeleton text (the ugly live slot-1 FOLLOWUP).
  const episode = mkCase({
    medications: [{ generic: 'Insulin glargine', highAlert: true }, { generic: 'Amlodipine' }],
    presentingComplaints: ['dizziness', 'headache'],
    allergies: null,
    advice: ['Review in 2 weeks'],
  });
  const unknowns = [
    unk({ kind: 'care_gap', subject: 'Vitamin D', detail: 'severely abnormal (8) ng/ml — not rechecked in 1.1y' }),
    unk({ kind: 'unknown_finding', subject: 'night sweats' }),
  ];
  const cands = candidatesFromUnknowns(unknowns, episode, KEYS);
  assert.ok(cands.length > 5, 'fixture yields more candidates than served slots');
  const gemini = (c: CandidateAsk) => `${c.subject || 'those records'} — checking in warmly, how is it going?`;
  const raw = JSON.stringify({ picks: cands.map((c, i) => ({ n: i + 1, question: gemini(c), why: `phrased #${i + 1}` })) });
  const r = await runInquirySelection(episode, KEYS, unknowns, { generate: async () => raw });
  assert.equal(r.source, 'inquiry');
  assert.equal(r.asks.length, 5, 'cap-5 unchanged');
  assert.equal(r.asks[0].meta?.highAlert, true, 'high-alert-first unchanged (ladder owns order)');
  for (const a of r.asks) {
    const c = cands.find((x) => x.id === a.id)!;
    assert.equal(a.question, gemini(c), `${a.id}: served with Gemini phrasing, not skeleton`);
  }
  // slot order is STILL the ladder's, byte-unchanged vs an empty-picks assembly
  const ladderOnly = assembleInquiryAskSet(episode, KEYS, cands, []);
  assert.deepEqual(r.asks.map((a) => a.id), ladderOnly.asks.map((a) => a.id), 'which-5 and order identical — B7 changes phrasing coverage only');
  // partial-coverage safety: drop one served candidate's phrasing → that ask falls to skeleton
  const servedIds = r.asks.map((a) => a.id);
  const partial = JSON.stringify({ picks: cands.map((c, i) => ({ n: i + 1, question: gemini(c) })).filter((_, i) => cands[i].id !== servedIds[2]) });
  const r2 = await runInquirySelection(episode, KEYS, unknowns, { generate: async () => partial });
  const unphrased = r2.asks.find((a) => a.id === servedIds[2])!;
  assert.equal(unphrased.question, cands.find((c) => c.id === servedIds[2])!.question, 'missing phrasing falls back to the skeleton, ask still served');
});

test('parseSelection tolerates prose around the JSON and rejects malformed shapes', () => {
  assert.ok(parseSelection('Here you go:\n{"picks":[{"n":1,"question":"q"}]}\nthanks'));
  assert.equal(parseSelection('no json here'), null);
  assert.equal(parseSelection('{"picks":"nope"}'), null);
  // a pick missing a numeric n, or with a non-string question, is a structural failure
  assert.equal(parseSelection('{"picks":[{"id":"MED_STATUS:x","question":"q"}]}'), null);
  assert.equal(parseSelection('{"picks":[{"n":"1","question":"q"}]}'), null);
  assert.equal(parseSelection('{"picks":[{"n":1,"question":42}]}'), null);
});

test('B6: parseSelection strips markdown code fences (the live-prod fallback root cause)', () => {
  // the real trace shape: a perfect answer wrapped in ```json … ``` fences
  const fenced = '```json\n{"picks":[{"n":1,"question":"Doctor started Lantus recently — have you begun the injections?","why":"newly added insulin"}],"rationale":"new drug first"}\n```';
  const picks = parseSelection(fenced)!;
  assert.ok(picks, 'fenced JSON parses');
  assert.equal(picks.length, 1);
  assert.equal(picks[0].n, 1);
  assert.match(picks[0].question, /Lantus/);
  // bare (unfenced) JSON stays back-compatible; a bare ``` fence (no language tag) also parses
  assert.ok(parseSelection('{"picks":[{"n":2,"question":"q"}]}'));
  assert.ok(parseSelection('```\n{"picks":[{"n":2,"question":"q"}]}\n```'));
});

test('B6 end-to-end: a fenced, number-based Gemini response serves source inquiry with Gemini phrasing', async () => {
  const episode = mkCase({ medications: [{ generic: 'Insulin glargine', brand: 'Lantus', highAlert: true }], allergies: null });
  const cands = candidatesFromUnknowns([], episode, KEYS);
  const n = nOf(cands, cands.find((c) => c.meta?.highAlert)!.id);
  const r = await runInquirySelection(episode, KEYS, [], {
    generate: async () => '```json\n{"picks":[{"n":' + n + ',"question":"Doctor started Insulin glargine (Lantus) — have you begun the injections?","why":"newly added insulin"}]}\n```',
  });
  assert.equal(r.source, 'inquiry', 'fenced response is NOT a fallback');
  assert.equal(r.ask_set_version, 'ask-set/0.2');
  assert.equal(r.asks[0].meta?.highAlert, true, 'ladder still owns slot order');
  assert.equal(r.asks[0].question, 'Doctor started Insulin glargine (Lantus) — have you begun the injections?', "Gemini's phrasing survives parse + number-map");
  const meta = r.askMeta.find((m) => m.askId === r.asks[0].id)!;
  assert.equal(meta.why, 'newly added insulin');
});

test('fallbackAskSet is buildAskSet verbatim (deep-equal asks + overflow)', () => {
  const episode = mkCase({ medications: [{ generic: 'X' }, { generic: 'Y' }], presentingComplaints: ['a', 'b'], allergies: null });
  const fb = fallbackAskSet(episode, KEYS);
  const base = buildAskSet(episode, KEYS);
  assert.deepEqual({ asks: fb.asks, overflow: fb.overflow }, base);
  assert.equal(fb.ask_set_version, 'ask-set/0.1');
  assert.equal(fb.source, 'deterministic_fallback');
});

// keep the type visible to the compiler so the exported shape can't silently narrow
const _t: CandidateAsk | null = null;
void _t;
