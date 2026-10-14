/**
 *   node --test --import tsx lib/__tests__/provenance-grounding-label.test.ts
 *
 * Finding-card grounding label correction (ruling R-7, bug 9b, 28 Jul 2026).
 *
 * TWO classifiers live in lib/provenance-tier-core.ts. `groundingKind` (the FINDING CARD) returns
 * "internal corpus" on citation PRESENCE alone — MEASURED: 30,927 of 37,549 LLM findings (82.4%)
 * rendered "Internal corpus reference" with no test that the cited source supports the claim
 * (exhibits: a cough-syrup finding citing an iron-deficiency review; a high-value cholecalciferol
 * finding citing a wound protocol naming no vitamin D). `classifyProvenanceTier` (the LEDGER) is
 * HONEST — it never reads citation_ids — and must not move by a byte.
 *
 * This change corrects the CLAIM (wording only); the support check itself is phase 3 of the audit
 * integrity batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  GROUNDING_PRESENTATION, groundingKind, classifyProvenanceTier, PROVENANCE_TIER_LABELS,
  PROVENANCE_TIERS,
} from '../provenance-tier-core.ts';
import { OPD_ENGINE_VERSION } from '../opd-note-audit-core.ts';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The two new labels, verbatim — and the two untouched ones, byte-identical
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the citation-derived labels carry the caveat, VERBATIM per the kickoff', () => {
  assert.equal(GROUNDING_PRESENTATION.external_source.label, 'External source (support not verified)');
  assert.equal(GROUNDING_PRESENTATION.internal_corpus.label, 'Internal corpus citation (support not verified)');
});

test('deterministic_rule and no_source labels are BYTE-IDENTICAL to before', () => {
  assert.equal(GROUNDING_PRESENTATION.deterministic_rule.label, 'Deterministic rule');
  assert.equal(GROUNDING_PRESENTATION.no_source.label, 'Clinical reasoning — no source');
});

test('all four `elevated` values are unchanged — this is wording, not ranking', () => {
  assert.equal(GROUNDING_PRESENTATION.deterministic_rule.elevated, true);
  assert.equal(GROUNDING_PRESENTATION.external_source.elevated, true);
  assert.equal(GROUNDING_PRESENTATION.internal_corpus.elevated, false);
  assert.equal(GROUNDING_PRESENTATION.no_source.elevated, false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · groundingKind LOGIC is untouched — all four kinds, fixture-pinned
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('groundingKind returns the same kind for the same input as before — all four kinds', () => {
  // mechanism certainty first
  assert.equal(groundingKind({ source: 'deterministic', citation_ids: [1] }, true), 'deterministic_rule');
  assert.equal(groundingKind({ source: 'deterministic' }, false), 'deterministic_rule');
  // then external (the L7 resolvability verdict), regardless of citation ids
  assert.equal(groundingKind({ citation_ids: [3] }, true), 'external_source');
  assert.equal(groundingKind({}, true), 'external_source');
  // then internal corpus on citation presence (the presence test the caveat exists for)
  assert.equal(groundingKind({ citation_ids: [1, 2] }, false), 'internal_corpus');
  // then nothing
  assert.equal(groundingKind({ citation_ids: [] }, false), 'no_source');
  assert.equal(groundingKind({}, false), 'no_source');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE LEDGER WAS NOT TOUCHED — labels byte-identical, classifier behaviour pinned
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('PROVENANCE_TIER_LABELS is byte-identical — the ledger map was not touched', () => {
  assert.deepEqual(PROVENANCE_TIER_LABELS, {
    deterministic: 'Deterministic — resolvable external citation',
    clinician_signed: 'Clinician-signed — a named clinician stands behind this entry',
    category_authority: 'Category authority — society citation at category level',
    internal_consensus: 'Internal consensus — self-mined rule / marked internally-derived',
    uncited_deterministic: 'Deterministic check — no citation attached',
    deterministic_completeness: 'Deterministic completeness check — no external authority exists',
    deterministic_logical: 'Deterministic logical check — evidence is the prescription itself',
    unattributed_sourceable: 'Unattributed — sourceable (a catalog entry could exist)',
    inherent_judgment: 'Inherent clinical judgement — cannot be cited by any catalog',
  });
  assert.equal(PROVENANCE_TIERS.length, 9, 'no tier added or removed');
});

test('classifyProvenanceTier is untouched: never reads citation_ids, same verdicts on a fixture', () => {
  const src = readFileSync('lib/provenance-tier-core.ts', 'utf8');
  const fn = src.slice(src.indexOf('export function classifyProvenanceTier'), src.indexOf('// ── Citation-source provenance tier'));
  assert.ok(!fn.includes('citation_ids'), 'THE HONESTY PROPERTY: the ledger classifier never reads citation_ids');
  // Behaviour fixture — an LLM finding with citations earns NOTHING in the ledger:
  assert.equal(classifyProvenanceTier({ verdict: 'low-value' }), 'unattributed_sourceable');
  assert.equal(classifyProvenanceTier({ verdict: 'high-value' }), 'unattributed_sourceable');
  assert.equal(classifyProvenanceTier({ rule_ref: 'r1' }, { citation_doi: '10.1/x' }), 'deterministic');
  assert.equal(classifyProvenanceTier({ rule_ref: 'r1' }, null), 'internal_consensus');
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'incomplete_dosing' }), 'deterministic_completeness');
  assert.equal(classifyProvenanceTier({ source: 'deterministic', signal_type: 'duplicate_molecule' }), 'deterministic_logical');
  assert.equal(classifyProvenanceTier({ source: 'deterministic' }), 'uncited_deterministic');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The caveat line + no bare strings anywhere
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CAVEAT = 'A citation label records that a source was attached to a finding. It does not verify that the source supports the finding. A support check is in build.';

test('the page-level caveat renders ONCE per page, verbatim, in the findings area', () => {
  const page = readFileSync('app/admin/opd-audit/[id]/page.tsx', 'utf8');
  assert.equal(page.split(CAVEAT).length - 1, 1, 'exactly one occurrence — once per page, not per finding');
  const findingsIdx = page.indexOf('id="findings"');
  assert.ok(page.indexOf(CAVEAT) > findingsIdx, 'in the findings area');
});

test('GREP TEST: no surface renders the bare pre-caveat strings, and the map has ONE home', () => {
  // Walk app/ + lib/ + components/ (code files, tests excluded) — grep is unreliable here (G1).
  const bare: string[] = [];
  const mapHomes: string[] = [];
  let walked = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', '.git', '__tests__'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      // The release changelog QUOTES the labels the L8/L9 build shipped with — a historical record
      // of what was true then, not a live label surface. Rewriting it would falsify history, and
      // the R-7 file contract forbids touching it. Every LIVE surface reads GROUNDING_PRESENTATION.
      if (p.endsWith('opd-audit-changelog.ts')) continue;
      walked++;
      const s = readFileSync(p, 'utf8');
      // The OLD labels must not survive anywhere as rendered strings.
      if (s.includes("'Internal corpus reference'") || s.includes('"Internal corpus reference"')) bare.push(p);
      if (s.includes("'External source'") || s.includes('"External source"')) bare.push(p);
      if (s.includes('GROUNDING_PRESENTATION = ') || s.includes('GROUNDING_PRESENTATION: Record')) mapHomes.push(p);
    }
  };
  walk('app'); walk('lib'); walk('components');
  assert.ok(walked > 400, `the walk must actually cover the tree (walked ${walked})`);
  assert.deepEqual(bare, [], 'no bare pre-caveat label may render anywhere');
  assert.equal(mapHomes.length, 1, 'the map is defined once — the UI and any future reader cannot disagree');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · No engine bump, no scoring change
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the label correction itself rode no bump — the version only moves for scoring changes', () => {
  // R-7 shipped at 0.81.15 with no bump. 0.81.16 is the audit-integrity phase-0 quantization
  // revert — a SCORING change, which is exactly what the version exists to name.
  assert.match(OPD_ENGINE_VERSION, /^opd-note-audit\/0\.81\.\d+$/);
});

test('the provenance ledger page still reads ONLY the ledger map', () => {
  const ledger = readFileSync('app/admin/provenance/page.tsx', 'utf8');
  assert.ok(ledger.includes('PROVENANCE_TIER_LABELS'));
  assert.ok(!ledger.includes('GROUNDING_PRESENTATION'), 'the two maps must not cross surfaces');
});
