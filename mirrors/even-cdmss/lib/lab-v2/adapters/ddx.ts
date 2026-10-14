/**
 * lib/lab-v2/adapters/ddx.ts — the `ddx` engine behind the fence (§17.3, decision 37).
 *
 * The route file is UNTOUCHED. `POST` is imported and called in process with a synthetic
 * NextRequest inside `withLabExecution`; see lib/lab-v2/adapters/types.ts for the request
 * construction, the edges, and why this is never a network self-fetch.
 *
 * Stages (decision 35/35a): investigations_parse (conditional), clinical_state_normalise (conditional), ddx_draft, ddx_critique, ddx_revision
 *
 * DECISION 39 — the summary below is derived from the events this route actually emits, read out
 * of its own `emit(...)` call sites, so no field is null on a successful run. `engine_version` is
 * the route file's git blob hash: this engine declares no version constant of its own.
 */
import { POST } from '@/app/api/ddx/route';
import {
  assessStream, eventOfType, eventTypes, makeRouteAdapter,
  type Adapter, type RouteAdapterDeps, type RouteRead,
} from './types';

/**
 * DECISION 39 — the inline summary for this engine, exported so it can be asserted on a
 * fixture read. Every field is derived from an event the route actually emits.
 */
export function summariseDdx(read: RouteRead): Record<string, unknown> {
  const sources = eventOfType(read, 'sources');
  const done = eventOfType(read, 'done');
  return {
    event_types: eventTypes(read),
    events: read.events.length,
    sources: Array.isArray(sources?.items) ? (sources!.items as unknown[]).length : 0,
    critiqued: eventTypes(read).includes('critique'),
    ms: typeof done?.ms === 'number' ? done.ms : null,
  };
}

export function makeDdxAdapter(deps: RouteAdapterDeps = {}): Adapter {
  return makeRouteAdapter({
    engine: 'ddx',
    path: '/api/ddx',
    file: 'app/api/ddx/route.ts',
    post: POST,
    summarise: summariseDdx,
    assess: assessStream,
  }, deps);
}
