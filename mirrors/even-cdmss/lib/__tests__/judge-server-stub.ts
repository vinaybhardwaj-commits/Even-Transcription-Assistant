/**
 * lib/__tests__/judge-server-stub.ts — a local HTTP server standing in for the rerank judge, so
 * `rerankJudge` runs for real against a real socket.
 *
 * ⚠️ NOT A TEST FILE, AND DELIBERATELY NOT NAMED `.test.ts`. The suite glob is
 * `lib/**\/__tests__/*.test.ts`; `telemetry-db-stub.ts` is named the same way for the same reason.
 *
 * ── WHY THIS WORKS EVEN WITH `installDbStub` INSTALLED. The whole pass rests on it. ─────────────
 * `telemetry-db-stub.ts:103` replaces `globalThis.fetch`. The OpenAI SDK does not use it.
 * `node_modules/openai/core.js:144` is `this.fetch = overriddenFetch ?? index_1.fetch`, bound at
 * client CONSTRUCTION (`lib/llm.ts:41`), and the resolved shim is node-fetch@2, which uses the
 * `http` module. Verified in-process, before and after a stub-style replacement:
 *
 *     require('openai/_shims/index.js').fetch === globalThis.fetch   // false, both times
 *
 * So a judge request bypasses the database stub entirely and reaches a real socket on 127.0.0.1.
 * Nothing here ever opens a socket to any other host.
 *
 * ── HOW ONE BATCH IS TOLD FROM ANOTHER: ONLY BY PASSAGE TEXT. ──────────────────────────────────
 * Model, system prompt, temperature, max_tokens, options, keep_alive and the `QUESTION:` prefix are
 * byte-identical across batches, and `[${idx}]` at `lib/rerank.ts:431` is the LOCAL slice index, so
 * it restarts at `[0]` every batch and carries no batch identity.
 *
 * Every fixture passage therefore begins with a unique marker token, and this server scores each
 * passage by the marker it finds inside that passage's own `[idx]` segment. The reply's keys are the
 * local indices the caller used, so the same marker scores the same wherever it lands. Two
 * constraints on a fixture, from `lib/rerank.ts:430` and `:59`: the text is truncated to
 * `MAX_SNIPPET_CHARS = 600` FIRST and only then whitespace-collapsed, so a marker must sit inside
 * the first 600 characters and must survive `.replace(/\s+/g, ' ')`. A leading single-word token
 * satisfies both.
 *
 * ── WHAT THE SERVER RETURNS ────────────────────────────────────────────────────────────────────
 * HTTP 200, `content-type: application/json`. Only three fields are read, at `lib/rerank.ts:461-464`:
 * `choices[0].message.content`, `usage.prompt_tokens`, `usage.completion_tokens`. `content` is the
 * scoring object as a STRING. `usage` is omitted by default: both `typeof` guards then go false, the
 * two token counts become null, and the batch still records `outcome: 'success'` — nothing throws.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import net from 'node:net';

/**
 * Which of the three things production asks this server for.
 *
 * ⚠️ THREE CALLS REACH ONE CLIENT. `retrieve` at the production shape makes all of them through the
 * SAME OpenAI client (`lib/llm.ts:41`): the expansion chat (`lib/retrieve.ts:408` → `lib/expand.ts`),
 * the embedding (`:413` → `lib/llm.ts:600`), and the judge chats (`:589` → `lib/rerank.ts:450`).
 * Serving them all from one server is what lets case C run the production path unescaped.
 */
export type JudgeRequestKind = 'judge' | 'expansion' | 'embedding';

/** One request, as the server received it. */
export interface JudgeRequest {
  kind: JudgeRequestKind;
  url: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  /** The markers present in this request, in local `[idx]` order. Index i is local index i. */
  markers: string[];
  /** Embedding requests only: the exact text handed to `embedQuery`. */
  input?: string;
}

