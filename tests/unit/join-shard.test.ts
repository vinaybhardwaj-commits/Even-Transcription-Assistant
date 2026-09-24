/**
 * JOIN-SHARD (24 Sep) — the join's mutex is per shard, not per service.
 *
 * Before: one Durable Object ("joiner") with one `#busy` flag, so any join anywhere refused every
 * other. After: the caller names a shard (`x-join-shard`, the session id), the Worker hashes it into
 * one of JOIN_SHARDS fixed instances, and each instance keeps its own flag.
 *
 * The Worker and its `Joiner` class are run FOR REAL here; only the platform underneath them is
 * faked (`@cloudflare/containers`, the R2 binding, workerd's FixedLengthStream). What that proves:
 *   - joins on different shards are in flight at the same time and both succeed;
 *   - a second join on a busy shard is refused (never queued), and the flag clears afterwards;
 *   - a request with no key goes to the legacy "joiner" instance, exactly as before;
 *   - the number of instances a stream of keys can touch never exceeds `max_instances`.
 * What it does NOT prove: that Cloudflare starts 33 containers. That is the deploy's check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/db", () => ({ sql: () => Promise.resolve([]) }));

// ── the platform, faked ────────────────────────────────────────────────────────────────────────
// `@cloudflare/containers` is aliased to tests/stubs/cloudflare-containers.mjs (vitest.config.ts);
// the stub reports into `globalThis.__joinTest`.
type JoinTest = { touched: string[]; containerCalls: string[]; gate: (name: string) => Promise<void> };
const t = ((globalThis as unknown as { __joinTest: JoinTest }).__joinTest = { touched: [], containerCalls: [], gate: async () => {} });
const touched = t.touched;
const containerCalls = t.containerCalls;

class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(_length: number) {
    super();
  }
}

// @ts-expect-error — plain ESM Worker; no types, by design.
import worker, { Joiner } from "../../services/audio-join/worker/index.js";
// @ts-expect-error — plain ESM shipped inside the container image; no types, by design.
import { JOIN_SHARDS, LEGACY_INSTANCE, SHARD_HEADER, SHARD_KEY_RE, fnv1a32, shardInstanceName, shardKeyFromHeaders } from "../../services/audio-join/container/join-core.mjs";
// @ts-expect-error — the twin's front door; plain ESM, no types.
import { createTwin } from "../../services/audio-join/twin/server.mjs";
import { callJoinService, shardHeader } from "@/lib/bench-join";
import { resetBreakers } from "@/lib/service-pool";

const PIECE = (s: string, i: number) => `bench/opd-7/2026-09-23/${s}/chunk_${String(i).padStart(5, "0")}.webm`;
const jobFor = (session: string) => ({
  pieces: [{ key: PIECE(session, 1), idx: 1 }, { key: PIECE(session, 2), idx: 2 }],
  trim: { start_ms: 0, end_ms: 60_000 },
  out_key: `clips/${session}/a-b-primary.webm`,
  meta: { session_id: session },
});

const bucket = new Map<string, Uint8Array>();
const AUDIO = {
  async head(key: string) {
    const b = bucket.get(key);
    return b ? { size: b.length } : null;
  },
  async get(key: string) {
    const b = bucket.get(key);
    return b ? { body: new Response(b).body } : null;
  },
  async put(key: string, body: ReadableStream, _o: unknown) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    bucket.set(key, bytes);
    return { size: bytes.length };
  },
};
const env = () => {
  const e: Record<string, unknown> = { JOIN_TOKEN: "tok", AUDIO };
  e.JOINER = { cls: Joiner, env: e };
  return e;
};

const post = (e: Record<string, unknown>, session: string, shard: string | null = session) =>
  worker.fetch(
    new Request("https://join/join", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json", "x-join-request-id": `rid-${session}`, ...(shard === null ? {} : { [SHARD_HEADER]: shard }) },
      body: JSON.stringify(jobFor(session)),
    }),
    e,
  ).then((r: Response) => r.json() as Promise<Record<string, unknown>>);

/** Two session ids that land on DIFFERENT shards, and two that land on the SAME one. */
function pickSessions() {
  const ids = Array.from({ length: 200 }, (_, i) => `bs_test${i}`);
  const a = ids[0]!;
  const b = ids.find((s) => shardInstanceName(s) !== shardInstanceName(a))!;
  const c = ids.find((s) => s !== a && shardInstanceName(s) === shardInstanceName(a))!;
  return { a, b, c };
}

