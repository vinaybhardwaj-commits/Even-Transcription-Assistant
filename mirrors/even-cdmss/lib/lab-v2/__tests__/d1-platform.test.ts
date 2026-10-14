/**
 * LAB-MCP-V2 §17.8 round D1 — the platform half: `data_scope` (decision 105), the denylist gap
 * (decision 101), the unfenced document read (decision 102) and the two new engines (item 4).
 *
 * ⚠️ TWO OF THESE TEST THINGS THAT WERE LIVE AND WRONG, not things this round designed.
 * Decision 101's ten keys were accepted by `freezeRequestCase` on `c0f59fd0` and would have been
 * stored in a de-identified research object; decision 102's `generateFromDocument` would have made
 * a real, unmetered Vertex call on a patient's discharge PDF from inside a research context. Both
 * are asserted against the shipped code, not against a description of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENGINE_STAGES, IDENTIFYING_PRINCIPALS_ENV, LabError, NEVER_IDENTIFYING, SUPPORTED_ENGINES,
} from '../contracts';
import { dataScopeFor, identifyingPrincipals, mayUseIdentifyingInput } from '../../mcp-v2/auth';
import { callCarriesIdentifyingInput } from '../service';
import { freezeRequestCase, identifyingKeys, requiresIdentifyingInput } from '../sources/requests';
import { withLabExecution, labExecution } from '../../lab-execution-context';
import { generateFromDocument } from '../../gemini-multimodal';
import { SCOPES_BY_PRINCIPAL } from '../contracts';
import { ALL_ADAPTERS } from '../adapters/types';
import { BY_NAME, visibleTools } from '../registry';

const ROOT = process.cwd();
const EDGES = { chat: async () => ({}), retrieve: async () => ({ hits: [] }), event: () => {} };

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 105 — data_scope
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.8 decision 105: the list is empty by default and grants nothing', () => {
  assert.deepEqual([...identifyingPrincipals({})], []);
  assert.deepEqual([...identifyingPrincipals({ [IDENTIFYING_PRINCIPALS_ENV]: '' })], []);
  assert.deepEqual([...identifyingPrincipals({ [IDENTIFYING_PRINCIPALS_ENV]: '   ' })], []);
  for (const p of ['research', 'operator', 'reviewer', 'release'] as const) {
    assert.equal(dataScopeFor(p, {}), 'deidentified', `${p} starts de-identified`);
    assert.equal(mayUseIdentifyingInput(p, {}), false);
  }
});

test('§17.8 decision 105: `research` in the list is REFUSED at load, by name', () => {
  const env = { [IDENTIFYING_PRINCIPALS_ENV]: 'operator,research' };
  assert.throws(() => identifyingPrincipals(env), (e: LabError) => (
    e.code === 'CLASSIFICATION_REQUIRED'
    && e.message.includes('research')
    && /may never hold data_scope/.test(e.message)
  ));
  // ⚠️ REFUSED, NOT FILTERED. A deployment that asked for something impossible is told so; quietly
  // dropping the name would leave V believing the research key had been granted something.
  assert.throws(() => dataScopeFor('operator', env));
  assert.deepEqual([...NEVER_IDENTIFYING], ['research']);
});

test('§17.8 decision 105: an unknown name is refused too, so a typo is not a silent no-op', () => {
  assert.throws(() => identifyingPrincipals({ [IDENTIFYING_PRINCIPALS_ENV]: 'operater' }),
    (e: LabError) => e.code === 'CLASSIFICATION_REQUIRED' && /is not a principal/.test(e.message));
});

test('§17.8 decision 105: `operator` on the list passes; off it, refused with the name', () => {
  const on = { [IDENTIFYING_PRINCIPALS_ENV]: 'operator' };
  assert.deepEqual([...identifyingPrincipals(on)], ['operator']);
  assert.equal(dataScopeFor('operator', on), 'identifying');
  assert.equal(mayUseIdentifyingInput('operator', on), true);
  // ⚠️ BOTH CONDITIONS. `reviewer` holds production_read and is not on the list; `release` holds it
  // and is not on the list either. The env narrows an existing authority, it never grants one.
  assert.equal(mayUseIdentifyingInput('reviewer', on), false);
  assert.equal(dataScopeFor('operator', {}), 'deidentified', 'and off the list it is back to de-identified');
});

test('§17.8 decision 105: the gate is per CALL, not per tool — a de-identified engine is open', () => {
  // ⚠️ THE BLUNT VERSION OF THIS CHECK CLOSED dataset_create FOR EVERY ENGINE, and the suite said
  // so on its first run. Decision 101's words are that the ENGINE decides.
  assert.equal(callCarriesIdentifyingInput({ engine: 'ask' }), false);
  assert.equal(callCarriesIdentifyingInput({ engine: 'opd_note_audit' }), false);
  assert.equal(callCarriesIdentifyingInput({ engine: 'readmission' }), true);
  assert.equal(callCarriesIdentifyingInput({ engine: 'preop' }), true);
  assert.equal(callCarriesIdentifyingInput({ engine: 'ipd_discharge' }), true);
  // Fails closed on absence and on a name this platform does not know.
  assert.equal(callCarriesIdentifyingInput({}), true);
  assert.equal(callCarriesIdentifyingInput({ engine: 'not_an_engine' }), true);
  assert.equal(callCarriesIdentifyingInput(null), true);
});

test('§17.8 decision 105: dataset_create is the tool that declares identifying_input', () => {
  assert.equal(BY_NAME.dataset_create.identifying_input, true);
  /**
   * ⚠️ RULE 1a, §17.11 DECISION 146 — 'dataset_create' → THREE, and the two new ones are stronger
   * than it, not weaker. This asserted the flag was carried by exactly one tool, because marking
   * tools that never see a person would make it mean nothing. `case_ask` and `case_timeline` are
   * the first tools whose WHOLE INPUT is a person, so they carry it and they also carry
   * `identifying_always`: `dataset_create` is narrowed by the engine a call names (seven of its ten
   * take a de-identified body), and these two have no such case. The set is still closed and this
   * is still where a fourth would be noticed.
   */
  const marked = Object.values(BY_NAME).filter((s) => s.identifying_input === true).map((s) => String(s.name)).sort();
  assert.deepEqual(marked, ['case_ask', 'case_timeline', 'dataset_create']);
  // And the always-flag is carried by the two, never by dataset_create.
  const always = Object.values(BY_NAME).filter((s) => s.identifying_always === true).map((s) => String(s.name)).sort();
  assert.deepEqual(always, ['case_ask', 'case_timeline']);
  assert.notEqual(BY_NAME.dataset_create.identifying_always, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 101 — the ten keys
// ═════════════════════════════════════════════════════════════════════════════════════

const DECISION_101_KEYS = [
  'documentId', 'document_id', 'ipUid', 'ip_uid', 'dedup_key', 'dedupKey',
  'episodeKey', 'episode_key', 'individualUid', 'individual_uid',
] as const;

test('§17.8 decision 101: each of the ten keys, alone in a body, is refused', () => {
  for (const key of DECISION_101_KEYS) {
    assert.deepEqual(identifyingKeys({ [key]: 'x' }), [key], `${key} must be on the denylist`);
    assert.throws(() => freezeRequestCase('ask', { [key]: 'x' }), (e: LabError) => (
      e.code === 'CLASSIFICATION_REQUIRED' && e.message.includes(key)
    ), `${key} must be refused by freezeRequestCase`);
  }
  // Nested, at depth, and inside an array — the walk was already right and must stay right.
  assert.deepEqual(identifyingKeys({ a: { b: [{ dedup_key: 1 }] } }), ['dedup_key']);
});

test('§17.8 decision 101: the four that already matched still match, and the safe ones still do not', () => {
  for (const key of ['memberId', 'member_id', 'encounter_id', 'uhid']) {
    assert.deepEqual(identifyingKeys({ [key]: 'x' }), [key]);
  }
  // ⚠️ `key` WAS ADDED AS A SUFFIX ONLY TO THE ENCOUNTER GROUP, and this is why. `case_key` is this
  // platform's own de-identified handle and rides on every frozen case; widening the pattern to a
  // bare `key` would have refused every dataset the platform has ever made.
  for (const safe of ['case_key', 'key', 'arm_hash', 'run_id', 'item_id', 'engine', 'question']) {
    assert.deepEqual(identifyingKeys({ [safe]: 'x' }), [], `${safe} must NOT be on the denylist`);
  }
});

test('§17.8 decision 101: the three D engines require identifying input; the seven wired before do not', () => {
  for (const e of ['ipd_discharge', 'readmission', 'preop'] as const) {
    assert.equal(requiresIdentifyingInput(e), true, `${e} cannot run without an identifier`);
  }
  for (const e of ['opd_note_audit', 'ask', 'ddx', 'appropriateness', 'pathway', 'doc_audit', 'ipd_episode'] as const) {
    assert.equal(requiresIdentifyingInput(e), false, `${e} must stay open to the research key`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 102 — the unfenced document read
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.8 decision 102: generateFromDocument throws LAB_IO_FORBIDDEN inside the fence', async () => {
  await withLabExecution(EDGES, async () => {
    await assert.rejects(
      () => generateFromDocument('sys', 'user', 'YmFzZTY0', 'application/pdf'),
      (e: LabError) => e instanceof LabError && e.code === 'LAB_IO_FORBIDDEN',
    );
  });
  // ⚠️ AND IT THROWS RATHER THAN RETURNING NULL, even though every caller reads null as
  // "unreadable". A null would be indistinguishable from a PDF that could not be read, so a lab
  // run would have produced a case with no extract and scored it.
  assert.equal(labExecution(), undefined, 'and outside a context it is its ordinary self');
});

test('§17.8 decision 102: the static isolation list carries all three guarded functions', () => {
  const guarded: [string, string][] = [
    ['lib/db.ts', 'production sql inside lab execution'],
    ['lib/metabase.ts', 'db13 read inside lab execution'],
    ['lib/gemini-multimodal.ts', 'document read inside lab execution'],
  ];
  for (const [file, message] of guarded) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(src.includes(`if (labExecution()) throw new LabError('LAB_IO_FORBIDDEN', '${message}')`),
      `${file} must carry the §7 guard verbatim`);
  }
  // The survey's finding, pinned: this was the ONE model path in the three D engines that did not
  // go through lib/trace.ts. If a fourth appears, it belongs on this list the day it is written.
  const doc = readFileSync(join(ROOT, 'lib/doc-audit.ts'), 'utf8');
  assert.ok(doc.includes('generateFromDocument'), 'lib/doc-audit.ts is still the caller the guard protects');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 4 — the two engines
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.8 item 4: readmission and preop are supported, adapted and priced; and D2b adds the third', () => {
  for (const e of ['readmission', 'preop'] as const) {
    assert.ok(SUPPORTED_ENGINES.includes(e), `${e} is supported`);
    assert.ok(ALL_ADAPTERS()[e], `${e} has an adapter`);
    assert.ok((ENGINE_STAGES[e] ?? []).length > 0, `${e} declares stages`);
  }
  // ⚠️ RULE 1a, §17.9 DECISION 117(a). D1 asserted `ipd_discharge` was held BACK; D2b wires it,
  // so the assertion inverts rather than disappears — the third Slice D engine is supported,
  // adapted and priced on exactly the terms the other two are.
  assert.ok(SUPPORTED_ENGINES.includes('ipd_discharge'), 'decision 117(a) wired it in D2b');
  assert.ok(ALL_ADAPTERS().ipd_discharge, 'and it has an adapter');
  assert.equal((ENGINE_STAGES.ipd_discharge ?? []).length, 8, 'decision 124: eight labels');

  assert.deepEqual((ENGINE_STAGES.readmission ?? []).map((s) => s.name),
    ['readmit_oon', 'readmit_condition', 'readmit_recon_a', 'readmit_recon_b']);
  assert.deepEqual((ENGINE_STAGES.preop ?? []).map((s) => s.name), ['preop_suggest', 'preop_narrative']);
  // ⚠️ EVERY ONE OF THE SIX IS CONDITIONAL, AND THAT IS THE HONEST MARKING. Exactly one of three
  // readmission paths fires per finding, and both preop legs sit behind flags. §35a still requires
  // an arm to price all of them: an arm that priced only the recon pair would refuse the first
  // out-of-network case it met.
  for (const e of ['readmission', 'preop'] as const) {
    for (const st of ENGINE_STAGES[e] ?? []) assert.equal(st.conditional, true, `${e}.${st.name}`);
  }
  // Decision 104 — the narrative leg is out of scope for D1, so it is NOT priced.
  assert.ok(!(ENGINE_STAGES.readmission ?? []).some((s) => s.name === 'readmit_narrative'));
});

// ═════════════════════════════════════════════════════════════════════════════════════
// D1 FIX 1 — DECISION 108
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.8 decision 108: the operator can now run an identifying experiment end to end', () => {
  /**
   * ⚠️ THE BUG THIS CLOSES WAS A GAP BETWEEN TWO DECISIONS, NOT INSIDE EITHER.
   *
   * Decision 105 makes `operator` the only principal that may send an identifier — `research` holds
   * `research_write` and may NEVER hold the attribute. But a Slice D run needs `dataset_create`,
   * then `experiment_create`, then `experiment_run`, and all three are `research_write`, which
   * `operator` did not have. Measured live on `c7f353af`: `operator` saw 33 tools and none of the
   * three, so no principal could run an identifying experiment at all.
   */
  const operator = visibleTools(SCOPES_BY_PRINCIPAL.operator).map((t) => String(t.name));
  for (const tool of ['dataset_create', 'experiment_create', 'experiment_run']) {
    assert.ok(operator.includes(tool), `the operator must see ${tool} or Slice D has no reachable path`);
  }
  // And the attribute is what actually lets the identifier through — the scope alone does not.
  assert.equal(mayUseIdentifyingInput('operator', {}), false, 'off the list, still refused');
  assert.equal(mayUseIdentifyingInput('operator', { [IDENTIFYING_PRINCIPALS_ENV]: 'operator' }), true);

  // ⚠️ RESEARCH GAINS NOTHING. The two rows are separate, and the key that may never see a person
  // is byte-identical to what it was.
  assert.deepEqual([...SCOPES_BY_PRINCIPAL.research], ['research_read', 'research_write', 'production_read']);
  assert.throws(() => mayUseIdentifyingInput('research', { [IDENTIFYING_PRINCIPALS_ENV]: 'research' }));

  // ⚠️ AND THE OPERATOR STILL DOES NOT HOLD THE TWO SCOPES THAT CHANGE WHAT A CLINICIAN SEES.
  // `research_write` is not `release` and is not `review`; activation and approval are untouched.
  assert.ok(!SCOPES_BY_PRINCIPAL.operator.includes('release'));
  assert.ok(!SCOPES_BY_PRINCIPAL.operator.includes('review'));
  for (const tool of ['release_prepare', 'release_apply', 'release_rollback', 'review_submit', 'review_queue']) {
    assert.ok(!operator.includes(tool), `the operator must not see ${tool}`);
  }

  // The reviewer and release rows are untouched, and so are their tool counts.
  assert.deepEqual([...SCOPES_BY_PRINCIPAL.reviewer], ['review', 'research_read', 'production_read']);
  assert.deepEqual([...SCOPES_BY_PRINCIPAL.release], ['release', 'production_read']);
  assert.equal(visibleTools(SCOPES_BY_PRINCIPAL.reviewer).length, 32);
  assert.equal(visibleTools(SCOPES_BY_PRINCIPAL.release).length, 13);
  // ⚠️ RULE 1a, §17.11 — 39 → 42. D3 adds case_ask, case_timeline and failure_minimize, all three
  // `research_write`-scoped, which is the scope research and operator hold and the other two do
  // not. The reviewer and release counts above are unchanged BY CONSTRUCTION rather than by luck,
  // and that is what this trio of assertions is for.
  assert.equal(visibleTools(SCOPES_BY_PRINCIPAL.research).length, 42);
});

