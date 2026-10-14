/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r41-refresh.test.ts
 * R4.1 (CDMSS-READMISSIONS-R4.1-PRD v1.0): the card helpers (judgementExceptionLines — every
 * value combination; caseLine — first sentence, markers stripped, ~160-char word-boundary cap;
 * absent / invalid narrative → nothing) · the board layout pins · the refresh delta detector · the
 * probe gate (fingerprints; run blocked without a passed probe) · the transport seam (recon
 * sequence identical under an injected pass; the Vertex tracedChat options byte-identical) · the
 * refresh run type (Bedrock-only, Opus exact, n = 1) · PHI source-reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { caseLine, judgementExceptionLines, NEGLIGENCE_ADVISORY, CASE_LINE_MAX, type SurfaceFinding } from '../readmission-surface-core.ts';
import {
  reconPromptFingerprints, probePassed, probeUnlocksRun, refreshDelta, refreshLanded, countsForStay,
  REFRESH_N_PER_TICK, REFRESH_LEG_BUDGET_MS, REFRESH_NARRATIVE_BUDGET_MS, REFRESH_MAX_ATTEMPTS, REFRESH_WORKER, REFRESH_PROBE_KEY,
} from '../readmission-refresh-core.ts';
import { planRunCreate } from '../backfill-runs-core.ts';
import { runReconSequence, type PassFn } from '../readmission/run.ts';
import { templateExistenceSql } from '../readmission/db13.ts';
import type { PassClaims } from '../readmission-reconcile-core.ts';
import { NARRATIVE_MODEL } from '../readmission-narrative-core.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const f = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  dedupKey: 'IP-1|IP-2', findingClass: 'even_even', lane: 'tight_bounce', auditStatus: 'audited',
  patientName: null, uhid: 'UH-1', ageGender: null, gapDays: 4,
  indexDepartment: 'Orthopaedics', readmitDepartment: 'Orthopaedics', indexDoctor: null, readmitDoctor: null,
  indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-05T09:30:00+05:30',
  payerIndex: 'Even', payerReadmit: 'Even', cmNote: null,
  planned: 'unplanned', sameCondition: 'same', avoidable: 'needs_adjudication',
  labTier: 'tier1', labTimingProfile: 'has_late_labs', nOmissions: 1,
  needsHumanReview: true, promotedToFull: false, notAuditableReason: null,
  finding: null, omissionEvidence: null, ...over,
});

// ── R41-1: judgement exception lines — every value combination ──────────────────────────

test('judgementExceptionLines: suspected → red line; not_suggested → quiet slate line; unknown / null / junk / pre-R1 → nothing; negligence carries the advisory caveat; not-audited rows render nothing', () => {
  const combos: Array<[string | null | undefined, string | null | undefined, string[]]> = [
    ['suspected', 'suspected', ['Preventable injury · Suspected', 'Negligence · Suspected']],
    ['suspected', 'not_suggested', ['Preventable injury · Suspected', 'Negligence · Not suggested']],
    ['suspected', 'unknown', ['Preventable injury · Suspected']],
    ['not_suggested', 'suspected', ['Preventable injury · Not suggested', 'Negligence · Suspected']],
    ['not_suggested', 'not_suggested', ['Preventable injury · Not suggested', 'Negligence · Not suggested']],
    ['not_suggested', null, ['Preventable injury · Not suggested']],
    ['unknown', 'unknown', []],
    [null, null, []],          // pre-R1 blob
    [undefined, undefined, []],
    ['weird', 'garbage', []],
    ['unknown', 'suspected', ['Negligence · Suspected']],
  ];
  for (const [pi, ng, expected] of combos) {
    const lines = judgementExceptionLines(f({ preventableInjury: pi, negligence: ng }));
    assert.deepEqual(lines.map((l) => l.text), expected, `pi=${pi} ng=${ng}`);
    for (const l of lines) {
      assert.equal(l.tone, l.text.endsWith('Suspected') ? 'red' : 'slate');
      if (l.key === 'negligence') assert.equal(l.caveat, NEGLIGENCE_ADVISORY); else assert.equal(l.caveat, undefined);
    }
  }
  assert.deepEqual(judgementExceptionLines(f({ auditStatus: 'excluded', preventableInjury: 'suspected', negligence: 'suspected' })), []);
  assert.deepEqual(judgementExceptionLines(f({ auditStatus: 'not_auditable', preventableInjury: 'suspected', negligence: 'suspected' })), []);
});

