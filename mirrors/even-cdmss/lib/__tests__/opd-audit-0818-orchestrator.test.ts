import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unindicatedRespFindings, decongestantDurationFindings, dedupeRouteAware, muscleRelaxantFindings, parseDurationDays, ddiFindings, vitaminDRepletionFindings, pregnancyRiskFindings, lmpIntervalDays, mskContextDocumented } from '@/lib/opd-note-audit';
import { opdCaseText, type DeidOpdCase, type OpdMed } from '@/lib/opd-ingest-core';
import type { OpdFinding } from '@/lib/opd-note-audit-core';

function mkCase(p: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [],
    impressionCodes: [], impressions: [], history: [], comorbidities: [], medications: [],
    investigations: [], advice: [], examination: [], allergies: null, followUpType: null, followUpDateSet: false, ...p,
  };
}
const det = (subject: string, source: 'deterministic' | 'llm' = 'deterministic'): OpdFinding =>
  ({ subject, verdict: 'low-value', confidence: 0.7, domain: 'prescribing_safety', rationale: '', evidence: [], estimates: [], citation_ids: [], source });

// ── 0.81.10 (SIGNAL-TYPE-COLLAPSE S1) — the muscle-relaxant prompt is an informational, non-scoring
//    documentation nudge (it must be excluded from the note-quality index) ──
test('0.81.10 S1: the muscle-relaxant finding is emitted informational (surfaced, out of the score)', () => {
  const fs = muscleRelaxantFindings([{ generic: 'Chlorzoxazone', brand: 'CHLORZOX' } as OpdMed]);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].subject, 'Muscle relaxant prescribed — document the indication');
  assert.equal(fs[0].domain, 'appropriateness');
  assert.equal(fs[0].informational, true);            // NON-scoring — the whole point of S1
  assert.equal(fs[0].source, 'deterministic');
  // no muscle relaxant on the line → no finding
  assert.equal(muscleRelaxantFindings([{ generic: 'Amlodipine' } as OpdMed]).length, 0);
});

// ── bug 1 — unindicated xanthine bronchodilator for an acute URTI ─────
test('bug 1: xanthine for an acute URTI fires (context-guarded)', () => {
  const c = mkCase({ presentingComplaints: ['common cold, sore throat'], medications: [{ generic: 'Theophylline' } as OpdMed] });
  const fs = unindicatedRespFindings(c);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].domain, 'appropriateness');
  assert.equal(fs[0].verdict, 'low-value');
});
test('bug 1: the SAME xanthine is NOT flagged for a chronic-airways patient (J40–J47 guard)', () => {
  const c = mkCase({ presentingComplaints: ['common cold'], diagnosisCodes: ['J44.9'], medications: [{ generic: 'Theophylline' } as OpdMed] });
  assert.equal(unindicatedRespFindings(c).length, 0);
  const c2 = mkCase({ presentingComplaints: ['cough'], impressions: ['Bronchial asthma'], medications: [{ generic: 'Doxophylline' } as OpdMed] });
  assert.equal(unindicatedRespFindings(c2).length, 0);
});
// ── 0.81.14 (Ruling 12, CLINICAL-RULINGS §2.4) — acebrophylline removed from XANTHINE_MOLECULES ──
test('0.81.14 Ruling 12: acebrophylline + acetylcysteine in an acute URTI → NO finding (rule dormant for it)', () => {
  const c = mkCase({ presentingComplaints: ['common cold, cough'], medications: [
    { generic: 'Acebrophylline' } as OpdMed, { generic: 'Acetylcysteine' } as OpdMed] });
  assert.equal(unindicatedRespFindings(c).length, 0);
  // a genuine xanthine on the same presentation STILL fires — the rule is dormant, not dead
  assert.equal(unindicatedRespFindings(mkCase({ presentingComplaints: ['common cold'], medications: [{ generic: 'Theophylline' } as OpdMed] })).length, 1);
});
// ── 0.81.13 (PHARMACY-ROUND1 Decision 11) — montelukast + antihistamine is RETIRED entirely ──
test('0.81.13 Decision 11: antihistamine + montelukast emits NO finding at any duration', () => {
  for (const duration of ['3 days', '8 days', '30 days', undefined]) {
    const c = mkCase({ presentingComplaints: ['viral URTI'], medications: [
      { generic: 'Levocetirizine', duration } as OpdMed, { generic: 'Montelukast', duration } as OpdMed] });
    assert.equal(unindicatedRespFindings(c).length, 0, `duration=${duration}`);
  }
});
test('0.81.13 Decision 11: a xanthine AND antihistamine+montelukast → exactly ONE finding (the xanthine)', () => {
  const c = mkCase({ presentingComplaints: ['viral URTI'], medications: [
    { generic: 'Theophylline' } as OpdMed, { generic: 'Levocetirizine' } as OpdMed, { generic: 'Montelukast' } as OpdMed] });
  const fs = unindicatedRespFindings(c);
  assert.equal(fs.length, 1);
  assert.match(fs[0].subject, /^Xanthine bronchodilator not indicated/);
  assert.doesNotMatch(fs[0].subject, /montelukast/i);
});
// ── 0.81.13 (Decision 3) — xanthine relabel: no "mucolytic", correct subject ──
test('0.81.13 Decision 3: xanthine subject/rationale carry no "mucolytic"; guard + confidence unchanged', () => {
  const c = mkCase({ presentingComplaints: ['common cold, sore throat'], medications: [{ generic: 'Theophylline' } as OpdMed] });
  const fs = unindicatedRespFindings(c);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].subject, 'Xanthine bronchodilator not indicated for an acute URTI: Theophylline');
  assert.doesNotMatch(fs[0].subject, /mucolytic/i);
  assert.doesNotMatch(fs[0].rationale, /mucolytic/i);
  assert.equal(fs[0].confidence, 0.6);
  assert.equal(fs[0].domain, 'appropriateness');
  // chronic-airways guard still suppresses
  assert.equal(unindicatedRespFindings(mkCase({ presentingComplaints: ['cough'], diagnosisCodes: ['J45.9'], medications: [{ generic: 'Theophylline' } as OpdMed] })).length, 0);
});
test('bug 1: no acute-URTI context → nothing fires', () => {
  const c = mkCase({ presentingComplaints: ['knee pain'], medications: [{ generic: 'Acebrophylline' } as OpdMed] });
  assert.equal(unindicatedRespFindings(c).length, 0);
});

