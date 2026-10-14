// lib/__tests__/reasoning-registry.test.ts — Reasoning Observability Stage 0 tests:
// generator determinism / committed-artifact currency / hash validity / PHI-exclusion /
// manifest merge / rubric inclusion / count invariant. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderRegistryExport, renderRegistryHtml, manifestFor } from '../reasoning/registry-core';
import { PROMPT_MANIFESTS, UNREGISTERED_PROMPTS } from '../reasoning/manifest';
import GENERATED from '../../data/reasoning-registry/prompts.generated.json';

// The generator is an untyped .mjs script; resolve it at runtime (tsx) so tsc doesn't chase it.
const GEN_SPECIFIER = ['..', '..', 'scripts', 'reasoning-registry-gen.mjs'].join('/');

test('registry generation is deterministic and the committed artifact is current', async () => {
  const { buildRegistryJson } = await import(GEN_SPECIFIER);
  const first = buildRegistryJson();
  const second = buildRegistryJson();
  assert.equal(first, second, 'two runs must be byte-identical (the CI staleness gate depends on this)');
  assert.ok(!/generated|source_commit|timestamp/.test(Object.keys(JSON.parse(first)).join(' ')),
    'no time- or commit-dependent top-level field may be emitted');
  // npm test runs from the repo root
  const committed = readFileSync('data/reasoning-registry/prompts.generated.json', 'utf8');
  assert.equal(first, committed, 'committed prompts.generated.json is stale — run `npm run reasoning:registry`');
});

test('every extracted prompt has non-empty text and a valid sha256 of exactly that text', () => {
  const gen = GENERATED as { prompts: Array<{ id: string; text: string; sha256: string; sha12: string; chars: number; lines: number }> };
  assert.ok(gen.prompts.length > 0);
  for (const p of gen.prompts) {
    assert.ok(p.text.trim().length > 0, `${p.id} has empty text`);
    assert.match(p.sha256, /^[0-9a-f]{64}$/, `${p.id} sha256 malformed`);
    const recomputed = createHash('sha256').update(p.text, 'utf8').digest('hex');
    assert.equal(p.sha256, recomputed, `${p.id} sha256 does not hash its own text`);
    assert.equal(p.sha12, p.sha256.slice(0, 12));
    assert.equal(p.chars, p.text.length);
    assert.equal(p.lines, p.text.split('\n').length);
  }
});

test('the research export contains prompt/rubric/metadata keys ONLY — no clinical/patient/trace content', () => {
  const x = renderRegistryExport();
  // any key resembling run/clinical/patient/trace content fails the export
  const FORBIDDEN = /(patient|phi\b|trace|uhid|mrn|dob|diagnos|complaint|medication|symptom|input|output|answer|response|payload|run_id|member|episode|encounter)/i;
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) { v.forEach((e, i) => walk(e, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        assert.ok(!FORBIDDEN.test(k), `forbidden key "${k}" at ${path} — the research export must carry no clinical/patient/trace fields`);
        walk(val, `${path}.${k}`);
      }
    }
  };
  walk(x, '$');
  // and the HTML rendering serves the same payload, nothing extra
  const html = renderRegistryHtml(x);
  assert.ok(html.includes('CDMSS reasoning registry') && html.includes(x.prompts[0].id));
});