// ── R41-3: the case line ─────────────────────────────────────────────────────────────────

test('caseLine: first sentence, markers stripped (single + list + mixed separators), whitespace tidied; only from a VALID narrative with text', () => {
  const text = 'The patient was readmitted four days after a hemiarthroplasty with a discharging wound [S1, R2]. Hb had fallen to 9.1 g/dL before discharge [L1]. Nothing else.';
  assert.equal(caseLine({ text, valid: true }), 'The patient was readmitted four days after a hemiarthroplasty with a discharging wound.');
  assert.equal(caseLine({ text: 'Flagged on day 4 [S1] [OT1; P1].\n\nSecond paragraph [R1].', valid: true }), 'Flagged on day 4.');
  assert.equal(caseLine({ text: 'Only one sentence with no terminal punctuation [S3]', valid: true }), 'Only one sentence with no terminal punctuation');
  // a decimal inside prose is not a sentence end
  assert.equal(caseLine({ text: 'Hb was 9.1 g/dL at discharge [L1]. Then more.', valid: true }), 'Hb was 9.1 g/dL at discharge.');
  assert.equal(caseLine({ text, valid: false }), null);
  assert.equal(caseLine({ text: '', valid: true }), null);
  assert.equal(caseLine({ text: '   [S1] ', valid: true }), null);
  assert.equal(caseLine(null), null); assert.equal(caseLine(undefined), null);
});

test('caseLine: ~160-char cap on a word boundary with an ellipsis; never mid-word; short sentences untouched', () => {
  const long = `${'The index stay recorded a displaced intracapsular fracture treated with a cemented hemiarthroplasty and an uneventful early course with mobilisation on day two and a clean wound at discharge according to the treating team'} [S1, S2, S3].`;
  const out = caseLine({ text: long, valid: true })!;
  assert.ok(out.length <= CASE_LINE_MAX, `len ${out.length}`);
  assert.ok(out.endsWith('…'));
  const body = out.slice(0, -1);
  assert.ok(long.startsWith(body), 'prefix of the sentence'); assert.ok(long[body.length] === ' ', 'cut on a word boundary');
  assert.equal(caseLine({ text: 'Short. [S1]', valid: true }), 'Short.');
  assert.equal(CASE_LINE_MAX, 160);
});