/**
 * ONE WIRE-LEVEL OBSERVATION (addendum v15 §5.3). Recorded by the opt-in request recorder, which is
 * a SEPARATE store from `requests` (§5.1): the parsed path discards the raw body the moment it
 * `JSON.parse`s it, so a wire recorder cannot be built from `JudgeRequest` at all, and `JudgeRequest`
 * gains no field (§5.11).
 *
 * `seq` is assigned at ACCEPTANCE, before the body has arrived (§5.4). `body` is the exact
 * entity-body bytes as a Buffer. `overflowed` is true when the body exceeded the 1 MiB limit, in
 * which case `body` is zero-length and the bytes were never buffered (§5.5).
 *
 * No headers. No authorization values. No timestamps. Nothing derived.
 */
export interface JudgeObservation {
  seq: number;
  /**
   * SOCKET IDENTITY (addendum v18 §4.2, amending v15 §5.3): the one socket-identity field the
   * amendment permits, recorded only while socket recording is enabled — which is the only time an
   * observation exists at all. Identities come from a module-level `WeakMap<net.Socket, number>`
   * and are assigned at ACCEPTANCE, beside `seq`. Two observations with different `seq` and the
   * SAME `socketId` were carried by the same undestroyed socket — reuse proven, not inferred.
   * `JudgeRequest` gains no field, so v15 §5.11 is untouched.
   */
  socketId: number;
  method: string;
  path: string;
  body: Buffer;
  overflowed: boolean;
}

/** The exact recorder limit (addendum v15 §5.5). 1048576 is accepted; 1048577 is rejected with 413. */
export const RECORDER_BODY_LIMIT_BYTES = 1048576;

