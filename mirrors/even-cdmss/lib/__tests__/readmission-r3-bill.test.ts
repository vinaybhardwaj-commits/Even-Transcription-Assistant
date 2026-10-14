/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r3-bill.test.ts
 * R3 — the return-stay HOSPITAL BILL (CDMSS-READMISSIONS-R3-PRD v1.0 §3.5): formatBillRs ·
 * the four returnBill states through returnStayBill + the Bill chip (incl. the documented
 * `Bill pending` copy) · the ok:false → all-unknown path · the IN-list builder · the two
 * fetches through an injected runner (fault never throws) · PHI source-read on the R3
 * section of db13.ts · brief tables · OON and delayed-SSI unchanged in all three places.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BILL_CELL_SUB, BILLS_UNAVAILABLE_NOTICE, billChipState, chipText, coverageChips, formatBillRs, returnBillFor,
  returnStayBill, returnStayBillSub, type ReturnBill, type SurfaceFinding,
} from '../readmission-surface-core.ts';
import {
  BILL_IDS_CAP, billIdList, fetchStayBillBreakdown, fetchStayBillTotals, stayBillBreakdownSql, stayBillTotalsSql,
} from '../readmission/db13.ts';
import { BILL_SENTENCE_EVEN, BILL_SENTENCE_NO_SECOND_STAY, BILL_SENTENCE_NOT_FINALISED, BILL_SENTENCE_OON, billSentence, billTableLines, composeBrief, T_BILL } from '../readmission/brief.ts';

const f = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  dedupKey: 'IP-1|IP-2', findingClass: 'even_even', lane: 'structural_30d', auditStatus: 'audited',
  patientName: null, uhid: 'UH-1', ageGender: null, gapDays: 5,
  indexDepartment: 'Orthopaedics', readmitDepartment: 'Orthopaedics', indexDoctor: null, readmitDoctor: null,
  indexDischargeAt: '2026-06-01T10:00:00+05:30', readmitAdmitAt: '2026-06-06T10:00:00+05:30',
  payerIndex: 'Even', payerReadmit: 'Even', cmNote: null,
  planned: 'unplanned', sameCondition: 'same', avoidable: 'justified',
  labTier: 'tier1', labTimingProfile: 'has_late_labs', nOmissions: 0,
  needsHumanReview: false, promotedToFull: false, notAuditableReason: null,
  finding: null, omissionEvidence: null,
  ...over,
});
const billed = (netRs: number, lines = 40): ReturnBill => ({ state: 'billed', netRs, lines });
const NOT_FIN: ReturnBill = { state: 'not_finalised', netRs: null, lines: null };
const UNKNOWN: ReturnBill = { state: 'unknown', netRs: null, lines: null };
const NA: ReturnBill = { state: 'na', netRs: null, lines: null };
const chip = (row: SurfaceFinding) => coverageChips(row).find((c) => c.key === 'bill')!;

// ── formatBillRs (R3-1: no floor, as computed; en-IN grouping) ───────────────────

test('formatBillRs: en-IN grouping, paise kept, tiny values rendered as-is (no floor), negatives as computed', () => {
  assert.equal(formatBillRs(51968), '₹51,968');
  assert.equal(formatBillRs(184000), '₹1,84,000');
  assert.equal(formatBillRs(1780000), '₹17,80,000');
  assert.equal(formatBillRs(1), '₹1');            // V's ruling: no suppression of a stub bill
  assert.equal(formatBillRs(0), '₹0');            // only ever reached from a real zero SUM, never from null
  assert.equal(formatBillRs(1234.5), '₹1,234.5');
  assert.equal(formatBillRs(0.1 + 0.2), '₹0.3');  // float noise capped at the paise, not a rounding rule
  assert.equal(formatBillRs(-250), '₹-250');
});

// ── the ONE state mapping (R3-6) ─────────────────────────────────────────────────