test('board layout: the two judgement cells are gone, justification + bill stay as cells, exception lines + case line render; case line derived in the list route before the strip', () => {
  const board = code('components/care/ReadmissionsBoard.tsx');
  assert.ok(!/<Cell k="Preventable injury"/.test(board)); assert.ok(!/<Cell k="Negligence"/.test(board));
  assert.match(board, /<Cell k="Medical justification"/); assert.match(board, /<Cell k="Return stay bill"/);
  assert.match(board, /judgementExceptionLines\(f\)\.map/); assert.match(board, /l\.caveat && /);
  assert.match(board, /f\.caseLine && /);
  assert.ok(!/judgementLabel|NEGLIGENCE_ADVISORY/.test(board), 'the card no longer prints the always-valued judgement cells');
  const list = code('app/api/care/readmissions/list/route.ts');
  assert.match(list, /caseLine: caseLine\(f\.finding\?\.caseNarrative\), finding: stripCaseArtefacts\(f\.finding\)/);
  // the case page and the brief still show all three judgements (R41-2)
  assert.match(code('components/care/ReadmissionCasePage.tsx'), /<Cell k="Preventable injury"/);
  assert.match(code('lib/readmission/brief.ts'), /Preventable injury: \$\{judgementLabel/);
});

// ── the delta detector (R41-4) ───────────────────────────────────────────────────────────

test('refreshDelta: rows-now vs stored coverage — absent / missing → pending; present / empty / fetch_failed (A1) → not; no rows → not; attempt cap → stuck', () => {
  const rowsNow = { ot: 2, pac: 0, progress: 3 };
  assert.deepEqual(refreshDelta({ ot: { status: 'absent', count: 0 }, pac: { status: 'absent', count: 0 }, progress: { status: 'absent', count: 0 } }, rowsNow), { pending: true, stuck: false, sources: ['ot', 'progress'] });
  assert.deepEqual(refreshDelta({ ot: { status: 'present', count: 1 }, pac: { status: 'absent', count: 0 }, progress: { status: 'empty', count: 3 } }, rowsNow), { pending: false, stuck: false, sources: [] });
  // Addendum A1: a fetch_failed-only delta is NOT refresh-pending (it cannot loop a case)
  assert.deepEqual(refreshDelta({ ot: { status: 'fetch_failed', count: 0 }, pac: { status: 'absent', count: 0 }, progress: { status: 'present', count: 2 } }, rowsNow), { pending: false, stuck: false, sources: [] });
  assert.deepEqual(refreshDelta({ ot: { status: 'fetch_failed', count: 0 }, pac: { status: 'fetch_failed', count: 0 }, progress: { status: 'absent', count: 0 } }, rowsNow), { pending: true, stuck: false, sources: ['progress'] });
  assert.deepEqual(refreshDelta(null, rowsNow), { pending: true, stuck: false, sources: ['ot', 'progress'] });          // never looked (pre-R2)
  assert.deepEqual(refreshDelta(undefined, { ot: 0, pac: 0, progress: 0 }), { pending: false, stuck: false, sources: [] });
  assert.deepEqual(refreshDelta({ ot: { status: 'absent', count: 0 } }, rowsNow, REFRESH_MAX_ATTEMPTS), { pending: false, stuck: true, sources: ['ot', 'progress'] });
  assert.equal(REFRESH_MAX_ATTEMPTS, 3);
});

test('countsForStay sums index + readmit encounters; unknown encounters contribute nothing', () => {
  const by = new Map([['IP-1', { ot: 1, pac: 0, progress: 2 }], ['IP-2', { ot: 0, progress: 1 }]]);
  assert.deepEqual(countsForStay(by, ['IP-1', 'IP-2', null, 'IP-9']), { ot: 1, pac: 0, progress: 3 });
  assert.deepEqual(countsForStay(by, ['IP-1']), { ot: 1, pac: 0, progress: 2 });
});

test('existence SQL: encounter_id + count only, final rows, IN-list escaped; empty → null (no query)', () => {
  const sql = templateExistenceSql('kx_clinical_template_ot_notes', ['IP-1', "IP'2", 'IP-1', 'bad id!', 'IPNO-229'])!;
  // "IP'2" and "bad id!" are not encounter-id shapes and are dropped before the list is built (never escaped in)
  assert.match(sql, /SELECT encounter_id, count\(\*\)::int AS n FROM kx_clinical_template_ot_notes\s+WHERE encounter_id IN \('IP-1', 'IPNO-229'\) AND status = 'final'\s+GROUP BY 1/);
  assert.equal(templateExistenceSql('kx_clinical_template_ot_notes', []), null);
  assert.ok(!/patient_name|patient_mobile|uhid|component_json|\bnote\b/.test(sql));
});

// ── the probe gate (R41-5) ───────────────────────────────────────────────────────────────

test('probe gate: no record / malformed / not passed / stale fingerprints → blocked; passed for current fingerprints → unlocked', () => {
  const fp = reconPromptFingerprints();
  assert.match(fp, /^([0-9a-f]{16}\.){4}[0-9a-f]{16}$/);
  assert.equal(reconPromptFingerprints(), fp, 'deterministic');
  const blocked = (raw: unknown, re: RegExp) => { const r = probeUnlocksRun(raw, fp); assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, re); };
  blocked(null, /no probe recorded/);
  blocked('', /no probe recorded/);
  blocked('{not json', /no valid probe record/);
  blocked(JSON.stringify({ passed: false, fingerprints: fp }), /did not pass/);
  blocked(JSON.stringify({ passed: true, fingerprints: 'deadbeef' }), /different prompt fingerprints/);
  const ok = probeUnlocksRun(JSON.stringify({ passed: true, fingerprints: fp, dedupKey: 'k', at: 't', model: NARRATIVE_MODEL, legs: [], narrativeValid: true, saved: false }), fp);
  assert.equal(ok.ok, true);
  assert.equal(probePassed([]), false);
  assert.equal(probePassed([{ label: 'readmit_recon_a', ms: 1, jsonClosed: true, verdicts: {} }, { label: 'readmit_recon_b', ms: 1, jsonClosed: false, verdicts: {} }]), false);
  assert.equal(probePassed([{ label: 'readmit_recon_a', ms: 1, jsonClosed: true, verdicts: {} }, { label: 'readmit_recon_b', ms: 1, jsonClosed: true, verdicts: {} }]), true);
  assert.equal(REFRESH_PROBE_KEY, 'readmit_refresh_probe');
});

