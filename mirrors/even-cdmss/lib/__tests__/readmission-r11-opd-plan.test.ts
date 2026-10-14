/**
 *   node --test --import tsx lib/__tests__/readmission-r11-opd-plan.test.ts
 *
 * R11 — the OPD plan of management reaches the readmission Ask agent
 * (CDMSS-READMISSIONS-R11-OPD-PLAN-HYDRATE-PRD-07-SEP-2026, R11-D1..R11-D6).
 *
 * WHAT BROKE. `renderOpdNote` rendered a prior clinic visit from the IPD med-rec whitelist: a visit
 * date and an ICD code, and nothing else. That whitelist has no plan column, so a staged
 * wound-closure plan written on the prescription could not reach the model — and the agent, reading
 * a blank, denied the plan existed. The distinction this whole file defends is the R10 one: an
 * absence in the render is not an absence in the record.
 *
 * WHAT THIS HOLDS STILL:
 *   HYDRATE   the plan text now renders (R11-D3), through the ONE existing parser + renderer pair;
 *             `dpipe_pom` first, the GP nested field as the fallback, exactly as the audit reads it.
 *   FALLBACK  a Metabase throw degrades to the pre-R11 thin render and warns once (R11-D2) — the
 *             reach never throws and never turns a failed read into "no plan documented".
 *   NO `plan` nothing reads a field named `plan`; `dpipe.plan` is a pipeline mode ("FREE"), not
 *             clinical text, and it must never appear in what the model is shown.
 *   FAIL LOUD row carries plan text, case carries none ⇒ one warn, then the text as it stands
 *             (R11-D6). No second plan parser is written anywhere.
 *   MEDS      the medication keys the audit uses (`brand_name` / `generic_name`) now survive; the
 *             thin render's `name|brand|generic` guess dropped every db13 drug name.
 *
 * Every uid here is synthetic and every row is hand-built. Nothing in this file touches db13.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOpdNote, renderOpdNoteThin } from '../readmission/records.ts';

// ── the stub reach ──────────────────────────────────────────────────────────────────────────────

const UID = 'opdplan0001';
const PLAN_SENTENCE = 'Regular dressings for 2-3 occasions followed by secondary suturing of wound.';

/** The one med-rec row `memoOpdRows` would return for this uid — the thin render's whole input. */
const MEDREC_ROW = { uid: UID, visit_date: '2026-07-06', diagnosis_icd_codes: ['Z48.81'], medications: null };

/** A RenderDeps stub. `fetchOpdNote` is the only dep the hydrate uses; `memoOpdRows` is the only one
 *  the fallback uses. The other three exist because the shape demands them, and are never called. */
const deps = (fetchOpdNote: (uid: string) => Promise<Record<string, unknown> | null>) => ({
  identity: { names: [], uhids: [] },
  individualUid: 'ind-synthetic',
  memoOpdRows: async () => ({ linked: true, prescriptionRows: [MEDREC_ROW] as Record<string, unknown>[], labRows: [] as Record<string, unknown>[] }),
  memoLabs: async () => [],
  memoSnapshot: async () => null,
  memoCareCalls: async () => [],
  fetchOpdNote,
});

const serving = (row: Record<string, unknown> | null) => deps(async () => row);

/** Run `fn` with console.warn captured. Returns what was warned, so a test can assert both that a
 *  warn fired AND — the harder half — that one did not. */
async function withWarnCapture<T>(fn: () => Promise<T>): Promise<{ value: T; warns: string[] }> {
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map((a) => String(a)).join(' ')); };
  try {
    const value = await fn();
    return { value, warns };
  } finally {
    console.warn = real;
  }
}

/** The gold row's shape, as `fetchOpdNoteByUid` returns it. `plan` is present and is NOT clinical
 *  text — it is the pipeline mode. It is here so "nothing reads `plan`" is an assertion, not a hope. */
const goldRow = (): Record<string, unknown> => ({
  uid: UID,
  timestamp: '2026-07-06T04:30:00Z',
  type_of_prescription: 'HOSPITAL_GP',
  is_draft: false,
  diagnosis_icd_codes: ['Z48.81'],
  medications: null,
  plan: 'FREE',
  dpipe_pom: [{ management_plan: PLAN_SENTENCE, requires_surgery_or_procedure: false }],
  general_practitioner_prescription__plan_of_management: [{ management_plan: `<p>${PLAN_SENTENCE}</p>` }],
});

// ── the six fixtures ────────────────────────────────────────────────────────────────────────────