test('returnBillFor: class → na · ok:false → unknown · no readmit id → unknown · id missing → not_finalised · present → billed', () => {
  const t = { netRs: 51968, lines: 40 };
  assert.deepEqual(returnBillFor({ findingClass: 'even_even', readmitEncounterId: 'IP-2', ok: true, total: t }), billed(51968, 40));
  assert.deepEqual(returnBillFor({ findingClass: 'even_even', readmitEncounterId: 'IP-2', ok: true, total: undefined }), NOT_FIN);
  assert.deepEqual(returnBillFor({ findingClass: 'even_even', readmitEncounterId: 'IP-2', ok: false, total: t }), UNKNOWN);   // a fault is never a figure
  assert.deepEqual(returnBillFor({ findingClass: 'even_even', readmitEncounterId: null, ok: true, total: null }), UNKNOWN);
  assert.deepEqual(returnBillFor({ findingClass: 'out_of_network', readmitEncounterId: null, ok: true, total: null }), NA);
  assert.deepEqual(returnBillFor({ findingClass: 'out_of_network', readmitEncounterId: 'IP-2', ok: true, total: t }), NA);   // class wins even with a total
  assert.deepEqual(returnBillFor({ findingClass: 'delayed_ssi', readmitEncounterId: null, ok: false, total: null }), NA);
});

test('the cell: billed → the figure (+ the sub line) · not_finalised → "bill not finalised" · unknown / no object → the R1 unknown · OON / delayed-SSI → n/a', () => {
  assert.equal(returnStayBill(f({ returnBill: billed(51968) })), '₹51,968');
  assert.equal(returnStayBillSub(f({ returnBill: billed(51968) })), BILL_CELL_SUB);
  assert.equal(BILL_CELL_SUB, 'hospital bill · net of refunds · fresh at load');
  assert.equal(returnStayBill(f({ returnBill: NOT_FIN })), 'bill not finalised');
  assert.equal(returnStayBillSub(f({ returnBill: NOT_FIN })), undefined);
  assert.equal(returnStayBill(f({ returnBill: UNKNOWN })), 'unknown — not yet measured');
  assert.equal(returnStayBill(f()), 'unknown — not yet measured');                    // pre-R3 caller: no object
  assert.equal(returnStayBill(f({ returnBill: null })), 'unknown — not yet measured');
  assert.equal(returnStayBill(f({ returnBill: NA })), 'unknown — not yet measured');   // na by state on an Even–Even row cannot happen; reads honestly, never a figure
  // a billed object with a non-finite figure is not a figure
  assert.equal(returnStayBill(f({ returnBill: { state: 'billed', netRs: null, lines: 3 } })), 'unknown — not yet measured');
  // OON / delayed-SSI: n/a whatever the object says
  assert.equal(returnStayBill(f({ findingClass: 'out_of_network', returnBill: billed(1) })), 'n/a');
  assert.equal(returnStayBillSub(f({ findingClass: 'out_of_network', returnBill: billed(1) })), undefined);
  assert.equal(returnStayBill(f({ findingClass: 'delayed_ssi', returnBill: billed(1) })), 'n/a');
});

test('the Bill chip (R3-7): billed → present · not_finalised → absent (copy "Bill pending", the ONE documented divergence) · unknown → unknown · OON / delayed-SSI → n/a', () => {
  assert.equal(chip(f({ returnBill: billed(51968) })).state, 'present');
  assert.equal(chipText(chip(f({ returnBill: billed(51968) }))), 'Bill');
  assert.equal(chip(f({ returnBill: NOT_FIN })).state, 'absent');
  assert.equal(chipText(chip(f({ returnBill: NOT_FIN }))), 'Bill pending');          // not "Bill none"
  assert.equal(chipText({ key: 'ot', label: 'OT', state: 'absent' }), 'OT none');    // every other chip unchanged
  assert.equal(chipText({ label: 'PAC', state: 'absent' }), 'PAC none');
  assert.equal(chip(f({ returnBill: UNKNOWN })).state, 'unknown');
  assert.equal(chip(f()).state, 'unknown');
  assert.equal(chip(f({ findingClass: 'out_of_network', returnBill: billed(1) })).state, 'n/a');
  assert.equal(chip(f({ findingClass: 'delayed_ssi', returnBill: billed(1) })).state, 'n/a');
  assert.equal(billChipState({ findingClass: 'even_even', returnBill: NA }), 'n/a');
  // the eight chips keep their order
  assert.deepEqual(coverageChips(f()).map((c) => c.key), ['index_ds', 'readmit_ds', 'labs', 'ot', 'pac', 'progress', 'post_ipd', 'bill']);
});

