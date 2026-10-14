// NDJSON progress streaming helper
// Each line = one JSON event ending with '\n':
//   { type: 'progress', stage, msg, ms? }
//   { type: 'sources',  items }
//   { type: 'token',    content }            (streaming endpoints only)
//   { type: 'result',   data }                (non-streaming endpoints)
//   { type: 'done',     ms, trace_id? }
//   { type: 'error',    message }

export type Stage = 'expanding' | 'variants' | 'retrieving' | 'reranking' | 'fusing' | 'generating' | 'drafting' | 'reviewing' | 'revising' | 'finalizing' | 'parsing' | 'persisting' | 'done'
  // CCB (care-brief) stages — the episode bundler + de-identified report read + grounding.
  | 'fetching' | 'reading' | 'grounding';

export type ProgressEvent =
  | { type: 'progress'; stage: Stage; msg: string; ms?: number }
  | { type: 'sources'; items: unknown[]; plos?: unknown[] }
  // critic_ran (7 Aug 2026): FALSE when the critique leg failed — transport error, truncated
  // response, unparseable JSON. Without it `issue_count: 0` means both "read and passed" and
  // "never ran", and a live Bedrock run produced the second while looking like the first.
  // Optional, so every existing emitter and consumer is unchanged.
  | { type: 'critique'; severity: string; issue_count: number; details: Record<string, unknown>; critic_ran?: boolean }
  | { type: 'draft_complete'; chars: number }
  | { type: 'draft_superseded'; reason: string }
  | { type: 'token'; content: string }
  | { type: 'result'; data: unknown }
  // trace_id (F11 DEC-2, 7 Aug 2026): OPTIONAL, and only the two F11-wired routes set it. It lets
  // a lab probe settle its stored attribution against what the TRACE says served the run, instead
  // of against what it asked for — the difference between a fact and an intention. Optional keeps
  // every other emitter and consumer byte-identical; unknown fields were already ignored.
  | { type: 'done'; ms: number; trace_id?: string }
  | { type: 'pubchem_facts'; data: unknown }                                              // v1.9
  | { type: 'class_overlap'; pairs: unknown[] }                                            // v1.9
  | { type: 'error'; message: string };

export function makeNdjsonStream() {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) { controllerRef = ctrl; },
  });
  function emit(ev: ProgressEvent) {
    if (!controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(JSON.stringify(ev) + '\n'));
    } catch {
      // v2.0.1 H1: enqueue throws TypeError when the stream is already closed
      // (e.g. a setInterval heartbeat callback fires AFTER close() was called,
      // or the client aborted the request mid-flight). Marking the controller
      // null prevents subsequent emits from retrying the same throw. logEvent
      // server-side trace is unaffected.
      controllerRef = null;
    }
  }
  function close() {
    if (!controllerRef) return;
    try { controllerRef.close(); } catch { /* already closed — harmless */ }
    controllerRef = null;
  }
  return { stream, emit, close };
}

export function ndjsonHeaders() {
  return new Headers({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}