test('manifest merge: registered id gets its metadata; unknown id → unregistered, never a throw', () => {
  const registered = manifestFor('opd-note-audit-core/OPD_AUDIT_SYSTEM');
  assert.equal(registered.maturity, 'draft');
  assert.equal(registered.rubricId, 'PDQI-9 reasoning rubric');
  assert.equal(registered.owner, null, 'owner is an honest blank, not a guessed name');
  const unknown = manifestFor('no-such-file/NO_SUCH_SYSTEM');
  assert.deepEqual(unknown, { maturity: 'unregistered', owner: null, clinicianApprover: null, rubricId: null, schemaId: null });
  // coverage: every generated id is either registered or on the honest gap list — and no stale entries
  const genIds = new Set((GENERATED as { prompts: Array<{ id: string }> }).prompts.map((p) => p.id));
  const listed = new Set([...PROMPT_MANIFESTS.map((m) => m.id), ...UNREGISTERED_PROMPTS]);
  for (const id of genIds) assert.ok(listed.has(id), `${id} is in the generated registry but neither registered nor on UNREGISTERED_PROMPTS`);
  for (const id of listed) assert.ok(genIds.has(id), `${id} is listed in the manifest but no longer in the generated registry (stale entry)`);
  // every registered rubricId must resolve to a real rubric
  const rubricIds = new Set((GENERATED as { rubrics: Array<{ id: string }> }).rubrics.map((r) => r.id));
  for (const m of PROMPT_MANIFESTS) {
    if (m.rubricId) assert.ok(rubricIds.has(m.rubricId), `${m.id} links rubric "${m.rubricId}", which is not in the registry`);
  }
});