export interface JudgeServer {
  readonly port: number;
  /** No `/v1` suffix: `lib/llm.ts:39` appends it. */
  readonly url: string;
  /** Every request body received, in arrival order, whatever its kind. */
  readonly requests: JudgeRequest[];
  /** marker → score on the judge's own 0–10 scale. */
  setScores(scores: Record<string, number>): void;
  /**
   * Replace the `content` string wholesale, for the malformed-response attacks. The callback gets
   * the markers of that request in local index order. `null` restores normal scoring.
   */
  setRawContent(fn: ((markers: string[]) => string) | null): void;
  /** Include a `usage` block. Off by default — only turn it on to assert token counts. */
  setIncludeUsage(on: boolean): void;
  /** The paragraph the expansion chat returns. Fixed, so `expandedQuery` is deterministic. */
  setExpansion(text: string): void;
  /**
   * Override the embedding vector, for the attack that returns a different vector on the second
   * call. `null` restores the deterministic per-input vector.
   */
  setEmbeddingOverride(fn: ((input: string, callIndex: number) => number[]) | null): void;
  /**
   * Send every chat to the judge responder, ignoring the system prompt. This is the "route the
   * expansion to the judge by mistake" attack, kept here so it can be run without editing the file.
   */
  setChatDiscrimination(on: boolean): void;
  /**
   * THE REQUEST RECORDER, opt-in (addendum v15 §5.2). Off by default; while off, no observation is
   * stored and the sequence counter does not advance. In the style of the six `set*` mutators above.
   */
  setRecording(on: boolean): void;
  /**
   * A defensive copy of every observation so far (§5.7): a new array of new objects, each with a
   * copied Buffer. Throws while any request is in flight (§5.6), naming the in-flight count.
   */
  snapshot(): JudgeObservation[];
  /**
   * Clear observations and return the sequence counter to 0 (§5.4, §5.10). Throws while any request
   * is in flight (§5.6). Leaves scores, raw content, usage inclusion, expansion text, embedding
   * override and chat discrimination UNCHANGED.
   */
  resetObservations(): void;
  /**
   * The in-flight count right now (§5.6). Read-only. A test that has seen its client-side response
   * end may still find this at 1 for a tick: the client's `end` event and the server's `finish`
   * event are DIFFERENT MOMENTS, and the counter decrements on the server's. `settled()` waits.
   */
  inFlight(): number;
  /** Resolves once the in-flight count is 0. Never throws; polls the counter, so no test sleeps. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

/**
 * COMPARISON BY STABLE MARKER IDENTITY (addendum v15 §5.9). Concurrent judge batches are otherwise
 * indistinguishable — model, system prompt, temperature, `max_tokens`, options, `keep_alive` and the
 * `QUESTION:` prefix are byte-identical, and the local slice index restarts at `[0]` in every batch —
 * so arrival order is an accident of which socket completed first. Two runs match when the multiset
 * of marker-keyed bodies matches, whatever order the sockets completed in.
 *
 * `markers` is the set of marker tokens to look for. Each observation is keyed by the SORTED subset
 * of markers found in its body; the value is the body bytes. Returns a Map from that key to the list
 * of bodies seen under it, so multiplicity survives (§5.8) — two identical requests are two entries.
 */
export function groupByMarkerSet(
  observations: readonly JudgeObservation[],
  markers: readonly string[],
): Map<string, Buffer[]> {
  const out = new Map<string, Buffer[]>();
  for (const o of observations) {
    const text = o.body.toString('utf8');
    const key = markers.filter((m) => text.includes(m)).sort().join('|');
    const list = out.get(key) ?? [];
    list.push(o.body);
    out.set(key, list);
  }
  return out;
}

/**
 * Do two observation lists carry the same multiset of marker-keyed observations? Order-independent
 * (§5.9), multiplicity-preserving (§5.8), byte-exact on method, path and entity body. Returns null
 * when they match and a one-line reason when they do not, so an assertion can print WHICH key
 * differed.
 *
 * ⚠️ THE GROUP VALUE IS THE WHOLE TUPLE (addendum v18 §3.2, review 29 finding 2). An earlier
 * version grouped BODIES by marker set and compared method and path separately, as a global sorted
 * multiset — so two observations could swap their method or path between marker groups and still
 * compare equal. The value under each marker-set key is now ONE Buffer, built as
 * `method` + `path` + a NUL byte + `body`, sorted within its group by `Buffer.compare`, so the
 * method-path-body association cannot dissolve. The separate method/path multiset is deleted.
 * `Buffer.compare`, not a string comparison on UTF-8: bodies may hold lone surrogates and a string
 * compare is not byte-exact. The tuple is built HERE, inside the comparator — `groupByMarkerSet`
 * is unchanged, because two existing tests assert on its output as body bytes.
 *
 * ⚠️ THIS IS THE WHOLE OF J1's CLAIM (v15 §3.1): byte-identical HTTP method, path, and entity-body
 * bytes received by the loopback server. It says nothing about TCP framing, TLS or headers, and the
 * observation carries none of those to compare.
 */
export function sameWireObservations(
  a: readonly JudgeObservation[],
  b: readonly JudgeObservation[],
  markers: readonly string[],
): string | null {
  if (a.length !== b.length) return `count differs: ${a.length} vs ${b.length}`;
  // Key: the sorted subset of markers found in the body. Value: the method+path+NUL+body tuple.
  const group = (xs: readonly JudgeObservation[]): Map<string, Buffer[]> => {
    const out = new Map<string, Buffer[]>();
    for (const o of xs) {
      const text = o.body.toString('utf8');
      const key = markers.filter((mk) => text.includes(mk)).sort().join('|');
      const tuple = Buffer.concat([Buffer.from(o.method, 'utf8'), Buffer.from(o.path, 'utf8'), Buffer.from([0]), o.body]);
      const list = out.get(key) ?? [];
      list.push(tuple);
      out.set(key, list);
    }
    return out;
  };
  const ga = group(a);
  const gb = group(b);
  if (ga.size !== gb.size) return `marker-set count differs: ${ga.size} vs ${gb.size}`;
  for (const [key, tuplesA] of ga) {
    const tuplesB = gb.get(key);
    if (!tuplesB) return `marker set [${key}] present on one side only`;
    if (tuplesA.length !== tuplesB.length) return `marker set [${key}] multiplicity ${tuplesA.length} vs ${tuplesB.length}`;
    // Byte-exact tuple comparison, order-independent within the group.
    const sortedA = [...tuplesA].sort(Buffer.compare);
    const sortedB = [...tuplesB].sort(Buffer.compare);
    for (let i = 0; i < sortedA.length; i++) {
      if (!sortedA[i].equals(sortedB[i])) return `marker set [${key}] method/path/body tuple ${i} differs`;
    }
  }
  return null;
}

// ── The embedding vector ───────────────────────────────────────────────────────────────────────
// `EMBED_MODEL` is 'nomic-embed-text' (`lib/llm.ts:593`) and its column is the 768-dimension nomic
// space — `lib/jats-chunk.ts:9` calls it "the nomic-768 embedder", and `lib/llm.ts:604` /
// `lib/retrieve.ts:23` establish 1024 for the mxbai `embedding_v2` column by contrast. The schema
// itself declares `VECTOR` with no explicit dimension (`migrations/0019_even_ground.sql:19` says so
// in as many words), so 768 comes from the code's own statements rather than from a DDL constraint.
export const EMBED_DIMENSION = 768;

/**
 * A DETERMINISTIC vector for a given input string. Case C runs twice and both runs must produce
 * byte-identical results, so nothing here may be random: an FNV-1a hash of the input seeds a plain
 * LCG, and the same text always yields the same 768 floats.
 */
export function deterministicEmbedding(input: string, dim = EMBED_DIMENSION): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const out = new Array<number>(dim);
  let s = h || 1;
  for (let i = 0; i < dim; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;   // [-1, 1)
  }
  return out;
}