test('ok:false → EVERY card unknown (fail-safe demonstrated end-to-end through the mapping) — and the notice copy', () => {
  const rows = ['IP-2', 'IP-3', 'IP-4'].map((id) => returnBillFor({ findingClass: 'even_even', readmitEncounterId: id, ok: false, total: { netRs: 1, lines: 1 } }));
  assert.ok(rows.every((b) => b.state === 'unknown' && b.netRs === null));
  for (const b of rows) {
    assert.equal(returnStayBill(f({ returnBill: b })), 'unknown — not yet measured');
    assert.equal(chip(f({ returnBill: b })).state, 'unknown');
  }
  assert.equal(BILLS_UNAVAILABLE_NOTICE, 'Bill amounts are unavailable right now — cells show unknown');
});

// ── db13: IN-list builder, SQL, the two fetches through an injected runner ────────

test('billIdList: dedup, invalid ids dropped, order kept, capped at BILL_IDS_CAP', () => {
  assert.deepEqual(billIdList(['IP-2', 'IP-2', null, undefined, '', "IP'; DROP TABLE x; --", 'IPNO-229', 'a b', 'IP-2']), ['IP-2', 'IPNO-229']);
  assert.deepEqual(billIdList([]), []);
  const many = Array.from({ length: BILL_IDS_CAP + 50 }, (_, i) => `IP-${i}`);
  assert.equal(billIdList(many).length, BILL_IDS_CAP);
  assert.equal(BILL_IDS_CAP, 500);
});

test('SQL builders: empty → null (no query); the VALIDATED formula verbatim; quotes escaped; the breakdown groups by service_type', () => {
  assert.equal(stayBillTotalsSql([]), null);
  const sql = stayBillTotalsSql(['IP-2', "IP'3"])!;
  assert.match(sql, /SELECT visit_id_admission_id, SUM\(net_amt\) AS net, COUNT\(\*\)::int AS lines/);
  assert.match(sql, /FROM kx_billing_records/);
  assert.match(sql, /WHERE visit_id_admission_id IN \('IP-2', 'IP''3'\)/);
  assert.match(sql, /GROUP BY 1/);
  assert.doesNotMatch(sql, /status\s*=|WHERE[^]*status/);   // R3-4: NO status filter — refunds are negative, SUM is net
  assert.equal(stayBillBreakdownSql('not an id!'), null);
  const b = stayBillBreakdownSql('IP-2')!;
  assert.match(b, /SELECT service_type, SUM\(net_amt\) AS net, COUNT\(\*\)::int AS lines/);
  assert.match(b, /WHERE visit_id_admission_id = 'IP-2'/);
  assert.match(b, /GROUP BY 1\s+ORDER BY 2 DESC NULLS LAST/);
  assert.doesNotMatch(b, /billing_category/);   // the BED CLASS, not the service category
});

test('fetchStayBillTotals: empty input runs NO query; rows map; a faulting runner → { ok:false, empty } and never throws', async () => {
  let calls = 0;
  const empty = await fetchStayBillTotals([], async () => { calls++; return []; });
  assert.equal(calls, 0);
  assert.deepEqual(empty, { ok: true, totals: new Map() });
  const ok = await fetchStayBillTotals(['IP-2', 'IP-3', 'IP-2'], async (sql) => {
    calls++;
    assert.match(sql, /IN \('IP-2', 'IP-3'\)/);
    return [
      { visit_id_admission_id: 'IP-2', net: '51968.00', lines: 40 },   // numeric may arrive as a string
      { visit_id_admission_id: 'IP-3', net: 1, lines: '1' },
      { visit_id_admission_id: null, net: 5, lines: 1 },                // unusable row skipped
      { visit_id_admission_id: 'IP-9', net: 'abc', lines: 1 },          // unusable sum skipped
    ];
  });
  assert.equal(calls, 1);
  assert.equal(ok.ok, true);
  assert.deepEqual([...ok.totals.entries()], [['IP-2', { netRs: 51968, lines: 40 }], ['IP-3', { netRs: 1, lines: 1 }]]);
  const bad = await fetchStayBillTotals(['IP-2'], async () => { throw new Error('Metabase HTTP 500'); });
  assert.deepEqual(bad, { ok: false, totals: new Map() });
  // → through the mapping, the missing id on an ok read is not_finalised, and every id on a fault is unknown
  assert.equal(returnBillFor({ findingClass: 'even_even', readmitEncounterId: 'IP-7', ok: ok.ok, total: ok.totals.get('IP-7') }).state, 'not_finalised');
  assert.equal(returnBillFor({ findingClass: 'even_even', readmitEncounterId: 'IP-2', ok: bad.ok, total: bad.totals.get('IP-2') }).state, 'unknown');
});