test('the run start reads the gate first (source-read): startRefreshRun refuses 412 without a passed probe; the tick re-checks it; resume re-checks it', () => {
  const src = code('lib/readmission/refresh.ts');
  const startIdx = src.indexOf('export async function startRefreshRun');
  const gateIdx = src.indexOf('await refreshRunUnlocked()', startIdx);
  const createIdx = src.indexOf('await createRun(plan)', startIdx);
  assert.ok(gateIdx > startIdx && gateIdx < createIdx, 'the gate is read before the run row can exist');
  assert.match(src.slice(startIdx, createIdx), /status: 412, error: `probe gate: \$\{gate\.reason\}`/);
  const tickIdx = src.indexOf('export async function refreshTick');
  assert.ok(src.indexOf('await refreshRunUnlocked()', tickIdx) > tickIdx, 'every tick re-checks the gate');
  assert.match(src, /if \(action === 'resume'\) \{ const gate = await refreshRunUnlocked\(\)/);
  // only a PASSED probe is recorded
  assert.match(src, /if \(passed\) \{ try \{ await setSetting\(REFRESH_PROBE_KEY, JSON\.stringify\(record\)\)/);
});

// ── the transport seam (R41-4): sequence identical, Vertex options byte-identical ──────────

const cat = { items: [
  { id: 'S1', source: 'index_summary' as const, side: 'index' as const, text: 'diagnosis: fracture neck of femur' },
  { id: 'R1', source: 'readmit_summary' as const, side: 'readmit' as const, text: 'diagnosis: SSI' },
  { id: 'L1', source: 'lab' as const, side: 'index' as const, text: 'Hb 9.1', abnormal: true, at: '2026-06-01' },
] };
const inputs = { catalog: cat, labProfile: 'has_late_labs' as const, labTier: 'tier1' as const, labSourceProvenance: { tier: 'tier1' as const, structuredLabCount: 1, window: null, caseLabCount: 0, indexCase: 'store' as const, readmitCase: 'store' as const, extractionVersion: 'x', indexDocumentId: 'D1', readmitDocumentId: 'D2' }, indexSentenceCount: 1, readmitSentenceCount: 1 };
const rowBase = { dedup_key: 'IP-1|IP-2', finding_class: 'even_even', index_encounter_id: 'IP-1', readmit_encounter_id: 'IP-2', form_uid: null, uhid: 'UH-1', lane: 'tight_bounce', gap_days: 4, index_department: 'Ortho', readmit_department: 'Ortho', index_doctor: 'Dr A', readmit_doctor: 'Dr A', index_discharge_at: '2026-06-01T10:00:00+05:30', readmit_admit_at: '2026-06-05T09:30:00+05:30', cm_note: null, form_is_planned: null, form_same_condition: null };
const claims = (over: Partial<PassClaims> = {}): PassClaims => ({ planned: { verdict: 'unplanned', evidenceIds: ['S1'] }, sameCondition: { verdict: 'same', evidenceIds: ['R1'] }, omissions: [], exculpatory: [], avoidable: { verdict: 'uncertain', evidenceIds: ['L1'] }, refusalRecord: [], ...over });

test('runReconSequence: the leg sequence is one function — full pair = recon_a then recon_b; lane D = condition then (on same) recon_a + recon_b; OON = one pass; identical under any injected transport', async () => {
  const seen: string[] = [];
  const pass: PassFn = async (label) => { seen.push(label); return claims(); };
  const full = await runReconSequence({ row: rowBase as never, inputs: inputs as never, indexDischargeAt: rowBase.index_discharge_at, pass });
  assert.deepEqual(seen, ['readmit_recon_a', 'readmit_recon_b']); assert.equal(full.promoted, false); assert.equal(full.finding.findingClass, 'even_even');
  seen.length = 0;
  const laneD = await runReconSequence({ row: { ...rowBase, lane: 'other' } as never, inputs: inputs as never, indexDischargeAt: rowBase.index_discharge_at, pass });
  assert.deepEqual(seen, ['readmit_condition', 'readmit_recon_a', 'readmit_recon_b']); assert.equal(laneD.promoted, true);
  seen.length = 0;
  const laneDdiff = await runReconSequence({ row: { ...rowBase, lane: 'other' } as never, inputs: inputs as never, indexDischargeAt: rowBase.index_discharge_at, pass: async (label) => { seen.push(label); return claims({ sameCondition: { verdict: 'different', evidenceIds: ['R1'] } }); } });
  assert.deepEqual(seen, ['readmit_condition']); assert.equal(laneDdiff.promoted, false);
  seen.length = 0;
  const oon = await runReconSequence({ row: { ...rowBase, finding_class: 'out_of_network', readmit_encounter_id: null } as never, inputs: inputs as never, indexDischargeAt: rowBase.index_discharge_at, pass });
  assert.deepEqual(seen, ['readmit_oon']); assert.equal(oon.finding.findingClass, 'out_of_network');
  // an unparseable leg throws (the caller decides retry semantics)
  await assert.rejects(runReconSequence({ row: rowBase as never, inputs: inputs as never, indexDischargeAt: null, pass: async () => null }), /recon pass A unparseable/);
});

test('the Vertex path is zero-diff: the vertexPass slice (body + tracedChat options) hashes to its f09cb6f value, and runReadmissionAudit injects it', () => {
  const run = code('lib/readmission/run.ts');
  const slice = run.slice(run.indexOf('async function vertexPass('), run.indexOf('// ── Phase 1.5: the three-source substrate'));
  assert.equal(createHash('sha256').update(slice).digest('hex').slice(0, 16), '266b568368142216', 'vertexPass is byte-identical to the shipped R2/R3/R4 text (sha at f09cb6f)');
  assert.match(slice, /\{ gemini: model, timeoutMs: budget\.timeoutMs, maxTries: budget\.maxTries, noLocalFallback: true \}/);
  assert.match(run, /pass: \(label, prompt\) => vertexPass\(traceId, label, model, prompt\),/);
  // the refresh transport lives outside run.ts and names bedrock, one try, its own budget
  const refresh = code('lib/readmission/refresh.ts');
  assert.match(refresh, /\{ bedrock: NARRATIVE_MODEL_ID, timeoutMs: REFRESH_LEG_BUDGET_MS, maxTries: REFRESH_LEG_MAX_TRIES \}/);
  assert.ok(!/gemini:/.test(refresh), 'the refresh path never names a Gemini model');
  // the worker route and its arithmetic are untouched by R4.1 (only the R4 Addendum A clamp is there)
  // R4.1 touched neither the worker route nor its arithmetic: no refresh / Bedrock-pass wiring in it
  const worker = code('app/api/readmission/worker/route.ts');
  assert.ok(!/refresh|bedrockPass|readmission_refresh|REFRESH_/.test(worker));
});

// ── the run type on the rails (R41-7) ────────────────────────────────────────────────────

test('refresh run type: worker readmission_refresh is Bedrock-only on the rails, the exact Opus id enforced, n_per_tick forced to 1; budgets as ruled', async () => {
  assert.equal(planRunCreate({ worker: REFRESH_WORKER, model: NARRATIVE_MODEL, dayFrom: '2026-08-18', dayTo: '2026-08-18' }).ok, true);
  const v = planRunCreate({ worker: REFRESH_WORKER, model: 'vertex:gemini-2.5-pro', dayFrom: '2026-08-18', dayTo: '2026-08-18' });
  assert.equal(v.ok, false); assert.match((v as { error: string }).error, /R41-4/);
  const m = await import('../readmission/refresh.ts');
  const p = m.planRefreshRun({ model: NARRATIVE_MODEL, dayFrom: '2026-08-01', dayTo: '2026-08-18', nPerTick: 8 });
  assert.equal(p.ok, true); assert.equal((p as { nPerTick: number }).nPerTick, 1);
  const h = m.planRefreshRun({ model: 'bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0', dayFrom: '2026-08-01', dayTo: '2026-08-18' });
  assert.equal(h.ok, false); assert.match((h as { error: string }).error, /refresh run model must be/);
  assert.equal(REFRESH_N_PER_TICK, 1); assert.equal(REFRESH_LEG_BUDGET_MS, 40_000); assert.equal(REFRESH_NARRATIVE_BUDGET_MS, 50_000);
  // the box: assemble ≤30 s + 3 legs × 40 s + narrative 50 s = 200 s ≤ the 210 s soft-lock TTL and the 300 s route
  assert.ok(30_000 + 3 * REFRESH_LEG_BUDGET_MS + REFRESH_NARRATIVE_BUDGET_MS <= 210_000);
});

test('save is IN PLACE (the same UPDATE at dedup_key + engine 0.2, never an insert); narrative source refresh; PHI-clean; never auto-started', () => {
  const src = code('lib/readmission/refresh.ts');
  assert.match(src, /await saveAudit\(\{ dedupKey: row\.dedup_key, status: 'audited', finding, model, provider, traceId, promoted: seq\.promoted \}\)/);
  assert.match(src, /const saveAudit = deps\.saveAudit \?\? saveAuditResult;/);
  assert.ok(!/INSERT INTO/.test(src));
  assert.match(src, /narrativeSource: 'refresh'/);
  for (const col of ['patient_name', 'patient_mobile', 'telecom']) assert.ok(!new RegExp(`\\b${col}\\b`).test(src), `no ${col}`);
  const db13 = code('lib/readmission/db13.ts');
  const r41 = db13.slice(db13.indexOf('R4.1 — the refresh delta detector'));
  for (const col of ['patient_name', 'patient_mobile', 'telecom', 'uhid', 'component_json']) assert.ok(!new RegExp(`\\b${col}\\b`).test(r41.replace(/uhid \+ ipd_no; PAC uhid-window/, '')), `existence SQL section names no '${col}'`);
  const route = code('app/api/admin/readmission-refresh/route.ts');
  assert.match(route, /NEVER auto-started/); assert.ok(!/start_run/.test(code('vercel.json')));
  // the cron hook chains: OPD idle → narrative tick → (idle) → refresh tick
  const hook = code('app/api/admin/opd-audit-mini-backfill/route.ts');
  assert.match(hook, /'idle' in readmission && readmission\.idle\s*\n?\s*\? await refreshTick\(\)/);
});

// ── Addendum A1 — the attempt cap is complete ─────────────────────────────────────────────

test('A1 pure: refreshLanded — a targeted source that came back present / empty landed; all fetch_failed did not; no targets → landed', () => {
  assert.equal(refreshLanded({ ot: { status: 'present', count: 1 }, progress: { status: 'fetch_failed', count: 0 } }, ['ot', 'progress']), true);
  assert.equal(refreshLanded({ ot: { status: 'fetch_failed', count: 0 }, progress: { status: 'fetch_failed', count: 0 } }, ['ot', 'progress']), false);
  assert.equal(refreshLanded({ ot: { status: 'absent', count: 0 } }, ['ot']), false);
  assert.equal(refreshLanded(null, ['ot']), false);
  assert.equal(refreshLanded(null, []), true);
});

const seamRow = (attempts: number) => ({
  dedup_key: 'IP-1|IP-2', finding_class: 'even_even', index_encounter_id: 'IP-1', readmit_encounter_id: 'IP-2', form_uid: null, uhid: 'UH-1', lane: 'tight_bounce', gap_days: 4,
  index_department: 'Ortho', readmit_department: 'Ortho', index_doctor: null, readmit_doctor: null, index_discharge_at: '2026-06-01T10:00:00+05:30', readmit_admit_at: '2026-06-05T09:30:00+05:30',
  cm_note: null, form_is_planned: null, form_same_condition: null, finding: { refreshAttempts: attempts, templateCoverage: { ot: { status: 'absent', count: 0 }, pac: { status: 'absent', count: 0 }, progress: { status: 'absent', count: 0 } } }, audited_at: '2026-08-18T00:00:00Z',
});
const okAssembled = (cov?: unknown) => ({ inputs: { ...inputs, templateCoverage: cov }, indexAdmitAt: null, indexDischargeAt: '2026-06-01T10:00:00+05:30', identity: { names: [], uhids: [] } });
const trace = { start: async () => 't-1', finish: async () => {} };
const usage0 = async () => ({ tokensIn: 0, tokensOut: 0 });
type Written = Array<Record<string, unknown>>;
const recorder = (): { writes: Written; save: (k: string, a: Record<string, unknown>) => Promise<boolean> } => { const writes: Written = []; return { writes, save: async (_k, a) => { writes.push(a); return true; } }; };

test('A1: re-assemble failure on the save path books an attempt (n+1) and parks at the cap; the probe (save:false) writes nothing', async () => {
  const m = await import('../readmission/refresh.ts');
  const rec = recorder();
  const r = await m.reanalyzeOnOpus(seamRow(0) as never, { save: true }, { assemble: async () => ({ notAuditable: 'no index PDF' }), saveArtefacts: rec.save as never, trace: trace as never, usage: usage0 as never });
  assert.equal(r.ok, false); assert.match(r.reason!, /could not be re-assembled.*\(attempt 1\/3\)/);
  assert.equal(rec.writes[0].refreshAttempts, 1); assert.equal((rec.writes[0].lastRefreshError as { stuck: boolean }).stuck, false);
  const rec3 = recorder();
  const r3 = await m.reanalyzeOnOpus(seamRow(2) as never, { save: true }, { assemble: async () => ({ notAuditable: 'no index PDF' }), saveArtefacts: rec3.save as never, trace: trace as never, usage: usage0 as never });
  assert.match(r3.reason!, /attempt 3\/3 — parked as refresh_stuck/); assert.equal(rec3.writes[0].refreshAttempts, 3); assert.equal((rec3.writes[0].lastRefreshError as { stuck: boolean }).stuck, true);
  const probe = recorder();
  const p = await m.reanalyzeOnOpus(seamRow(0) as never, { save: false }, { assemble: async () => ({ notAuditable: 'no index PDF' }), saveArtefacts: probe.save as never, trace: trace as never, usage: usage0 as never });
  assert.equal(p.ok, false); assert.equal(probe.writes.length, 0, 'the probe never books attempts');
});

test('A1: DEC-2 model-disagreement refusal books an attempt and saves no finding', async () => {
  const m = await import('../readmission/refresh.ts');
  const rec = recorder(); let audits = 0;
  const r = await m.reanalyzeOnOpus(seamRow(1) as never, { save: true }, {
    assemble: async () => okAssembled() as never, pass: () => async () => claims(), served: async () => ({ model: 'gemini-2.5-pro', provider: 'gemini' }),
    saveAudit: async () => { audits++; return true; }, saveArtefacts: rec.save as never, trace: trace as never, usage: usage0 as never,
  });
  assert.equal(r.ok, false); assert.match(r.reason!, /DEC-2.*nothing saved \(attempt 2\/3\)/); assert.equal(audits, 0);
  assert.equal(rec.writes.length, 1); assert.equal(rec.writes[0].refreshAttempts, 2);
});

test('A1: in-place write failure books an attempt; a thrown / unparseable leg books an attempt', async () => {
  const m = await import('../readmission/refresh.ts');
  const rec = recorder();
  const r = await m.reanalyzeOnOpus(seamRow(0) as never, { save: true }, {
    assemble: async () => okAssembled() as never, pass: () => async () => claims(), served: async () => ({ model: 'global.anthropic.claude-opus-4-6-v1', provider: 'bedrock' }),
    saveAudit: async () => false, saveArtefacts: rec.save as never, trace: trace as never, usage: usage0 as never,
  });
  assert.equal(r.ok, false); assert.match(r.reason!, /in-place store write failed \(attempt 1\/3\)/); assert.equal(rec.writes[0].refreshAttempts, 1);
  const rec2 = recorder();
  const r2 = await m.reanalyzeOnOpus(seamRow(2) as never, { save: true }, {
    assemble: async () => okAssembled() as never, pass: () => async () => null, saveArtefacts: rec2.save as never, trace: trace as never, usage: usage0 as never,
  });
  assert.equal(r2.ok, false); assert.match(r2.reason!, /recon pass A unparseable.*attempt 3\/3 — parked as refresh_stuck/); assert.equal(rec2.writes[0].refreshAttempts, 3);
});

test('A1: a successful refresh that LANDED rows resets attempts to 0; one whose targeted sources all came back fetch_failed counts as an attempt (no reset) — and fetch_failed no longer pends, so it cannot loop', async () => {
  const m = await import('../readmission/refresh.ts');
  const compose = async () => ({ ok: true, valid: true, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, model: 'm', provider: 'bedrock' });
  const served = async () => ({ model: 'global.anthropic.claude-opus-4-6-v1', provider: 'bedrock' });
  const landed = recorder();
  const a = await m.reanalyzeOnOpus(seamRow(2) as never, { save: true, sources: ['ot'] }, {
    assemble: async () => okAssembled({ ot: { status: 'present', count: 2 }, pac: { status: 'absent', count: 0 }, progress: { status: 'absent', count: 0 } }) as never,
    pass: () => async () => claims(), served, saveAudit: async () => true, saveArtefacts: landed.save as never, compose: compose as never, trace: trace as never, usage: usage0 as never,
  });
  assert.equal(a.ok, true); assert.equal(landed.writes[0].refreshAttempts, 0); assert.equal((landed.writes[0].lastRefresh as { landed: boolean }).landed, true);
  const notLanded = recorder();
  const b = await m.reanalyzeOnOpus(seamRow(1) as never, { save: true, sources: ['ot'] }, {
    assemble: async () => okAssembled({ ot: { status: 'fetch_failed', count: 0 }, pac: { status: 'absent', count: 0 }, progress: { status: 'absent', count: 0 } }) as never,
    pass: () => async () => claims(), served, saveAudit: async () => true, saveArtefacts: notLanded.save as never, compose: compose as never, trace: trace as never, usage: usage0 as never,
  });
  assert.equal(b.ok, true); assert.equal(notLanded.writes[0].refreshAttempts, 2); assert.equal((notLanded.writes[0].lastRefresh as { landed: boolean }).landed, false);
  assert.match((notLanded.writes[0].lastRefreshError as { reason: string }).reason, /every targeted source came back fetch_failed/);
  // and the stored fetch_failed coverage is not a delta any more: rows-now on OT, coverage fetch_failed → not pending
  assert.deepEqual(refreshDelta({ ot: { status: 'fetch_failed', count: 0 } }, { ot: 2, pac: 0, progress: 0 }, 2), { pending: false, stuck: false, sources: [] });
});
