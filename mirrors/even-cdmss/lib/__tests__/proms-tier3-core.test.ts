import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreInstrument, scoreHouseItems, PROM_SCORING_VERSION,
} from '../proms/schedule-core';
import {
  compileItemBank, bankById, PROM_ITEM_BANK_VERSION, type BankItem,
} from '../proms/item-bank-core';
import {
  validateAdhocSelection, scoreAdhocSet, ADHOC_GEN_PROMPT, ADHOC_GEN_VERSION, ADHOC_MAX_ITEMS,
} from '../proms/adhoc-core';
import {
  HOUSE_SETS, SHARED_SCALES, VALIDATED_INSTRUMENTS, PREM_MODULE, type InstrumentDef,
} from '../proms/catalog';

// ── shared fixtures / oracle helpers (independent recompute; NOT the engine) ──────────────────────
const HS_IDS = Object.keys(HOUSE_SETS);
const VALIDATED_IDS = new Set(Object.keys(VALIDATED_INSTRUMENTS));
const PREM_IDS = new Set([PREM_MODULE.id, ...PREM_MODULE.items.map((i) => i.id)]);

/** Value that maps to option index `i` on a given scale (NRS-11 is numeric; else the shared array). */
function valueAt(scale: string, i: number): string {
  if (scale === 'NRS-11') return String(i);
  return SHARED_SCALES[scale as keyof typeof SHARED_SCALES][i];
}
/** Value that maps to the MAX (most severe) option on a scale — drives every ⚠ to trigger. */
function maxValue(scale: string): string {
  if (scale === 'NRS-11') return '10';
  const opts = SHARED_SCALES[scale as keyof typeof SHARED_SCALES];
  return opts[opts.length - 1];
}
/** Oracle mirror of schedule-core triggers() — kept independent so the regression pins real numbers. */
function refTriggers(scale: string, value: string): boolean {
  const v = value.trim();
  switch (scale) {
    case 'YN': return v === 'yes';
    case 'NRS-11': { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 8; }
    case 'S5-SEV': case 'S5-FRQ': { const i = SHARED_SCALES[scale].indexOf(v); return i >= 3; }
    case 'S5-CMP': return v === 'worse' || v === 'much worse';
    case 'DIET4': return v === 'liquids only' || v === 'barely';
    case 'SUPPORT3': return v === 'struggling';
    default: { const i = SHARED_SCALES[scale as keyof typeof SHARED_SCALES]?.indexOf(v) ?? -1; return i >= 3; }
  }
}
/** Oracle mirror of the house escalation map (verbatim from the frozen branch). */
function refEscalations(def: InstrumentDef, byId: Map<string, string>): string[] {
  const esc: string[] = [];
  for (const it of def.items) {
    const v = byId.get(it.id);
    if (v == null) continue;
    if (it.escalation && refTriggers(it.scale, v)) {
      if (it.escalation === 'always') esc.push('E5');
      else if (it.escalation === 'E2-with-item-3') {
        const fever = def.items.find((x) => x.scale === 'YN' && /fever/i.test(x.text || ''));
        if (fever && (byId.get(fever.id) || '').trim() === 'yes') esc.push('E2');
      } else esc.push(it.escalation);
    }
  }
  return Array.from(new Set(esc));
}
const sorted = (a: string[]) => [...a].sort();
/** Build responses that set every item of `def` to option index `i` (uniform profile). */
function uniform(def: InstrumentDef, i: number): { itemId: string; value: string }[] {
  return def.items.map((it) => ({ itemId: it.id, value: valueAt(it.scale, i) }));
}
/** Build responses that set every item to its most-severe option (red-flag profile). */
function redFlag(def: InstrumentDef): { itemId: string; value: string }[] {
  return def.items.map((it) => ({ itemId: it.id, value: maxValue(it.scale) }));
}
/** A genuine BankItem[] for a whole house set (bypasses the ≤6 selection cap for direct scoring). */
function asBankItems(def: InstrumentDef): BankItem[] {
  return def.items.map((it) => ({ id: it.id, text: it.text, scale: it.scale, escalation: it.escalation ?? null, sourceSet: def.id }));
}

// ── constants / versions ──────────────────────────────────────────────────────────────────────────
test('tier3 versions + max are stamped', () => {
  assert.equal(PROM_ITEM_BANK_VERSION, 'prom-item-bank/0.1');
  assert.equal(ADHOC_GEN_VERSION, 'adhoc-gen/0.1');
  assert.equal(ADHOC_MAX_ITEMS, 6);
});

