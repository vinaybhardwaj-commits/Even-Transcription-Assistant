/**
 * lib/__tests__/ipd-episode-contract.test.ts — the STRUCTURAL invariants of the IPD Episode Audit
 * build. These are source-read assertions, and each one guards a property that a behavioural test
 * cannot reach because the property is about what the code IS, not what it returns.
 *
 * WHAT IS PINNED HERE, AND WHY EACH ONE MATTERS:
 *  · Every pass input is a FILTER over the one assembled event list. Two assembly paths is how a
 *    blinded pass quietly stops being blinded, and it would pass every unit test on the way.
 *  · Every model call goes through governedChat with { bedrock: model }. A direct client call
 *    would be a PHI path that de-identification never gated, and an unattributable cost row.
 *  · The UNTOUCHED list is untouched. A build that reads a frozen module is fine; a build that
 *    edits one has changed something nobody reviewed.
 *  · The flag 404s the UI and does NOT gate the pipeline, and there is no cron entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OUTCOME_AWARE_NOTICE, NO_DIVERGENCE_COPY } from '../../app/admin/ipd-audit/episodes/ui';
import { IPD_EPISODE_ENGINE_VERSION, SKIP_REASONS, IPD_DISCHARGE_ENGINE_VERSION_FOR_JOIN } from '../ipd-episode/store';
import {
  runEpisodeBatch, countsTowardMax, MAX_CANDIDATES_EXAMINED, SELECTION_SKIP_REASONS,
  type RunEpisodeResult,
} from '../ipd-episode/run';
import {
  IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_COMMENTARY_SYSTEM, IPD_EPISODE_DIFF_SYSTEM,
  IPD_EPISODE_FIDELITY_SYSTEM,
} from '../ipd-episode/prompts';
import {
  callModel, planAttempt, worstCaseMsFor, DEFAULT_CALL_CLASS, MIN_VIABLE_ATTEMPT_MS,
  ONE_CALL_WORST_CASE_MS, TRANSPORT_ATTEMPTS,
} from '../ipd-episode/model-call';
import { PROVIDER_BUDGETS, totalBudgetMs } from '../lab-provider-core';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ENGINE_FILES = [
  'lib/ipd-episode/assemble-core.ts', 'lib/ipd-episode/assemble.ts', 'lib/ipd-episode/checkpoint-core.ts',
  'lib/ipd-episode/checkpoint.ts', 'lib/ipd-episode/db13.ts', 'lib/ipd-episode/judge-core.ts',
  'lib/ipd-episode/judge.ts', 'lib/ipd-episode/prompts.ts', 'lib/ipd-episode/resolve-core.ts',
  'lib/ipd-episode/run.ts', 'lib/ipd-episode/store.ts',
];

// ── the blinding is structural ───────────────────────────────────────────────────────────────

test('every checkpoint and pass input is built by FILTERING the one assembled event list', () => {
  const run = code('lib/ipd-episode/run.ts');
  // the four filters, all from assemble-core, all applied in run.ts
  for (const filter of ['eventsBeforeDayStart(', 'episodeLevelEvents(', 'diffPassEvents(', 'fidelityPassEvents(']) {
    assert.ok(run.includes(filter), `run.ts must build its inputs with ${filter}`);
  }
  // assembleEpisode is called EXACTLY ONCE — one list, built once
  assert.equal((run.match(/assembleEpisode\(/g) ?? []).length, 1,
    'the episode is assembled exactly once; a second assembly path is how blinding is lost');
  // and nothing else in the engine assembles events
  for (const f of ENGINE_FILES.filter((x) => !x.endsWith('run.ts') && !x.endsWith('assemble.ts'))) {
    assert.ok(!code(f).includes('assembleEpisode('), `${f} must not assemble a second event list`);
  }
});

test('the checkpoint and judge layers are handed a list — neither reaches back for an event', () => {
  for (const f of ['lib/ipd-episode/checkpoint.ts', 'lib/ipd-episode/checkpoint-core.ts', 'lib/ipd-episode/judge.ts', 'lib/ipd-episode/judge-core.ts']) {
    const src = code(f);
    for (const reader of ['fetchProgressNotes', 'fetchBillingOrders', 'fetchDischargeSummary', 'fetchAdmission', 'fetchLabOrders', 'fetchExtractionByIpUid']) {
      assert.ok(!src.includes(`${reader}(`), `${f} must not call ${reader} — it renders what it is given`);
    }
  }
});

test('the blinded layers never name an outcome field', () => {
  // discharge_type / los_days / discharge_date_time must not be reachable from the checkpoint
  // layer at all. (judge-core legitimately names them in its fidelity and commentary builders,
  // which are the two passes allowed to see the outcome.)
  for (const f of ['lib/ipd-episode/checkpoint.ts', 'lib/ipd-episode/checkpoint-core.ts']) {
    const src = code(f);
    for (const field of ['discharge_type', 'discharge_date_time', 'dischargeType', 'extracted_case', 'extractedCase']) {
      assert.ok(!src.includes(field), `${f} must not name '${field}' — the checkpoint pass is blind to the outcome`);
    }
  }
});

test('the outcome line reaches pass B and NOTHING else, wherever pass B now runs', () => {
  // DECISION 35 moved pass B out of the pipeline, so this fact moved with it: `outcomeLineFrom`
  // now lives in judge-core and is called by the on-demand route. What must not change is that
  // the outcome reaches exactly one pass — the scored passes stay blind to how the admission ended.
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(/export function outcomeLineFrom/.test(core), 'defined once, in judge-core');

  const run = code('lib/ipd-episode/run.ts');
  assert.ok(!run.includes('outcomeLineFrom'), 'the audit pipeline never builds the outcome line at all');
  assert.ok(!run.includes('runCommentaryPass'), 'and never runs pass B');

  const route = code('app/api/ipd-episode/commentary/route.ts');
  const at = route.indexOf('runCommentaryPass(');
  assert.ok(at > 0, 'the on-demand route is the one caller');
  assert.ok(route.slice(at, at + 700).includes('outcomeLineFrom('), 'and it is where the outcome enters');
  assert.equal((route.match(/outcomeLineFrom\(/g) ?? []).length, 1, 'called once');
});

// ── one model path ───────────────────────────────────────────────────────────────────────────

test('every model call in this engine goes through governedChat with an explicit bedrock target', () => {
  for (const f of ENGINE_FILES) {
    const src = code(f);
    const calls = (src.match(/governedChat\(/g) ?? []).length;
    if (!calls) continue;
    // one { bedrock: … } per governedChat call
    assert.equal((src.match(/bedrock:/g) ?? []).length, calls, `${f}: every governedChat call names a bedrock model`);
    // and no other client is reachable
    for (const banned of ['chatWithFallback(', 'getGeminiChatClient(', 'bedrockConverse(', 'bedrockGenerate(', '.chat.completions.create(']) {
      assert.ok(!src.includes(banned), `${f} must not call ${banned} — the governed layer is the only path`);
    }
  }
});

test('the models are validated BEFORE any work — not after three Opus calls have already been spent', () => {
  const run = code('lib/ipd-episode/run.ts');
  const assertAt = run.indexOf('assertKnownBedrockModel(');
  assert.ok(assertAt > 0, 'run.ts asserts the models');
  for (const later of ['fetchDischargeSummary(', 'assembleEpisode(', 'runCheckpoint(', 'runDiffPass(', 'startTrace(']) {
    const at = run.indexOf(later);
    if (at > 0) assert.ok(assertAt < at, `assertKnownBedrockModel must run before ${later}`);
  }
});

test('all four prompts are top-level consts in one pure file with no imports, so the registry can extract them', () => {
  const src = read('lib/ipd-episode/prompts.ts');
  assert.ok(!/^\s*import /m.test(src), 'prompts.ts imports nothing — it is pure text');
  for (const name of ['IPD_EPISODE_CHECKPOINT_SYSTEM', 'IPD_EPISODE_DIFF_SYSTEM', 'IPD_EPISODE_FIDELITY_SYSTEM', 'IPD_EPISODE_COMMENTARY_SYSTEM']) {
    assert.ok(new RegExp(`^export const ${name} = \``, 'm').test(src), `${name} is a top-level template literal`);
  }
  for (const p of [IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_DIFF_SYSTEM, IPD_EPISODE_FIDELITY_SYSTEM, IPD_EPISODE_COMMENTARY_SYSTEM]) {
    assert.ok(p.trim().length > 400, 'every prompt carries real instruction');
  }
});

test('the registry has all four prompts, registered rather than left on the honest gap list', () => {
  const gen = JSON.parse(read('data/reasoning-registry/prompts.generated.json')) as { prompts: { id: string }[] };
  const manifest = read('lib/reasoning/manifest.ts');
  for (const name of ['IPD_EPISODE_CHECKPOINT_SYSTEM', 'IPD_EPISODE_DIFF_SYSTEM', 'IPD_EPISODE_FIDELITY_SYSTEM', 'IPD_EPISODE_COMMENTARY_SYSTEM']) {
    const id = `prompts/${name}`;
    assert.ok(gen.prompts.some((p) => p.id === id), `${id} is in the generated registry`);
    assert.ok(manifest.includes(`'${id}'`), `${id} is registered in PROMPT_MANIFESTS`);
  }
});

test('each prompt states the discipline its pass is fenced by', () => {
  // the checkpoint prompt is told it does not know the ending
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /You do not know how the admission ended/);
  // the diff prompt is told the same, and told not to infer one from where the events stop
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /YOU ARE NOT TOLD HOW THIS ADMISSION ENDED/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /Do not infer an outcome from where it stops/);
  // the fidelity prompt is fenced to one domain and one finding type
  assert.match(IPD_EPISODE_FIDELITY_SYSTEM, /domain "documentation" and finding_type "commission"/);
  // the commentary prompt is forbidden every number
  assert.match(IPD_EPISODE_COMMENTARY_SYSTEM, /YOU PRODUCE NO NUMBERS/);
  assert.match(IPD_EPISODE_COMMENTARY_SYSTEM, /Do not create a finding/);
  // and all four are told the substrate's limits or told not to name a patient
  for (const p of [IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_DIFF_SYSTEM, IPD_EPISODE_FIDELITY_SYSTEM, IPD_EPISODE_COMMENTARY_SYSTEM]) {
    assert.match(p, /Never name a patient/);
  }
});

// ── the flag ─────────────────────────────────────────────────────────────────────────────────

test('both UI routes 404 unless IPD_EPISODE_AUDIT_ENABLED is exactly "1"', () => {
  for (const f of ['app/admin/ipd-audit/episodes/page.tsx', 'app/admin/ipd-audit/episodes/[id]/page.tsx']) {
    const src = code(f);
    assert.ok(src.includes("process.env.IPD_EPISODE_AUDIT_ENABLED !== '1'"), `${f} reads the flag at request time`);
    assert.ok(src.includes('notFound()'), `${f} 404s when the flag is off`);
  }
});

test('the flag gates the UI ONLY — the worker and the pipeline never read it (§9)', () => {
  for (const f of ['app/api/ipd-episode/worker/route.ts', ...ENGINE_FILES]) {
    assert.ok(!code(f).includes('IPD_EPISODE_AUDIT_ENABLED'), `${f} must not read the UI flag — the pipeline runs regardless`);
  }
});

test('the IPD page link is flag-gated too, so there is no half-open door', () => {
  const src = code('app/admin/ipd-audit/page.tsx');
  assert.ok(src.includes("process.env.IPD_EPISODE_AUDIT_ENABLED === '1'"));
  assert.ok(src.includes('/admin/ipd-audit/episodes'));
});

// ── the UI's verbatim obligations ────────────────────────────────────────────────────────────

test('the commentary block carries PRD §10 item 5 verbatim, and the empty-findings copy is verbatim too', () => {
  assert.equal(OUTCOME_AWARE_NOTICE, 'This commentary was written with knowledge of the patient outcome. The scores above were not.');
  assert.equal(NO_DIVERGENCE_COPY, 'No divergence found against the expected course.');
  const panels = read('app/admin/ipd-audit/episodes/[id]/panels.tsx');
  const commentary = read('app/admin/ipd-audit/episodes/[id]/commentary-client.tsx');
  assert.ok(commentary.includes('OUTCOME_AWARE_NOTICE'), 'the panel renders the constant, not a retyped copy');
  assert.ok(commentary.includes('Outcome-aware commentary'));
  assert.ok(panels.includes('Could not assess'));
  // decision 35: the notice sits above the block in EVERY state, including while generating and
  // after a failure — it is not conditional on there being text to caveat.
  const notice = commentary.indexOf('OUTCOME_AWARE_NOTICE');
  assert.ok(notice > 0 && notice < commentary.indexOf('Generating commentary'),
    'the outcome-aware label precedes the generating state, not only the finished text');
});

test('the sibling score is read at the pinned discharge engine version and always labelled as its own', () => {
  assert.equal(IPD_DISCHARGE_ENGINE_VERSION_FOR_JOIN, 'ipd-discharge-audit/0.2');
  // comments stripped: the file's header legitimately NAMES the palette it refuses to import,
  // which is the same reason lib/__tests__/ipd-audit-billing.test.ts strips them
  const ui = code('app/admin/ipd-audit/episodes/ui.tsx');
  assert.ok(ui.includes('Discharge engine score'));
  assert.ok(ui.includes('not audited by discharge engine'), 'a missing sibling row is stated, never shown as a zero');
  // this engine's own number never borrows the discharge engine's A–E band palette
  assert.ok(!ui.includes('bandColor') && !ui.includes('opd-audit-ui'),
    'the episode surface does not colour its divergence index with another engine’s band palette');
});

// ── the file contract (PRD §11) ──────────────────────────────────────────────────────────────

test('the UNTOUCHED list is untouched: this engine READS the frozen modules and edits none of them', () => {
  // ipd-audit is imported in exactly two places, both read-only helpers, and never written to
  const assemble = code('lib/ipd-episode/assemble.ts');
  assert.ok(assemble.includes("from '../ipd-audit/db13'"), 'the render-time header reader is reused, not reimplemented');
  for (const f of ENGINE_FILES) {
    const src = code(f);
    for (const banned of ['saveIpdAudit(', 'upsertExtractedCase(', 'computeScorecard(', 'recordIpdAuditFailure(']) {
      assert.ok(!src.includes(banned), `${f} must not write through a frozen module (${banned})`);
    }
    assert.ok(!/INSERT INTO ipd_discharge_audits|UPDATE ipd_discharge_audits|INSERT INTO discharge_extracted_cases|UPDATE discharge_extracted_cases/i.test(src),
      `${f} must never write to the discharge engine's tables`);
  }
  // and the store only ever SELECTs from them
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(/FROM ipd_discharge_audits/.test(store) && /FROM discharge_extracted_cases/.test(store));
});

test('the de-identifier is the stay-library one: its type from core.ts, its function from where build.ts takes it', () => {
  const assemble = code('lib/ipd-episode/assemble.ts');
  assert.ok(assemble.includes("import type { Deidentifier } from '../stay-library/core'"),
    'the contract type comes from stay-library/core.ts, as PRD §12 names');
  assert.ok(assemble.includes("import { deidText } from '../readmission/assemble'"),
    'and the concrete scrubber from lib/readmission/assemble.ts');
  // stay-library/core.ts exports Deidentifier ONLY as a type — there is no function there to import
  const core = read('lib/stay-library/core.ts');
  assert.match(core, /export type Deidentifier = \(text: string\) => string;/);
  assert.ok(!/export (function|const) deid/.test(core), 'core.ts holds no concrete de-identifier');
  // and this engine binds it exactly the way stay-library/build.ts does
  const build = code('lib/stay-library/build.ts');
  const shape = 'const deid: Deidentifier = (text: string) => deidText(text, identity);';
  assert.ok(build.includes(shape), 'stay-library binds it this way');
  assert.ok(assemble.includes(shape), 'and so does this engine — one implementation, two callers');
});

test('no new dependency, and vercel.json is untouched — there is NO cron entry (decision 19)', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
  const all = { ...pkg.dependencies, ...(pkg.devDependencies ?? {}) };
  for (const f of ENGINE_FILES) {
    for (const imp of code(f).matchAll(/from '([^'.][^']*)'/g)) {
      const pkgName = imp[1].startsWith('@') ? imp[1].split('/').slice(0, 2).join('/') : imp[1].split('/')[0];
      if (pkgName.startsWith('node:')) continue;
      assert.ok(pkgName in all, `${f} imports '${pkgName}', which is not a declared dependency`);
    }
  }
  if (existsSync('vercel.json')) {
    const vercel = read('vercel.json');
    assert.ok(!vercel.includes('ipd-episode'), 'vercel.json must carry no cron entry for this worker (decision 19)');
  }
});

test('the migration route and the reference .sql create the same three tables', () => {
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  const sqlFiles = readdirSync('migrations').filter((n) => n.includes('ipd_episode_audits'));
  assert.equal(sqlFiles.length, 1, 'exactly one reference migration file');
  const sqlText = read(join('migrations', sqlFiles[0]));
  for (const table of ['ipd_episode_audits', 'ipd_episode_checkpoints', 'ipd_episode_skips']) {
    assert.ok(route.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `the route creates ${table}`);
    assert.ok(sqlText.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `the .sql creates ${table}`);
  }
  // the (encounter_id, engine_version) unique index is gone as of round 6 item 2 — every run is
  // its own row now, and uniqueness moved to (…, run_seq) plus a partial index on is_current
  assert.ok(route.includes('ipd_episode_audits_encounter_engine_run_uq') && sqlText.includes('ipd_episode_audits_encounter_engine_run_uq'));
  assert.ok(sqlText.includes('PRIMARY KEY (encounter_id, engine_version)'), 'the skips table is keyed as §7.3 says');
  // every statement is idempotent, so the route can be run twice
  assert.ok(!/CREATE TABLE (?!IF NOT EXISTS)/.test(route) && !/CREATE TABLE (?!IF NOT EXISTS)/.test(sqlText));
});

test('the migration is 0052 — 0051 was already taken by the cognition shadow sweep', () => {
  const names = readdirSync('migrations');
  assert.ok(names.includes('0052_ipd_episode_audits.sql'), 'the reference copy is 0052');
  assert.ok(!names.includes('0051_ipd_episode_audits.sql'), 'no 0051 copy survives the rename');
  // and nothing still points at the old number
  for (const f of ['lib/ipd-episode/store.ts', 'app/api/admin/migrate-ipd-episode-audits/route.ts']) {
    assert.ok(!read(f).includes('0051_ipd_episode_audits') && !read(f).includes('migrations/0051'),
      `${f} still references the old migration number`);
  }
});

test('app_source matches ipd_discharge_audits: TEXT NOT NULL DEFAULT \'standalone\', in both copies', () => {
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  for (const [label, src] of [['route', route], ['sql', sqlText]] as const) {
    assert.match(src, /app_source\s+TEXT NOT NULL DEFAULT 'standalone'/, `${label}: app_source must be NOT NULL with the shared default`);
  }
  // the route must also repair a table created by an earlier run of itself
  assert.ok(route.includes("ALTER TABLE ipd_episode_audits ALTER COLUMN app_source SET DEFAULT 'standalone'"));
  assert.ok(route.includes('ADD COLUMN IF NOT EXISTS error_detail TEXT'));
  assert.ok(sqlText.includes('error_detail          TEXT'));
});

test('citation_ids: the DDL type and the store’s cast agree — a mismatch would delete the blinding proof', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  const store = code('lib/ipd-episode/store.ts');

  // one type, declared identically in both copies of the DDL
  assert.match(sqlText, /citation_ids\s+INTEGER\[\]/, '.sql declares INTEGER[]');
  assert.match(route, /citation_ids\s+INTEGER\[\]/, 'the admin route declares INTEGER[]');
  assert.ok(!/citation_ids\s+TEXT\[\]/i.test(sqlText) && !/citation_ids\s+TEXT\[\]/i.test(route),
    'citation_ids is never TEXT[] — these values are mksap_chunks ids');

  // and the writer casts to the same type
  assert.ok(store.includes('$8::int[]'), 'the store casts citation_ids as int[]');
  assert.ok(!/citation_ids[^)]*::text\[\]/.test(store), 'the store never casts citation_ids to text[]');

  // the ::text[] casts in this file are on genuinely-text columns, and neither is citation_ids
  const textCasts = store.match(/::text\[\]/g) ?? [];
  assert.equal(textCasts.length, 2, 'two ::text[] casts: the ip_uid join and the retrieved_titles array');
  assert.ok(store.includes('ip_uid = ANY($2::text[])'), 'the sibling-score join on ip_uid, which IS text');
  assert.ok(store.includes('$17::text[]'), 'and retrieved_titles, which IS a text[]');
});

test('the migrate route repairs a citation_ids column of the wrong type, and is idempotent about it', () => {
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(route.includes('ALTER COLUMN citation_ids TYPE INTEGER[] USING citation_ids::text[]::integer[]'),
    'the repair is present');
  // guarded on the catalogue, so a correct table is not rewritten on every run
  assert.ok(route.includes("current === 'integer[]'") && route.includes('pg_attribute'),
    'the ALTER runs only when the live type is actually wrong');
  assert.ok(route.includes('steps.checkpoints_citation_ids'), 'and the route reports which branch it took');
});

test('every counted column carries DEFAULT 0 in both DDL copies, and the writer never sends null', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  // ⚠️ divergence_index is DELIBERATELY ABSENT from this list as of round 4 item 5. It is the one
  // counted column that may legitimately be NULL — under scoring_status 'no_expectations' there is
  // no score — and a DEFAULT 0 would make "not scorable" indistinguishable from the worst episode
  // this engine has ever produced. Its own test asserts the absence.
  const counted = [
    'completeness_pct', 'n_findings', 'n_divergence_pass', 'n_fidelity_pass',
    'n_omission', 'n_commission', 'n_timing', 'n_sequencing', 'n_divergent', 'n_context_dependent',
    'n_unassessable', 'n_concordant', 'n_low_value', 'n_dropped_invalid', 'checkpoint_count',
  ];
  for (const col of counted) {
    assert.ok(new RegExp(`${col}\\s+INTEGER DEFAULT 0`).test(sqlText), `.sql: ${col} DEFAULT 0`);
    assert.ok(new RegExp(`${col}\\s+INTEGER DEFAULT 0`).test(route), `route: ${col} DEFAULT 0`);
    assert.ok(route.includes(`'${col}'`), `route re-applies the default to an existing table for ${col}`);
  }
  // the INSERT names every one of these columns, so DEFAULT alone cannot save them — the writer
  // coalesces too
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(/function num\(v: number \| null \| undefined\): number/.test(store), 'the coalescing helper exists');
  assert.ok(store.includes('num(c.n_findings)'), 'every counter goes through it');
  // los_days deliberately does NOT: a missing stay length is unknown, not zero
  assert.ok(store.includes('row.losDays,'), 'losDays is passed through as-is, nulls included');
});

test('selection requires a progress note in SQL, so a note-less episode is never a candidate', () => {
  const src = code('lib/ipd-episode/db13.ts');
  assert.ok(src.includes('AND EXISTS (SELECT 1 FROM kx_clinical_template_progress_reports p'),
    'the EXISTS clause is present');
  assert.ok(src.includes('WHERE p.encounter_id = a.encounter_id)'), 'and the join is exact — no rewriting');
  assert.ok(src.includes('fetchClosedEpisodes(limit = 2000)'), 'the fetch limit is 2000');
  // run.ts still re-checks conditions 1 and 3 per episode, because the query and the attempt differ in time
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes("reason: 'no_notes'"), 'no_notes stays reachable as a per-episode skip');
});

test('no PHI column name appears in the migration DDL, in either copy', () => {
  const sqlFiles = readdirSync('migrations').filter((n) => n.includes('ipd_episode_audits'));
  for (const src of [code('app/api/admin/migrate-ipd-episode-audits/route.ts'), read(join('migrations', sqlFiles[0])).replace(/^--.*$/gm, '')]) {
    for (const col of ['uhid', 'patient_name', 'patient_age', 'patient_gender', 'birth_date', 'mobile', 'address', 'telecom', 'kin_']) {
      assert.ok(!new RegExp(`\\b${col}`).test(src), `the DDL must not declare a '${col}' column`);
    }
  }
});

// ── the store's casts and its refusal to fail quietly ───────────────────────────────────────

test('the sibling-score query casts its id array as ::text[]', () => {
  const src = code('lib/ipd-episode/store.ts');
  assert.ok(src.includes('ip_uid = ANY($2::text[])'),
    'without the cast the driver’s array binding is ambiguous enough for the server to reject the statement');
});

test('the checkpoint insert casts citation_ids as ::int[]', () => {
  const src = code('lib/ipd-episode/store.ts');
  assert.ok(src.includes('$8::int[]'), 'citation_ids is an int[] column and an empty array needs the cast');
  // the cast sits on the citation_ids ordinal, not on some other parameter
  const insert = src.slice(src.indexOf('INSERT INTO ipd_episode_checkpoints'));
  const cols = insert.slice(0, insert.indexOf('VALUES'));
  const ordinal = cols.split(',').findIndex((c) => c.includes('citation_ids')) + 1;
  assert.equal(ordinal, 8, 'citation_ids is the 8th column, so $8 is the one to cast');
});

test('no read or write in the store fails silently — every catch says what broke', () => {
  const src = code('lib/ipd-episode/store.ts');
  assert.ok(!src.includes('.catch(() => [])'),
    'a bare `.catch(() => [])` makes "no rows" and "this query has been broken for a week" identical');
  // every degraded path routes through the one warn helper
  const catches = (src.match(/\.catch\(/g) ?? []).length;
  const warns = (src.match(/warn\(/g) ?? []).length;
  assert.ok(warns >= catches - 1, `every degraded path should warn (${warns} warns for ${catches} catches)`);
});

test('a failed checkpoint write is counted and reported — those rows carry the blinding proof', () => {
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('failedCheckpoints'), 'saveEpisodeAudit returns how many checkpoint rows did not land');
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('ipd_episode_checkpoint_write_failed'), 'and the pipeline raises a trace event for it');
});

// ── unparseable findings are not the A2 domain counter ───────────────────────────────────────

test('unparseable findings reach the trace, error_detail, raw_judge_error AND the counters', () => {
  // ⚠️ THIS REPLACES round 2's assertion, which required the opposite. Round 2 separated the two
  // causes so n_dropped_invalid would mean only "A2 broke its fence"; IP-1286 then discarded 5 of
  // 15 divergence findings with every counter reading 0 and no record anywhere. Round 3 reverses
  // it on the orchestrator's instruction: no discard may leave every counter at 0. Both readings
  // survive because there are now two columns.
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('ipd_episode_unparseable_findings'), 'a trace event carries the fragments');
  assert.ok(run.includes('errorDetail'), 'prose reaches error_detail');
  assert.ok(run.includes('rawJudgeError'), 'the raw fragments reach raw_judge_error');
  assert.ok(/finalizeFindings\(raw, entryRefs, events, unparseable,/.test(run),
    'and the count IS passed into the counters');
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('countFindings(findings, dropped, parseFailed)'),
    'n_dropped_invalid is fed both causes; n_parse_failed isolates the second');
});

// ── round 4 items 1–5: the retrieval query, and refusing to invent a score ───────────────────

test('the query builder has no administrative parameter left to misuse', () => {
  const core = code('lib/ipd-episode/checkpoint-core.ts');
  // bounded to the interface ITSELF — a wider slice picks up the ID_FIELD regex below, which names
  // ward/facility precisely because it strips them
  const iface = core.slice(core.indexOf('export interface RetrievalQueryInput'), core.indexOf('export interface RetrievalQueryResult'));
  // ⚠️ `remarks` is DELIBERATELY NOT in this list as of round 5 item 3. It was stripped with the
  // four administrative fields and should not have been: it is free text written AT ADMISSION, so
  // it carries the presenting picture and no hindsight. Removing it left IP-1286's day 0 query
  // empty, and nine of its eleven uncited findings were day 0.
  for (const gone of ['treatingDepartmentName', 'admissionType', 'admitSource', 'ward', 'facility', 'doctor']) {
    assert.ok(!iface.includes(gone), `RetrievalQueryInput must not accept '${gone}' — it retrieves staffing literature`);
  }
  const run = code('lib/ipd-episode/run.ts');
  const call = run.slice(run.indexOf('retrievalQueryInput:'), run.indexOf('retrievalQueryInput:') + 600);
  for (const gone of ['treatingDepartmentName', 'admitSource', 'admissionType', 'facilityName']) {
    assert.ok(!call.includes(gone), `run.ts must not pass '${gone}' into the query`);
  }
});

test('the extracted case is UNREACHABLE from the checkpoint retrieval path (§3.3.3, reverted 2026-09-02)', () => {
  // A discharge summary is written after the fact. Its diagnosis is what the admission turned out
  // to be, so selecting excerpts with it would put hindsight into a blinded pass through the
  // retrieved text — even though the strings never enter the prompt. The whole path is gone, and
  // this asserts it cannot come back.
  const cpCore = code('lib/ipd-episode/checkpoint-core.ts');
  const cp = code('lib/ipd-episode/checkpoint.ts');
  for (const src of [cpCore, cp]) {
    for (const banned of ['extractedDiagnosis', 'extractedProcedure', 'extractedCase', 'extracted_case', 'extractedJson']) {
      assert.ok(!src.includes(banned), `the checkpoint layer must not name '${banned}'`);
    }
  }
  // the builder takes ONE input, and it is the filtered event list
  const iface = cpCore.slice(cpCore.indexOf('export interface RetrievalQueryInput'), cpCore.indexOf('export interface RetrievalQueryResult'));
  const fields = [...iface.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]);
  assert.deepEqual(fields.sort(), ['authorNames', 'episodeSurgeryNames', 'eventsBeforeCutoff', 'isDayZero', 'remarks'],
    'the cut-off window, admission remarks, author names to strip, the day 0 OT fallback — no extraction');

  // and run.ts passes exactly those, nothing more
  const run = code('lib/ipd-episode/run.ts');
  const call = run.slice(run.indexOf('retrievalQueryInput:'), run.indexOf('retrievalQueryInput:') + 600);
  assert.ok(call.includes('eventsBeforeCutoff: input_events'), 'the checkpoint gets its own filtered list');
  for (const banned of ['extractedDiagnosis', 'extractedProcedure', 'extraction.']) {
    assert.ok(!call.includes(banned), `run.ts must not pass '${banned}' into the query`);
  }
});

// ── round 11: one call site, re-derived ceilings, bounded judge output ───────────────────────

test('every model call goes through the ONE shared helper', () => {
  for (const f of ['lib/ipd-episode/checkpoint.ts', 'lib/ipd-episode/judge.ts']) {
    const src = code(f);
    assert.ok(!src.includes('governedChat('), `${f} must not call governedChat directly any more`);
    assert.ok(src.includes('callModel('), `${f} goes through the helper`);
  }
  const mc = code('lib/ipd-episode/model-call.ts');
  assert.equal((mc.match(/governedChat\(/g) ?? []).length, 1, 'exactly one governedChat call in the engine');
  assert.ok(mc.includes('bedrock: input.model'), 'and it still names a bedrock target');
});

test('a truncated body is NEVER accepted as an answer — the defect of rounds 8, 10 and 11', () => {
  const mc = code('lib/ipd-episode/model-call.ts');
  assert.ok(mc.includes("if (finishReason === 'length')"), 'a clean 200 with a length finish is refused');
  assert.ok(mc.includes('export function isTruncation('), 'and a thrown one is detected');
  assert.ok(mc.includes('truncationRetryInstruction'), 'retried once, asking for less');
  assert.ok(mc.includes('retried once asking for fewer items and it truncated again'),
    'and a second truncation fails the call with a reason');
  assert.ok(mc.includes('export function truncatedAt('), 'the character count is named in the failure');
});

test('every ceiling carries its derivation beside the constant', () => {
  const judge = read('lib/ipd-episode/judge.ts');
  assert.ok(judge.includes('export const JUDGE_MAX_TOKENS = 16000'));
  assert.ok(judge.includes('export const COMMENTARY_MAX_TOKENS = 10000'), 'raised from the tightest of the four');
  assert.ok(judge.includes('DERIVATION') || judge.includes('worst case'), 'the arithmetic is written down');
  assert.ok(judge.includes('22,677'), 'the observed overflow is cited');
  const cp = read('lib/ipd-episode/checkpoint.ts');
  assert.ok(cp.includes('DERIVATION') && cp.includes('3.1× headroom'), 'the checkpoint ceiling too');
  // no bare numeric max_tokens left at a call site
  assert.ok(!/max_tokens: \d/.test(code('lib/ipd-episode/judge.ts')));
  assert.ok(!/max_tokens: \d/.test(code('lib/ipd-episode/checkpoint.ts')));
});

test('the judge output is bounded the way the checkpoint course is', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('export const MAX_FINDINGS_PER_PASS = 30'));
  assert.ok(core.includes('export function capFindings('));
  const judge = code('lib/ipd-episode/judge.ts');
  assert.equal((judge.match(/capFindings\(/g) ?? []).length, 2, 'applied to both A1 and A2');
  assert.ok(judge.includes('findingsTruncated: capped.dropped'), 'and the drop is recorded');
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  assert.ok(sqlText.includes('n_findings_truncated'));
});

test('diagnostics survive a FAILED episode — they were only on the audit row before', () => {
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('diagnostics?: unknown'), 'recordSkip takes them');
  assert.ok(store.includes('COALESCE(EXCLUDED.diagnostics, ipd_episode_skips.diagnostics)'),
    'and never overwrites evidence with a null on a later upsert');
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('const diagnosticsNow ='), 'built as a closure, so it reflects the failure point');
  // every skip after the checkpoints run carries them
  for (const marker of ["reason: 'diff_failed'", "reason: 'fidelity_failed'"]) {
    const at = run.indexOf(marker);
    assert.ok(at > 0 && run.slice(at, at + 400).includes('diagnostics: diagnosticsNow'),
      `${marker} carries diagnostics`);
  }
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  for (const col of ['diagnostics', 'detail']) {
    assert.ok(sqlText.includes(col), `.sql declares skips.${col}`);
    assert.ok(route.includes(`ALTER TABLE ipd_episode_skips ADD COLUMN IF NOT EXISTS ${col}`), `back-filled`);
  }
});

// ── round 10: the timeout ───────────────────────────────────────────────────────────────────

test('checkpoints run concurrently and the judge passes stay sequential', () => {
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('export const CHECKPOINT_CONCURRENCY = 3'));
  assert.ok(run.includes('await mapWithLimit(plan, CHECKPOINT_CONCURRENCY, buildCheckpoint)'));
  // order preserved: a reordered list would scramble day indices against expected courses
  assert.ok(run.includes('out[i] = await fn(items[i])'), 'the helper writes by index');
  // the three judge passes must NOT be parallelised — they depend on each other
  assert.ok(!/Promise\.all\([^)]*runDiffPass|Promise\.all\([^)]*runFidelityPass/.test(run));
  const diffAt = run.indexOf('runDiffPass(');
  const fidAt = run.indexOf('runFidelityPass(');
  assert.ok(diffAt > 0 && diffAt < fidAt, 'A1 then A2, in order');
  // DECISION 35: the pipeline ENDS at the fidelity pass. B is not last here any more — it is
  // not here at all, and a re-added call would put a 107 s model call back on the audit path.
  assert.ok(!run.includes('runCommentaryPass('), 'pass B does not run in the pipeline');
});

test('PROMPT shaping never touches real_course or the resolver', () => {
  const core = code('lib/ipd-episode/assemble-core.ts');
  assert.ok(core.includes('export function summariseEventsForPrompt('));
  const run = code('lib/ipd-episode/run.ts');
  // the stored course and the resolver both get the FULL list
  assert.ok(run.includes('realCourse: events'), 'real_course is stored as assembled');
  assert.ok(run.includes('const resolverEvents = diffPassEvents(events);'),
    'the resolver matches the full filtered list, not the summary');
  assert.ok(!run.includes('resolveAll(resolvableEntries, summariseEventsForPrompt'),
    'a drug ordered once must still be findable by the resolver');
  // and the prompts get the summary
  for (const pass of ['runDiffPass', 'runFidelityPass']) {
    const at = run.indexOf(pass + '(');
    assert.ok(run.slice(at, at + 320).includes('summariseEventsForPrompt'), `${pass} reads the summary`);
  }
  // pass B reads the summary too — it just reads it from the stored real_course now (decision 35)
  const route = code('app/api/ipd-episode/commentary/route.ts');
  const bAt = route.indexOf('runCommentaryPass(');
  assert.ok(route.slice(bAt, bAt + 700).includes('summariseEventsForPrompt'),
    'the on-demand pass B is shaped the same way the in-pipeline one was');
  assert.ok(run.includes('promptEvents:') && run.includes('assembledEvents:'), 'both counts recorded');
});

test('a timeout is not silent: an in_progress marker is written before any model work', () => {
  const run = code('lib/ipd-episode/run.ts');
  const markerAt = run.indexOf("reason: 'in_progress'");
  assert.ok(markerAt > 0, 'the marker exists');
  // NB: search CALL SITES, not bare names — the import line at the top of the file would match
  for (const later of ['assembleEpisode({', 'return runCheckpoint({', 'runDiffPass({']) {
    const at = run.indexOf(later);
    assert.ok(at > 0, `${later} exists`);
    assert.ok(markerAt < at, `the marker must precede ${later}`);
  }
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes("'in_progress'") && store.includes("'timed_out'"), 'both reasons declared');
  assert.ok(store.includes('export function inProgressIsStale('));
  assert.ok(store.includes('IN_PROGRESS_STALE_MS = 30 * 60 * 1000'), '30 minutes, above the 800 s cap');
  const worker = code('app/api/ipd-episode/worker/route.ts');
  assert.ok(worker.includes('running.has(c.encounterId)'), 'a live in_progress episode is not re-picked');
  assert.ok(worker.includes('inProgressIsStale(s.last_seen)'), 'but a dead one is');
});

/**
 * ROUND 12 ITEM 1. The defect this pins: round 11 added `n_findings_truncated` to the audits
 * INSERT. Every column, every `$n` and every parameter was renumbered correctly — and all three
 * COUNTS still agreed, so the count-based check I had run since round 2 stayed green. What did not
 * move was the `::jsonb` cast: it sat on `$35`, which had become `judge_temperature`, and Postgres
 * refused the whole statement with `column "judge_temperature" is of type double precision but
 * expression is of type jsonb`. IPNO-416 ran the full 314 s pipeline and persisted nothing.
 *
 * Counting is not alignment. This pairs each column with its value token and checks the CAST
 * POSITION — and the expected type comes from the DDL in migrations/0052, not from a list written
 * out by hand here. A hand list is the same class of mistake one level up: it would have to be
 * edited in step with the DDL, and the whole lesson of this defect is that a thing which must be
 * edited in step with another thing eventually is not.
 */
