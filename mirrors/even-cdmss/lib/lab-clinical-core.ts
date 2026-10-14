/**
 * lib/lab-clinical-core.ts — PURE reducers for the Lab MCP clinical-route probes
 * (lab_ddx / lab_ask). No I/O, no imports → unit-testable under --experimental-strip-types.
 *
 * The DDx and Ask production routes stream NDJSON events. These reducers fold the raw
 * event list into a stored lab result + a compact summary, so the tools test the REAL
 * pipeline output shape without duplicating pipeline logic.
 */

export type NdjsonEvent = Record<string, unknown>;

/** Split a raw NDJSON body into parsed event objects (tolerant of blank/partial lines). */
export function parseNdjson(raw: string): NdjsonEvent[] {
  const out: NdjsonEvent[] = [];
  for (const line of (raw || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a partial/garbled line */ }
  }
  return out;
}

export interface DdxDx { diagnosis?: string; likelihood?: string }
export interface DdxProbe {
  ok: boolean;
  error: string | null;
  summary: string;
  cannot_miss: string[];
  most_likely: string[];
  other: string[];
  n_sources: number;
  n_plos: number;
  critique_severity: string | null;
  critique_issue_count: number | null;
  /** FALSE when the critique leg did not complete — `critique_issue_count: 0` then means the draft
   *  is UNAUDITED, not clean. Null on a stream that emitted no critique event at all. */
  critic_ran: boolean | null;
  demographic_removed: string[];
  result: Record<string, unknown> | null;
  /** The route's trace id, off the terminal `done` event (F11 DEC-2). Null on an older route or a
   *  stream that never reached `done` — the attribution check treats null as "no evidence". */
  trace_id: string | null;
}

const dxNames = (arr: unknown): string[] =>
  Array.isArray(arr) ? arr.map((d) => String((d as DdxDx)?.diagnosis || '').trim()).filter(Boolean) : [];

/** Fold the DDx NDJSON stream into a stored result + summary. */
export function reduceDdxEvents(events: NdjsonEvent[]): DdxProbe {
  const base: DdxProbe = {
    ok: false, error: null, summary: '', cannot_miss: [], most_likely: [], other: [],
    n_sources: 0, n_plos: 0, critique_severity: null, critique_issue_count: null,
    demographic_removed: [], result: null, trace_id: null, critic_ran: null,
  };
  let sawDone = false;
  for (const e of events) {
    switch (e.type) {
      case 'sources':
        base.n_sources = Array.isArray(e.items) ? e.items.length : 0;
        base.n_plos = Array.isArray(e.plos) ? (e.plos as unknown[]).length : 0;
        break;
      case 'critique':
        base.critique_severity = typeof e.severity === 'string' ? e.severity : base.critique_severity;
        base.critique_issue_count = typeof e.issue_count === 'number' ? e.issue_count : base.critique_issue_count;
        if (typeof e.critic_ran === 'boolean') base.critic_ran = e.critic_ran;
        break;
      case 'result': {
        const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>;
        base.result = d;
        base.summary = String(d.summary || '');
        base.cannot_miss = dxNames(d.cannot_miss);
        base.most_likely = dxNames(d.most_likely);
        base.other = dxNames(d.other);
        break;
      }
      case 'error':
        base.error = String(e.message || 'error');
        break;
      case 'done':
        sawDone = true;
        if (typeof e.trace_id === 'string' && e.trace_id) base.trace_id = e.trace_id;
        break;
      default: break;
    }
  }
  base.ok = base.error == null && (sawDone || base.result != null);
  return base;
}

export interface AskProbe {
  ok: boolean;
  error: string | null;
  answer: string;
  answer_chars: number;
  n_sources: number;
  n_plos: number;
  revised: boolean;
  critique_issue_count: number | null;
  /** FALSE when the critique leg did not complete — `critique_issue_count: 0` then means the draft
   *  is UNAUDITED, not clean. Null on a stream that emitted no critique event at all. */
  critic_ran: boolean | null;
  citation_ids: number[];
  uncited: boolean;         // answer text present but no [n] citations at all → cite-or-label canary
  result: Record<string, unknown> | null;
  /** The route's trace id, off the terminal `done` event (F11 DEC-2). Null on an older route or a
   *  stream that never reached `done` — the attribution check treats null as "no evidence". */
  trace_id: string | null;
}

/** Distinct bracketed citation ids like [1] [P2] → numeric ids only (PLOS Pn tracked separately). */
export function extractCitationIds(answer: string): number[] {
  const ids = new Set<number>();
  for (const m of (answer || '').matchAll(/\[(\d{1,3})\]/g)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b);
}