// ── item-bank compile ───────────────────────────────────────────────────────────────────────────
test('compileItemBank is deterministic (twice → deep-equal)', () => {
  assert.deepEqual(compileItemBank(), compileItemBank());
});

test('bank is house-only: no validated-instrument id leaks in', () => {
  const bank = compileItemBank();
  for (const b of bank) assert.equal(VALIDATED_IDS.has(b.id), false, `validated id leaked: ${b.id}`);
});

test('bank is house-only: no PREM id leaks in', () => {
  const bank = compileItemBank();
  for (const b of bank) assert.equal(PREM_IDS.has(b.id), false, `PREM id leaked: ${b.id}`);
});

test('every bank item is sourced from an hs-set (never a validated set or PREM)', () => {
  const bank = compileItemBank();
  const keys = new Set(HS_IDS);
  for (const b of bank) {
    assert.equal(keys.has(b.sourceSet), true, `bad sourceSet: ${b.sourceSet}`);
    assert.equal(b.sourceSet.startsWith('hs-'), true);
  }
});

test('bank ids are unique (dedupe holds)', () => {
  const bank = compileItemBank();
  assert.equal(new Set(bank.map((b) => b.id)).size, bank.length);
});

test('bank covers all 21 hs-sets (item count = Σ set items, deduped)', () => {
  const bank = compileItemBank();
  const raw = HS_IDS.reduce((n, k) => n + HOUSE_SETS[k].items.length, 0);
  const uniqueRaw = new Set(HS_IDS.flatMap((k) => HOUSE_SETS[k].items.map((i) => i.id))).size;
  assert.equal(bank.length, uniqueRaw);
  assert.ok(bank.length <= raw && bank.length > 0);
});

test('bankById is first-wins and complete', () => {
  const bank = compileItemBank();
  const m = bankById(bank);
  assert.equal(m.size, bank.length);
  assert.equal(m.get(bank[0].id)!.id, bank[0].id);
});

test('every bank item scale exists in SHARED_SCALES', () => {
  for (const b of compileItemBank()) assert.ok(b.scale in SHARED_SCALES, `unknown scale: ${b.scale}`);
});

// ── validateAdhocSelection (T1: selection-only) ────────────────────────────────────────────────────
test('validate drops unknown ids', () => {
  const bank = compileItemBank();
  const good = bank[0].id;
  const set = validateAdhocSelection([good, '__nope__', 'zzz'], bank);
  assert.deepEqual(set.items.map((i) => i.id), [good]);
});

test('validate dedupes repeated ids', () => {
  const bank = compileItemBank();
  const good = bank[0].id;
  assert.deepEqual(validateAdhocSelection([good, good, good], bank).items.map((i) => i.id), [good]);
});

test('validate caps at ADHOC_MAX_ITEMS, preserving order', () => {
  const bank = compileItemBank();
  const ids = bank.slice(0, 8).map((b) => b.id);
  const set = validateAdhocSelection(ids, bank);
  assert.equal(set.items.length, ADHOC_MAX_ITEMS);
  assert.deepEqual(set.items.map((i) => i.id), ids.slice(0, ADHOC_MAX_ITEMS));
});

test('validate: zero valid ids → empty set', () => {
  const bank = compileItemBank();
  assert.deepEqual(validateAdhocSelection(['__x__', '__y__'], bank).items, []);
});

test('validate preserves selection order', () => {
  const bank = compileItemBank();
  const pick = [bank[4].id, bank[1].id, bank[9].id];
  assert.deepEqual(validateAdhocSelection(pick, bank).items.map((i) => i.id), pick);
});

test('validate is deterministic (twice → deep-equal)', () => {
  const bank = compileItemBank();
  const pick = bank.slice(2, 6).map((b) => b.id);
  assert.deepEqual(validateAdhocSelection(pick, bank), validateAdhocSelection(pick, bank));
});

// ── scoreAdhocSet (delegates to the house kernel) ──────────────────────────────────────────────────
test('scoreAdhocSet: house-sum correct on a fixture', () => {
  const bank = compileItemBank();
  const set = validateAdhocSelection(bank.slice(0, 3).map((b) => b.id), bank);
  const responses = set.items.map((it) => ({ itemId: it.id, value: valueAt(it.scale, 1) }));
  const out = scoreAdhocSet(set, responses);
  assert.equal(out.score, set.items.length);   // each item at option index 1 → sum = count
  assert.equal(out.scale, 'house');
  assert.equal(out.version, PROM_SCORING_VERSION);
});