const DDL_TYPES = (() => {
  // column → declared type, parsed out of every CREATE TABLE in the reference migration.
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const byTable = new Map<string, Map<string, string>>();
  for (const m of sqlText.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    const cols = new Map<string, string>();
    for (const raw of m[2].split('\n')) {
      const line = raw.replace(/--.*$/, '').trim().replace(/,$/, '');
      // a column line is `name TYPE ...`; table-level constraints and index bodies are not
      const col = /^([a-z_][a-z0-9_]*)\s+(JSONB|INTEGER\[\]|TEXT\[\]|TEXT|INTEGER|BOOLEAN|UUID|TIMESTAMPTZ|DOUBLE PRECISION|NUMERIC)(?![A-Za-z_])/i.exec(line);
      if (col && !/^(primary|foreign|unique|constraint|check)$/i.test(col[1])) {
        cols.set(col[1], col[2].toUpperCase());
      }
    }
    byTable.set(m[1], cols);
  }
  return byTable;
})();

/** The cast a column of this declared type requires in an INSERT — '' means no cast. */
function castForType(t: string | undefined): string {
  if (t === 'JSONB') return '::jsonb';
  if (t === 'INTEGER[]') return '::int[]';
  if (t === 'TEXT[]') return '::text[]';
  return '';
}

