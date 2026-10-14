/**
 *   node --test --import tsx lib/__tests__/opd-invalid-marking.test.ts
 *
 * S0 — production invalid-marking (PRD 28 Jul 2026). The first build in the stability programme
 * that touches a live clinical surface.
 *
 * THE DEFECT (MEASURED): when PDQI-9 is unassessed, note_quality drops out of the index with
 * weight 0 — and it is the lowest-scoring domain, so the index goes UP. 4 of 75 gemini audits in
 * 28h had no PDQI-9 and scored a mean 98.25 vs 81.10 assessed; corpus-wide 33 rows average 95.21
 * vs 78.36 with 52% exactly 100. A failure to measure scored as excellence, inside every
 * published aggregate.
 *
 * THE SHAPE: production keeps FAIL-SOFT (D1 — the audit still completes and persists). This is
 * INVALID-MARKING, not the lab's fail-loud: one bounded retry (D2), then mark
 * `excluded_reason = 'llm_leg_failed'` (D3, model-agnostic D4), suppress the score on display
 * (D5), exclude the NOTE from aggregates but NEVER from worker dedup (D6 — the trap).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { llmLegFailedAfterParse } from '../opd-note-audit.ts';

const SRC = readFileSync('lib/opd-note-audit.ts', 'utf8');
const STORE = readFileSync('lib/opd-audit-store.ts', 'utf8');
const BACKFILL = readFileSync('app/api/admin/opd-invalid-marking-backfill/route.ts', 'utf8');
const DETAIL = readFileSync('app/admin/opd-audit/[id]/page.tsx', 'utf8');
const SCORE_CORE = readFileSync('lib/opd-note-score-core.ts', 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The leg-failed predicate — pure, shared by the retry trigger and the final signal
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('llmLegFailedAfterParse: failed when the parse produced nothing PDQI-9-usable', () => {
  assert.equal(llmLegFailedAfterParse(null), true, 'parse returned null');
  assert.equal(llmLegFailedAfterParse({}), true, 'pdqi9 absent');
  assert.equal(llmLegFailedAfterParse({ pdqi9: null }), true, 'pdqi9 null');
  assert.equal(llmLegFailedAfterParse({ pdqi9: undefined }), true, 'pdqi9 undefined');
  // {} survives `== null` but scores as rows [] — the exact empty array the S0 gate counts.
  assert.equal(llmLegFailedAfterParse({ pdqi9: {} }), true, 'pdqi9 empty object');
});

test('the predicate is DELIBERATELY weaker than the lab guard — partial PDQI-9 passes in production', () => {
  // Production is fail-soft: a partial reading still carries signal for a clinician. The lab
  // requires 9/9 (schema compliance); production requires only "did the instrument read at all".
  assert.equal(llmLegFailedAfterParse({ pdqi9: { clear: 4 } }), false, '1/9 attributes is NOT marked');
  assert.equal(llmLegFailedAfterParse({
    pdqi9: { clear: 4, complete: 3, concise: 4, organized: 5, prioritized: 4, sufficient: 3, synthesized: 4, consistent: 5, current: 4 },
  }), false, '9/9 obviously passes');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The retry (D2) — ONE, production only, and the eval path is untouched
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('exactly ONE bounded retry, gated on !opts.evalModel, whether the leg THREW or parsed to nothing', () => {
  // The throw path: eval rethrows unchanged BEFORE any retry; production retries once.
  assert.ok(SRC.includes(`    } catch (e) {
      if (opts.evalModel) throw e;   // eval propagation unchanged — drainOne records, next tick retries
      legRetried = true;
      raw = await generateLeg();     // a second throw lands in the outer catch: det-only + marked, as today`));
  // The parse path: retry only if the throw path did not already consume the one retry.
  assert.ok(SRC.includes('if (!opts.evalModel && !legRetried && llmLegFailedAfterParse(parsed)) {'));
  // Bounded: the flag is set before the second attempt, and nothing resets it.
  const block = SRC.slice(SRC.indexOf('let legRetried = false;'), SRC.indexOf('const llmLegFailed ='));
  assert.equal((block.match(/legRetried = true;/g) || []).length, 2, 'both trigger sites consume the SAME single budget');
  assert.ok(!/legRetried = false/.test(block.slice(10)), 'nothing hands the budget back');
});

test('a worse retry never replaces a partial first attempt', () => {
  assert.ok(SRC.includes('if (!llmLegFailedAfterParse(parsed2)) { raw = raw2; parsed = parsed2; }'),
    'attempt 2 is kept only when it actually helped');
});

test('the signal can NEVER be set on the eval path — lab rows must not carry production marks', () => {
  assert.ok(SRC.includes('const llmLegFailed = !opts.evalModel && llmLegFailedAfterParse(parsed);'));
});

test('the det-only fallback is marked UNCONDITIONALLY — every fallback row is a failed measurement', () => {
  // Whatever threw (LLM leg, retrieval, anything in the try), pdqi9 was never assessed, and the S0
  // gate counts every unmarked empty-pdqi9 row. This is what makes the gate hold.
  assert.ok(SRC.includes('quietingGen: quietCfg.gen, llmLegFailed: true };'));
  // …and the eval rethrow still comes first, so no lab path reaches that return.
  const catchBlock = SRC.slice(SRC.indexOf("if (traceId) await finishTrace(traceId, 'error'"));
  assert.ok(catchBlock.indexOf('if (opts.evalModel) throw e;') < catchBlock.indexOf('llmLegFailed: true'));
});

test('the eval-path parse guards are UNCHANGED — d08bba7 is not the pattern here, but it still stands', () => {
  assert.ok(SRC.includes('if (parsed === null) throw withEnvelope(new Error(evalGuardMessage.parseNull(raw.length)), evalEnv);'));
  assert.ok(SRC.includes('if (rated !== 9) throw withEnvelope(new Error(evalGuardMessage.pdqi9Partial(rated)), evalEnv);'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The store (D3/D4) — mark, clear on success, never clobber house_account
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('saveOpdAudit writes the mark only when signal AND stored pdqi9 are both empty', () => {
  assert.ok(STORE.includes("const excludedReason = audit.llmLegFailed === true && emptyPdqi9 ? 'llm_leg_failed' : null;"));
  assert.ok(STORE.includes('const emptyPdqi9 = scPdqi9 == null || (Array.isArray(scPdqi9) && scPdqi9.length === 0);'));
});

test('a successful re-audit CLEARS a stale mark; house_account is preserved verbatim — both paths', () => {
  // force-insert conflict clause
  assert.ok(STORE.includes(`excluded_reason = COALESCE(EXCLUDED.excluded_reason,
           CASE WHEN opd_note_audits.excluded_reason = 'llm_leg_failed' THEN NULL ELSE opd_note_audits.excluded_reason END)`));
  // updateOpdAudit
  assert.ok(STORE.includes(`excluded_reason = COALESCE($21,
         CASE WHEN excluded_reason = 'llm_leg_failed' THEN NULL ELSE excluded_reason END)`));
});

test('D6 — the trap survives in its NARROWED form: only an incident makes a note re-auditable', () => {
  // 31 Jul 2026 (addendum B / T-9). D6's original rule was "never filter excluded_reason here",
  // because a blanket filter makes every marked note look un-audited and the worker re-admits it
  // nightly — the house-account fault. That rule is now expressed as an ALLOWLIST rather than an
  // absence: a note recovers only from an INCIDENT that marked the row, never from a verdict about
  // the note. Everything not listed stays permanent, so the original fault cannot recur by default.
  assert.ok(STORE.includes(`const RE_AUDITABLE_EXCLUSIONS = [
  'vertex_outage_mislabel_2026_07',
  'llm_leg_failed',
] as const;`), 'the allowlist is exactly the two incident reasons, verbatim');
  assert.ok(!/RE_AUDITABLE_EXCLUSIONS = \[[^\]]*house_account/s.test(STORE),
    'house_account must NEVER be re-auditable — it is the reason the trap exists');

  // auditedUidsForDay (single-version) is untouched — it was never part of the fault.
  assert.ok(STORE.includes(`    \`SELECT uid FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date\``),
    'auditedUidsForDay must stay unfiltered');

  // THE SPEND GUARD, and it must key on the WRITE TARGET, not the read family: a note holding a
  // row at the version the worker writes would otherwise be re-audited nightly on the paid model
  // for a result the save discards. Keyed on the family instead, EVERY stranded note is held and
  // the change frees nothing. NARROWED by addendum F v2 task 2: a write-target row marked
  // 'llm_leg_failed' no longer holds the note, because the default conflict clause now LANDS on
  // exactly that row (DO UPDATE ... WHERE) — the discard the guard protected against is gone for
  // that one class, and only that class.
  assert.ok(STORE.includes(`OR bool_or(engine_version = $3 AND excluded_reason IS DISTINCT FROM 'llm_leg_failed')`),
    'the guard is a single write-target version, and a failed row at that version does not hold the note');
  assert.ok(STORE.includes('day, RE_AUDITABLE_EXCLUSIONS as unknown as string[], OPD_ENGINE_VERSION,'),
    '$3 is OPD_ENGINE_VERSION — never OPD_ENGINE_VERSIONS_CURRENT');
  assert.ok(!/AUDITED_PARAMS[\s\S]{0,200}OPD_ENGINE_VERSIONS_CURRENT/.test(STORE),
    'the read family must not become the guard key');

  // Both day readers share ONE predicate: the worker gates on the count and fetches on the uid
  // list, so a divergence would loop a day forever.
  assert.equal((STORE.match(/\$\{AUDITED_HAVING\}/g) || []).length, 2, 'both readers use the shared HAVING');
});

test('addendum F v2 task 2 — a failed row never blocks a retry, a successful row is never overwritten', () => {
  // The DEFAULT conflict clause is force's DO UPDATE narrowed by a WHERE that admits ONLY
  // 'llm_leg_failed' rows. DO NOTHING is gone: it is what made every retry round mint a new
  // carrier version (0.81.18). The WHERE is the entire safety argument —
  //   · a successful row is excluded, so a plain save still returns 'exists' for it;
  //   · no 'llm_leg_failed' row is ever in the experiment cohort (its filter admits only
  //     excluded_reason IS NULL or 'vertex_outage_mislabel_2026_07'), so the cohort is untouchable;
  //   · audited_at moves only on rows no read surface counts.
  assert.ok(!STORE.includes(`'DO NOTHING'`), 'the DO NOTHING clause is gone');
  assert.ok(STORE.includes(`WHERE opd_note_audits.excluded_reason = 'llm_leg_failed'`),
    'the default upsert lands ONLY on a failed row');
  // Force mode keeps the FULL overwrite (no WHERE): the force branch applies overwriteSet with the
  // hysteresis CASE, the default branch applies it with the fresh band and the WHERE.
  assert.ok(/\?\s*`DO UPDATE SET \$\{overwriteSet\(hysteresisCaseSql\(/.test(STORE),
    'force = full overwrite with hysteresis, unnarrowed');
  // The retry path takes the fresh band UNCONDITIONALLY — the prior displayed_band belongs to a
  // det-only failed row (~95/A, "failure scored as excellence") that no surface displayed; holding
  // it would anchor the first real audit to an artifact.
  assert.ok(/:\s*`DO UPDATE SET \$\{overwriteSet\('EXCLUDED\.displayed_band'\)\}/.test(STORE),
    'the retry path bands fresh, not against the failed row\'s anchor');
  // Both modes report what happened: (xmax = 0) distinguishes a fresh insert from a landed retry.
  assert.ok(STORE.includes('RETURNING id, (xmax = 0) AS inserted'), 'every save can report insert-vs-update');
});

test('the canonical id set still excludes marked rows — the mark IS the aggregate exclusion', () => {
  assert.ok(STORE.includes('WHERE app_source = $1 AND excluded_reason IS NULL'),
    'canonicalOpdAuditIds filters excluded_reason IS NULL, so llm_leg_failed rows leave every canonical surface');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The reader split (D6) — every aggregate reader carries its exclusion
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('EVERY enumerated aggregate/display reader excludes marked rows', () => {
  // Class A — already filtered excluded_reason IS NULL (house-account precedent); the mark rides it.
  for (const f of [
    'app/admin/opd-audit/page.tsx',            // main OPD aggregates + list + trend + by-doctor
    'lib/opd-audit-doctor.ts',                 // doctor metrics + O/E funnel + stewardship reads
    'app/api/governance/opd-signals/route.ts', // governance signals
    'lib/opd-gov-read.ts',                     // per-doctor governance read
    'app/care/page.tsx',                       // care landing counts
    'app/api/care/review-queue/route.ts',      // review queue
    'app/api/opd-triage/queue/route.ts',       // triage queue
    'app/admin/stewardship/page.tsx',          // stewardship rollup
    'lib/even-concept.ts', 'lib/even-ground.ts', 'lib/even-lvc.ts',  // Even app surfaces
    'lib/learning.ts',                         // learning digests
  ]) {
    assert.ok(/excluded_reason IS NULL/.test(readFileSync(f, 'utf8')), `${f} must filter excluded_reason IS NULL`);
  }
  // Class B — surgical: quieting-stats queries exclude ONLY llm_leg_failed, so their existing
  // house_account behaviour (unfiltered, a pre-existing decision) is untouched.
  const supp = readFileSync('lib/audit-suppression-store.ts', 'utf8');
  assert.equal((supp.match(/excluded_reason IS DISTINCT FROM 'llm_leg_failed'/g) || []).length, 3,
    'all three suppression-stats windows exclude marked notes');
  assert.ok(!/excluded_reason IS NULL/.test(supp), 'and none of them grew the broader filter');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Display suppression (D5)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the detail page suppresses the score and says exactly "Not assessed at this engine version"', () => {
  assert.ok(DETAIL.includes("const notAssessed = String(r.excluded_reason || '') === 'llm_leg_failed';"));
  // V ruling on F-2: the earlier text asserted a queue that does not exist — the exact defect
  // class this programme eliminates. The truthful text names the two REAL clearing mechanisms'
  // shared property: the mark is scoped to this engine version.
  assert.ok(DETAIL.includes('Not assessed at this engine version'));
  assert.ok(!DETAIL.includes('re-audit queued') && !DETAIL.includes('re-audit is queued'),
    'no surface may promise a queue nothing implements');
  assert.ok(DETAIL.includes(', excluded_reason'), 'the SELECT must actually fetch the mark');
  // The stored values stay; they are never presented as a score (D5) — the circle branch flips.
  assert.ok(DETAIL.includes('{notAssessed ? ('));
});

test('the escalation package never hands a failed measurement to an external reviewer', () => {
  assert.ok(DETAIL.includes('- CDMSS grade: not assessed at this engine version (grading model could not assess this note)'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · The backfill (D7) — dry-run by default, §5 predicate verbatim, reversible
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the backfill predicate is the §5 / S0-gate predicate VERBATIM', () => {
  assert.ok(BACKFILL.includes(
    "const PREDICATE = `excluded_reason IS NULL AND (pdqi9 IS NULL OR jsonb_typeof(pdqi9) <> 'array' OR jsonb_array_length(pdqi9) = 0)`;"));
});

test('DRY-RUN BY DEFAULT: the write happens only under ?apply=1, and the delta is always reported', () => {
  assert.ok(BACKFILL.includes("const apply = req.nextUrl.searchParams.get('apply') === '1';"));
  const updIdx = BACKFILL.indexOf("SET excluded_reason = 'llm_leg_failed'");
  const gateIdx = BACKFILL.indexOf('if (apply) {');
  assert.ok(gateIdx > 0 && updIdx > gateIdx, 'the UPDATE must sit inside the apply gate');
  const code = BACKFILL.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  assert.equal((code.match(/UPDATE opd_note_audits/g) || []).length, 2,
    'exactly the apply UPDATE and the reversal string — nothing else writes');
  for (const field of ['before_mean', 'after_mean', 'byEngineVersion', 'byAffectedDoctor', 'reversal']) {
    assert.ok(BACKFILL.includes(field), `dry-run must report ${field}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · UNTOUCHED — no scoring change, no engine bump, no eval-path change
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('opd-note-score-core.ts knows nothing of any of this — no scoring change, no engine bump', () => {
  assert.ok(!/llm_leg_failed|llmLegFailed|excluded_reason|invalid/i.test(SCORE_CORE),
    'the scoring core must be untouched by S0');
});

test('parseOpdAnalysis is untouched — the guard sits at the call site, production keeps the leniency', () => {
  assert.ok(!/function parseOpdAnalysis/.test(SRC), 'no local override');
  assert.ok(/parseOpdAnalysis,/.test(SRC.slice(0, SRC.indexOf("} from './opd-note-audit-core'"))),
    'still imported from the core');
});

test('the lab batch path knows nothing of llmLegFailed', () => {
  for (const f of ['lib/lab-batch.ts', 'lib/lab-batch-core.ts', 'lib/mini-backfill.ts']) {
    assert.ok(!/llmLegFailed|llm_leg_failed/.test(readFileSync(f, 'utf8')), `${f} must be untouched by S0`);
  }
});