test('scoreAdhocSet: any item unanswered → null (complete-gate)', () => {
  const bank = compileItemBank();
  const set = validateAdhocSelection(bank.slice(0, 4).map((b) => b.id), bank);
  const partial = set.items.slice(1).map((it) => ({ itemId: it.id, value: valueAt(it.scale, 1) }));
  assert.equal(scoreAdhocSet(set, partial).score, null);
});

test('scoreAdhocSet: a ⚠ item surfaces its escalation code', () => {
  // hs-wrist hw7 = YN 'E5'; select it and answer 'yes' → E5 surfaces.
  const bank = compileItemBank();
  const set = validateAdhocSelection(['hw7'], bank);
  assert.equal(set.items.length, 1);
  const out = scoreAdhocSet(set, [{ itemId: 'hw7', value: 'yes' }]);
  assert.deepEqual(out.escalations, ['E5']);
});

// ── generation prompt (data only) ──────────────────────────────────────────────────────────────────
test('ADHOC_GEN_PROMPT is present, selection-only, never-invent', () => {
  assert.equal(typeof ADHOC_GEN_PROMPT, 'string');
  assert.ok(ADHOC_GEN_PROMPT.length > 100);
  assert.match(ADHOC_GEN_PROMPT, /bank/i);
  assert.match(ADHOC_GEN_PROMPT, /never/i);
  assert.match(ADHOC_GEN_PROMPT, new RegExp(String(ADHOC_MAX_ITEMS)));
});

// ── REGRESSION (mandatory): all 21 hs-sets/0.2 sets score byte-identically through the extraction ───
test('regression: 21 sets — all-index-0 → score 0, escalations match the oracle', () => {
  assert.equal(HS_IDS.length, 21);
  for (const id of HS_IDS) {
    const def = HOUSE_SETS[id];
    const responses = uniform(def, 0);   // NB: YN=['yes','no'] so index 0 = 'yes' (a ⚠ trigger)
    const byId = new Map(responses.map((r) => [r.itemId, r.value]));
    const out = scoreInstrument(id, responses);
    assert.equal(out.score, 0, `${id} index-0 score`);   // optionIndex 0 for every scale → sum 0
    assert.equal(out.scale, 'house');
    assert.deepEqual(sorted(out.escalations), sorted(refEscalations(def, byId)), `${id} index-0 escalations`);
  }
});

test('regression: 21 sets — complete-midpoint (all index 1) → score = item count', () => {
  for (const id of HS_IDS) {
    const def = HOUSE_SETS[id];
    assert.equal(scoreInstrument(id, uniform(def, 1)).score, def.items.length, `${id} midpoint score`);
  }
});

test('regression: 21 sets — any item unanswered → null', () => {
  for (const id of HS_IDS) {
    const def = HOUSE_SETS[id];
    const partial = uniform(def, 1).slice(1);   // drop the first item
    assert.equal(scoreInstrument(id, partial).score, null, `${id} partial`);
  }
});

test('regression: 21 sets — red-flag escalations match the oracle AND kernel/adhoc agree with scoreInstrument', () => {
  for (const id of HS_IDS) {
    const def = HOUSE_SETS[id];
    const responses = redFlag(def);
    const byId = new Map(responses.map((r) => [r.itemId, r.value]));

    const viaInstrument = scoreInstrument(id, responses);
    const viaKernel = scoreHouseItems(def.items, byId);
    const viaAdhoc = scoreAdhocSet({ items: asBankItems(def) }, responses);
    const expectEsc = refEscalations(def, byId);

    // scoreInstrument matches the independent oracle (pins the exact codes + sum)
    assert.deepEqual(sorted(viaInstrument.escalations), sorted(expectEsc), `${id} escalations`);
    // single-source-of-truth: all three code paths agree byte-for-byte
    assert.equal(viaKernel.score, viaInstrument.score, `${id} kernel score`);
    assert.deepEqual(sorted(viaKernel.escalations), sorted(viaInstrument.escalations), `${id} kernel esc`);
    assert.equal(viaAdhoc.score, viaInstrument.score, `${id} adhoc score`);
    assert.deepEqual(sorted(viaAdhoc.escalations), sorted(viaInstrument.escalations), `${id} adhoc esc`);
  }
});