for (const [table, insertMarker] of [
  ['ipd_episode_audits', 'INSERT INTO ipd_episode_audits'],
  ['ipd_episode_checkpoints', 'INSERT INTO ipd_episode_checkpoints'],
] as const) {
  test(`every cast in the ${table} INSERT sits on the placeholder whose column has that type`, () => {
    const ddl = DDL_TYPES.get(table);
    assert.ok(ddl && ddl.size > 0, `${table} is declared in migrations/0052`);

    const src = code('lib/ipd-episode/store.ts');
    const from = src.indexOf(insertMarker);
    const to = src.indexOf(')', src.indexOf('VALUES', from) + 'VALUES'.length);
    assert.ok(from > 0, `${insertMarker} is findable`);
    const block = src.slice(from, src.indexOf('`', from) > 0 ? to + 1 : to + 1);

    const columns = block.slice(block.indexOf('(') + 1, block.indexOf('VALUES'))
      .replace(/\)/g, '').split(',').map((c) => c.trim()).filter(Boolean);
    const tokens = block.slice(block.indexOf('VALUES') + 'VALUES'.length)
      .replace(/[()]/g, '').split(',').map((t) => t.trim()).filter(Boolean);

    assert.equal(columns.length, tokens.length, 'one value token per column');
    assert.ok(columns.length > 10, 'the column list parsed');

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const token = tokens[i];
      // A literal (TRUE) is not a placeholder and carries no cast.
      if (!token.startsWith('$')) { assert.ok(!token.includes('::'), `${col}: literal ${token} is cast`); continue; }
      const declared = ddl.get(col);
      assert.ok(declared, `${col} is declared in the DDL for ${table}`);
      const want = castForType(declared);
      const got = token.includes('::') ? token.slice(token.indexOf('::')) : '';
      assert.equal(got, want,
        `${col} is ${declared} in the DDL, so its token must be ${want ? `$n${want}` : '$n with no cast'} — found ${token}`);
    }

    // And the placeholders must still run 1..N with no gap or repeat: that is what a renumber breaks.
    const nums = tokens.filter((t) => t.startsWith('$')).map((t) => Number(t.replace(/\D+/g, '')));
    assert.deepEqual(nums, nums.map((_, i) => i + 1), 'placeholders are sequential from $1');
  });
}

