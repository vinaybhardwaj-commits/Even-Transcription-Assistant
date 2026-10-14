/**
 * lib/lab-v2/adapters/ask.ts — the `ask` engine behind the fence (§17.3, decision 37).
 *
 * The route file is UNTOUCHED. `POST` is imported and called in process with a synthetic
 * NextRequest inside `withLabExecution`; see lib/lab-v2/adapters/types.ts for the request
 * construction, the edges, and why this is never a network self-fetch.
 *
 * Stages (decision 35/35a): investigations_parse (conditional), draft, critique, revision, answer
 *
 * DECISION 39 — the summary below is derived from the events this route actually emits, read out
 * of its own `emit(...)` call sites, so no field is null on a successful run. `engine_version` is
 * the route file's git blob hash: this engine declares no version constant of its own.
 */
import { POST } from '@/app/api/ask/route';
import {
  assessStream, eventOfType, eventTypes, makeRouteAdapter,
  type Adapter, type RouteAdapterDeps, type RouteRead,
} from './types';

/**
 * DECISION 39 — the inline summary for this engine, exported so it can be asserted on a
 * fixture read. Every field is derived from an event the route actually emits.
 */
export function summariseAsk(read: RouteRead): Record<string, unknown> {
  const sources = eventOfType(read, 'sources');
  const done = eventOfType(read, 'done');
  return {
    event_types: eventTypes(read),
    events: read.events.length,
    sources: Array.isArray(sources?.items) ? (sources!.items as unknown[]).length : 0,
    tokens: eventTypes(read).filter((t) => t === 'token').length,
    draft_complete: eventTypes(read).includes('draft_complete'),
    ms: typeof done?.ms === 'number' ? done.ms : null,
  };
}

export function makeAskAdapter(deps: RouteAdapterDeps = {}): Adapter {
  return makeRouteAdapter({
    engine: 'ask',
    path: '/api/ask',
    file: 'app/api/ask/route.ts',
    post: POST,
    summarise: summariseAsk,
    assess: assessStream,
  }, deps);
}
