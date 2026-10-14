/**
 * lib/lab-v2/adapters/pathway.ts — the `pathway` (skeleton) engine behind the fence
 * (§17.3, decision 37).
 *
 * The route file is UNTOUCHED. `POST` is imported and called in process with a synthetic
 * NextRequest inside `withLabExecution`; see lib/lab-v2/adapters/types.ts for the request
 * construction, the edges, and why this is never a network self-fetch.
 *
 * ⚠️ THE ONE OF THE FIVE THAT DOES NOT STREAM. `/api/pathway/skeleton` returns a plain
 * `NextResponse.json({ ok, skeleton, traceId })`, so there are no NDJSON events and
 * `assessStream` would find no `done` marker. It is assessed on its own `ok` flag instead.
 *
 * Stages (decision 35/35a): pathway_skeleton, clinical_state_normalise (conditional)
 */
import { POST } from '@/app/api/pathway/skeleton/route';
import { makeRouteAdapter, type Adapter, type RouteAdapterDeps, type RouteRead } from './types';

/**
 * DECISION 39 — the inline summary for this engine, exported so it can be asserted on a
 * fixture read. Every field is derived from an event the route actually emits.
 */
export function summarisePathway(read: RouteRead): Record<string, unknown> {
  const j = (read.json ?? {}) as { ok?: unknown; skeleton?: unknown };
  const skeleton = j.skeleton as { steps?: unknown[] } | undefined;
  return { ok: j.ok === true, steps: Array.isArray(skeleton?.steps) ? skeleton!.steps!.length : null };
}

export function makePathwayAdapter(deps: RouteAdapterDeps = {}): Adapter {
  return makeRouteAdapter({
    engine: 'pathway',
    path: '/api/pathway/skeleton',
    file: 'app/api/pathway/skeleton/route.ts',
    post: POST,
    summarise: summarisePathway,
    assess: (read: RouteRead) => ((read.json as { ok?: unknown } | null)?.ok === true ? 'assessed' : 'unassessable'),
  }, deps);
}