// ── round 12 / decision 35: commentary is on demand ─────────────────────────────────────────

test('the audit row is complete and scorable with commentary NULL', () => {
  const run = code('lib/ipd-episode/run.ts');
  // The pipeline writes null and says why. Nothing downstream may treat that as a failure:
  // no skip, no error detail, no effect on scoring_status.
  assert.ok(run.includes('commentary: null'), 'the pipeline writes null by construction');
  assert.ok(!/commentary[^\n]*recordSkip|recordSkip[^\n]*commentary/.test(run),
    'a missing commentary never writes a skip row');
  const scoring = code('lib/ipd-episode/judge-core.ts');
  assert.ok(!/scoringStatusFor[\s\S]{0,400}commentary/.test(scoring),
    'scoring status cannot depend on the commentary');
});

test('the on-demand commentary route is admin-gated, idempotent, and never fatal', () => {
  const route = code('app/api/ipd-episode/commentary/route.ts');

  // admin-gated, the same pair every admin route in this repo uses
  assert.ok(route.includes('requireAdmin(req)') && route.includes('isAdminUnlocked()'),
    'ADMIN_TOKEN or an admin session, like the rest');

  // idempotent on BOTH sides: the cheap read-side early return, and the write-side guard that
  // survives two simultaneous first opens. The read alone is not idempotency, it is a race.
  assert.ok(route.includes('row.commentary != null'), 'an existing commentary never reaches the model');
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(/UPDATE ipd_episode_audits SET commentary[\s\S]{0,120}WHERE id = \$1 AND commentary IS NULL/.test(store),
    'the write itself refuses to overwrite an existing commentary');

  // never fatal: a failed generation is a 200 with a null commentary and a reason
  assert.ok(/status: 'failed', commentary: null/.test(route), 'failure is a state, not an error page');
  assert.ok(!route.includes('status: 500'), 'a commentary that will not generate is not a server error');
});

test('pass B is given the FULL finding list with the real ids it is asked to annotate', () => {
  // IPNO-416 rejected two commentaries for annotating 'r-13'. That was not an invented id: resolver
  // ids read `r-13-cp-d1/diagnostics/3` and the model cut them at the natural break. The ref was
  // already carried in checkpoint_ref, so the id never needed to contain it.
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('finding_id: `r-${i + 1}`'), 'resolver ids are short and whole');
  assert.ok(!core.includes('`r-${i + 1}-${entry.ref}`'), 'the truncatable form is gone');

  const route = code('app/api/ipd-episode/commentary/route.ts');
  // the full stored list, unfiltered — resolver findings included
  assert.ok(/findings = Array\.isArray\(row\.findings\)/.test(route), 'the list comes from the row');
  assert.ok(!/findings\.filter\(/.test(route), 'nothing is filtered out of what pass B is shown');

  // and validation still checks every annotation against exactly that list
  const judge = code('lib/ipd-episode/judge.ts');
  assert.ok(judge.includes('const knownIds = a.findings.map((f) => f.finding_id)'), 'ids come from the same list');
  assert.ok(judge.includes('validateCommentary(text, knownIds)'), 'and every annotation is checked against it');
});

test('stage timings are recorded so the slow stage is a fact, not a guess', () => {
  const run = code('lib/ipd-episode/run.ts');
  for (const t of ['assemble_ms', 'retrieval_ms', 'checkpoint_ms', 'checkpoint_max_ms',
                   'checkpoint_wall_ms', 'diff_ms', 'fidelity_ms', 'commentary_ms']) {
    assert.ok(run.includes(t), `${t} is measured`);
  }
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  for (const col of ['stage_timings', 'checkpoint_wall_ms', 'checkpoint_concurrency',
                     'prompt_events', 'assembled_events', 'checkpoint_policy']) {
    assert.ok(sqlText.includes(col), `.sql declares ${col}`);
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `the route back-fills ${col}`);
  }
});

test('the worker header carries MEASURED figures, not the stale estimate', () => {
  const raw = read('app/api/ipd-episode/worker/route.ts');
  assert.ok(raw.includes('IPNO-416') && raw.includes('FUNCTION_INVOCATION_TIMEOUT'),
    'the failure that disproved the old number is named');
  assert.ok(raw.includes('227 s') && raw.includes('156 s'), 'the two completions are cited');
  assert.ok(raw.includes('O(checkpoints ×'), 'and the shape of the cost is stated');
  // the ceiling is stated in checkpoints and events, not only seconds
  assert.ok(raw.includes('checkpoints: 8 is the maximum') && raw.includes('prompt_events'));
  // the old estimate survives only as the thing being corrected
  const claims = raw.split('~520 s worst case').length - 1;
  assert.equal(claims, 1, 'mentioned once, as the error');
});

// ── round 9: the point score is not shown ───────────────────────────────────────────────────

test('the band is stored, and the reason is recorded in the code where the next reader will find it', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('export function divergenceBandFor('));
  assert.ok(core.includes('export function bandIsUncertain('));
  // the WHY, with the evidence, per item 4
  const doc = read('lib/ipd-episode/judge-core.ts');
  assert.ok(doc.includes('40, 37, 36, 41, 36'), 'the five readings are cited');
  assert.ok(doc.includes('334ed090'), 'and the sha they came from');
  assert.ok(doc.includes('MUST NOT MISTAKE THE BAND FOR COARSENESS OF AMBITION'),
    'the next reader must know this is a refusal to overclaim, not a lowering of sights');
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  for (const col of ['divergence_band', 'band_uncertain']) {
    assert.ok(sqlText.includes(col), `.sql declares ${col}`);
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `the route back-fills ${col}`);
  }
  assert.ok(sqlText.includes('±5 repeat-run spread'), 'the DDL says why the band exists');
});

test('the raw index never appears on the list, and the list cannot be sorted by it', () => {
  const list = code('app/admin/ipd-audit/episodes/page.tsx');
  assert.ok(!list.includes('divergence_index'), 'the number is not rendered on the list at all');
  assert.ok(!/sort === 'divergence'/.test(list), 'and there is no index sort');
  assert.ok(list.includes("sp.sort === 'band'"), 'sorting is by band');
  assert.ok(list.includes('(num(b.n_divergent) ?? 0) - (num(a.n_divergent) ?? 0)'),
    'then by divergent COUNT within band — a count does not move the way the index does');
});

test('the index IS available on drill-in, labelled with its spread', () => {
  const ui = code('app/admin/ipd-audit/episodes/ui.tsx');
  assert.ok(ui.includes('export function InternalIndex('));
  assert.ok(ui.includes('Internal index') && ui.includes('repeat-run spread'));
  const detail = code('app/admin/ipd-audit/episodes/[id]/page.tsx');
  assert.ok(detail.includes('<InternalIndex'), 'and the detail page renders it');
});

test('the chip shows a band or "not scorable", never a bare number', () => {
  const ui = code('app/admin/ipd-audit/episodes/ui.tsx');
  const chip = ui.slice(ui.indexOf('export function DivergenceChip'), ui.indexOf('export function InternalIndex'));
  assert.ok(!/\{index\}/.test(chip), 'the chip renders no index');
  assert.ok(chip.includes('not scorable'), 'and still refuses to band an unscorable episode');
  assert.ok(chip.includes('(near boundary)'));
});

// ── round 8: the ceiling, the hole, and the bound ───────────────────────────────────────────

test('the checkpoint token ceiling is raised and RECORDED on every row', () => {
  const cp = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(cp.includes('export const CHECKPOINT_MAX_TOKENS = 8000'), 'raised from 3000');
  // passed through the shared helper's field now, not a raw max_tokens key
  assert.ok(cp.includes('maxTokens: CHECKPOINT_MAX_TOKENS'), 'and actually passed');
  assert.ok(!cp.includes('3000'), 'the old ceiling is gone');
  // finish_reason now comes back from the shared helper, on success and on failure alike
  assert.ok(cp.includes('lastFinishReason = r.finishReason ?? lastFinishReason'));
  const mc = code('lib/ipd-episode/model-call.ts');
  assert.ok(mc.includes('finishReasonOf(res)'), 'the helper reads it off the response');
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  for (const col of ['max_tokens', 'finish_reason', 'attempts', 'entries_truncated']) {
    assert.ok(sqlText.includes(col), `.sql declares ${col}`);
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `the route back-fills ${col}`);
  }
});

test('a hole in the expected course cannot be scored over', () => {
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes("checkpoints.filter((c) => c.status === 'error' || c.entryCount === 0).length"),
    'an errored OR empty checkpoint counts as incomplete');
  assert.ok(run.includes('incompleteCheckpoints,'), 'and reaches the status function');
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes("if ((a.incompleteCheckpoints ?? 0) > 0) return 'incomplete_checkpoints';"));
  // tested FIRST, so it outranks no_expectations and all_capped
  const fn = core.slice(core.indexOf('export function scoringStatusFor'), core.indexOf('export function storedDivergenceIndex'));
  assert.ok(fn.indexOf('incomplete_checkpoints') < fn.indexOf('no_expectations'));
  assert.ok(core.includes("if (status === 'no_expectations' || status === 'incomplete_checkpoints') return null;"),
    'and the index is stored NULL');
  const ui = code('app/admin/ipd-audit/episodes/ui.tsx');
  assert.ok(ui.includes('part of the expected course is missing'), 'the UI gives the reason');
});

test('the expected course is bounded in the prompt AND in code', () => {
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /AT MOST FOUR ENTRIES PER CATEGORY/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /MOST CONSEQUENTIAL FIRST/);
  const core = code('lib/ipd-episode/checkpoint-core.ts');
  assert.ok(core.includes('export const MAX_ENTRIES_PER_CATEGORY = 4'));
  assert.ok(core.includes('export function capExpectedCourse('), 'a prompt is a request; this is the guarantee');
  const cp = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(cp.includes('capExpectedCourse(course)'), 'and it runs on every checkpoint');
});

// ── decision 33: omission is a lookup, not a judgement ──────────────────────────────────────

test('the resolver is pure — no db, no model, no Next, nothing that could vary between runs', () => {
  const src = code('lib/ipd-episode/resolve-core.ts');
  for (const banned of ['governedChat', 'metabaseQuery', 'from \'../db\'', 'next/', 'Math.random', 'Date.now', 'new Date(']) {
    assert.ok(!src.includes(banned), `resolve-core must not contain '${banned}' — determinism is the point`);
  }
  // it imports exactly one thing, and it is a type
  const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
  assert.equal(imports.length, 1, 'one import');
  assert.ok(imports[0].startsWith('import type'), 'and it is type-only');
});