test('§17.8 decision 108: the operator gains NINE tools, not three, and that is reported', () => {
  /**
   * ⚠️ THE DECISION NAMES THREE AND THE SCOPE GRANTS NINE, because a scope is not a list of tools.
   * The other six ride along by construction: run_cancel, run_retry, run_replay, episode_replay,
   * corpus_stage and rule_propose. It is a real widening and it is pinned here rather than absorbed
   * — if a tenth appears, this test says so.
   *
   * It is not a privilege escalation. `operator` already holds `production_write`, the stronger
   * authority; and both staging tools stage into QUARANTINE — `corpus_stage` writes rows that are
   * `visible = false` under a `labq:` prefix, and `rule_propose` writes a proposal that
   * `lvc_recommendations` never sees. Activating either needs `release`, which the operator does
   * not hold and does not gain.
   */
  const gained = visibleTools(SCOPES_BY_PRINCIPAL.operator)
    .filter((t) => t.scopes.includes('research_write') && !t.scopes.some((s) => (['production_read', 'production_write', 'research_read'] as string[]).includes(s)))
    .map((t) => String(t.name)).sort();
  // ⚠️ RULE 1a, §17.11 — NINE → TWELVE. D3's three are `research_write` and nothing else, for the
  // reason the decision gives: `production_read` would have shown the two case tools to the
  // reviewer and release keys as well. So they land in exactly this list, which is what it is for.
  assert.deepEqual(gained, [
    'case_ask', 'case_timeline', 'corpus_stage', 'dataset_create', 'episode_replay',
    'experiment_create', 'experiment_run', 'failure_minimize',
    'rule_propose', 'run_cancel', 'run_replay', 'run_retry',
  ]);
});
