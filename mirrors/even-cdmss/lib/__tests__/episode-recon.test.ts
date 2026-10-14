// lib/__tests__/episode-recon.test.ts — EpisodeState (#4) SL5: reconstruction-fidelity bench.
//
// Invariants that a passing render can't show:
//   1. SEPARATION — ratings live in episode_recon_ratings, NEVER ipd_audit_feedback and NEVER
//      ipd_gold_adjudication. Builder-fidelity is its own bench.
//   2. VOCABULARY — verdicts faithful|missed_material_fact|mis_phased|over_included; phases
//      pre|intra|post. Exactly.
//   3. READ-ONLY on EpisodeState — the queue reads the persisted v0.2 object; it never re-builds or
//      re-extracts (no buildEpisodeState / extractCase import), and reuses the SL3 EpisodeCourse.
//   4. DE-IDENTIFIED — the store has no PHI/URL column; the source PDF is shown READ-TIME, never
//      persisted into the bench.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('(1) SEPARATION: ratings go to episode_recon_ratings, never the other adjudication stores', () => {
  const route = code('app/api/admin/episode-recon-rating/route.ts');
  assert.ok(/INSERT INTO episode_recon_ratings/.test(route), 'writes the dedicated recon store');
  assert.ok(!/ipd_audit_feedback/.test(route), 'never writes ipd_audit_feedback');
  assert.ok(!/ipd_gold_adjudication/.test(route), 'never writes ipd_gold_adjudication');
  const triage = code('app/admin/episode-recon-queue/recon-triage.tsx');
  assert.ok(/\/api\/admin\/episode-recon-rating/.test(triage), 'the triage posts to the dedicated endpoint');
});

test('(2) VOCABULARY: exactly the four fidelity verdicts and three phases', () => {
  const route = code('app/api/admin/episode-recon-rating/route.ts');
  const v = route.match(/VERDICTS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(v, 'verdict allow-list is a Set literal');
  assert.deepEqual(v![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort(),
    ['faithful', 'mis_phased', 'missed_material_fact', 'over_included']);
  const p = route.match(/PHASES = new Set\(\[([^\]]*)\]\)/);
  assert.deepEqual(p![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort(), ['intra', 'post', 'pre']);
});

test('(3) READ-ONLY: the queue reads the persisted episode, never re-builds/re-extracts', () => {
  const page = code('app/admin/episode-recon-queue/page.tsx');
  assert.ok(/FROM episode_states WHERE version/.test(page), 'reads the persisted v0.2 rows');
  assert.ok(!/buildEpisodeState|extractCase|resolveOpdLinkage/.test(page), 'the queue never re-builds or re-extracts');
  assert.ok(/from '\.\.\/ipd-audit\/\[id\]\/episode-course'/.test(page), 'reuses the SL3 EpisodeCourse render, not a fork');
  // measures fidelity, introduces no score/band into the projection
  assert.ok(!/bandColor|careValueIndex|valueScore/.test(page), 'no score/band leaks into the bench render');
});

test('(4) DE-IDENTIFIED: the store has no PHI/URL column; the PDF is read-time only', () => {
  const mig = read('migrations/0017_episode_recon_ratings.sql').replace(/--.*$/gm, '');
  for (const phi of ['patient_name', 'uhid ', 'age_gender', 'pdf_url', 'source_url']) {
    assert.ok(!mig.toLowerCase().includes(phi), `the store must have no '${phi.trim()}' column`);
  }
  assert.ok(/document_id\s+TEXT NOT NULL/.test(mig) && /phase\s+TEXT NOT NULL/.test(mig), 'refs + phase only');
  // the queue fetches the source PDF read-time (fetchIpdDoc) rather than persisting a URL
  const page = code('app/admin/episode-recon-queue/page.tsx');
  assert.ok(/fetchIpdDoc\(c\.documentId\)/.test(page), 'the source PDF is resolved read-time');
  assert.ok(!/INSERT|UPDATE/.test(page), 'the queue writes nothing');
});