// ── 0.81.13 (Decision 4) — nasal decongestant two-tier (>7 → 0.7, >15 → 0.85) ──
test('0.81.13 Decision 4: 5 → none; 7 → none; 8 and 15 → 0.7; 16 and 1 month → 0.85; unparseable → none', () => {
  const one = (duration?: string) => decongestantDurationFindings([{ generic: 'Oxymetazoline', route: 'nasal', duration } as OpdMed]);
  assert.equal(one('5 days').length, 0);
  assert.equal(one('7 days').length, 0);        // was >5 → now <=7 emits nothing
  assert.equal(one(undefined).length, 0);
  assert.equal(one('to continue').length, 0);   // unparseable → none
  const d8 = one('8 days'); assert.equal(d8.length, 1); assert.equal(d8[0].confidence, 0.7);
  const d15 = one('15 days'); assert.equal(d15.length, 1); assert.equal(d15[0].confidence, 0.7);
  const d16 = one('16 days'); assert.equal(d16.length, 1); assert.equal(d16[0].confidence, 0.85);
  const dm = one('1 month'); assert.equal(dm.length, 1); assert.equal(dm[0].confidence, 0.85);
  // ingredient-level in an FDC still resolves; no "3–5 day cap" wording survives
  const fdc = decongestantDurationFindings([{ resolvedGeneric: 'Xylometazoline+Sodium chloride', duration: '10 days' } as OpdMed]);
  assert.equal(fdc.length, 1);
  assert.doesNotMatch(fdc[0].rationale, /3.?5 day/);
});

// ── 0.81.13 (Decision 2 / §3.1) — parseDurationDays export is unchanged behaviour ──
test('0.81.13: parseDurationDays (exported) parses days/weeks/months and returns null for chronic/unparseable', () => {
  assert.equal(parseDurationDays('5 days'), 5);
  assert.equal(parseDurationDays('1 week'), 7);
  assert.equal(parseDurationDays('1 month'), 30);
  assert.equal(parseDurationDays('30 days'), 30);
  for (const s of ['to continue', 'sos', 'when needed', '', '3 more days']) {
    assert.equal(parseDurationDays(s), null, s);
  }
  assert.equal(parseDurationDays(undefined), null);
});