test('the resolver is the ONLY producer of unassessable, and code owns omissions', () => {
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('resolveAll(resolvableEntries'), 'the pipeline resolves every expectation');
  assert.ok(run.includes('findingsFromResolved('), 'and turns the outcomes into findings');
  // the diff pass's omissions are dropped
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('export function dropJudgedOmissions('));
  assert.ok(core.includes('const judged = f.resolution == null;'),
    'only JUDGED omissions are dropped — the resolver’s own are the analysis');
  // and unassessable is enforced
  assert.ok(core.includes('export function enforceUnassessable('));
  assert.ok(core.includes("if (f.resolution === 'absent_class_missing') return { finding: f, rejected: false };"),
    'the one honest gap is exempt because code established it');
});

test('the Tier C rule cannot erase a code-established absence', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  const fn = core.slice(core.indexOf('export function applyTierCRule'), core.indexOf('export function applyUncitedCap'));
  assert.ok(fn.includes('if (f.resolution != null) return { finding: f, rewritten: false };'),
    'an absence has nothing to cite by definition — §4.2 would delete every omission without this');
});

test('the resolver runs against the SAME blinded event list the diff pass sees', () => {
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('const resolverEvents = diffPassEvents(events);'),
    'no discharge event — an expectation cannot be satisfied by the discharge summary');
});

test('the checkpoint prompt asks for a matcher and a severity, both at generation time', () => {
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /EVERY EXPECTATION MUST BE MACHINE-CHECKABLE/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /"matcher": \{"kind": "drug", "terms": \[\]\}/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /proposed_severity/);
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /while you still do not know how the admission ended/,
    'severity chosen blind cannot be coloured by hindsight');
});

test('the unassessable definition is the mirror-gap one, in the pass that emits verdicts', () => {
  // the checkpoint prompt emits no verdicts, so the definition belongs in the DIFF prompt
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /THE MIRROR CANNOT ANSWER/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /the entire data class is absent from this pipeline/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /If you can point at a source table that would have held the answer, the verdict is not unassessable/);
  assert.ok(!/unassessable: the record cannot answer the question/.test(IPD_EPISODE_DIFF_SYSTEM),
    'the old loose definition is what produced 23 unearned unassessable verdicts');
});

test('a checkpoint generated with no retrieval says so', () => {
  const cp = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(cp.includes('retrievalSkipped: !query.trim()'), 'an empty query means no search was attempted');
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(sqlText.includes('retrieval_skipped'), '.sql declares it');
  assert.ok(route.includes('ADD COLUMN IF NOT EXISTS retrieval_skipped'), 'and the route back-fills it');
});

test('the query is built from a WHITELIST of clinical fields, not by stripping a blob', () => {
  const core = code('lib/ipd-episode/assemble-core.ts');
  assert.ok(core.includes('export const QUERY_NARRATIVE_FIELDS'), 'the whitelist exists');
  assert.ok(core.includes('export function queryNarrativeFrom('), 'and the builder that applies it');
  // fields nobody has thought of are excluded by default, which a deny-list can never do
  for (const excluded of ["'doctor'", "'role'", "'tag_data'", "'isDischarge'"]) {
    const list = core.slice(core.indexOf('QUERY_NARRATIVE_FIELDS'), core.indexOf('queryNarrativeFrom'));
    assert.ok(!list.includes(excluded), `${excluded} must not be whitelisted`);
  }
  // and pharmacy SKUs no longer reach retrieval at all
  const cpCore = code('lib/ipd-episode/checkpoint-core.ts');
  assert.ok(!cpCore.includes("detailStr(e, 'ordered_item_name')"),
    'ABSTACK and SODIUM proved twice that a SKU cannot be cleaned into a clinical term');
});

test('the diff temperature is named and recorded on the row', () => {
  const judge = code('lib/ipd-episode/judge.ts');
  assert.ok(judge.includes('export const JUDGE_TEMPERATURE = 0'));
  assert.ok(judge.includes('temperature: JUDGE_TEMPERATURE'));
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  assert.ok(sqlText.includes('judge_temperature'), 'stored, so the claim is checkable from the row');
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('judge_temperature') && store.includes('resolution_counts'));
});

// ── round 5 ─────────────────────────────────────────────────────────────────────────────────

test('ONE cap rule (round 14 item 10): citation OR Tier A evidence, and severity is not an exemption', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  // The two stacked caps are gone; one rule remains, and it is a disjunction.
  assert.ok(core.includes('if (f.citation_ids.length > 0 || findingHasTierAEvidence(f)) return { finding: f, capped: false };'),
    'either kind of support is enough — requiring both is what made major unreachable');
  assert.ok(!/export function applyUncitedCap\b/.test(core), 'the uncited cap no longer caps');
  const fn = core.slice(core.indexOf('export function applySeverityCap'), core.indexOf('export function entryWasUncited'));
  assert.ok(!/severity === 'major'/.test(fn), 'major is not exempt — that would hold the loudest findings to the weakest standard');
  // and the literature cap no longer lowers anything
  assert.ok(!/applyLiteratureCap\(/.test(core.slice(core.indexOf('export function finalizeFindings'))),
    'literature is classified and counted, not capped');
});

test('the cap trail is persisted on every finding, and capped_count on the row', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  for (const field of ['verdict_before_cap', 'severity_before_cap', 'capped']) {
    assert.ok(core.includes(`${field}:`), `the finding carries ${field}`);
  }
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(/capped_count          INTEGER DEFAULT 0/.test(sqlText));
  assert.ok(route.includes('ADD COLUMN IF NOT EXISTS capped_count INTEGER DEFAULT 0'));
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('num(row.cappedCount)'), 'the writer persists it');
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('cappedCount: final.capped_finding_ids.size'), 'from the same set the status uses');
});

test('the normative leg is OFF — a normative chunk earns its slot on relevance or does not appear', () => {
  const cp = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(!cp.includes('useNormativeLeg: true'),
    'the leg reserves slots by construction: RRF scores its rank 1 exactly as the main leg’s rank 1');
  assert.ok(cp.includes('minSimilarity: RETRIEVAL_MIN_SIMILARITY'), 'the floor is still passed explicitly');
  assert.ok(cp.includes('sim >= RETRIEVAL_MIN_SIMILARITY'), 'and the gate is kept as a backstop');
  assert.ok(cp.includes('normativeDropped'), 'drops are counted, not silent');
  // the corpus stays WIDE — nothing became uncitable, the reservation just went away
  assert.ok(!cp.includes('restrictSources'), 'the main legs are still unrestricted');
  assert.ok(!/source:\s*'/.test(cp), 'no single-source filter');
});

test('the generation settings are recorded on every checkpoint row', () => {
  const cp = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(cp.includes('export const CHECKPOINT_TEMPERATURE = 0'), 'temperature 0 on the checkpoint call');
  assert.ok(cp.includes('export const CHECKPOINT_SEED: number | null = null'),
    'seed is null because Bedrock Converse has no wire field for one');
  // and the transport really has no seed — toConverseInput builds maxTokens + temperature only
  const core = readFileSync(join(process.cwd(), 'lib/bedrock-core.ts'), 'utf8');
  const cfg = core.slice(core.indexOf('const inferenceConfig'), core.indexOf('const inferenceConfig') + 400);
  assert.ok(!cfg.includes('seed'), 'lib/bedrock-core.ts confirms there is nowhere to put a seed');
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  for (const col of ['temperature', 'seed']) {
    assert.ok(sqlText.includes(col), `.sql declares ${col}`);
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `the route back-fills ${col}`);
  }
});

test('EVERY RUN IS KEPT: run_seq, is_current, and no upsert', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(sqlText.includes('run_seq               INTEGER NOT NULL DEFAULT 1'));
  assert.ok(sqlText.includes('is_current            BOOLEAN NOT NULL DEFAULT TRUE'));
  assert.ok(sqlText.includes('ipd_episode_audits_current_uq') && sqlText.includes('WHERE is_current'),
    'exactly one current row is a database guarantee, not a convention');
  assert.ok(!sqlText.includes('ipd_episode_audits_encounter_engine_uq'), 'the old unique index is gone');

  // the route migrates an existing table in the right ORDER: add, backfill, drop, recreate
  const addAt = route.indexOf('ADD COLUMN IF NOT EXISTS is_current');
  const fillAt = route.indexOf('SET is_current = TRUE WHERE is_current IS NULL');
  const dropAt = route.indexOf('DROP INDEX IF EXISTS ipd_episode_audits_encounter_engine_uq');
  const newAt = route.indexOf('ipd_episode_audits_current_uq');
  assert.ok(addAt > 0 && fillAt > addAt && dropAt > fillAt && newAt > dropAt,
    'backfill before dropping the old index, and drop before adding the new one');

  const store = code('lib/ipd-episode/store.ts');
  const insert = store.slice(store.indexOf('INSERT INTO ipd_episode_audits'), store.indexOf('RETURNING id'));
  assert.ok(!insert.includes('ON CONFLICT'), 'the audits write is a plain INSERT — every run is its own row');
  assert.ok(store.includes('SET is_current = FALSE'), 'the previous run is demoted first');
  assert.ok(!store.includes('DELETE FROM ipd_episode_checkpoints'),
    'no checkpoint DELETE: a new run owns a new audit id, so there is nothing to clear');
});

test('worker selection and the UI list read is_current only', () => {
  const store = code('lib/ipd-episode/store.ts');
  const audited = store.slice(store.indexOf('export async function auditedEncounterIds'), store.indexOf('export interface SkipRow'));
  assert.ok(audited.includes('is_current = TRUE'), 'the worker watermark counts current rows only');
  const worklist = store.slice(store.indexOf('export async function episodeWorklist'), store.indexOf('export async function episodeAuditById'));
  assert.ok(worklist.includes('is_current = TRUE'), 'and so does the list surface');
});

test('topicality is per excerpt, with a count beside the boolean', () => {
  const core = code('lib/ipd-episode/checkpoint-core.ts');
  assert.ok(core.includes('export function assessTopicality('), 'the per-excerpt assessor exists');
  // ROUND 14 ITEM 7: the majority rule could not fire on the slates this engine actually gets.
  assert.ok(core.includes('offTopic: off >= offTopicThreshold(excerpts.length)'),
    'the boolean fires at a quarter of the slate, which is a threshold eight excerpts can reach');
  assert.ok(core.includes('const terms = distinctive(x.label);'),
    'and each excerpt is judged on its title, not on a body that borrows the query’s vocabulary');
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  for (const col of ['offtopic_excerpt_count', 'day0_query_from_ot']) {
    assert.ok(sqlText.includes(col), `.sql declares ${col}`);
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `the route back-fills ${col}`);
  }
});

test('NOTHING in retrieval reaches outside the cut-off — the day 0 fallback reads the filtered window', () => {
  const core = code('lib/ipd-episode/checkpoint-core.ts');
  assert.ok(core.includes('input.isDayZero && input.episodeSurgeryNames?.length'), 'day 0 only');
  const run = code('lib/ipd-episode/run.ts');
  // ⚠️ the fallback used to be handed `events` (the WHOLE episode), so an OT note at 11:53 selected
  // day 0's evidence against a 03:03 cut-off. It now reads input_events, the same filtered list
  // every other rule uses.
  assert.ok(run.includes('episodeSurgeryNames: input_events'), 'sourced from the cut-off window');
  assert.ok(!/episodeSurgeryNames: events\b/.test(run) && !run.includes('const episodeSurgeryNames = Array.from(new Set(\n      events'),
    'never from the unfiltered episode list');
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('day0QueryFromOt'), 'and every row it touches records it');
});

test('the extracted case reaches only the two places that are entitled to it', () => {
  const run = code('lib/ipd-episode/run.ts');
  // every read of the stored extraction in the pipeline
  const reads = [...run.matchAll(/extraction\.extractedJson/g)].length;
  assert.equal(reads, 2, 'exactly two: assembly (onto the discharge event) and the fidelity pass');
  assert.ok(/extractedCase: extraction\.extractedJson/.test(run), 'assembleEpisode — filtered out of every blinded input');
  assert.ok(/runFidelityPass\([\s\S]{0,400}extractedCase: extraction\.extractedJson/.test(run),
    'runFidelityPass — the one pass whose job is to read it');
});

test('a thin query is an honest answer, not a gap to backfill', () => {
  const cpCore = code('lib/ipd-episode/checkpoint-core.ts');
  // nothing invents content when the window is empty: the builder only ever pushes strings it
  // found on the filtered events, and returns '' when it found none
  assert.ok(cpCore.includes("const query = collapseSpaces(parts.join(' ')).slice(0, Q_TOTAL_CHARS);"));
  assert.ok(cpCore.includes("return { query: '', day0FromOt: false };"),
    'an empty window yields an empty query — nothing invents clinical words');
  // the ONE fallback is the day 0 OT note, and it is gated and stamped (round 5 item 3)
  const fallbacks = (cpCore.match(/day0FromOt: true/g) ?? []).length;
  assert.equal(fallbacks, 1, 'exactly one fallback path exists');
});

test('retrieved titles and the off-topic flag are stored as columns, not buried in jsonb', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  for (const col of ['retrieved_titles', 'retrieval_offtopic']) {
    assert.ok(sqlText.includes(col), `.sql declares ${col}`);
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `the route back-fills ${col}`);
  }
  assert.ok(sqlText.includes('retrieved_titles    TEXT[]'), 'titles are a text[]');
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('$17::text[]'), 'the insert casts the titles array');
  // off topic never blocks generation
  const cp = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(!/if \(.*retrievalIsOffTopic/.test(cp), 'the flag is recorded, never branched on');
});

