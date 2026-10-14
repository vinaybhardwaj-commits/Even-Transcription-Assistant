/**
 * scripts/lab-versions-gen.mjs — bake every lab engine's version at BUILD time
 * (LAB-MCP-V2-PRD-v1.0 §17.6 item 8, decision 53).
 *
 * ⚠️ THE PROBLEM THIS SOLVES. Five of the seven engines have no version constant of their own, so
 * decision 39 made their version the route file's GIT BLOB HASH, computed from the source ON DISK.
 * That is exact in a developer's tree and in CI, and it is `unavailable` in the Vercel serverless
 * bundle, because a `.ts` file is not shipped there. `engine_describe` therefore reported
 * `ask/route@unavailable` in the one environment anyone actually queries — a version that says it
 * does not know is honest, and useless.
 *
 * So the hashes are computed HERE, where the sources are, and committed. `engine_describe` prefers
 * the live hash when it can read the file and falls back to the baked one when it cannot, and says
 * WHICH it used. A test asserts the committed file is fresh against the sources, so a route edited
 * without re-running this fails the gate rather than shipping a stale version.
 *
 * Run: `npm run lab:versions` — and it runs from `npm run build` before `next build`.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'lib', 'lab-v2', 'engine-versions.generated.ts');

/** `sha1("blob <bytes>\0" + contents)` — byte-identical to `git hash-object`, as decision 39 says. */
function blobHash(file) {
  const data = readFileSync(join(process.cwd(), file));
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

/**
 * The route file behind each engine that has no version constant. Read from the adapters rather
 * than typed here would need the whole Next runtime; the five paths are pinned by
 * `adapters-a3.test.ts` against the adapters themselves, so a drift between this list and the
 * adapters is caught there and by this round's freshness test.
 */
const ROUTE_FILES = {
  ask: 'app/api/ask/route.ts',
  ddx: 'app/api/ddx/route.ts',
  appropriateness: 'app/api/appropriateness/route.ts',
  pathway: 'app/api/pathway/skeleton/route.ts',
  doc_audit: 'app/api/doc-audit/analyze/route.ts',
};

const routes = {};
for (const [engine, file] of Object.entries(ROUTE_FILES)) {
  routes[engine] = { file, blob: blobHash(file), version: `${engine}/route@${blobHash(file).slice(0, 12)}` };
}

const body = `/**
 * lib/lab-v2/engine-versions.generated.ts — GENERATED. Do not edit by hand.
 *
 * Written by \`npm run lab:versions\` (scripts/lab-versions-gen.mjs), which \`npm run build\` calls
 * before \`next build\`. It exists because decision 39's route blob hash is computed from a \`.ts\`
 * file that the Vercel serverless bundle does not ship, so \`engine_describe\` reported
 * \`route@unavailable\` in production. Baking the hash at build time makes the version exact
 * everywhere; \`lib/lab-v2/__tests__/b3-versions.test.ts\` fails if this file is stale.
 *
 * Regenerate with: npm run lab:versions
 */

/** engine → the route file its version is derived from, that file's git blob hash, and the version. */
export const GENERATED_ROUTE_VERSIONS: Readonly<Record<string, { file: string; blob: string; version: string }>> = ${JSON.stringify(routes, null, 2)} as const;

/** The baked version for an engine with no version constant, or null when it has one. */
export function bakedEngineVersion(engine: string): string | null {
  return GENERATED_ROUTE_VERSIONS[engine]?.version ?? null;
}
`;

writeFileSync(OUT, body);
console.log(`lab:versions — wrote lib/lab-v2/engine-versions.generated.ts (${Object.keys(routes).length} route engines).`);