let release: (() => void) | null = null;
let entered: Array<() => void> = [];
/** Hold every container call open until `release()`, and let the test await N of them being inside. */
function holdContainers() {
  const gate = new Promise<void>((r) => { release = r; });
  t.gate = async () => {
    entered.forEach((f) => f());
    await gate;
  };
}
const inside = (n: number) => new Promise<void>((resolve) => {
  const check = () => { if (containerCalls.length >= n) resolve(); };
  entered.push(check);
  check();
});

beforeEach(() => {
  vi.stubGlobal("FixedLengthStream", FakeFixedLengthStream);
  touched.length = 0;
  containerCalls.length = 0;
  entered = [];
  release = null;
  t.gate = async () => {};
  bucket.clear();
  for (const s of ["bs_test0", "bs_a", "bs_b"]) for (const i of [1, 2]) bucket.set(PIECE(s, i), new Uint8Array([9, 9, 9]));
  for (let i = 0; i < 200; i++) for (const k of [1, 2]) bucket.set(PIECE(`bs_test${i}`, k), new Uint8Array([9, 9, 9]));
  resetBreakers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── the pure half ──────────────────────────────────────────────────────────────────────────────
describe("shard naming", () => {
  it("no key → the legacy instance, exactly as before", () => {
    expect(shardInstanceName(null)).toBe(LEGACY_INSTANCE);
    expect(LEGACY_INSTANCE).toBe("joiner");
  });

  it("a key always lands on the same shard, and only ever on shard-0..shard-(N-1)", () => {
    for (let i = 0; i < 500; i++) {
      const name = shardInstanceName(`bs_${i}`);
      expect(name).toBe(shardInstanceName(`bs_${i}`));
      const n = Number(/^shard-(\d+)$/.exec(name)?.[1]);
      expect(Number.isInteger(n) && n >= 0 && n < JOIN_SHARDS).toBe(true);
    }
    expect(fnv1a32("bs_xvntaugh")).toBe(fnv1a32("bs_xvntaugh"));
  });

  it("real-looking session ids spread over EVERY shard, none carrying most of the load", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const id = `bs_${Math.random().toString(36).slice(2, 10)}`;
      counts.set(shardInstanceName(id), (counts.get(shardInstanceName(id)) ?? 0) + 1);
    }
    expect(counts.size).toBe(JOIN_SHARDS);
    for (const n of counts.values()) expect(n).toBeLessThan((1000 / JOIN_SHARDS) * 3);
  });

  it("the app's copy of the key pattern is the service's pattern (drift would silently un-shard sessions)", () => {
    const src = readFileSync("lib/bench-join.ts", "utf8");
    const literal = /return typeof id === "string" && (\/\^[^\n]*?\$\/)\.test\(id\)/.exec(src)?.[1];
    expect(literal).toBeDefined();
    const client = new RegExp(literal!.slice(1, -1));
    expect(client.source).toBe(SHARD_KEY_RE.source);
    // and behaviourally, on the characters a drift would drop
    for (const id of ["bs_a", "a.b", "a:b", "a-b", "a_b", "bs a", "a/b", "", "x".repeat(129)]) {
      expect(client.test(id)).toBe(SHARD_KEY_RE.test(id));
      expect(Object.keys(shardHeader({ meta: { session_id: id } } as never)).length === 1).toBe(SHARD_KEY_RE.test(id));
    }
  });

  it("the header: absent is fine, a plain id is fine, anything else is refused by name", () => {
    expect(shardKeyFromHeaders(new Headers())).toEqual({ ok: true, key: null });
    expect(shardKeyFromHeaders(new Headers({ [SHARD_HEADER]: "bs_xvntaugh" }))).toEqual({ ok: true, key: "bs_xvntaugh" });
    for (const bad of ["", "a b", "x".repeat(129), "bs/../x", "bs;drop"]) {
      expect(shardKeyFromHeaders(new Headers({ [SHARD_HEADER]: bad }))).toEqual({ ok: false, error: "bad_shard_key" });
    }
  });

  it("the shard count and wrangler's max_instances cannot drift: JOIN_SHARDS + the legacy instance <= max_instances", () => {
    const text = readFileSync("services/audio-join/wrangler.jsonc", "utf8")
      .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const max = Number(/"max_instances"\s*:\s*(\d+)/.exec(text)?.[1]);
    expect(Number.isInteger(max)).toBe(true);
    expect(JOIN_SHARDS + 1).toBeLessThanOrEqual(max);
    expect(max).toBe(JOIN_SHARDS + 1); // no slack: an unused slot is a limit nobody sized
  });
});

