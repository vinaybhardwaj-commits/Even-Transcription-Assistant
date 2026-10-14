/**
 * lib/lab-v2/adapters/doc-audit.ts — the `doc_audit` engine behind the fence (§17.3, decision 37).
 *
 * The route file is UNTOUCHED. `POST` is imported and called in process with a synthetic
 * NextRequest inside `withLabExecution`; see lib/lab-v2/adapters/types.ts for the request
 * construction, the edges, and why this is never a network self-fetch.
 *
 * Stages (decision 35/35a): doc_audit_analyze, doc_audit_cite_gate, doc_audit_prognosis, doc_audit_prognosis_critique, doc_audit_prognosis_revise
 *
 * DECISION 39 — the summary below is derived from the events this route actually emits, read out
 * of its own `emit(...)` call sites, so no field is null on a successful run. `engine_version` is
 * the route file's git blob hash: this engine declares no version constant of its own.
 */
import { POST } from '@/app/api/doc-audit/analyze/route';
import {
  assessStream, eventOfType, eventTypes, makeRouteAdapter,
  type Adapter, type RouteAdapterDeps, type RouteRead,
} from './types';

/**
 * DECISION 39 — the inline summary for this engine, exported so it can be asserted on a
 * fixture read. Every field is derived from an event the route actually emits.
 */
export function summariseDocAudit(read: RouteRead): Record<string, unknown> {
  const result = eventOfType(read, 'result');
  const data = (result?.data ?? {}) as { ok?: unknown; report?: unknown };
  const done = eventOfType(read, 'done');
  return {
    event_types: eventTypes(read),
    events: read.events.length,
    ok: data.ok === true,
    has_report: data.report != null,
    ms: typeof done?.ms === 'number' ? done.ms : null,
  };
}

export function makeDocAuditAdapter(deps: RouteAdapterDeps = {}): Adapter {
  return makeRouteAdapter({
    engine: 'doc_audit',
    path: '/api/doc-audit/analyze',
    file: 'app/api/doc-audit/analyze/route.ts',
    post: POST,
    summarise: summariseDocAudit,
    assess: assessStream,
  }, deps);
}
