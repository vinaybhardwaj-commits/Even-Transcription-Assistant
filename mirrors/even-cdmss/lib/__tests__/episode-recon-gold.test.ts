// lib/__tests__/episode-recon-gold.test.ts — the EpisodeState reconstruction-fidelity gold pin (#4
// SL5b). The committed episode-recon-gold/1.0 artifact (V, 18-Jul-2026) must load, match the pinned
// content hash (drift = CI red = re-ratification), stay de-identified + URL-free, and carry EXACTLY
// V's genuine verdicts (no backfill; CC's SL5a build-time test posts on IP-100 pre/intra excluded).
// V's set is ALL FAITHFUL — so the bench has NO negative examples (an asserted limitation, not a
// proof of perfection). Plus the loader's drift-rejection paths. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadEpisodeReconGold, reconGoldContentSha256, reconPhaseCount,
  EPISODE_RECON_GOLD_SHA256, EPISODE_RECON_GOLD_VERSION,
} from '../episode-state/recon-gold';
import GOLD from '../../data/episode-recon-gold.json';

test('the committed recon gold is frozen, ratified, and hash-pinned', () => {
  const g = loadEpisodeReconGold(GOLD);
  assert.equal(g.version, EPISODE_RECON_GOLD_VERSION);
  assert.equal(g.validator, 'V');
  assert.equal(g.status, 'ratified');
  assert.equal(g.ratified_at, '2026-07-18');
  assert.equal(g.builder_version, 'episode-state/0.2');
  // the pin: in-file hash == recomputed == the governance constant
  assert.equal(reconGoldContentSha256(g.cases), EPISODE_RECON_GOLD_SHA256);
  assert.equal(g.content_sha256, EPISODE_RECON_GOLD_SHA256);
  // computed over EXACTLY V's genuine verdicts — nothing backfilled
  assert.equal(g.n_cases, 24);
  assert.equal(g.n_phases, 70);
  assert.equal(reconPhaseCount(g.cases), g.n_phases, 'header n_phases matches the rated verdicts');
});

test('the gold carries V\'s genuine verdicts: all 70 faithful, NO negative examples (CC test posts excluded)', () => {
  const g = loadEpisodeReconGold(GOLD);
  const dist: Record<string, number> = { faithful: 0, missed_material_fact: 0, mis_phased: 0, over_included: 0 };
  for (const c of g.cases) for (const v of Object.values(c.phases)) dist[v]++;
  assert.equal(dist.faithful, 70);
  // the honest limitation, pinned: V's rated set is all-faithful → the bench has NO negative examples
  assert.equal(dist.missed_material_fact, 0, 'no completeness miss — CC\'s SL5a test post is excluded, not counted');
  assert.equal(dist.mis_phased, 0);
  assert.equal(dist.over_included, 0);
  // IP-100's pre/intra were CC build-time test posts — excluded; only V's post rating survives
  const ip100 = g.cases.find((c) => c.ip_uid === 'IP-100')!;
  assert.deepEqual(Object.keys(ip100.phases).sort(), ['post'], 'IP-100 keeps only its V-rated post phase');
  assert.equal(ip100.phases.post, 'faithful');
  assert.equal(ip100.phases.pre, undefined, 'the CC test-post miss is not in the gold');
  // no case carries a note (the only note was on the excluded CC post)
  assert.ok(g.cases.every((c) => !c.notes), 'no rationale notes remain (the sole note was CC\'s excluded post)');
});

test('the gold spans strata (speciality + linked/intra-only)', () => {
  const g = loadEpisodeReconGold(GOLD);
  const specs = new Set(g.cases.map((c) => c.speciality));
  assert.ok(specs.size >= 6, `≥6 specialities (got ${specs.size})`);
  assert.ok(specs.has('Internal Medicine'), 'Internal Medicine present');
  assert.ok([...specs].some((s) => /Neuro/.test(s)), 'a neuro stratum present');
  const linkage = g.cases.map((c) => c.linkage);
  assert.ok(linkage.includes('linked') && linkage.includes('intra-only'), 'both linked and intra-only strata');
});

test('the recon gold is de-identified: no UHID / phone / honorific-name / URL anywhere', () => {
  const txt = JSON.stringify((GOLD as { cases: unknown[] }).cases);
  assert.ok(!/UHID[-\s]?\d/i.test(txt), 'no UHID');
  assert.ok(!/\b[6-9]\d{9}\b/.test(txt), 'no 10-digit phone');
  assert.ok(!/\b(Mr|Mrs|Ms|Master|Baby of|B\/O|W\/O|S\/O|D\/O)\.?\s+[A-Z]/.test(txt), 'no honorific+name');
  assert.ok(!/storage\.googleapis\.com|https?:\/\/|gs:\/\//.test(txt), 'no URLs (public repo)');
  for (const c of (GOLD as { cases: Array<Record<string, unknown>> }).cases) {
    for (const k of Object.keys(c)) assert.ok(!/name|uhid|phone|address|dob/i.test(k), `case field '${k}' looks like PHI`);
  }
});

test('loadEpisodeReconGold rejects drift: edited verdict, wrong version/status/validator, dup id, bad verdict/phase', () => {
  const clone = () => JSON.parse(JSON.stringify(GOLD)) as Record<string, unknown> & { cases: Array<Record<string, unknown>> };
  const edited = clone();
  (edited.cases[0].phases as Record<string, string>).intra = 'over_included';   // content edit → hash mismatch
  assert.throws(() => loadEpisodeReconGold(edited), /drifted/);
  assert.throws(() => loadEpisodeReconGold({ ...clone(), version: 'episode-recon-gold/0.9' }), /version/);
  assert.throws(() => loadEpisodeReconGold({ ...clone(), status: 'draft' }), /ratified/);
  assert.throws(() => loadEpisodeReconGold({ ...clone(), validator: 'not-V' }), /single-validator/);
  const dup = clone();
  dup.cases[1].ip_uid = dup.cases[0].ip_uid;
  assert.throws(() => loadEpisodeReconGold(dup));
});
