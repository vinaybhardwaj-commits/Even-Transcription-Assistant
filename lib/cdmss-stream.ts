// NDJSON progress streaming helper
// Each line = one JSON event ending with '\n':
//   { type: 'progress', stage, msg, ms? }
//   { type: 'sources',  items }
//   { type: 'token',    content }            (streaming endpoints only)
//   { type: 'result',   data }                (non-streaming endpoints)
//   { type: 'done',     ms }
//   { type: 'error',    message }

export type Stage = 'expanding' | 'retrieving' | 'reranking' | 'generating' | 'parsing' | 'persisting' | 'done';

export type ProgressEvent =
  | { type: 'progress'; stage: Stage; msg: string; ms?: number }
  | { type: 'sources'; items: unknown[] }
  | { type: 'token'; content: string }
  | { type: 'result'; data: unknown }
  | { type: 'done'; ms: number }
  | { type: 'error'; message: string };

export function makeNdjsonStream() {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) { controllerRef = ctrl; },
  });
  function emit(ev: ProgressEvent) {
    if (!controllerRef) return;
    controllerRef.enqueue(encoder.encode(JSON.stringify(ev) + '\n'));
  }
  function close() {
    if (!controllerRef) return;
    controllerRef.close();
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