test('rubric inclusion: nabh/6e external-json + the five embedded-in-prompt rubrics', () => {
  const rubrics = (GENERATED as { rubrics: Array<{ id: string; kind: string; sha256?: string; embedded_in?: string }> }).rubrics;
  const nabh = rubrics.find((r) => r.id === 'nabh/6e');
  assert.ok(nabh, 'nabh/6e missing');
  assert.equal(nabh!.kind, 'external-json');
  assert.match(nabh!.sha256!, /^[0-9a-f]{64}$/);
  const embedded = rubrics.filter((r) => r.kind === 'embedded-in-prompt');
  assert.equal(embedded.length, 5);
  const genIds = new Set((GENERATED as { prompts: Array<{ id: string }> }).prompts.map((p) => p.id));
  for (const r of embedded) {
    const hostId = r.embedded_in!.replace(/\.ts\//, '/');
    assert.ok(genIds.has(hostId), `${r.id} embedded_in ${r.embedded_in} does not resolve to an extracted prompt`);
  }
});

test('count invariant: counts match the committed artifact contents (34 prompts / 7 rubrics / 41 builders)', () => {
  const gen = GENERATED as {
    counts: { prompts: number; rubrics: number; user_message_builders: number; features: number };
    prompts: Array<{ feature: string }>; rubrics: unknown[]; user_message_builders: unknown[];
  };
  assert.equal(gen.counts.prompts, gen.prompts.length);
  assert.equal(gen.counts.rubrics, gen.rubrics.length);
  assert.equal(gen.counts.user_message_builders, gen.user_message_builders.length);
  assert.equal(gen.counts.features, new Set(gen.prompts.map((p) => p.feature)).size);
  // the ratified Stage-0 baseline (CDMSS-REASONING-CONFIG-EXPORT-14-JUL-2026): a change here is
  // a REAL change to the reasoning surface — bump knowingly, in the same commit as the prompt.
  // Inquiry K1 adds inquiry-core/INQUIRY_SELECT_SYSTEM + buildInquirySelectUser (27→28, 29→30).
  // Brainstem PR 0 adds verify-core/VERIFY_SYSTEM + buildVerifyUser (28→29, 30→31, +1 feature).
  // Concept Coder Phase 1 adds even-concept/CONCEPT_EXTRACT_SYSTEM + buildConceptExtractUser (29→30, 31→32, +1 feature).
  // Scoring-policy Phase C registers data/lab-packages.json as a SECOND external-json reference
  // (6→7 rubrics). No prompt, builder or feature changes: it is factual context injected into an
  // existing prompt (lvc-core/buildJudgeUser), not a new reasoning surface.
  // Readmission Agent Phase 1 (5 Aug 2026) adds the four readmission-prompts builders
  // (buildFullReconPrompt / buildSecondAvoidablePrompt / buildConditionPassPrompt / buildOonPrompt,
  // 32→36). Their system prompts live inline in the builders, not as exported *_SYSTEM consts, so
  // prompts/features are unchanged — a deliberate bump, in the same commit as the prompts.
  // Readmissions R4 (18 Aug 2026) adds readmission-prompts/buildNarrativePrompt — the case-page
  // narrative leg (Opus 4.6 on Bedrock, code-enforced citations); system inline, so builders only
  // (36→37). The four recon builders are byte-identical (pinned in readmission-r4-case.test.ts).
  // Readmissions R4.3 (19 Aug 2026) adds readmission-prompts/buildAskPrompt — "ask the agent", a
  // conversation fenced to one case's stored material; system inline (37→38). Recon + narrative
  // builders byte-identical (readmission-r43-ask.test.ts pins both fingerprint sets).
  // LVP L2 (21 Aug 2026) adds lvp-operator-core/LVP_OPERATOR_SYSTEM — the low-value-patterns shelf
  // operator (Opus 4.6 on Bedrock), a genuinely new reasoning surface (30→31 prompts, +1 feature).
  // Builders are UNCHANGED at 38: its user message is assembled by operatorUserMessage(), which the
  // generator does not count as a builder, and no existing builder moved.
  // Pre-op Risk B5 + B6 (27 Aug 2026) add the module's two LLM rails, and they are the
  // module's ONLY reasoning surfaces — everything else in it is arithmetic:
  //   preop-extract-core/EXTRACT_SYSTEM         + buildExtractPrompt    (31→32, 38→39, +1 feature)
  //   preop-narrative-core/PREOP_NARRATIVE_SYSTEM + buildNarrativePrompt (32→33, 39→40, +1 feature)
  // Both ship behind flags that are OFF, and both are registered anyway: the registry
  // records what the codebase CAN reason with, not what is currently switched on.
  // CASE-AGENTS-SPINE P1 (27 Aug 2026) adds ONE builder, buildCaseAskPrompt in case-ask-core —
  // the shared persisted Ask on the OPD note-audit and IPD discharge-audit cases (40→41). No new
  // PROMPT const: like the readmission Ask it extracts from, its system text is assembled inside
  // the builder rather than bound to a standing _SYSTEM const, so prompts stay 33. No new feature
  // row either — case-ask-core is not in the generator's FEATURE_OF map, so it labels itself.
  // STEWARDSHIP S4 (29 Aug 2026) adds physician-standing-core/STANDING_PROMPT_CLAUSE — the medical
  // superintendent's standing overlay (33→34 prompts, +1 feature; physician-standing-core is not in
  // the generator's FEATURE_OF map, so it labels itself). Builders stay 41: the clause is appended
  // to the SHARED buildCaseAskPrompt as an optional material field, so no new builder exists and
  // buildCaseAskPrompt itself is unchanged for OPD and IPD (pinned byte-for-byte in
  // physician-standing.test.ts and case-ask-core.test.ts). It is a genuinely new reasoning surface
  // and it is counted as one — but note what it asks for: the model REPORTS what a named reviewer
  // asserted in his own words, and code discards anything it cannot find inside that turn.
  // IPD EPISODE AUDIT 0.1 (2 Sep 2026) adds the four standing prompts of the second IPD engine —
  // lib/ipd-episode/prompts.ts, all four registered in the manifest (34→38 prompts). Four new
  // builders come with them, one per pass: buildCheckpointUser in checkpoint-core and
  // buildDiffUser / buildFidelityUser / buildCommentaryUser in judge-core (41→45). Features go
  // 23→24: ipd-episode/prompts.ts is not in the generator's FEATURE_OF map, so it labels itself.
  // Rubrics are unchanged at 7 — the discipline in all four prompts is the BLINDING (what each
  // pass may not see), which is embedded in the text and re-enforced in code, not a linkable
  // rubric document.
  assert.equal(gen.counts.prompts, 38);
  assert.equal(gen.counts.rubrics, 7);
  assert.equal(gen.counts.user_message_builders, 45);
  assert.equal(gen.counts.features, 24);
});