test('fetchStayBillBreakdown: invalid id → null (no query); groups keep the route order, null service_type reads unclassified, total snaps to the paise; fault → ok:false, never throws', async () => {
  let calls = 0;
  assert.equal(await fetchStayBillBreakdown('bad id!', async () => { calls++; return []; }), null);
  assert.equal(calls, 0);
  const b = await fetchStayBillBreakdown('IP-2', async () => [
    { service_type: 'IP Package', net: 120000, lines: 1 },
    { service_type: 'Pharmacy', net: '12340.10', lines: 30 },
    { service_type: null, net: 0.2, lines: 2 },
    { service_type: 'Refund', net: -500, lines: 1 },
  ]);
  assert.deepEqual(b, {
    ok: true,
    groups: [
      { serviceType: 'IP Package', netRs: 120000, lines: 1 },
      { serviceType: 'Pharmacy', netRs: 12340.1, lines: 30 },
      { serviceType: 'unclassified', netRs: 0.2, lines: 2 },
      { serviceType: 'Refund', netRs: -500, lines: 1 },
    ],
    totalRs: 131840.3, lines: 34,
  });
  const none = await fetchStayBillBreakdown('IP-2', async () => []);
  assert.deepEqual(none, { ok: true, groups: [], totalRs: 0, lines: 0 });   // looked, no rows — the caller reads lines, not the zero
  const bad = await fetchStayBillBreakdown('IP-2', async () => { throw new Error('boom'); });
  assert.deepEqual(bad, { ok: false, groups: [], totalRs: 0, lines: 0 });
});

// ── PHI (R3-9): the R3 section of db13.ts names ONLY the six permitted columns ────

test('PHI source-read: the R3 bill readers SELECT only visit_id_admission_id / net_amt / amount / discount_amt / service_type / status; no PHI column, no insurer table, no billing.ts import', () => {
  const src = readFileSync(join(process.cwd(), 'lib/readmission/db13.ts'), 'utf8');
  const start = src.indexOf('R3 — the return-stay HOSPITAL BILL');
  assert.ok(start > 0, 'the R3 section marker exists');
  // The R3 section runs to the next section marker (R4's three-hop join, appended after it —
  // that section legitimately names the UHID as its join key and is pinned by its own test).
  const next = src.indexOf('R4 — the three-hop identity join', start);
  const r3 = src.slice(start, next > 0 ? next : undefined);
  for (const col of ['patient_name', 'patient_mobile', 'telecom', 'address_details', 'primary_email_address', 'secondary_email_address', 'employee_name', 'nationality', 'gender', 'age', 'uhid']) {
    assert.ok(!new RegExp(`\\b${col}\\b`).test(r3), `R3 section must not name '${col}'`);
  }
  // every column token that appears in a SELECT string of the section is on the allow-list
  const allowed = new Set(['visit_id_admission_id', 'net_amt', 'amount', 'discount_amt', 'service_type', 'status']);
  for (const sql of [stayBillTotalsSql(['IP-2'])!, stayBillBreakdownSql('IP-2')!]) {
    const selectList = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM'));
    for (const tok of selectList.match(/[a-z_]{3,}/g) ?? []) {
      if (['SUM', 'COUNT', 'AS', 'net', 'lines', 'int'].includes(tok) || /^(sum|count|as|net|lines|int)$/.test(tok)) continue;
      assert.ok(allowed.has(tok), `SELECT names '${tok}' which is not on the R3-9 list`);
    }
    assert.match(sql, /FROM kx_billing_records/);
  }
  // R3-10: the four insurer / claim tables are named in the section's prose (as ruled out) and
  // NOWHERE as a table a query reads from.
  for (const t of ['kx_claim_bills', 'dpipe_services', 'medical_ipd_claims', 'ipd_claims_v1']) {
    assert.ok(!new RegExp(`(FROM|JOIN)\\s+"?${t}\\b`).test(src), `db13.ts must not read ${t}`);
  }
  // no readmission code imports the throwing S7 billing module
  for (const file of ['lib/readmission/db13.ts', 'lib/readmission/brief.ts', 'lib/readmission/surface-row.ts', 'lib/readmission-surface-core.ts',
    'app/api/care/readmissions/list/route.ts', 'app/api/care/readmissions/case/route.ts', 'components/care/ReadmissionsBoard.tsx']) {
    const code = readFileSync(join(process.cwd(), file), 'utf8');
    assert.ok(!/from ['"][^'"]*ipd-audit\/billing['"]/.test(code), `${file} must not import lib/ipd-audit/billing`);
  }
});