// ── bug 8 — route/formulation-aware duplication ───────────────────────────────
test('bug 8: BPO wash-off + leave-on is NOT a duplicate (finding dropped)', () => {
  const meds: OpdMed[] = [
    { resolvedGeneric: 'Benzoyl Peroxide', brand: 'Benzoyl Peroxide Face Wash', instruction: 'wash off' } as OpdMed,
    { resolvedGeneric: 'Benzoyl Peroxide', brand: 'Benzoyl Peroxide Gel', instruction: 'apply thin layer' } as OpdMed,
  ];
  const kept = dedupeRouteAware([det('Duplicate prescription: Benzoyl Peroxide')], meds);
  assert.equal(kept.length, 0);
});
test('bug 8: topical + systemic sharing a molecule is not a duplicate', () => {
  const meds: OpdMed[] = [
    { resolvedGeneric: 'Clindamycin', brand: 'Clindamycin Gel', instruction: 'apply' } as OpdMed,
    { resolvedGeneric: 'Clindamycin', brand: 'Clindamycin Cap', instruction: 'oral' } as OpdMed,
  ];
  assert.equal(dedupeRouteAware([det('Duplicate prescription: Clindamycin')], meds).length, 0);
});
test('bug 8: a genuine same-route duplicate is KEPT', () => {
  const meds: OpdMed[] = [
    { resolvedGeneric: 'Amoxicillin', brand: 'Amox 500 Cap', instruction: 'oral' } as OpdMed,
    { resolvedGeneric: 'Amoxicillin', brand: 'Amox 250 Cap', instruction: 'oral' } as OpdMed,
  ];
  assert.equal(dedupeRouteAware([det('Duplicate prescription: Amoxicillin')], meds).length, 1);
});
test('bug 8: an LLM finding (non-deterministic) is never touched by the route filter', () => {
  const meds: OpdMed[] = [{ resolvedGeneric: 'Benzoyl Peroxide', brand: 'Face Wash', instruction: 'wash' } as OpdMed];
  assert.equal(dedupeRouteAware([det('Duplicate prescription: Benzoyl Peroxide', 'llm')], meds).length, 1);
});

// ── bug 4 — consult date surfaced in opdCaseText (+ historical guard) ─────────
test('bug 4: opdCaseText surfaces the consult date exactly once with a historical guard', () => {
  const text = opdCaseText(mkCase({ noteDate: '2026-07-12T09:30:00Z', presentingComplaints: ['fever'] }));
  assert.match(text, /Consultation date \(the encounter being audited\): 2026-07-12/);
  assert.match(text, /HISTORICAL context that predates this consult/);
  assert.equal((text.match(/Consultation date \(the encounter being audited\)/g) || []).length, 1);
  // no noteDate → no line
  assert.doesNotMatch(opdCaseText(mkCase({ presentingComplaints: ['fever'] })), /Consultation date \(the encounter being audited\)/);
});

// ── 0.81.14 Ruling 1 (§2.1) — topical + oral NSAID interaction suppressed entirely ──
test('0.81.14 Ruling 1: an oral + topical NSAID pair emits NO interaction finding', () => {
  const meds: OpdMed[] = [
    { generic: 'Ibuprofen', resolvedGeneric: 'Ibuprofen' } as OpdMed,
    { generic: 'Diclofenac', resolvedGeneric: 'Diclofenac', route: 'topical' } as OpdMed,
  ];
  assert.equal(ddiFindings(meds).filter((f) => /^Interaction/.test(f.subject)).length, 0);
});
test('0.81.14 Ruling 1: two ORAL NSAIDs still produce an interaction finding (unchanged)', () => {
  const meds: OpdMed[] = [
    { generic: 'Ibuprofen', resolvedGeneric: 'Ibuprofen' } as OpdMed,
    { generic: 'Diclofenac', resolvedGeneric: 'Diclofenac' } as OpdMed,
  ];
  assert.ok(ddiFindings(meds).some((f) => /^Interaction/.test(f.subject)));
});

// ── 0.81.14 Ruling 4 (§2.3) — muscle relaxant fires only without documented MSK context ──
test('0.81.14 Ruling 4: muscle relaxant with MSK context → none; without → fires; ctx omitted → today', () => {
  const meds: OpdMed[] = [{ generic: 'Chlorzoxazone' } as OpdMed];
  assert.equal(muscleRelaxantFindings(meds, { mskDocumented: true }).length, 0);
  assert.equal(muscleRelaxantFindings(meds, { mskDocumented: false }).length, 1);
  assert.equal(muscleRelaxantFindings(meds).length, 1);                       // ctx omitted → prior behaviour
  assert.equal(muscleRelaxantFindings(meds)[0].informational, true);          // stays informational
});
test('0.81.14 Ruling 4: mskContextDocumented — "low back pain" true, ICD M54.5 true, "fever, cough" false', () => {
  assert.equal(mskContextDocumented(mkCase({ presentingComplaints: ['low back pain'] })), true);
  assert.equal(mskContextDocumented(mkCase({ diagnosisCodes: ['M54.5'] })), true);
  assert.equal(mskContextDocumented(mkCase({ presentingComplaints: ['fever, cough'] })), false);
  // end-to-end: MSK text → no muscle-relaxant finding; no MSK context → fires
  const meds: OpdMed[] = [{ generic: 'Tizanidine' } as OpdMed];
  assert.equal(muscleRelaxantFindings(meds, { mskDocumented: mskContextDocumented(mkCase({ presentingComplaints: ['neck pain'] })) }).length, 0);
  assert.equal(muscleRelaxantFindings(meds, { mskDocumented: mskContextDocumented(mkCase({ presentingComplaints: ['fever'] })) }).length, 1);
});

