/**
 * lib/lab-v2/engine-versions.generated.ts — GENERATED. Do not edit by hand.
 *
 * Written by `npm run lab:versions` (scripts/lab-versions-gen.mjs), which `npm run build` calls
 * before `next build`. It exists because decision 39's route blob hash is computed from a `.ts`
 * file that the Vercel serverless bundle does not ship, so `engine_describe` reported
 * `route@unavailable` in production. Baking the hash at build time makes the version exact
 * everywhere; `lib/lab-v2/__tests__/b3-versions.test.ts` fails if this file is stale.
 *
 * Regenerate with: npm run lab:versions
 */

/** engine → the route file its version is derived from, that file's git blob hash, and the version. */
export const GENERATED_ROUTE_VERSIONS: Readonly<Record<string, { file: string; blob: string; version: string }>> = {
  "ask": {
    "file": "app/api/ask/route.ts",
    "blob": "cf7b972c87dbb5af36425300f9fb753762565d9d",
    "version": "ask/route@cf7b972c87db"
  },
  "ddx": {
    "file": "app/api/ddx/route.ts",
    "blob": "9b646825fcb7a45ef2e08ccbc470082955c7c178",
    "version": "ddx/route@9b646825fcb7"
  },
  "appropriateness": {
    "file": "app/api/appropriateness/route.ts",
    "blob": "5a6a215b121885d961a2691279413e1f6fcc8821",
    "version": "appropriateness/route@5a6a215b1218"
  },
  "pathway": {
    "file": "app/api/pathway/skeleton/route.ts",
    "blob": "aacb8a1e3a65d254034115fb12b216ca9af0c154",
    "version": "pathway/route@aacb8a1e3a65"
  },
  "doc_audit": {
    "file": "app/api/doc-audit/analyze/route.ts",
    "blob": "8a0fe78c57e12a17ca89a155774b1834a650ed5e",
    "version": "doc_audit/route@8a0fe78c57e1"
  }
} as const;

/** The baked version for an engine with no version constant, or null when it has one. */
export function bakedEngineVersion(engine: string): string | null {
  return GENERATED_ROUTE_VERSIONS[engine]?.version ?? null;
}
