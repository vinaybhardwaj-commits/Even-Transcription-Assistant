// lib/__tests__/consensus-gold.test.ts — invariants for Consensus gold (#7), SL1+SL2.
//
// Four things must hold or the bench is unsafe or wrong, and none is visible in a passing render:
//   1. SEPARATION. Gold-building verdicts must live in ipd_gold_adjudication, NEVER
//      ipd_audit_feedback — those are surface-feedback rows on live audits; conflating them makes
//      the 2.0 gold un-separable from clinician feedback. The kickoff's central store rule.
//   2. VOCABULARY. V labels tp | valid_extra | false | nitpick | contested — exactly. A drift
//      here silently drops or mislabels adjudications.
//   3. DE-IDENTIFICATION. The 2.0 gold lands in a public repo; the harness must gate finding text
//      against URLs and PHI-shaped tokens, and the store must carry no name/UHID column.
//   4. ONE MATCHER. The union is deduped by the VERBATIM S4.1 matcher — the shipped rescore now
//      imports it from lib/ipd-audit/theme-match, so there is a single source, not a re-derivation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
// assertions are about CODE, not commentary (these files name ipd_audit_feedback in their headers
// precisely to say they must NOT write it) — strip comments first.
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('(1) SEPARATION: the consensus store is ipd_gold_adjudication, never ipd_audit_feedback', () => {
  const route = code('app/api/admin/ipd-gold-adjudication/route.ts');
  assert.ok(/INSERT INTO ipd_gold_adjudication/.test(route), 'the route writes the dedicated gold-adjudication store');
  assert.ok(!/ipd_audit_feedback/.test(route), 'the route must NEVER write ipd_audit_feedback');
  // the triage UI posts to the dedicated endpoint, not the surface-feedback one
  const triage = code('app/admin/ipd-gold-queue/consensus-triage.tsx');
  assert.ok(/\/api\/admin\/ipd-gold-adjudication/.test(triage), 'the triage posts to the dedicated endpoint');
  assert.ok(!/ipd-audit-feedback/.test(triage), 'the triage must not post to the surface-feedback endpoint');
});

test('(2) VOCABULARY: exactly tp | valid_extra | false | nitpick | contested', () => {
  const route = code('app/api/admin/ipd-gold-adjudication/route.ts');
  const m = route.match(/VERDICTS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'the verdict allow-list is a Set literal');
  const got = m![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  assert.deepEqual(got, ['contested', 'false', 'nitpick', 'tp', 'valid_extra'],
    'the five gold-building verdicts, and no surface verdicts (agree/disagree/needs_action)');
  // the surface's 4-verdict set must not leak in — valid_extra is what makes this a gold builder
  assert.ok(!got.includes('agree') && !got.includes('needs_action'), 'no surface-feedback verdicts');
});

test('(3a) DE-IDENTIFICATION: the harness gates finding text against URLs and PHI', () => {
  const h = read('scripts/ipd-consensus-gold-harness.mjs');
  assert.ok(/URL_RE\s*=\s*\/https\?/.test(h), 'a URL guard exists');
  assert.ok(/PHI_RE\s*=/.test(h) && /uhid/i.test(h), 'a PHI-shaped guard exists');
  assert.ok(/assertClean\(theme,/.test(h) && /assertClean\(e,/.test(h),
    'every gold theme AND every extra is passed through the de-identification gate');
  // the guard THROWS (a soft warning would let a URL slip into a public-repo artifact)
  assert.ok(/throw new Error\(`URL in/.test(h), 'a URL match aborts the build, not warns');
});

test('(3b) DE-IDENTIFICATION: the store schema carries no name/UHID column', () => {
  const mig = read('migrations/0015_ipd_gold_union.sql');
  for (const forbidden of [/\bpatient_name\b/i, /\buhid\b/i, /\bmrn\b/i, /\bsource_pdf_url\b/i, /\bpdf_url\b/i]) {
    assert.ok(!forbidden.test(mig.replace(/--.*$/gm, '')), `the candidates/adjudication tables must not have a ${forbidden} column`);
  }
  // case_id + ip_uid are the permitted link-back keys (the same posture 1.0/1.1 gold uses)
  assert.ok(/case_id\s+TEXT NOT NULL/.test(mig) && /ip_uid\s+TEXT/.test(mig), 'link-back keys only');
});

test('(4) ONE MATCHER: rescore + harness share the matcher, neither keeps a copy', () => {
  const script = read('scripts/ipd-s4-theme-rescore.mjs');
  const harness = read('scripts/ipd-consensus-gold-harness.mjs');
  assert.ok(/from '\.\/lib\/theme-match\.mjs'/.test(script), 'the rescore imports the shared matcher');
  assert.ok(/from '\.\/lib\/theme-match\.mjs'/.test(harness), 'the harness imports the SAME shared matcher');
  // neither re-declares its own JUDGE_SYSTEM / judgeCase body (that would be a second matcher)
  assert.ok(!/const JUDGE_SYSTEM =/.test(script), 'no inline JUDGE_SYSTEM copy remains in the rescore');
  assert.ok(!/async function judgeCase\(/.test(script), 'no inline judgeCase body remains in the rescore');
  // the shared prompt IS the verbatim S4.1 concept-equivalence judge
  const matcher = read('scripts/lib/theme-match.mjs');
  assert.ok(/SAME clinical concern/.test(matcher) && /Return ONLY JSON/.test(matcher),
    'the shared JUDGE_SYSTEM is the S4.1 concept-equivalence prompt');
  // and it stays OUT of the governed layer's scan — it is measurement tooling, not app code
  assert.ok(/chatWithFallback/.test(matcher), 'the matcher calls the model as the script always did');
});