test('divergence_index alone among the counted columns may be NULL, and is never defaulted to 0', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(/divergence_index      INTEGER,/.test(sqlText), '.sql leaves it nullable with no default');
  assert.ok(!/divergence_index\s+INTEGER DEFAULT 0/.test(sqlText) && !/divergence_index\s+INTEGER DEFAULT 0/.test(route),
    'a DEFAULT 0 would make "not scorable" read as the worst episode ever recorded');
  assert.ok(route.includes('ALTER COLUMN divergence_index DROP DEFAULT'),
    'and a table created by an earlier run has the default removed');
  // the writer must not coalesce it either
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(!store.includes('num(row.divergenceIndex)'), 'the writer passes it through, nulls included');
  assert.ok(store.includes('row.divergenceIndex,'));
});

test('scoring_status is stored and the UI refuses to render a number without one', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(sqlText.includes("scoring_status        TEXT NOT NULL DEFAULT 'ok'"));
  assert.ok(route.includes("ADD COLUMN IF NOT EXISTS scoring_status TEXT NOT NULL DEFAULT 'ok'"));
  const ui = code('app/admin/ipd-audit/episodes/ui.tsx');
  assert.ok(ui.includes('not scorable'), 'the chip says so in words');
  assert.ok(/if \(st !== 'ok' \|\| !band\)/.test(ui), 'any status but ok suppresses the band too');
  // both surfaces pass the status in
  for (const f of ['app/admin/ipd-audit/episodes/page.tsx', 'app/admin/ipd-audit/episodes/[id]/page.tsx']) {
    assert.ok(read(f).includes('scoring_status'), `${f} passes scoring_status to the chip`);
  }
});

// ── V's 2026-09-02 widening: cite anything, but price it ─────────────────────────────────────

test('retrieval is not restricted to the normative allowlist', () => {
  const src = code('lib/ipd-episode/checkpoint.ts');
  // the MAIN legs are unrestricted: neither knob that would fence the corpus is set
  assert.ok(!src.includes('restrictSources'), 'the main legs are not restricted to a source list');
  assert.ok(!/source:\s*'/.test(src), 'no single-source filter — StatPearls and journal content are citable');
  assert.ok(src.includes('topK: RETRIEVAL_TOP_K'), 'k is still 8');
  // round 6 item 5 turned the normative LEG off; its own test explains why
});

test('the normative source list is the shipped one, never a local copy that can drift', () => {
  const src = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(src.includes("resolveNormativeSources") && src.includes("from '../retrieve'"),
    'classification resolves against lib/retrieve.ts’s own helper');
  // no hand-written allowlist anywhere in the engine
  for (const f of ENGINE_FILES) {
    const body = code(f);
    assert.ok(!/\[\s*'choosing-wisely'/.test(body), `${f} must not hardcode a normative source list`);
  }
});

test('each checkpoint row records the source of every cited chunk, as a fact not a verdict', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(sqlText.includes('citation_sources    JSONB'), '.sql declares citation_sources');
  assert.ok(route.includes('ADD COLUMN IF NOT EXISTS citation_sources JSONB'), 'and the route back-fills it');
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('citation_sources') && store.includes('$16::jsonb'), 'the insert writes it');
  // the STORED value is the raw source string; the normative/literature split is derived later, so
  // a change to the source list can be re-applied to old rows without re-running a model
  const cp = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(cp.includes("sources[String(Number(h.id))] = String(h.source ?? '')"),
    'the chunk’s own source value is stored verbatim');
});

test('round 14 item 10: literature is CLASSIFIED and COUNTED, and caps nothing', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  // provenance survives — the question "how much of this score rests on guidelines" stays answerable
  assert.ok(core.includes('classifyCitationProvenance(capRes.finding'), 'still classified');
  assert.ok(core.includes("if (provenance === 'literature') litCapped++;"), 'and still counted');
  // but it no longer runs as a cap inside the chain
  const chain = core.slice(core.indexOf('export function finalizeFindings'));
  assert.ok(!/applyLiteratureCap\(/.test(chain),
    'a StatPearls passage is support for an expectation; it may not silence a finding built on one');
});

test('round 14 item 1: the billing ceiling runs BEFORE the severity cap, and is lower', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes("export const BILLING_ONLY_CEILING: Severity = 'minor';"),
    'a dispensing-only claim is held below the ordinary ceiling');
  assert.ok(core.indexOf('applyBillingOnlyCap(f0, events)') < core.indexOf('applySeverityCap(billRes.finding)'),
    'order matters: a citation must not lift a billing-only claim back up');
  assert.ok(core.includes('BILLING_ONLY_CAVEAT'), 'and the caveat is written into the statement a reader sees');
});

test('citation_provenance is stored on every finding so the cohort can be measured later', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('citation_provenance: CitationProvenance | null'), 'it is part of the finding shape');
  assert.ok(core.includes('provenance_counts'), 'and rolled up per episode');
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('citations by provenance:'), 'the run reports the breakdown');
  const panels = read('app/admin/ipd-audit/episodes/[id]/panels.tsx');
  assert.ok(panels.includes('citation_provenance') && panels.includes('literature only'),
    'and the UI shows it, so a reader can see why a finding is not major');
});

// ── round 3: nothing this engine discards may disappear ─────────────────────────────────────

test('the checkpoint pass retries ONCE when the whole course comes back uncited and retrieval worked', () => {
  const src = code('lib/ipd-episode/checkpoint.ts');
  assert.ok(src.includes('everyEntryUncited('), 'the retry is triggered by that exact shape');
  assert.ok(src.includes('excerpts.length > 0 && everyEntryUncited('),
    'and only when there were excerpts to cite — no excerpts is not a failure');
  // one retry, not a loop
  assert.equal((src.match(/await askOnce\(/g) ?? []).length, 2, 'exactly two asks: the first and one retry');
  assert.ok(src.includes('if (second.course && !everyEntryUncited('),
    'a retry that also cites nothing is discarded and the first answer stands');
  assert.ok(src.includes('uncitedEntryCount'), 'and the count is recorded either way');
});

test('an uncited entry is never repaired by guessing — the count is the whole response', () => {
  const core = code('lib/ipd-episode/checkpoint-core.ts');
  assert.ok(core.includes('export function countUncitedEntries('), 'it counts');
  // nothing in the engine attaches a citation on a text overlap. `similarity` is excluded from the
  // pattern: round 5 item 5 gates the normative leg on retrieval's own similarity floor, which
  // decides which excerpts are SHOWN and never which of them a finding is said to have used.
  for (const f of ENGINE_FILES) {
    const src = code(f).replace(/citation_ids/g, '').replace(/[Ss]imilarity/g, '').replace(/MIN_SIMILARITY/g, '');
    assert.ok(!/overlap|fuzzy/i.test(src), `${f} must not infer a citation from text similarity`);
  }
  // and the count is never repaired into a citation
  const cpCore = code('lib/ipd-episode/checkpoint-core.ts');
  assert.ok(!/citation_ids\s*=\s*\[[^\]]/.test(cpCore), 'no code path assigns a citation list it did not parse');
});

test('the checkpoint row carries grounding as scalars, in the DDL and in the writer', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  for (const col of ['uncited_entry_count', 'entry_count']) {
    assert.ok(sqlText.includes(col), `.sql declares ${col}`);
    assert.ok(route.includes(col), `the route declares and back-fills ${col}`);
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `${col} is added to an existing table`);
  }
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('uncitedEntryCount') && store.includes('$14,$15'), 'the insert writes both');
});

test('discarded findings are persisted with their raw fragment, and traced', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(sqlText.includes('raw_judge_error       JSONB'), '.sql declares raw_judge_error');
  assert.ok(route.includes('ADD COLUMN IF NOT EXISTS raw_judge_error JSONB'), 'and the route back-fills it');
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('rawJudgeError: failures.length ? failures : null'), 'the pipeline persists the failures');
  assert.ok(run.includes('ipd_episode_unparseable_findings'), 'and raises a trace event');
  assert.ok(run.includes('failures,'), 'the trace event carries the fragments, not just a count');
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('PARSE_FRAGMENT_CHARS = 1000'), 'fragments are truncated to 1000 chars');
});

test('n_parse_failed exists in the DDL and every discard reaches n_dropped_invalid', () => {
  const sqlText = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  assert.ok(/n_parse_failed\s+INTEGER DEFAULT 0/.test(sqlText) && /n_parse_failed\s+INTEGER DEFAULT 0/.test(route));
  assert.ok(route.includes('ADD COLUMN IF NOT EXISTS n_parse_failed INTEGER DEFAULT 0'));
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('n_dropped_invalid: domainDropped + parseFailed'),
    'the counter is the SUM — item 5 reverses round 2 deliberately');
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(store.includes('n_parse_failed'), 'and the writer persists it');
});

test('an all-uncited episode raises its own trace event and says so on the row', () => {
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(run.includes('ipd_episode_all_entries_uncited'), 'the grounding failure is traceable');
  assert.ok(run.includes('came back uncited'), 'and stated in error_detail');
});

// ── the batch driver: skips must not consume a slot (fix round 2, items 4 and 6) ─────────────

test('a candidate list of [no_notes, no_extraction, ok, ok, ok] with max=2 audits exactly the first two ok episodes', async () => {
  const plan: Record<string, RunEpisodeResult> = {
    e1: { encounterId: 'e1', skip: 'no_notes', latencyMs: 1 },
    e2: { encounterId: 'e2', skip: 'no_extraction', latencyMs: 1 },
    e3: { encounterId: 'e3', status: 'inserted', latencyMs: 1 },
    e4: { encounterId: 'e4', status: 'inserted', latencyMs: 1 },
    e5: { encounterId: 'e5', status: 'inserted', latencyMs: 1 },
  };
  const seen: string[] = [];
  const { results, tally } = await runEpisodeBatch(
    ['e1', 'e2', 'e3', 'e4', 'e5'].map((encounterId) => ({ encounterId, dischargedAt: null })),
    2,
    async (input) => { seen.push(input.encounterId); return plan[input.encounterId]; },
  );

  assert.deepEqual(seen, ['e1', 'e2', 'e3', 'e4'], 'it walked past both skips and stopped after two real audits');
  assert.equal(tally.audited, 2, 'exactly two episodes were audited');
  assert.deepEqual(results.filter((r) => r.status).map((r) => r.encounterId), ['e3', 'e4'],
    'and they are the FIRST two ok episodes, in order');
  assert.ok(!seen.includes('e5'), 'the third ok episode is left for the next tick');
  assert.equal(tally.candidatesExamined, 4);
  assert.equal(tally.skipped, 2);
  assert.deepEqual(tally.skippedByReason, { no_notes: 1, no_extraction: 1 });
  assert.equal(tally.errors, 0);
});

test('a selection skip costs no slot; a model-stage skip does — that is what `max` is bounding', () => {
  // conditions 1–3 are decided before a model runs, so they are free
  for (const skip of ['no_discharge_summary', 'no_notes', 'no_extraction']) {
    assert.equal(countsTowardMax({ skip }), false, skip);
  }
  // these two spent the whole checkpoint + judge budget before failing
  for (const skip of ['diff_failed', 'fidelity_failed']) {
    assert.equal(countsTowardMax({ skip }), true, skip);
  }
  assert.equal(countsTowardMax({ skip: undefined }), true, 'a successful audit obviously counts');
});

test('a tick cannot spin: the examine cap stops it even when nothing in the queue qualifies', async () => {
  const queue = Array.from({ length: 500 }, (_, i) => ({ encounterId: `e${i}`, dischargedAt: null }));
  let calls = 0;
  const { tally } = await runEpisodeBatch(queue, 2, async (input) => {
    calls++;
    return { encounterId: input.encounterId, skip: 'no_extraction', latencyMs: 1 };
  });
  assert.equal(calls, MAX_CANDIDATES_EXAMINED, 'it stops at the cap, not at the end of a 500-long queue');
  assert.equal(tally.candidatesExamined, MAX_CANDIDATES_EXAMINED);
  assert.equal(tally.audited, 0);
  assert.equal(tally.capReached, true, 'and it SAYS it stopped on the cap rather than looking caught-up');
  assert.equal(tally.exhausted, false);
});

test('the batch driver reports errors separately from skips', async () => {
  const { tally } = await runEpisodeBatch(
    [{ encounterId: 'a', dischargedAt: null }, { encounterId: 'b', dischargedAt: null }],
    5,
    async (input) => (input.encounterId === 'a'
      ? { encounterId: 'a', error: 'metabase unreachable', latencyMs: 1 }
      : { encounterId: 'b', status: 'inserted' as const, latencyMs: 1 }),
  );
  assert.equal(tally.errors, 1);
  assert.equal(tally.audited, 1);
  assert.equal(tally.skipped, 0, 'a transport error is not a skip — it writes no skip row either');
  assert.equal(tally.exhausted, true);
});

test('the worker reports the per-tick tally the review asked for, and no longer truncates its queue', () => {
  const src = code('app/api/ipd-episode/worker/route.ts');
  for (const field of ['candidatesExamined', 'audited', 'skippedByReason', 'errors', 'queueLength', 'capReached']) {
    assert.ok(src.includes(field), `the sweep response must report ${field}`);
  }
  assert.ok(src.includes('runEpisodeBatch('), 'the sweep runs through the tested batch driver');
  assert.ok(!/nextCandidates\(max\)/.test(src), 'the queue is no longer pre-truncated to max');
});