/**
 * ⚠️ BASE64 FLOAT32, NOT A JSON ARRAY, AND THIS IS NOT OPTIONAL.
 * `embedQuery` calls `llm.embeddings.create({ model, input })` with no `encoding_format`, and
 * `node_modules/openai/resources/embeddings.js:44-47` therefore sends `encoding_format: 'base64'`
 * and unconditionally decodes the reply through `Core.toFloat32Array`
 * (`node_modules/openai/core.js:968-973`), which does `Buffer.from(str, 'base64')`. A plain array
 * here would be decoded as if it were base64 and produce garbage.
 */
export function encodeEmbedding(vec: number[]): string {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf.toString('base64');
}

/** Split a user message into its `[idx] text` passage segments, in local index order. */
export function passageSegments(userMsg: string): Array<{ idx: number; text: string }> {
  const body = userMsg.split('PASSAGES:\n')[1] ?? '';
  const out: Array<{ idx: number; text: string }> = [];
  for (const m of body.matchAll(/\[(\d+)\]\s([\s\S]*?)(?=\n\n\[\d+\]\s|\n\nReturn the JSON|$)/g)) {
    out.push({ idx: Number(m[1]), text: m[2] });
  }
  return out;
}

// ── SOCKET IDENTITY (addendum v18 §4.2). Module-level, so an identity survives across requests on
// the same socket and across server instances in one process; a WeakMap, so a closed socket's entry
// can be collected. The counter only ever grows and an identity is never reused — UNLIKE `seq`,
// which `resetObservations` returns to 0 and whose values therefore recur across resets (v19 §3.5
// corrects the earlier "exactly like `seq`" analogy, which misstated this). Identity is a property
// of the SOCKET, not of the observation store, so no reset touches it.
// `resetObservations` does NOT touch it: identity is a property of the socket, not of the store,
// and v15 §5.10's list of what a reset clears is unchanged.
const socketIds = new WeakMap<net.Socket, number>();
let nextSocketId = 0;
function socketIdentityOf(s: net.Socket): number {
  let id = socketIds.get(s);
  if (id === undefined) { id = nextSocketId; nextSocketId += 1; socketIds.set(s, id); }
  return id;
}

/**
 * Start the server and apply the environment it implies.
 *
 * ⚠️ AWAIT THIS BEFORE THE DYNAMIC IMPORT OF `../rerank`. Three of these writes are read at MODULE
 * LOAD and cannot be fixed afterwards; the rest are read at run time and are set here anyway so one
 * call leaves the whole environment in a known state. The per-line reasons are in the comments.
 */
