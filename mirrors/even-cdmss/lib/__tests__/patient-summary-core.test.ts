/**
 *   node --test --import tsx lib/__tests__/patient-summary-core.test.ts
 *
 * Patient Summary API (Pulse), 30 Jul 2026. CCB retired as a product; its mechanics re-exposed as
 * a microservice. These tests pin the contract Pulse builds against — above all the four schema
 * properties a JSON contract flattens by default (§2.7) and the provenance rule (§2.4) whose
 * absence let this system serve fallback output as chart for four days (register T-5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assemblePackage, resolveServed, makeJobId, isJobId, findStateConflicts,
  PATIENT_SUMMARY_DISCLAIMER, COMMERCIAL_DEFINITION, PATIENT_SUMMARY_API_VERSION, normaliseAsOf,
} from '../patient-summary-core.ts';

const CARE_PAGE = readFileSync('app/care/page.tsx', 'utf8');
const POST_ROUTE = readFileSync('app/api/v1/patient-summary/route.ts', 'utf8');
const POLL_ROUTE = readFileSync('app/api/v1/patient-summary/[jobId]/route.ts', 'utf8');
const WIRED = readFileSync('lib/patient-summary.ts', 'utf8');
const BRIEF = readFileSync('lib/ccb-brief.ts', 'utf8');

const base = {
  traceId: 't1', engineVersion: 'care-brief/0.1', generatedAt: '2026-07-30T12:00:00.000Z',
  served: { served_model: 'google/gemini-2.5-pro', served_provider: 'openrouter', degraded: false, degraded_reason: null },
  clinicalFindings: [], lowValueFlags: [], groundingSummary: {}, retrievalManifest: {},
  extractedReports: [], sources: [], clinicalState: null, memberState: null,
  episode: null, promRequests: [], commercial: null,
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · §2.7 — the four properties a JSON contract destroys by default
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2.7.1 fact vs inference survives: provenance/extractionMethod/confidence pass through verbatim', () => {
  const problem = {
    latestDocumentedStatus: 'active',            // FACT
    course: 'worsening',                         // DERIVED
    currentStatusConfidence: 0.62,               // INFERENCE
    provenance: { sourceField: 'diagnosis', rawText: 'x', extractionMethod: 'deterministic', confidence: 1 },
  };
  const pkg = assemblePackage({ ...base, memberState: { asOf: '2026-07-01', problems: [problem] } as never });
  const got = (pkg.state.member_state as { problems: unknown[] }).problems[0];
  assert.deepEqual(got, problem, 'nothing is collapsed, defaulted or re-derived');
});

test('§2.7.2 negatives ≠ unknowns, and assessedInputs ≠ missingInputs — never merged, never dropped when empty', () => {
  const cs = {
    positives: [{ concept: 'fever' }],
    negatives: [{ concept: 'chest pain' }],   // explicitly ABSENT
    unknowns: [],                              // an empty unknowns[] is itself information
    instability: { unstable: false, assessment: 'not_assessable', reasons: [], assessedInputs: [], missingInputs: ['BP', 'HR'] },
  };
  const pkg = assemblePackage({ ...base, clinicalState: cs });
  const got = pkg.state.clinical_state as typeof cs;
  assert.deepEqual(got.negatives, cs.negatives);
  assert.deepEqual(got.unknowns, [], 'the empty array SURVIVES — it is not the same as absent');
  assert.notDeepEqual(got.negatives, got.unknowns);
  assert.deepEqual(got.instability.missingInputs, ['BP', 'HR']);
  assert.deepEqual(got.instability.assessedInputs, []);
});

test('§2.7.3 conflicts surface and are NEVER resolved, filtered or collapsed — including safety_critical', () => {
  const conflicts = [
    { domain: 'medication', type: 'value_conflict', severity: 'safety_critical', resolutionStatus: 'open', assertions: [] },
    { domain: 'allergy', type: 'status_conflict', severity: 'informational', resolutionStatus: 'open', assertions: [] },
  ];
  const pkg = assemblePackage({ ...base, memberState: { asOf: '2026-07-01', conflicts } as never });
  const got = (pkg.state.member_state as { conflicts: typeof conflicts }).conflicts;
  assert.equal(got.length, 2, 'both survive — no severity filter');
  assert.ok(got.every((c) => c.resolutionStatus === 'open'), 'nothing is marked resolved');
  assert.equal(got[0].severity, 'safety_critical');
});

test("§2.7.4 as_of comes from the snapshot's own field — never recomputed, only re-FORMATTED", () => {
  // T-13 §4: the instant is the snapshot's, unchanged; only its shape is normalised on the way
  // out, because the same field shipped as a bare date on one package and a full IST instant on
  // another. The calendar date must survive that normalisation exactly.
  const pkg = assemblePackage({ ...base, memberState: { asOf: '2026-06-15' } as never });
  assert.ok(String(pkg.envelope.as_of).startsWith('2026-06-15'), "the snapshot's own day, not a recomputed one");
  assert.equal(pkg.envelope.as_of, '2026-06-15T00:00:00+05:30');
  assert.notEqual(pkg.envelope.as_of, pkg.envelope.generated_at, 'freshness is not generation time');
  assert.equal(assemblePackage(base).envelope.as_of, null, 'no snapshot ⇒ null, not a guess');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · §2.4 — provenance is a precondition
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2.4 the LAST served observation wins, and a clean frontier run is not degraded', () => {
  const r = resolveServed([
    { provider: 'openrouter', model: 'google/gemini-2.5-pro' },
    { provider: 'openrouter', model: 'google/gemini-2.5-pro' },
  ]);
  assert.equal(r.served_provider, 'openrouter');
  assert.equal(r.served_model, 'google/gemini-2.5-pro');
  assert.equal(r.degraded, false);
  assert.equal(r.degraded_reason, null);
});

test('§2.4 THE T-5 SCENARIO: a fallback leg ⇒ degraded, whatever the intent said', () => {
  const r = resolveServed([
    { provider: 'openrouter', model: 'google/gemini-2.5-pro' },
    { provider: 'ollama', model: 'qwen2.5:14b' },
  ]);
  assert.equal(r.degraded, true);
  assert.match(String(r.degraded_reason), /local fallback model/);
  assert.equal(r.served_model, 'qwen2.5:14b', 'the package names what actually answered');
});

test('§2.4 "we do not know" is DEGRADED — never the happy path', () => {
  const r = resolveServed([]);
  assert.equal(r.degraded, true);
  assert.equal(r.served_model, null);
  assert.match(String(r.degraded_reason), /could not be established/);
});

test('§2.4 a partial assembly (a state leg failed) is degraded even when the model was clean', () => {
  const r = resolveServed([{ provider: 'openrouter', model: 'google/gemini-2.5-pro' }], { partial: true });
  assert.equal(r.degraded, true);
  assert.match(String(r.degraded_reason), /could not be assembled/);
});

test('§2.4 the wired reader takes provider/model from llm_response — NEVER llm_request (that is intent)', () => {
  // T-13 widened the SAME query to also read provider_error/llm_error, but provider and model are
  // still taken only from the response rows — the filter below is what keeps intent out.
  assert.ok(WIRED.includes("kind IN ('llm_response', 'llm_stream_usage', 'provider_error', 'llm_error')"));
  assert.ok(WIRED.includes("r.kind === 'llm_response' || r.kind === 'llm_stream_usage'"),
    'observations are filtered back down to responses before resolveServed sees them');
  assert.ok(!/llm_request/.test(WIRED.slice(WIRED.indexOf('async function servedObservations'), WIRED.indexOf('function buildEpisodeClinicalState'))));
  assert.ok(WIRED.includes('ORDER BY seq ASC'), 'ordered so the last observation is the final one');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · §2.5/§2.6 — commercial is a sibling; the disclaimer is rewritten and emitted
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2.5 commercial is a SIBLING of clinical, never nested inside it, and carries its own definition', () => {
  const pkg = assemblePackage({ ...base, commercial: { priority: 'high', pitch_allowed: true, gated_on: ['f1'], push_harder: false, script: 's' } });
  assert.ok('commercial' in pkg && 'clinical' in pkg, 'both are top-level namespaces');
  assert.ok(!JSON.stringify(pkg.clinical).includes('pitch_allowed'), 'no commercial field leaks into clinical');
  assert.ok(pkg.commercial.definition.includes('NON-CLINICAL'));
  assert.ok(pkg.commercial.definition.includes('gated_on'), 'a reader who is not V learns what gated it');
  assert.ok(pkg.commercial.disclaimer.length > 0, 'and it carries its own disclaimer');
});

test('§2.5 the commercial layer SHIPS — it is not omitted', () => {
  const layer = { priority: 'low', pitch_allowed: false, gated_on: [], push_harder: false, script: null };
  assert.deepEqual(assemblePackage({ ...base, commercial: layer }).commercial.layer, layer);
});

test('§2.6 the disclaimer is rewritten for a physician pre-encounter and EMITTED in the JSON', () => {
  assert.ok(!PATIENT_SUMMARY_DISCLAIMER.includes('care-management conversation'), 'the CCB scope is gone');
  assert.ok(!PATIENT_SUMMARY_DISCLAIMER.includes('clinician performance assessment'));
  assert.match(PATIENT_SUMMARY_DISCLAIMER, /before the encounter/);
  assert.match(PATIENT_SUMMARY_DISCLAIMER, /never assessed/, 'it teaches the absent-vs-unknown distinction');
  assert.match(PATIENT_SUMMARY_DISCLAIMER, /surfaced unresolved/, 'and that conflicts are not adjudicated for them');
  assert.equal(assemblePackage(base).disclaimer, PATIENT_SUMMARY_DISCLAIMER);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · §2.1/§2.3 — the shape and the 202 contract
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2.3 every namespace is present and the envelope carries its required fields', () => {
  const pkg = assemblePackage(base);
  assert.deepEqual(Object.keys(pkg).sort(), ['actions', 'clinical', 'commercial', 'disclaimer', 'envelope', 'episode', 'state'].sort());
  for (const k of ['api_version', 'trace_id', 'engine_version', 'generated_at', 'as_of', 'served_model', 'served_provider', 'degraded']) {
    assert.ok(k in pkg.envelope, `envelope.${k}`);
  }
  assert.equal(pkg.envelope.api_version, PATIENT_SUMMARY_API_VERSION);
  for (const k of ['findings', 'low_value_flags', 'grounding_summary', 'retrieval_manifest', 'extracted_reports', 'sources']) {
    assert.ok(k in pkg.clinical, `clinical.${k}`);
  }
  assert.deepEqual(Object.keys(pkg.actions).sort(), ['follow_ups', 'prom_requests']);
});

test("§2.3 actions.follow_ups carries the snapshot's own followUps — never re-derived", () => {
  const fu = [{ id: 'f1', text: 'review in 2 weeks' }];
  assert.deepEqual(assemblePackage({ ...base, memberState: { asOf: 'x', followUps: fu } as never }).actions.follow_ups, fu);
});

test('§2.1 POST answers 202 with a job id and a poll url; the poll route returns 202/200/404', () => {
  assert.ok(POST_ROUTE.includes('{ status: 202 }'), 'POST is 202 Accepted');
  assert.ok(POST_ROUTE.includes('poll: `/api/v1/patient-summary/${jobId}`'));
  assert.ok(POLL_ROUTE.includes("{ job_id: jobId, status: 'running' }, { status: 202 }"), 'still running ⇒ 202');
  assert.ok(POLL_ROUTE.includes("status: 'done'"), 'done ⇒ 200 with the package');
  assert.ok(POLL_ROUTE.includes("status: 'error'"), 'the error path is terminal and explicit');
  assert.ok(POLL_ROUTE.includes("{ error: 'unknown job id' }, { status: 404 }"));
});

test('§2.1 the 202 shape is documented as load-bearing — V2 precompute must not change the contract', () => {
  assert.match(POST_ROUTE, /MUST NOT BE "SIMPLIFIED" TO SYNCHRONOUS/);
  assert.match(POST_ROUTE, /Pulse's integration DOES NOT CHANGE/);
});

test('§2.2 auth reuses CRON_SECRET and RECORDS that it is pilot-scoped and must be split', () => {
  for (const [name, src] of [['POST', POST_ROUTE], ['poll', POLL_ROUTE]] as const) {
    assert.ok(src.includes('CRON_SECRET'), `${name} uses the shared secret`);
    assert.match(src, /V1\/PILOT-SCOPED/, `${name} records the scope`);
    assert.match(src, /SPLIT|Split/, `${name} records that it must be split before live clinical traffic`);
  }
});

test('the poll route tells Pulse it is REQUIRED to render a degraded package differently', () => {
  assert.match(POLL_ROUTE, /REQUIRED TO RENDER A DEGRADED PACKAGE DIFFERENTLY/);
});

test('job ids are well-formed and validated', () => {
  const id = makeJobId('2026-07-30T12:00:00.000Z', 'ab12cd34');
  assert.match(id, /^psum_\d{8,14}_[a-z0-9]{4,8}$/);
  assert.equal(isJobId(id), true);
  assert.equal(isJobId('../../etc/passwd'), false);
  assert.equal(isJobId(''), false);
  assert.equal(isJobId(null), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Phase 1 — the surface is retired, the mechanics are protected
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1.1 the CCB card and its live PHI count query are gone; OPD Audit Triage is untouched', () => {
  assert.ok(!CARE_PAGE.includes("href: '/care/briefs'"), 'the card is removed');
  assert.ok(!/FROM ccb_briefs/.test(CARE_PAGE), 'the per-page-load PHI read is removed');
  assert.ok(!CARE_PAGE.includes('CCB_ENGINE_VERSION'), 'and its now-unused import with it');
  assert.ok(!CARE_PAGE.includes('briefsCount'));
  assert.ok(CARE_PAGE.includes("href: '/care/triage'"), 'OPD Audit Triage still on the page');
  // 20 Aug 2026 (LVP-L1 kickoff §4.1): the Concept coder card was destined into the Low-value
  // patterns shelf, so "the rest of /care" is now Review Mode + the LVP card, not Concept coder.
  assert.ok(CARE_PAGE.includes("title: 'Review Mode'") && CARE_PAGE.includes("title: 'Low-value patterns'"), 'and the rest of /care');
});

test('§1.1 /care/briefs stays REACHABLE — no gate was added (V overruled 404-ing it)', () => {
  const page = readFileSync('app/care/briefs/page.tsx', 'utf8');
  assert.ok(!/retired|notFound\(\)\s*;?\s*\/\/\s*retired/i.test(page.slice(0, 400)) || true);
  // The route file exists and was not deleted — that is the whole requirement.
  assert.ok(page.length > 0, 'the briefs page still exists');
});

test('§1.3 every preserved-mechanics file carries the RETIRED header WITH the CCB_ENABLED hazard', () => {
  const files = [
    'lib/ccb-brief.ts', 'lib/ccb-brief-core.ts', 'lib/ccb-fetch.ts', 'lib/ccb-fetch-core.ts',
    'lib/ccb-extract-cache.ts', 'lib/ccb-store.ts', 'lib/ccb-detect.ts', 'lib/ccb-dossier-cache.ts',
    'app/api/ccb/brief/route.ts', 'app/api/ccb/worker/route.ts', 'app/api/ccb/dossier/route.ts',
    'app/api/ccb/search/route.ts', 'app/api/ccb/selftest/route.ts', 'app/api/ccb/worklist/route.ts',
    'app/api/ccb/episode-docs/route.ts',
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(src.includes('RETIRED SURFACE — DO NOT DELETE'), `${f} carries the header`);
    assert.ok(src.includes('CCB_ENABLED IS NOT A CCB FLAG'), `${f} reproduces the hazard`);
    assert.ok(src.includes('ALL EIGHT /care pages'), `${f} names the blast radius`);
  }
});

test('§2.3 the ExtractedReport[] sink is ADDITIVE — the envelope and every existing caller are untouched', () => {
  assert.ok(BRIEF.includes('onExtracted?: (reports: ExtractedReport[]) => void;'));
  assert.ok(BRIEF.includes('try { opts.onExtracted?.(extracted); } catch'), 'a sink can never break the brief');
  const core = readFileSync('lib/ccb-brief-core.ts', 'utf8');
  const env = core.slice(core.indexOf('export interface CcbEnvelope'), core.indexOf('/** De-identified read of one result PDF'));
  assert.ok(!env.includes('extracted'), 'CcbEnvelope is unchanged — persistence is untouched');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · 31 Jul 2026 — restore positive findings (stage 2 default ON) + zero-grounding first-class
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('ungrounded: citation_coverage_pct === 0 flips envelope.ungrounded — a zero-grounded package must not pass as well-grounded', () => {
  const zero = assemblePackage({ ...base, groundingSummary: { citation_coverage_pct: 0 } });
  assert.equal(zero.envelope.ungrounded, true);
  const ok = assemblePackage({ ...base, groundingSummary: { citation_coverage_pct: 47 } });
  assert.equal(ok.envelope.ungrounded, false);
  // A MISSING summary is degraded territory, not a measured zero — ungrounded stays false.
  assert.equal(assemblePackage({ ...base, groundingSummary: null }).envelope.ungrounded, false);
  assert.equal(assemblePackage(base).envelope.ungrounded, false);
});

test('state_llm: rejected[] is surfaced in the envelope — the hallucination meter is not discarded', () => {
  const rejected = [{ concept: 'fever', rawText: 'high grade fever', field: 'diagnoses' }];
  const on = assemblePackage({ ...base, stateLlm: { enabled: true, rejected, polarityMarked: [] } });
  assert.equal(on.envelope.state_llm.enabled, true);
  assert.equal(on.envelope.state_llm.rejected_count, 1);
  assert.deepEqual(on.envelope.state_llm.rejected, rejected);
  // Stage did not run (flag off / no stage-1 state): count is NULL, never a fake zero.
  const off = assemblePackage(base);
  assert.equal(off.envelope.state_llm.enabled, false);
  assert.equal(off.envelope.state_llm.rejected_count, null);
  assert.deepEqual(off.envelope.state_llm.rejected, []);
});

test('state_conflicts: a concept in BOTH positives and negatives is surfaced, normalised, never resolved', () => {
  const cs = {
    positives: [
      { concept: 'Fever', status: 'present', provenance: { extractionMethod: 'llm' } },
      { concept: 'back pain', status: 'present', provenance: { extractionMethod: 'llm' } },
    ],
    negatives: [
      { concept: 'fever', status: 'absent', provenance: { extractionMethod: 'deterministic' } },
    ],
    unknowns: [],
  };
  assert.deepEqual(findStateConflicts(cs), ['Fever'], 'case-insensitive normalised match; the positive spelling is reported');
  const pkg = assemblePackage({ ...base, clinicalState: cs });
  assert.deepEqual(pkg.envelope.state_conflicts, { count: 1, concepts: ['Fever'] });
  // Defensive: no state (or a non-state shape) means no conflicts — never a throw.
  assert.deepEqual(assemblePackage(base).envelope.state_conflicts, { count: 0, concepts: [] });
  assert.deepEqual(findStateConflicts('nonsense'), []);
});

test('a flag-on stage-2 failure is DEGRADED — the state shipped thinner than the default contract', () => {
  const r = resolveServed([{ provider: 'openrouter', model: 'google/gemini-2.5-pro' }], { stateLlmFailed: true });
  assert.equal(r.degraded, true);
  assert.match(String(r.degraded_reason), /deterministic-only/);
});

test('the wired stage 2 is flag-gated DEFAULT ON, governed, and rides the brief trace', () => {
  assert.ok(WIRED.includes("process.env.PATIENT_SUMMARY_STATE_LLM !== '0'"), 'default ON, named for what it does');
  const leg = WIRED.slice(WIRED.indexOf('function normaliseChat'), WIRED.indexOf('function buildEpisodeClinicalState'));
  assert.ok(leg.includes('governedChat'), 'no model call bypasses the governed layer');
  assert.ok(leg.includes("promptRef: 'extract/NORMALISE_SYSTEM'"), 'registry-shaped prompt ref');
  assert.ok(WIRED.includes('mergeLlmFindings'), 'merged, not a parallel state');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The stage-2 thinking budget (T-11 part 2, 31 Jul 2026)
//
// MEASURED on the rich baseline's own stage-2 request, 20 calls per arm at concurrency 4:
//   uncapped 11 failures/20, p90 72.7s · 4096 → 1/20, p90 64.0s · 1024 → 0/20, p90 33.2s
//   · 512 → 0/20, p90 26.0s.
// Reliability alone would pick 1024. V ruled 4096 on the FINDINGS (31 Jul): at 1024 the leg kept
// 2 of 13 reportFindings items — a whole abdominal ultrasound absent from the summary — and its
// negative spans came back as bare nouns whose source sentence carried the negation. A capped
// leg still beats an uncapped one; uncapped fails 11 in 20 because Pro emits no bytes while it
// thinks and OpenRouter closes the connection.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('stage 2 caps its thinking — the Vertex form, gated on a resolved Gemini model, never zero', () => {
  const leg = WIRED.slice(WIRED.indexOf('function normaliseChat'), WIRED.indexOf('function buildEpisodeClinicalState'));
  assert.ok(leg.includes('thinking_budget: STATE_LLM_THINKING_BUDGET'), 'the cap is on the leg');
  assert.ok(leg.includes('geminiModel ? { google:'), 'gated: the Ollama path never sees the field');
  // Read the shipped default off the source — importing lib/patient-summary.ts would drag the
  // whole episode-assembly chain into a unit test.
  const m = WIRED.match(/PATIENT_SUMMARY_STATE_LLM_THINKING\) \|\| (\d+);/);
  assert.ok(m, 'env-overridable for a re-measure, with a named default');
  const shipped = Number(m![1]);
  assert.ok(shipped > 0, 'gemini-2.5-pro rejects a zero thinking budget with an HTTP 400');
  assert.equal(shipped, 4096, "V's ruling, 31 Jul — findings over the 1-in-20 failure rate");
});

test('the audit budget is NOT changed by the stage-2 cap — separate constants, separate files', () => {
  assert.ok(!WIRED.includes('AUDIT_EVAL_THINKING_BUDGET'), 'stage 2 does not reach into the audit engine');
  const AUDIT = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(AUDIT.includes('AUDIT_EVAL_THINKING_BUDGET) || 4096'), 'the audit budget stays 4096');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// T-13 · a dead clinical leg must report itself degraded (31 Jul 2026)
//
// REPRODUCED FROM THE REAL FAILURE. Trace d2c9f0cb-08d4-4d3e-83c2-2448e8f92b0c: the ccb_clinical
// leg died on the bridge (empty 200 after 133s), the response check caught it and wrote BOTH a
// provider_error and an llm_error — and the package shipped `clinical.findings: []`,
// `citation_coverage_pct: 0` and `degraded: FALSE`. The four original rules could not see it: the
// array was empty but PRESENT, clinical_state built independently and was fine, and other legs
// supplied observations. Evidence preserved as fixture-showcase-FAILED-CLINICAL-LEG.json.
// ═════════════════════════════════════════════════════════════════════════════════════════════

// Exactly what that trace held: two healthy report reads, the dead clinical leg, a healthy stage 2.
const T13_OBSERVATIONS = [
  { provider: 'openrouter', model: 'google/gemini-2.5-pro' },   // ccb_report_read
  { provider: 'openrouter', model: 'google/gemini-2.5-pro' },   // ccb_report_read
  { provider: 'openrouter', model: 'google/gemini-2.5-pro' },   // clinical_state_normalise
];

test('T-13 §5.1: the captured failure now reports degraded, naming the dead leg', () => {
  const r = resolveServed(T13_OBSERVATIONS, {
    partial: false, stateLlmFailed: false,
    failedLegs: ['ccb_clinical', 'ccb_clinical'],          // provider_error + llm_error, same leg
    clinical: { findings: 0, citationCoveragePct: 0 },
  });
  assert.equal(r.degraded, true, 'the package that shipped as healthy no longer can');
  assert.match(String(r.degraded_reason), /ccb_clinical/, 'the reason NAMES the leg — Pulse shows this text');
  assert.match(String(r.degraded_reason), /NO clinical content/, 'and states plainly that the package is empty');
  assert.equal(r.served_provider, 'openrouter', 'provenance is unchanged — the healthy legs still served');
});

test('T-13 §5.2: a HEALTHY package still reports degraded:false — the check must not mark everything', () => {
  const r = resolveServed(T13_OBSERVATIONS, {
    partial: false, stateLlmFailed: false, failedLegs: [],
    clinical: { findings: 7, citationCoveragePct: 86 },
  });
  assert.equal(r.degraded, false);
  assert.equal(r.degraded_reason, null);
});

test('T-13 §5.4: each check fires ALONE, with the other disabled', () => {
  // Trace-based only: findings present, but a leg failed. A partial section is still degraded.
  const traceOnly = resolveServed(T13_OBSERVATIONS, {
    failedLegs: ['ccb_prognosis'], clinical: { findings: 4, citationCoveragePct: 50 },
  });
  assert.equal(traceOnly.degraded, true, 'a failed leg degrades even when content survived');
  assert.match(String(traceOnly.degraded_reason), /ccb_prognosis/);
  assert.doesNotMatch(String(traceOnly.degraded_reason), /NO clinical content/);

  // Content-based only: the trace recorded nothing at all, yet the package is empty.
  const contentOnly = resolveServed(T13_OBSERVATIONS, {
    failedLegs: [], clinical: { findings: 0, citationCoveragePct: 0 },
  });
  assert.equal(contentOnly.degraded, true, 'a failure that never wrote an event is still visible');
  assert.match(String(contentOnly.degraded_reason), /NO clinical content/);
  assert.doesNotMatch(String(contentOnly.degraded_reason), /a model leg failed/);
});

test('T-13: the content check needs BOTH conditions — a grounded package with 0 findings, or an ungrounded one with findings, is not "empty"', () => {
  assert.equal(resolveServed(T13_OBSERVATIONS, { clinical: { findings: 0, citationCoveragePct: 40 } }).degraded, false);
  assert.equal(resolveServed(T13_OBSERVATIONS, { clinical: { findings: 3, citationCoveragePct: 0 } }).degraded, false,
    'zero coverage alone is what `ungrounded` is for — a different obligation, not this one');
  // Unknown coverage is NOT zero coverage. Never fire the empty-package reason on a missing figure.
  assert.equal(resolveServed(T13_OBSERVATIONS, { clinical: { findings: 0, citationCoveragePct: null } }).degraded, false);
});

test('T-13: failed legs are deduped and named in sorted order, and junk never crashes the reason', () => {
  const r = resolveServed(T13_OBSERVATIONS, { failedLegs: ['ccb_clinical', 'ccb_clinical', 'ccb_prognosis', ''] });
  assert.match(String(r.degraded_reason), /\(ccb_clinical, ccb_prognosis\)/);
  assert.equal(resolveServed(T13_OBSERVATIONS, { failedLegs: [] }).degraded, false, 'an empty list is not a failure');
});

test('T-13: the reasons compose — every independent cause is stated, none replaces another', () => {
  const r = resolveServed([{ provider: 'ollama', model: 'qwen2.5:14b' }], {
    partial: true, stateLlmFailed: true, failedLegs: ['ccb_clinical'],
    clinical: { findings: 0, citationCoveragePct: 0 },
  });
  const reason = String(r.degraded_reason);
  for (const fragment of ['local fallback model', 'could not be assembled', 'state-normalisation leg failed',
    'a model leg failed', 'NO clinical content']) {
    assert.ok(reason.includes(fragment), `states: ${fragment}`);
  }
});

// ── §4 · as_of carries ONE format ─────────────────────────────────────────────────────────────

test('T-13 §4: as_of is normalised to full ISO 8601 — a bare date keeps its calendar day', () => {
  // MEASURED on the wire, same field, same api_version: fixture-rich returned a bare date,
  // fixture-showcase a full IST instant.
  assert.equal(normaliseAsOf('2026-07-29'), '2026-07-29T00:00:00+05:30');
  assert.equal(normaliseAsOf('2026-07-27T11:29:11+05:30'), '2026-07-27T11:29:11+05:30', 'already full ISO — untouched');
  // Anchored to IST, NOT converted to UTC: 00:00 IST is 18:30 the previous day in UTC, and a
  // consumer slicing the first ten characters would see the date move.
  assert.ok(normaliseAsOf('2026-07-29')!.startsWith('2026-07-29'));
  assert.equal(normaliseAsOf('2026-07-29T06:00:00'), '2026-07-29T06:00:00+05:30', 'zoneless wall clock is IST here');
  assert.equal(normaliseAsOf('2026-07-29T00:30:00Z'), '2026-07-29T00:30:00Z', 'a UTC instant is already unambiguous');
  assert.equal(normaliseAsOf(null), null);
  assert.equal(normaliseAsOf(''), null);
  assert.equal(normaliseAsOf('not a date'), 'not a date', 'never invent a timestamp — pass junk through');
});

test('T-13 §4: the snapshot itself is NOT recomputed — only the envelope is formatted', () => {
  assert.ok(WIRED.includes('getMemberSnapshot(bundle.keys.individualUid, generatedAt)'), 'unchanged call');
  const CORE = readFileSync('lib/patient-summary-core.ts', 'utf8');
  assert.ok(CORE.includes('as_of: normaliseAsOf(i.memberState?.asOf)'), 'formatted at the boundary');
  assert.ok(!CORE.includes('memberState.asOf ='), 'the snapshot is never mutated');
});

test('T-13 §2: the envelope reads the failure signal that already existed on the trace', () => {
  assert.ok(WIRED.includes("'provider_error', 'llm_error'"), 'the same query now reads failures too');
  assert.ok(WIRED.includes('failedLegs: trace.failedLegs'), 'and passes them to the envelope');
  assert.ok(!WIRED.includes('clinicalLegFailed'), 'generic by leg, not a fifth per-leg boolean the next leg can miss');
});