// ── the worker ───────────────────────────────────────────────────────────────────────────────

test('the worker mirrors the IPD discharge worker: 800 s box, the same auth, ?max= default 2 cap 5', () => {
  const src = code('app/api/ipd-episode/worker/route.ts');
  assert.ok(src.includes('export const maxDuration = 800'));
  assert.ok(src.includes("export const runtime = 'nodejs'") && src.includes("export const dynamic = 'force-dynamic'"));
  assert.ok(src.includes("req.headers.get('x-vercel-cron')") && src.includes('CRON_SECRET') && src.includes('isAdminUnlocked()'));
  assert.ok(src.includes("Math.max(1, Math.min(5, Number(p.get('max') || 2)))"), '?max= defaults to 2 and caps at 5');
  assert.ok(src.includes("p.get('encounter')"), '?encounter= runs one named episode');
  // sequential by construction: no concurrency knob exists at all
  assert.ok(!src.includes("p.get('conc')") && !src.includes('mapLimit'), 'the worker has no concurrency knob');
  // the loop itself now lives in run.ts's injectable batch driver (so it is unit-testable); the
  // point still stands — one episode at a time, awaited, no Promise.all anywhere on this path
  const runSrc = code('lib/ipd-episode/run.ts');
  assert.ok(/for \(const c of candidates\) \{/.test(runSrc), 'runEpisodeBatch processes candidates one after another');
  assert.ok(!/Promise\.all\([^)]*runner/.test(runSrc), 'never concurrently — three Opus calls per episode is the whole budget');
  assert.ok(src.includes('runEpisodeBatch('), 'and the worker drives it');
});

test('the worker holds the app_settings lock key the PRD names, and releases it in finally', () => {
  const src = code('app/api/ipd-episode/worker/route.ts');
  assert.ok(src.includes("'ipd_episode_lock'"));
  assert.ok(src.includes('lockHeld(') && src.includes('locked: true'), 'a held lock returns {ok:true, locked:true} and does nothing');
  assert.ok(/} finally \{[\s\S]*setSetting\(LOCK_KEY, ''\)/.test(src), 'the lock is released in finally');
});

test('the lock TTL is 780 s — its own, not the 210 s helper sized for a 300 s box', () => {
  const src = code('app/api/ipd-episode/worker/route.ts');
  assert.ok(src.includes('const IPD_EPISODE_LOCK_TTL_MS = 780 * 1000'), 'a local 780 s TTL');
  assert.ok(!/import \{[^}]*lockHeld[^}]*\} from '@\/lib\/mini-backfill'/.test(src),
    'mini-backfill’s 210 s lockHeld must not be imported here — one episode can run ~520 s');
  assert.ok(/function lockHeld\(/.test(src), 'the predicate is defined locally');
  // the TTL must sit under the box: a lock outliving its own invocation wedges the worker
  const box = Number(src.match(/maxDuration = (\d+)/)![1]) * 1000;
  const ttl = 780 * 1000;
  assert.ok(ttl < box, 'the TTL clears before the box does');
  assert.ok(ttl > 520 * 1000, 'and outlasts a worst-case single episode, so a healthy tick is never called stale');
});

// ── engine identity ──────────────────────────────────────────────────────────────────────────

test('the engine version and the closed set of skip reasons', () => {
  assert.equal(IPD_EPISODE_ENGINE_VERSION, 'ipd-episode-audit/0.1');
  // the PRD's five, plus the two lifecycle markers round 10 added so a dead invocation is visible
  assert.deepEqual([...SKIP_REASONS], [
    'no_discharge_summary', 'no_notes', 'no_extraction', 'diff_failed', 'fidelity_failed',
    'in_progress', 'timed_out',
  ]);
});

test('every skip reason the pipeline writes is declared, and the PRD five are all reachable', () => {
  const run = code('lib/ipd-episode/run.ts');
  const written = new Set([...run.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]));
  for (const r of written) assert.ok((SKIP_REASONS as readonly string[]).includes(r), `'${r}' is not a declared skip reason`);
  for (const r of ['no_discharge_summary', 'no_notes', 'no_extraction', 'diff_failed', 'fidelity_failed', 'in_progress']) {
    assert.ok(written.has(r), `'${r}' is declared but never written`);
  }
  // 'timed_out' is deliberately NOT written by the pipeline: the process is dead by then. It is
  // the reason a SWEEP would stamp on a stale in_progress marker it reclaims.
  assert.ok(!written.has('timed_out'), 'a dying invocation cannot write its own epitaph');
});

test('a db13 fault writes NO audit row and NO skip row — a transport failure is not a fact about an episode', () => {
  const run = code('lib/ipd-episode/run.ts');
  const tail = run.slice(run.lastIndexOf('} catch (e) {'));
  assert.ok(!tail.includes('recordSkip('), 'the top-level catch must not write a skip');
  assert.ok(!tail.includes('saveEpisodeAudit('), 'the top-level catch must not write an audit row');
  assert.ok(tail.includes('error:'), 'it returns a recorded error instead');
});

test('no route in this build can return a 500 on a failed audit (§8)', () => {
  const worker = code('app/api/ipd-episode/worker/route.ts');
  const statuses = [...worker.matchAll(/status:\s*(\d{3})/g)].map((m) => Number(m[1]));
  for (const s of statuses) assert.ok(s === 401 || s === 400, `the worker returns only 401/400, found ${s}`);
});


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 13 ITEMS 1 & 2 · THE WALL-CLOCK BUDGET, AND THE LADDER THAT MULTIPLIED THE FAILURE
//
// IP-1483: the diff pass timed out at 332,735 ms, was retried, timed out at 331,818 ms, and a
// third attempt began at +763.7 s inside an 800 s box. The function was killed. No audit row, no
// skip row — the same "spent the whole budget and persisted nothing" failure round 11 produced by
// a different route.
//
// The arithmetic behind it: governedChat already runs PROVIDER_BUDGETS.bedrock.utility, 110 s ×
// 3 = 332,250 ms of worst case, and this engine wrapped THAT in three more attempts. Nine
// provider attempts in a box that fits two.
//
// A refused call is testable without a provider precisely BECAUSE it is refused: nothing is sent.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('round 13 item 2: the engine adds NO ladder of its own — governedChat already has one', () => {
  assert.equal(TRANSPORT_ATTEMPTS, 1,
    'three attempts here multiplied a 332 s provider ladder into 996 s inside an 800 s box');
});

test('round 13 item 1: the worst case is DERIVED from the budget table, never typed here', () => {
  assert.equal(ONE_CALL_WORST_CASE_MS, totalBudgetMs('bedrock', 'utility'),
    'a hand-copied number would have to be edited in step with a table it cannot see');
  // and it is the number IP-1483 actually measured, twice
  assert.equal(ONE_CALL_WORST_CASE_MS, 332_250);
});

test('round 13 item 1: a call with no room left is REFUSED, and never reaches the provider', async () => {
  const r = await callModel({
    traceId: undefined, label: 'ipd_episode_diff',
    system: 'sys', user: 'usr', model: 'global.anthropic.claude-opus-4-6-v1',
    maxTokens: 16000, temperature: 0, promptRef: 'prompts/IPD_EPISODE_DIFF_SYSTEM',
    truncationRetryInstruction: 'shorter please',
    // one second of budget against a call that can cost 332 s
    deadlineAt: Date.now() + 1000,
  });
  assert.equal(r.attempts, 0, 'a call we declined to place is not an attempt that was made');
  assert.equal(r.budget.refusedForBudget, true);
  assert.equal(r.truncated, false, 'a budget refusal is never dressed up as a truncation');
  assert.ok(r.error, 'and it fails the call, so the episode records a skip');
  assert.match(r.error!, /not started/);
  assert.match(r.error!, /ipd_episode_diff/, 'the reason names the call');
  assert.match(r.error!, /below the 60000 ms floor/, 'and why, in the units the floor is written in');
  assert.equal(r.text, '');
});

test('round 13 item 1: the deadline and the budget remaining are recorded at every attempt', async () => {
  const deadlineAt = Date.now() + 5000;
  const r = await callModel({
    traceId: undefined, label: 'ipd_episode_fidelity',
    system: 's', user: 'u', model: 'global.anthropic.claude-opus-4-6-v1',
    maxTokens: 100, temperature: 0, promptRef: 'prompts/IPD_EPISODE_FIDELITY_SYSTEM',
    truncationRetryInstruction: 'x', deadlineAt,
  });
  assert.equal(r.budget.deadlineAt, deadlineAt, 'the deadline is on the record either way');
  assert.equal(r.budget.remainingMsAtAttempt.length, 1, 'the budget was consulted before the attempt');
  assert.ok(r.budget.remainingMsAtAttempt[0] <= 5000);
  assert.equal(r.budget.worstCaseMs, ONE_CALL_WORST_CASE_MS);
});