export async function startJudgeServer(initialScores: Record<string, number> = {}): Promise<JudgeServer> {
  const requests: JudgeRequest[] = [];
  let scores: Record<string, number> = { ...initialScores };
  let rawContent: ((markers: string[]) => string) | null = null;
  let includeUsage = false;
  let expansionText = 'expanded clinical paragraph, fixed so the expanded query is deterministic';
  let embeddingOverride: ((input: string, callIndex: number) => number[]) | null = null;
  let discriminateChat = true;
  let embeddingCalls = 0;

  // ── THE REQUEST RECORDER (addendum v15 §5). A SEPARATE store from `requests` (§5.1). ──────────
  let recording = false;                     // §5.2 off by default
  const observations: JudgeObservation[] = [];
  let nextSeq = 0;                           // §5.4 assigned at acceptance, monotonic, never reused
  let inFlight = 0;                          // §5.6 incremented at acceptance, decremented at response end

  const json = (res: ServerResponse, payload: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];

    // ── ACCEPTANCE (v15 §5.4, §5.6). The sequence number and the in-flight increment happen HERE,
    // before a single body byte has arrived. A request that arrives first is numbered first even if
    // it finishes last. Neither advances while recording is off (§5.2).
    //
    // ⚠️ THE RECORDING DECISION IS SAMPLED ONCE, AT ACCEPTANCE (addendum v19 §3.1). Acceptance used
    // to read `recording` and each later handler read its CURRENT value again, so a mid-flight
    // toggle could produce an observation with `seq: -1`, lose an accepted observation, or leak the
    // in-flight count. The decision is captured in this local, and the module-level flag is never
    // read again for a request already accepted: the `data` handler, the `end` handler, the `close`
    // handler and observation creation all use `recordThisRequest`.
    const recordThisRequest = recording;
    const seq = recordThisRequest ? nextSeq++ : -1;
    // The socket identity is assigned at ACCEPTANCE, beside `seq` (v18 §4.2). `req.socket` is live
    // at this hook point; the WeakMap hands the same identity back for every request the same
    // undestroyed socket carries.
    const socketId = recordThisRequest ? socketIdentityOf(req.socket) : -1;
    if (recordThisRequest) inFlight += 1;
    let received = 0;
    let overflowed = false;
    // The in-flight decrement is tied to the RESPONSE ending, for 200 and for 413 alike (§5.6).
    //
    // ⚠️ `close`, NOT `finish`. Probed on Node 22: when the client closes its socket right after
    // reading the response — which is what a non-keep-alive `http.request` does — the server-side
    // `ServerResponse` emits `close` and NEVER emits `finish`. A decrement hung on `finish` leaked
    // one in-flight count per such request, and `settled()` then waited forever. `close` fires on
    // every path: normal completion, 413, and an aborted client. It fires exactly once.
    if (recordThisRequest) res.once('close', () => { inFlight -= 1; });

    // ── HOOK POINT ONE: byte accounting in the `data` handler (v15 §5.1, §5.5). The limit must be
    // enforced before the body completes, so the running total lives here. Past the limit the
    // chunks are DROPPED — never buffered beyond it, never logged — and the flag is set. Bytes are
    // still consumed off the socket so the request reaches `end` normally.
    req.on('data', (c: Buffer) => {
      received += c.length;
      if (recordThisRequest && received > RECORDER_BODY_LIMIT_BYTES) { overflowed = true; chunks.length = 0; return; }
      if (!overflowed) chunks.push(c);
    });
    req.on('end', () => {
      // ── HOOK POINT TWO: observation capture in the `end` handler, at the expression that
      // concatenates the chunks (v15 §5.1). `req.method` and `req.url` are both in scope here, so
      // method, path and body come from one place. The Buffer stored is the concatenated bytes
      // themselves; `snapshot` copies them on the way out (§5.7).
      const raw = Buffer.concat(chunks);
      if (recordThisRequest) {
        observations.push({
          seq, socketId, method: String(req.method ?? ''), path: String(req.url ?? ''),
          body: overflowed ? Buffer.alloc(0) : raw, overflowed,
        });
      }
      // ── OVERFLOW (v15 §5.5): HTTP 413, an empty JSON object, response ended normally, socket
      // NOT destroyed. The parsed path below never runs for an overflowing request.
      if (overflowed) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      let body: {
        model?: string; temperature?: number; max_tokens?: number; input?: string;
        messages?: Array<{ role: string; content: string }>;
      } = {};
      try { body = JSON.parse(raw.toString('utf8')); } catch { /* recorded below as empty */ }
      const url = req.url ?? '';

      // ── EMBEDDINGS ──────────────────────────────────────────────────────────────────────────
      if (url.includes('/embeddings')) {
        const input = String(body.input ?? '');
        const vec = embeddingOverride ? embeddingOverride(input, embeddingCalls) : deterministicEmbedding(input);
        embeddingCalls += 1;
        requests.push({
          kind: 'embedding', url, model: String(body.model ?? ''), system: '', user: '',
          temperature: NaN, maxTokens: NaN, markers: [], input,
        });
        json(res, {
          object: 'list',
          model: String(body.model ?? 'nomic-embed-text'),
          data: [{ object: 'embedding', index: 0, embedding: encodeEmbedding(vec) }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
        return;
      }

      // ── CHAT: expansion or judge ────────────────────────────────────────────────────────────
      const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';

      // ⚠️ KEYED ON THE SYSTEM PROMPT, NOT ON "every chat is a judge call". The expansion prompt
      // opens "You are a medical query rewriter" (`lib/expand.ts`) and the judge's opens "You are a
      // clinical relevance judge" (`lib/rerank.ts:365`). Model would also separate them, but only
      // because this harness sets RERANK_JUDGE_MODEL; the prompt is the property of the code.
      const isExpansion = discriminateChat && /medical query rewriter/i.test(system);

      const segs = passageSegments(user);
      const known = Object.keys(scores);
      const markers = segs
        .sort((a, b) => a.idx - b.idx)
        .map((s) => known.find((k) => s.text.includes(k)) ?? '');

      requests.push({
        kind: isExpansion ? 'expansion' : 'judge',
        url, model: String(body.model ?? ''), system, user,
        temperature: Number(body.temperature), maxTokens: Number(body.max_tokens), markers,
      });

      const content = isExpansion
        ? expansionText
        : rawContent
          ? rawContent(markers)
          : JSON.stringify(Object.fromEntries(markers.map((m, i) => [String(i), scores[m] ?? 0])));

      json(res, {
        model: String(body.model ?? 'test-judge'),
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        ...(includeUsage ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } : {}),
      });
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  // ── READ AT MODULE LOAD. These must be set before `../rerank` (and through it `../llm`) loads. ──
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;  // lib/llm.ts:39 appends '/v1' itself
  delete process.env.GCP_PROJECT;                            // lib/llm.ts:52 → geminiConfigured() false
  process.env.RERANK_JUDGE_MODEL = 'test-judge';             // lib/rerank.ts:57

  // ── READ AT RUN TIME. Order does not matter; set anyway so the state is known. ─────────────────
  process.env.LLM_PIPELINE = 'mini';        // lib/llm.ts:95 → geminiUtilityModel() undefined
  delete process.env.GEMINI_ALL;            // lib/llm.ts:311
  delete process.env.GEMINI_UTILITY;        // lib/llm.ts:311
  delete process.env.GCP_SA_KEY;            // lib/llm.ts:82
  delete process.env.GEMINI_VIA_OPENROUTER; // lib/llm.ts:133

  // ── AND THESE TWO, WHICH CAN OPEN A REAL OUTBOUND SOCKET. ──────────────────────────────────────
  // `cohereRelevanceScores` (lib/rerank.ts:118) reads OPENROUTER_API_KEY directly and posts to
  // https://openrouter.ai/api/v1/rerank. It has NO miniPipeline() gate, so LLM_PIPELINE='mini' does
  // not stop it. With RERANK_BACKEND=cohere exported in the shell, `rerank()` would take the
  // env-default cohere arm and make that call for real.
  delete process.env.RERANK_BACKEND;
  delete process.env.OPENROUTER_API_KEY;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    setScores(next) { scores = { ...next }; },
    setRawContent(fn) { rawContent = fn; },
    setIncludeUsage(on) { includeUsage = on; },
    setExpansion(text) { expansionText = text; },
    setEmbeddingOverride(fn) { embeddingOverride = fn; },
    setChatDiscrimination(on) { discriminateChat = on; },
    setRecording(on) { recording = on; },
    snapshot() {
      // §5.6: refuse while in flight. Do not return partial data; do not wait. Name the count.
      if (inFlight > 0) throw new Error(`snapshot refused: ${inFlight} request(s) in flight`);
      // §5.7 + v19 §3.2: a new array of new objects, each with a COPIED Buffer — and the clone is
      // DESCRIPTOR-FAITHFUL. An object spread here dropped non-enumerable properties, so a
      // non-enumerable stored field could never reach `Reflect.ownKeys` inspection in test 5.3 and
      // the no-headers guard was blind to it. Own-property descriptors preserve symbol-keyed and
      // non-enumerable fields; the body is then replaced with a copied Buffer, so the clone is
      // faithful AND defensive together — mutating anything returned still leaves the store
      // unchanged.
      return observations.map((o) => {
        const clone: JudgeObservation = Object.create(Object.getPrototypeOf(o), Object.getOwnPropertyDescriptors(o));
        clone.body = Buffer.from(o.body);
        return clone;
      });
    },
    resetObservations() {
      if (inFlight > 0) throw new Error(`resetObservations refused: ${inFlight} request(s) in flight`);
      // §5.4, §5.10: observations and the counter, and NOTHING else. Scores, raw content, usage
      // inclusion, expansion text, embedding override and chat discrimination are not touched.
      observations.length = 0;
      nextSeq = 0;
    },
    inFlight() { return inFlight; },
    settled() {
      return new Promise<void>((resolve) => {
        const tick = () => { if (inFlight === 0) resolve(); else setImmediate(tick); };
        tick();
      });
    },
    close() {
      server.closeAllConnections?.();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE CONNECTION GUARD (addendum v15 §10). No guard restricting outbound connections existed
// anywhere in the suite before pass 2. This one changes no production code.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * WHY `net.Socket.prototype.connect` (v15 §10.1). It is the one seam every path this pass touches
 * goes through: loopback `http`, remote `http`, `tls.connect`, and Node's native `fetch`. It was
 * tested against all four. `http.Agent.prototype.createConnection` is NOT that seam — the OpenAI
 * SDK's node shim installs `agentkeepalive`, which supplies its own `createConnection`, so an Agent
 * patch would miss the SDK's traffic entirely, which is the traffic that matters here.
 *
 * ⚠️ THREE FACTS THE IMPLEMENTATION HANDLES (v15 §10.2).
 *
 *   1. The argument shape is not uniform. Through `http`/`https` — the OpenAI path — the first
 *      argument is an ARRAY of `[options, callback]`, because `net.createConnection` normalizes its
 *      arguments before calling `socket.connect`. Through `tls.connect` it is a plain object.
 *      `hostOf` normalizes both, then reads `host ?? hostname`. A guard reading only
 *      `args[0].host` refuses loopback, because `args[0]` is the array.
 *   2. A throw inside the guard is SYNCHRONOUS. It escapes the caller rather than arriving as an
 *      `error` event. The guard's own test uses `try`/`catch`, not a listener.
 *   3. The guard sees HOSTNAMES, not resolved addresses. DNS has not run at this point.
 *
 * ⚠️ THE `localhost` DECISION (v15 §10.3 item 1), stated explicitly: `localhost` is REFUSED.
 * The guard permits the literal `127.0.0.1` and nothing else. Reasons, in order of weight:
 *   - `localhost` is a NAME, and the guard sees names before DNS runs. On a host whose resolver
 *     maps `localhost` to `::1` first, or to anything a hosts file says, the name is not the
 *     loopback address the guard is meant to permit. Permitting the name would permit whatever the
 *     resolver decides, which is precisely the indirection this guard exists to remove.
 *   - Every path this pass drives already dials the literal address: `startJudgeServer` sets
 *     `OLLAMA_BASE_URL` to `http://127.0.0.1:<port>`, and the connection-guard test dials it the
 *     same way. Nothing in the pass needs the name.
 *   - Refusing is the failure-closed direction. A test that dials `localhost` fails loudly and is
 *     corrected to the literal; a guard that admitted the name could admit a non-loopback target
 *     silently.
 * If a later pass needs `localhost`, it widens the allow-list deliberately, in writing, and states
 * why the resolver indirection is acceptable there.
 *
 * TLS is refused unconditionally (item 2). The pass opens no TLS connection to anything, so a TLS
 * attempt is by construction an escape to a real remote host — the Cohere endpoint being the one
 * this suite is most exposed to.
 *
 * Every other host is refused with an error NAMING THE HOST (item 3), so the failure a reader sees
 * says where the socket was going.
 *
 * `uninstallConnectionGuard` restores the original prototype method (item 4) so the guard does not
 * leak into later test files in the same process. Idempotent in both directions.
 */
export const CONNECTION_GUARD_ALLOWED_HOST = '127.0.0.1';

type SocketConnect = typeof net.Socket.prototype.connect;
let originalConnect: SocketConnect | null = null;

/**
 * Normalize the argument shapes and return the host being dialled, or null if none is visible.
 *
 * ⚠️ WHAT THE PROBE SHOWED, AND WHY THIS READS ONLY `host ?? hostname`. Run against Node with a
 * throwing prototype patch, `http.get` arrives as an ARRAY `[options, cb]` whose options object
 * carries `servername: ""` (an EMPTY STRING, not undefined) and `path: "/x"` (the URL PATH, not a
 * unix socket). A first draft of this function read `'servername' in o` as a TLS signal and
 * `typeof o.path === 'string'` as a unix-socket signal, and both misfired on plain http — every
 * loopback connection was refused as TLS. Neither option is a reliable discriminator, so neither is
 * read here. TLS is decided by the CALLER from the socket itself (`this.encrypted`, set on a
 * `TLSSocket`), which is the only signal that cannot be spoofed by an options object.
 */
function hostOf(args: unknown[]): string | null {
  // Shape 1 (http/https/native fetch, and net.connect(options)): args[0] is [options, callback?].
  // Shape 2 (tls.connect): args[0] is the options object itself.
  // Shape 3 (net.connect(port, host)): args[0] is a number and args[1] is the host string.
  let first: unknown = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    const o = first as { host?: unknown; hostname?: unknown };
    const h = o.host ?? o.hostname;
    return typeof h === 'string' ? h : null;
  }
  if (typeof first === 'number' && typeof args[1] === 'string') return args[1];
  return null;
}

export function installConnectionGuard(): void {
  if (originalConnect) return;   // already installed — idempotent
  originalConnect = net.Socket.prototype.connect;
  const original = originalConnect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const host = hostOf(args);
    // `tls.connect` constructs a TLSSocket, whose `encrypted` property is true, and calls connect
    // on it. That is the reliable TLS signal — see the note on `hostOf` for the two options-object
    // fields that are NOT.
    const isTls = (this as { encrypted?: boolean }).encrypted === true;
    if (isTls) {
      throw new Error(`connection guard: TLS connection refused (host ${host ?? 'unknown'})`);
    }
    if (host !== null && host !== CONNECTION_GUARD_ALLOWED_HOST) {
      throw new Error(`connection guard: outbound connection to '${host}' refused; only ${CONNECTION_GUARD_ALLOWED_HOST} is permitted`);
    }
    return (original as unknown as (...a: unknown[]) => net.Socket).apply(this, args);
  } as SocketConnect;
}

export function uninstallConnectionGuard(): void {
  if (!originalConnect) return;   // not installed — idempotent
  net.Socket.prototype.connect = originalConnect;
  originalConnect = null;
}

/** Test-only: is the guard currently installed? */
export function connectionGuardInstalled(): boolean { return originalConnect !== null; }