// ── 0.81.14 Ruling 13 (§2.5) — Vitamin D weekly-repletion duration ──
test('0.81.14 Ruling 13: 60,000 IU weekly for >8 weeks fires informational; 8 weeks / daily / low-strength / unparseable → none', () => {
  const mk = (o: Partial<OpdMed>): OpdMed => ({ generic: 'Cholecalciferol', strength: '60000 IU', frequency: 'once a week', duration: '12 weeks', ...o } as OpdMed);
  const fires = vitaminDRepletionFindings([mk({})]);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].informational, true);
  assert.equal(fires[0].confidence, 0);
  assert.match(fires[0].subject, /Vitamin D 60,000 IU weekly prescribed for 12 weeks/);
  assert.equal(vitaminDRepletionFindings([mk({ duration: '8 weeks' })]).length, 0);         // 56d, not >56
  assert.equal(vitaminDRepletionFindings([mk({ frequency: '1-0-0' })]).length, 0);           // rule 3 (weekly) fails — daily grid
  assert.equal(vitaminDRepletionFindings([mk({ strength: '1000 IU' })]).length, 0);          // rule 2 (60k) fails
  assert.equal(vitaminDRepletionFindings([mk({ generic: 'Amoxicillin' })]).length, 0);       // rule 1 (composition) fails
  assert.equal(vitaminDRepletionFindings([mk({ duration: '8 weeks followed by once a month for 4 months' })]).length, 0);  // unparseable → silent (load-bearing fail-safe)
  assert.equal(vitaminDRepletionFindings([mk({ duration: undefined })]).length, 0);          // empty duration → none
});

// ── 0.81.14 Rulings 5–8 (§2.7) — possible-pregnancy verification advisory ──
const VISIT = '2026-07-25T00:00:00Z';
const lmpDaysAgo = (n: number): string => { const d = new Date(VISIT); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
test('0.81.14 Rulings 5–8: pregnancy advisory fires only in the 36–90d window with a trigger drug, always informational', () => {
  const dox: OpdMed[] = [{ generic: 'Doxycycline', resolvedGeneric: 'Doxycycline' } as OpdMed];
  const fire = pregnancyRiskFindings(dox, { lmpIntervalDays: lmpIntervalDays(lmpDaysAgo(45), VISIT) });
  assert.equal(fire.length, 1);
  assert.equal(fire[0].informational, true);
  assert.equal(fire[0].domain, 'prescribing_safety');
  assert.match(fire[0].subject, /^Possible pregnancy — verify status before/);
  assert.match(fire[0].rationale, /used with caution in pregnancy/);
  // LMP 20d (too recent) and 120d (too old) → none
  assert.equal(pregnancyRiskFindings(dox, { lmpIntervalDays: lmpIntervalDays(lmpDaysAgo(20), VISIT) }).length, 0);
  assert.equal(pregnancyRiskFindings(dox, { lmpIntervalDays: lmpIntervalDays(lmpDaysAgo(120), VISIT) }).length, 0);
  // NSAID (ibuprofen) is NOT a trigger; amoxicillin is not a trigger → none even in-window
  assert.equal(pregnancyRiskFindings([{ generic: 'Ibuprofen', resolvedGeneric: 'Ibuprofen' } as OpdMed], { lmpIntervalDays: 45 }).length, 0);
  assert.equal(pregnancyRiskFindings([{ generic: 'Amoxicillin', resolvedGeneric: 'Amoxicillin' } as OpdMed], { lmpIntervalDays: 45 }).length, 0);
  // absent LMP (null interval) → none, even for a contraindicated drug
  assert.equal(pregnancyRiskFindings([{ generic: 'Methotrexate', resolvedGeneric: 'Methotrexate' } as OpdMed], { lmpIntervalDays: null }).length, 0);
  assert.equal(pregnancyRiskFindings([{ generic: 'Methotrexate', resolvedGeneric: 'Methotrexate' } as OpdMed]).length, 0);   // ctx omitted → none
  // a contraindicated drug reads as "contraindicated in", not "caution"
  const contra = pregnancyRiskFindings([{ generic: 'Isotretinoin', resolvedGeneric: 'Isotretinoin' } as OpdMed], { lmpIntervalDays: 45 });
  assert.match(contra[0].rationale, /contraindicated in pregnancy/);
});
test('0.81.14: lmpIntervalDays parses ISO dates + fail-safe on missing/garbage', () => {
  assert.equal(lmpIntervalDays('2026-06-10', '2026-07-25'), 45);
  assert.equal(lmpIntervalDays(null, VISIT), null);
  assert.equal(lmpIntervalDays('2026-06-10', null), null);
  assert.equal(lmpIntervalDays('not-a-date', VISIT), null);
});
