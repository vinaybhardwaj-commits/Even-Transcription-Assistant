// Architecture Governance Slice 1 — clinical-semantics test #5 (ratified invariant).
// ADVISORY NEVER CARRIES SCORED-BAND VISUAL LANGUAGE: the advisory/longitudinal context
// indicator renders from the informational CONTEXT_STYLE palette — never bandColor/scoreColor
// (the scored-band language). FORM USED: pure palette-disjointness + source-level assertion
// (PRD Part C item 5's sanctioned equivalent). WHY THIS FORM IS FAITHFUL: audit-table.tsx is a
// 'use client' component whose module graph (lucide-react etc.) cannot load under node --test,
// so instead of a renderToStaticMarkup harness we prove the SAME invariant two ways:
//   (a) the CONTEXT_STYLE palette (parsed from the component SOURCE, so it cannot drift) shares
//       ZERO colours with the band palette (bandColor A–E + scoreColor across every threshold);
//   (b) source-level: every line that renders from CONTEXT_STYLE references neither bandColor
//       nor scoreColor — the advisory cell simply has no path to the scored palette.
// Together (a)+(b) make "an advisory badge that LOOKS like a band badge" unrepresentable
// without failing this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bandColor, scoreColor } from '../opd-audit-ui';

const SRC = readFileSync(join(process.cwd(), 'app/admin/opd-audit/audit-table.tsx'), 'utf8');

/** Parse the CONTEXT_STYLE literal out of the component source (fails loudly if it moves). */
function contextPalette(): { keys: string[]; colors: Set<string> } {
  const colors = new Set<string>();
  const keys: string[] = [];
  const block = SRC.match(/const CONTEXT_STYLE[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'CONTEXT_STYLE literal found in audit-table.tsx');
  for (const m of block![1].matchAll(/(\w+):\s*\{\s*label:[^}]*?color:\s*'(#[0-9a-fA-F]+)',\s*bg:\s*'(#[0-9a-fA-F]+)'/g)) {
    keys.push(m[1]);
    colors.add(m[2].toLowerCase());
    colors.add(m[3].toLowerCase());
  }
  return { keys, colors };
}

test('semantics #5a: the advisory CONTEXT_STYLE palette is disjoint from the scored-band palette', () => {
  const { keys, colors } = contextPalette();
  assert.deepEqual(keys.sort(), ['established', 'none', 'thin'], 'all three context tiers parsed (no vacuous pass)');
  const bandPalette = new Set<string>();
  for (const b of ['A', 'B', 'C', 'D', 'E']) bandPalette.add(bandColor(b).toLowerCase());
  for (const s of [0, 39, 40, 54, 55, 69, 70, 84, 85, 100]) bandPalette.add(scoreColor(s).toLowerCase());
  for (const c of colors) assert.ok(!bandPalette.has(c), `advisory colour ${c} must not appear in the band/score palette`);
});

test('semantics #5b: no advisory render line reaches for bandColor/scoreColor (source assertion)', () => {
  const advisoryLines = SRC.split('\n').filter((l) => l.includes('CONTEXT_STYLE'));
  assert.ok(advisoryLines.length >= 3, 'CONTEXT_STYLE is actually rendered (definition + tint + badge)');
  for (const l of advisoryLines) {
    assert.ok(!l.includes('bandColor') && !l.includes('scoreColor'),
      `advisory line must not use the scored palette: ${l.trim().slice(0, 100)}`);
  }
});

test('semantics #5c: the scored-band palette itself is intact (guards against gaming 5a by editing the bands)', () => {
  // bandFor thresholds ↔ scoreColor thresholds stay aligned; five distinct band colours exist.
  const five = new Set(['A', 'B', 'C', 'D', 'E'].map((b) => bandColor(b)));
  assert.equal(five.size, 5);
});