// ── the Worker + Joiner, for real ──────────────────────────────────────────────────────────────
describe("the Worker routes by shard and each shard has its own mutex", () => {
  it("joins for two DIFFERENT shards are in flight together and both succeed", async () => {
    const { a, b } = pickSessions();
    holdContainers();
    const e = env();
    const first = post(e, a);
    const second = post(e, b);
    await inside(2); // both containers are mid-join at once — impossible with one global flag
    expect(new Set(containerCalls).size).toBe(2);
    release!();
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(bucket.has(`clips/${a}/a-b-primary.webm`)).toBe(true);
    expect(bucket.has(`clips/${b}/a-b-primary.webm`)).toBe(true);
  });

  it("a SECOND join on the same session is refused while the first runs — not queued — and the flag clears after", async () => {
    const { a } = pickSessions();
    holdContainers();
    const e = env();
    const first = post(e, a);
    await inside(1);
    const second = await post(e, a);
    expect(second).toMatchObject({ ok: false, error: "join_already_running" });
    expect(containerCalls).toHaveLength(1); // the refused join never reached a container
    release!();
    expect((await first).ok).toBe(true);
    t.gate = async () => {};
    expect((await post(e, a)).ok).toBe(true); // `finally` cleared #busy
  });

  it("two sessions that HASH to the same shard serialise, as every join did before sharding", async () => {
    const { a, c } = pickSessions();
    expect(shardInstanceName(a)).toBe(shardInstanceName(c));
    holdContainers();
    const e = env();
    const first = post(e, a);
    await inside(1);
    expect(await post(e, c)).toMatchObject({ ok: false, error: "join_already_running" });
    release!();
    await first;
  });

  it("KEYLESS is the old path: it lands on the legacy instance and serialises there, unchanged", async () => {
    holdContainers();
    const e = env();
    const first = post(e, "bs_test0", null);
    await inside(1);
    expect(touched).toEqual([LEGACY_INSTANCE]);
    expect(await post(e, "bs_test1", null)).toMatchObject({ ok: false, error: "join_already_running" });
    release!();
    expect((await first).ok).toBe(true);
    expect(new Set(containerCalls)).toEqual(new Set([LEGACY_INSTANCE]));
  });

  it("a keyless join and a keyed join do not block each other (separate instances)", async () => {
    holdContainers();
    const e = env();
    const legacy = post(e, "bs_test0", null);
    const keyed = post(e, "bs_test1");
    await inside(2);
    release!();
    expect((await legacy).ok && (await keyed).ok).toBe(true);
  });

  it("a malformed key is refused by name and touches no instance", async () => {
    const r = await post(env(), "bs_test0", "not a valid key!");
    expect(r).toMatchObject({ ok: false, error: "bad_shard_key" });
    expect(touched).toHaveLength(0);
  });

  it("no stream of keys can touch more instances than max_instances allows", async () => {
    const e = env();
    for (let i = 0; i < 200; i++) await post(e, `bs_test${i}`);
    const names = new Set(touched);
    expect(names.size).toBeGreaterThan(JOIN_SHARDS / 2);
    expect(names.size).toBeLessThanOrEqual(JOIN_SHARDS);
    expect(names.size + 1).toBeLessThanOrEqual(33); // + the legacy instance <= max_instances
  });

  it("auth still comes first: no bearer, no routing", async () => {
    const r = await worker.fetch(new Request("https://join/join", { method: "POST", headers: { [SHARD_HEADER]: "bs_a" }, body: "{}" }), env());
    expect(r.status).toBe(401);
    expect(touched).toHaveLength(0);
  });

  it("/health says whether sharding landed", async () => {
    const h = await (await worker.fetch(new Request("https://join/health"), env())).json();
    expect(h).toMatchObject({ ok: true, shards: JOIN_SHARDS, shard_header: SHARD_HEADER });
  });
});