test('1 · gold shape — the plan renders, the code survives, and the pipeline mode never leaks', async () => {
  const { value: text, warns } = await withWarnCapture(() => renderOpdNote(UID, serving(goldRow())));
  assert.match(text, /secondary suturing/);
  assert.match(text, /Z48\.81/);
  // `dpipe.plan` = 'FREE' is a pipeline mode. A renderer that read a field named `plan` would put it
  // in front of the model as if it were a clinical decision.
  assert.ok(!text.includes('FREE'), 'nothing may read a field named `plan`');
  assert.deepEqual(warns, [], 'a successful hydrate is silent');
});

test('2 · both plan fields null — the case says so plainly, and says it without warning', async () => {
  const row = { ...goldRow(), dpipe_pom: null, general_practitioner_prescription__plan_of_management: null };
  const { value: text, warns } = await withWarnCapture(() => renderOpdNote(UID, serving(row)));
  assert.match(text, /Clinician advice \/ plan: \(none documented\)/);
  assert.deepEqual(warns, [], 'a genuinely empty plan is an absence, not a fault');
});

test('3 · dpipe empty, the GP nested twin carries it — the fallback field is read', async () => {
  const row = { ...goldRow(), dpipe_pom: null };
  const { value: text, warns } = await withWarnCapture(() => renderOpdNote(UID, serving(row)));
  assert.match(text, /secondary suturing/);
  assert.deepEqual(warns, []);
});

test('4 · the fetch throws — the thin render, one warn, and never an exception (R11-D2)', async () => {
  const d = deps(async () => { throw new Error('Metabase HTTP 500'); });
  const { value: text, warns } = await withWarnCapture(() => renderOpdNote(UID, d));
  assert.equal(text, await renderOpdNoteThin(UID, d), 'a failed hydrate degrades to exactly the pre-R11 text');
  assert.match(text, /visit date: 2026-07-06/);
  assert.match(text, /diagnosis codes: Z48\.81/);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\[readmission-opd\]/);
  assert.match(warns[0], /Metabase HTTP 500/);
});

test('4b · no row for the uid — same degradation, its own warn', async () => {
  const { value: text, warns } = await withWarnCapture(() => renderOpdNote(UID, serving(null)));
  assert.match(text, /visit date: 2026-07-06/);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\[readmission-opd\] no row for uid/);
});

test('5 · medications — db13\'s own keys survive, where the thin render dropped every drug name', async () => {
  const row = {
    ...goldRow(),
    medications: [{ brand_name: 'Brand X', generic_name: 'genericum', dosage: '1 tab', frequency: 'BD', duration: '5 days' }],
  };
  const { value: text } = await withWarnCapture(() => renderOpdNote(UID, serving(row)));
  assert.ok(/Brand X/.test(text) || /genericum/.test(text), 'brand_name / generic_name must reach the model');
  // The thin render read `name|brand|generic` and would have emitted the dose with no drug attached.
  const thin = await renderOpdNoteThin(UID, serving(row));
  assert.ok(!/Brand X|genericum/.test(thin), 'the miss this round closes, pinned as it was');
});

test('6 · arrays present, text empty — an empty string is not plan text, so no warn', async () => {
  const row = {
    ...goldRow(),
    dpipe_pom: [{ management_plan: '', requires_surgery_or_procedure: false }],
    general_practitioner_prescription__plan_of_management: [{ management_plan: '' }],
  };
  const { value: text, warns } = await withWarnCapture(() => renderOpdNote(UID, serving(row)));
  assert.match(text, /Clinician advice \/ plan: \(none documented\)/);
  assert.deepEqual(warns, [], 'presence of the container is not presence of the plan');
});

// ── R11-D6, the branch the six fixtures leave unexercised ───────────────────────────────────────

test('R11-D6 — row holds plan text the case did not take: one warn, and the text as it stands', async () => {
  // Text under a key the parser does not read. This is the shape that would have been a silent loss:
  // the case renders "(none documented)" while the row plainly carries prose.
  const row = {
    ...goldRow(),
    dpipe_pom: [{ management_plan: '', notes_the_parser_does_not_read: 'staged closure over three visits' }],
    general_practitioner_prescription__plan_of_management: null,
  };
  const { value: text, warns } = await withWarnCapture(() => renderOpdNote(UID, serving(row)));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /\[readmission-opd\] plan text present in row but absent from case/);
  // Fail LOUD, not fail DIFFERENT: no second parser rescues the line, and the render is unchanged.
  assert.match(text, /Clinician advice \/ plan: \(none documented\)/);
  assert.ok(!text.includes('staged closure'), 'this file must never grow a second plan parser');
});