// ── the brief (R3 §3.4) ──────────────────────────────────────────────────────────

const bd = (over: Partial<Parameters<typeof billTableLines>[1] & object> = {}) => ({
  ok: true, groups: [{ serviceType: 'IP Package', netRs: 120000, lines: 1 }, { serviceType: 'Pharmacy', netRs: 12340, lines: 30 }], totalRs: 132340, lines: 31, ...over,
});

test('billSentence: billed → the measured figure tagged (as-of only when a stamp is given); not_finalised → BILL_SENTENCE_NOT_FINALISED (Addendum A1); unknown / no object keep BILL_SENTENCE_EVEN; OON and no-second-stay unchanged', () => {
  assert.equal(billSentence(f({ returnBill: billed(51968) }), null), `Return stay bill: ₹51,968 — hospital bill, net of refunds. ${T_BILL}`);
  assert.equal(billSentence(f({ returnBill: billed(51968) }), '2026-08-18 10:00'), `Return stay bill: ₹51,968 — hospital bill, net of refunds, as of 2026-08-18 10:00. ${T_BILL}`);
  assert.equal(BILL_SENTENCE_NOT_FINALISED, 'Return stay bill not finalised — billing has not completed for this stay.');
  assert.equal(billSentence(f({ returnBill: NOT_FIN })), BILL_SENTENCE_NOT_FINALISED);
  assert.notEqual(BILL_SENTENCE_NOT_FINALISED, BILL_SENTENCE_EVEN);
  assert.equal(billSentence(f({ returnBill: UNKNOWN })), BILL_SENTENCE_EVEN);
  assert.equal(billSentence(f()), BILL_SENTENCE_EVEN);
  assert.equal(billSentence(f({ findingClass: 'out_of_network', returnBill: billed(1) })), BILL_SENTENCE_OON);
  assert.equal(billSentence(f({ findingClass: 'delayed_ssi', returnBill: billed(1) })), BILL_SENTENCE_NO_SECOND_STAY);
  assert.equal(T_BILL, '[hospital bill, db13]');
});

test('billTableLines: a table per stay, every line tagged, total row; null / fault → "not available"; looked-and-empty → "bill not finalised" (never ₹0)', () => {
  const lines = billTableLines('Index stay bill', bd());
  assert.deepEqual(lines, [
    `- Index stay bill — 31 line(s) ${T_BILL}`, '',
    '| Service | Net ₹ | Source |', '|---|---|---|',
    `| IP Package | ₹1,20,000 | ${T_BILL} |`,
    `| Pharmacy | ₹12,340 | ${T_BILL} |`,
    `| Total | ₹1,32,340 | ${T_BILL} |`, '',
  ]);
  for (const l of lines.filter((x) => x && !/^\|---/.test(x) && !/^\| Service/.test(x))) assert.ok(l.includes(T_BILL), l);
  assert.deepEqual(billTableLines('Return stay bill', null), [`- Return stay bill: not available ${T_BILL}`]);
  assert.deepEqual(billTableLines('Return stay bill', undefined), [`- Return stay bill: not available ${T_BILL}`]);
  assert.deepEqual(billTableLines('Return stay bill', bd({ ok: false, groups: [], totalRs: 0, lines: 0 })), [`- Return stay bill: not available ${T_BILL}`]);
  assert.deepEqual(billTableLines('Return stay bill', bd({ groups: [], totalRs: 0, lines: 0 })), [`- Return stay bill: bill not finalised ${T_BILL}`]);
  // a pipe in a service_type cannot break the table
  assert.match(billTableLines('X', bd({ groups: [{ serviceType: 'A|B', netRs: 1, lines: 1 }], totalRs: 1, lines: 1 }))[4], /^\| A\/B \| ₹1 \|/);
});