test('round 13 item 1: an UNBUDGETED call still runs — the deadline is opt-in for tests only', () => {
  const mc = readFileSync('lib/ipd-episode/model-call.ts', 'utf8');
  assert.match(mc, /deadlineAt\?: number \| null/, 'optional in the type');
  assert.match(mc, /const deadlineAt = input\.deadlineAt \?\? null/);
  // null remaining ⇒ the class default stands and nothing is refused
  const plan = planAttempt('audit', null);
  assert.ok(plan, 'an unbudgeted call is never refused');
  assert.equal(plan!.shrunk, false);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 14 ITEM 11 · THE CALL CLASS, AND THE REFUSAL THAT WAS TOO EAGER
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('item 11: the judge passes declare `audit`; the checkpoint pass stays `utility`', () => {
  const judge = readFileSync('lib/ipd-episode/judge.ts', 'utf8');
  const checkpoint = readFileSync('lib/ipd-episode/checkpoint.ts', 'utf8');
  assert.match(judge, /callClass: 'audit'/, 'the three Opus passes are audit-class work');
  assert.ok(!/callClass:/.test(checkpoint),
    'checkpoints generate in 15-35 s and keep utility’s 110 s × 3 — a fitting ceiling and three cheap tries');
  assert.equal(DEFAULT_CALL_CLASS, 'utility', 'and the default is unchanged, so no other caller moves');
});

test('item 11: `audit` not `audit_ipd` — 200 s is below the one diff that ever succeeded', () => {
  const audit = PROVIDER_BUDGETS.bedrock.audit!;
  const auditIpd = PROVIDER_BUDGETS.bedrock.audit_ipd!;
  assert.equal(audit.perAttemptMs, 380_000);
  assert.equal(auditIpd.perAttemptMs, 200_000);
  // IPNO-416's diff generated for 212,402 ms. audit_ipd would have failed it too.
  assert.ok(auditIpd.perAttemptMs < 212_402, 'audit_ipd would not have covered the one that passed');
  assert.ok(audit.perAttemptMs > 212_402, 'audit does');
});

test('item 11: the budget is PASSED to the transport, never inherited', () => {
  const mc = readFileSync('lib/ipd-episode/model-call.ts', 'utf8');
  assert.match(mc, /timeoutMs: plan\.perAttemptMs, maxTries: plan\.maxTries/,
    'absent these the transport silently falls back to utility inside bedrockGenerate');
});

test('item 11 / round 13 correction: a box smaller than one worst case SHRINKS the call, not refuses it', () => {
  // THE REGRESSION THIS FIXES: the commentary route's box is 300 s and one utility worst case is
  // 332 s, so the round-13 guard would have refused pass B on every episode — a route made
  // unreachable by its own guard. An audit-class 380 s ceiling would have been worse.
  const squeezed = planAttempt('audit', 250_000);
  assert.ok(squeezed, 'still worth attempting');
  assert.equal(squeezed!.shrunk, true);
  assert.equal(squeezed!.maxTries, 1, 'one attempt, since there is no room for a ladder');
  assert.ok(squeezed!.perAttemptMs <= 250_000,
    'and it cannot outlive the box — which is the guarantee that actually mattered');
  assert.ok(squeezed!.perAttemptMs >= 240_000, 'while still using nearly all of what is left');
});

test('item 11 / round 13 correction: below the viability floor it still refuses', () => {
  assert.equal(planAttempt('audit', 30_000), null, 'a judge pass cannot finish in 30 s');
  assert.equal(planAttempt('audit', MIN_VIABLE_ATTEMPT_MS - 1), null);
  assert.ok(planAttempt('audit', MIN_VIABLE_ATTEMPT_MS), 'and at the floor it tries');
});

test('item 11: with room for the full ladder, the class budget is used unshrunk', () => {
  const full = planAttempt('audit', 700_000);
  assert.deepEqual(full, { perAttemptMs: 380_000, maxTries: 1, shrunk: false });
  const util = planAttempt('utility', 700_000);
  assert.deepEqual(util, { perAttemptMs: 110_000, maxTries: 3, shrunk: false });
});

test('item 11: the commentary route can now actually run pass B inside its 300 s box', () => {
  const src = readFileSync('app/api/ipd-episode/commentary/route.ts', 'utf8');
  const maxDuration = Number(/export const maxDuration = (\d+)/.exec(src)?.[1]);
  const reserve = Number(/const COMMENTARY_RESERVE_MS = (\d+) \* 1000/.exec(src)?.[1]) * 1000;
  const budget = maxDuration * 1000 - reserve;
  assert.ok(budget < worstCaseMsFor('audit'), 'the box is genuinely smaller than one full call');
  assert.ok(planAttempt('audit', budget), 'and pass B is attempted anyway, ceilinged to fit');
});

test('round 13 item 1: every production model call site passes a deadline', () => {
  const judge = readFileSync('lib/ipd-episode/judge.ts', 'utf8');
  const checkpoint = readFileSync('lib/ipd-episode/checkpoint.ts', 'utf8');
  const run = readFileSync('lib/ipd-episode/run.ts', 'utf8');
  assert.match(checkpoint, /deadlineAt: input\.deadlineAt \?\? null/, 'checkpoints');
  assert.match(judge, /callModel\(\{[\s\S]*?deadlineAt/, 'the judge helper forwards it');
  for (const pass of ['runDiffPass', 'runFidelityPass']) {
    assert.match(run, new RegExp(`${pass}\\(\\{[\\s\\S]{0,200}?deadlineAt`), `${pass} is given the deadline`);
  }
  assert.match(run, /runCheckpoint\(\{[\s\S]{0,80}?deadlineAt/, 'and so is every checkpoint');
});

test('round 13 item 1: the worker derives the deadline FROM maxDuration, and reserves persist time', () => {
  const src = readFileSync('app/api/ipd-episode/worker/route.ts', 'utf8');
  // derived, not restated: the guard is a lie the moment the two can disagree
  assert.match(src, /maxDurationSeconds: number = maxDuration/,
    'the helper defaults to the route’s own maxDuration rather than a copy of the number');
  assert.match(src, /startedAt \+ maxDurationSeconds \* 1000 - PERSIST_RESERVE_MS/);
  assert.ok(!/const PERSIST_RESERVE_MS = 0\b/.test(src), 'the reserve is non-zero');
  // both entry points, because ?encounter= is how every spot check runs
  assert.match(src, /runEpisodeAudit\(\{ encounterId: one, deadlineAt \}\)/, 'the single-episode path');
  assert.match(src, /runEpisodeAudit\(\{ \.\.\.i, deadlineAt \}\)/, 'and the sweep');
});

test('round 13: a refused or failed diff still writes a diff_failed SKIP — never a silent death', () => {
  const run = readFileSync('lib/ipd-episode/run.ts', 'utf8');
  const afterDiff = run.slice(run.indexOf('const a1 = await runDiffPass'));
  const block = afterDiff.slice(0, afterDiff.indexOf('const a2 = await runFidelityPass'));
  assert.match(block, /if \(!a1\.ok\)/);
  assert.match(block, /recordSkip\(\{[\s\S]*?reason: 'diff_failed'/,
    'PRD §8: every failure degrades to a RECORDED no-op');
});

test('round 13 item 3: the diff prompt describes the digest it is actually sent', () => {
  // A prompt that promises excerpt numbers to a model that is shown none is an instruction to
  // invent them — and invented ordinals resolve against a real chunk list.
  assert.ok(!/normative excerpt numbers carried by the checkpoint entry/.test(IPD_EPISODE_DIFF_SYSTEM),
    'the citation instruction went with the citations');
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /Leave citation_ids empty/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /WHAT WAS EXPECTED/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /Each expectation is stated once/,
    'the model is told the list is deduplicated, so recurrence is not read as emphasis');
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /checkpoint-id\/section\/number/, 'the ref format still stands');
});

test('round 13 item 3: both halves of the measurement are stored, and nothing renumbered', () => {
  const ddl = readFileSync('migrations/0052_ipd_episode_audits.sql', 'utf8');
  const store = readFileSync('lib/ipd-episode/store.ts', 'utf8');
  const route = readFileSync('app/api/admin/migrate-ipd-episode-audits/route.ts', 'utf8');
  for (const col of ['diff_prompt_chars', 'digest_entries']) {
    assert.match(ddl, new RegExp(`${col}\\s+INTEGER`), `${col} is in the DDL`);
    assert.match(store, new RegExp(col), `${col} is written`);
    assert.match(route, new RegExp(`ADD COLUMN IF NOT EXISTS ${col} INTEGER`), `${col} is backfilled`);
  }
  // APPENDED. Round 11 renumbered this statement and left two casts behind on their old
  // placeholders; the placeholder-position gate below catches that, and appending avoids it.
  assert.match(store, /\$54,\$55,\$56::jsonb,\n\s*\$57,\$58,\$59,\$60,\$61\)/,
    'the new parameters are at the end, so no existing $n moved');
});


test('ROUND 15: every column the worklist PAGE reads is named in the worklist QUERY', () => {
  // ⚠️ THE DEFECT THIS EXISTS FOR. `dbf07b9a` added divergence_band, band_uncertain and
  // scoring_status to the INSERT and to the page, and never to the SELECT. `r.divergence_band` was
  // therefore undefined on every row, DivergenceChip took its "no band was stored" branch, and the
  // worklist read "not scorable" for every episode — on a table full of scored ones. Nothing
  // failed, nothing threw, and no test looked at both halves at once.
  const store = read('lib/ipd-episode/store.ts');
  const page = read('app/admin/ipd-audit/episodes/page.tsx');
  const query = store.slice(store.indexOf('export async function episodeWorklist'));
  const select = query.slice(query.indexOf('SELECT'), query.indexOf('FROM ipd_episode_audits'));

  const readFields = new Set<string>();
  for (const m of page.matchAll(/\br\.([a-z_][a-z0-9_]*)/g)) readFields.add(m[1]);
  assert.ok(readFields.size > 5, 'the page really does read row fields');
  for (const field of readFields) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(select),
      `the page reads r.${field}, so the worklist SELECT must name it`);
  }
  // and the three that were missing are explicitly among them now
  for (const field of ['divergence_band', 'band_uncertain', 'scoring_status']) {
    assert.ok(readFields.has(field), `${field} is read by the page`);
    assert.ok(new RegExp(`\\b${field}\\b`).test(select), `${field} is selected`);
  }
});

test('ROUND 15 ITEM 1: the absolutes are stored, selected and rendered beside the band', () => {
  const ddl = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  const store = read('lib/ipd-episode/store.ts');
  const ui = code('app/admin/ipd-audit/episodes/ui.tsx');
  for (const col of ['penalty_total', 'expectations_evaluated']) {
    assert.match(ddl, new RegExp(`${col}\\s+INTEGER`), `${col} is declared`);
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${col} INTEGER`), `${col} is back-filled`);
    assert.ok(store.includes(col), `${col} is written and selected`);
  }
  assert.ok(ui.includes('export function DivergenceCounts('), 'and rendered by the same component tree as the band');
  for (const page of ['app/admin/ipd-audit/episodes/page.tsx', 'app/admin/ipd-audit/episodes/[id]/page.tsx']) {
    assert.ok(read(page).includes('<DivergenceCounts'), `${page} shows the counts`);
  }
});

test('ROUND 15 ITEM 1: the index is a rate, and the denominator excludes what could not be measured', () => {
  const core = code('lib/ipd-episode/judge-core.ts');
  assert.ok(core.includes('const maxPenalty = SEVERITY_PENALTY.major * evaluated;'),
    'the ceiling is 8 × the expectations evaluated');
  assert.ok(core.includes("findings.filter((f) => f.verdict !== 'unassessable').length"),
    'a question the pipeline could not answer is not in the denominator');
  assert.ok(core.includes('if (evaluated === 0) return null;'),
    'and nothing measured is null, never 0 and never 100');
});


test('ROUND 15: the response reports the SAME band values it stored, from the same variables', () => {
  // ⚠️ THE DEFECT. The returned result recomputed index/band/uncertainty instead of reusing the
  // ones written to the row. After round 15 gave `bandIsUncertain` a denominator, the row got it
  // and the response did not — so all five re-runs reported band_uncertain TRUE in the API while
  // the stored column said FALSE for four of them. A response that disagrees with the row it just
  // wrote is the one a person reads first.
  const run = code('lib/ipd-episode/run.ts');
  const returned = run.slice(run.lastIndexOf('return {\n      encounterId,'));
  assert.ok(returned.includes('divergenceIndex: storedIndex ?? undefined'), 'one index variable');
  assert.ok(returned.includes('divergenceBand: divergenceBandFor(storedIndex)'), 'banded from it');
  assert.ok(returned.includes('bandUncertain: bandIsUncertain(storedIndex, final.penalty_total, final.expectations_evaluated)'),
    'and the uncertainty gets the denominator, exactly as the row does');
  // the row and the response must not compute it two different ways
  const rowCall = 'bandUncertain: bandIsUncertain(storedIndex, final.penalty_total, final.expectations_evaluated)';
  assert.equal(run.split(rowCall).length - 1, 2, 'the row and the response use the identical call');
  // and the absolutes ride along in the response too
  for (const field of ['penaltyTotal: final.penalty_total', 'expectationsEvaluated: final.expectations_evaluated']) {
    assert.ok(returned.includes(field), `the response carries ${field}`);
  }
});


test('ROUND 15: the UI copy states no fixed index window, because there no longer is one', () => {
  const ui = read('app/admin/ipd-audit/episodes/ui.tsx');
  const page = read('app/admin/ipd-audit/episodes/page.tsx');
  // The ±5 was measured in PENALTY points on a 51-expectation episode — about 1.2 index points
  // there, less on a longer stay. Any single figure quoted against the rate is wrong for every
  // episode but one, and "±5" specifically overstates the noise about fourfold.
  const rendered = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  for (const [name, src] of [['ui.tsx', ui], ['page.tsx', page]] as const) {
    assert.ok(!/±\s*5|within 5 (points|of)/.test(rendered(src)),
      `${name} must not quote a fixed index window against a rate`);
  }
  // and it says what the flag now MEANS
  assert.match(ui, /would put it in a different band/, 'the tooltip states the actual test');
  assert.match(ui, /moved by the repeat-run spread measured on identical input/);
  assert.match(ui, /the same wobble matters less on an admission with more expectations/i,
    'and why it is computed per episode rather than from a window');
});


test('ROUND 17 ITEM 5: app_source is WRITTEN, and de_identified is GONE', () => {
  const store = read('lib/ipd-episode/store.ts');
  const ddl = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');

  // WRITTEN: preview and production share one DATABASE_URL (decision 31), so which deployment
  // produced a row is a real question. The idiom is the repo's own.
  assert.match(store, /const APP_SOURCE = process\.env\.APP_SOURCE \|\| 'standalone';/);
  assert.match(store, /expectations_evaluated, app_source\)/, 'named in the INSERT');
  assert.match(store, /^\s*APP_SOURCE,$/m, 'and passed as a parameter');

  // DROPPED: an assertion column that asserted nothing — DEFAULT TRUE, never written, therefore
  // TRUE on every row whatever ran, including throughout the period when real_course carried a
  // theatre assistant's name (round 14 item 9).
  const ddlBody = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS ipd_episode_audits'));
  assert.ok(!/^\s{2}de_identified\s+BOOLEAN/m.test(ddlBody), 'not declared any more');
  assert.match(route, /DROP COLUMN IF EXISTS de_identified/, 'and dropped idempotently');
  assert.ok(!/de_identified/.test(store), 'and nothing writes or reads it');
});

test('ROUND 17 ITEM 6: episodeAuditById names its columns, and names ALL of them', () => {
  const store = read('lib/ipd-episode/store.ts');
  const ddl = read(join('migrations', '0052_ipd_episode_audits.sql'));
  const fn = store.slice(store.indexOf('export async function episodeAuditById'));
  assert.ok(!/SELECT \* FROM ipd_episode_audits/.test(fn), 'no SELECT *');

  // and the named list is exactly the table — the check episodeWorklist did not have for six rounds
  const tbl = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS ipd_episode_audits'));
  // ⚠️ LOOSE ON PURPOSE (round 18 item 4). This was `/^ {2}([a-z_]+)\s+[A-Z]/`, coupled to exactly
  // two-space indentation and an UPPERCASE type token. A column indented differently, or declared
  // `jsonb` in lower case, would simply vanish from `declared` — and a bidirectional check that
  // silently forgets a column is worse than no check, because it still reports green. Any
  // indentation, any type case; comment lines and the constraint clauses at the end are excluded
  // by requiring an identifier followed by a type word on the same line.
  const body = tbl.slice(0, tbl.indexOf('\n);'));
  const declared = new Set(
    body.split('\n')
      .map((l) => l.replace(/--.*$/, '').trim())
      .filter((l) => l && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK)\b/i.test(l))
      .map((l) => /^([a-z][a-z0-9_]*)\s+[A-Za-z]/.exec(l)?.[1])
      .filter((c): c is string => !!c),
  );
  const sql = fn.slice(fn.indexOf('`SELECT id,'), fn.indexOf('FROM ipd_episode_audits'));
  const named = new Set([...sql.matchAll(/\b([a-z][a-z0-9_]*)\b/g)].map((m) => m[1]).filter((w) => w !== 'select'));
  // ⚠️ THE EXTRACTION ITSELF IS CHECKED FIRST. A bidirectional comparison between two sets is
  // vacuously green if one of them came back empty or short, which is precisely how a
  // presentation-coupled regex fails: silently, and in the reassuring direction.
  assert.ok(declared.size >= 60, `the DDL extraction found only ${declared.size} columns`);
  assert.ok(declared.has('id') && declared.has('real_course') && declared.has('penalty_total'),
    'and it finds columns of every declaration shape in the file');
  for (const c of declared) assert.ok(named.has(c), `column ${c} is declared but not selected`);
  for (const c of named) assert.ok(declared.has(c), `${c} is selected but not a column`);
});
