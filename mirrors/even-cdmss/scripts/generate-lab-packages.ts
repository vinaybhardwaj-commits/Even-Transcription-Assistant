/**
 * scripts/generate-lab-packages.ts — one-off generator for data/lab-packages.json (§7.2).
 *
 *   node --env-file=.env.local --import tsx scripts/generate-lab-packages.ts
 *   node --env-file=.env.local --import tsx scripts/generate-lab-packages.ts --dry-run
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ V MUST RUN THIS. The build sandbox has NO live database, so the committed
 * data/lab-packages.json ships EMPTY (`[]`). That is safe by construction — §7.2/§8.9 require an
 * empty or malformed file to produce a judge context byte-identical to today's, which is tested —
 * but it means the duplication-flagging fix is INERT until this runs and the output is committed.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The point of generating rather than authoring (decision §1.13): EHRC's own package composition is
 * already in production data, so Dr. Binita CORRECTS A POPULATED DRAFT instead of authoring 62
 * packages from scratch. `aliases` ships empty — that is the field she edits, to add the colloquial
 * names doctors actually write ("vit profile", "vitamin panel").
 *
 * VALIDATED SOURCE (§2.11):
 *   SELECT DISTINCT investigation__name, included_tests
 *     FROM "individuals-prescriptions__further_investigation"
 *    WHERE included_tests IS NOT NULL AND included_tests <> ''
 *
 * `included_tests` REPEATS EACH TEST, typically twice, within a single string — de-duplication is
 * mandatory, case-insensitive, and an entry equal to the package name itself is dropped.
 * Expect 62 packages.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { metabaseQuery } from '../lib/metabase';
import { LAB_PACKAGE_SOURCE, type LabPackage } from '../lib/scoring-policy/lab-packages-csv';

const OUT = join(process.cwd(), 'data/lab-packages.json');
const EXPECTED_PACKAGES = 62;

/** Split, trim, de-duplicate case-insensitively, drop anything equal to the package name. */
export function constituentsFrom(includedTests: string, packageName: string): string[] {
  const pkg = String(packageName ?? '').trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(includedTests ?? '').split(',')) {
    const v = part.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (k === pkg) continue;          // a package listing itself tells the judge nothing
    if (seen.has(k)) continue;        // the source repeats each test, typically twice
    seen.add(k);
    out.push(v);
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const rows = await metabaseQuery(
    `SELECT DISTINCT investigation__name, included_tests
       FROM "individuals-prescriptions__further_investigation"
      WHERE included_tests IS NOT NULL AND included_tests <> ''`,
  );

  // One entry per package name; if db13 holds several rows for a package, union their constituents
  // rather than letting the last row win.
  const byName = new Map<string, LabPackage>();
  for (const r of rows) {
    const name = String(r.investigation__name ?? '').trim();
    if (!name) continue;
    const tests = constituentsFrom(String(r.included_tests ?? ''), name);
    if (!tests.length) continue;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      const seen = new Set(existing.contains.map((c) => c.toLowerCase()));
      for (const t of tests) if (!seen.has(t.toLowerCase())) { existing.contains.push(t); seen.add(t.toLowerCase()); }
    } else {
      byName.set(key, { package: name, aliases: [], contains: tests, source: LAB_PACKAGE_SOURCE });
    }
  }

  const packages = [...byName.values()].sort((a, b) => a.package.localeCompare(b.package));
  const json = `${JSON.stringify(packages, null, 2)}\n`;

  console.log(`rows: ${rows.length}`);
  console.log(`packages: ${packages.length}${packages.length === EXPECTED_PACKAGES ? '' : `  ⚠️ expected ${EXPECTED_PACKAGES}`}`);
  const dupes = packages.filter((p) => new Set(p.contains.map((c) => c.toLowerCase())).size !== p.contains.length);
  console.log(`packages with a duplicate constituent: ${dupes.length}${dupes.length ? '  ⚠️ de-duplication failed' : ''}`);

  if (dryRun) {
    console.log('\n--dry-run — nothing written. First three:');
    console.log(JSON.stringify(packages.slice(0, 3), null, 2));
    return;
  }
  writeFileSync(OUT, json, 'utf8');
  console.log(`\nwrote ${OUT} (${json.length} bytes). Commit it, then run: npm run reasoning:registry`);
}

// Only run when invoked directly, so the pure helper above stays importable by tests.
if (process.argv[1] && /generate-lab-packages\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exit(1); });
}
