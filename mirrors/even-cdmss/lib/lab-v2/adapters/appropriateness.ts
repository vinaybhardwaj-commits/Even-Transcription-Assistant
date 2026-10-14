/**
 * lib/lab-v2/adapters/appropriateness.ts — the `appropriateness` engine behind the fence (§17.3, decision 37).
 *
 * The route file is UNTOUCHED. `POST` is imported and called in process with a synthetic
 * NextRequest inside `withLabExecution`; see lib/lab-v2/adapters/types.ts for the request
 * construction, the edges, and why this is never a network self-fetch.
 *
 * Stages (decision 35/35a): lvc_value, lvc_value_critique, clinical_state_normalise (conditional)
 *
 * DECISION 39 — the summary below is derived from the events this route actually emits, read out
 * of its own `emit(...)` call sites, so no field is null on a successful run. `engine_version` is
 * the route file's git blob hash: this engine declares no version constant of its own.
 */
import { POST } from '@/app/api/appropriateness/route';
import {
  assessStream, eventOfType, eventTypes, makeRouteAdapter,
  type Adapter, type RouteAdapterDeps, type RouteRead,
} from './types';

/**
 * DECISION 39 — the inline summary for this engine, exported so it can be asserted on a
 * fixture read. Every field is derived from an event the route actually emits.
 */
export function summariseAppropriateness(read: RouteRead): Record<string, unknown> {
  const done = eventOfType(read, 'done');
  return {
    event_types: eventTypes(read),
    events: read.events.length,
    progress_stages: eventTypes(read).filter((t) => t === 'progress').length,
    ms: typeof done?.ms === 'number' ? done.ms : null,
  };
}

export function makeAppropriatenessAdapter(deps: RouteAdapterDeps = {}): Adapter {
  return makeRouteAdapter({
    engine: 'appropriateness',
    path: '/api/appropriateness',
    file: 'app/api/appropriateness/route.ts',
    post: POST,
    summarise: summariseAppropriateness,
    assess: assessStream,
  }, deps);
}