// ── the caller ─────────────────────────────────────────────────────────────────────────────────
describe("the app sends the shard key", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("shardHeader is the session id, or nothing", () => {
    expect(shardHeader({ meta: { session_id: "bs_xvntaugh" } } as never)).toEqual({ "x-join-shard": "bs_xvntaugh" });
    expect(shardHeader({} as never)).toEqual({});
    expect(shardHeader({ meta: { session_id: "has space" } } as never)).toEqual({});
    expect(shardHeader({ meta: { session_id: 42 } } as never)).toEqual({});
  });

  it("callJoinService puts it on the wire, and the body is untouched", async () => {
    process.env.AUDIO_JOIN_URL = "https://join";
    process.env.AUDIO_JOIN_TOKEN = "t";
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal("fetch", async (_u: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ headers: init.headers, body: init.body });
      return new Response(JSON.stringify({ ok: true, key: "k", bytes: 1, duration_ms: 2 }), { status: 200 });
    });
    const req = { pieces: [], trim: { start_ms: 0, end_ms: 1 }, out_key: "clips/x", meta: { session_id: "bs_xvntaugh" } } as never;
    await callJoinService(req);
    expect(seen[0]!.headers["x-join-shard"]).toBe("bs_xvntaugh");
    expect(seen[0]!.body).toBe(JSON.stringify(req));
  });

  it("a request without a session id sends no header at all (the old request, byte for byte)", async () => {
    process.env.AUDIO_JOIN_URL = "https://join";
    process.env.AUDIO_JOIN_TOKEN = "t";
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_u: string, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return new Response(JSON.stringify({ ok: true, key: "k", bytes: 1, duration_ms: 2 }), { status: 200 });
    });
    await callJoinService({ pieces: [] } as never);
    expect(Object.keys(headers).sort()).toEqual(["Authorization", "content-type", "x-join-request-id"]);
  });
});