/** Fold the Ask NDJSON stream (token deltas + events) into a stored result + summary. */
export function reduceAskEvents(events: NdjsonEvent[]): AskProbe {
  let answer = '';
  let n_sources = 0, n_plos = 0;
  let revised = false;
  let critique_issue_count: number | null = null;
  let critic_ran: boolean | null = null;
  let error: string | null = null;
  let sawDone = false;
  let traceId: string | null = null;
  // The final answer is the LAST contiguous run of token deltas (a revised answer
  // supersedes the draft). Reset the buffer when a revision run starts.
  for (const e of events) {
    switch (e.type) {
      case 'token':
        answer += String(e.content || '');
        break;
      case 'draft_superseded':
        revised = true;
        answer = '';                 // the revised token run follows — drop the superseded draft
        break;
      case 'sources':
        n_sources = Array.isArray(e.items) ? e.items.length : 0;
        n_plos = Array.isArray(e.plos) ? (e.plos as unknown[]).length : 0;
        break;
      case 'critique':
      case 'audit':
        if (typeof e.issue_count === 'number') critique_issue_count = e.issue_count as number;
        if (typeof e.critic_ran === 'boolean') critic_ran = e.critic_ran as boolean;
        break;
      case 'error':
        error = String(e.message || 'error');
        break;
      case 'done':
        sawDone = true;
        if (typeof e.trace_id === 'string' && e.trace_id) traceId = e.trace_id;
        break;
      default: break;
    }
  }
  answer = answer.trim();
  const citation_ids = extractCitationIds(answer);
  return {
    ok: error == null && (sawDone || answer.length > 0),
    error,
    answer,
    answer_chars: answer.length,
    n_sources, n_plos, revised,
    critique_issue_count,
    critic_ran,
    citation_ids,
    uncited: answer.length > 40 && citation_ids.length === 0,
    result: { answer, n_sources, n_plos, revised, citation_ids },
    trace_id: traceId,
  };
}

export interface AppropriatenessProbe {
  ok: boolean;
  error: string | null;
  n_flags: number;
  flag_statements: string[];         // the CW statements that fired — the over-flag surface
  considered: number;
  empty: boolean;
  value_present: boolean;            // did the LLM value pass return an analysis?
  n_value_sources: number;
  result: Record<string, unknown> | null;
}

/** Fold the /api/appropriateness NDJSON stream (order-check LVC) into a stored result. */
export function reduceAppropriatenessEvents(events: NdjsonEvent[]): AppropriatenessProbe {
  const base: AppropriatenessProbe = {
    ok: false, error: null, n_flags: 0, flag_statements: [], considered: 0,
    empty: false, value_present: false, n_value_sources: 0, result: null,
  };
  let sawDone = false;
  for (const e of events) {
    if (e.type === 'error') base.error = String(e.message || 'error');
    else if (e.type === 'done') sawDone = true;
    else if (e.type === 'result') {
      const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>;
      base.result = d;
      const flags = Array.isArray(d.flags) ? d.flags as Record<string, unknown>[] : [];
      base.n_flags = flags.length;
      base.flag_statements = flags.map((f) => String(f.statement || f.id || '').trim()).filter(Boolean);
      base.considered = Number(d.considered || 0);
      base.empty = d.empty === true;
      base.value_present = d.valueAnalysis != null;
      base.n_value_sources = Array.isArray(d.valueSources) ? (d.valueSources as unknown[]).length : 0;
    }
  }
  base.ok = base.error == null && (sawDone || base.result != null);
  return base;
}

export interface DocAuditProbe {
  ok: boolean;
  error: string | null;
  report_ok: boolean;
  headline: number | null;
  band: string | null;
  n_findings: number | null;
  result: Record<string, unknown> | null;
}

/** Fold the /api/doc-audit/analyze NDJSON stream (case audit, text leg) into a stored result. */
export function reduceDocAuditEvents(events: NdjsonEvent[]): DocAuditProbe {
  const base: DocAuditProbe = {
    ok: false, error: null, report_ok: false, headline: null, band: null, n_findings: null, result: null,
  };
  let sawDone = false;
  for (const e of events) {
    if (e.type === 'error') base.error = String(e.message || 'error');
    else if (e.type === 'done') sawDone = true;
    else if (e.type === 'result') {
      const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>;
      base.result = d;
      base.report_ok = d.ok === true && d.report != null;
      const report = (d.report && typeof d.report === 'object' ? d.report : {}) as Record<string, unknown>;
      const sc = (report.scorecard && typeof report.scorecard === 'object' ? report.scorecard : {}) as Record<string, unknown>;
      if (typeof sc.headline === 'number') base.headline = sc.headline as number;
      if (typeof sc.band === 'string') base.band = sc.band as string;
      const findings = Array.isArray(report.findings) ? report.findings : null;
      base.n_findings = findings ? findings.length : null;
      if (d.error) base.error = base.error ?? String(d.error);
    }
  }
  base.ok = base.error == null && (sawDone || base.result != null);
  return base;
}

/** Resolve the base URL for a self-fetch to the app's own routes. */
export function labSelfBaseUrl(env: Record<string, string | undefined>): string {
  const explicit = (env.LAB_SELF_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = (env.VERCEL_URL || '').trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return 'http://localhost:3000';
}
