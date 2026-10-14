// scripts/metamorphic-llm-report.mjs — Part C: the LLM-leg metamorphic relations (PRD
// CDMSS-METAMORPHIC-AND-SYNTHETIC-CONTROLS v1.0 §5; decisions M1/M2). REPORT ONLY — this script
// gates nothing and deploys nothing. It is the weekly lab batch (M7) run by hand or on a schedule:
//
//   node --env-file=.env.local --import tsx scripts/metamorphic-llm-report.mjs
//
// Each relation (L-1 status qualifier · L-2 praise needs evidence · L-3 praise is not blind) runs
// BASE and TRANSFORMED arms 3× each through the real grounded audit (auditOpdNote, mini pipeline —
// the same engine path runMiniOpdToLab drives; the uid-fetch step is replaced because these
// fixtures are SYNTHETIC db13-shaped rows: no db13 uid, no PHI, §9.3). Every run persists to
// lab_analyses under the relation's experiment name (mm-llm-l1/l2/l3) so the engine-health panel
// reads the same rows this report prints. Majority decides; a 2–1 arm is recorded split: true —
// a finding about non-determinism, never a silent pass (M2).
//
// The relation FIXTURES + matchers live in lib/metamorphic-core.ts (single definition — the panel
// verdicts and this report can never drift).
import { PART_C_RELATIONS, majorityOf, partCVerdict } from '../lib/metamorphic-core.ts';
import { auditOpdNote } from '../lib/opd-note-audit.ts';
import { ensureLabTables, saveLabAnalysis } from '../lib/lab.ts';
import { MINI_MODEL } from '../lib/llm.ts';
import { telemetryContextFor } from '../lib/retrieval-telemetry-core.ts';
import { startInvocation } from '../lib/retrieval-invocation-store.ts';
import { settleOwned } from '../lib/retrieval-settlement.ts';

const RUNS_PER_ARM = 3;

// ⚠️ ONE INVOCATION PER PROCESS (D11), made once at module scope rather than per run: every audit
// this script performs belongs to the same execution, and minting a context per note would report
// one local script run as dozens of separate invocations.
const TELEMETRY_CTX = telemetryContextFor('script', null);
let telemetryOpened = false;
async function openTelemetryOnce() {
  if (telemetryOpened) return;
  telemetryOpened = true;
  await startInvocation(TELEMETRY_CTX);
}
const log = (...a) => console.error(...a);

await ensureLabTables();

// RETIRED relations are skipped, not deleted (V, 2 Aug 2026): L-2 and L-3 both rest on praise, and
// praise proved too rare to build a test on. Their objects stay in PART_C_RELATIONS as fixtures for
// the verdict-logic tests — L-3 is the subject of the 1 August regression guard — but they no longer
// consume runs. An empty active set is not an error: the loop simply produces no rows.
const ACTIVE = PART_C_RELATIONS.filter((r) => r.active);
log(`[part C] ${ACTIVE.length} active of ${PART_C_RELATIONS.length} relations`
  + (ACTIVE.length < PART_C_RELATIONS.length
    ? ` — retired: ${PART_C_RELATIONS.filter((r) => !r.active).map((r) => r.id).join(', ')}`
    : ''));

const report = [];
for (const rel of ACTIVE) {
  const arms = { base: rel.baseRow, transformed: rel.transform(structuredClone(rel.baseRow)) };
  const armFires = { base: [], transformed: [] };
  // L-3 needs BOTH matchers on the transformed arm: praise still present? safety fired?
  const praiseSeen = { base: [], transformed: [] };

  await openTelemetryOnce();
  for (const [arm, row] of Object.entries(arms)) {
    for (let run = 1; run <= RUNS_PER_ARM; run++) {
      const started = Date.now();
      let fired = false; let praise = false; let findings = [];
      let error = null;
      // ⚠️ THIS SCRIPT AUDITS AND SAVES NOTHING (D9), so every run settles `no_persistence_intended`
      // — and `trace: false` means `trace_id` is null from declaration through to the terminal write,
      // which is the second of the two callers D10 names for that.
      let handle = null;
      let published = false;
      try {
        const audit = await auditOpdNote(row, {
          pipeline: 'mini', engineTag: 'lab', trace: false,
          telemetry: { ctx: TELEMETRY_CTX, route: 'script', persistenceIntent: 'never_persists' },
          onLifecycleHandleUpdated: (h) => { handle = h; published = true; },
        });
        await settleOwned(handle, 'no_persistence_intended');
        findings = audit.findings;
        fired = rel.fires(findings);
        praise = findings.some((f) => f.signal_type === 'appropriateness_high_value'
          || (f.domain === 'appropriateness' && f.verdict === 'high-value'));
      } catch (e) {
        await settleOwned(handle, published ? 'audit_generation_failed' : 'retrieval_not_run');
        error = String(e?.message ?? e).slice(0, 300);
        log(`  ! ${rel.id} ${arm} run ${run} FAILED: ${error}`);
      }
      armFires[arm].push(fired);
      praiseSeen[arm].push(praise);
      try {
        await saveLabAnalysis({
          experiment: rel.experiment, kind: 'opd_note', engine: 'mm-llm-leg',
          inputRef: null, inputPreview: `${rel.id} ${arm} run ${run} (synthetic fixture — no db13 uid)`,
          output: { relation: rel.id, arm, run, fired, praise, error,
            matched: findings.filter((f) => rel.fires([f])).map((f) => f.subject).slice(0, 5) },
          model: MINI_MODEL, latencyMs: Date.now() - started,
        });
      } catch (e) { log(`  ! ${rel.id} ${arm} run ${run}: lab write failed (${e?.message}) — report continues`); }
      log(`  ${rel.id} ${arm} run ${run}: fired=${fired}${rel.id === 'L-3' ? ` praise=${praise}` : ''}`);
    }
  }

  const baseMaj = majorityOf(armFires.base);
  const transMaj = majorityOf(armFires.transformed);
  const basePraiseMaj = majorityOf(praiseSeen.base);
  const transPraiseMaj = majorityOf(praiseSeen.transformed);
  // ENGINE-HEALTH-HONESTY §2: precondition first (base must show the state the transformation
  // removes), then the relation's own verdict — one implementation, shared with the panel.
  const { verdict, reason } = partCVerdict(rel, {
    baseFired: baseMaj.fired, basePraise: basePraiseMaj.fired,
    transformedFired: transMaj.fired, transformedPraise: transPraiseMaj.fired,
  });
  const split = baseMaj.split || transMaj.split
    || (rel.precondition === 'praise' && basePraiseMaj.split)
    || (rel.id === 'L-3' && transPraiseMaj.split);
  report.push({
    relation: rel.id, title: rel.title, experiment: rel.experiment,
    base_fires: `${armFires.base.filter(Boolean).length}/${RUNS_PER_ARM}`,
    transformed_fires: `${armFires.transformed.filter(Boolean).length}/${RUNS_PER_ARM}`,
    verdict, reason: reason ?? null,
    split,
  });
}

if (!report.length) console.log('\nNo active Part C relations — nothing was run.');
console.log('\nrelation | base fires (n/3) | transformed fires (n/3) | verdict | split?');
for (const r of report) {
  console.log(`${r.relation} ${r.title} | ${r.base_fires} | ${r.transformed_fires} | ${r.verdict}${r.reason ? ` (${r.reason})` : ''} | ${r.split ? 'SPLIT (2-1) — a finding about non-determinism, not a pass' : 'no'}`);
}
console.log(`\nJSON: ${JSON.stringify(report)}`);