// ── the twin ───────────────────────────────────────────────────────────────────────────────────
describe("the twin speaks the same contract over the S3 store", () => {
  const makeStore = () => {
    const puts: Array<{ key: string; bytes: number; contentType: string; meta: Record<string, string> }> = [];
    return {
      puts,
      store: {
        async head(k: string) { const b = bucket.get(k); return b ? { size: b.length } : null; },
        async get(k: string) { return bucket.get(k) ?? null; },
        async put(k: string, body: Uint8Array, o: { contentType: string; meta: Record<string, string> }) {
          puts.push({ key: k, bytes: body.length, contentType: o.contentType, meta: o.meta });
        },
      },
    };
  };
  let gate: Promise<void> = Promise.resolve();
  const containerFetch = vi.fn(async (_u: string, _init: unknown) => {
    await gate;
    return new Response(new Uint8Array([7, 7, 7]), { headers: { "content-type": "audio/webm", "x-join-duration-ms": "1000" } });
  });

  const call = async (handle: (q: unknown, s: unknown) => Promise<void>, session: string, headers: Record<string, string> = {}) => {
    const { Readable } = await import("node:stream");
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(jobFor(session)))]), {
      method: "POST", url: "/join",
      headers: { authorization: "Bearer tok", "x-join-request-id": "r1", [SHARD_HEADER]: session, ...headers },
    });
    let status = 0; let out = "";
    const res = { writeHead: (s: number) => { status = s; }, end: (b: Buffer) => { out = b.toString(); } };
    await handle(req, res);
    return { status, body: JSON.parse(out) as Record<string, unknown> };
  };

  beforeEach(() => { gate = Promise.resolve(); containerFetch.mockClear(); });

  it("joins, frames the pieces in order, and writes the clip with its provenance", async () => {
    const { store, puts } = makeStore();
    const handle = createTwin({ store, token: "tok", containerUrl: "http://127.0.0.1:8080", fetchImpl: containerFetch });
    const r = await call(handle, "bs_a");
    expect(r.body).toMatchObject({ ok: true, key: "clips/bs_a/a-b-primary.webm", bytes: 3, pieces: 2, duration_ms: 1000 });
    expect(puts).toEqual([{ key: "clips/bs_a/a-b-primary.webm", bytes: 3, contentType: "audio/webm", meta: { session_id: "bs_a" } }]);
    expect(containerFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad token and fails CLOSED with no token configured", async () => {
    const { store } = makeStore();
    const handle = createTwin({ store, token: "tok", containerUrl: "http://x", fetchImpl: containerFetch });
    expect((await call(handle, "bs_a", { authorization: "Bearer nope" })).status).toBe(401);
    const open = createTwin({ store, token: undefined, containerUrl: "http://x", fetchImpl: containerFetch });
    expect((await call(open, "bs_a")).status).toBe(503);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("the same shard is single-flight; a different shard runs alongside it", async () => {
    const { store } = makeStore();
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const handle = createTwin({ store, token: "tok", containerUrl: "http://x", fetchImpl: containerFetch, maxConcurrent: 2 });
    const { a, b, c } = pickSessions();
    const first = call(handle, a);
    await vi.waitFor(() => expect(containerFetch).toHaveBeenCalledTimes(1));
    expect((await call(handle, c)).body).toMatchObject({ ok: false, error: "join_already_running" }); // same shard as `a`
    const other = call(handle, b); // different shard
    await vi.waitFor(() => expect(containerFetch).toHaveBeenCalledTimes(2));
    open();
    expect((await first).body.ok).toBe(true);
    expect((await other).body.ok).toBe(true);
  });

  it("stops at maxConcurrent even across different shards (c3 is a shared CPU box)", async () => {
    const { store } = makeStore();
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const handle = createTwin({ store, token: "tok", containerUrl: "http://x", fetchImpl: containerFetch, maxConcurrent: 1 });
    const { a, b } = pickSessions();
    const first = call(handle, a);
    await vi.waitFor(() => expect(containerFetch).toHaveBeenCalledTimes(1));
    expect((await call(handle, b)).body).toMatchObject({ ok: false, error: "join_already_running" });
    open();
    await first;
  });

  it("names its failures: a missing piece, a dead container, a bad shard key", async () => {
    const { store } = makeStore();
    bucket.delete(PIECE("bs_a", 2));
    const handle = createTwin({ store, token: "tok", containerUrl: "http://x", fetchImpl: containerFetch });
    expect((await call(handle, "bs_a")).body).toMatchObject({ ok: false, error: "piece_missing" });
    bucket.set(PIECE("bs_a", 2), new Uint8Array([9]));
    const dead = createTwin({ store, token: "tok", containerUrl: "http://x", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never });
    expect((await call(dead, "bs_a")).body).toMatchObject({ ok: false, error: "container_failed", hop: "do_to_container" });
    expect((await call(handle, "bs_a", { [SHARD_HEADER]: "no good" })).body).toMatchObject({ ok: false, error: "bad_shard_key" });
  });
});
