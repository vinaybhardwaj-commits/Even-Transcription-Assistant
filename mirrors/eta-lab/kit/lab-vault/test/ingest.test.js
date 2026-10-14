import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../worker/index.js";
import { parseKey } from "../worker/validate.js";

const TOKEN = "t".repeat(40);
const RUN = "hist-bulk-20260924T1912-ab12cd3";
const KEY = `runs/${RUN}/room_x/2026-09-24/win1.json`;

// Fake R2 with the same put(onlyIf etagDoesNotMatch "*") / head / get semantics as the binding.
function fakeBucket() {
  const objs = new Map();
  return {
    objs, puts: 0, deletes: 0,
    async put(key, bytes, opts) {
      if (this.throwOnExisting && objs.has(key)) throw new Error("10054: object is locked");
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && objs.has(key)) return null;
      this.puts++;
      objs.set(key, { bytes: new Uint8Array(bytes), customMetadata: opts.customMetadata, checksums: { sha256: new Uint8Array(Buffer.from(opts.sha256, "hex")).buffer } });
      return { key };
    },
    async head(key) { return objs.get(key) ?? null; },
    async list({ prefix }) { return { objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async get(key) { const o = objs.get(key); return o && { arrayBuffer: async () => o.bytes.buffer.slice(0) }; },
    async delete() { this.deletes++; },
  };
}
const env = () => ({ INGEST_TOKEN: TOKEN, RESULTS: fakeBucket() });
const prov = (over = {}) => ({
  schema: "eta-lab-result/1",
  provenance: {
    run_id: RUN, producer: "hist-bulk", created_at: "2026-09-24T19:12:03+05:30", provenance_complete: true, not_run: ["diarizer"],
    stack: { whisper: { model: "large-v3", flags: { vad: false } }, indic_conformer: { model_id: "m", git_head: "g" }, sravaani: { version: "1" }, router: { commit: "c", config_sha256: "s" } },
    guards: { shim_anti_loop: "1", english_hallucination_guard: "1", transcript_guard: "1", loop_guard_number_rule: "1" },
    diarizer: null, stack_versions_sha256: "a".repeat(64), source_audio_keys: ["audio/x.wav"], ...over,
  },
  segments: [],
});
const put = (e, key, body, headers = {}, method = "PUT") =>
  worker.fetch(new Request(`https://x.test/v1/obj/${key}`, { method, body: typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer ? body : JSON.stringify(body), headers: { authorization: `Bearer ${TOKEN}`, ...headers } }), e);

test("create then identical then conflict", async () => {
  const e = env();
  const body = JSON.stringify(prov());
  assert.equal((await put(e, KEY, body)).status, 201);
  assert.equal((await put(e, KEY, body)).status, 200);
  assert.equal(e.RESULTS.puts, 1);
  const r = await put(e, KEY, JSON.stringify({ ...prov(), segments: [1] }));
  assert.equal(r.status, 409);
  assert.equal(e.RESULTS.objs.get(KEY).bytes.length, body.length);
  assert.equal(e.RESULTS.deletes, 0);
});

test("sha256 is computed server-side, a client header is ignored", async () => {
  const e = env();
  const body = JSON.stringify(prov());
  const r = await put(e, KEY, body, { "x-content-sha256": "0".repeat(64) });
  assert.equal((await r.json()).sha256, createHash("sha256").update(body).digest("hex"));
});

test("auth: none, wrong, unconfigured", async () => {
  const e = env();
  const body = JSON.stringify(prov());
  const noAuth = await worker.fetch(new Request(`https://x.test/v1/obj/${KEY}`, { method: "PUT", body }), e);
  assert.equal(noAuth.status, 401);
  assert.equal((await put(e, KEY, body, { authorization: "Bearer nope" })).status, 401);
  assert.equal((await put({ RESULTS: e.RESULTS }, KEY, body)).status, 503);
  assert.equal((await put({ RESULTS: e.RESULTS, INGEST_TOKEN: "short" }, KEY, body)).status, 503);
  assert.equal(e.RESULTS.puts, 0);
  assert.ok(!(await noAuth.text()).includes(TOKEN));
});

test("no destructive or other routes", async () => {
  const e = env();
  for (const method of ["DELETE", "POST", "PATCH", "GET", "HEAD"]) {
    const r = await worker.fetch(new Request(`https://x.test/v1/obj/${KEY}`, { method, headers: { authorization: `Bearer ${TOKEN}` } }), e);
    assert.equal(r.status, 405, method);
  }
  assert.equal((await put(e, `${KEY}?overwrite=1`, JSON.stringify(prov()))).status, 400);
  assert.equal((await put(e, KEY, "x", { "content-type": "multipart/form-data; boundary=a" })).status, 415);
  assert.equal(e.RESULTS.puts + e.RESULTS.deletes, 0);
});

test("keys: prefixes and traversal", () => {
  const ok = [KEY, `runs/${RUN}/room_x/2026-09-24/win1.attempt2.json`, `manifests/${RUN}.json`, `manifests/${RUN}.start.json`, "index/windows-20260924.jsonl", "index/windows-20260924.parquet", "index/search-20260924.jsonl", "runs/hist-miner-backfill-20260924/r/2026-08-04/w.json", "runs/stt-parity-backfill-20260924/r/2026-08-04/w.json"];
  for (const k of ok) assert.ok(parseKey(k), k);
  const bad = ["../runs/x", "runs/../x", `runs/${RUN}/../room/2026-09-24/w.json`, "/runs/x", `runs//${RUN}`, "runs\\x", "%2e%2e/x", `runs/${RUN}/room_x/2026-09-24/%2e%2e.json`,
    "other/x.json", "audio/x.json", `runs/${RUN}/room_x/2026-09-24/w.txt`, "index/windows.jsonl", "index/search-20260924.parquet", "index/search.jsonl", "index/../runs", `runs/nobody-20260924T1912-ab12cd3/r/2026-09-24/w.json`, `runs/${RUN}/r/24-09-2026/w.json`, "", `runs/${RUN}/r/2026-09-24/w..json`];
  for (const k of bad) assert.equal(parseKey(k), null, k);
});

test("size cap incl. chunked body without content-length", async () => {
  const e = env();
  const big = "index/windows-20260924.jsonl";
  const over = new Uint8Array(50 * 1024 * 1024 + 1);
  assert.equal((await put(e, big, over.buffer.slice(0), { "content-length": String(over.length) })).status, 413);
  const stream = new ReadableStream({ start(c) { const chunk = new Uint8Array(1024 * 1024); for (let i = 0; i < 51; i++) c.enqueue(chunk); c.close(); } });
  const r = await worker.fetch(new Request(`https://x.test/v1/obj/${big}`, { method: "PUT", body: stream, duplex: "half", headers: { authorization: `Bearer ${TOKEN}` } }), e);
  assert.equal(r.status, 413);
  const exact = new Uint8Array(50 * 1024 * 1024).fill(97);
  assert.equal((await put(e, big, exact)).status, 201);
  assert.equal((await put(e, "index/windows-20260925.jsonl", new Uint8Array(0))).status, 400);
});

test("provenance: new run rejected when incomplete, backfill flagged", async () => {
  const e = env();
  const cases = {
    "no schema": (d) => delete d.schema,
    "run_id mismatch": (d) => (d.provenance.run_id = "hist-bulk-20260924T1913-ab12cd3"),
    "producer mismatch": (d) => (d.provenance.producer = "vj"),
    "null whisper model": (d) => (d.provenance.stack.whisper.model = null),
    "missing router config": (d) => delete d.provenance.stack.router.config_sha256,
    "missing guard": (d) => delete d.provenance.guards.transcript_guard,
    "no source keys": (d) => (d.provenance.source_audio_keys = []),
    "diarizer null unexplained": (d) => (d.provenance.not_run = []),
    "not complete": (d) => (d.provenance.provenance_complete = false),
    "bad created_at": (d) => (d.provenance.created_at = "yesterday"),
    "bad stack hash": (d) => (d.provenance.stack_versions_sha256 = "abc"),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const d = prov(); mutate(d);
    const r = await put(e, KEY, d);
    assert.equal(r.status, 422, name);
  }
  assert.equal((await put(e, KEY, "not json")).status, 422);
  assert.equal(e.RESULTS.puts, 0);

  const BF = "hist-bulk-backfill-20260924";
  const bfKey = `runs/${BF}/room_x/2026-08-04/w1.json`;
  const bf = { schema: "eta-lab-result/1", provenance: { run_id: BF, producer: "hist-bulk", provenance_complete: false } };
  assert.equal((await put(e, bfKey, bf)).status, 201);
  bf.provenance.provenance_complete = true; // claims complete but is not
  assert.equal((await put(e, `runs/${BF}/room_x/2026-08-04/w2.json`, bf)).status, 422);
  assert.equal((await put(e, `runs/${BF}/room_x/2026-08-04/w3.json`, { schema: "eta-lab-result/1", provenance: { run_id: BF, producer: "hist-bulk" } })).status, 422); // flag must be present
});

test("manifest needs no source_audio_keys; .start allowed", async () => {
  const e = env();
  const d = prov({ source_audio_keys: undefined });
  delete d.provenance.source_audio_keys;
  assert.equal((await put(e, `manifests/${RUN}.start.json`, d)).status, 201);
  assert.equal((await put(e, `manifests/${RUN}.json`, d)).status, 201);
});

test("a locked prefix that throws on an existing key still gives 200/409, and a real failure is a 500 without a write", async () => {
  const e = env();
  e.RESULTS.throwOnExisting = true;
  const body = JSON.stringify(prov());
  assert.equal((await put(e, KEY, body)).status, 201);
  assert.equal((await put(e, KEY, body)).status, 200);
  assert.equal((await put(e, KEY, JSON.stringify({ ...prov(), segments: [1] }))).status, 409);
  const broken = { INGEST_TOKEN: TOKEN, RESULTS: { async put() { throw new Error("boom"); }, async head() { return null; } } };
  const r = await put(broken, KEY, body);
  assert.equal(r.status, 500);
});

test("addendum: an immutable note under manifests/, needs a reason and the run_id of its key", async () => {
  const e = env();
  const key = `manifests/${RUN}.addendum.json`;
  const ok = { schema: "eta-lab-result/1", provenance: { run_id: RUN, producer: "hist-bulk" }, addendum: { reason: "ruling 196; field absent", temperature_fallback: "on (ruling 196; field absent)" } };
  assert.ok(parseKey(key) && parseKey(key).kind === "addendum");
  assert.equal((await put(e, KEY, prov())).status, 201); // the run has records, so a note may be pinned on it
  assert.equal((await put(e, key, ok)).status, 201);
  assert.equal((await put(e, key, ok)).status, 200);
  assert.equal((await put(e, key, { ...ok, addendum: { reason: "changed" } })).status, 409); // still write-once
  assert.equal((await put(e, `manifests/${RUN}.addendum.json`.replace("ab12cd3", "ab12cd4"), ok)).status, 422); // run_id differs from the key
  await put(e, `runs/hist-bulk-20260924T1913-ab12cd3/room_x/2026-09-24/win1.json`, { ...prov(), provenance: { ...prov().provenance, run_id: "hist-bulk-20260924T1913-ab12cd3" } });
  for (const bad of [{ ...ok, addendum: {} }, { ...ok, addendum: { reason: " " } }, { ...ok, addendum: [] }, { schema: "eta-lab-result/1", provenance: ok.provenance }])
    assert.equal((await put(e, `manifests/hist-bulk-20260924T1913-ab12cd3.addendum.json`, { ...bad, provenance: { ...(bad.provenance ?? ok.provenance), run_id: "hist-bulk-20260924T1913-ab12cd3" } })).status, 422);
  assert.equal(parseKey(`manifests/${RUN}.addendum.start.json`), null);
});

test("empty source_audio_keys only for a window that says it used no audio", async () => {
  const e = env();
  const empty = (extra) => ({ ...prov({ source_audio_keys: [] }), ...extra });
  assert.equal((await put(e, KEY, empty({}))).status, 422);                                   // no cut info: still rejected
  assert.equal((await put(e, KEY, empty({ cut: { n_chunks: 2 } }))).status, 422);              // chunks were used but none listed
  assert.equal((await put(e, KEY, empty({ cut: { n_chunks: 0, chunks_dropped: ["bc_x"] }, ok: false, error: "no_audio_in_window" }))).status, 201);
});

test("n_chunks==0 relaxation: exact 0 only, and the record must not claim a transcript (refuter-2 #892)", async () => {
  const e = env();
  const mk = (extra) => ({ ...prov({ source_audio_keys: [] }), ...extra });
  for (const n of ["0", false, null, -1, 1, "", [], undefined]) assert.equal((await put(e, KEY, mk({ cut: { n_chunks: n }, ok: false }))).status, 422, String(n));
  assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: true, segments: [{ text: "hi" }] }))).status, 422);   // claims a transcript with no audio
  assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: true, segments: [] }))).status, 422);        // must say it failed
  assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: false, segments: [{ text: "x" }] }))).status, 422);
  for (const text of [{ turns: [{ text: "hello" }] }, { transcript_native: "hello" }, { transcript_en: "hello" }, { segments: { a: 1 } }, { turns: ["hello"] }])
    assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: false, ...text }))).status, 422, JSON.stringify(text)); // text via any field (refuter-2 #951 F1)
  assert.equal((await put(e, KEY, mk({ cut: { n_chunks: 0 }, ok: false, state: "failed", error: "no_audio_in_window", segments: [], transcript_native: "" }))).status, 201);
});

test("addendum: producer must match the key's run, and the run must already have records", async () => {
  const e = env();
  const key = `manifests/${RUN}.addendum.json`;
  const body = (producer) => ({ schema: "eta-lab-result/1", provenance: { run_id: RUN, producer }, addendum: { reason: "note" } });
  assert.equal((await put(e, key, body("hist-bulk"))).status, 422);             // run has no records yet
  assert.equal((await put(e, KEY, prov())).status, 201);                       // now it does
  assert.equal((await put(e, key, body("vj"))).status, 422);                   // wrong producer
  assert.equal((await put(e, key, body("hist-bulk"))).status, 201);
});

test("segments must be an array when present (protects the nightly index build)", async () => {
  const e = env();
  for (const segments of ["x", { a: 1 }, 5]) assert.equal((await put(e, KEY, { ...prov(), segments })).status, 422, JSON.stringify(segments));
  assert.equal((await put(e, `runs/${RUN}/room_x/2026-09-24/win2.json`, { ...prov(), segments: null })).status, 201);   // real no-audio records carry segments: null
  assert.equal((await put(e, KEY, { ...prov(), segments: [{ text: "ok" }] })).status, 201);
});