test('composeBrief: Even–Even billed → both tables + the measured sentence + Part 1 cell; OON → OON sentence, index table only, no return table, n/a everywhere; delayed-SSI → no-second-stay sentence, no return table', () => {
  const even = composeBrief({ row: f({ returnBill: billed(132340, 31) }), indexExtract: null, readmitExtract: null, indexBill: bd(), readmitBill: bd(), detailFetched: true });
  assert.match(even.markdown, /- Return stay bill: ₹1,32,340 \[finding row\]/);            // Part 1 Assessment cell
  assert.match(even.markdown, /- Bill: Return stay bill: ₹1,32,340 — hospital bill, net of refunds\. \[hospital bill, db13\]/);
  assert.match(even.markdown, /- Index stay bill — 31 line\(s\) \[hospital bill, db13\]/);
  assert.match(even.markdown, /- Return stay bill — 31 line\(s\) \[hospital bill, db13\]/);
  assert.match(even.markdown, /\| Hospital bill \| present \|/);   // R4.2: artefact rows in words
  // every rupee line carries the tag
  for (const l of even.markdown.split('\n').filter((x) => /₹/.test(x) && !/^\| Service \|/.test(x))) assert.ok(/\[hospital bill, db13\]|\[finding row\]/.test(l), l);
  const notFin = composeBrief({ row: f({ returnBill: NOT_FIN }), indexExtract: null, readmitExtract: null, indexBill: bd(), readmitBill: bd({ groups: [], totalRs: 0, lines: 0 }) });
  assert.match(notFin.markdown, /- Return stay bill: bill not finalised \[finding row\]/);
  assert.match(notFin.markdown, /\| Hospital bill \| pending — bill not finalised \|/);   // R4.2 wording; the card chip still reads "Bill pending"
  // A1: Part 2 agrees with Part 1 — the not-finalised sentence, and NOT the R1 "not yet measured" one.
  assert.match(notFin.markdown, new RegExp(`- Bill: ${BILL_SENTENCE_NOT_FINALISED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(notFin.markdown, new RegExp(BILL_SENTENCE_EVEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(notFin.markdown, /- Return stay bill: bill not finalised \[hospital bill, db13\]/);
  const unknown = composeBrief({ row: f({ returnBill: UNKNOWN }), indexExtract: null, readmitExtract: null, indexBill: null, readmitBill: null });
  assert.match(unknown.markdown, /- Return stay bill: unknown — not yet measured \[finding row\]/);
  assert.match(unknown.markdown, /- Index stay bill: not available \[hospital bill, db13\]/);
  assert.match(unknown.markdown, /- Return stay bill: not available \[hospital bill, db13\]/);
  assert.doesNotMatch(unknown.markdown, /₹/);
  const oon = composeBrief({ row: f({ findingClass: 'out_of_network', readmitDepartment: null, returnBill: NA }), indexExtract: null, readmitExtract: null, indexBill: bd(), readmitBill: null });
  assert.match(oon.markdown, new RegExp(BILL_SENTENCE_OON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(oon.markdown, /- Index stay bill — 31 line\(s\)/);
  assert.doesNotMatch(oon.markdown, /Return stay bill: not available|Return stay bill —/);
  assert.match(oon.markdown, /\| Hospital bill \| n\/a \|/);
  assert.match(oon.markdown, /Return stay bill: n\/a/);
  const ssi = composeBrief({ row: f({ findingClass: 'delayed_ssi', readmitDepartment: null, readmitAdmitAt: null, gapDays: null, returnBill: NA }), indexExtract: null, readmitExtract: null, indexBill: null, readmitBill: null });
  assert.match(ssi.markdown, new RegExp(BILL_SENTENCE_NO_SECOND_STAY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(ssi.markdown, /Return stay bill: not available|Return stay bill —/);
  assert.match(ssi.markdown, /\| Hospital bill \| n\/a \|/);
  assert.match(ssi.markdown, /Return stay bill: n\/a/);
});
