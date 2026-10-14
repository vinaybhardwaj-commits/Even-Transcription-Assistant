#!/usr/bin/env node
// scripts/changelog-coverage-check.mjs — CI gate (31 Jul 2026).
//
// WHY THIS EXISTS. Engine versions 0.81.15, 0.81.16 and 0.81.17 all shipped with NO changelog
// entry, and the debt went unnoticed for three versions. The changelog is surfaced in-product on
// /admin/opd-audit/how-it-works, so a missing entry is not an internal tidiness problem: it is a
// scoring change a clinician can see in their numbers and cannot look up. The changelog's own
// header already states the discipline ("EVERY change ... gets an entry here"); this makes the
// build enforce it instead of trusting it.
//
// THE RULE: every engine version in OPD_ENGINE_VERSIONS_CURRENT must have an entry in
// OPD_AUDIT_CHANGELOG, and so must OPD_ENGINE_VERSION itself. Entries with `engine: null`
// (changes that shipped without a bump) are legitimate and simply do not participate.
//
//   node scripts/changelog-coverage-check.mjs
//
// Exit 0 = every shipped engine version is documented. Exit 1 = at least one is not.

import { readFileSync } from 'node:fs';

const CORE = 'lib/opd-note-audit-core.ts';
const LOG = 'lib/opd-audit-changelog.ts';

const core = readFileSync(CORE, 'utf8');
const log = readFileSync(LOG, 'utf8');

// The shipped set: OPD_ENGINE_VERSIONS_CURRENT plus the live OPD_ENGINE_VERSION. Read as text so
// this check has no import cycle and no build step of its own.
const familyMatch = core.match(/OPD_ENGINE_VERSIONS_CURRENT\s*=\s*\[([\s\S]*?)\]/);
if (!familyMatch) {
  console.error(`changelog:coverage — FAILED: could not find OPD_ENGINE_VERSIONS_CURRENT in ${CORE}`);
  process.exit(1);
}
const currentMatch = core.match(/OPD_ENGINE_VERSION\s*=\s*'([^']+)'/);
if (!currentMatch) {
  console.error(`changelog:coverage — FAILED: could not find OPD_ENGINE_VERSION in ${CORE}`);
  process.exit(1);
}

const strip = (v) => v.replace(/^opd-note-audit\//, '');
const shipped = new Set(
  [...familyMatch[1].matchAll(/'([^']+)'/g)].map((m) => strip(m[1])).concat(strip(currentMatch[1])),
);

// Documented: every `engine: '<version>'` in the changelog array. `engine: null` is skipped by
// the pattern itself — a no-bump entry documents a change, not a version.
const documented = new Set([...log.matchAll(/engine:\s*'([^']+)'/g)].map((m) => strip(m[1])));

const missing = [...shipped].filter((v) => !documented.has(v)).sort();

if (missing.length) {
  console.error(`changelog:coverage — FAILED: ${missing.length} shipped engine version(s) have no changelog entry:`);
  for (const v of missing) console.error(`  · opd-note-audit/${v}`);
  console.error(`\nAdd an entry to OPD_AUDIT_CHANGELOG in ${LOG} — the changelog is surfaced in-product`);
  console.error(`on /admin/opd-audit/how-it-works, so an undocumented version is a scoring change a`);
  console.error(`clinician can see and cannot look up. Set scoring:true if stored scores changed.`);
  process.exit(1);
}

console.log(`changelog:coverage — GREEN: all ${shipped.size} shipped engine versions documented (${documented.size} versioned entries).`);
