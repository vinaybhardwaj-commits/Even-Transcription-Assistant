// lib/__tests__/opd-normative-channel.test.ts — R-11 fix candidate: the ADDITIVE normative channel.
// The 8 literature excerpts must stay byte-identical (the displacement fix); CW statements append as
// a separate citable [9+] block. Pure — no DB/LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assembleAuditContext, buildNormativeBlock, normativeChannelOpts, opdRetrieveOpts,
  NORMATIVE_CHANNEL_HEADER, NORMATIVE_CHANNEL_K,
} from '../opd-note-audit.ts';
import { hitsToSources, buildCitedContext, type CiteHit } from '../citations-core.ts';
import { parseBatchState, LB_KEYS } from '../lab-batch-core.ts';

const lit = (id: number): CiteHit => ({
  id, source: 'statpearls', book: 'StatPearls', chapter: `ch${id}`, section: null,
  page_start: null, page_end: null, item_number: null, chunk_type: 'narrative',
  similarity: 0.5, text: `literature excerpt ${id} about antihistamine montelukast evidence`,
});
const cw = (id: number, society = 'CW-AAFP'): CiteHit => ({
  id, source: 'choosing-wisely', book: society, chapter: null, section: null,
  page_start: null, page_end: null, item_number: `cwus-${id}`, chunk_type: 'recommendation',
  similarity: 0.6, text: `Avoid prescribing antihistamine+montelukast for viral URTI (statement ${id})`,
});

// ── Test 1 — no channel ⇒ context assembly byte-identical to today (production regression guard) ──
test('no normative hits ⇒ assembleAuditContext is byte-identical to today\'s assembly', () => {
  const hits = [lit(1), lit(2), lit(3), lit(4), lit(5), lit(6), lit(7), lit(8)];
  const { sources, citedContext } = assembleAuditContext(hits, []);
  assert.deepEqual(sources, hitsToSources(hits), 'sources must be exactly hitsToSources(hits)');
  assert.equal(citedContext, buildCitedContext(hits), 'citedContext must be exactly buildCitedContext(hits)');
});

// ── Test 2a — channel mode leaves the LITERATURE retrieve untouched (no eviction) ──
test('channel mode: the literature retrieve opts are unchanged — useNormativeLeg is NOT set', () => {
  // the channel never touches opdRetrieveOpts — the audit's lit retrieve stays today's exact opts
  const litOpts = opdRetrieveOpts(false, {});
  assert.deepEqual(litOpts, { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true });
  assert.ok(!('useNormativeLeg' in litOpts));
  // and the 8 lit excerpts appear UNCHANGED at the head of the channel context
  const hits = Array.from({ length: 8 }, (_, i) => lit(i + 1));
  const { citedContext } = assembleAuditContext(hits, [cw(101)]);
  assert.ok(citedContext.startsWith(buildCitedContext(hits)), 'the [1-8] literature block must be byte-identical');
});

// ── Test 2b — the separate normative retrieve is the shipped CW-restricted shape, LIMIT 4 ──
test('normativeChannelOpts: standalone CW-only search — restrictSources, topK 4, leg NOT set', () => {
  const opts = normativeChannelOpts({});
  assert.equal(opts.topK, NORMATIVE_CHANNEL_K);
  assert.equal(NORMATIVE_CHANNEL_K, 4);
  assert.deepEqual(opts.restrictSources, ['choosing-wisely', 'lab:guidelines-even-protocols', 'lab:guidelines-icmr-amr-2019']);
  assert.ok(!('useNormativeLeg' in opts), 'the channel is NOT the leg — no union flag');
  assert.equal(opts.useReranker, false);
  assert.equal(opts.skipExpand, true);
});

// ── Test 2c — citedContext carries the labelled block, numbering continuing past the literature ──
test('channel context: literature [1-8] then the labelled normative block [9+]', () => {
  const hits = Array.from({ length: 8 }, (_, i) => lit(i + 1));
  const norm = [cw(101, 'CW-AAFP'), cw(102, 'CW-AAP')];
  const { sources, citedContext } = assembleAuditContext(hits, norm);
  // block present, labelled, additive framing intact
  assert.ok(citedContext.includes(NORMATIVE_CHANNEL_HEADER));
  assert.ok(NORMATIVE_CHANNEL_HEADER.includes('do not replace it'));
  assert.ok(NORMATIVE_CHANNEL_HEADER.includes('Do NOT withhold or downgrade'));
  // numbering continues: [9] and [10], society-suffixed
  assert.ok(citedContext.includes('[9] Avoid prescribing antihistamine+montelukast for viral URTI (statement 101) — CW-AAFP'));
  assert.ok(citedContext.includes('[10] Avoid prescribing antihistamine+montelukast for viral URTI (statement 102) — CW-AAP'));
  // sources extend so citation_ids [9]/[10] resolve to the CW chunks
  assert.equal(sources.length, 10);
  assert.equal(sources[8].n, 9);
  assert.equal(sources[8].source, 'choosing-wisely');
  assert.equal(sources[9].n, 10);
  // and the first 8 sources are byte-identical to today's
  assert.deepEqual(sources.slice(0, 8), hitsToSources(hits));
});

test('numbering adapts when fewer than 8 literature excerpts return', () => {
  const hits = [lit(1), lit(2), lit(3)];
  const { citedContext, sources } = assembleAuditContext(hits, [cw(101)]);
  assert.ok(citedContext.includes('[4] Avoid prescribing'), 'block starts right after the last lit excerpt');
  assert.equal(sources.length, 4);
  assert.equal(sources[3].n, 4);
});

test('buildNormativeBlock: empty hits ⇒ empty string (audit proceeds on literature alone)', () => {
  assert.equal(buildNormativeBlock([], 9), '');
});

// ── Test 3 — leg and channel are independent; channel does NOT set the leg ──
test('evalNormativeChannel is independent of evalNormativeLeg — no union, no eviction', () => {
  // channel opts never carry the leg flag; the leg gate never reads the channel
  assert.ok(!('useNormativeLeg' in normativeChannelOpts({})));
  assert.ok(!('useNormativeLeg' in opdRetrieveOpts(false, {}, undefined)));
  // batch state: the two flags parse independently
  const both = parseBatchState({ [LB_KEYS.evalNormativeChannel]: '1' } as Record<string, string>);
  assert.equal(both.evalNormativeChannel, true);
  assert.equal(both.evalNormativeLeg, false, 'setting the channel must not set the leg');
  const neither = parseBatchState({});
  assert.equal(neither.evalNormativeChannel, false);
});

// ── Test 4 — eval path still writes lab_analyses only ──
test('the eval path still writes lab_analyses only — never opd_note_audits', () => {
  const src = readFileSync('lib/lab-batch.ts', 'utf8');
  assert.ok(src.includes('saveLabAnalysis'));
  assert.ok(!src.includes('saveOpdAudit'));
  assert.ok(!/opd-audit-store/.test(src));
  assert.ok(!/INSERT\s+INTO\s+opd_note_audits/i.test(src));
});

// OPD_AUDIT_SYSTEM is frozen — the channel framing lives ONLY in the user-message context block
test('OPD_AUDIT_SYSTEM is untouched — the channel header is not injected into the system prompt', () => {
  const core = readFileSync('lib/opd-note-audit-core.ts', 'utf8');
  assert.ok(!core.includes('NORMATIVE REFERENCES'), 'the frozen system prompt must not carry the channel framing');
});
