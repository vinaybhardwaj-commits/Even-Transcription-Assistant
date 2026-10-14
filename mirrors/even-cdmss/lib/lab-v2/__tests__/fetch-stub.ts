/**
 * Transport stub for the params-fidelity suite (LAB-MCP-V2 decision 23).
 *
 * ⚠️ THIS MODULE MUST BE IMPORTED BEFORE lib/trace.ts, AND THAT IS WHY IT IS A SEPARATE FILE.
 * `GCP_PROJECT` and `GCP_LOCATION` are module-level consts in lib/llm.ts, read at import.
 * `geminiConfigured()` is `Boolean(GCP_PROJECT && process.env.GCP_SA_KEY)`, so a project set
 * after that import leaves the Vertex tier permanently unavailable and the cloud ladder falls
 * through to Ollama — which is how an earlier draft of the fidelity test managed to "capture" a
 * body it had never actually sent.
 *
 * ⚠️ WHY TWO SEAMS. The two hops of a Vertex call use two different HTTP clients:
 *
 *   · the OAuth token mint in lib/gcp-auth.ts calls the global `fetch` directly, so replacing
 *     `globalThis.fetch` intercepts it;
 *   · the completion goes through the OpenAI SDK, which on Node bundles node-fetch@2 and
 *     therefore never touches `globalThis.fetch` at all. node-fetch resolves its transport as
 *     `(options.protocol === 'https:' ? https : http).request` AT CALL TIME, so patching
 *     `https.request` is the seam that reaches it — and it is the lowest one available without
 *     editing lib/llm.ts, which this round's contract does not permit.
 *
 * Both seams feed ONE handler, so a test sees every outbound request through a single door and
 * nothing can reach the network: the default handler throws.
 */
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export type FetchHandler = (url: string, init?: { body?: unknown }) => Promise<Response>;

let handler: FetchHandler = async (url) => {
  throw new Error(`fetch-stub: no handler installed — a test tried to reach ${url}`);
};

/** Swap the active handler and return the previous one, so a test can restore it. */
export function setFetchHandler(next: FetchHandler): FetchHandler {
  const previous = handler;
  handler = next;
  return previous;
}

// ── seam 1: the global fetch (lib/gcp-auth.ts's token mint) ──────────────────────────
globalThis.fetch = ((input: unknown, init?: { body?: unknown }) =>
  handler(String((input as { url?: string })?.url ?? input), init)) as typeof globalThis.fetch;

// ── seam 2: node-fetch's transport (the OpenAI SDK's completion call) ────────────────
interface NodeRequestOptions { protocol?: string; hostname?: string; host?: string; path?: string }

/**
 * A minimal stand-in for ClientRequest: enough of the surface node-fetch actually uses.
 * It buffers whatever is written, hands the body to the handler on `end()`, and emits the
 * `response` event node-fetch listens for with a readable it can pipe.
 */
function fakeRequest(options: NodeRequestOptions) {
  const chunks: Buffer[] = [];
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const url = `${options.protocol ?? 'https:'}//${options.hostname ?? options.host ?? 'unknown'}${options.path ?? ''}`;

  req.write = (chunk: unknown) => { if (chunk) chunks.push(Buffer.from(chunk as Uint8Array)); return true; };
  req.end = (chunk?: unknown) => {
    if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk as Uint8Array));
    const body = Buffer.concat(chunks).toString('utf8');
    // Async on purpose: node-fetch attaches its listeners synchronously after `send()`
    // returns and before it writes the body, so emitting on a later tick is always safe.
    void handler(url, { body }).then(async (response) => {
      const res = new PassThrough() as PassThrough & Record<string, unknown>;
      res.statusCode = response.status;
      res.headers = Object.fromEntries(response.headers.entries());
      req.emit('response', res);
      res.end(await response.text());
    }, (err) => req.emit('error', err));
    return req;
  };
  // No-ops node-fetch calls on the request object.
  req.setTimeout = () => req;
  req.setNoDelay = () => req;
  req.setSocketKeepAlive = () => req;
  req.flushHeaders = () => req;
  req.abort = () => {};
  req.destroy = () => {};
  return req;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const patch = (...args: any[]) => fakeRequest((args[0] ?? {}) as NodeRequestOptions);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(https as any).request = patch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(http as any).request = patch;

process.env.GCP_PROJECT = 'lab-v2-test-project';
process.env.GCP_LOCATION = 'global';
